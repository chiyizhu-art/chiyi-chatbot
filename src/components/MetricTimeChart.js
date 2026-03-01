import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

function CustomTooltip({ active, payload, label, metric }) {
  if (!active || !payload?.length) return null;
  const v = payload[0]?.value;
  return (
    <div
      style={{
        background: 'rgba(15, 15, 35, 0.92)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 10,
        padding: '0.65rem 0.9rem',
        fontSize: '0.82rem',
        fontFamily: 'Inter, sans-serif',
        color: '#e2e8f0',
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
      }}
    >
      <p style={{ margin: '0 0 0.4rem', fontWeight: 700, color: '#fff' }}>{label}</p>
      <p style={{ margin: 0, opacity: 0.9 }}>
        {metric}: <strong>{typeof v === 'number' ? v.toLocaleString() : v}</strong>
      </p>
    </div>
  );
}

export default function MetricTimeChart({ data, metric, height = 260 }) {
  if (!data?.length) return null;
  return (
    <div className="metric-chart-wrap">
      <p className="metric-chart-label">{metric} vs release_date</p>
      <div className="metric-chart-canvas">
        <ResponsiveContainer width="100%" height={height}>
          <LineChart data={data} margin={{ top: 12, right: 16, left: 0, bottom: 32 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.07)" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fill: 'rgba(255,255,255,0.6)', fontSize: 10, fontFamily: 'Inter,sans-serif' }}
              axisLine={{ stroke: 'rgba(255,255,255,0.12)' }}
              tickLine={false}
              angle={-25}
              textAnchor="end"
              interval="preserveStartEnd"
              height={55}
            />
            <YAxis
              tick={{ fill: 'rgba(255,255,255,0.5)', fontSize: 10, fontFamily: 'Inter,sans-serif' }}
              axisLine={false}
              tickLine={false}
              width={55}
            />
            <Tooltip content={<CustomTooltip metric={metric} />} cursor={{ stroke: 'rgba(255,255,255,0.12)' }} />
            <Line
              type="monotone"
              dataKey="value"
              stroke="rgba(255, 215, 0, 0.85)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

