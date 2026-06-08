import { useEffect, useState } from "react";
import { api } from "../api";

function fmt(n) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n ?? 0);
}

function progressColor(ratio) {
  if (ratio >= 1) return "red";
  if (ratio >= 0.75) return "amber";
  return "green";
}

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getDashboard()
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="top-bar-loading" />;
  if (error) return (
    <div className="page">
      <div className="page-header"><h1>Dashboard</h1></div>
      <div className="msg msg-error">{error}</div>
    </div>
  );

  const spent = data?.total_spent ?? 0;
  const income = data?.monthly_income ?? 0;
  const net = income - spent;
  const cats = data?.categories ?? [];

  return (
    <div className="page">
      <div className="page-header"><h1>Dashboard</h1></div>

      <div className="stat-row">
        <div className="stat-tile">
          <span className="stat-value text-red">{fmt(spent)}</span>
          <span className="stat-label">Spent</span>
        </div>
        <div className="stat-tile">
          <span className="stat-value text-green">{fmt(income)}</span>
          <span className="stat-label">Income</span>
        </div>
        <div className="stat-tile">
          <span className={`stat-value ${net >= 0 ? "text-green" : "text-red"}`}>{fmt(net)}</span>
          <span className="stat-label">Net</span>
        </div>
      </div>

      {cats.length > 0 ? (
        <div className="card">
          <p className="section-label">Spending by Category</p>
          <div className="cat-list">
            {cats.map((c) => {
              const ratio = c.budget > 0 ? (c.spent ?? 0) / c.budget : 0;
              const color = c.budget > 0 ? progressColor(ratio) : "green";
              return (
                <div className="cat-row" key={c.id ?? c.name}>
                  <div className="cat-row-top">
                    <span className="cat-name">{c.name}</span>
                    <span className="cat-amounts">
                      {fmt(c.spent)}{c.budget > 0 ? ` / ${fmt(c.budget)}` : ""}
                    </span>
                  </div>
                  {c.budget > 0 && (
                    <div className="progress-track">
                      <div
                        className={`progress-fill ${color}`}
                        style={{ width: `${Math.min(ratio * 100, 100)}%` }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="2" y="5" width="20" height="14" rx="2" />
            <path d="M2 10h20" />
          </svg>
          No transactions this month
        </div>
      )}
    </div>
  );
}
