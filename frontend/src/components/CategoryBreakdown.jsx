import { useState } from "react";
import { useNavigate } from "react-router-dom";

function fmt(n) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n ?? 0);
}

function barColor(ratio) {
  if (ratio >= 1)    return "#EF4444";
  if (ratio >= 0.75) return "#F59E0B";
  return "#22C55E";
}

export default function CategoryBreakdown({ categories, selectedId, dateParams }) {
  const [showEmpty, setShowEmpty] = useState(false);
  const navigate = useNavigate();

  if (!categories || categories.length === 0) return null;

  const shown      = categories.filter((c) => !c.folded_into_misc);
  const filtered   = selectedId ? shown.filter((c) => c.category_id === selectedId) : shown;
  const withSpend  = filtered.filter((c) => c.spent > 0);
  const zeroSpend  = selectedId ? [] : shown.filter((c) => c.spent <= 0);
  const visible    = showEmpty ? filtered : withSpend;

  return (
    <div className="card" style={{ padding: 0, marginBottom: 20 }}>
      <p className="section-label" style={{ padding: "14px 16px 10px", margin: 0 }}>
        SPENDING BY CATEGORY
      </p>

      {visible.map((cat) => {
        const budget = cat.budget ?? 0;
        const spent  = cat.spent  ?? 0;
        const ratio  = budget > 0 ? spent / budget : 0;
        const fill   = budget > 0 ? barColor(ratio) : "#94A3B8";
        const width  = budget > 0 ? `${Math.min(ratio * 100, 100)}%` : "0%";
        const overBudget = budget > 0 && spent >= budget;

        return (
          <div
            key={cat.category_id}
            style={{
              padding: "12px 16px",
              borderTop: "1px solid var(--border)",
              cursor: cat.category_id ? "pointer" : "default",
            }}
            onClick={() => {
              if (!cat.category_id) return;
              const p = new URLSearchParams({ category_id: cat.category_id });
              if (cat.period === "yearly" && dateParams?.end_date) {
                const year = new Date(dateParams.end_date + "T00:00:00").getFullYear();
                p.set("date_from", `${year}-01-01`);
                p.set("date_to",   `${year}-12-31`);
              } else {
                if (dateParams?.start_date) p.set("date_from", dateParams.start_date);
                if (dateParams?.end_date)   p.set("date_to",   dateParams.end_date);
              }
              navigate(`/transactions?${p.toString()}`);
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
              <span style={{ fontSize: 14, fontWeight: 500, color: "#F1F5F9" }}>
                {cat.category_name}
                {cat.is_misc && (
                  <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: "var(--primary)" }}>
                    MISC
                  </span>
                )}
              </span>
              <span style={{
                fontSize: 14, fontWeight: 600,
                color: overBudget ? "#EF4444" : "#F1F5F9",
              }}>
                {fmt(spent)}
              </span>
            </div>

            <div style={{
              width: "100%", height: 6, borderRadius: 3,
              background: "#22263A", marginBottom: 4, overflow: "hidden",
            }}>
              <div style={{ width, height: "100%", borderRadius: 3, background: fill, transition: "width 300ms" }} />
            </div>

            <div style={{ fontSize: 12, color: "#94A3B8" }}>
              {budget > 0
                ? `${fmt(spent)} / ${fmt(budget)} ${cat.period === "yearly" ? "yr" : "mo"}`
                : fmt(spent)}
              {cat.period === "yearly" && budget > 0 && (
                <span style={{ marginLeft: 6, fontSize: 11, color: "#475569" }}>Jan–Dec</span>
              )}
              {cat.overflow_to_misc > 0 && (
                <span style={{ marginLeft: 6, fontSize: 11, color: "#475569" }}>
                  ({fmt(cat.overflow_to_misc)} covered by Misc)
                </span>
              )}
            </div>
          </div>
        );
      })}

      {zeroSpend.length > 0 && (
        <button
          onClick={(e) => { e.stopPropagation(); setShowEmpty((v) => !v); }}
          style={{
            width: "100%", padding: "10px 16px",
            borderTop: "1px solid var(--border)",
            background: "none", border: "none",
            fontSize: 12, color: "#94A3B8",
            cursor: "pointer", textAlign: "left",
          }}
        >
          {showEmpty ? "Hide empty categories" : `Show ${zeroSpend.length} empty categor${zeroSpend.length === 1 ? "y" : "ies"}`}
        </button>
      )}
    </div>
  );
}
