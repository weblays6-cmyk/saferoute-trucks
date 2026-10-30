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

export default function TripForm({ form, setForm, onSubmit, loading, onQuickDepart }) {
  const set = (key) => (e) => { setForm({ ...form, [key]: e.target.value }); suggest(key, e.target.value) }
  const [gpsMsg, setGpsMsg] = useState('')

  // Place predictions (Google-Maps style): as the user types, Nominatim suggests
  // matching places; tapping one fills the field. Debounced, free, no API key.
  const [sug, setSug] = useState({ field: null, items: [] })
  const sugTimer = useRef(null)
  function suggest(field, q) {
    clearTimeout(sugTimer.current)
    if (!q || q.trim().length < 3) { setSug({ field: null, items: [] }); return }
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
               placeholder="Enter a place — suggestions will appear" />
        {sugList('origin')}
      </div>
      <button type="button" className="gps-btn" onClick={() => useMyLocation(false)}>
        📍 Use my current location (GPS)
      </button>
      {gpsMsg && <div className="gps-msg">{gpsMsg}</div>}
      <label>Destination</label>
      <div className="ac-wrap">
        <input value={form.destination} onChange={set('destination')} required autoComplete="off"
               placeholder="Enter a place — suggestions will appear" />
        {sugList('destination')}
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
