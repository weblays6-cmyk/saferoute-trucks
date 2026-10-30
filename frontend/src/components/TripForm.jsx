export default function TripForm({ form, setForm, onSubmit, loading }) {
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })
  return (
    <form className="panel form" onSubmit={onSubmit}>
      <h2>Trip Details</h2>
      <label>Origin (start place)</label>
      <input value={form.origin} onChange={set('origin')} placeholder="Dallas, TX" required />
      <label>Destination</label>
      <input value={form.destination} onChange={set('destination')} placeholder="Oklahoma City, OK" required />
      <label>Departure date &amp; time</label>
      <input type="datetime-local" value={form.departure} onChange={set('departure')} required />
      <label>Load weight (lb)</label>
      <input type="number" min="0" max="150000" value={form.loadLb} onChange={set('loadLb')} required />
      <label>Check weather every</label>
      <select value={form.interval} onChange={set('interval')}>
        <option value="">Automatic (by trip length)</option>
        <option value="10">10 miles</option>
        <option value="25">25 miles</option>
        <option value="50">50 miles</option>
      </select>
      <button type="submit" disabled={loading}>
        {loading ? <><span className="spinner" /> Checking weather on all routes…</> : 'Find Safest Route'}
      </button>
      <p className="hint">Weather is checked at the time the truck is expected to reach each checkpoint (ETA), not at departure time.</p>
    </form>
  )
}
