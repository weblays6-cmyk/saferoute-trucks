import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet-rotate' // the plugin patches L.Map globally; a plain map init crashes without it loaded
import 'leaflet/dist/leaflet.css'
import axios from 'axios'
import { API_BASE } from '../api.js'

// The truck marker MUST be a CSS/SVG icon: Leaflet's default marker images
// 404 in the Vite build, so viewers saw a broken-image glyph instead of
// the truck's location symbol (Victor's screenshot, 2026-10-31).
const truckIcon = L.divIcon({
  className: 'truck-pin-wrap',
  html: '<div class="truck-pulse"></div>' +
        '<svg class="truck-pin" viewBox="0 0 24 24" width="40" height="40">' +
        '<path d="M12 1.5c-4.4 0-8 3.5-8 7.9 0 5.9 8 13.1 8 13.1s8-7.2 8-13.1c0-4.4-3.6-7.9-8-7.9z" fill="#e11d48" stroke="#fff" stroke-width="1.6"/>' +
        '<circle cx="12" cy="9.3" r="3.4" fill="#fff"/></svg>',
  iconSize: [40, 40],
  iconAnchor: [20, 38],
})
const meIcon = L.divIcon({
  className: 'me-dot-wrap',
  html: '<div class="me-dot"></div>',
  iconSize: [20, 20],
  iconAnchor: [10, 10],
})

function distMeters(aLat, aLon, bLat, bLon) {
  const R = 6371000, rad = Math.PI / 180
  const dLat = (bLat - aLat) * rad, dLon = (bLon - aLon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

// Public live-tracking page: anyone with a /track/<id> link (family,
// dispatcher) watches the truck move. Polls the share endpoint; no login.
// Victor's flow: after the map opens, ASK the viewer "want directions to
// this truck?" - Yes sets the VIEWER's location as origin and the truck
// as destination and draws the route, Google-Maps style; No just shows
// the truck's red location pin.
export default function TrackView({ id }) {
  const mapRef = useRef(null)
  const markRef = useRef(null)
  const trailRef = useRef(null)
  const meRef = useRef(null)
  const routeRef = useRef(null)
  const truckRef = useRef(null)   // latest truck {lat, lon}
  const navRef = useRef(null)     // { meLat, meLon, destLat, destLon, lastRun }
  const [info, setInfo] = useState(null)
  const [err, setErr] = useState('')
  const [phase, setPhase] = useState('ask')   // ask | nav | show | denied | routing
  const [navInfo, setNavInfo] = useState(null)
  const phaseRef = useRef('ask')
  const setPhaseBoth = (p) => { phaseRef.current = p; setPhase(p) }

  async function routeToTruck(meLat, meLon) {
    const t = truckRef.current
    if (!t) return
    navRef.current = { meLat, meLon, destLat: t.lat, destLon: t.lon, lastRun: Date.now() }
    try {
      const { data } = await axios.post(`${API_BASE}/api/analyze/`, {
        origin: `${meLat.toFixed(5)}, ${meLon.toFixed(5)}`,
        destination: `${t.lat.toFixed(5)}, ${t.lon.toFixed(5)}`,
        departure: new Date().toISOString(),
        load_lb: 35000,
      })
      const r = data.routes?.[0]
      if (!r || !mapRef.current) return
      const latlngs = r.geometry.map(([lat, lon]) => [lat, lon])
      if (routeRef.current) { routeRef.current.setLatLngs(latlngs); routeRef.current.setStyle({ dashArray: null }) }
      else routeRef.current = L.polyline(latlngs, { color: '#2563eb', weight: 6, opacity: 0.9 }).addTo(mapRef.current)
      const bounds = L.latLngBounds(latlngs).extend([meLat, meLon]).extend([t.lat, t.lon])
      mapRef.current.fitBounds(bounds.pad(0.08))
      setNavInfo({ miles: r.distance_miles, min: Math.round(r.duration_min) })
    } catch {
      // Routing refused (e.g. the truck is only a few streets away and the
      // trip is under the routing minimum): still show the way - a dashed
      // straight line with the crow-flies distance.
      const t2 = truckRef.current
      if (t2 && mapRef.current) {
        const straight = [[meLat, meLon], [t2.lat, t2.lon]]
        if (routeRef.current) { routeRef.current.setLatLngs(straight); routeRef.current.setStyle({ dashArray: '6 8' }) }
        else routeRef.current = L.polyline(straight, { color: '#2563eb', weight: 5, opacity: 0.85, dashArray: '6 8' }).addTo(mapRef.current)
        mapRef.current.fitBounds(L.latLngBounds(straight).pad(0.15))
        const mi = distMeters(meLat, meLon, t2.lat, t2.lon) / 1609.344
        setNavInfo({ miles: Math.round(mi * 10) / 10, min: Math.max(1, Math.round(mi / 25 * 60)), straight: true })
      } else setNavInfo(null)
    }
  }

  function startNav() {
    if (!navigator.geolocation) { setPhaseBoth('denied'); return }
    setPhaseBoth('routing')
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords
        if (mapRef.current) {
          if (meRef.current) meRef.current.setLatLng([latitude, longitude])
          else meRef.current = L.marker([latitude, longitude], { icon: meIcon }).addTo(mapRef.current).bindPopup('📍 You are here')
        }
        setPhaseBoth('nav')
        routeToTruck(latitude, longitude)
      },
      () => setPhaseBoth('denied'),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
    )
  }

  useEffect(() => {
    const map = L.map('track-map', { rotate: true, touchRotate: false, rotateControl: false, attributionControl: false }).setView([20, 78], 5)
    mapRef.current = map
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {}).addTo(map)
    trailRef.current = L.polyline([], { color: '#00a878', weight: 5, opacity: 0.85 }).addTo(map)
    let dead = false
    const tick = async () => {
      try {
        const { data } = await axios.get(`${API_BASE}/api/share/${id}/`)
        if (dead) return
        setInfo(data)
        if (data.lat != null) {
          const ll = [data.lat, data.lon]
          truckRef.current = { lat: data.lat, lon: data.lon }
          trailRef.current.addLatLng(ll)
          if (!markRef.current) {
            markRef.current = L.marker(ll, { icon: truckIcon }).addTo(map).bindPopup('🚛 Truck is here')
            map.setView(ll, 14)
          } else {
            markRef.current.setLatLng(ll)
            if (phaseRef.current !== 'nav' && !map.getBounds().pad(-0.2).contains(ll)) map.panTo(ll)
          }
          // The truck is a moving destination: refresh the viewer's route
          // when it has moved away from the point we routed to.
          const nav = navRef.current
          if (phaseRef.current === 'nav' && nav &&
              distMeters(nav.destLat, nav.destLon, data.lat, data.lon) > 300 &&
              Date.now() - nav.lastRun > 45000) {
            routeToTruck(nav.meLat, nav.meLon)
          }
        }
      } catch {
        if (!dead) setErr('This share link is not active. The trip may have ended, or the link is wrong.')
      }
    }
    tick()
    const iv = setInterval(tick, 8000)
    return () => { dead = true; clearInterval(iv); map.remove() }
  }, [id])

  const ago = info ? (info.age_sec < 8 ? 'just now' : info.age_sec < 60 ? `${info.age_sec}s ago` : `${Math.round(info.age_sec / 60)} min ago`) : ''
  const live = info && info.active && info.age_sec <= 90
  return (
    <div className="track-page">
      <div className="track-card">
        <h2>🚛 SafeRoute — Live Trip</h2>
        {err && <p className="track-err">{err}</p>}
        {!err && !info && <p>Connecting…</p>}
        {info && (
          <>
            <p className="track-route"><b>{info.from || 'Start'}</b> → <b>{info.to || 'Destination'}</b></p>
            <p className="track-meta">
              {info.eta_min != null ? <>ETA about <b>{info.eta_min} min</b> • </> : null}
              Updated {ago} • {live ? <span className="track-live">● LIVE</span> : <span className="track-stale">last known position</span>}
            </p>
          </>
        )}
        {info && !err && phase === 'ask' && (
          <div className="track-ask">
            <span>🧭 Do you want directions to this truck?</span>
            <div className="track-ask-btns">
              <button className="track-go" onClick={startNav}>Navigate to it</button>
              <button className="track-stay" onClick={() => setPhaseBoth('show')}>Just show location</button>
            </div>
          </div>
        )}
        {phase === 'routing' && <p className="track-meta">Finding your location…</p>}
        {phase === 'denied' && <p className="track-meta">Location permission was not given — showing the truck's location only. <button className="track-retry" onClick={startNav}>Try again</button></p>}
        {phase === 'nav' && (
          <p className="track-meta">
            {navInfo
              ? <>🚗 <b>{navInfo.miles} mi</b> • about <b>{navInfo.min} min</b> from you to the truck — {navInfo.straight ? 'the truck is very close; the dashed line points straight to it.' : 'the blue line is your route. It refreshes as the truck moves.'}</>
              : 'Drawing your route to the truck…'}
          </p>
        )}
      </div>
      <div id="track-map" className="track-map" />
    </div>
  )
}
