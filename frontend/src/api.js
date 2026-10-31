import axios from 'axios'

// Backend URL: local dev = Django on :8000. For deployment set VITE_API_URL in Vercel.
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000'

export async function analyzeTrip({ origin, destination, departureLocal, loadLb, intervalMiles }) {
  const payload = {
    origin,
    destination,
    // Serializer expects a timezone-aware ISO string; toISOString() gives UTC.
    departure: new Date(departureLocal).toISOString(),
    load_lb: Number(loadLb),
  }
  // interval is optional in the API — only send it when the user picked one.
  if (intervalMiles) payload.interval_miles = Number(intervalMiles)

  try {
    const { data } = await axios.post(`${API_BASE}/api/analyze/`, payload)
    return data
  } catch (err) {
    // Backend returns {"error": "..."} for bad input (400) / service failure (502),
    // or field errors from serializer validation. Turn both into one readable message.
    const d = err.response?.data
    if (d?.error) throw new Error(d.error)
    if (d && typeof d === 'object') {
      const first = Object.values(d).flat()[0]
      if (first) throw new Error(String(first))
    }
    throw new Error('Could not reach the server. Is the backend running?')
  }
}

// ---- Live location sharing -------------------------------------------------
export async function shareStart(from, to) {
  const { data } = await axios.post(`${API_BASE}/api/share/start/`, { from, to })
  return data.id
}
export async function sharePing(id, lat, lon, etaMin) {
  try { await axios.post(`${API_BASE}/api/share/${id}/ping/`, { lat, lon, eta_min: etaMin }) } catch {}
}
export async function shareStop(id) {
  try { await axios.post(`${API_BASE}/api/share/${id}/stop/`, {}) } catch {}
}
export { API_BASE }
