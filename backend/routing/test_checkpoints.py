from datetime import datetime, timedelta

import pytest

from routing.checkpoints import (
    auto_interval, build_checkpoints, cumulative_miles, point_at_mile,
)

# Equator meeda 1 degree longitude = approx 69.09 miles (simple ga lekka veyadaniki)
LINE = [(0.0, 0.0), (0.0, 0.5), (0.0, 1.0)]
DEPARTURE = datetime(2026, 1, 1, 10, 0)


@pytest.mark.parametrize("total, expected", [(50, 10), (100, 10), (101, 25), (400, 25), (401, 50)])
def test_auto_interval(total, expected):
    assert auto_interval(total) == expected


def test_checkpoint_spacing_and_last_is_destination():
    cps = build_checkpoints(LINE, duration_min=120, departure=DEPARTURE, interval_miles=10)
    total = cumulative_miles(LINE)[-1]
    assert cps[0].mile == 0
    assert cps[1].mile == pytest.approx(10)
    assert cps[-1].mile == pytest.approx(total)
    assert len(cps) == 8                       # 0,10,...,60 + destination


def test_segment_miles_add_up_to_route_length():
    cps = build_checkpoints(LINE, duration_min=120, departure=DEPARTURE, interval_miles=25)
    total = cumulative_miles(LINE)[-1]
    assert sum(c.segment_miles for c in cps) == pytest.approx(total)


def test_eta_starts_at_departure_and_ends_at_arrival():
    cps = build_checkpoints(LINE, duration_min=120, departure=DEPARTURE, interval_miles=10)
    assert cps[0].eta == DEPARTURE
    assert cps[-1].eta == DEPARTURE + timedelta(hours=2)


def test_eta_increases_along_route():
    cps = build_checkpoints(LINE, duration_min=120, departure=DEPARTURE, interval_miles=10)
    etas = [c.eta for c in cps]
    assert etas == sorted(etas)


def test_point_interpolation():
    cum = cumulative_miles(LINE)
    lat, lon = point_at_mile(LINE, cum, cum[1])
    assert lat == pytest.approx(0.0)
    assert lon == pytest.approx(0.5)


def test_duplicate_points_do_not_crash():
    coords = [(0.0, 0.0), (0.0, 0.0), (0.0, 1.0)]
    cps = build_checkpoints(coords, duration_min=60, departure=DEPARTURE, interval_miles=10)
    assert cps[-1].mile == pytest.approx(69.09, abs=0.1)


def test_too_few_points_raises():
    with pytest.raises(ValueError):
        build_checkpoints([(0.0, 0.0)], 60, DEPARTURE)