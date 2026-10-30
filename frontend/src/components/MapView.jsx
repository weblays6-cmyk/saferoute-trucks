import { useEffect, useRef } from 'react'
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

export default function MapView({ result, selectedRouteId, onSelectRoute, showHeat, heatHour, onReroute, onJourneyMode, onJourneyEvent }) {
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

  // Create the map once: base maps + switcher, GPS locate button, journey controls.
  useEffect(() => {
    if (mapRef.current) return
    const bases = makeBaseLayers()
    mapRef.current = L.map('saferoute-map', { layers: [bases.light], preferCanvas: true, fadeAnimation: false }).setView([34.1, -97.1], 6)
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
              const ll = [pos.coords.latitude, pos.coords.longitude]
              locateRef.current.clearLayers()
              L.circle(ll, { radius: pos.coords.accuracy || 100, color: '#3b82f6', weight: 1, fillColor: '#3b82f6', fillOpacity: 0.15 }).addTo(locateRef.current)
              L.circleMarker(ll, { radius: 8, color: '#ffffff', weight: 3, fillColor: '#3b82f6', fillOpacity: 1 })
                .addTo(locateRef.current).bindPopup('<b>📍 You are here</b><br>Your current GPS location')
              map.flyTo(ll, Math.max(map.getZoom(), 9))
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
          '</div>' +
          '<div class="jpanel" style="display:none">' +
          '  <div class="jnav"></div>' +
          '  <div class="jbar"><div class="jfill"></div></div>' +
          '  <div class="jstat"></div>' +
          '  <div class="jwarn"></div>' +
          '  <button class="jend">✕ End Journey</button>' +
          '</div>'
        L.DomEvent.disableClickPropagation(div)
        journeyUiRef.current = {
          live: div.querySelector('.live'), demo: div.querySelector('.demo'),
          panel: div.querySelector('.jpanel'), nav: div.querySelector('.jnav'),
          fill: div.querySelector('.jfill'), stat: div.querySelector('.jstat'),
          warn: div.querySelector('.jwarn'),
        }
        journeyUiRef.current.live.addEventListener('click', startLive)
        journeyUiRef.current.demo.addEventListener('click', toggleDemo)
        div.querySelector('.jend').addEventListener('click', () => endJourney())
        return div
      },
    })
    new JourneyControl({ position: 'bottomleft' }).addTo(mapRef.current)

    function setNav() {
      const ui = journeyUiRef.current
      if (ui && J.meta) {
        ui.nav.innerHTML =
          `<div class="jnav-row"><span class="dot from"></span><span>${J.meta.from}</span></div>` +
          `<div class="jnav-line"></div>` +
          `<div class="jnav-row"><span class="dot to"></span><span>${J.meta.to}</span></div>`
      }
    }

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
      journeyUiRef.current.panel.style.display = 'block'
      setNav()
      journeyModeRef.current?.(true)
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
      const ui = journeyUiRef.current
      if (ui) ui.panel.style.display = 'none'
      setButtons()
      journeyModeRef.current?.(false)
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
          journeyUiRef.current.stat.textContent = 'Arrived at destination — trip complete. 🎉'
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
      J.mode = 'live'; J.playing = true; J.offCount = 0; J.rerouting = false
      showPanel(); setButtons()
      const ui = journeyUiRef.current
      ui.stat.textContent = 'Waiting for GPS signal… allow location access if asked.'
      ui.warn.textContent = ''
      J.watchId = navigator.geolocation.watchPosition(
        (pos) => onLivePosition(pos),
        () => {
          ui.warn.textContent = 'GPS signal lost or permission denied — journey tracking paused.'
          ui.warn.className = 'jwarn bad'
        },
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }
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
      followVehicle(J, map, ll)

      const near = nearestOnRoute(route, ll)
      const ui = journeyUiRef.current
      updatePanel(route, Math.min(1, Math.max(0, near.frac)))
      if (near.dist <= OFF_ROUTE_METRES) {
        J.offCount = 0
        if (!J.rerouting) { ui.warn.textContent = 'On route ✓ — following the highlighted route.'; ui.warn.className = 'jwarn' }
      } else {
        J.offCount += 1
        if (J.offCount >= 2 && !J.rerouting) {
          // Off route twice in a row: notify the driver and reroute from here.
          J.rerouting = true
          ui.warn.textContent = '⚠ You are off the route! Finding a new route from your current location…'
          ui.warn.className = 'jwarn bad'
          L.popup().setLatLng(ll).setContent('<b>⚠ Off route</b><br>Recalculating a new route to your destination…').openOn(map)
          rerouteRef.current?.(pos.coords.latitude, pos.coords.longitude)
        } else if (!J.rerouting) {
          ui.warn.textContent = '⚠ You seem to be leaving the route…'
          ui.warn.className = 'jwarn bad'
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
        }
      } else {
        // A genuinely new search (or mode not live): reset the journey.
        if (J.mode) J.end?.()
        if (J.truck) { J.truck.remove(); J.truck = null }
        Object.assign(J, { playing: false, raf: null, t: 0, route: sel, mode: null })
        const ui = journeyUiRef.current
        if (ui) ui.panel.style.display = 'none'
      }
      J.meta = result ? {
        from: result.origin.name, to: result.destination.name,
        destLat: result.destination.lat, destLon: result.destination.lon,
      } : null
      if (!J.mode) J.route = sel
      J.setButtons?.()
      if (journeyUiRef.current?.panel.style.display === 'block') {
        const ui = journeyUiRef.current
        if (J.meta) ui.nav.innerHTML =
          `<div class="jnav-row"><span class="dot from"></span><span>${J.meta.from}</span></div>` +
          `<div class="jnav-line"></div>` +
          `<div class="jnav-row"><span class="dot to"></span><span>${J.meta.to}</span></div>`
      }
    }

    layers.clearLayers()
    if (!result) return

    const bounds = []
    result.routes.forEach((r) => {
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

    const pin = (loc, text) =>
      L.marker([loc.lat, loc.lon]).addTo(layers).bindPopup(`<b>${text}</b><br>${loc.name || ''}`)
    pin(result.origin, 'Origin')
    pin(result.destination, 'Destination')

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
  }, [result, selectedRouteId, onSelectRoute])

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
