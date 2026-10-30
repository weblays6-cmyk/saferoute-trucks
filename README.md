SafeRoute Trucks — Weather-Aware Truck Routing
A full-stack web app that helps a truck driver choose the safest route between two places,
based on the weather along the route, the truck's load weight, and travel time.
Built for the Spotter AI Full Stack Developer take-home assessment.
Live app: https://saferoute-trucks.vercel.app
Live API: https://saferoute-trucks.onrender.com/api/health/ (Render free tier — the first request after idle can take ~50s to wake)
What it does
The driver enters origin, destination, departure date/time, and load weight,
   and can pick how often weather is checked (every 10 / 25 / 50 miles, or automatic).
The app generates 3 route options and places checkpoints along each route.
For every checkpoint it fetches the weather **for the time the truck is expected to
   arrive there (ETA)** — not for the departure time — and classifies the risk.
It recommends the best route and explains why.
The map shows all routes, checkpoints coloured by risk, route summaries, and a
   weather heatmap along the corridor with a 0–48 hour forecast slider.
Risk rules (from the assignment spec)
Severity order: Low < Moderate < High < Severe < No Travel
Condition
Low
Moderate
High
Severe
No Travel
Wind (mph)
<25
25–34
35–44
45–54
≥55
Rain (in/hr)
<0.10
0.10–0.25
0.25–0.50
0.50–1.00
>1.00
Snow (in/hr)
<0.5
0.5–1.0
1.0–2.0
2.0–3.0
>3.0
Load rules (wind):
≥55 mph → No Travel for any load
45–54 mph + load > 30,000 lb → No Travel
35–44 mph + load > 40,000 lb → Severe
A checkpoint's overall risk is the worst of its wind/rain/snow levels after load rules.
Recommendation priority: (1) routes with No Travel conditions go last →
(2) fewest Severe miles → (3) fewest High miles → (4) lowest average risk →
(5) shortest travel time. "Miles at a risk level" = sum of the segment lengths
represented by checkpoints at that level.
Tech & APIs (all free, no keys except none)
Need
Service
Geocoding
Nominatim (OpenStreetMap)
Routing (3 routes)
OSRM
Weather (hourly, 48h+)
Open-Meteo — wind requested in mph; rain mm→in/hr and snow cm→in/hr converted
Map
Leaflet + OpenStreetMap, leaflet.heat for the heatmap
Backend
Django + Django REST Framework
Frontend
React (Vite)
Architecture
saferoute-trucks/
├── backend/            Django + DRF — stateless API, no database needed
│   └── routing/
│       ├── risk.py         risk thresholds + load rules
│       ├── checkpoints.py  checkpoint sampling along the route + ETA
│       ├── services.py     geocoding / routing / weather calls (batched + cached)
│       ├── ranking.py      route summaries + recommendation sorting
│       ├── analysis.py     orchestrates one /api/analyze/ request + heatmap frames
│       └── tests           pytest suite for risk, ranking, checkpoints, services, API
└── frontend/           React + Leaflet
    └── src/
        ├── api.js
        └── components/  TripForm, MapView, RouteCards, CheckpointTable
API: POST /api/analyze/
{ "origin": "Dallas, TX", "destination": "Oklahoma City, OK",
  "departure": "2026-10-30T08:00:00Z", "load_lb": 35000, "interval_miles": 25 }
Returns ranked routes with geometry, scored checkpoints, per-route summaries with a
recommendation reason, warnings, and heatmap frames (risk per corridor point for
each hour 0–48 after departure). Weather for all points of all routes is fetched in
one batched Open-Meteo request, and identical requests are cached for 10 minutes.
Run locally
Backend:
cd backend
python -m venv venv && venv\Scripts\activate   # (source venv/bin/activate on Mac/Linux)
pip install -r requirements.txt
python manage.py runserver        # http://localhost:8000
Frontend (second terminal):
cd frontend
npm install
npm run dev                       # http://localhost:5173
Tests:
cd backend && pytest              # 82 tests
Assumptions & trade-offs
ETA at a checkpoint assumes a constant average speed (route duration ÷ distance).
Weather is the hourly forecast value nearest to the ETA.
If the routing service returns fewer than 3 routes, the app shows what it got and warns.
No login/database: the tool is a single-trip planner, so the API is stateless;
  caching is in-memory.
Demo routes in the US work best: the spec's units (miles, mph, in/hr, lb) and
  trucking context are US-based.