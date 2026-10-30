import { useCallback, useEffect, useRef, useState } from 'react'
import TripForm from './components/TripForm'
import MapView from './components/MapView'
import RouteCards from './components/RouteCards'
import CheckpointTable from './components/CheckpointTable'
import { analyzeTrip } from './api'
import './App.css'

// Default departure: tomorrow 08:00 local, in the format datetime-local expects.
function tomorrow8am() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(8, 0, 0, 0)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function shortPlace(name) {
  if (!name) return ''
  const parts = String(name).split(',')
  return parts.slice(0, 2).join(',').trim()
}

export default function App() {
  const [form, setForm] = useState({
    origin: 'Dallas, TX', destination: 'Oklahoma City, OK',
    departure: tomorrow8am(), loadLb: 35000, interval: '25',
  })
  const [result, setResult] = useState(null)
  const [selectedRouteId, setSelectedRouteId] = useState(null)
  const [showHeat, setShowHeat] = useState(true)
  const [heatHour, setHeatHour] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [journeyMode, setJourneyMode] = useState(false)
  const reroutingRef = useRef(false)

  // Travel Activity: searches, journeys and reroutes, saved on this device.
  const [history, setHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem('saferoute_history') || '[]') } catch { return [] }
  })
  useEffect(() => {
    try { localStorage.setItem('saferoute_history', JSON.stringify(history.slice(0, 30))) } catch {}
  }, [history])
  const addHistory = useCallback((entry) => {
    setHistory((h) => [{ ...entry, at: Date.now() }, ...h].slice(0, 30))
  }, [])

  const onSelectRoute = useCallback((id) => setSelectedRouteId(id), [])

  // After Find is pressed, bring the map to the top of the screen (phone + PC)
  const mapAnchorRef = useRef(null)
  const scrollToMap = () => requestAnimationFrame(() =>
    mapAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))

  async function runTrip(overrides = {}) {
    const f = { ...form, ...overrides }
    setForm(f)
    setLoading(true); setError('')
    scrollToMap()
    try {
      const data = await analyzeTrip({
        origin: f.origin, destination: f.destination,
        departureLocal: f.departure, loadLb: f.loadLb,
        intervalMiles: f.interval || null,
      })
      setResult(data)
      const rec = data.routes.find((r) => r.id === data.recommended_route_id)
      addHistory({ type: 'search', from: data.origin.name, to: data.destination.name,
                   routeLabel: rec?.label, miles: rec?.distance_miles })
      setSelectedRouteId(data.recommended_route_id)  // start by showing the winning route's checkpoints
      setHeatHour(0)
      scrollToMap()  // results are in - make sure the map is what the user sees
    } catch (err) {
      setError(err.message)
      setResult(null)
    } finally {
      setLoading(false)
    }
  }

  function onSubmit(e) { e.preventDefault(); runTrip() }

  // Departure quick chips (Now / Today / Tomorrow): set the time instantly —
  // and if a result is already showing, re-run with it right away.
  function quickDepart(local) {
    if (result) runTrip({ departure: local })
    else setForm((f) => ({ ...f, departure: local }))
  }

  // One-click example trips (evaluator-friendly): fill the form and run immediately.
  function demoTrip(origin, destination) {
    runTrip({ origin, destination })
    document.getElementById('planner')?.scrollIntoView({ behavior: 'smooth' })
  }

  // "What if I leave later?" — shift departure and re-run with the same trip.
  function shiftDeparture(hours) {
    const d = new Date(form.departure)
    d.setHours(d.getHours() + hours)
    const pad = (n) => String(n).padStart(2, '0')
    const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
    runTrip({ departure: local })
  }

  // Live-journey reroute: the driver went off route — re-plan from the GPS position
  // to the SAME destination (departure/load stay as planned). Guarded so GPS jitter
  // can never start overlapping requests.
  const onReroute = useCallback((lat, lon) => {
    if (reroutingRef.current) return
    reroutingRef.current = true
    addHistory({ type: 'reroute', from: `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
                 to: result?.destination.name })
    runTrip({ origin: `${lat.toFixed(5)}, ${lon.toFixed(5)}` })
      .finally(() => { reroutingRef.current = false })
  }, [form, result, addHistory])

  const selectedRoute = result?.routes.find((r) => r.id === selectedRouteId) || result?.routes[0]
  const heatTime = result ? new Date(new Date(result.departure).getTime() + heatHour * 3600_000) : null

  return (
    <div className={journeyMode ? 'app journey-on' : 'app'}>
      <div className="topbar">
        <span className="tb-live">● LIVE</span>
        <span>AI-powered driver safety — weather-aware routing built for Spotter fleets</span>
        <span className="tb-tags"><em>TMS</em><em>Sentinel Safety</em><em>Driver App</em><em>CRM</em></span>
      </div>
      <header>
        <div className="brand">
          <div className="logo">SR</div>
          <div>
            <h1>SafeRoute <span>Trucks</span></h1>
            <p>Weather-aware truck routing — the safest route by weather, load weight and travel time.</p>
          </div>
        </div>
        <div className="chips">
          <span>3 routes compared</span>
          <span>ETA-based weather</span>
          <span>Load-aware risk rules</span>
          <span>48-hour heatmap</span>
        </div>
      </header>

      <section className="hero">
        <div className="hero-text">
          <div className="hero-tag">WEATHER-AWARE ROUTING FOR TRUCK DRIVERS</div>
          <h2>Drive the <span>safest route</span>,<br />every single time.</h2>
          <p>SafeRoute Trucks compares 3 routes, checks the weather at every checkpoint for the
             exact time your truck will be there, applies load-weight safety rules, and tells
             you which route to take — and why.</p>
          <div className="hero-cta">
            <button className="cta-main" onClick={() => document.getElementById('planner')?.scrollIntoView({ behavior: 'smooth' })}>Plan a Trip ↓</button>
            <button className="cta-demo" onClick={() => demoTrip('Dallas, TX', 'Denver, CO')}>▶ Try a live example</button>
          </div>
          <div className="hero-points">
            <span>Built for Spotter's driver-safety mission</span>
            <span>Free live weather &amp; routing data</span>
          </div>
        </div>
        <div className="hero-card">
          <div className="hc-head">HOW A ROUTE WINS</div>
          <ol>
            <li><b>No Travel</b> routes go last</li>
            <li>Fewest <b>Severe</b> miles</li>
            <li>Fewest <b>High-risk</b> miles</li>
            <li>Lowest <b>average risk</b></li>
            <li>Shortest <b>travel time</b></li>
          </ol>
          <div className="hc-foot">Load rule example: wind 45–54 mph + load over 30,000 lb = <b>No Travel</b></div>
        </div>
      </section>

      {!result && !loading && (
        <div className="steps">
          <div><b>1</b><span><strong>Enter the trip</strong>Origin, destination, departure time &amp; load weight</span></div>
          <div><b>2</b><span><strong>We compare 3 routes</strong>Weather checked at every checkpoint, at the truck's ETA</span></div>
          <div><b>3</b><span><strong>Drive the safest</strong>Ranked by Severe miles, High miles, average risk &amp; time</span></div>
        </div>
      )}
      <div className="layout" id="planner">
        <div className="left">
          <TripForm form={form} setForm={setForm} onSubmit={onSubmit} loading={loading} onQuickDepart={quickDepart} />
          {result && (
            <div className="panel heat">
              <h2>Weather Heatmap</h2>
              <label className="switch">
                <input type="checkbox" checked={showHeat} onChange={(e) => setShowHeat(e.target.checked)} />
                Show heatmap along the routes
              </label>
              <label>Forecast time: departure + {heatHour} hr</label>
              <input type="range" min="0" max="48" value={heatHour}
                     onChange={(e) => setHeatHour(Number(e.target.value))} />
              <div className="hint">{heatTime && heatTime.toLocaleString()} — slide to see how risk along the corridor changes over the next 48 hours.</div>
              <div className="legend">
                <span><i style={{ background: '#22c55e' }} />Low</span>
                <span><i style={{ background: '#eab308' }} />Moderate</span>
                <span><i style={{ background: '#f97316' }} />High</span>
                <span><i style={{ background: '#ef4444' }} />Severe</span>
                <span><i style={{ background: '#991b1b' }} />No Travel</span>
              </div>
              <div className="heatscale">
                <div className="heatscale-bar" />
                <div className="heatscale-labels"><span>Safe</span><span>Risky</span><span>Dangerous</span></div>
                <div className="hint">Heat colour on the map: blue/green = safe weather, yellow/orange = risky, <b>red = dangerous</b>. Checkpoint dots use the same colours as the legend above.</div>
              </div>
            </div>
          )}
        </div>

        <div className="centre" ref={mapAnchorRef}>
          <MapView result={result} selectedRouteId={selectedRoute?.id}
                   onSelectRoute={onSelectRoute} showHeat={showHeat} heatHour={heatHour}
                   onReroute={onReroute} onJourneyMode={setJourneyMode}
                   onJourneyEvent={addHistory} />
          {error && <div className="error">{error}</div>}
          {result?.warnings?.length > 0 && (
            <div className="warnings">{result.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}</div>
          )}
          {result && (() => {
            const rec = result.routes.find((r) => r.id === result.recommended_route_id)
            return rec ? (
              <div className="banner">
                <div className="banner-badge">SAFEST ROUTE</div>
                <div>
                  <b>{rec.label}</b> — {rec.distance_miles} miles
                  <div className="banner-reason">{rec.summary.reason}</div>
                  <div className="banner-stats">
                    {result.routes.reduce((a, r) => a + r.checkpoints.length, 0)} checkpoints scored •
                    {' '}{result.heatmap?.points?.length || 0} heatmap points • weather at every ETA
                  </div>
                </div>
              </div>
            ) : null
          })()}
          {result && (
            <div className="shiftbar">
              <span>Leaving at a different time can change the safest route:</span>
              <button onClick={() => shiftDeparture(6)} disabled={loading}>Leave +6 hrs later</button>
              <button onClick={() => shiftDeparture(12)} disabled={loading}>Leave +12 hrs later</button>
            </div>
          )}
          <CheckpointTable route={selectedRoute} />
        </div>

        <aside className="rightcol">
          <div className="rightcol-head">Route Options <span>ranked — safest first</span></div>
          {loading && (
            <div className="cards col" aria-hidden="true">
              {[1,2,3].map((i) => <div key={i} className="card skeleton"><div className="skl w60" /><div className="skl w90" /><div className="skl w75" /><div className="skl bar" /></div>)}
            </div>
          )}
          {!result && !loading && (
            <div className="panel placeholder">
              <b>No routes yet</b>
              <p>Enter a trip on the left and press <b>Find Safest Route</b> — the 3 compared routes will appear here, safest first, next to the map.</p>
              <p>Or tap <b>▶ Try a live example</b> above to see it instantly.</p>
            </div>
          )}
          <RouteCards result={result} selectedRouteId={selectedRoute?.id} onSelectRoute={onSelectRoute} />
          <div className="panel history">
            <div className="hist-head">
              <h2>Travel Activity</h2>
              {history.length > 0 && <button className="hist-clear" onClick={() => setHistory([])}>Clear</button>}
            </div>
            {history.length === 0 && <p className="hist-empty">No activity yet — your trip searches, journeys and reroutes will appear here.</p>}
            <ul className="hist-list">
              {history.slice(0, 8).map((h, i) => (
                <li key={i}>
                  <span className={`hist-ic ${h.type}`}>
                    {h.type === 'search' ? '🔎' : h.type === 'reroute' ? '⚠' : h.completed ? '🏁' : '🚚'}
                  </span>
                  <span className="hist-text">
                    {h.type === 'search' && <>Trip planned: <b>{shortPlace(h.from)} → {shortPlace(h.to)}</b> — {h.routeLabel} recommended{h.miles ? `, ${h.miles} mi` : ''}</>}
                    {h.type === 'reroute' && <>Went off route — <b>rerouted</b> from current location to {shortPlace(h.to)}</>}
                    {h.type === 'journey' && <>{h.mode === 'live' ? 'Live journey' : 'Demo drive'} on <b>{h.routeLabel}</b> — {h.completed ? 'completed 🎉' : `ended at ${Math.round((h.progress || 0) * 100)}%`}{h.miles ? ` of ${h.miles} mi` : ''}</>}
                    <span className="hist-time">{new Date(h.at).toLocaleString()}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>

      <footer>Spotter Full Stack Assessment • Routes: OSRM • Weather: Open-Meteo • Geocoding: Nominatim • Maps: OpenStreetMap / Esri</footer>
    </div>
  )
}
