import bisect
import math
from dataclasses import dataclass
from datetime import datetime, timedelta

EARTH_RADIUS_MILES = 3958.8


# Oka checkpoint: ekkada (lat/lon), route lo ye mile, ye time ki cheruthundi, entha distance represent chestundi
@dataclass
class RoutePoint:
    lat: float
    lon: float
    mile: float
    eta: datetime
    segment_miles: float


def haversine_miles(lat1, lon1, lat2, lon2):
    """Rendu lat/lon points madhya distance (miles). Earth curve ni consider chestundi."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = p2 - p1
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * EARTH_RADIUS_MILES * math.asin(math.sqrt(a))


def cumulative_miles(coords):
    """Route lo prathi point varaku motham entha miles ayyindo list istundi. Modhati point = 0."""
    cum = [0.0]
    for (lat1, lon1), (lat2, lon2) in zip(coords, coords[1:]):
        cum.append(cum[-1] + haversine_miles(lat1, lon1, lat2, lon2))
    return cum


def auto_interval(total_miles):
    """Route length batti sampling interval: short trip ki 10 mi, medium ki 25 mi, long ki 50 mi."""
    if total_miles <= 100:
        return 10
    if total_miles <= 400:
        return 25
    return 50


def point_at_mile(coords, cum, mile):
    """Route meeda 'mile' daggara lat/lon (rendu points madhya linear ga interpolate chestundi)."""
    if mile <= 0:
        return coords[0]
    if mile >= cum[-1]:
        return coords[-1]
    i = bisect.bisect_right(cum, mile)        # cum[i-1] <= mile < cum[i]
    seg = cum[i] - cum[i - 1]
    t = (mile - cum[i - 1]) / seg if seg else 0.0
    lat1, lon1 = coords[i - 1]
    lat2, lon2 = coords[i]
    return (lat1 + (lat2 - lat1) * t, lon1 + (lon2 - lon1) * t)


def build_checkpoints(coords, duration_min, departure, interval_miles=None):
    """
    coords       : route geometry [(lat, lon), ...] (routing API nundi vastundi)
    duration_min : routing API ichina motham travel time (minutes)
    departure    : user ichina departure datetime
    interval_miles: 10 / 25 / 50. Ivvakapothe route length batti auto select avthundi
    """
    if len(coords) < 2:
        raise ValueError("Route lo kanisam 2 points undali")

    cum = cumulative_miles(coords)
    total = cum[-1]
    interval = interval_miles or auto_interval(total)

    # Checkpoint miles: 0, interval, 2*interval ... (chivari 1 mile lopu unte skip), tarvata destination
    miles = []
    m = 0.0
    while total - m >= 1.0:
        miles.append(m)
        m += interval
    miles.append(total)

    points = []
    for i, mile in enumerate(miles):
        # Prathi checkpoint ki 'segment_miles': pakka checkpoints madhya midpoints varaku.
        # Anni segments kalipite motham route miles ki equal avthundi.
        start = 0.0 if i == 0 else (miles[i - 1] + mile) / 2
        end = total if i == len(miles) - 1 else (mile + miles[i + 1]) / 2

        lat, lon = point_at_mile(coords, cum, mile)

        # ETA = departure + (route lo ye fraction ki cheraam) x motham duration. (constant speed assumption)
        fraction = mile / total if total else 0.0
        eta = departure + timedelta(minutes=duration_min * fraction)

        points.append(RoutePoint(lat, lon, mile, eta, end - start))
    return points