import { RISK_COLORS, RISK_LABELS } from './MapView'

const fmtTime = (min) => `${Math.floor(min / 60)}h ${Math.round(min % 60)}m`

export default function RouteCards({ result, selectedRouteId, onSelectRoute }) {
  if (!result) return null
  const ranked = [...result.routes].sort((a, b) => a.summary.rank - b.summary.rank)
  return (
    <div className="cards">
      {ranked.map((r) => {
        const s = r.summary
        const total = Object.values(s.risk_miles || {}).reduce((a, b) => a + b, 0) || 1
        return (
          <div key={r.id}
               className={'card' + (s.recommended ? ' rec' : '') + (r.id === selectedRouteId ? ' sel' : '')}
               onClick={() => onSelectRoute(r.id)}>
            <h3>{r.label} {s.recommended && <span className="badge">RECOMMENDED</span>}</h3>
            <div className="meta">{r.distance_miles} miles • {fmtTime(r.duration_min)} • Arrives {new Date(s.arrival).toLocaleString()}</div>
            {s.blocked && <div className="blocked">Has No Travel conditions — avoid if possible</div>}
            <div className="nums">
              <span>Severe: <b>{s.severe_miles} mi</b></span>
              <span>High: <b>{s.high_miles} mi</b></span>
              <span>Avg risk: <b>{s.avg_risk}</b></span>
            </div>
            {/* Risk-miles bar: share of the trip spent at each risk level */}
            <div className="bar">
              {Object.entries(s.risk_miles || {}).filter(([, v]) => v > 0).map(([k, v]) => (
                <div key={k} title={`${RISK_LABELS[k]}: ${v} mi`}
                     style={{ width: `${(v / total) * 100}%`, background: RISK_COLORS[k] }} />
              ))}
            </div>
            <div className="legendline">
              {Object.entries(s.risk_miles || {}).filter(([, v]) => v > 0).map(([k, v]) => (
                <span key={k}><i style={{ background: RISK_COLORS[k] }} />{RISK_LABELS[k]} {v} mi</span>
              ))}
            </div>
            {s.recommended && s.reason && <p className="reason">Why: {s.reason}</p>}
          </div>
        )
      })}
    </div>
  )
}
