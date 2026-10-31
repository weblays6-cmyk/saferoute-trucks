import hashlib
import math
import re
import time
from datetime import datetime, timezone

import requests
from django.core.cache import cache

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse"
PHOTON_URL = "https://photon.komoot.io/api/"
GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search"
OSRM_URL = "https://router.project-osrm.org/route/v1/driving"
OSRM_FALLBACK_URL = "https://routing.openstreetmap.de/routed-car/route/v1/driving"
OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
METNO_URL = "https://api.met.no/weatherapi/locationforecast/2.0/complete"

# Nominatim policy: a User-Agent header is required, max 1 request/second
HEADERS = {"User-Agent": "SafeRouteTrucks/1.0 (take-home assessment)"}
TIMEOUT = 20
METERS_PER_MILE = 1609.344
WEATHER_BATCH = 50           # Open-Meteo accepts up to 50 locations per call
WEATHER_CACHE_TTL = 30 * 60  # 30 minutes

RETRY_STATUS = {429, 500, 502, 503, 504}  # temporary errors worth retrying


class ServiceError(Exception):
    """An external API failed. The message is safe to show to the user."""


class BadInput(ServiceError):
    """The user's input is the problem (e.g. location not found). The API returns 400."""


def _get_with_retry(url, params, headers=None, attempts=5):
    """GET that rides out temporary errors, especially 429 rate limits.

    Free weather APIs enforce per-minute/per-hour quotas that reset on their
    own, so a 429 is worth waiting on: back off 1s, 2s, 4s, 8s (and honour a
    Retry-After header, capped at 20s). Other retryable statuses (5xx) use the
    same schedule. Non-retryable responses return immediately.
    """
    last = None
    for attempt in range(attempts):
        try:
            r = requests.get(url, params=params, headers=headers, timeout=TIMEOUT)
            if r.status_code not in RETRY_STATUS:
                return r
            last = requests.HTTPError(f"{r.status_code} error from {url}")
            wait = 2 ** attempt
            retry_after = (getattr(r, "headers", None) or {}).get("Retry-After")
            if retry_after and retry_after.isdigit():
                wait = max(wait, min(int(retry_after), 20))
        except (requests.ConnectionError, requests.Timeout) as exc:
            last = exc
            wait = 2 ** attempt
        if attempt < attempts - 1:
            time.sleep(wait)
    raise last


# ---------------------------------------------------------------- Geocoding
def _nominatim_geocode(query):
    r = requests.get(
        NOMINATIM_URL,
        params={"q": query, "format": "json", "limit": 1},
        headers=HEADERS,
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    data = r.json()
    if not data:
        return None
    time.sleep(1)  # respect Nominatim's 1 request/second limit
    return {
        "name": data[0]["display_name"],
        "lat": float(data[0]["lat"]),
        "lon": float(data[0]["lon"]),
    }


def _photon_geocode(query):
    r = requests.get(
        PHOTON_URL,
        params={"q": query, "limit": 1},
        headers=HEADERS,
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    features = r.json().get("features") or []
    if not features:
        return None
    f = features[0]
    lon, lat = f["geometry"]["coordinates"]
    props = f.get("properties", {})
    parts = [props.get("name"), props.get("city") or props.get("district"),
             props.get("state"), props.get("country")]
    name = ", ".join(x for i, x in enumerate(parts) if x and x not in parts[:i])
    return {"name": name or query, "lat": float(lat), "lon": float(lon)}


def _openmeteo_geocode(query):
    r = requests.get(
        GEOCODING_URL,
        params={"name": query, "count": 1, "language": "en", "format": "json"},
        headers=HEADERS,
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    results = r.json().get("results") or []
    if not results:
        return None
    x = results[0]
    parts = [x.get("name"), x.get("admin1"), x.get("country")]
    name = ", ".join(part for part in parts if part)
    return {"name": name or query, "lat": float(x["latitude"]), "lon": float(x["longitude"])}


_COORDS_RE = re.compile(r"^(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)$")


def _coords_from_query(query):
    """'17.48866, 78.45155' -> {"name", "lat", "lon"} or None.

    GPS buttons and reroutes hand the backend a raw coordinate pair.
    Sending that to the place-name geocoders only works while Nominatim
    happens to answer (it parses coordinates; Photon/Open-Meteo do not),
    so coordinate input must be recognised directly - never via the
    flaky text-search chain. The display name comes from a reverse
    lookup; if that fails the coordinates themselves are the name.
    """
    m = _COORDS_RE.match(query)
    if not m:
        return None
    lat, lon = float(m.group(1)), float(m.group(2))
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    name = query
    try:
        r = _get_with_retry(
            NOMINATIM_REVERSE_URL,
            {"lat": lat, "lon": lon, "format": "json", "zoom": 18},
            headers=HEADERS, attempts=3,
        )
        r.raise_for_status()
        display = (r.json() or {}).get("display_name")
        if display:
            name = display
        time.sleep(1)  # respect Nominatim's 1 request/second limit
    except Exception:
        pass  # a name is cosmetic here; the coordinates are what matter
    return {"name": name, "lat": lat, "lon": lon}


def geocode(query):
    """Place name -> {"name", "lat", "lon"}.

    Tries Nominatim, then Photon, then Open-Meteo Geocoding. The free
    geocoders rate-limit shared/hosted IPs unpredictably (HTTP 429), so the
    fallback chain keeps the app working when one provider refuses.
    """
    query = query.strip()
    if not query:
        raise BadInput("Location is empty")

    coords = _coords_from_query(query)
    if coords is not None:
        key = "geo:" + hashlib.md5(query.lower().encode()).hexdigest()
        cache.set(key, coords, 24 * 3600)
        return coords

    key = "geo:" + hashlib.md5(query.lower().encode()).hexdigest()
    hit = cache.get(key)
    if hit:
        return hit

    answered = False
    last_error = None
    for finder in (_nominatim_geocode, _photon_geocode, _openmeteo_geocode):
        try:
            result = finder(query)
        except (requests.RequestException, ValueError, KeyError, IndexError, TypeError) as exc:
            last_error = exc
            continue
        answered = True
        if result:
            cache.set(key, result, 24 * 3600)
            return result

    if answered or last_error is None:
        raise BadInput(f"Could not find location: '{query}'")
    raise ServiceError(f"Geocoding service failed: {last_error}") from last_error


# ------------------------------------------------------------------ Routing
def _osrm(waypoints, alternatives):
    """Call OSRM and return a list of routes. waypoints = [(lat, lon), ...]"""
    # OSRM expects "lon,lat" order in the URL (not lat,lon)
    path = ";".join(f"{lon},{lat}" for lat, lon in waypoints)
    params = {
        "alternatives": alternatives,
        "overview": "full",
        "geometries": "geojson",
        "steps": "true",   # turn-by-turn steps for the navigation banner
    }
    # The public OSRM demo server rate-limits shared/hosted IPs too, so on a
    # transport failure (429/5xx) retry the same request against the FOSSGIS
    # routing server, which speaks the same OSRM API. A genuine "NoRoute"
    # answer is not retried - both servers use the same road data.
    data = None
    last_error = None
    for base in (OSRM_URL, OSRM_FALLBACK_URL):
        try:
            r = requests.get(f"{base}/{path}", params=params, headers=HEADERS, timeout=TIMEOUT)
            r.raise_for_status()
            data = r.json()
            break
        except (requests.RequestException, ValueError) as exc:
            last_error = exc
            data = None
    if data is None:
        raise ServiceError(f"Routing service failed: {last_error}") from last_error

    if data.get("code") != "Ok":
        raise ServiceError(f"No route found: {data.get('message') or data.get('code')}")

    return [
        {
            # GeoJSON uses [lon, lat]; we work with (lat, lon), so swap here
            "coords": [(lat, lon) for lon, lat in item["geometry"]["coordinates"]],
            "distance_miles": item["distance"] / METERS_PER_MILE,
            "duration_min": item["duration"] / 60,
            "steps": _parse_steps(item),
        }
        for item in data["routes"]
    ]


def _parse_steps(route_item):
    """Flatten OSRM legs/steps into turn-by-turn maneuvers.

    Returns [{mile, name, type, modifier, exit}] where mile is the cumulative
    distance at which the maneuver happens. Consecutive duplicates at via
    points (leg joints) are merged. Capped so the payload stays small.
    """
    steps = []
    mile = 0.0
    for leg in route_item.get("legs") or []:
        for st in leg.get("steps") or []:
            man = st.get("maneuver") or {}
            steps.append({
                "mile": round(mile, 2),
                "name": st.get("name") or "",
                "type": man.get("type") or "",
                "modifier": man.get("modifier") or "",
                "exit": man.get("exit"),
            })
            mile += (st.get("distance") or 0) / METERS_PER_MILE
    out = []
    for s in steps:
        if (out and abs(out[-1]["mile"] - s["mile"]) < 0.01
                and out[-1]["type"] == s["type"] and out[-1]["name"] == s["name"]):
            continue
        out.append(s)
    return out[:80]


def _detour_vias(origin, destination):
    """
    Public OSRM often returns only 1-2 routes. To reach 3, build extra 'via' points
    on both sides of the origin-destination line (perpendicular offsets).
    """
    (lat1, lon1), (lat2, lon2) = origin, destination
    mid_lat, mid_lon = (lat1 + lat2) / 2, (lon1 + lon2) / 2
    scale = math.cos(math.radians(mid_lat)) or 1.0  # longitude degrees shrink with latitude

    x, y = (lon2 - lon1) * scale, lat2 - lat1
    norm = math.hypot(x, y) or 1.0
    px, py = -y / norm, x / norm  # rotate 90 degrees to get the perpendicular direction

    vias = []
    for fraction in (0.15, 0.30):  # offset as a fraction of the trip length
        offset = norm * fraction
        vias.append((mid_lat + py * offset, mid_lon + px * offset / scale))
        vias.append((mid_lat - py * offset, mid_lon - px * offset / scale))
    return vias


def _is_duplicate(a, b):
    """Treat two routes as the same if distance and time both differ by under 1.5%."""
    def close(x, y):
        return abs(x - y) / max(x, y, 1e-9) < 0.015
    return close(a["distance_miles"], b["distance_miles"]) and close(a["duration_min"], b["duration_min"])


def get_routes(origin, destination, want=3):
    """origin/destination = (lat, lon). Returns up to 'want' distinct routes."""
    routes = _osrm([origin, destination], "3")
    fastest = min(r["duration_min"] for r in routes)

    for via in _detour_vias(origin, destination):
        if len(routes) >= want:
            break
        try:
            candidates = _osrm([origin, via, destination], "false")
        except ServiceError:
            continue
        candidate = candidates[0]
        if candidate["duration_min"] > fastest * 1.6:  # skip huge detours
            continue
        if any(_is_duplicate(candidate, r) for r in routes):  # skip near-copies
            continue
        routes.append(candidate)

    routes = routes[:want]
    for i, route in enumerate(routes):
        route["id"] = i + 1
        route["label"] = f"Route {chr(65 + i)}"
    return routes


# ------------------------------------------------------------------ Weather
def _to_utc_naive(dt):
    """Convert an aware datetime to UTC and drop tzinfo. Naive datetimes are assumed UTC."""
    if dt.tzinfo is not None:
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def _fetch_batch(locations, start_date, end_date):
    params = {
        "latitude": ",".join(f"{lat:.4f}" for lat, _ in locations),
        "longitude": ",".join(f"{lon:.4f}" for _, lon in locations),
        "hourly": "wind_speed_10m,rain,showers,snowfall",
        "wind_speed_unit": "mph",      # wind comes back in mph
        "precipitation_unit": "inch",  # rain and snow in inches (not mm/cm)
        "timezone": "UTC",
        "start_date": start_date.isoformat(),
        "end_date": end_date.isoformat(),
    }
    try:
        r = _get_with_retry(OPEN_METEO_URL, params, attempts=3)  # fail fast: MET Norway fallback waits behind this
        if r.status_code == 400:
            reason = r.json().get("reason", "bad request")
            raise ServiceError(f"Weather request rejected: {reason}")
        r.raise_for_status()
        payload = r.json()
    except (requests.RequestException, ValueError) as exc:
        raise ServiceError(f"Weather service failed: {exc}") from exc

    # One location returns a dict, several locations return a list
    items = payload if isinstance(payload, list) else [payload]

    series = []
    for item in items:
        hourly = item["hourly"]
        n = len(hourly["time"])
        wind = [v or 0.0 for v in hourly["wind_speed_10m"]]
        rain = [v or 0.0 for v in hourly["rain"]]
        showers = [v or 0.0 for v in hourly["showers"]]
        snow = [v or 0.0 for v in hourly["snowfall"]]
        series.append({
            "start": datetime.fromisoformat(hourly["time"][0]),  # naive UTC
            "wind_mph": wind,
            # rain + showers combined; snow stays separate so nothing is double counted
            "rain_in_hr": [rain[i] + showers[i] for i in range(n)],
            "snow_in_hr": snow,
        })
    return series


def _metno_series(lat, lon, start_date, end_date):
    """Fallback weather series from MET Norway (api.met.no), same shape as the
    Open-Meteo series. Used only when Open-Meteo refuses us (429): it is a
    separate free service with its own quota. Wind m/s -> mph; precipitation
    mm -> in/hr; near/below-freezing precipitation counts as snow (about a
    10:1 snow-to-water ratio) because this feed has no separate snow field.
    """
    try:
        r = requests.get(
            METNO_URL,
            params={"lat": f"{lat:.4f}", "lon": f"{lon:.4f}"},
            headers=HEADERS,
            timeout=TIMEOUT,
        )
        r.raise_for_status()
        entries = r.json()["properties"]["timeseries"]
    except (requests.RequestException, ValueError, KeyError, TypeError) as exc:
        raise ServiceError(f"Weather service failed: {exc}") from exc

    base = datetime.combine(start_date, datetime.min.time())  # naive UTC midnight
    total = ((end_date - start_date).days + 1) * 24
    wind = [None] * total
    rain = [0.0] * total
    snow = [0.0] * total
    for entry in entries:
        t = datetime.fromisoformat(entry["time"].replace("Z", "+00:00")).replace(tzinfo=None)
        idx = int((t - base).total_seconds() // 3600)
        if idx < 0 or idx >= total:
            continue
        data = entry["data"]
        det = data.get("instant", {}).get("details", {})
        if det.get("wind_speed") is not None:
            wind[idx] = det["wind_speed"] * 2.23694
        temp = det.get("air_temperature")
        if "next_1_hours" in data:
            span, nxt = 1, data["next_1_hours"]["details"]
        elif "next_6_hours" in data:
            span, nxt = 6, data["next_6_hours"]["details"]
        else:
            continue
        per_hour_mm = (nxt.get("precipitation_amount") or 0.0) / span
        for j in range(idx, min(idx + span, total)):
            if temp is not None and temp <= 1.0:
                snow[j] = per_hour_mm / 2.54   # ~10:1 snow depth vs water
            else:
                rain[j] = per_hour_mm / 25.4
            if wind[j] is None and det.get("wind_speed") is not None:
                wind[j] = det["wind_speed"] * 2.23694
    last = 0.0
    for i in range(total):
        if wind[i] is None:
            wind[i] = last
        else:
            last = wind[i]
    return {"start": base, "wind_mph": wind, "rain_in_hr": rain, "snow_in_hr": snow}


def fetch_weather(locations, start_date, end_date):
    """
    locations = [(lat, lon), ...]. Returns one hourly forecast series per location (same order).
    Coordinates are rounded to 2 decimals for caching, and fetched in batches.
    """
    keys = [(round(lat, 2), round(lon, 2)) for lat, lon in locations]
    cache_key = lambda k: f"wx:{k[0]}:{k[1]}:{start_date}:{end_date}"

    found = {}
    missing = []
    for k in dict.fromkeys(keys):  # remove duplicates, keep order
        hit = cache.get(cache_key(k))
        if hit is not None:
            found[k] = hit
        else:
            missing.append(k)

    for i in range(0, len(missing), WEATHER_BATCH):
        batch = missing[i:i + WEATHER_BATCH]
        try:
            batch_series = _fetch_batch(batch, start_date, end_date)
        except ServiceError as exc:
            if str(exc).startswith("Weather request rejected"):
                raise  # a real problem with our request (e.g. bad dates), not quota
            # Open-Meteo refused (usually its free quota on our server IP).
            # Fall back to MET Norway per location so the search still works.
            from concurrent.futures import ThreadPoolExecutor
            def _one(k):
                ck = f"wxm:{k[0]}:{k[1]}:{start_date}:{end_date}"
                hit = cache.get(ck)
                if hit is not None:
                    return k, hit
                series = _metno_series(k[0], k[1], start_date, end_date)
                cache.set(ck, series, WEATHER_CACHE_TTL)
                return k, series
            with ThreadPoolExecutor(max_workers=8) as pool:
                batch_series = None
                for k, series in pool.map(_one, batch):
                    found[k] = series
                    cache.set(cache_key(k), series, WEATHER_CACHE_TTL)
        if batch_series is not None:
            for k, series in zip(batch, batch_series):
                found[k] = series
                cache.set(cache_key(k), series, WEATHER_CACHE_TTL)

    return [found[k] for k in keys]


def weather_at(series, eta):
    """Pick the forecast for the hour nearest to the ETA."""
    hours = round((_to_utc_naive(eta) - series["start"]).total_seconds() / 3600)
    idx = max(0, min(hours, len(series["wind_mph"]) - 1))
    return {
        "wind_mph": series["wind_mph"][idx],
        "rain_in_hr": series["rain_in_hr"][idx],
        "snow_in_hr": series["snow_in_hr"][idx],
    }


def weather_for_points(points):
    """For a list of RoutePoints (from checkpoints.py), return the weather at each point's ETA."""
    etas = [_to_utc_naive(p.eta) for p in points]
    series = fetch_weather([(p.lat, p.lon) for p in points], min(etas).date(), max(etas).date())
    return [weather_at(s, p.eta) for s, p in zip(series, points)]