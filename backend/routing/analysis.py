import hashlib
import json
import math
from datetime import timedelta, timezone

from django.core.cache import cache

from . import services
from .checkpoints import auto_interval, build_checkpoints
from .ranking import Checkpoint, rank_routes, summarize_route
from .risk import Risk, assess_checkpoint, rain_risk, snow_risk, wind_risk

FORECAST_HOURS = 48               # heatmap slider range: 0..48 hours after departure
MAX_GEOMETRY_POINTS = 600         # keeps the map line (and the response) small
MIN_HEAT_STEP_MILES = 25.0        # heatmap sampling distance along the corridor
MAX_HEAT_POINTS_PER_ROUTE = 60    # caps work for very long trips
RESULT_CACHE_TTL = 10 * 60        # identical requests within 10 minutes are served from cache


# --------------------------------------------------------------- helpers
def _normalize(text):
    return " ".join(text.lower().split())


def _cache_key(origin, destination, departure, load_lb, interval):
    raw = json.dumps([_normalize(origin), _normalize(destination),
                      departure.isoformat(), load_lb, interval])
    return "analysis:" + hashlib.md5(raw.encode()).hexdigest()


def simplify(coords, max_points=MAX_GEOMETRY_POINTS):
    """Thin out a long route line for the map (the last point is always kept)."""
    if len(coords) > max_points:
        step = math.ceil(len(coords) / max_points)
        thinned = list(coords[::step])
        if thinned[-1] != coords[-1]:
            thinned.append(coords[-1])
        coords = thinned
    return [[round(lat, 5), round(lon, 5)] for lat, lon in coords]


def _risk_miles(scored):
    """Miles spent at each risk level, e.g. {"LOW": 600.0, "HIGH": 50.0, ...}."""
    miles = {level.name: 0.0 for level in Risk}
    for c in scored:
        miles[c.risk.name] += c.segment_miles
    return {name: round(value, 1) for name, value in miles.items()}


def _routes_or_bad_input(origin, destination):
    try:
        return services.get_routes(origin, destination)
    except services.BadInput:
        raise
    except services.ServiceError as exc:
        # OSRM says "No route found" when e.g. the points are on different continents.
        # That is a problem with the input, not a service outage.
        if str(exc).startswith("No route found"):
            raise services.BadInput("No drivable route between these locations.") from exc
        raise


def explain(best, others):
    """One-line reason for the recommendation, following the priority order of the spec."""
    if not others:
        return "Only one route was available."
    runner_up = others[0]

    if runner_up["blocked"] and not best["blocked"]:
        reason = "Avoids No Travel conditions that other routes run into."
    elif best["severe_miles"] != runner_up["severe_miles"]:
        reason = (f"Fewest Severe miles ({best['severe_miles']:.0f} vs "
                  f"{runner_up['severe_miles']:.0f} on the next best route).")
    elif best["high_miles"] != runner_up["high_miles"]:
        reason = (f"Fewest High-risk miles ({best['high_miles']:.0f} vs "
                  f"{runner_up['high_miles']:.0f} on the next best route).")
    elif best["avg_risk"] != runner_up["avg_risk"]:
        reason = (f"Lowest average risk ({best['avg_risk']:.2f} vs "
                  f"{runner_up['avg_risk']:.2f} on the next best route).")
    else:
        reason = "Shortest travel time among routes with equal weather risk."

    if best["blocked"]:
        reason += " Note: every route has No Travel conditions."
    return reason


# --------------------------------------------------------- per-route build
def _checkpoint_payload(point, weather, load_lb):
    levels = {
        "wind": wind_risk(weather["wind_mph"], load_lb),
        "rain": rain_risk(weather["rain_in_hr"]),
        "snow": snow_risk(weather["snow_in_hr"]),
    }
    risk = max(levels.values())
    return risk, {
        "mile": round(point.mile, 1),
        "lat": round(point.lat, 5),
        "lon": round(point.lon, 5),
        "eta": point.eta.isoformat(),
        "segment_miles": round(point.segment_miles, 1),
        "wind_mph": round(weather["wind_mph"], 1),
        "rain_in_hr": round(weather["rain_in_hr"], 3),
        "snow_in_hr": round(weather["snow_in_hr"], 3),
        "risk": risk.name,
        "risk_level": int(risk),
        # which condition caused the risk (None when everything is Low)
        "driver": max(levels, key=levels.get) if risk > Risk.LOW else None,
        # True when the load rules pushed the wind risk above the plain wind table
        "load_rule_applied": levels["wind"] > wind_risk(weather["wind_mph"], 0),
    }


def _heat_payload(route_id, point, series, departure, load_lb):
    """Hourly frames (0..48h after departure) for one corridor point."""
    risk, wind, rain, snow = [], [], [], []
    for hour in range(FORECAST_HOURS + 1):
        w = services.weather_at(series, departure + timedelta(hours=hour))
        risk.append(int(assess_checkpoint(w["wind_mph"], w["rain_in_hr"], w["snow_in_hr"], load_lb)))
        wind.append(round(w["wind_mph"], 1))
        rain.append(round(w["rain_in_hr"], 3))
        snow.append(round(w["snow_in_hr"], 3))
    return {
        "route_id": route_id,
        "mile": round(point.mile, 1),
        "lat": round(point.lat, 5),
        "lon": round(point.lon, 5),
        "risk": risk,
        "wind_mph": wind,
        "rain_in_hr": rain,
        "snow_in_hr": snow,
    }


# ------------------------------------------------------------------ main
def run_analysis(origin_text, destination_text, departure, load_lb, interval_miles=None):
    if departure.tzinfo is None:
        departure = departure.replace(tzinfo=timezone.utc)

    key = _cache_key(origin_text, destination_text, departure, load_lb, interval_miles)
    cached = cache.get(key)
    if cached is not None:
        return cached

    origin = services.geocode(origin_text)
    destination = services.geocode(destination_text)
    routes = _routes_or_bad_input((origin["lat"], origin["lon"]),
                                  (destination["lat"], destination["lon"]))
    if routes[0]["distance_miles"] < 1:
        raise services.BadInput("Origin and destination are the same place.")

    # The same interval for every route keeps the comparison fair
    interval = interval_miles or auto_interval(max(r["distance_miles"] for r in routes))

    # 1) Decide all sample points first (checkpoints for risk, denser points for the heatmap)
    plans = []
    for route in routes:
        checkpoints = build_checkpoints(route["coords"], route["duration_min"], departure, interval)
        heat_step = max(MIN_HEAT_STEP_MILES, route["distance_miles"] / MAX_HEAT_POINTS_PER_ROUTE)
        heat_points = build_checkpoints(route["coords"], route["duration_min"], departure, heat_step)
        plans.append((route, checkpoints, heat_points))

    # 2) ONE weather request set for every point of every route (batched + cached inside services)
    locations = []
    for _, checkpoints, heat_points in plans:
        locations += [(p.lat, p.lon) for p in checkpoints]
        locations += [(p.lat, p.lon) for p in heat_points]

    longest = max(r["duration_min"] for r in routes)
    start_date = departure.astimezone(timezone.utc).date()
    end_date = (departure + timedelta(hours=FORECAST_HOURS, minutes=longest)).astimezone(timezone.utc).date()
    all_series = services.fetch_weather(locations, start_date, end_date)

    # 3) Score every route
    results, cursor = [], 0
    for route, checkpoints, heat_points in plans:
        cp_series = all_series[cursor:cursor + len(checkpoints)]
        cursor += len(checkpoints)
        heat_series = all_series[cursor:cursor + len(heat_points)]
        cursor += len(heat_points)

        scored, cp_payloads = [], []
        for point, series in zip(checkpoints, cp_series):
            weather = services.weather_at(series, point.eta)
            risk, payload = _checkpoint_payload(point, weather, load_lb)
            scored.append(Checkpoint(point.mile, risk, point.segment_miles))
            cp_payloads.append(payload)

        summary = summarize_route(scored, route["duration_min"])
        summary["duration_min"] = round(route["duration_min"], 1)
        summary["distance_miles"] = round(route["distance_miles"], 1)
        summary["risk_miles"] = _risk_miles(scored)
        summary["arrival"] = checkpoints[-1].eta.isoformat()

        results.append({
            "id": route["id"],
            "label": route["label"],
            "distance_miles": summary["distance_miles"],
            "duration_min": summary["duration_min"],
            "geometry": simplify(route["coords"]),
            "checkpoints": cp_payloads,
            "summary": summary,
            "_heat": [_heat_payload(route["id"], p, s, departure, load_lb)
                      for p, s in zip(heat_points, heat_series)],
        })

    # 4) Rank (adds "rank" and "recommended" into each summary)
    ranked = rank_routes([r["summary"] for r in results])
    recommended = next(r for r in results if r["summary"]["recommended"])
    recommended["summary"]["reason"] = explain(ranked[0], ranked[1:])

    heat_points_all = []
    for r in results:
        heat_points_all += r.pop("_heat")

    warnings = []
    if all(r["summary"]["blocked"] for r in results):
        warnings.append(
            "All routes have No Travel conditions for this departure time and load. "
            "Consider delaying the trip."
        )
    if len(results) < 3:
        warnings.append(f"The routing service returned only {len(results)} route(s).")

    result = {
        "origin": origin,
        "destination": destination,
        "departure": departure.isoformat(),
        "load_lb": load_lb,
        "interval_miles": interval,
        "recommended_route_id": recommended["id"],
        "routes": results,
        "heatmap": {
            "hours": FORECAST_HOURS + 1,   # frames 0..48
            "start": departure.isoformat(),
            "points": heat_points_all,
        },
        "warnings": warnings,
    }
    cache.set(key, result, RESULT_CACHE_TTL)
    return result