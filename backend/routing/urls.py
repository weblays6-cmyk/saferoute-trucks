from django.urls import path

from .views import (
    AnalyzeView,
    HealthView,
    ShareGetView,
    SharePingView,
    ShareStartView,
    ShareStopView,
)

urlpatterns = [
    path("analyze/", AnalyzeView.as_view(), name="analyze"),
    path("health/", HealthView.as_view(), name="health"),
    path("share/start/", ShareStartView.as_view(), name="share-start"),
    path("share/<slug:sid>/ping/", SharePingView.as_view(), name="share-ping"),
    path("share/<slug:sid>/stop/", ShareStopView.as_view(), name="share-stop"),
    path("share/<slug:sid>/", ShareGetView.as_view(), name="share-get"),
]
