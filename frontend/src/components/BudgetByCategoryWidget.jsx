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

export default function BudgetByCategoryWidget({ categories, flexPool, selectedId, dateParams }) {
  const budgeted = (categories ?? []).filter(
    (c) => ((c.budget ?? 0) > 0 || c.is_flex) && (c.period ?? "monthly") === "monthly"
  );
  const totalBudget = budgeted.reduce((sum, c) => sum + (c.budget ?? 0), 0);
  const totalSpent = budgeted.reduce((sum, c) => sum + (c.spent ?? 0), 0);
  const totalRemaining = totalBudget - totalSpent;
  const ratio = totalBudget > 0 ? totalSpent / totalBudget : 0;

  const poolRatio = flexPool && flexPool.budget > 0 ? flexPool.spent / flexPool.budget : 0;

  const hasFlex = !!(flexPool && flexPool.budget > 0);
  const flexSpent = hasFlex ? flexPool.spent : 0;
  const fixedSpent = Math.max(totalSpent - flexSpent, 0);
  const fixedBudget = totalBudget - (hasFlex ? flexPool.budget : 0);
  const fixedRatio = fixedBudget > 0 ? fixedSpent / fixedBudget : 0;

  const fixedPct = totalBudget > 0 ? Math.min(fixedSpent / totalBudget, 1) * 100 : 0;
  const flexPct = totalBudget > 0 ? Math.min(flexSpent / totalBudget, 1 - fixedPct / 100) * 100 : 0;

  return (
    <div>
      {totalBudget > 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <p className="section-label" style={{ marginBottom: 10 }}>Total Monthly Budget</p>

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

          <div style={{ display: "flex", width: "100%", height: 8, borderRadius: 4, background: "var(--surface-raised)", overflow: "hidden" }}>
            {hasFlex ? (
              <>
                <div
                  style={{
                    width: `${fixedPct}%`,
                    height: "100%",
                    background: barColor(fixedRatio),
                    transition: "width 300ms",
                  }}
                />
                <div
                  style={{
                    width: `${flexPct}%`,
                    height: "100%",
                    background: barColor(poolRatio),
                    opacity: 0.6,
                    transition: "width 300ms",
                  }}
                />
              </>
            ) : (
              <div
                style={{
                  width: `${Math.min(ratio * 100, 100)}%`,
                  height: "100%",
                  background: barColor(ratio),
                  transition: "width 300ms",
                }}
              />
            )}
          </div>

          {hasFlex && (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 11, color: "var(--text-muted)" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: barColor(fixedRatio), flexShrink: 0 }} />
                  Fixed · {fmt(fixedSpent)} / {fmt(fixedBudget)}
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: barColor(poolRatio), opacity: 0.6, flexShrink: 0 }} />
                  Flex · {fmt(flexPool.spent)} / {fmt(flexPool.budget)}
                </span>
              </div>
              <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8, marginBottom: 0 }}>
                Underspending in one flexible category covers overspending in another.
              </p>
            </>
          )}
        </div>
      )}

      <CategoryBreakdown categories={categories} flexPoolRatio={poolRatio} selectedId={selectedId} dateParams={dateParams} />
    </div>
  );
}
