import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useOnline } from "../context/OnlineContext";
import { useDashboardFilters, RANGES } from "../hooks/useDashboardFilters";
import { usePwaSync } from "../hooks/usePwaSync";
import CategoryBreakdown from "../components/CategoryBreakdown";
import CategoryDonut from "../components/CategoryDonut";
import SpendingTrendChart from "../components/SpendingTrendChart";
import MerchantInsights from "../components/MerchantInsights";
import ComparisonCard from "../components/ComparisonCard";
import PinPickerModal from "../components/PinPickerModal";

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
    const dt = new Date(lastSyncedAt);
    if (isNaN(dt.getTime())) return null;
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
  const [selectedCategoryId, setSelectedCategoryId] = useState(null);
  const [showPinPicker, setShowPinPicker] = useState(false);
  const navigate = useNavigate();
  const { isOnline } = useOnline();
  const {
    range, setRange,
    customStart, setCustomStart,
    customEnd, setCustomEnd,
    pinnedIds, togglePin, clearPins,
    dateParams,
  } = useDashboardFilters();

  const allParams = pinnedIds.length
    ? { ...dateParams, include_ids: pinnedIds.join(",") }
    : dateParams;

  useEffect(() => {
    load(allParams);
  }, [dateParams, pinnedIds]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api.syncStatus().then(setSyncStatus).catch(() => {});
  }, []);

  usePwaSync({
    credentialsConfigured: syncStatus?.credentials_configured ?? false,
    lastSyncedAt: syncStatus?.last_synced_at ?? null,
    onSynced: async (result) => {
      const status = await api.syncStatus().catch(() => null);
      if (status) setSyncStatus(status);
      if (result?.new_transactions > 0 || result?.imported > 0) load(dateParams);
    },
  });

  async function load(params) {
    setLoading(true);
    try {
      const d = await api.getDashboard(params);
      setData(d);
      if (onQueueChange) onQueueChange(d.pending_count ?? 0);
    } catch {
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
      if (result?.new_transactions > 0 || result?.imported > 0) load(allParams);
    } catch {
    } finally {
      setRefreshing(false);
    }
  }

  if (loading && !data) return <div className="top-bar-loading" />;

  if (!data) return (
    <div className="page">
      <div className="page-header"><h1>Home</h1></div>
      <div className="msg msg-error">Unable to load data. Make sure the server is running.</div>
    </div>
  );

  const { pending_count, by_category } = data;
  const spent = data.total_spent ?? 0;
  const income = data.monthly_income ?? 0;
  const net = income - spent;

  return (
    <>
      {loading && <div className="top-bar-loading" />}
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

        <div className="range-pills">
          {RANGES.map((r) => (
            <button
              key={r.value}
              className={`range-pill${range === r.value ? " active" : ""}`}
              onClick={() => setRange(r.value)}
            >
              {r.label}
            </button>
          ))}
          <button
            className={`range-pill${pinnedIds.length > 0 ? " active" : ""}`}
            style={pinnedIds.length > 0 ? { background: "var(--primary)", borderColor: "var(--primary)" } : {}}
            onClick={() => setShowPinPicker(true)}
          >
            {pinnedIds.length > 0 ? `+${pinnedIds.length} pinned` : "Pin"}
          </button>
        </div>

        {range === "custom" && (
          <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
            <input
              type="date"
              value={customStart}
              onChange={(e) => setCustomStart(e.target.value)}
              style={{
                flex: 1, padding: "7px 10px", borderRadius: 8,
                border: "1px solid var(--border)", background: "var(--surface-raised)",
                color: "var(--text)", fontSize: 13,
              }}
            />
            <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>to</span>
            <input
              type="date"
              value={customEnd}
              onChange={(e) => setCustomEnd(e.target.value)}
              style={{
                flex: 1, padding: "7px 10px", borderRadius: 8,
                border: "1px solid var(--border)", background: "var(--surface-raised)",
                color: "var(--text)", fontSize: 13,
              }}
            />
          </div>
        )}

        <div className="summary-grid" style={{ marginBottom: 20 }}>
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

        <ComparisonCard dateParams={allParams} />

        <SpendingTrendChart dateParams={allParams} monthlyIncome={income} />

        <CategoryDonut
          categories={by_category}
          selectedId={selectedCategoryId}
          onSelect={setSelectedCategoryId}
        />
        <CategoryBreakdown
          categories={by_category}
          selectedId={selectedCategoryId}
        />

        <MerchantInsights dateParams={allParams} />
      </div>

      {showPinPicker && (
        <PinPickerModal
          pinnedIds={pinnedIds}
          togglePin={togglePin}
          clearPins={clearPins}
          dateParams={dateParams}
          onClose={() => setShowPinPicker(false)}
        />
      )}
    </>
  );
}
