import pytest
from routing.risk import Risk, assess_checkpoint, wind_risk, rain_risk, snow_risk


# Wind boundaries (spec table prakaram)
@pytest.mark.parametrize("wind, expected", [
    (0, Risk.LOW), (24.9, Risk.LOW),
    (25, Risk.MODERATE), (34.9, Risk.MODERATE),
    (35, Risk.HIGH), (44.9, Risk.HIGH),
    (45, Risk.SEVERE), (54.9, Risk.SEVERE),
    (55, Risk.NO_TRAVEL), (80, Risk.NO_TRAVEL),
])
def test_wind_thresholds(wind, expected):
    assert wind_risk(wind, load_lb=10000) == expected


# Load rules
@pytest.mark.parametrize("wind, load, expected", [
    (55, 0, Risk.NO_TRAVEL),          # 55+ mph, any load
    (45, 30000, Risk.SEVERE),         # exactly 30,000 => rule apply kaadu
    (45, 30001, Risk.NO_TRAVEL),      # >30,000 => No Travel
    (50, 45000, Risk.NO_TRAVEL),
    (35, 40000, Risk.HIGH),           # exactly 40,000 => rule apply kaadu
    (35, 40001, Risk.SEVERE),         # >40,000 => Severe
    (44.9, 45000, Risk.SEVERE),
    (30, 50000, Risk.MODERATE),       # 35 mph kante takkuva => load rule ledu
])
def test_load_rules(wind, load, expected):
    assert wind_risk(wind, load) == expected


@pytest.mark.parametrize("rain, expected", [
    (0.09, Risk.LOW), (0.10, Risk.MODERATE), (0.25, Risk.MODERATE),
    (0.26, Risk.HIGH), (0.50, Risk.HIGH), (0.51, Risk.SEVERE),
    (1.00, Risk.SEVERE), (1.01, Risk.NO_TRAVEL),
])
def test_rain_thresholds(rain, expected):
    assert rain_risk(rain) == expected


@pytest.mark.parametrize("snow, expected", [
    (0.4, Risk.LOW), (0.5, Risk.MODERATE), (1.0, Risk.MODERATE),
    (1.1, Risk.HIGH), (2.0, Risk.HIGH), (2.1, Risk.SEVERE),
    (3.0, Risk.SEVERE), (3.1, Risk.NO_TRAVEL),
])
def test_snow_thresholds(snow, expected):
    assert snow_risk(snow) == expected


# Combined: worst of wind, rain, snow
def test_worst_condition_wins():
    assert assess_checkpoint(wind_mph=20, rain_in_hr=0.3, snow_in_hr=2.5, load_lb=10000) == Risk.SEVERE