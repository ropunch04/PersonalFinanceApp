import CategoryBreakdown from "./CategoryBreakdown";

function fmt(n) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n ?? 0);
}

function barColor(ratio) {
  if (ratio >= 1) return "#EF4444";
  if (ratio >= 0.75) return "#F59E0B";
  return "#22C55E";
}

export default function BudgetByCategoryWidget({ categories, selectedId, dateParams }) {
  const budgeted = (categories ?? []).filter((c) => (c.budget ?? 0) > 0);
  const totalBudget = budgeted.reduce((sum, c) => sum + (c.budget ?? 0), 0);
  const totalSpent = budgeted.reduce((sum, c) => sum + (c.spent ?? 0), 0);
  const totalRemaining = totalBudget - totalSpent;
  const ratio = totalBudget > 0 ? totalSpent / totalBudget : 0;

  return (
    <div>
      {totalBudget > 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <p className="section-label" style={{ marginBottom: 10 }}>Total Budget</p>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
            <span style={{ fontSize: 22, fontWeight: 700, color: "var(--text)" }}>
              {fmt(totalSpent)}
              <span style={{ fontSize: 14, fontWeight: 500, color: "var(--text-secondary)" }}>
                {" "}/ {fmt(totalBudget)}
              </span>
            </span>
            <span
              className={totalRemaining >= 0 ? "text-green" : "text-red"}
              style={{ fontSize: 13, fontWeight: 600 }}
            >
              {totalRemaining >= 0
                ? `${fmt(totalRemaining)} left`
                : `${fmt(Math.abs(totalRemaining))} over`}
            </span>
          </div>

          <div style={{ width: "100%", height: 6, borderRadius: 3, background: "var(--surface-raised)", overflow: "hidden" }}>
            <div
              style={{
                width: `${Math.min(ratio * 100, 100)}%`,
                height: "100%",
                borderRadius: 3,
                background: barColor(ratio),
                transition: "width 300ms",
              }}
            />
          </div>
        </div>
      )}
      <CategoryBreakdown categories={categories} selectedId={selectedId} dateParams={dateParams} />
    </div>
  );
}
