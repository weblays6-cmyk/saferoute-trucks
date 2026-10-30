import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet.heat'

export const RISK_COLORS = {
  LOW: '#22c55e', MODERATE: '#eab308', HIGH: '#f97316', SEVERE: '#ef4444', NO_TRAVEL: '#7f1d1d',
}
export const RISK_LABELS = {
  LOW: 'Low', MODERATE: 'Moderate', HIGH: 'High', SEVERE: 'Severe', NO_TRAVEL: 'No Travel',
}

export default function MapView({ result, selectedRouteId, onSelectRoute, showHeat, heatHour }) {
  const mapRef = useRef(null)
  const layerRef = useRef(null)

  // Create the map once.
  useEffect(() => {
    if (mapRef.current) return
    mapRef.current = L.map('saferoute-map').setView([34.1, -97.1], 6)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
    }).addTo(mapRef.current)
    layerRef.current = L.layerGroup().addTo(mapRef.current)
  }, [])

  // Redraw whenever the result, the selected route, or the heatmap controls change.
  useEffect(() => {
    const map = mapRef.current, layers = layerRef.current
    if (!map || !layers) return
    layers.clearLayers()
    if (!result) return

    const bounds = []
    // Route lines: recommended = thick green, others = thinner blue. Click a line to select it.
    result.routes.forEach((r) => {
      const isRec = r.id === result.recommended_route_id
      const isSel = r.id === selectedRouteId
      const line = L.polyline(r.geometry, {
        color: isRec ? '#22c55e' : '#60a5fa',
        weight: isSel ? 7 : isRec ? 6 : 4,
        opacity: 0.9,
      }).addTo(layers)
      line.on('click', () => onSelectRoute(r.id))
      line.bindPopup(`<b>${r.label}</b><br>${r.distance_miles} miles`)
      r.geometry.forEach((p) => bounds.push(p))
    })

    // Origin / destination pins
    const pin = (loc, text) =>
      L.marker([loc.lat, loc.lon]).addTo(layers).bindPopup(`<b>${text}</b><br>${loc.name || ''}`)
    pin(result.origin, 'Origin')
    pin(result.destination, 'Destination')

    // Checkpoints of the selected route only (all routes together would clutter the map).
    const sel = result.routes.find((r) => r.id === selectedRouteId) || result.routes[0]
    sel.checkpoints.forEach((c) => {
      L.circleMarker([c.lat, c.lon], {
        radius: 8, color: '#fff', weight: 1.5,
        fillColor: RISK_COLORS[c.risk], fillOpacity: 1,
      }).addTo(layers).bindPopup(
        `<b>Mile ${c.mile}</b> — ${RISK_LABELS[c.risk]} risk<br>` +
        `ETA: ${new Date(c.eta).toLocaleString()}<br>` +
        `Wind: ${c.wind_mph} mph • Rain: ${c.rain_in_hr} in/hr • Snow: ${c.snow_in_hr} in/hr` +
        (c.load_rule_applied ? '<br><b>Load rule applied</b> (heavy load raised the wind risk)' : '')
      )
    })

    // Heatmap layer: corridor points, intensity = risk level (0..4) at the slider hour.
    if (showHeat && result.heatmap?.points?.length && L.heatLayer) {
      const pts = result.heatmap.points.map((p) => [p.lat, p.lon, Math.max(p.risk[heatHour] / 4, 0.08)])
      L.heatLayer(pts, { radius: 28, blur: 20, maxZoom: 10 }).addTo(layers)
    }

    if (bounds.length) map.fitBounds(bounds, { padding: [30, 30] })
  }, [result, selectedRouteId, showHeat, heatHour, onSelectRoute])

  return <div id="saferoute-map" className="map" />
}
