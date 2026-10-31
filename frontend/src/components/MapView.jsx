import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet.heat'

export const RISK_COLORS = {
  LOW: '#22c55e', MODERATE: '#eab308', HIGH: '#f97316', SEVERE: '#ef4444', NO_TRAVEL: '#991b1b',
}
export const RISK_LABELS = {
  LOW: 'Low', MODERATE: 'Moderate', HIGH: 'High', SEVERE: 'Severe', NO_TRAVEL: 'No Travel',
}

// Three base maps, switchable from the control at the map's top-right — like Google Maps.
// All are free tile services that need no API key (CARTO now requires a key, so it is not used).
function makeBaseLayers() {
  const light = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors', keepBuffer: 4, updateWhenIdle: false, updateWhenZooming: false,
  })
  const dark = L.layerGroup([
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles © Esri — Source: Esri, DeLorme, NAVTEQ', keepBuffer: 4, updateWhenIdle: false, updateWhenZooming: false,
    }),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}'),
  ])
  const satellite = L.layerGroup([
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics', keepBuffer: 4, updateWhenIdle: false, updateWhenZooming: false, maxNativeZoom: 18,
    }),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'),
  ])
  return { light, dark, satellite }
}

// Origin/destination pins drawn with pure CSS (Leaflet's default marker
// images 404 in a Vite build and showed as broken-image boxes).
function pinIcon(kind) {
  return L.divIcon({
    className: 'pin-wrap',
    html: `<div class="pin ${kind}"><span></span></div>`,
    iconSize: [30, 42], iconAnchor: [15, 40], popupAnchor: [0, -38],
  })
}

// Distance from a point to the route (metres) + how far along the route the
// nearest point is (fraction 0..1). Used for live off-route detection.
function nearestOnRoute(route, latlng) {
  const pts = route.geometry.map((g) => L.latLng(g[0], g[1]))
  if (!route._cum) {
    route._cum = [0]
    for (let i = 1; i < pts.length; i++) route._cum.push(route._cum[i - 1] + pts[i - 1].distanceTo(pts[i]))
  }
  const total = route._cum[route._cum.length - 1] || 1
  const kx = 111320 * Math.cos((latlng.lat * Math.PI) / 180)
  const ky = 110540
  let best = { dist: Infinity, frac: 0 }
  for (let i = 1; i < pts.length; i++) {
    const ax = (pts[i - 1].lng - latlng.lng) * kx, ay = (pts[i - 1].lat - latlng.lat) * ky
    const bx = (pts[i].lng - latlng.lng) * kx, by = (pts[i].lat - latlng.lat) * ky
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy || 1
    let f = -(ax * dx + ay * dy) / len2
    f = Math.max(0, Math.min(1, f))
    const px = ax + f * dx, py = ay + f * dy
    const d = Math.hypot(px, py)
    if (d < best.dist) best = { dist: d, frac: (route._cum[i - 1] + f * (route._cum[i] - route._cum[i - 1])) / total }
  }
  return best
}

function pointAtFraction(route, t) {
  const pts = route.geometry.map((g) => L.latLng(g[0], g[1]))
  if (!pts.length) return null
  if (!route._cum) {
    route._cum = [0]
    for (let i = 1; i < pts.length; i++) route._cum.push(route._cum[i - 1] + pts[i - 1].distanceTo(pts[i]))
  }
  const target = t * route._cum[route._cum.length - 1]
  let i = 1
  while (i < route._cum.length - 1 && route._cum[i] < target) i++
  const segLen = route._cum[i] - route._cum[i - 1] || 1
  const f = (target - route._cum[i - 1]) / segLen
  return L.latLng(
    pts[i - 1].lat + (pts[i].lat - pts[i - 1].lat) * f,
    pts[i - 1].lng + (pts[i].lng - pts[i - 1].lng) * f
  )
}

const OFF_ROUTE_METRES = 300 // further than this from the route = off route

// ---------- Turn-by-turn helpers (Google Maps style banner) ----------
function fmtDist(mi) {
  if (mi < 0.1) return `${Math.max(10, Math.round((mi * 5280) / 10) * 10)} ft`
  return `${mi.toFixed(1)} mi`
}
function dirWord(mod = '') {
  if (mod.includes('uturn')) return 'around (U-turn)'
  if (mod.includes('sharp left')) return 'sharply left'
  if (mod.includes('sharp right')) return 'sharply right'
  if (mod.includes('slight left')) return 'slightly left'
  if (mod.includes('slight right')) return 'slightly right'
  if (mod.includes('left')) return 'left'
  if (mod.includes('right')) return 'right'
  return 'straight'
}
function stepArrow(st) {
  const m = st.modifier || '', t = st.type || ''
  if (t === 'arrive') return '📍'
  if (t === 'roundabout' || t === 'rotary') return '↻'
  if (m.includes('uturn')) return '⤶'
  if (m.includes('sharp left')) return '↙'
  if (m.includes('sharp right')) return '↘'
  if (m.includes('slight left')) return '↖'
  if (m.includes('slight right')) return '↗'
  if (m.includes('left')) return '↰'
  if (m.includes('right')) return '↱'
  return '↑'
}
function stepText(st) {
  const name = st.name && st.name !== '-' ? st.name : ''
  const onto = name ? ` onto ${name}` : ''
  switch (st.type) {
    case 'depart': return name ? `towards ${name}` : 'Start your journey'
    case 'arrive': return 'Arrive at your destination'
    case 'turn': return `Turn ${dirWord(st.modifier)}${onto}`
    case 'end of road': return `At the end of the road, turn ${dirWord(st.modifier)}${onto}`
    case 'merge': return `Merge${onto}`
    case 'fork': return `Keep ${dirWord(st.modifier)} at the fork${onto}`
    case 'roundabout': case 'rotary': return `At the roundabout, take exit ${st.exit || ''}${onto}`.replace('  ', ' ')
    case 'on ramp': return `Take the ramp${onto}`
    case 'off ramp': return `Take the exit${onto}`
    case 'new name': case 'continue': return name ? `Continue${onto}` : 'Continue straight'
    default: return name ? `towards ${name}` : 'Continue straight'
  }
}
// The next meaningful maneuver after distMi, plus the one after it ("Then …").
function nextManeuver(route, distMi) {
  const steps = (route.steps || []).filter((st, i) =>
    !(st.type === 'depart' && i > 0) &&
    !(st.type === 'arrive' && st.mile < route.distance_miles - 0.05))
  const idx = steps.findIndex((st) => st.mile > distMi + 0.015)
  if (idx === -1) return null
  return { step: steps[idx], next: steps[idx + 1] && steps[idx + 1].type !== 'arrive' ? steps[idx + 1] : null }
}

// Compass bearing (degrees) from point a to point b.
function bearingDeg(a, b) {
  const rad = Math.PI / 180
  const y = Math.sin((b.lng - a.lng) * rad) * Math.cos(b.lat * rad)
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) -
            Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lng - a.lng) * rad)
  return (Math.atan2(y, x) / rad + 360) % 360
}

// Vehicle icon: a mint badge with a white direction arrow. The arrow element is
// rotated to the direction of travel, Google-Maps style — an emoji truck always
// faces one way, which read as "going the wrong direction".
function vehicleIcon() {
  return L.divIcon({
    className: 'veh-wrap',
    html: '<div class="veh"><svg class="veh-arrow" viewBox="0 0 24 24" width="17" height="17"><path d="M12 2 L19 21 L12 17 L5 21 Z" fill="#ffffff"/></svg></div>',
    iconSize: [34, 34], iconAnchor: [17, 17],
  })
}
function setVehicle(marker, latlng, bearing) {
  if (bearing != null && isFinite(bearing)) marker._bearing = bearing
  marker.setLatLng(latlng)
  const el = marker.getElement()?.querySelector('.veh-arrow')
  if (el && marker._bearing != null) el.style.transform = `rotate(${marker._bearing}deg)`
}

// Follow the vehicle ONLY when it reaches the map's edge zone. Panning on a
// timer (the old approach) made the whole map shake during the journey.
function followVehicle(J, map, pos) {
  if (!map.getBounds().pad(-0.18).contains(pos)) {
    map.panTo(pos, { animate: true, duration: 0.25 })
  }
}

export default function MapView({ result, selectedRouteId, onSelectRoute, showHeat, heatHour, onReroute, onJourneyMode, onJourneyEvent, onEditTrip }) {
  const mapRef = useRef(null)
  const layerRef = useRef(null)
  const heatRef = useRef(null)
  const lastResultRef = useRef(null)
  const locateRef = useRef(null)
  const journeyRef = useRef(null)
  const journeyUiRef = useRef(null)
  const rerouteRef = useRef(onReroute)
  rerouteRef.current = onReroute
  const journeyModeRef = useRef(onJourneyMode)
  journeyModeRef.current = onJourneyMode
  const journeyEventRef = useRef(onJourneyEvent)
  journeyEventRef.current = onJourneyEvent
  const selectRouteRef = useRef(onSelectRoute)
  selectRouteRef.current = onSelectRoute
  const editTripRef = useRef(onEditTrip)
  editTripRef.current = onEditTrip
  // Bumped when a journey starts/ends so the redraw effect can switch between
  // "all routes compared" and "only the driven route" (Google-Maps behaviour).
  const [journeyTick, setJourneyTick] = useState(0)
  const bumpJourneyRef = useRef(null)
  bumpJourneyRef.current = () => setJourneyTick((t) => t + 1)

  // Create the map once: base maps + switcher, GPS locate button, journey controls.
  useEffect(() => {
    if (mapRef.current) return
    const bases = makeBaseLayers()
    mapRef.current = L.map('saferoute-map', { layers: [bases.light], preferCanvas: true, fadeAnimation: false }).setView([34.1, -97.1], 6)
    // If OpenStreetMap tiles keep failing (throttling / slow network), quietly
    // swap the Light base to Esri World Street Map so the map never stays grey.
    const esriStreet = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles © Esri — Source: Esri, DeLorme, NAVTEQ', keepBuffer: 4, updateWhenIdle: false, updateWhenZooming: false,
    })
    let osmErrors = 0, swapped = false
    bases.light.on('tileerror', () => {
      osmErrors += 1
      if (osmErrors >= 8 && !swapped && mapRef.current?.hasLayer(bases.light)) {
        swapped = true
        mapRef.current.removeLayer(bases.light)
        mapRef.current.addLayer(esriStreet)
        esriStreet.setZIndex(0)
      }
    })
    L.control.layers(
      { '☀ Light': bases.light, '🌙 Dark': bases.dark, '🛰 Satellite': bases.satellite },
      null, { collapsed: false, position: 'topright' }
    ).addTo(mapRef.current)
    layerRef.current = L.layerGroup().addTo(mapRef.current)
    heatRef.current = L.layerGroup().addTo(mapRef.current)
    locateRef.current = L.layerGroup().addTo(mapRef.current)
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => { mapRef.current?.invalidateSize() })
      ro.observe(document.getElementById('saferoute-map'))
    }
    const J = {
      mode: null, playing: false, t: 0, raf: null, truck: null, liveDot: null,
      watchId: null, offCount: 0, rerouting: false, route: null, meta: null,
      frac: 0, arrived: false,
    }
    journeyRef.current = J

    // ---- My-location helpers: cache every fix (instant journey starts) and
    // draw the blue "you are here" dot. Used by the locate button, the
    // on-load auto-locate, and live tracking.
    function cachePos(lat, lon, acc) {
      J.lastPos = { lat, lon, acc: acc ?? null, at: Date.now() }
      try { localStorage.setItem('saferoute_lastpos', JSON.stringify(J.lastPos)) } catch {}
    }
    function drawMyLocation(lat, lon, acc, fly) {
      const map = mapRef.current
      if (!map) return
      const ll = [lat, lon]
      locateRef.current.clearLayers()
      L.circle(ll, { radius: acc || 100, color: '#3b82f6', weight: 1, fillColor: '#3b82f6', fillOpacity: 0.15 }).addTo(locateRef.current)
      L.circleMarker(ll, { radius: 8, color: '#ffffff', weight: 3, fillColor: '#3b82f6', fillOpacity: 1 })
        .addTo(locateRef.current).bindPopup('<b>📍 You are here</b><br>Your current GPS location')
      if (fly) map.flyTo(ll, Math.max(map.getZoom(), 11))
    }
    J.cachePos = cachePos; J.drawMyLocation = drawMyLocation
    try { const saved = JSON.parse(localStorage.getItem('saferoute_lastpos') || 'null'); if (saved) J.lastPos = saved } catch {}

    // As soon as the site opens, show the user where they are on the map -
    // only when permission was already granted (never a surprise prompt).
    if (navigator.geolocation && navigator.permissions) {
      navigator.permissions.query({ name: 'geolocation' }).then((st) => {
        if (st.state !== 'granted') return
        navigator.geolocation.getCurrentPosition((pos) => {
          cachePos(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy)
          if (!journeyRef.current?.route) drawMyLocation(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, true)
        }, () => {}, { timeout: 8000, maximumAge: 600000 })
      }).catch(() => {})
    }

    // ---- GPS locate button (bottom-right): show my current position once.
    const LocateControl = L.Control.extend({
      onAdd() {
        const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control locate-control')
        div.innerHTML = '<a href="#" title="Show my current location (GPS)" role="button" aria-label="Show my current location">◎</a>'
        L.DomEvent.on(div, 'click', (e) => {
          L.DomEvent.preventDefault(e)
          const map = mapRef.current
          if (!navigator.geolocation) {
            L.popup().setLatLng(map.getCenter()).setContent('GPS is not available in this browser.').openOn(map)
            return
          }
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              cachePos(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy)
              drawMyLocation(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, true)
            },
            () => { L.popup().setLatLng(map.getCenter()).setContent('Location unavailable — please allow location permission in your browser.').openOn(map) },
            { timeout: 10000, maximumAge: 300000 }
          )
        })
        return div
      },
    })
    new LocateControl({ position: 'bottomright' }).addTo(mapRef.current)

    // ---- Journey controls (bottom-left): Live GPS journey + Demo drive.
    const JourneyControl = L.Control.extend({
      onAdd() {
        const div = L.DomUtil.create('div', 'leaflet-control journey-control')
        div.innerHTML =
          '<div class="jbtns">' +
          '  <button class="jbtn live" disabled>📍 Start Live Journey</button>' +
          '  <button class="jbtn demo" disabled>▶ Demo Drive</button>' +
          '</div>'
        L.DomEvent.disableClickPropagation(div)
        journeyUiRef.current = {
          ...journeyUiRef.current,
          live: div.querySelector('.live'), demo: div.querySelector('.demo'),
          btns: div.querySelector('.jbtns'),
        }
        journeyUiRef.current.live.addEventListener('click', startLive)
        journeyUiRef.current.demo.addEventListener('click', toggleDemo)
        return div
      },
    })
    new JourneyControl({ position: 'bottomleft' }).addTo(mapRef.current)

    // ---- Google Maps style navigation banner (top) ----
    const BannerControl = L.Control.extend({
      onAdd() {
        const div = L.DomUtil.create('div', 'leaflet-control navbanner-wrap')
        div.innerHTML =
          '<div class="navbanner" style="display:none">' +
          '  <div class="nb-main"><span class="nb-arrow">↑</span>' +
          '    <div class="nb-body"><div class="nb-dist"></div><div class="nb-text"></div></div></div>' +
          '  <div class="nb-then" style="display:none"></div>' +
          '</div>'
        L.DomEvent.disableClickPropagation(div)
        const root = div.querySelector('.navbanner')
        journeyUiRef.current = { ...journeyUiRef.current, banner: {
          root, arrow: div.querySelector('.nb-arrow'), dist: div.querySelector('.nb-dist'),
          text: div.querySelector('.nb-text'), then: div.querySelector('.nb-then'),
        } }
        return div
      },
    })
    new BannerControl({ position: 'topleft' }).addTo(mapRef.current)

    // ---- Bottom bar: trip line, ETA, weather risk, End (Google Maps style) ----
    const BarControl = L.Control.extend({
      onAdd() {
        const div = L.DomUtil.create('div', 'leaflet-control navbottom-wrap')
        div.innerHTML =
          '<div class="navbottom" style="display:none">' +
          '  <div class="jedit">' +
          '    <div class="jedit-row"><span class="dot from"></span><input class="jfrom" type="text" autocomplete="off" spellcheck="false" aria-label="From"></div>' +
          '    <div class="jedit-row"><span class="dot to"></span><input class="jto" type="text" autocomplete="off" spellcheck="false" aria-label="To"></div>' +
          '    <button class="japply" style="display:none">↻ Update trip</button>' +
          '  </div>' +
          '  <div class="jchips"></div>' +
          '  <div class="nb-etarow"><span class="jeta"></span><button class="jend">✕ End</button></div>' +
          '  <div class="jbar"><div class="jfill"></div></div>' +
          '  <div class="jstat"></div>' +
          '  <div class="jwarn"></div>' +
          '</div>'
        L.DomEvent.disableClickPropagation(div)
        L.DomEvent.disableScrollPropagation(div)
        const root = div.querySelector('.navbottom')
        const fromInput = div.querySelector('.jfrom')
        const toInput = div.querySelector('.jto')
        const applyBtn = div.querySelector('.japply')
        journeyUiRef.current = { ...journeyUiRef.current,
          panel: root, fromInput, toInput,
          fill: div.querySelector('.jfill'), stat: div.querySelector('.jstat'),
          warn: div.querySelector('.jwarn'), eta: div.querySelector('.jeta'),
          chips: div.querySelector('.jchips'),
        }
        const markDirty = () => {
          const dirty = J.meta && (fromInput.value.trim() !== J.meta.from && fromInput.value.trim() !== '' ||
                                   toInput.value.trim() !== J.meta.to && toInput.value.trim() !== '')
          applyBtn.style.display = dirty ? 'block' : 'none'
        }
        fromInput.addEventListener('input', markDirty)
        toInput.addEventListener('input', markDirty)
        applyBtn.addEventListener('click', () => {
          editTripRef.current?.(fromInput.value, toInput.value)
          applyBtn.style.display = 'none'
          fromInput.blur(); toInput.blur()
        })
        div.querySelector('.jend').addEventListener('click', () => endJourney())
        return div
      },
    })
    new BarControl({ position: 'bottomleft' }).addTo(mapRef.current)

    function setBanner({ arrow = '↑', dist = '', text = '', then = null, tone = '' } = {}) {
      const b = journeyUiRef.current?.banner
      if (!b) return
      b.root.className = 'navbanner' + (tone ? ' ' + tone : '')
      b.arrow.textContent = arrow
      b.dist.textContent = dist
      b.text.textContent = text
      if (then) { b.then.style.display = 'block'; b.then.textContent = then }
      else b.then.style.display = 'none'
    }
    J.setBanner = setBanner

    function showJourneyUi() {
      const ui = journeyUiRef.current
      if (!ui) return
      if (ui.banner) ui.banner.root.style.display = 'block'
      if (ui.panel) ui.panel.style.display = 'block'
      if (ui.btns) ui.btns.style.display = 'none'
    }
    function hideJourneyUi() {
      const ui = journeyUiRef.current
      if (!ui) return
      if (ui.banner) ui.banner.root.style.display = 'none'
      if (ui.panel) ui.panel.style.display = 'none'
      if (ui.btns) ui.btns.style.display = 'block'
    }
    J.showUi = showJourneyUi; J.hideUi = hideJourneyUi

    function setNav() {
      const ui = journeyUiRef.current
      if (!ui || !J.meta) return
      if (ui.fromInput && document.activeElement !== ui.fromInput) ui.fromInput.value = J.meta.from
      if (ui.toInput && document.activeElement !== ui.toInput) ui.toInput.value = J.meta.to
      if (ui.chips && J.routesMeta) {
        ui.chips.innerHTML = '<span>Route:</span>' + J.routesMeta.map((r) =>
          `<button data-rid="${r.id}" class="${J.route?.id === r.id ? 'on' : ''}">${r.label.replace('Route ', '')}</button>`).join('')
        ui.chips.querySelectorAll('button').forEach((b) =>
          b.addEventListener('click', () => selectRouteRef.current?.(Number(b.dataset.rid))))
      }
    }
    J.setNav = setNav

    function setButtons() {
      const ui = journeyUiRef.current
      if (!ui) return
      const has = !!J.route
      ui.live.disabled = !has || J.mode === 'demo'
      ui.demo.disabled = !has || J.mode === 'live'
      ui.live.textContent = J.mode === 'live' ? '📍 Live Journey running…' : '📍 Start Live Journey'
      ui.demo.textContent = J.mode === 'demo' ? (J.playing ? '⏸ Pause Demo' : '▶ Resume Demo') : '▶ Demo Drive'
    }
    J.setButtons = setButtons

    function showPanel() {
      showJourneyUi()
      setBanner({ arrow: '🧭', text: J.mode === 'live' ? 'Waiting for GPS signal…' : 'Journey started', dist: '' })
      if (J.mode === 'live') J.bannerHold = true
      setNav()
      journeyModeRef.current?.(true)
      bumpJourneyRef.current?.()
      // The layout switches to fullscreen over the next frames — refit the map.
      setTimeout(() => mapRef.current?.invalidateSize(), 120)
      setTimeout(() => mapRef.current?.invalidateSize(), 450)
    }

    function endJourney() {
      if (J.mode && !J.arrived) {
        journeyEventRef.current?.({ type: 'journey', mode: J.mode,
          progress: J.mode === 'demo' ? J.t : J.frac, completed: false,
          routeLabel: J.route?.label, miles: J.route?.distance_miles,
          from: J.meta?.from, to: J.meta?.to })
      }
      if (J.raf) cancelAnimationFrame(J.raf)
      if (J.watchId != null && navigator.geolocation) navigator.geolocation.clearWatch(J.watchId)
      if (J.truck) { J.truck.remove(); J.truck = null }
      if (J.liveDot) { J.liveDot.remove(); J.liveDot = null }
      Object.assign(J, { mode: null, playing: false, t: 0, raf: null, watchId: null, offCount: 0, rerouting: false, frac: 0, arrived: false })
      J.bannerHold = false
      hideJourneyUi()
      setButtons()
      journeyModeRef.current?.(false)
      bumpJourneyRef.current?.()
    }
    J.end = endJourney

    // ---------- DEMO DRIVE: simulated truck along the selected route ----------
    function toggleDemo() {
      if (!J.route) return
      if (J.mode === 'demo' && J.playing) {
        J.playing = false
        if (J.raf) cancelAnimationFrame(J.raf)
        setButtons()
        return
      }
      if (J.t >= 1) J.t = 0
      J.mode = 'demo'; J.playing = true
      showPanel(); setButtons()
      animateDemo()
    }

    function animateDemo() {
      const map = mapRef.current
      const route = J.route
      if (!route || !map) return
      const DURATION = 20000
      let last = performance.now()
      const step = (now) => {
        if (J.mode !== 'demo' || !J.playing) return
        const dt = now - last; last = now
        J.t = Math.min(1, J.t + dt / DURATION)
        const pos = pointAtFraction(J.route, J.t)
        if (pos) {
          const ahead = pointAtFraction(J.route, Math.min(1, J.t + 0.006))
          const brg = ahead ? bearingDeg(pos, ahead) : null
          if (!J.truck) {
            J.truck = L.marker(pos, { icon: vehicleIcon() }).addTo(map)
          }
          setVehicle(J.truck, pos, brg)
          followVehicle(J, map, pos)
          updatePanel(J.route, J.t)
        }
        if (J.t < 1) J.raf = requestAnimationFrame(step)
        else {
          J.playing = false; J.raf = null
          J.bannerHold = true
          setBanner({ arrow: '🎉', text: 'You have arrived', dist: '', tone: 'ok', then: 'Trip complete — well driven!' })
          if (journeyUiRef.current.eta) journeyUiRef.current.eta.innerHTML = '<b>Arrived</b><span> • trip complete</span>'
          journeyUiRef.current.warn.textContent = ''
          setButtons()
        }
      }
      J.raf = requestAnimationFrame(step)
    }

    // ---------- LIVE JOURNEY: real GPS tracking + off-route rerouting ----------
    function startLive() {
      if (!J.route) return
      if (!navigator.geolocation) {
        journeyUiRef.current.warn.textContent = 'GPS is not available in this browser.'
        showPanel()
        return
      }
      J.mode = 'live'; J.playing = true; J.offCount = 0; J.rerouting = false; J.coolUntil = 0
      showPanel(); setButtons()
      const ui = journeyUiRef.current
      ui.stat.textContent = 'Waiting for GPS signal… allow location access if asked.'
      ui.warn.textContent = ''
      if (ui.eta) ui.eta.innerHTML = ''
      // Instant start, Google-Maps style: if we already know where the driver
      // is (fix from page load or an earlier session), draw the guidance from
      // that fix right away - live GPS refines it within seconds.
      const cached = J.lastPos
      if (cached && Date.now() - cached.at < 15 * 60000) {
        onLivePosition({ coords: { latitude: cached.lat, longitude: cached.lon, accuracy: cached.acc ?? 1000, heading: null, speed: null } })
      }
      // One fast network fix as a bridge until the high-accuracy watch locks.
      navigator.geolocation.getCurrentPosition(
        (pos) => onLivePosition(pos), () => {},
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 30000 })
      J.watchId = navigator.geolocation.watchPosition(
        (pos) => onLivePosition(pos),
        () => {
          ui.warn.textContent = 'GPS signal lost or permission denied — journey tracking paused.'
          ui.warn.className = 'jwarn bad'
          setBanner({ arrow: '⚠', text: 'GPS signal lost', dist: '', tone: 'warn', then: 'Tracking paused — check location permission.' })
        },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
      )
    }

    function onLivePosition(pos) {
      const map = mapRef.current
      const route = J.route
      if (!map || !route || J.mode !== 'live') return
      const ll = L.latLng(pos.coords.latitude, pos.coords.longitude)
      let brg = null
      if (pos.coords.heading != null && isFinite(pos.coords.heading) && (pos.coords.speed ?? 0) > 0.5) {
        brg = pos.coords.heading
      } else if (J._lastPos && J._lastPos.distanceTo(ll) > 5) {
        brg = bearingDeg(J._lastPos, ll)
      }
      if (!J.liveDot) {
        J.liveDot = L.marker(ll, { icon: vehicleIcon() }).addTo(map)
      }
      setVehicle(J.liveDot, ll, brg)
      J._lastPos = ll
      cachePos(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy)
      followVehicle(J, map, ll)

      const near = nearestOnRoute(route, ll)
      const ui = journeyUiRef.current
      if (J.bannerHold && !J.rerouting) J.bannerHold = false  // first GPS fix: banner goes live
      updatePanel(route, Math.min(1, Math.max(0, near.frac)))
      // GPS jitter must never cry wolf: the off-route distance grows with the
      // fix's own accuracy, it takes 3 fixes in a row, and after one reroute
      // the detector cools down for 45s. The banner carries the message -
      // no map popup (it kept re-appearing and covering the road).
      const threshold = Math.max(OFF_ROUTE_METRES, (pos.coords.accuracy || 0) * 1.5)
      if (near.dist <= threshold) {
        J.offCount = 0
        J.bannerHold = false
        if (!J.rerouting) { ui.warn.textContent = 'On route ✓ — following the highlighted route.'; ui.warn.className = 'jwarn' }
      } else {
        J.offCount += 1
        J.bannerHold = true
        if (J.offCount >= 3 && !J.rerouting && Date.now() > (J.coolUntil || 0)) {
          J.rerouting = true
          J.coolUntil = Date.now() + 45000
          ui.warn.textContent = '⚠ You are off the route! Finding a new route from your current location…'
          ui.warn.className = 'jwarn bad'
          setBanner({ arrow: '⚠', text: 'You are off the route!', dist: '', tone: 'warn', then: 'Finding a new route from your current location…' })
          rerouteRef.current?.(pos.coords.latitude, pos.coords.longitude)
        } else if (!J.rerouting) {
          ui.warn.textContent = '⚠ You seem to be leaving the route…'
          ui.warn.className = 'jwarn bad'
          setBanner({ arrow: '⚠', text: 'You seem to be leaving the route…', dist: '', tone: 'warn' })
        }
      }
    }

    function updatePanel(route, t) {
      const ui = journeyUiRef.current
      if (!ui) return
      J.frac = t
      if (t >= 0.995 && !J.arrived && J.mode) {
        J.arrived = true
        journeyEventRef.current?.({ type: 'journey', mode: J.mode, progress: 1, completed: true,
          routeLabel: route.label, miles: route.distance_miles,
          from: J.meta?.from, to: J.meta?.to })
      }
      const totalMiles = route.distance_miles
      const mileNow = t * totalMiles
      ui.fill.style.width = `${Math.round(t * 100)}%`
      const minsLeft = Math.max(0, Math.round(route.summary.duration_min * (1 - t)))
      if (ui.eta) {
        const etaClock = new Date(Date.now() + minsLeft * 60000)
          .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        ui.eta.innerHTML = `<b>${minsLeft} min</b><span> • ${(totalMiles - mileNow).toFixed(1)} mi left • ETA ${etaClock}</span>`
      }
      if (!J.bannerHold && !J.rerouting) {
        const nm = nextManeuver(route, mileNow)
        if (nm) setBanner({
          arrow: stepArrow(nm.step), dist: fmtDist(nm.step.mile - mileNow),
          text: stepText(nm.step),
          then: nm.next ? `Then ${stepArrow(nm.next)} ${nm.next.name || ''}`.trim() : null,
        })
      }
      const passed = [...route.checkpoints].filter((c) => c.mile <= mileNow)
      const cur = passed[passed.length - 1]
      const next = route.checkpoints.find((c) => c.mile > mileNow)
      ui.stat.textContent =
        `${route.label}: Mile ${mileNow.toFixed(0)} of ${totalMiles} • about ${minsLeft} min to go` +
        (next ? ` • Next checkpoint: Mile ${next.mile}` : '')
      if (J.rerouting) return // keep the reroute message visible until the new route lands
      if (cur) {
        const bad = cur.risk === 'HIGH' || cur.risk === 'SEVERE' || cur.risk === 'NO_TRAVEL'
        ui.warn.textContent = bad
          ? `⚠ Mile ${cur.mile}: ${RISK_LABELS[cur.risk]} risk — wind ${cur.wind_mph} mph. ${cur.risk === 'NO_TRAVEL' ? 'Do not travel in this stretch.' : 'Drive carefully.'}`
          : `Mile ${cur.mile}: ${RISK_LABELS[cur.risk]} risk — wind ${cur.wind_mph} mph, rain ${cur.rain_in_hr} in/hr, snow ${cur.snow_in_hr} in/hr`
        ui.warn.className = 'jwarn' + (bad ? ' bad' : '')
      }
    }
    J.updatePanel = updatePanel
  }, [])

  // Redraw routes/checkpoints/heat whenever inputs change.
  useEffect(() => {
    const map = mapRef.current, layers = layerRef.current
    if (!map || !layers) return
    map.invalidateSize()

    const J = journeyRef.current
    const sel = result?.routes.find((r) => r.id === selectedRouteId) || result?.routes[0] || null
    const isNewResult = lastResultRef.current !== result
    if (J) {
      const sameDestination = J.meta && result &&
        Math.abs(J.meta.destLat - result.destination.lat) < 0.001 &&
        Math.abs(J.meta.destLon - result.destination.lon) < 0.001
      if (J.mode === 'demo' && !isNewResult && sel) {
        // Route switch mid-demo: keep driving — same progress fraction on the
        // newly selected route, truck and panel stay alive.
        J.route = sel
      } else if (J.mode === 'live' && J.watchId != null && sameDestination) {
        // This result is a reroute (or a refresh of the same trip): keep tracking.
        const wasRerouting = J.rerouting
        J.route = sel
        J.offCount = 0
        J.rerouting = false
        if (wasRerouting && journeyUiRef.current) {
          journeyUiRef.current.warn.textContent = '✅ New route ready — follow the highlighted route.'
          journeyUiRef.current.warn.className = 'jwarn'
          J.bannerHold = true
          J.setBanner?.({ arrow: '✅', text: 'New route ready', dist: '', tone: 'ok', then: 'Follow the highlighted route.' })
          setTimeout(() => { J.bannerHold = false }, 4000)
        }
      } else {
        // A genuinely new search (or mode not live): reset the journey.
        if (J.mode) J.end?.()
        if (J.truck) { J.truck.remove(); J.truck = null }
        Object.assign(J, { playing: false, raf: null, t: 0, route: sel, mode: null })
        J.hideUi?.()
      }
      J.meta = result ? {
        from: result.origin.name, to: result.destination.name,
        destLat: result.destination.lat, destLon: result.destination.lon,
      } : null
      J.routesMeta = result ? result.routes.map((r) => ({ id: r.id, label: r.label })) : null
      if (!J.mode) J.route = sel
      J.setButtons?.()
      if (journeyUiRef.current?.panel.style.display !== 'none') J.setNav?.()
    }

    layers.clearLayers()
    if (!result) return

    const bounds = []
    const inJourney = !!journeyRef.current?.mode
    result.routes.forEach((r) => {
      // During a journey draw ONLY the route being driven - parallel lines
      // for the other options just confuse the driver (Victor's feedback).
      if (inJourney && sel && r.id !== sel.id) return
      const isRec = r.id === result.recommended_route_id
      const isSel = r.id === selectedRouteId
      const line = L.polyline(r.geometry, {
        color: isRec ? '#00c896' : '#3b82f6',
        weight: isSel ? 7 : isRec ? 6 : 4,
        opacity: 0.95,
      }).addTo(layers)
      line.on('click', () => onSelectRoute(r.id))
      line.bindPopup(`<b>${r.label}</b><br>${r.distance_miles} miles`)
      r.geometry.forEach((p) => bounds.push(p))
    })

    const pin = (loc, text, kind) =>
      L.marker([loc.lat, loc.lon], { icon: pinIcon(kind) }).addTo(layers)
        .bindPopup(`<b>${text}</b><br>${loc.name || ''}`)
    pin(result.origin, 'Origin', 'from')
    pin(result.destination, 'Destination', 'to')

    const selRoute = result.routes.find((r) => r.id === selectedRouteId) || result.routes[0]
    selRoute.checkpoints.forEach((c) => {
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

    // Fit the map to the routes ONLY for a genuinely new result — switching the
    // selected route (A -> B) must be instant and must never yank the camera,
    // especially during a live journey where the map belongs to the driver.
    lastResultRef.current = result
    const journeyActive = journeyRef.current?.mode
    if (bounds.length && isNewResult && !journeyActive) {
      map.fitBounds(bounds, { padding: [30, 30] })
    }
  }, [result, selectedRouteId, onSelectRoute, journeyTick])

  // Heat layer on its own effect: rebuilding the heat canvas on every route
  // selection made switching feel slow, so it only redraws when the result,
  // the toggle, or the forecast hour actually changes.
  useEffect(() => {
    const map = mapRef.current, heat = heatRef.current
    if (!map || !heat) return
    heat.clearLayers()
    if (!showHeat || !result?.heatmap?.points?.length || !L.heatLayer) return
    try {
      if (map.getSize().y > 0) {
        const pts = result.heatmap.points.map((pt) => [pt.lat, pt.lon, Math.max(pt.risk[heatHour] / 4, 0.12)])
        L.heatLayer(pts, {
          radius: 30, blur: 22, maxZoom: 10, minOpacity: 0.55,
          gradient: { 0.0: '#3b82f6', 0.3: '#22c55e', 0.55: '#eab308', 0.78: '#f97316', 1.0: '#ef4444' },
        }).addTo(heat)
      }
    } catch (e) { /* heatmap is decorative — skip it if the canvas fails */ }
  }, [result, showHeat, heatHour])

  return <div id="saferoute-map" className="map" />
}
