import { useEffect, useRef, useState } from "react";
import { api } from "../api";

function fmtDate(s) {
  if (!s) return "";
  return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function ReimbursePickerModal({ inflowTxn, onClose, onLinked }) {
  const [query, setQuery]     = useState("");
  const [outflows, setOutflows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [linking, setLinking] = useState(null);
  const debounceRef = useRef(null);

  function search(q) {
    setLoading(true);
    api.getLinkableOutflows({ q, limit: 20 })
      .then(setOutflows)
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { search(""); }, []);

  function handleQueryChange(e) {
    const val = e.target.value;
    setQuery(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(val), 150);
  }

  async function handleLink(outflow) {
    setLinking(outflow.id);
    try {
      const updated = await api.linkReimbursement(inflowTxn.id, outflow.id);
      onLinked(updated);
      onClose();
    } catch (e) {
      alert(e.message);
      setLinking(null);
    }
  }

  async function handleUnlink() {
    setLinking("unlink");
    try {
      const updated = await api.unlinkReimbursement(inflowTxn.id);
      onLinked(updated);
      onClose();
    } catch (e) {
      alert(e.message);
      setLinking(null);
    }
  }

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxHeight: "80dvh", display: "flex", flexDirection: "column" }}>
        <div className="modal-header">
          <h2>Link to Expense</h2>
          <button className="modal-close" onClick={onClose} type="button">×</button>
        </div>

        {inflowTxn.reimburses_id && (
          <div style={{
            marginBottom: 12, padding: "10px 12px",
            background: "var(--surface-raised)", borderRadius: 8,
            display: "flex", justifyContent: "space-between", alignItems: "center",
          }}>
            <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              Linked to: <strong>{inflowTxn.reimburses_merchant || "expense"}</strong>
            </span>
            <button
              className="btn btn-sm"
              style={{ color: "var(--red)", borderColor: "var(--red)", background: "transparent" }}
              onClick={handleUnlink}
              disabled={!!linking}
            >
              {linking === "unlink" ? "Unlinking…" : "Unlink"}
            </button>
          </div>
        )}

        <input
          type="search"
          placeholder="Search expenses…"
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
            <div className="empty-state" style={{ padding: "32px 0" }}>No expenses found</div>
          )}
          {outflows.map((o) => (
            <div key={o.id} style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "10px 0", borderBottom: "1px solid var(--border)",
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {o.merchant_raw || "Untitled"}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
                  {fmtDate(o.transaction_at)}{o.category_name ? ` · ${o.category_name}` : ""}
                </div>
              </div>
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--red)", flexShrink: 0 }}>
                -${parseFloat(o.amount).toFixed(2)}
              </span>
              <button
                className="btn btn-sm"
                disabled={!!linking}
                onClick={() => handleLink(o)}
                style={{ flexShrink: 0 }}
              >
                {linking === o.id ? "Linking…" : "Link"}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
