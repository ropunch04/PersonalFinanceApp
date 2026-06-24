import { useEffect, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from "recharts";
import { api } from "../api";

function fmtCurrency(n) {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 0,
  }).format(n ?? 0);
}

function fmtLabel(dateStr) {
  try {
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return dateStr;
  }
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const spent  = payload.find((p) => p.dataKey === "spent")?.value ?? 0;
  const income = payload.find((p) => p.dataKey === "income")?.value ?? 0;
  return (
    <div style={{
      background: "#1A1D27", border: "1px solid #2E3250",
      borderRadius: 8, padding: "8px 12px", fontSize: 12,
    }}>
      <div style={{ color: "#94A3B8", marginBottom: 4 }}>{fmtLabel(label)}</div>
      <div style={{ color: "#EF4444" }}>Out: {fmtCurrency(spent)}</div>
      {income > 0 && <div style={{ color: "#22C55E" }}>In: {fmtCurrency(income)}</div>}
    </div>
  );
}

export default function SpendingTrendChart({ dateParams }) {
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); // eslint-disable-line react-hooks/set-state-in-effect
    setError(null);
    api.getTrend(dateParams)
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setError(e.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [dateParams]);

  if (loading && !data) {
    return (
      <div style={{
        height: 200, borderRadius: 12, background: "#22263A",
        animation: "pulse 1.5s ease-in-out infinite",
        marginBottom: 20,
      }} />
    );
  }

  if (error || !data?.length) {
    return (
      <div style={{ height: 200, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 20 }}>
        <span style={{ fontSize: 13, color: "#94A3B8" }}>Trend data unavailable</span>
      </div>
    );
  }

  const N = Math.max(1, Math.ceil(data.length / 6));
  const tickFormatter = (val, idx) => (idx % N === 0 ? fmtLabel(val) : "");

  return (
    <div style={{ marginBottom: 20 }}>
      <p className="section-label" style={{ marginBottom: 8 }}>SPENDING TREND</p>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -24 }}>
          <CartesianGrid stroke="#2E3250" strokeDasharray="0" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={tickFormatter}
            tick={{ fill: "#475569", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tick={{ fill: "#475569", fontSize: 10 }}
            tickFormatter={(v) => `$${Math.round(v / 1000) > 0 ? `${Math.round(v / 1000)}k` : v}`}
          />
          <Tooltip content={<CustomTooltip />} />
          <Line
            type="monotone"
            dataKey="spent"
            stroke="#EF4444"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
          <Line
            type="monotone"
            dataKey="income"
            stroke="#22C55E"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
