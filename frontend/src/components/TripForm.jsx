import { useEffect, useRef, useState } from 'react'

// Turn GPS coordinates into a readable place name (Nominatim reverse geocoding,
// the same free service the backend uses). Falls back to the raw coordinates,
// which the backend geocoder also accepts.
async function reverseGeocode(lat, lon) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=12`)
    const d = await r.json()
    const a = d.address || {}
    const place = a.city || a.town || a.village || a.suburb || a.county || ''
    const name = [place, a.state].filter(Boolean).join(', ')
    return name || d.display_name?.split(',').slice(0, 2).join(',') || `${lat}, ${lon}`
  } catch {
    return `${lat}, ${lon}`
  }
}

// Built-in city list for the "nearby / popular places" quick suggestions shown
// under a place field before the user starts typing (instant, no network).
const CITIES = [
  { name: 'Hyderabad, Telangana', lat: 17.385, lon: 78.487 },
  { name: 'Secunderabad, Telangana', lat: 17.44, lon: 78.5 },
  { name: 'Warangal, Telangana', lat: 17.978, lon: 79.59 },
  { name: 'Vijayawada, Andhra Pradesh', lat: 16.506, lon: 80.648 },
  { name: 'Guntur, Andhra Pradesh', lat: 16.306, lon: 80.436 },
  { name: 'Visakhapatnam, Andhra Pradesh', lat: 17.687, lon: 83.279 },
  { name: 'Tirupati, Andhra Pradesh', lat: 13.629, lon: 79.419 },
  { name: 'Bengaluru, Karnataka', lat: 12.972, lon: 77.595 },
  { name: 'Mysuru, Karnataka', lat: 12.295, lon: 76.639 },
  { name: 'Chennai, Tamil Nadu', lat: 13.083, lon: 80.270 },
  { name: 'Coimbatore, Tamil Nadu', lat: 11.016, lon: 76.955 },
  { name: 'Pune, Maharashtra', lat: 18.520, lon: 73.857 },
  { name: 'Mumbai, Maharashtra', lat: 19.076, lon: 72.878 },
  { name: 'Nagpur, Maharashtra', lat: 21.150, lon: 79.088 },
  { name: 'Delhi, India', lat: 28.614, lon: 77.209 },
  { name: 'Kochi, Kerala', lat: 9.931, lon: 76.267 },
  { name: 'Dallas, TX', lat: 32.776, lon: -96.797 },
  { name: 'Fort Worth, TX', lat: 32.755, lon: -97.331 },
  { name: 'Houston, TX', lat: 29.760, lon: -95.370 },
  { name: 'Austin, TX', lat: 30.267, lon: -97.743 },
  { name: 'Oklahoma City, OK', lat: 35.468, lon: -97.516 },
  { name: 'Denver, CO', lat: 39.739, lon: -104.985 },
  { name: 'Atlanta, GA', lat: 33.749, lon: -84.388 },
  { name: 'Chicago, IL', lat: 41.878, lon: -87.630 },
]
function distMiles(aLat, aLon, bLat, bLon) {
  const R = 3958.8, rad = Math.PI / 180
  const dLat = (bLat - aLat) * rad, dLon = (bLon - aLon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}
const POPULAR = ['Hyderabad, Telangana', 'Bengaluru, Karnataka', 'Chennai, Tamil Nadu',
  'Vijayawada, Andhra Pradesh', 'Dallas, TX', 'Oklahoma City, OK', 'Denver, CO']

export default function TripForm({ form, setForm, onSubmit, loading, onQuickDepart }) {
  const set = (key) => (e) => { setForm({ ...form, [key]: e.target.value }); suggest(key, e.target.value) }
  const [gpsMsg, setGpsMsg] = useState('')

  // Place predictions (Google-Maps style): as the user types, Nominatim suggests
  // matching places; tapping one fills the field. Debounced, free, no API key.
  const [sug, setSug] = useState({ field: null, items: [] })
  const [focusField, setFocusField] = useState(null)
  const [myCoords, setMyCoords] = useState(null)
  const sugTimer = useRef(null)
  function suggest(field, q) {
    clearTimeout(sugTimer.current)
    if (!q || q.trim().length < 2) { setSug({ field: null, items: [] }); return }
    sugTimer.current = setTimeout(async () => {
      try {
        const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`)
        const items = await r.json()
        setSug({ field, items })
      } catch { setSug({ field: null, items: [] }) }
    }, 350)
  }
  function pick(field, item) {
    setForm((f) => ({ ...f, [field]: item.display_name.split(',').slice(0, 3).join(',') }))
    setSug({ field: null, items: [] })
  }
  // Quick departure choices: Now = this minute; Today/Tomorrow keep the typed
  // time but jump the date. The parent re-runs the search immediately if a
  // result is already on screen, so every function downstream just works.
  function quickDepart(which) {
    const pad = (n) => String(n).padStart(2, '0')
    const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
    let d
    if (which === 'now') {
      d = new Date()
    } else {
      d = form.departure ? new Date(form.departure) : new Date()
      const base = new Date()
      if (which === 'tomorrow') base.setDate(base.getDate() + 1)
      d.setFullYear(base.getFullYear(), base.getMonth(), base.getDate())
    }
    const local = fmt(d)
    if (onQuickDepart) onQuickDepart(local)
    else setForm((f) => ({ ...f, departure: local }))
  }
  const sugList = (field) => sug.field === field && sug.items.length > 0 && (
    <ul className="ac-list">
      {sug.items.map((it) => (
        <li key={it.place_id} onMouseDown={(e) => { e.preventDefault(); pick(field, it) }}>
          📍 {it.display_name.split(',').slice(0, 3).join(',')}
        </li>
      ))}
    </ul>
  )

  // Quick suggestions under a focused, still-empty field: places NEAR the user
  // when we know where they are, otherwise popular trucking cities. Tapping
  // one fills the field - nothing is ever filled without the user's tap.
  function pickQuick(field, name) {
    setForm((f) => ({ ...f, [field]: name }))
    setSug({ field: null, items: [] })
    setFocusField(null)
  }
  const quickList = (field) => {
    if (focusField !== field || sug.field === field) return null
    if ((form[field] || '').trim().length >= 2) return null
    let head, rows
    if (myCoords) {
      head = '📍 Nearby places'
      rows = CITIES
        .map((c) => ({ ...c, d: distMiles(myCoords.lat, myCoords.lon, c.lat, c.lon) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 5)
        .map((c) => ({ name: c.name, note: `${c.d < 1 ? '<1' : Math.round(c.d)} mi away` }))
    } else {
      head = '⭐ Popular places'
      rows = POPULAR.map((name) => ({ name, note: '' }))
    }
    return (
      <ul className="ac-list">
        <li className="ac-head">{head}</li>
        {rows.map((r) => (
          <li key={r.name} onMouseDown={(e) => { e.preventDefault(); pickQuick(field, r.name) }}>
            📍 {r.name}{r.note && <span className="ac-dist">{r.note}</span>}
          </li>
        ))}
      </ul>
    )
  }

  // If location permission was already granted earlier, learn the position
  // quietly so the quick list can show NEARBY places. This never fills a
  // field by itself - it only powers the suggestions Victor asked for.
  useEffect(() => {
    navigator.permissions?.query({ name: 'geolocation' })
      .then((st) => {
        if (st.state !== 'granted' || !navigator.geolocation) return
        navigator.geolocation.getCurrentPosition(
          (pos) => setMyCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
          () => {}, { timeout: 8000, maximumAge: 600000 })
      })
      .catch(() => {})
  }, [])

  // Ask the browser for the current GPS position and put it in the Origin box.
  function useMyLocation(auto = false) {
    if (!navigator.geolocation) {
      if (!auto) setGpsMsg('GPS is not available in this browser — type your starting place.')
      return
    }
    if (!auto) setGpsMsg('Detecting your location…')
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords
        setMyCoords({ lat: latitude, lon: longitude })
        const name = await reverseGeocode(latitude, longitude)
        setForm((f) => ({ ...f, origin: name }))
        setGpsMsg(`Current location set: ${name}`)
      },
      () => { if (!auto) setGpsMsg('Location permission denied — please type your starting place.') },
      { timeout: 10000, maximumAge: 300000 }
    )
  }

  return (
    <form className="panel form" onSubmit={onSubmit}>
      <h2>Trip Details</h2>
      <label>Origin (start place)</label>
      <div className="ac-wrap">
        <input value={form.origin} onChange={set('origin')} required autoComplete="off"
               onFocus={() => setFocusField('origin')} onBlur={() => setFocusField(null)}
               placeholder="Enter a place — suggestions will appear" />
        {sugList('origin')}
        {quickList('origin')}
      </div>
      <button type="button" className="gps-btn" onClick={() => useMyLocation(false)}>
        📍 Use my current location (GPS)
      </button>
      {gpsMsg && <div className="gps-msg">{gpsMsg}</div>}
      <label>Destination</label>
      <div className="ac-wrap">
        <input value={form.destination} onChange={set('destination')} required autoComplete="off"
               onFocus={() => setFocusField('destination')} onBlur={() => setFocusField(null)}
               placeholder="Enter a place — suggestions will appear" />
        {sugList('destination')}
        {quickList('destination')}
      </div>
      <label>Departure date &amp; time</label>
      <input type="datetime-local" value={form.departure} onChange={set('departure')} required />
      <div className="presets quickchips">
        <button type="button" onClick={() => quickDepart('now')}>⚡ Now</button>
        <button type="button" onClick={() => quickDepart('today')}>Today</button>
        <button type="button" onClick={() => quickDepart('tomorrow')}>Tomorrow</button>
      </div>
      <label>Load weight (lb)</label>
      <input type="number" min="0" max="150000" value={form.loadLb} onChange={set('loadLb')} required />
      <div className="presets">
        <button type="button" onClick={() => setForm({ ...form, loadLb: 0 })}>Empty</button>
        <button type="button" onClick={() => setForm({ ...form, loadLb: 20000 })}>Light 20k</button>
        <button type="button" onClick={() => setForm({ ...form, loadLb: 45000 })}>Heavy 45k</button>
      </div>
      <label>Check weather every</label>
      <select value={form.interval} onChange={set('interval')}>
        <option value="10">10 miles</option>
        <option value="25">25 miles</option>
        <option value="50">50 miles</option>
      </select>
      <button type="submit" disabled={loading}>
        {loading ? <><span className="spinner" /> Finding safest route…</> : 'Find Safest Route'}
      </button>
    </form>
  )
}
