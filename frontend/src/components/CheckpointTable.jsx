import { RISK_COLORS, RISK_LABELS } from './MapView'

export default function CheckpointTable({ route }) {
  if (!route) return null
  return (
    <div className="panel tablewrap">
      <h2>{route.label} — Checkpoints (every {route.checkpoints[1] ? Math.round(route.checkpoints[1].mile - route.checkpoints[0].mile) : '—'} miles)</h2>
      <table>
        <thead><tr><th>Mile</th><th>ETA</th><th>Wind</th><th>Rain</th><th>Snow</th><th>Risk</th><th>Main cause</th></tr></thead>
        <tbody>
          {route.checkpoints.map((c, i) => (
            <tr key={i} className={c.risk === 'LOW' || c.risk === 'MODERATE' ? '' : 'risky-' + c.risk.toLowerCase()}>
              <td>{c.mile}</td>
              <td>{new Date(c.eta).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
              <td>{c.wind_mph} mph</td>
              <td>{c.rain_in_hr} in/hr</td>
              <td>{c.snow_in_hr} in/hr</td>
              <td><span className="riskbadge" style={{ background: RISK_COLORS[c.risk] }}>{RISK_LABELS[c.risk]}</span>
                  {c.load_rule_applied && <span className="loadnote"> load rule</span>}</td>
              <td>{c.driver ? c.driver : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
