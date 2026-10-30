import { useCallback, useState } from 'react'
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

  const onSelectRoute = useCallback((id) => setSelectedRouteId(id), [])

  async function onSubmit(e) {
    e.preventDefault()
    setLoading(true); setError('')
    try {
      const data = await analyzeTrip({
        origin: form.origin, destination: form.destination,
        departureLocal: form.departure, loadLb: form.loadLb,
        intervalMiles: form.interval || null,
      })
      setResult(data)
      setSelectedRouteId(data.recommended_route_id)  // start by showing the winning route's checkpoints
      setHeatHour(0)
    } catch (err) {
      setError(err.message)
      setResult(null)
    } finally {
      setLoading(false)
    }
  }

  const selectedRoute = result?.routes.find((r) => r.id === selectedRouteId) || result?.routes[0]
  const heatTime = result ? new Date(new Date(result.departure).getTime() + heatHour * 3600_000) : null

  return (
    <div className="app">
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

      {!result && !loading && (
        <div className="steps">
          <div><b>1</b><span><strong>Enter the trip</strong>Origin, destination, departure time &amp; load weight</span></div>
          <div><b>2</b><span><strong>We compare 3 routes</strong>Weather checked at every checkpoint, at the truck's ETA</span></div>
          <div><b>3</b><span><strong>Drive the safest</strong>Ranked by Severe miles, High miles, average risk &amp; time</span></div>
        </div>
      )}
      <div className="layout">
        <div className="left">
          <TripForm form={form} setForm={setForm} onSubmit={onSubmit} loading={loading} />
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
                <span><i style={{ background: '#7f1d1d' }} />No Travel</span>
              </div>
            </div>
          )}
        </div>
        <MapView result={result} selectedRouteId={selectedRoute?.id}
                 onSelectRoute={onSelectRoute} showHeat={showHeat} heatHour={heatHour} />
      </div>

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
      {loading && (
        <div className="cards" aria-hidden="true">
          {[1,2,3].map((i) => <div key={i} className="card skeleton"><div className="skl w60" /><div className="skl w90" /><div className="skl w75" /><div className="skl bar" /></div>)}
        </div>
      )}
      <RouteCards result={result} selectedRouteId={selectedRoute?.id} onSelectRoute={onSelectRoute} />
      <CheckpointTable route={selectedRoute} />
      <footer>Spotter Full Stack Assessment • Routes: OSRM • Weather: Open-Meteo • Geocoding: Nominatim • Map: OpenStreetMap</footer>
    </div>
  )
}
