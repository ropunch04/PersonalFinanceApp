import { useEffect, useState } from "react";
import { api } from "../api";

function fmt(n) {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 0,
  }).format(n ?? 0);
}

function periodLabel(dateParams) {
  if (!dateParams?.start_date) return "—";
  try {
    const d = new Date(dateParams.start_date + "T00:00:00");
    return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  } catch { return "—"; }
}

function prevPeriodLabel(dateParams) {
  if (!dateParams?.start_date) return "—";
  try {
    const d = new Date(dateParams.start_date + "T00:00:00");
    d.setMonth(d.getMonth() - 1);
    return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  } catch { return "—"; }
}

function DeltaBadge({ pct, invertColor }) {
  if (pct == null) return null;
  const isUp = pct > 0;
  const isGood = invertColor ? isUp : !isUp;
  const color = isGood ? "#22C55E" : "#EF4444";
  const arrow = isUp ? "↑" : "↓";
  const abs = Math.abs(pct);
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 2,
      background: "#22263A", borderRadius: 6,
      fontSize: 11, fontWeight: 600, color,
      padding: "2px 6px", marginLeft: 6,
    }}>
      {arrow} {abs}%
    </span>
  );
}

function CompRow({ label, current, previous, deltaPct, invertColor, noPrev }) {
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "80px 1fr 1fr",
      alignItems: "center", gap: 8,
      padding: "10px 0",
      borderBottom: "1px solid var(--border)",
    }}>
      <span style={{ fontSize: 12, color: "#475569", fontWeight: 500 }}>{label}</span>
      <div style={{ fontSize: 14, fontWeight: 600, color: "#F1F5F9" }}>
        {fmt(current)}
        <DeltaBadge pct={deltaPct} invertColor={invertColor} />
      </div>
      <div style={{ fontSize: 14, color: noPrev ? "#475569" : "#94A3B8" }}>
        {noPrev ? "—" : fmt(previous)}
      </div>
    </div>
  );
}

export default function ComparisonCard({ dateParams }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); // eslint-disable-line react-hooks/set-state-in-effect
    api.getComparison(dateParams)
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [dateParams]);

  if (loading && !data) {
    return (
      <div style={{
        height: 140, borderRadius: 12, background: "#22263A",
        animation: "pulse 1.5s ease-in-out infinite", marginBottom: 20,
      }} />
    );
  }

  if (!data) return null;

  const { current, previous, deltas, biggest_change_category, velocity } = data;
  const noPrev = !previous;
  const curLabel  = periodLabel(dateParams);
  const prevLabel = prevPeriodLabel(dateParams);

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{
        display: "grid", gridTemplateColumns: "80px 1fr 1fr",
        gap: 8, marginBottom: 4,
      }}>
        <span />
        <span style={{ fontSize: 11, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          {curLabel}
        </span>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          {prevLabel}
        </span>
      </div>

      <CompRow
        label="Spent"
        current={current?.spent}
        previous={previous?.spent}
        deltaPct={deltas?.spent_delta_pct}
        invertColor={false}
        noPrev={noPrev}
      />
      <CompRow
        label="Income"
        current={current?.income}
        previous={previous?.income}
        deltaPct={deltas?.income_delta_pct}
        invertColor={true}
        noPrev={noPrev}
      />
      <CompRow
        label="Net"
        current={current?.net}
        previous={previous?.net}
        deltaPct={deltas?.net_delta_pct}
        invertColor={true}
        noPrev={noPrev}
      />

      {biggest_change_category && (
        <div style={{ paddingTop: 12, fontSize: 14, color: "#94A3B8" }}>
          <span style={{ fontWeight: 700, color: "#F1F5F9" }}>Biggest Change — </span>
          <span style={{ color: biggest_change_category.direction === "up" ? "#EF4444" : "#22C55E" }}>
            {biggest_change_category.direction === "up" ? "↑" : "↓"}
            {" "}{biggest_change_category.category_name} {Math.abs(biggest_change_category.delta_pct)}% vs last period
          </span>
        </div>
      )}

      {noPrev && (
        <div style={{ paddingTop: 10, fontSize: 12, color: "#475569" }}>
          No data for previous period
        </div>
      )}

      {velocity && (
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
          <div style={{ fontSize: 13, color: "#94A3B8", marginBottom: 8 }}>
            On pace to spend{" "}
            <span style={{ fontWeight: 700, color: "#F1F5F9" }}>
              {fmt(velocity.projected_spend)}
            </span>
            {" "}this month
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ flex: 1, height: 4, borderRadius: 2, background: "#22263A", overflow: "hidden" }}>
              <div style={{
                width: `${Math.min((velocity.days_elapsed / velocity.days_in_month) * 100, 100)}%`,
                height: "100%", borderRadius: 2, background: "#6C63FF",
              }} />
            </div>
            <span style={{ fontSize: 11, color: "#475569", flexShrink: 0 }}>
              {velocity.days_elapsed}d / {velocity.days_in_month}d
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
