import { Fragment, useEffect, useRef, useState } from 'react'

// Turn GPS coordinates into a readable place name (Nominatim reverse geocoding,
// the same free service the backend uses). Falls back to the raw coordinates,
// which the backend geocoder also accepts.
async function reverseGeocode(lat, lon) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18`)
    const d = await r.json()
    const a = d.address || {}
    // Show the EXACT locality the user stands in (Surya Nagar, IDPL Colony -
    // the OSM "neighbourhood"), not the administrative ward: Nominatim puts
    // names like "Ward 131 Quthbullapur" in suburb, which confused users.
    // Order: neighbourhood -> non-Ward suburb -> city -> state.
    const area = a.neighbourhood || a.residential || a.quarter || a.hamlet || a.village || ''
    const suburb = a.suburb && !/^ward\b/i.test(a.suburb) ? a.suburb : ''
    const city = a.city || a.town || a.county || ''
    const parts = [...new Set([area, suburb, city, a.state].filter(Boolean))].slice(0, 3)
    const nm = parts.join(', ') || d.display_name?.split(',').slice(0, 3).join(',')
    if (nm) return nm
    throw new Error('no name')
  } catch {
    // Nominatim busy - BigDataCloud's free client reverse API as second try.
    try {
      const r2 = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`)
      const d2 = await r2.json()
      const parts2 = [...new Set([d2.locality, d2.city, d2.principalSubdivision].filter(Boolean))].slice(0, 3)
      if (parts2.length) return parts2.join(', ')
    } catch {}
    return 'Current location'
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

// Well-known places people actually navigate to (temples, landmarks, tourist
// spots). Shown in the suggestion dropdown and matched while typing.
const FAMOUS = [
  { name: 'Charminar, Hyderabad', lat: 17.3616, lon: 78.4747 },
  { name: 'Golconda Fort, Hyderabad', lat: 17.3833, lon: 78.4011 },
  { name: 'Hussain Sagar, Hyderabad', lat: 17.4239, lon: 78.4738 },
  { name: 'Ramoji Film City, Hyderabad', lat: 17.2543, lon: 78.6808 },
  { name: 'Kanaka Durga Temple, Vijayawada', lat: 16.5152, lon: 80.6050 },
  { name: 'Tirupati Balaji Temple, Tirupati', lat: 13.6288, lon: 79.4192 },
  { name: 'Marina Beach, Chennai', lat: 13.0500, lon: 80.2824 },
  { name: 'Lalbagh Botanical Garden, Bengaluru', lat: 12.9507, lon: 77.5848 },
  { name: 'Vidhana Soudha, Bengaluru', lat: 12.9796, lon: 77.5907 },
  { name: 'Mysore Palace, Mysuru', lat: 12.3052, lon: 76.6552 },
  { name: 'Gateway of India, Mumbai', lat: 18.9220, lon: 72.8347 },
  { name: 'India Gate, Delhi', lat: 28.6129, lon: 77.2295 },
  { name: 'Times Square, New York', lat: 40.7580, lon: -73.9855 },
  { name: 'Golden Gate Bridge, San Francisco', lat: 37.8199, lon: -122.4783 },
  { name: 'Space Needle, Seattle', lat: 47.6205, lon: -122.3493 },
  { name: 'Grand Canyon South Rim, AZ', lat: 36.0619, lon: -112.1077 },
]

export default function TripForm({ form, setForm, onSubmit, loading, onQuickDepart, coordsRef }) {
  const set = (key) => (e) => {
    // Typing over a GPS-set field breaks the name<->coords pairing.
    if ((key === 'origin' || key === 'destination') && coordsRef?.current) delete coordsRef.current[key]
    setForm({ ...form, [key]: e.target.value }); suggest(key, e.target.value)
  }
  const [gpsMsg, setGpsMsg] = useState('')

  // Place predictions (Google-Maps style): as the user types, Nominatim suggests
  // matching places; tapping one fills the field. Debounced, free, no API key.
  const [sug, setSug] = useState({ field: null, items: [], local: [] })
  const [focusField, setFocusField] = useState(null)
  const [myCoords, setMyCoords] = useState(null)
  const sugTimer = useRef(null)
  function suggest(field, q) {
    clearTimeout(sugTimer.current)
    if (!q || q.trim().length < 2) { setSug({ field: null, items: [], local: [] }); return }
    // Instant matches from the built-in city + famous-places lists.
    const ql = q.trim().toLowerCase()
    const local = [...CITIES, ...FAMOUS]
      .filter((c) => c.name.toLowerCase().includes(ql))
      .slice(0, 3).map((c) => c.name)
    setSug({ field, items: [], local })
    sugTimer.current = setTimeout(async () => {
      try {
        // Bias the search to the user's surroundings (viewbox) so "Guntur"
        // finds Guntur, Andhra Pradesh - not a same-named village overseas -
        // then order the results nearest-first when we know the position.
        let url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&q=${encodeURIComponent(q)}`
        if (myCoords) {
          const { lat, lon } = myCoords
          url += `&viewbox=${lon - 2.5},${lat + 2.5},${lon + 2.5},${lat - 2.5}&bounded=0`
        }
        const r = await fetch(url)
        let items = await r.json()
        if (myCoords) {
          items = items
            .map((it) => ({ it, d: distMiles(myCoords.lat, myCoords.lon, parseFloat(it.lat), parseFloat(it.lon)) }))
            .sort((a, b) => a.d - b.d)
            .map((x) => x.it)
        }
        setSug({ field, items: items.slice(0, 5), local })
      } catch { setSug({ field, items: [], local }) } // keep local matches if the network search fails
    }, 350)
  }
  function pick(field, item) {
    if (coordsRef?.current) delete coordsRef.current[field]
    setForm((f) => ({ ...f, [field]: item.display_name.split(',').slice(0, 3).join(',') }))
    setSug({ field: null, items: [], local: [] })
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
  const sugList = (field) => sug.field === field && (sug.items.length > 0 || sug.local.length > 0) && (
    <ul className="ac-list">
      {sug.local.map((name) => (
        <li key={'L' + name} onMouseDown={(e) => { e.preventDefault(); pickQuick(field, name) }}>
          ⭐ {name}
        </li>
      ))}
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
    if (coordsRef?.current) delete coordsRef.current[field]
    setForm((f) => ({ ...f, [field]: name }))
    setSug({ field: null, items: [], local: [] })
    setFocusField(null)
  }
  const quickList = (field) => {
    if (focusField !== field || sug.field === field) return null
    if ((form[field] || '').trim().length >= 2) return null
    const sections = []
    // Recent searches first - places this user actually travelled to before.
    try {
      const hist = JSON.parse(localStorage.getItem('saferoute_history') || '[]')
      const seen = new Set()
      const recent = []
      for (const h of hist) {
        for (const nm of [h.to, h.from]) {
          const short = (nm || '').split(',').slice(0, 2).join(',')
          if (short && !seen.has(short) && short !== form[field]) { seen.add(short); recent.push(short) }
        }
        if (recent.length >= 4) break
      }
      if (recent.length) sections.push({ head: '🕘 Recent searches', icon: '🕘', rows: recent.map((name) => ({ name, note: '' })) })
    } catch {}
    // Nearby (or popular) places.
    if (myCoords) {
      const rows = CITIES
        .map((c) => ({ ...c, d: distMiles(myCoords.lat, myCoords.lon, c.lat, c.lon) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 5)
        .map((c) => ({ name: c.name, note: `${c.d < 1 ? '<1' : Math.round(c.d)} mi away` }))
      sections.push({ head: '📍 Nearby places', icon: '📍', rows })
    } else {
      sections.push({ head: '⭐ Popular places', icon: '📍', rows: POPULAR.map((name) => ({ name, note: '' })) })
    }
    // Famous / tourist places, nearest first when we know the position.
    const famous = myCoords
      ? FAMOUS.map((c) => ({ ...c, d: distMiles(myCoords.lat, myCoords.lon, c.lat, c.lon) }))
          .sort((a, b) => a.d - b.d)
          .map((c) => ({ name: c.name, note: `${Math.round(c.d)} mi away` }))
      : FAMOUS.slice(0, 5).map((c) => ({ name: c.name, note: '' }))
    sections.push({ head: '⭐ Famous places', icon: '⭐', rows: famous.slice(0, 5) })
    return (
      <ul className="ac-list">
        {sections.map((sec) => (
          <Fragment key={sec.head}>
            <li className="ac-head">{sec.head}</li>
            {sec.rows.map((r) => (
              <li key={sec.head + r.name} onMouseDown={(e) => { e.preventDefault(); pickQuick(field, r.name) }}>
                {sec.icon} {r.name}{r.note && <span className="ac-dist">{r.note}</span>}
              </li>
            ))}
          </Fragment>
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
        // The field shows the NAME; the exact GPS pair travels separately
        // so the backend routes from the true spot, not a re-geocoded name.
        if (coordsRef) coordsRef.current.origin = { coords: `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`, name }
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
      <div className="swaprow">
        <button type="button" className="swap-btn" title="Swap start and destination"
          onClick={() => {
            if (coordsRef) { const c = coordsRef.current.origin; coordsRef.current.origin = coordsRef.current.destination; coordsRef.current.destination = c }
            setForm({ ...form, origin: form.destination, destination: form.origin })
          }}>
          ⇅ Swap
        </button>
      </div>
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
