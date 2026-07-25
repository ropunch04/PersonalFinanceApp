import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { fmtCurrency } from "../format";

function fmtDate(s) {
  if (!s) return "";
  return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function ReimbursePickerModal({ inflowTxn, onClose, onLinked }) {
  const [query, setQuery] = useState("");
  const [outflows, setOutflows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [amounts, setAmounts] = useState({});
  const [applying, setApplying] = useState(null);
  const [existingLinks, setExistingLinks] = useState([]);
  const [remaining, setRemaining] = useState(inflowTxn.amount);
  const [unlinking, setUnlinking] = useState(null);
  const debounceRef = useRef(null);

  function loadLinks() {
    api.getTransactionLinks(inflowTxn.id)
      .then((data) => {
        setExistingLinks(data.as_inflow);
        setRemaining(data.inflow_remaining);
      })
      .catch(() => {});
  }

  function search(q) {
    setLoading(true);
    api.getLinkableOutflows({ q, limit: 20 })
      .then(setOutflows)
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    search("");
    loadLinks();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleQueryChange(e) {
    const val = e.target.value;
    setQuery(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(val), 150);
  }

  function suggestedAmount(o) {
    const stillOwed = o.expected_reimbursement != null
      ? Math.max(o.expected_reimbursement - (o.received_total || 0), 0)
      : Math.max(o.amount - (o.received_total || 0), 0);
    return Math.max(0, Math.min(stillOwed, remaining)).toFixed(2);
  }

  async function handleApply(o) {
    const raw = amounts[o.id] ?? suggestedAmount(o);
    const amount = parseFloat(raw);
    if (isNaN(amount) || amount <= 0) {
      alert("Enter a valid amount to apply");
      return;
    }
    setApplying(o.id);
    try {
      await api.createReimbursementLink(inflowTxn.id, o.id, amount);
      loadLinks();
      search(query);
      onLinked?.();
    } catch (e) {
      alert(e.message);
    } finally {
      setApplying(null);
    }
  }

  async function handleUnlink(linkId) {
    setUnlinking(linkId);
    try {
      await api.deleteReimbursementLink(linkId);
      loadLinks();
      search(query);
      onLinked?.();
    } catch (e) {
      alert(e.message);
    } finally {
      setUnlinking(null);
    }
  }

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxHeight: "80dvh", display: "flex", flexDirection: "column" }}>
        <div className="modal-header">
          <h2>Apply This Payment</h2>
          <button className="modal-close" onClick={onClose} type="button">×</button>
        </div>

        <div style={{
          marginBottom: 12, padding: "10px 12px",
          background: "var(--surface-raised)", borderRadius: 8, fontSize: 13, color: "var(--text-secondary)",
        }}>
          {fmtCurrency(inflowTxn.amount, 2)} payment —{" "}
          <strong style={{ color: remaining > 0.005 ? "var(--primary)" : "var(--green)" }}>
            {remaining > 0.005 ? `${fmtCurrency(remaining, 2)} left to apply` : "fully applied"}
          </strong>
        </div>

        {existingLinks.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            {existingLinks.map((l) => (
              <div key={l.link_id} style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "8px 0", borderBottom: "1px solid var(--border)",
              }}>
                <div style={{
                  flex: 1, minWidth: 0, fontSize: 13, color: "var(--text)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {l.outflow_merchant || "expense"}
                </div>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--green)", flexShrink: 0 }}>
                  {fmtCurrency(l.amount, 2)}
                </span>
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={unlinking === l.link_id}
                  onClick={() => handleUnlink(l.link_id)}
                  style={{ flexShrink: 0, padding: "0 8px" }}
                >
                  {unlinking === l.link_id ? "…" : "Unlink"}
                </button>
              </div>
            ))}
          </div>
        )}

        <input
          type="search"
          placeholder="Search charges to apply this payment to…"
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
          {!loading && outflows.length === 0 && (
            <div className="empty-state" style={{ padding: "32px 0" }}>No charges found</div>
          )}
          {outflows.map((o) => {
            const stillOwed = o.expected_reimbursement != null
              ? Math.max(o.expected_reimbursement - (o.received_total || 0), 0)
              : null;
            return (
              <div key={o.id} style={{
                display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
                padding: "10px 0", borderBottom: "1px solid var(--border)",
              }}>
                <div style={{ flex: 1, minWidth: 120 }}>
                  <div style={{
                    fontSize: 14, fontWeight: 500, color: "var(--text)",
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  }}>
                    {o.merchant_raw || "Untitled"}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
                    {fmtDate(o.transaction_at)}{o.category_name ? ` · ${o.category_name}` : ""}
                    {stillOwed != null && ` · owed ${fmtCurrency(stillOwed, 2)}`}
                  </div>
                </div>
                <span style={{ fontSize: 13, color: "var(--text-muted)", flexShrink: 0 }}>
                  -{fmtCurrency(o.amount, 2)}
                </span>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  value={amounts[o.id] ?? suggestedAmount(o)}
                  onChange={(e) => setAmounts((prev) => ({ ...prev, [o.id]: e.target.value }))}
                  style={{
                    width: 76, padding: "6px 8px", borderRadius: 6,
                    border: "1px solid var(--border)", background: "var(--surface-raised)",
                    color: "var(--text)", fontSize: 13, flexShrink: 0,
                  }}
                />
                <button
                  className="btn btn-sm"
                  disabled={applying === o.id || remaining <= 0.005}
                  onClick={() => handleApply(o)}
                  style={{ flexShrink: 0 }}
                >
                  {applying === o.id ? "Applying…" : "Apply"}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
