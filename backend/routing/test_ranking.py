from routing.ranking import Checkpoint, rank_routes, summarize_route
from routing.risk import Risk


def make(levels, duration_min, segment=10):
    """Risk levels list nundi route summary build chestundi (test kosam shortcut)."""
    checkpoints = [Checkpoint(i * segment, level, segment) for i, level in enumerate(levels)]
    return summarize_route(checkpoints, duration_min)


def test_summary_miles_and_average():
    s = make([Risk.LOW, Risk.HIGH, Risk.SEVERE, Risk.SEVERE], duration_min=120)
    assert s["severe_miles"] == 20
    assert s["high_miles"] == 10
    assert s["avg_risk"] == 2.0    # (0 + 2 + 3 + 3) / 4
    assert s["blocked"] is False


def test_segment_length_is_used_not_checkpoint_count():
    # 1 checkpoint x 50 miles, 3 checkpoints x 10 miles: miles lo lekka
    a = summarize_route([Checkpoint(0, Risk.SEVERE, 50)], 60)
    b = summarize_route([Checkpoint(0, Risk.SEVERE, 10)] * 3, 60)
    assert a["severe_miles"] == 50
    assert b["severe_miles"] == 30


def test_fewest_severe_miles_wins_even_if_slower():
    fast_but_severe = make([Risk.SEVERE, Risk.LOW], duration_min=100)
    slow_but_safe = make([Risk.HIGH, Risk.LOW], duration_min=300)
    ranked = rank_routes([fast_but_severe, slow_but_safe])
    assert ranked[0] is slow_but_safe


def test_fewest_high_miles_breaks_severe_tie():
    a = make([Risk.HIGH, Risk.HIGH], duration_min=100)
    b = make([Risk.HIGH, Risk.LOW], duration_min=200)
    assert rank_routes([a, b])[0] is b


def test_lowest_average_risk_breaks_high_tie():
    a = make([Risk.MODERATE, Risk.MODERATE], duration_min=100)
    b = make([Risk.LOW, Risk.LOW], duration_min=200)
    assert rank_routes([a, b])[0] is b


def test_shortest_time_is_last_tiebreaker():
    a = make([Risk.LOW, Risk.LOW], duration_min=200)
    b = make([Risk.LOW, Risk.LOW], duration_min=100)
    assert rank_routes([a, b])[0] is b


def test_no_travel_route_ranked_last():
    blocked = make([Risk.NO_TRAVEL, Risk.LOW], duration_min=50)
    risky = make([Risk.SEVERE, Risk.SEVERE], duration_min=500)
    ranked = rank_routes([blocked, risky])
    assert ranked[-1] is blocked
    assert ranked[0]["recommended"] is True
    assert ranked[1]["recommended"] is False


def test_empty_checkpoints_does_not_crash():
    s = summarize_route([], 0)
    assert s["avg_risk"] == 0.0