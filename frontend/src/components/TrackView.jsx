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

// Public live-tracking page: anyone with a /track/<id> link (family,
// dispatcher) watches the truck move. Polls the share endpoint; no login.
// Victor's flow: tapping Navigate hands the trip to the viewer's OWN maps
// app - Google Maps opens with the truck as destination and the ride ready
// to start. (The in-app blue-line route was replaced by this handoff.)
export default function TrackView({ id }) {
  const mapRef = useRef(null)
  const markRef = useRef(null)
  const trailRef = useRef(null)
  const truckRef = useRef(null)   // latest truck {lat, lon}
  const [info, setInfo] = useState(null)
  const [err, setErr] = useState('')
  const [phase, setPhase] = useState('ask')   // ask | show | opening
  const phaseRef = useRef('ask')
  const setPhaseBoth = (p) => { phaseRef.current = p; setPhase(p) }

  function openInGoogleMaps() {
    const t = truckRef.current
    if (!t) return
    const dest = `${t.lat},${t.lon}`
    const go = (origin) => {
      const url = `https://www.google.com/maps/dir/?api=1&destination=${dest}` +
        (origin ? `&origin=${origin}` : '') + '&travelmode=driving'
      window.open(url, '_blank')
      setPhaseBoth('show')
    }
    if (!navigator.geolocation) { go(null); return }
    setPhaseBoth('opening')
    navigator.geolocation.getCurrentPosition(
      (pos) => go(`${pos.coords.latitude},${pos.coords.longitude}`),
      () => go(null),   // no permission: Google Maps uses their own location
      { enableHighAccuracy: true, timeout: 6000, maximumAge: 60000 }
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
            if (!map.getBounds().pad(-0.2).contains(ll)) map.panTo(ll)
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
            {info.to
              ? <p className="track-route"><b>{info.from || 'Start'}</b> → <b>{info.to}</b></p>
              : <p className="track-route">📍 <b>{info.from || 'Live location'}</b></p>}
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
              <button className="track-go" onClick={openInGoogleMaps}>Navigate to it</button>
              <button className="track-stay" onClick={() => setPhaseBoth('show')}>Just show location</button>
            </div>
          </div>
        )}
        {phase === 'opening' && <p className="track-meta">Opening Google Maps with the truck as your destination…</p>}
        {phase === 'show' && info && !err && (
          <p className="track-meta">
            <button className="track-retry" onClick={openInGoogleMaps}>🧭 Open in Google Maps</button>
            <span> — directions to the truck's current spot.</span>
          </p>
        )}
      </div>
      <div id="track-map" className="track-map" />
    </div>
  )
}
