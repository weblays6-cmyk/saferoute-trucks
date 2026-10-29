from enum import IntEnum


# Risk levels. IntEnum ante numbers tho compare cheyochu (HIGH > MODERATE), max() work avthundi
class Risk(IntEnum):
    LOW = 0
    MODERATE = 1
    HIGH = 2
    SEVERE = 3
    NO_TRAVEL = 4


# Spec table nundi limits: (low, moderate, high, severe) upper limits
WIND_LIMITS = (25, 35, 45, 55)        # mph
RAIN_LIMITS = (0.10, 0.25, 0.50, 1.00)  # in/hr
SNOW_LIMITS = (0.5, 1.0, 2.0, 3.0)      # in/hr


def _level(value, limits, upper_inclusive):
    """Oka value ni limits tho compare chesi Risk level istundi."""
    low, moderate, high, severe = limits

    # Low limit kante takkuva ayithe LOW
    if value < low:
        return Risk.LOW

    # Migilina levels: modhata match ayyedi return avthundi
    for limit, level in ((moderate, Risk.MODERATE), (high, Risk.HIGH), (severe, Risk.SEVERE)):
        inside = value <= limit if upper_inclusive else value < limit
        if inside:
            return level

    # Anni limits dhatite NO_TRAVEL
    return Risk.NO_TRAVEL


def wind_risk(wind_mph, load_lb):
    """Wind risk + load rules."""
    level = _level(wind_mph, WIND_LIMITS, upper_inclusive=False)

    # Load rule 1: 45-54 mph + load > 30,000 lb => NO TRAVEL
    if 45 <= wind_mph < 55 and load_lb > 30000:
        return Risk.NO_TRAVEL

    # Load rule 2: 35-44 mph + load > 40,000 lb => kanisam SEVERE
    if 35 <= wind_mph < 45 and load_lb > 40000:
        level = max(level, Risk.SEVERE)

    return level


def rain_risk(rain_in_hr):
    return _level(rain_in_hr, RAIN_LIMITS, upper_inclusive=True)


def snow_risk(snow_in_hr):
    return _level(snow_in_hr, SNOW_LIMITS, upper_inclusive=True)


def assess_checkpoint(wind_mph, rain_in_hr, snow_in_hr, load_lb):
    """Oka checkpoint risk = wind, rain, snow lo worst (highest) level."""
    return max(
        wind_risk(wind_mph, load_lb),
        rain_risk(rain_in_hr),
        snow_risk(snow_in_hr),
    )