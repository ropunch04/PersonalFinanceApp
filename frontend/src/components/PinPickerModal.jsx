import { useEffect, useRef, useState } from "react";
import { api } from "../api";

function fmtAmt(t) {
  const sign = t.direction === "inflow" ? "+" : "-";
  return `${sign}$${parseFloat(t.amount).toFixed(2)}`;
}

function fmtDate(s) {
  if (!s) return "";
  return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function isInRange(txn, dateParams) {
  if (!dateParams?.start_date || !dateParams?.end_date) return false;
  const d = (txn.transaction_at || "").slice(0, 10);
  return d >= dateParams.start_date && d <= dateParams.end_date;
}

export default function PinPickerModal({ pinnedIds, togglePin, clearPins, dateParams, onClose }) {
  const [query, setQuery]     = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const debounceRef = useRef(null);

  function search(q) {
    setLoading(true);
    api.getTransactions({ limit: 30, q, offset: 0 })
      .then((d) => setResults(d.transactions ?? []))
      .catch(() => setResults([]))
      .finally(() => setLoading(false));
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { search(""); }, []);

  function handleQueryChange(e) {
    const val = e.target.value;
    setQuery(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(val), 200);
  }

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxHeight: "80dvh", display: "flex", flexDirection: "column" }}>
        <div className="modal-header">
          <h2>Pin Transactions</h2>
          <button className="modal-close" onClick={onClose} type="button">×</button>
        </div>

        {pinnedIds.length > 0 && (
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            marginBottom: 10, padding: "8px 12px",
            background: "var(--surface-raised)", borderRadius: 8, fontSize: 13,
          }}>
            <span style={{ color: "var(--text-secondary)" }}>
              {pinnedIds.length} pinned outside range
            </span>
            <button
              className="btn btn-sm"
              style={{ color: "var(--red)", borderColor: "var(--red)", background: "transparent" }}
              onClick={clearPins}
            >
              Clear all
            </button>
          </div>
        )}

        <input
          type="search"
          placeholder="Search transactions…"
          value={query}
          onChange={handleQueryChange}
          style={{
            marginBottom: 12, padding: "9px 12px", borderRadius: 8,
            border: "1px solid var(--border)", background: "var(--surface-raised)",
            color: "var(--text)", fontSize: 14, width: "100%", boxSizing: "border-box",
          }}
          autoFocus
        />

        <div style={{ overflowY: "auto", flex: 1 }}>
          {loading && <div className="top-bar-loading" />}
          {!loading && results.length === 0 && (
            <div className="empty-state" style={{ padding: "32px 0" }}>No transactions found</div>
          )}
          {results.map((t) => {
            const inRange = isInRange(t, dateParams);
            const pinned  = pinnedIds.includes(t.id);
            return (
              <div key={t.id} style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "10px 0", borderBottom: "1px solid var(--border)",
                opacity: inRange ? 0.45 : 1,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {t.merchant_raw || "Untitled"}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
                    {fmtDate(t.transaction_at)}
                    {t.category_name ? ` · ${t.category_name}` : ""}
                    {inRange && " · already in range"}
                  </div>
                </div>
                <span style={{
                  fontSize: 14, fontWeight: 600, flexShrink: 0,
                  color: t.direction === "inflow" ? "var(--green)" : "var(--red)",
                }}>
                  {fmtAmt(t)}
                </span>
                <button
                  className="btn btn-sm"
                  disabled={inRange}
                  onClick={() => togglePin(t.id)}
                  style={{
                    flexShrink: 0,
                    ...(pinned ? { background: "var(--primary)", color: "#fff", border: "none" } : {}),
                  }}
                >
                  {pinned ? "Pinned" : "Pin"}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
