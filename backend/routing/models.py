from django.db import models


class ShareSession(models.Model):
    """One live-location share link (driver -> anyone with /track/<sid>).

    Stored in the database, not memory: a share must stay valid for 24
    hours, across server sleeps and restarts. `active` flips off when the
    driver stops sharing, but the record (last known position) stays
    readable until the 24h expiry.
    """

    sid = models.CharField(max_length=16, unique=True, db_index=True)
    from_name = models.CharField(max_length=200, blank=True, default="")
    to_name = models.CharField(max_length=200, blank=True, default="")
    lat = models.FloatField(null=True, blank=True)
    lon = models.FloatField(null=True, blank=True)
    eta_min = models.FloatField(null=True, blank=True)
    active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def age_seconds(self):
        from django.utils import timezone

        return max(0, round((timezone.now() - self.updated_at).total_seconds()))

    def expired(self):
        from datetime import timedelta

        from django.utils import timezone

        return timezone.now() - self.created_at > timedelta(hours=24)
