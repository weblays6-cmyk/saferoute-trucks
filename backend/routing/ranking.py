from dataclasses import dataclass

from .risk import Risk


# Oka checkpoint: route lo ekkada (mile), emi risk, mariyu aa checkpoint entha distance ni represent chestundi
@dataclass
class Checkpoint:
    mile: float
    risk: Risk
    segment_miles: float   # 10, 25 leda 50 (chivari segment takkuva undochu)


def summarize_route(checkpoints, duration_min):
    """Checkpoints nundi route summary (miles, average risk, time) calculate chestundi."""

    # Oka risk level lo entha miles unnayo sum chestundi
    def miles_at(level):
        return sum(c.segment_miles for c in checkpoints if c.risk == level)

    total_miles = sum(c.segment_miles for c in checkpoints)

    # Average risk = miles tho weight chesina average (pedda segment ki ekkuva weight)
    weighted = sum(int(c.risk) * c.segment_miles for c in checkpoints)
    avg_risk = weighted / total_miles if total_miles else 0.0

    no_travel_miles = miles_at(Risk.NO_TRAVEL)

    return {
        "severe_miles": miles_at(Risk.SEVERE),
        "high_miles": miles_at(Risk.HIGH),
        "no_travel_miles": no_travel_miles,
        "avg_risk": round(avg_risk, 3),
        "duration_min": duration_min,
        "blocked": no_travel_miles > 0,   # No Travel unte route lo veldam safe kaadu
    }


def _sort_key(summary):
    # Tuple sort: modhati item muKhyam, tie ayithe next item chustundi.
    # False < True kabatti blocked routes (No Travel unnavi) last ki veltayi.
    return (
        summary["blocked"],
        summary["severe_miles"],     # 1. Fewest Severe miles
        summary["high_miles"],       # 2. Fewest High miles
        summary["avg_risk"],         # 3. Lowest average risk
        summary["duration_min"],     # 4. Shortest travel time
    )


def rank_routes(summaries):
    """Routes ni best nundi worst varaku sort chestundi. Modhati route 'recommended'."""
    ranked = sorted(summaries, key=_sort_key)
    for position, summary in enumerate(ranked, start=1):
        summary["rank"] = position
        summary["recommended"] = position == 1
    return ranked