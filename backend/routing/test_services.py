from datetime import datetime, timedelta, timezone

import pytest
import requests
from django.core.cache import cache

from routing import services


class FakeResponse:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError("error")

    def json(self):
        return self._payload


@pytest.fixture(autouse=True)
def clear_cache():
    cache.clear()


def make_series(n=48):
    # wind value = hour index, appudu eh hour teesukunnado easy ga telustundi
    return {
        "start": datetime(2026, 1, 1, 0, 0),
        "wind_mph": list(range(n)),
        "rain_in_hr": [0.0] * n,
        "snow_in_hr": [0.0] * n,
    }


def test_weather_at_picks_nearest_hour():
    s = make_series()
    assert services.weather_at(s, datetime(2026, 1, 1, 10, 20))["wind_mph"] == 10
    assert services.weather_at(s, datetime(2026, 1, 1, 10, 40))["wind_mph"] == 11


def test_weather_at_converts_timezone_to_utc():
    ist = timezone(timedelta(hours=5, minutes=30))
    eta = datetime(2026, 1, 1, 15, 30, tzinfo=ist)      # = 10:00 UTC
    assert services.weather_at(make_series(), eta)["wind_mph"] == 10


def test_weather_at_clamps_outside_range():
    s = make_series(24)
    assert services.weather_at(s, datetime(2026, 1, 5))["wind_mph"] == 23
    assert services.weather_at(s, datetime(2025, 12, 1))["wind_mph"] == 0


def test_fetch_weather_batches_sums_rain_showers_and_caches(monkeypatch):
    calls = []

    def fake_get(url, params=None, **kwargs):
        calls.append(len(params["latitude"].split(",")))
        n = calls[-1]
        item = {"hourly": {
            "time": ["2026-01-01T00:00", "2026-01-01T01:00"],
            "wind_speed_10m": [10.0, None],
            "rain": [0.1, 0.2],
            "showers": [0.05, None],
            "snowfall": [0.0, 0.3],
        }}
        return FakeResponse([item] * n)

    monkeypatch.setattr("routing.services.requests.get", fake_get)

    locations = [(30 + i * 0.1, 70.0) for i in range(120)]
    start = end = datetime(2026, 1, 1).date()
    result = services.fetch_weather(locations, start, end)

    assert calls == [50, 50, 20]                      # 3 batches
    assert len(result) == 120
    assert result[0]["rain_in_hr"][0] == pytest.approx(0.15)   # rain + showers
    assert result[0]["wind_mph"][1] == 0.0                     # None => 0

    services.fetch_weather(locations, start, end)
    assert calls == [50, 50, 20]                      # 2nd time cache nundi, new calls levu


def test_weather_400_gives_service_error(monkeypatch):
    monkeypatch.setattr(
        "routing.services.requests.get",
        lambda *a, **k: FakeResponse({"reason": "date out of range"}, status=400),
    )
    with pytest.raises(services.ServiceError, match="date out of range"):
        services.fetch_weather([(1.0, 2.0)], datetime(2030, 1, 1).date(), datetime(2030, 1, 1).date())


def osrm_item(duration_s, distance_m=160934):
    return {
        "distance": distance_m,
        "duration": duration_s,
        "geometry": {"coordinates": [[-96.8, 32.7], [-84.4, 33.7]]},   # [lon, lat]
    }


def test_get_routes_swaps_coordinates_and_labels(monkeypatch):
    items = [osrm_item(6000), osrm_item(7000), osrm_item(8000)]
    monkeypatch.setattr(
        "routing.services.requests.get",
        lambda *a, **k: FakeResponse({"code": "Ok", "routes": items}),
    )
    routes = services.get_routes((32.7, -96.8), (33.7, -84.4))
    assert len(routes) == 3
    assert routes[0]["coords"][0] == (32.7, -96.8)       # (lat, lon)
    assert routes[0]["distance_miles"] == pytest.approx(100.0, abs=0.1)
    assert [r["label"] for r in routes] == ["Route A", "Route B", "Route C"]


def test_get_routes_falls_back_to_detours(monkeypatch):
    state = {"n": 0}

    def fake_get(url, params=None, **kwargs):
        if params["alternatives"] == "3":
            return FakeResponse({"code": "Ok", "routes": [osrm_item(6000)]})   # 1 route matrame
        state["n"] += 1
        return FakeResponse({"code": "Ok", "routes": [osrm_item(6000 + state["n"] * 600)]})

    monkeypatch.setattr("routing.services.requests.get", fake_get)
    routes = services.get_routes((32.7, -96.8), (33.7, -84.4))
    assert len(routes) == 3
    assert len({r["duration_min"] for r in routes}) == 3     # anni different


def test_duplicate_detour_is_skipped():
    a = {"distance_miles": 100, "duration_min": 100}
    b = {"distance_miles": 100.5, "duration_min": 100.5}
    c = {"distance_miles": 120, "duration_min": 130}
    assert services._is_duplicate(a, b)
    assert not services._is_duplicate(a, c)

def test_weather_retries_on_503_then_succeeds(monkeypatch):
    monkeypatch.setattr("routing.services.time.sleep", lambda s: None)   # test lo wait avvadu
    calls = {"n": 0}

    def flaky_get(url, params=None, **kwargs):
        calls["n"] += 1
        if calls["n"] < 3:
            return FakeResponse({}, status=503)
        return FakeResponse({"hourly": {
            "time": ["2026-01-01T00:00"],
            "wind_speed_10m": [5.0], "rain": [0.0], "showers": [0.0], "snowfall": [0.0],
        }})

    monkeypatch.setattr("routing.services.requests.get", flaky_get)
    result = services.fetch_weather([(1.0, 2.0)], datetime(2026, 1, 1).date(), datetime(2026, 1, 1).date())
    assert calls["n"] == 3
    assert result[0]["wind_mph"] == [5.0]


def test_weather_gives_service_error_after_all_retries_fail(monkeypatch):
    monkeypatch.setattr("routing.services.time.sleep", lambda s: None)
    monkeypatch.setattr("routing.services.requests.get", lambda *a, **k: FakeResponse({}, status=503))
    with pytest.raises(services.ServiceError):
        services.fetch_weather([(1.0, 2.0)], datetime(2026, 1, 1).date(), datetime(2026, 1, 1).date())

def test_geocode_uses_nominatim_first(monkeypatch):
    seen = []

    def fake_get(url, params=None, **kwargs):
        seen.append(url)
        return FakeResponse([{"display_name": "Dallas, Texas, United States",
                              "lat": "32.78", "lon": "-96.80"}])

    monkeypatch.setattr("routing.services.time.sleep", lambda s: None)
    monkeypatch.setattr("routing.services.requests.get", fake_get)
    result = services.geocode("Dallas, TX")
    assert result["lat"] == 32.78 and result["lon"] == -96.80
    assert seen == [services.NOMINATIM_URL]


def test_geocode_falls_back_to_photon_when_nominatim_fails(monkeypatch):
    def fake_get(url, params=None, **kwargs):
        if url == services.NOMINATIM_URL:
            return FakeResponse({}, status=429)
        if url == services.PHOTON_URL:
            return FakeResponse({"features": [{
                "geometry": {"coordinates": [-96.80, 32.78]},
                "properties": {"name": "Dallas", "state": "Texas", "country": "United States"},
            }]})
        raise AssertionError("unexpected url " + url)

    monkeypatch.setattr("routing.services.requests.get", fake_get)
    result = services.geocode("Dallas, TX")
    assert result == {"name": "Dallas, Texas, United States", "lat": 32.78, "lon": -96.80}


def test_geocode_bad_input_when_no_provider_finds_place(monkeypatch):
    def fake_get(url, params=None, **kwargs):
        if url == services.NOMINATIM_URL:
            return FakeResponse([])
        if url == services.PHOTON_URL:
            return FakeResponse({"features": []})
        return FakeResponse({})

    monkeypatch.setattr("routing.services.time.sleep", lambda s: None)
    monkeypatch.setattr("routing.services.requests.get", fake_get)
    with pytest.raises(services.BadInput):
        services.geocode("Nowhere Land XYZ")


def test_osrm_falls_back_to_second_server(monkeypatch):
    def fake_get(url, params=None, **kwargs):
        if "router.project-osrm.org" in url:
            return FakeResponse({}, status=503)
        if "routing.openstreetmap.de" in url:
            return FakeResponse({"code": "Ok", "routes": [{
                "geometry": {"coordinates": [[-96.8, 32.7], [-97.5, 35.47]]},
                "distance": 322000, "duration": 13320,
            }]})
        raise AssertionError("unexpected url " + url)

    monkeypatch.setattr("routing.services.requests.get", fake_get)
    routes = services._osrm([(32.7, -96.8), (35.47, -97.5)], "false")
    assert len(routes) == 1
    assert routes[0]["coords"][0] == (32.7, -96.8)


def test_fetch_weather_falls_back_to_metno_when_open_meteo_refuses(monkeypatch):
    monkeypatch.setattr("routing.services.time.sleep", lambda s: None)

    def fake_get(url, params=None, **kwargs):
        if url == services.OPEN_METEO_URL:
            return FakeResponse({}, status=429)
        if url == services.METNO_URL:
            return FakeResponse({"properties": {"timeseries": [
                {"time": "2026-01-01T00:00:00Z", "data": {
                    "instant": {"details": {"wind_speed": 10.0, "air_temperature": 20.0}},
                    "next_1_hours": {"details": {"precipitation_amount": 25.4}},
                }},
                {"time": "2026-01-01T01:00:00Z", "data": {
                    "instant": {"details": {"wind_speed": 5.0, "air_temperature": -2.0}},
                    "next_1_hours": {"details": {"precipitation_amount": 2.54}},
                }},
            ]}})
        raise AssertionError("unexpected url " + url)

    monkeypatch.setattr("routing.services.requests.get", fake_get)
    result = services.fetch_weather([(32.77, -96.79)], datetime(2026, 1, 1).date(), datetime(2026, 1, 1).date())
    s = result[0]
    assert len(s["wind_mph"]) == 24
    assert abs(s["wind_mph"][0] - 22.3694) < 0.01     # 10 m/s -> mph
    assert abs(s["rain_in_hr"][0] - 1.0) < 0.001      # 25.4 mm -> 1 inch, warm -> rain
    assert abs(s["snow_in_hr"][1] - 1.0) < 0.001      # 2.54 mm water below freezing -> ~1 inch snow
