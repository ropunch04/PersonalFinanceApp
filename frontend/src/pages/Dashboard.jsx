import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useOnline } from "../context/OnlineContext";

function fmt(n) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n ?? 0);
}

function formatSyncAge(lastSyncedAt) {
  if (!lastSyncedAt) return null;
  try {
    const dt = new Date(lastSyncedAt + (lastSyncedAt.endsWith("Z") ? "" : "Z"));
    const diffMs = Date.now() - dt.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHrs = Math.floor(diffMins / 60);
    if (diffHrs < 24) return `${diffHrs}h ago`;
    return `${Math.floor(diffHrs / 24)}d ago`;
  } catch {
    return null;
  }
}

function SyncPill({ syncStatus, refreshing, onRefresh }) {
  const syncAge = formatSyncAge(syncStatus?.last_synced_at);
  const navigate = useNavigate();
  const { isOnline } = useOnline();

  if (!syncStatus) return null;

  return (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      background: "var(--bg)", borderRadius: 20, padding: "3px 10px",
      fontSize: 11, color: "var(--text-secondary)", marginTop: 4,
      border: "1px solid var(--border)",
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
        background: syncAge ? "var(--green)" : "var(--border)",
      }} />
      <span>
        {syncAge
          ? `Synced ${syncAge}`
          : syncStatus.credentials_configured
            ? "Never synced"
            : <span
                style={{ color: "var(--primary)", cursor: "pointer" }}
                onClick={() => navigate("/profile")}
              >Connect Gmail</span>
        }
      </span>
      {syncStatus.credentials_configured && isOnline && (
        <button
          onClick={onRefresh}
          disabled={refreshing}
          title="Sync now"
          style={{
            background: "none", border: "none", color: "var(--primary)",
            cursor: "pointer", padding: "2px", fontSize: 13,
            minWidth: "unset", minHeight: "unset", lineHeight: 1,
          }}
        >
          {refreshing ? "⟳" : "↻"}
        </button>
      )}
    </div>
  );
}

export default function Dashboard({ onQueueChange }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncStatus, setSyncStatus] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const navigate = useNavigate();
  const { isOnline } = useOnline();

  useEffect(() => {
    load();
    api.syncStatus().then(setSyncStatus).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    setLoading(true);
    try {
      const d = await api.getDashboard();
      setData(d);
      if (onQueueChange) onQueueChange(d.pending_count ?? 0);
    } catch {
      // keep stale data if offline
    } finally {
      setLoading(false);
    }
  }

  async function handleRefreshSync() {
    if (!isOnline) return;
    setRefreshing(true);
    try {
      const result = await api.syncNow();
      const status = await api.syncStatus();
      setSyncStatus(status);
      if (result?.new_transactions > 0 || result?.imported > 0) load();
    } catch {
      // swallow
    } finally {
      setRefreshing(false);
    }
  }

  if (loading) return <div className="top-bar-loading" />;

  if (!data) return (
    <div className="page">
      <div className="page-header"><h1>Home</h1></div>
      <div className="msg msg-error">Unable to load data. Make sure the server is running.</div>
    </div>
  );

  const { pending_count, summary } = data;
  const spent = data.total_spent ?? 0;
  const income = summary?.monthly_income ?? 0;
  const net = income - spent;

  return (
    <>
      {!isOnline && <div className="offline-banner">📴 Offline — showing cached data</div>}

      <div className="page">
        <div className="page-header">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1>Home</h1>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
              {new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" })}
            </div>
            <SyncPill
              syncStatus={syncStatus}
              refreshing={refreshing}
              onRefresh={handleRefreshSync}
            />
          </div>

          {(pending_count ?? 0) > 0 && (
            <button
              className="btn btn-sm"
              style={{
                background: "var(--red)", color: "#fff", border: "none",
                fontWeight: 700, flexShrink: 0,
              }}
              onClick={() => navigate("/transactions?status=pending")}
            >
              {pending_count} to review
            </button>
          )}
        </div>

        {/* Money summary */}
        <div className="summary-grid" style={{ marginBottom: 24 }}>
          <div className="stat-tile">
            <span className="stat-value text-red">{fmt(spent)}</span>
            <span className="stat-label">Money Out</span>
          </div>
          {income > 0 && (
            <div className="stat-tile">
              <span className="stat-value text-green">{fmt(income)}</span>
              <span className="stat-label">Money In</span>
            </div>
          )}
          {income > 0 && (
            <div className="stat-tile">
              <span className={`stat-value ${net >= 0 ? "text-green" : "text-red"}`}>
                {net >= 0 ? "+" : ""}{fmt(net)}
              </span>
              <span className="stat-label">Net</span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
