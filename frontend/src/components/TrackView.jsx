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

function stepText(st) {
  if (!st) return ''
  const name = st.name && st.name !== '-' ? st.name : ''
  if (st.type === 'depart') return name ? `Head towards ${name}` : 'Head towards the truck'
  if (st.type === 'arrive') return 'You have reached the truck'
  const mod = (st.modifier || '').replace(/-/g, ' ')
  if (st.type === 'turn') return name ? `Turn ${mod} onto ${name}` : `Turn ${mod}`
  if (st.type === 'continue') return name ? `Continue onto ${name}` : 'Continue straight'
  if (st.type === 'roundabout' || st.type === 'rotary') return name ? `At the roundabout, exit onto ${name}` : 'Take the roundabout exit'
  if (st.type === 'merge') return name ? `Merge onto ${name}` : 'Merge'
  if (st.type === 'fork') return name ? `Keep ${mod} onto ${name}` : `Keep ${mod}`
  return name ? `Continue towards ${name}` : 'Continue'
}
function stepArrow(st) {
  if (!st) return '↑'
  if (st.type === 'arrive') return '🏁'
  if (st.type === 'roundabout' || st.type === 'rotary') return '⟳'
  const m = st.modifier || ''
  if (m.includes('left')) return m.includes('sharp') ? '↩' : '↰'
  if (m.includes('right')) return m.includes('sharp') ? '↪' : '↱'
  if (m.includes('uturn')) return '↺'
  return '↑'
}
function fmtDist(mi) {
  if (mi < 0.1) return `${Math.max(10, Math.round(mi * 5280 / 10) * 10)} FT`
  return `${mi.toFixed(1)} MI`
}

// Public live-tracking page: anyone with a /track/<id> link watches the
// truck move. Victor's flow: the page ASKS "want directions to this
// truck?" - Navigate starts an IN-SITE navigation (our own map, banner +
// bottom bar like the driver's Live Journey - NOT a Google Maps handoff);
// "Just show location" keeps only the truck's red pin.
export default function TrackView({ id }) {
  const mapRef = useRef(null)
  const markRef = useRef(null)
  const trailRef = useRef(null)
  const meRef = useRef(null)
  const routeRef = useRef(null)
  const truckRef = useRef(null)   // latest truck {lat, lon}
  const navRef = useRef(null)     // active navigation state
  const [info, setInfo] = useState(null)
  const [err, setErr] = useState('')
  const [phase, setPhase] = useState('ask')   // ask | show | nav | denied
  const [navUi, setNavUi] = useState(null)    // {arrow, dist, text, then, etaMin, milesLeft}
  const phaseRef = useRef('ask')
  const setPhaseBoth = (p) => { phaseRef.current = p; setPhase(p) }

  function speak(text) {
    try {
      if (localStorage.getItem('saferoute_voice') === 'off') return
      const u = new SpeechSynthesisUtterance(text)
      u.lang = 'en-US'
      speechSynthesis.cancel()
      speechSynthesis.speak(u)
    } catch {}
  }

  async function computeRoute(meLat, meLon) {
    const t = truckRef.current
    if (!t) return
    const nav = navRef.current || (navRef.current = {})
    nav.meLat = meLat; nav.meLon = meLon
    nav.destLat = t.lat; nav.destLon = t.lon
    nav.lastRun = Date.now()
    try {
      const { data } = await axios.post(`${API_BASE}/api/analyze/`, {
        origin: `${meLat.toFixed(5)}, ${meLon.toFixed(5)}`,
        destination: `${t.lat.toFixed(5)}, ${t.lon.toFixed(5)}`,
        departure: new Date().toISOString(),
        load_lb: 35000,
      })
      const r = data.routes?.[0]
      if (!r || !mapRef.current || phaseRef.current !== 'nav') return
      nav.route = r
      // cumulative miles at each geometry vertex, for progress + step timing
      nav.cum = [0]
      for (let i = 1; i < r.geometry.length; i++) {
        const [aLat, aLon] = r.geometry[i - 1]
        const [bLat, bLon] = r.geometry[i]
        nav.cum.push(nav.cum[i - 1] + distMeters(aLat, aLon, bLat, bLon) / 1609.344)
      }
      nav.spokenStep = -1
      const latlngs = r.geometry.map(([lat, lon]) => [lat, lon])
      if (routeRef.current) { routeRef.current.setLatLngs(latlngs); routeRef.current.setStyle({ dashArray: null }) }
      else routeRef.current = L.polyline(latlngs, { color: '#2563eb', weight: 6, opacity: 0.9 }).addTo(mapRef.current)
      updateGuidance(meLat, meLon, true)
    } catch {
      // Very short hop / routing refused: dashed straight line still guides.
      const t2 = truckRef.current
      if (t2 && mapRef.current && phaseRef.current === 'nav') {
        const straight = [[meLat, meLon], [t2.lat, t2.lon]]
        if (routeRef.current) { routeRef.current.setLatLngs(straight); routeRef.current.setStyle({ dashArray: '6 8' }) }
        else routeRef.current = L.polyline(straight, { color: '#2563eb', weight: 5, opacity: 0.85, dashArray: '6 8' }).addTo(mapRef.current)
        const mi = distMeters(meLat, meLon, t2.lat, t2.lon) / 1609.344
        setNavUi({ arrow: '🧭', dist: fmtDist(mi), text: 'Head straight to the truck', then: '', etaMin: Math.max(1, Math.round(mi / 25 * 60)), milesLeft: Math.round(mi * 10) / 10 })
      }
    }
  }

  function updateGuidance(lat, lon, fit = false) {
    const nav = navRef.current
    const map = mapRef.current
    if (!nav?.route || !map) return
    const geom = nav.route.geometry
    // nearest vertex -> how far along the route the viewer is
    let best = 0, bestD = Infinity
    for (let i = 0; i < geom.length; i++) {
      const d = distMeters(lat, lon, geom[i][0], geom[i][1])
      if (d < bestD) { bestD = d; best = i }
    }
    const mileNow = nav.cum[best]
    const total = nav.route.distance_miles
    const milesLeft = Math.max(0, total - mileNow)
    const etaMin = Math.max(1, Math.round(nav.route.duration_min * (total ? milesLeft / total : 0)))
    const steps = nav.route.steps || []
    let idx = steps.findIndex((st) => st.mile > mileNow + 0.02)
    if (idx === -1) idx = steps.length - 1
    const st = steps[idx]
    const distTo = st ? Math.max(0, st.mile - mileNow) : milesLeft
    const truck = truckRef.current
    const arrived = truck && distMeters(lat, lon, truck.lat, truck.lon) < 60
    if (arrived) {
      setNavUi({ arrow: '🏁', dist: '', text: 'You have reached the truck', then: '', etaMin: 0, milesLeft: 0 })
      if (nav.spokenStep !== 999) { nav.spokenStep = 999; speak('You have reached the truck.') }
      return
    }
    setNavUi({
      arrow: stepArrow(st), dist: fmtDist(distTo), text: stepText(st),
      then: steps[idx + 1] ? `Then ${stepText(steps[idx + 1])}` : '',
      etaMin, milesLeft: Math.round(milesLeft * 10) / 10,
    })
    if (distTo <= 0.15 && nav.spokenStep !== idx) {
      nav.spokenStep = idx
      speak(stepText(st))
    }
    if (fit) map.fitBounds(L.latLngBounds(geom.map(([a, b]) => [a, b])).extend([lat, lon]).pad(0.08))
  }

  function onViewerPos(pos) {
    const { latitude: lat, longitude: lon, accuracy: acc } = pos.coords
    const map = mapRef.current
    if (!map) return
    if (meRef.current) meRef.current.setLatLng([lat, lon])
    else meRef.current = L.marker([lat, lon], { icon: meIcon }).addTo(map).bindPopup('📍 You are here')
    const nav = navRef.current
    if (nav?.follow !== false) map.setView([lat, lon], Math.max(map.getZoom(), 16), { animate: true })
    updateGuidance(lat, lon)
    // Re-route when the truck moved away from the routed point, or the
    // viewer moved well away from where the route was computed.
    const t = truckRef.current
    if (t && nav?.route && Date.now() - (nav.lastRun || 0) > 45000 &&
        (distMeters(nav.destLat, nav.destLon, t.lat, t.lon) > 300 ||
         distMeters(nav.meLat, nav.meLon, lat, lon) > 250)) {
      computeRoute(lat, lon)
    }
    void acc
  }

  function startNav() {
    if (!navigator.geolocation) { setPhaseBoth('denied'); return }
    setPhaseBoth('nav')
    speak('Starting navigation to the truck. Drive safe.')
    const begin = (pos) => {
      navRef.current = { follow: true }
      onViewerPos(pos)
      computeRoute(pos.coords.latitude, pos.coords.longitude)
      navRef.current.watchId = navigator.geolocation.watchPosition(
        onViewerPos,
        () => {},
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
      )
    }
    navigator.geolocation.getCurrentPosition(
      begin,
      () => setPhaseBoth('denied'),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
    )
  }

  function endNav() {
    const nav = navRef.current
    if (nav?.watchId != null) navigator.geolocation.clearWatch(nav.watchId)
    navRef.current = null
    if (routeRef.current && mapRef.current) { mapRef.current.removeLayer(routeRef.current); routeRef.current = null }
    if (meRef.current && mapRef.current) { mapRef.current.removeLayer(meRef.current); meRef.current = null }
    setNavUi(null)
    setPhaseBoth('show')
    try { speechSynthesis.cancel() } catch {}
  }

  useEffect(() => {
    const map = L.map('track-map', { rotate: true, touchRotate: false, rotateControl: false, attributionControl: false }).setView([20, 78], 5)
    mapRef.current = map
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {}).addTo(map)
    trailRef.current = L.polyline([], { color: '#00a878', weight: 5, opacity: 0.85 }).addTo(map)
    map.on('dragstart', () => { if (navRef.current) navRef.current.follow = false })
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
  const navigating = phase === 'nav'
  return (
    <div className={navigating ? 'track-page nav-on' : 'track-page'}>
      {!navigating && (
        <div className="track-card">
          <div className="track-head">
            <h2>🚛 SafeRoute — Live Trip</h2>
            <a className="track-home" href="/" title="Go to the SafeRoute home page">🏠</a>
          </div>
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
                <button className="track-go" onClick={startNav}>Navigate to it</button>
                <button className="track-stay" onClick={() => setPhaseBoth('show')}>Just show location</button>
              </div>
            </div>
          )}
          {phase === 'denied' && <p className="track-meta">Location permission was not given — showing the truck's location only. <button className="track-retry" onClick={startNav}>Try again</button></p>}
          {phase === 'show' && info && !err && (
            <p className="track-meta">
              <button className="track-retry" onClick={startNav}>🧭 Navigate to the truck</button>
              <span> — turn-by-turn, right here on this map.</span>
            </p>
          )}
        </div>
      )}
      <div className="track-mapwrap">
        <div id="track-map" className="track-map" />
        {navigating && (
          <>
            <div className="tnav-banner">
              <div className="tnav-arrow">{navUi?.arrow || '↑'}</div>
              <div className="tnav-main">
                <div className="tnav-dist">{navUi?.dist || '…'}</div>
                <div className="tnav-text">{navUi?.text || 'Finding your route to the truck…'}</div>
                {navUi?.then && <div className="tnav-then">{navUi.then}</div>}
              </div>
            </div>
            <div className="tnav-bar">
              <div className="tnav-eta">
                {navUi
                  ? <><b>{navUi.etaMin} min</b> • {navUi.milesLeft} mi to the truck</>
                  : 'Locating you…'}
              </div>
              <button className="tnav-recenter" title="Re-centre on me"
                onClick={() => {
                  const nav = navRef.current
                  if (nav) nav.follow = true
                  if (meRef.current && mapRef.current) mapRef.current.setView(meRef.current.getLatLng(), 16, { animate: true })
                }}>⌖</button>
              <button className="tnav-end" onClick={endNav}>✕ End</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
