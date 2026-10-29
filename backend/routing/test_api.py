from datetime import datetime, timedelta, timezone

import pytest
from django.core.cache import cache
from rest_framework.test import APIClient

from routing import services


@pytest.fixture(autouse=True)
def clear_cache():
    cache.clear()


def future_iso(hours=2):
    return (datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat()


def make_route(route_id, lat, duration_min):
    # a straight east-west line of about 138 miles
    return {
        "id": route_id,
        "label": f"Route {chr(64 + route_id)}",
        "coords": [(lat, 0.0), (lat, 1.0), (lat, 2.0)],
        "distance_miles": 138.0,
        "duration_min": duration_min,
    }


def constant_weather(wind_for):
    """Fake weather service. wind_for(lat) decides the wind speed at each location."""
    def fetch(locations, start_date, end_date):
        fetch.calls += 1
        n = 24 * ((end_date - start_date).days + 1)
        start = datetime(start_date.year, start_date.month, start_date.day)
        return [
            {"start": start, "wind_mph": [wind_for(lat)] * n,
             "rain_in_hr": [0.0] * n, "snow_in_hr": [0.0] * n}
            for lat, _ in locations
        ]
    fetch.calls = 0
    return fetch


@pytest.fixture
def fake(monkeypatch):
    """Route A (lat 0) has 50 mph wind, Route B (lat 1) has 10 mph. Route A is faster."""
    calls = {"geocode": 0}

    def geocode(text):
        calls["geocode"] += 1
        return {"name": text, "lat": 0.0, "lon": 0.0}

    weather = constant_weather(lambda lat: 50.0 if abs(lat) < 0.5 else 10.0)
    monkeypatch.setattr(services, "geocode", geocode)
    monkeypatch.setattr(services, "get_routes",
                        lambda o, d: [make_route(1, 0.0, 200), make_route(2, 1.0, 260)])
    monkeypatch.setattr(services, "fetch_weather", weather)
    calls["weather"] = weather
    return calls


def payload(**overrides):
    base = {"origin": "A City", "destination": "B City", "departure": future_iso(), "load_lb": 20000}
    base.update(overrides)
    return base


def post(data):
    return APIClient().post("/api/analyze/", data, format="json")


# ------------------------------------------------------------- results
def test_recommends_safer_route_even_if_slower(fake):
    res = post(payload())
    assert res.status_code == 200
    body = res.json()
    by_id = {r["id"]: r for r in body["routes"]}

    assert body["recommended_route_id"] == 2
    assert by_id[1]["summary"]["severe_miles"] > 0
    assert by_id[2]["summary"]["severe_miles"] == 0
    assert by_id[2]["summary"]["rank"] == 1
    assert "Severe" in by_id[2]["summary"]["reason"]


def test_checkpoint_fields(fake):
    body = post(payload()).json()
    cp = {r["id"]: r for r in body["routes"]}[1]["checkpoints"][0]
    assert cp["risk"] == "SEVERE" and cp["driver"] == "wind"
    assert cp["wind_mph"] == 50.0
    assert cp["load_rule_applied"] is False
    assert cp["eta"].startswith(body["departure"][:10])


def test_heavy_load_blocks_route_and_flags_load_rule(fake):
    body = post(payload(load_lb=35000)).json()  # 45-54 mph + >30,000 lb => No Travel
    route_a = {r["id"]: r for r in body["routes"]}[1]
    assert route_a["summary"]["blocked"] is True
    assert route_a["checkpoints"][0]["risk"] == "NO_TRAVEL"
    assert route_a["checkpoints"][0]["load_rule_applied"] is True
    assert body["recommended_route_id"] == 2


def test_heatmap_has_49_hourly_frames(fake):
    heat = post(payload()).json()["heatmap"]
    assert heat["hours"] == 49
    assert {p["route_id"] for p in heat["points"]} == {1, 2}
    for p in heat["points"]:
        assert len(p["risk"]) == len(p["wind_mph"]) == 49
        assert set(p["risk"]) == ({3} if p["route_id"] == 1 else {0})


def test_weather_is_fetched_once_for_all_routes(fake):
    post(payload())
    assert fake["weather"].calls == 1


def test_all_routes_blocked_warns(fake, monkeypatch):
    monkeypatch.setattr(services, "fetch_weather", constant_weather(lambda lat: 60.0))
    body = post(payload()).json()
    assert any("No Travel" in w for w in body["warnings"])


def test_identical_request_is_served_from_cache(fake):
    data = payload()
    post(data)
    post(data)
    assert fake["geocode"] == 2          # origin + destination, only for the first request
    assert fake["weather"].calls == 1


# ---------------------------------------------------------- validation
def test_missing_load_returns_400(fake):
    data = payload()
    del data["load_lb"]
    res = post(data)
    assert res.status_code == 400 and "load_lb" in res.json()


def test_negative_load_returns_400(fake):
    assert "load_lb" in post(payload(load_lb=-5)).json()


def test_bad_interval_returns_400(fake):
    assert "interval_miles" in post(payload(interval_miles=15)).json()


def test_past_departure_returns_400(fake):
    res = post(payload(departure=future_iso(hours=-48)))
    assert res.status_code == 400 and "departure" in res.json()


def test_departure_too_far_ahead_returns_400(fake):
    assert "departure" in post(payload(departure=future_iso(hours=24 * 9))).json()


def test_same_origin_and_destination_returns_400(fake):
    res = post(payload(origin="Dallas, TX", destination="  dallas,   tx "))
    assert res.status_code == 400 and "destination" in res.json()


# ------------------------------------------------------ error handling
def test_unknown_location_returns_400(monkeypatch):
    def not_found(text):
        raise services.BadInput("Could not find location")

    monkeypatch.setattr(services, "geocode", not_found)
    res = post(payload())
    assert res.status_code == 400
    assert res.json()["error"] == "Could not find location"


def test_no_route_returns_400(fake, monkeypatch):
    def no_route(o, d):
        raise services.ServiceError("No route found: NoRoute")

    monkeypatch.setattr(services, "get_routes", no_route)
    assert post(payload()).status_code == 400


def test_upstream_failure_returns_502(fake, monkeypatch):
    def down(locations, start, end):
        raise services.ServiceError("Weather service failed")

    monkeypatch.setattr(services, "fetch_weather", down)
    assert post(payload()).status_code == 502


def test_health_endpoint():
    res = APIClient().get("/api/health/")
    assert res.status_code == 200 and res.json() == {"status": "ok"}