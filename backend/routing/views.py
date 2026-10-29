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
