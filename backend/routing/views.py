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
# A driver taps Share mid-journey: the server keeps the latest position for a
# short random id, and anyone with the /track/<id> link can watch the truck
# move. In-memory on purpose (demo scale): a restart simply ends old shares.
import secrets
import threading
import time

_SHARES = {}
_SHARES_LOCK = threading.Lock()


class ShareStartView(APIView):
    def post(self, request):
        sid = secrets.token_urlsafe(6)
        with _SHARES_LOCK:
            _SHARES[sid] = {
                "from": str(request.data.get("from") or "")[:200],
                "to": str(request.data.get("to") or "")[:200],
                "lat": None, "lon": None, "eta_min": None,
                "active": True, "updated_at": time.time(),
            }
        return Response({"id": sid})


class SharePingView(APIView):
    def post(self, request, sid):
        with _SHARES_LOCK:
            s = _SHARES.get(sid)
            if not s:
                return Response({"detail": "share not found"}, status=status.HTTP_404_NOT_FOUND)
            try:
                s["lat"] = float(request.data.get("lat"))
                s["lon"] = float(request.data.get("lon"))
            except (TypeError, ValueError):
                return Response({"detail": "bad coordinates"}, status=status.HTTP_400_BAD_REQUEST)
            s["eta_min"] = request.data.get("eta_min")
            s["updated_at"] = time.time()
        return Response({"ok": True})


class ShareStopView(APIView):
    def post(self, request, sid):
        with _SHARES_LOCK:
            s = _SHARES.get(sid)
            if s:
                s["active"] = False
        return Response({"ok": True})


class ShareGetView(APIView):
    def get(self, request, sid):
        with _SHARES_LOCK:
            s = _SHARES.get(sid)
            if not s:
                return Response({"detail": "share not found"}, status=status.HTTP_404_NOT_FOUND)
            out = dict(s)
        out["age_sec"] = round(time.time() - out["updated_at"])
        return Response(out)
