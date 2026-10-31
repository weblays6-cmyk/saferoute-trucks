from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from .analysis import run_analysis
from .serializers import AnalyzeSerializer
from .services import BadInput, ServiceError


class AnalyzeView(APIView):
    """POST /api/analyze/ : compare 3 routes and return the map + heatmap data."""

    def post(self, request):
        serializer = AnalyzeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)  # invalid input -> 400 with field errors
        data = serializer.validated_data

        try:
            result = run_analysis(
                data["origin"], data["destination"], data["departure"],
                data["load_lb"], data.get("interval_miles"),
            )
        except BadInput as exc:  # the user's input is the problem -> 400
            return Response({"error": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except ServiceError as exc:  # an external API failed -> 502
            return Response({"error": str(exc)}, status=status.HTTP_502_BAD_GATEWAY)

        return Response(result)


class HealthView(APIView):
    """GET /api/health/ : used by the hosting platform to check the app is alive."""

    def get(self, request):
        return Response({"status": "ok"})


# ---- Live location sharing -------------------------------------------------
# A driver taps Share: the session lives in the DATABASE so the link stays
# valid for 24 hours, across server sleeps and restarts (the old in-memory
# dict died with every restart). Stop flips `active` off but keeps the last
# known position readable until expiry.
import secrets

from .models import ShareSession

_TABLE_READY = False


def _ensure_share_table():
    """Create the table on first use if migrations have not run yet.

    The host's start command does not run `migrate`, so the app guarantees
    its own table; once real migrations run this becomes a no-op check.
    """
    global _TABLE_READY
    if _TABLE_READY:
        return
    from django.db import connection

    if ShareSession._meta.db_table not in connection.introspection.table_names():
        with connection.schema_editor() as editor:
            editor.create_model(ShareSession)
    _TABLE_READY = True


def _get_session(sid):
    _ensure_share_table()
    try:
        s = ShareSession.objects.get(sid=sid)
    except ShareSession.DoesNotExist:
        return None
    if s.expired():
        s.delete()
        return None
    return s


class ShareStartView(APIView):
    def post(self, request):
        _ensure_share_table()
        # Opportunistic cleanup of expired links.
        from datetime import timedelta

        from django.utils import timezone

        ShareSession.objects.filter(created_at__lt=timezone.now() - timedelta(hours=24)).delete()
        s = ShareSession.objects.create(
            sid=secrets.token_urlsafe(6),
            from_name=str(request.data.get("from") or "")[:200],
            to_name=str(request.data.get("to") or "")[:200],
        )
        return Response({"id": s.sid})


class SharePingView(APIView):
    def post(self, request, sid):
        s = _get_session(sid)
        if not s:
            return Response({"detail": "share not found"}, status=status.HTTP_404_NOT_FOUND)
        try:
            s.lat = float(request.data.get("lat"))
            s.lon = float(request.data.get("lon"))
        except (TypeError, ValueError):
            return Response({"detail": "bad coordinates"}, status=status.HTTP_400_BAD_REQUEST)
        eta = request.data.get("eta_min")
        try:
            s.eta_min = float(eta) if eta is not None else None
        except (TypeError, ValueError):
            s.eta_min = None
        s.active = True
        s.save()
        return Response({"ok": True})


class ShareStopView(APIView):
    def post(self, request, sid):
        s = _get_session(sid)
        if s:
            s.active = False
            s.save()
        return Response({"ok": True})


class ShareGetView(APIView):
    def get(self, request, sid):
        s = _get_session(sid)
        if not s:
            return Response({"detail": "share not found"}, status=status.HTTP_404_NOT_FOUND)
        return Response({
            "from": s.from_name,
            "to": s.to_name,
            "lat": s.lat,
            "lon": s.lon,
            "eta_min": s.eta_min,
            "active": s.active,
            "age_sec": s.age_seconds(),
        })
