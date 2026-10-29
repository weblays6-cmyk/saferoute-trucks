import hashlib
import math
import time
from datetime import datetime, timezone

import requests
from django.core.cache import cache

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
OSRM_URL = "https://router.project-osrm.org/route/v1/driving"
OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"

# Nominatim rules: User-Agent header pettali, 1 request/second limit
HEADERS = {"User-Agent": "SafeRouteTrucks/1.0 (take-home assessment)"}
TIMEOUT = 20
METERS_PER_MILE = 1609.344
WEATHER_BATCH = 50          # Open-Meteo ki oka call lo max 50 locations
WEATHER_CACHE_TTL = 30 * 60  # 30 minutes

RETRY_STATUS = {429, 500, 502, 503, 504}   # temporary errors, malli try cheyochu


def _get_with_retry(url, params, headers=None, attempts=3):
    """GET request. Temporary errors (503 etc.) ki 1s, 2s gap tho retry chestundi."""
    last = None
    for attempt in range(attempts):
        try:
            r = requests.get(url, params=params, headers=headers, timeout=TIMEOUT)
            if r.status_code not in RETRY_STATUS:
                return r
            last = requests.HTTPError(f"{r.status_code} error from {url}")
        except (requests.ConnectionError, requests.Timeout) as exc:
            last = exc
        if attempt < attempts - 1:
            time.sleep(2 ** attempt)
    raise last


class ServiceError(Exception):
    """External API fail ayinappudu user ki clear message ivvadaniki."""


# ---------------------------------------------------------------- Geocoding
def geocode(query):
    """Place name -> {"name", "lat", "lon"} (Nominatim)."""
    query = query.strip()
    if not query:
        raise ServiceError("Location khaali undi")

    key = "geo:" + hashlib.md5(query.lower().encode()).hexdigest()
    hit = cache.get(key)
    if hit:
        return hit

    try:
        r = requests.get(
            NOMINATIM_URL,
            params={"q": query, "format": "json", "limit": 1},
            headers=HEADERS,
            timeout=TIMEOUT,
        )
        r.raise_for_status()
        data = r.json()
    except (requests.RequestException, ValueError) as exc:
        raise ServiceError(f"Geocoding fail ayindi: {exc}") from exc

    if not data:
        raise ServiceError(f"'{query}' location dorakaledu")

    result = {
        "name": data[0]["display_name"],
        "lat": float(data[0]["lat"]),
        "lon": float(data[0]["lon"]),
    }
    cache.set(key, result, 24 * 3600)
    time.sleep(1)   # Nominatim 1 req/sec rule ki respect
    return result


# ------------------------------------------------------------------ Routing
def _osrm(waypoints, alternatives):
    """OSRM ki call chesi routes list istundi. waypoints = [(lat, lon), ...]"""
    # OSRM URL lo order "lon,lat" (lat,lon kaadu)
    path = ";".join(f"{lon},{lat}" for lat, lon in waypoints)
    params = {
        "alternatives": alternatives,
        "overview": "full",
        "geometries": "geojson",
        "steps": "false",
    }
    try:
        r = requests.get(f"{OSRM_URL}/{path}", params=params, headers=HEADERS, timeout=TIMEOUT)
        r.raise_for_status()
        data = r.json()
    except (requests.RequestException, ValueError) as exc:
        raise ServiceError(f"Routing fail ayindi: {exc}") from exc

    if data.get("code") != "Ok":
        raise ServiceError(f"Route dorakaledu: {data.get('message') or data.get('code')}")

    return [
        {
            # GeoJSON lo [lon, lat]. Manam (lat, lon) use chestam, anduke swap
            "coords": [(lat, lon) for lon, lat in item["geometry"]["coordinates"]],
            "distance_miles": item["distance"] / METERS_PER_MILE,
            "duration_min": item["duration"] / 60,
        }
        for item in data["routes"]
    ]


def _detour_vias(origin, destination):
    """
    Public OSRM tarachuga 1-2 routes matrame istundi. 3 routes kavali kabatti,
    origin-destination madhya line ki iru vaipula (perpendicular) kotha 'via' points create chestundi.
    """
    (lat1, lon1), (lat2, lon2) = origin, destination
    mid_lat, mid_lon = (lat1 + lat2) / 2, (lon1 + lon2) / 2
    scale = math.cos(math.radians(mid_lat)) or 1.0   # longitude degrees chinnavi avthayi, adjust

    x, y = (lon2 - lon1) * scale, lat2 - lat1
    norm = math.hypot(x, y) or 1.0
    px, py = -y / norm, x / norm                      # 90 degrees rotate (perpendicular)

    vias = []
    for fraction in (0.15, 0.30):                     # line length lo 15% leda 30% pakkaki
        offset = norm * fraction
        vias.append((mid_lat + py * offset, mid_lon + px * offset / scale))
        vias.append((mid_lat - py * offset, mid_lon - px * offset / scale))
    return vias


def _is_duplicate(a, b):
    """Distance mariyu time rendu 1.5% lopu same ayithe same route ani anukuntam."""
    def close(x, y):
        return abs(x - y) / max(x, y, 1e-9) < 0.015
    return close(a["distance_miles"], b["distance_miles"]) and close(a["duration_min"], b["duration_min"])


def get_routes(origin, destination, want=3):
    """origin/destination = (lat, lon). Max 'want' distinct routes istundi."""
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
        if candidate["duration_min"] > fastest * 1.6:        # chala pedda detour vaddu
            continue
        if any(_is_duplicate(candidate, r) for r in routes):  # already unna route laage unte skip
            continue
        routes.append(candidate)

    routes = routes[:want]
    for i, route in enumerate(routes):
        route["id"] = i + 1
        route["label"] = f"Route {chr(65 + i)}"
    return routes


# ------------------------------------------------------------------ Weather
def _to_utc_naive(dt):
    """Aware datetime ni UTC ki marchi tzinfo teesestundi. Naive ayithe UTC anukuntundi."""
    if dt.tzinfo is not None:
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def _fetch_batch(locations, start_date, end_date):
    params = {
        "latitude": ",".join(f"{lat:.4f}" for lat, _ in locations),
        "longitude": ",".join(f"{lon:.4f}" for _, lon in locations),
        "hourly": "wind_speed_10m,rain,showers,snowfall",
        "wind_speed_unit": "mph",       # mph direct ga vastundi
        "precipitation_unit": "inch",   # rain mariyu snow inches lo (mm/cm kaadu)
        "timezone": "UTC",
        "start_date": start_date.isoformat(),
        "end_date": end_date.isoformat(),
    }
    try:
        r = _get_with_retry(OPEN_METEO_URL, params)
        if r.status_code == 400:
            reason = r.json().get("reason", "bad request")
            raise ServiceError(f"Weather request reject ayindi: {reason}")
        r.raise_for_status()
        payload = r.json()
    except (requests.RequestException, ValueError) as exc:
        raise ServiceError(f"Weather fail ayindi: {exc}") from exc

    # 1 location ki dict, multiple ki list vastundi
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
            "start": datetime.fromisoformat(hourly["time"][0]),   # naive UTC
            "wind_mph": wind,
            # rain + showers kalipi rain (snow ni separate ga unchutunnam, double count avvadu)
            "rain_in_hr": [rain[i] + showers[i] for i in range(n)],
            "snow_in_hr": snow,
        })
    return series


def fetch_weather(locations, start_date, end_date):
    """
    locations = [(lat, lon), ...]. Prathi location ki hourly forecast series istundi (same order lo).
    Coordinates ni 2 decimals ki round chesi cache chestundi, batches lo fetch chestundi.
    """
    keys = [(round(lat, 2), round(lon, 2)) for lat, lon in locations]
    cache_key = lambda k: f"wx:{k[0]}:{k[1]}:{start_date}:{end_date}"

    found = {}
    missing = []
    for k in dict.fromkeys(keys):               # duplicates teesesi order unchutundi
        hit = cache.get(cache_key(k))
        if hit is not None:
            found[k] = hit
        else:
            missing.append(k)

    for i in range(0, len(missing), WEATHER_BATCH):
        batch = missing[i:i + WEATHER_BATCH]
        for k, series in zip(batch, _fetch_batch(batch, start_date, end_date)):
            found[k] = series
            cache.set(cache_key(k), series, WEATHER_CACHE_TTL)

    return [found[k] for k in keys]


def weather_at(series, eta):
    """ETA ki daggara unna hour forecast teesukuntundi."""
    hours = round((_to_utc_naive(eta) - series["start"]).total_seconds() / 3600)
    idx = max(0, min(hours, len(series["wind_mph"]) - 1))
    return {
        "wind_mph": series["wind_mph"][idx],
        "rain_in_hr": series["rain_in_hr"][idx],
        "snow_in_hr": series["snow_in_hr"][idx],
    }


def weather_for_points(points):
    """RoutePoint list (checkpoints.py nundi) ki, prathi point ETA ki weather istundi."""
    etas = [_to_utc_naive(p.eta) for p in points]
    series = fetch_weather([(p.lat, p.lon) for p in points], min(etas).date(), max(etas).date())
    return [weather_at(s, p.eta) for s, p in zip(series, points)]
