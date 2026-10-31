import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet.heat'
import 'leaflet-rotate' // two-finger map rotation (Victor's ask)

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
  if (st?.name && /flyover|bridge/i.test(st.name)) return '🌉' // flyovers/bridges called out clearly
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
function shortName(name) {
  return String(name || '').split(',').slice(0, 2).join(',')
}
function stepText(st) {
  const name = st.name && st.name !== '-' ? st.name : ''
  const onto = name ? ` onto ${name}` : ''
  switch (st.type) {
    case 'depart': return `Head ${st.bearing != null ? compassOf(st.bearing) : 'out'}${name ? ` towards ${name}` : ''}`
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
const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest']
function compassOf(deg) { return COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8] }
function initialBearing(route) {
  const g = route.geometry || []
  if (g.length < 2) return 0
  const a = { lat: g[0][0], lng: g[0][1] }
  const k = Math.min(g.length - 1, 12)
  const b = { lat: g[k][0], lng: g[k][1] }
  return bearingDeg(a, b)
}

function nextManeuver(route, distMi) {
  const steps = (route.steps || []).filter((st, i) =>
    !(st.type === 'depart' && i > 0) &&
    !(st.type === 'arrive' && st.mile < route.distance_miles - 0.05))
  // At the very start, Google-Maps style: the first instruction is the
  // depart direction ("Head south towards HMT Rd"), then the first turn.
  if (distMi <= 0.03 && steps[0]?.type === 'depart') {
    const firstTurn = steps.find((st) => st.mile > 0.015 && st.type !== 'depart') || null
    return { step: { ...steps[0], bearing: initialBearing(route) }, next: firstTurn }
  }
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
// Route lines + checkpoint dots render as SVG, not canvas: during pan /
// two-finger rotate the browser just transforms the SVG layer (GPU-cheap),
// so the green line stays glued to the road instead of lagging behind and
// snapping back (Victor's video feedback).
const svgRenderer = L.svg({ padding: 0.5 })

function followVehicle(J, map, pos) {
  if (J.followLock) { map.panTo(pos, { animate: true, duration: 0.25 }); return }
  if (!map.getBounds().pad(-0.18).contains(pos)) {
    map.panTo(pos, { animate: true, duration: 0.25 })
  }
}

export default function MapView({ result, selectedRouteId, onSelectRoute, showHeat, heatHour, onReroute, onJourneyMode, onJourneyEvent, onEditTrip, editSignalRef }) {
  const mapRef = useRef(null)
  const layerRef = useRef(null)
  const heatRef = useRef(null)
  const lastResultRef = useRef(null)
  const locateRef = useRef(null)
  const journeyRef = useRef(null)
  const journeyUiRef = useRef({})
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
    let savedBase = 'light'
    try { savedBase = localStorage.getItem('saferoute_base') || 'light' } catch {}
    if (!bases[savedBase]) savedBase = 'light'
    mapRef.current = L.map('saferoute-map', {
      attributionControl: false, // Victor: no "Leaflet / OSM contributors" strip at the bottom
      layers: [bases[savedBase]], preferCanvas: true, fadeAnimation: false,
      rotate: true, touchRotate: true, rotateControl: false, // twist with two fingers; no plugin compass box (our Re-centre resets north)
    }).setView([34.1, -97.1], 6)
    window.__srMap = mapRef.current // debug/testing handle
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
    // Base-map switcher as a small card of symbol buttons (Victor's ask):
    // Light / Dark / Satellite, always visible - including mid-journey.
    const BaseControl = L.Control.extend({
      onAdd() {
        const div = L.DomUtil.create('div', 'leaflet-control basectl')
        const defs = [['light', '☀️', 'Light'], ['dark', '🌙', 'Dark'], ['satellite', '🛰️', 'Satellite']]
        div.innerHTML = defs.map(([k, icon, label]) =>
          `<button data-base="${k}" class="${k === savedBase ? 'on' : ''}" title="${label} map">${icon}<span>${label}</span></button>`).join('')
        L.DomEvent.disableClickPropagation(div)
        L.DomEvent.disableScrollPropagation(div)
        div.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
          const k = b.dataset.base
          const map = mapRef.current
          Object.entries(bases).forEach(([key, layer]) => {
            if (key === k) { if (!map.hasLayer(layer)) { map.addLayer(layer); layer.setZIndex?.(0) } }
            else if (map.hasLayer(layer)) map.removeLayer(layer)
          })
          div.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b))
          try { localStorage.setItem('saferoute_base', k) } catch {}
        }))
        return div
      },
    })
    new BaseControl({ position: 'topright' }).addTo(mapRef.current)
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
      voiceOn: (() => { try { return localStorage.getItem('saferoute_voice') !== '0' } catch { return true } })(),
      voiceStep: null, voiceStage: 0, joined: false,
    }
    journeyRef.current = J
    mapRef.current.on('dragstart', () => { J.followLock = false })

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
      L.circle(ll, { renderer: svgRenderer, radius: acc || 100, color: '#3b82f6', weight: 1, fillColor: '#3b82f6', fillOpacity: 0.15 }).addTo(locateRef.current)
      L.circleMarker(ll, { renderer: svgRenderer, radius: 8, color: '#ffffff', weight: 3, fillColor: '#3b82f6', fillOpacity: 1 })
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
        journeyUiRef.current.locate = div
        return div
      },
    })
    new LocateControl({ position: 'bottomright' }).addTo(mapRef.current)

    // ---- Journey controls (bottom-left): Live GPS journey start button.
    const JourneyControl = L.Control.extend({
      onAdd() {
        const div = L.DomUtil.create('div', 'leaflet-control journey-control')
        div.innerHTML =
          '<div class="jbtns">' +
          '  <button class="jbtn live" disabled>📍 Start Live Journey</button>' +
          '</div>'
        L.DomEvent.disableClickPropagation(div)
        journeyUiRef.current = {
          ...journeyUiRef.current,
          live: div.querySelector('.live'),
          btns: div.querySelector('.jbtns'),
        }
        journeyUiRef.current.live.addEventListener('click', startLive)
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
          '    <div class="jswaprow"><button class="jswap" title="Swap start and destination">⇅ Swap</button><button class="japply" style="display:none">↻ Update trip</button></div>' +
          '  </div>' +
          '  <div class="jchips"></div>' +
          '  <div class="nb-etarow"><span class="jeta"></span><button class="jvoice" title="Voice guidance on/off">🔊</button><button class="jend">✕ End</button></div>' +
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
          chips: div.querySelector('.jchips'), voice: div.querySelector('.jvoice'),
        }
        journeyUiRef.current.voice.textContent = J.voiceOn ? '🔊' : '🔇'
        journeyUiRef.current.voice.addEventListener('click', () => {
          J.voiceOn = !J.voiceOn
          try { localStorage.setItem('saferoute_voice', J.voiceOn ? '1' : '0') } catch {}
          journeyUiRef.current.voice.textContent = J.voiceOn ? '🔊' : '🔇'
          if (J.voiceOn) speak('Voice guidance on')
          else { try { window.speechSynthesis?.cancel() } catch {} }
        })
        const markDirty = () => {
          const dirty = J.meta && ((fromInput.value.trim() !== J.meta.from && fromInput.value.trim() !== shortName(J.meta.from) && fromInput.value.trim() !== '') ||
                                   (toInput.value.trim() !== J.meta.to && toInput.value.trim() !== shortName(J.meta.to) && toInput.value.trim() !== ''))
          applyBtn.style.display = dirty ? 'block' : 'none'
        }
        fromInput.addEventListener('input', markDirty)
        toInput.addEventListener('input', markDirty)
        const applyEdit = () => {
          editTripRef.current?.(fromInput.value, toInput.value)
          applyBtn.style.display = 'none'
          fromInput.blur(); toInput.blur()
        }
        applyBtn.addEventListener('click', applyEdit)
        div.querySelector('.jswap').addEventListener('click', () => {
          const t = fromInput.value
          fromInput.value = toInput.value
          toInput.value = t
          applyEdit() // a swap is a complete change: rebuild the trip at once
        })
        div.querySelector('.jend').addEventListener('click', () => endJourney())
        return div
      },
    })
    new BarControl({ position: 'bottomleft' }).addTo(mapRef.current)

    // Re-centre button (Google-Maps style): visible only during a journey,
    // jumps the camera back to the driver at street level.
    const RecenterControl = L.Control.extend({
      onAdd() {
        const div = L.DomUtil.create('div', 'leaflet-control recenter-wrap')
        div.innerHTML = '<button class="recenter-btn" title="Re-centre on me" aria-label="Re-centre on me">' +
          '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#0b7285" stroke-width="2">' +
          '<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.6" fill="#0b7285" stroke="none"/>' +
          '<path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg></button>'
        div.style.display = 'none'
        L.DomEvent.disableClickPropagation(div)
        L.DomEvent.disableScrollPropagation(div)
        div.querySelector('.recenter-btn').addEventListener('click', () => {
          const map = mapRef.current
          if (map && J._lastPos) {
            J.followLock = true // Google-style: camera stays locked on the driver until they drag the map
            map.setBearing?.(0) // re-centre also brings north back up
            map.setView(J._lastPos, 17, { animate: true })
          }
        })
        journeyUiRef.current.recenter = div
        return div
      },
    })
    new RecenterControl({ position: 'bottomright' }).addTo(mapRef.current)

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

    // ---------- VOICE GUIDANCE (Web Speech API, English) ----------
    function speak(text) {
      try {
        if (!J.voiceOn || !('speechSynthesis' in window)) return
        window.speechSynthesis.cancel()
        const u = new SpeechSynthesisUtterance(text)
        u.lang = 'en-US'; u.rate = 1.02
        window.speechSynthesis.speak(u)
      } catch {}
    }
    J.speak = speak
    // Google-Maps behaviour: navigation starts from where the driver
    // actually IS. If that is well away from the searched route's start,
    // rebuild the route from the live position to the same destination.
    function startFromHere(lat, lon) {
      if (J.startRerouted || !J.route) return
      const startPt = J.route.geometry?.[0]
      if (!startPt) return
      const d = L.latLng(lat, lon).distanceTo(L.latLng(startPt[0], startPt[1]))
      if (d <= 500) { J.joined = d <= 400; return }
      J.startRerouted = true
      J.rerouting = true
      setBanner({ arrow: '📍', text: 'Starting from your current location', dist: '', tone: 'ok', then: 'Rebuilding the route from where you are…' })
      speak('Starting from your current location')
      rerouteRef.current?.(lat, lon)
    }
    J.startFromHere = startFromHere
    function spokenDist(mi) {
      if (mi < 0.1) return `${Math.max(30, Math.round(mi * 5280 / 10) * 10)} feet`
      return `${mi < 0.95 ? Math.round(mi * 20) / 20 : mi.toFixed(1)} miles`
    }

    function showJourneyUi() {
      const ui = journeyUiRef.current
      if (!ui) return
      if (ui.banner) ui.banner.root.style.display = 'block'
      if (ui.panel) ui.panel.style.display = 'block'
      if (ui.recenter) ui.recenter.style.display = 'block'
      if (ui.locate) ui.locate.style.display = 'none' // Re-centre replaces Locate mid-journey (two similar buttons confused taps)
      if (ui.btns) ui.btns.style.display = 'none'
    }
    function hideJourneyUi() {
      const ui = journeyUiRef.current
      if (!ui) return
      if (ui.banner) ui.banner.root.style.display = 'none'
      if (ui.panel) ui.panel.style.display = 'none'
      if (ui.recenter) ui.recenter.style.display = 'none'
      if (ui.locate) ui.locate.style.display = 'block'
      if (ui.btns) ui.btns.style.display = 'block'
    }
    J.showUi = showJourneyUi; J.hideUi = hideJourneyUi

    function setNav() {
      const ui = journeyUiRef.current
      if (!ui || !J.meta) return
      if (ui.fromInput && document.activeElement !== ui.fromInput) ui.fromInput.value = shortName(J.meta.from)
      if (ui.toInput && document.activeElement !== ui.toInput) ui.toInput.value = shortName(J.meta.to)
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
      ui.live.disabled = !has || J.mode === 'live'
      ui.live.textContent = J.mode === 'live' ? '📍 Live Journey running…' : '📍 Start Live Journey'
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
          progress: J.frac, completed: false,
          routeLabel: J.route?.label, miles: J.route?.distance_miles,
          from: J.meta?.from, to: J.meta?.to })
      }
      if (J.raf) cancelAnimationFrame(J.raf)
      if (J.watchId != null && navigator.geolocation) navigator.geolocation.clearWatch(J.watchId)
      if (J.liveDot) { J.liveDot.remove(); J.liveDot = null }
      Object.assign(J, { mode: null, playing: false, t: 0, raf: null, watchId: null, offCount: 0, rerouting: false, frac: 0, arrived: false })
      J.bannerHold = false
      hideJourneyUi()
      setButtons()
      journeyModeRef.current?.(false)
      bumpJourneyRef.current?.()
    }
    J.end = endJourney

    // ---------- LIVE JOURNEY: real GPS tracking + off-route rerouting ----------
    function startLive() {
      if (!J.route || J.mode === 'live') return
      if (!navigator.geolocation) {
        journeyUiRef.current.warn.textContent = 'GPS is not available in this browser.'
        showPanel()
        return
      }
      J.mode = 'live'; J.playing = true; J.offCount = 0; J.rerouting = false; J.coolUntil = 0; J.joined = false; J.followLock = true
      J.startChecked = false; J.startRerouted = false; J.zoomedIn = false
      if (J.lastPos) {
        const m = mapRef.current
        if (m) m.setView([J.lastPos.lat, J.lastPos.lon], Math.max(m.getZoom(), 17))
      }
      showPanel(); setButtons()
      const ui = journeyUiRef.current
      ui.stat.textContent = 'Waiting for GPS signal… allow location access if asked.'
      const nmStart = nextManeuver(J.route, 0)
      speak(`Starting navigation to ${shortName(J.meta?.to || 'your destination')}. Drive safe.${nmStart ? ' ' + stepText(nmStart.step) : ''}`)
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
      // Street-level camera like Google Maps: first fix of a journey zooms
      // in on the driver instead of leaving the whole-route overview.
      if (!J.zoomedIn && J.mode === 'live') {
        J.zoomedIn = true
        map.setView(ll, Math.max(map.getZoom(), 17))
      }
      // Movement estimate for voice gating: directions are spoken only
      // while the vehicle is actually moving (Victor's rule).
      const nowMs = Date.now()
      if (J._lastPos && J._lastFixAt) {
        const dM = J._lastPos.distanceTo(ll)
        const dtS = Math.max(0.2, (nowMs - J._lastFixAt) / 1000)
        J.moving = dM > 12 && (dM / dtS) > 0.8
      }
      if (pos.coords.speed != null && isFinite(pos.coords.speed)) J.moving = pos.coords.speed > 0.8
      J._lastFixAt = nowMs
      J._lastPos = ll
      cachePos(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy)
      followVehicle(J, map, ll)

      if (!J.startChecked && (pos.coords.accuracy ?? 9999) < 1000) {
        J.startChecked = true
        J.startFromHere?.(pos.coords.latitude, pos.coords.longitude)
        if (J.startRerouted) return // the rebuilt route is on its way
      }
      const near = nearestOnRoute(route, ll)
      const ui = journeyUiRef.current
      if (J.bannerHold && !J.rerouting) J.bannerHold = false  // first GPS fix: banner goes live
      // GPS jitter must never cry wolf: the off-route distance grows with the
      // fix's own accuracy, it takes 3 fixes in a row, and after one reroute
      // the detector cools down for 45s. The banner carries the message -
      // no map popup (it kept re-appearing and covering the road).
      const threshold = Math.max(400, (pos.coords.accuracy || 0) * 1.5)
      // JOINED grace: the typed origin never matches the real GPS spot
      // exactly (and desktop/Wi-Fi GPS can be hundreds of metres off), so a
      // driver who simply has not REACHED the route yet is not "leaving" it.
      // Until the first on-route fix, show calm English guidance - no
      // warnings, no strikes, no reroute.
      if (!J.joined && near.dist > threshold) {
        J.bannerHold = true
        ui.warn.textContent = 'Head to the highlighted route - warnings start once you join it.'
        ui.warn.className = 'jwarn'
        setBanner({ arrow: '➤', text: 'Head to the route', dist: fmtDist(near.dist / 1609.34), tone: '', then: 'Navigation starts when you reach the highlighted route.' })
        updatePanel(route, Math.min(1, Math.max(0, near.frac)))
        return
      }
      if (near.dist <= threshold) J.joined = true
      updatePanel(route, Math.min(1, Math.max(0, near.frac)))
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
          speak('You are off the route. Finding a new route.')
          rerouteRef.current?.(pos.coords.latitude, pos.coords.longitude)
        } else if (!J.rerouting && J.offCount >= 2) {
          ui.warn.textContent = '⚠ You seem to be leaving the route…'
          ui.warn.className = 'jwarn bad'
          setBanner({ arrow: '⚠', text: 'You seem to be leaving the route…', dist: '', tone: 'warn' })
        } else if (!J.rerouting) {
          J.bannerHold = false // a single stray fix says nothing at all
        }
      }
    }

    function updatePanel(route, t) {
      const ui = journeyUiRef.current
      if (!ui) return
      J.frac = t
      if (t >= 0.995 && !J.arrived && J.mode) {
        J.arrived = true
        speak('You have arrived at your destination')
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
      const nm = !J.rerouting ? nextManeuver(route, mileNow) : null
      if (!J.bannerHold && nm) {
        setBanner({
          arrow: stepArrow(nm.step), dist: fmtDist(nm.step.mile - mileNow),
          text: stepText(nm.step),
          then: nm.next ? `Then ${stepArrow(nm.next)} ${stepText(nm.next)}` : null,
        })
      }
      // Voice: announce each maneuver twice - once in good time (<=0.6 mi)
      // and once when close (<=0.15 mi). E.g. "In 0.5 miles, turn right
      // onto Main Road."
      if (nm && J.mode && J.moving) {
        const remaining = nm.step.mile - mileNow
        if (J.voiceStep !== nm.step.mile) { J.voiceStep = nm.step.mile; J.voiceStage = 0 }
        if (remaining <= 0.6 && remaining > 0.15 && J.voiceStage < 1) {
          J.voiceStage = 1
          speak(`In ${spokenDist(remaining)}, ${stepText(nm.step)}`)
        } else if (remaining <= 0.15 && remaining > 0.01 && J.voiceStage < 2) {
          J.voiceStage = 2
          speak(`In ${spokenDist(remaining)}, ${stepText(nm.step)}`)
        }
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
      const editedTrip = (editSignalRef?.current || 0) !== (J.lastEditSeen || 0)
      J.lastEditSeen = editSignalRef?.current || 0
      if (J.mode === 'live' && isNewResult && editedTrip && sel) {
        // Victor: pressing Update trip mid-journey must NOT leave the map -
        // the journey continues on the new trip (same GPS watch, new route).
        J.route = sel; J.offCount = 0; J.rerouting = false; J.arrived = false; J.frac = 0; J.joined = false
        J.bannerHold = true
        J.setBanner?.({ arrow: '↻', text: 'Trip updated', dist: '', tone: 'ok', then: 'Navigating to the new destination.' })
        setTimeout(() => { J.bannerHold = false }, 3000)
        J.speak?.(`New trip. Navigating to ${shortName(result.destination.name)}`)
      } else if (J.mode === 'live' && J.watchId != null && sameDestination) {
        // This result is a reroute (or a refresh of the same trip): keep tracking.
        const wasRerouting = J.rerouting
        J.route = sel
        J.joined = true // a rerouted route starts at the driver
        J.offCount = 0
        J.rerouting = false
        if (wasRerouting && journeyUiRef.current) {
          if (J.startRerouted) {
            const nm0 = nextManeuver(sel, 0)
            if (nm0) J.speak?.('Drive safe. ' + stepText(nm0.step))
            J.startRerouted = false
          }
          journeyUiRef.current.warn.textContent = '✅ New route ready — follow the highlighted route.'
          journeyUiRef.current.warn.className = 'jwarn'
          J.bannerHold = true
          J.setBanner?.({ arrow: '✅', text: 'New route ready', dist: '', tone: 'ok', then: 'Follow the highlighted route.' })
          J.speak?.('New route ready')
          setTimeout(() => { J.bannerHold = false }, 4000)
        }
      } else {
        // A genuinely new search (or mode not live): reset the journey.
        if (J.mode) J.end?.()
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
      if (isSel) {
        // White casing: the driven route lifts off the map so flyovers and
        // main roads read clearly against the side roads beneath them.
        L.polyline(r.geometry, { color: '#ffffff', weight: 11, opacity: 0.9, renderer: svgRenderer }).addTo(layers)
      }
      const line = L.polyline(r.geometry, {
        renderer: svgRenderer,
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
        renderer: svgRenderer,
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
    } else if (journeyActive && J._lastPos) {
      // Any redraw mid-journey (reroute, edit, route switch) keeps the camera
      // on the driver at street level - on phone AND desktop alike.
      map.setView(J._lastPos, Math.max(map.getZoom(), 16))
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
