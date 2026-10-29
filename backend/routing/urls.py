from django.urls import path

from .views import AnalyzeView, HealthView

urlpatterns = [
    path("analyze/", AnalyzeView.as_view(), name="analyze"),
    path("health/", HealthView.as_view(), name="health"),
]