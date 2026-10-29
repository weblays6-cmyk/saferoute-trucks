from datetime import timedelta

from django.utils import timezone
from rest_framework import serializers

MAX_DAYS_AHEAD = 7        # the heatmap needs 48h beyond departure, plus trip time
PAST_TOLERANCE_HOURS = 6  # allow "leaving now" even if the clock is slightly behind
MAX_LOAD_LB = 150000


def _normalize(text):
    return " ".join(text.lower().split())


class AnalyzeSerializer(serializers.Serializer):
    """
    Validates the trip form.

    Example payload:
        {
          "origin": "Dallas, TX",
          "destination": "Atlanta, GA",
          "departure": "2026-10-30T08:00:00Z",
          "load_lb": 42000,
          "interval_miles": 25          (optional: 10, 25 or 50; omit for automatic)
        }

    Send `departure` with a timezone (e.g. JavaScript's toISOString()).
    A value without a timezone is treated as UTC.
    """

    origin = serializers.CharField(min_length=2, max_length=200)
    destination = serializers.CharField(min_length=2, max_length=200)
    departure = serializers.DateTimeField()
    load_lb = serializers.IntegerField(min_value=0, max_value=MAX_LOAD_LB)
    interval_miles = serializers.ChoiceField(choices=[10, 25, 50], required=False, allow_null=True)

    def validate_departure(self, value):
        now = timezone.now()
        if value < now - timedelta(hours=PAST_TOLERANCE_HOURS):
            raise serializers.ValidationError("Departure time is in the past.")
        if value > now + timedelta(days=MAX_DAYS_AHEAD):
            raise serializers.ValidationError(
                f"Departure must be within {MAX_DAYS_AHEAD} days (weather forecast limit)."
            )
        return value

    def validate(self, attrs):
        if _normalize(attrs["origin"]) == _normalize(attrs["destination"]):
            raise serializers.ValidationError(
                {"destination": "Destination must be different from the origin."}
            )
        return attrs