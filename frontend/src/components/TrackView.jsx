import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet-rotate' // the plugin patches L.Map globally; a plain map init crashes without it loaded
import 'leaflet/dist/leaflet.css'
import axios from 'axios'
import { API_BASE } from '../api.js'

// Public live-tracking page: anyone with a /track/<id> link (family,
// dispatcher) watches the truck move. Polls the share endpoint; no login.
export default function TrackView({ id }) {
  const mapRef = useRef(null)
  const markRef = useRef(null)
  const trailRef = useRef(null)
  const [info, setInfo] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    const map = L.map('track-map', { rotate: true, touchRotate: false, rotateControl: false }).setView([20, 78], 5)
    mapRef.current = map
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
    }).addTo(map)
    trailRef.current = L.polyline([], { color: '#00a878', weight: 5, opacity: 0.85 }).addTo(map)
    let dead = false
    const tick = async () => {
      try {
        const { data } = await axios.get(`${API_BASE}/api/share/${id}/`)
        if (dead) return
        setInfo(data)
        if (data.lat != null) {
          const ll = [data.lat, data.lon]
          trailRef.current.addLatLng(ll)
          if (!markRef.current) {
            markRef.current = L.marker(ll).addTo(map).bindPopup('🚛 Truck is here')
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
            <p className="track-route"><b>{info.from || 'Start'}</b> → <b>{info.to || 'Destination'}</b></p>
            <p className="track-meta">
              {info.eta_min != null ? <>ETA about <b>{info.eta_min} min</b> • </> : null}
              Updated {ago} • {live ? <span className="track-live">● LIVE</span> : <span className="track-stale">last known position</span>}
            </p>
          </>
        )}
      </div>
      <div id="track-map" className="track-map" />
    </div>
  )
}
