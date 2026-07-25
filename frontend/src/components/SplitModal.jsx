import { useState } from "react";
import { api } from "../api";
import { fmtCurrency } from "../format";

function blankPart(merchant) {
  return { merchant_raw: merchant, amount: "", category_id: "", notes: "" };
}

export default function SplitModal({ txn, categories, onClose, onSplit }) {
  const [parts, setParts] = useState([blankPart(txn.merchant_raw ?? ""), blankPart(txn.merchant_raw ?? "")]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const total = parts.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
  const remaining = txn.amount - total;
  const balanced = Math.abs(remaining) < 0.01;

  function updatePart(i, field, value) {
    setParts((prev) => prev.map((p, idx) => (idx === i ? { ...p, [field]: value } : p)));
  }

  function addPart() {
    setParts((prev) => [...prev, blankPart(txn.merchant_raw ?? "")]);
  }

  function removePart(i) {
    setParts((prev) => (prev.length > 2 ? prev.filter((_, idx) => idx !== i) : prev));
  }

  function fillRemaining(i) {
    const others = parts.reduce((sum, p, idx) => (idx === i ? sum : sum + (parseFloat(p.amount) || 0)), 0);
    const value = Math.max(0, txn.amount - others);
    updatePart(i, "amount", value.toFixed(2));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!balanced) return;
    setSaving(true);
    setError(null);
    try {
      await api.splitTransaction(txn.id, parts.map((p) => ({
        amount: parseFloat(p.amount),
        merchant_raw: p.merchant_raw.trim() || undefined,
        category_id: p.category_id ? parseInt(p.category_id) : null,
        notes: p.notes.trim() || undefined,
      })));
      onSplit();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxHeight: "85dvh", display: "flex", flexDirection: "column" }}>
        <div className="modal-header">
          <h2>Split “{txn.merchant_raw || "Transaction"}”</h2>
          <button className="modal-close" onClick={onClose} type="button">×</button>
        </div>

        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 12 }}>
          Break this {fmtCurrency(txn.amount, 2)} {txn.direction === "inflow" ? "deposit" : "charge"} into
          separate transactions — useful when one line item actually covers a few different things.
        </p>

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
          <div style={{ overflowY: "auto", flex: 1, marginBottom: 12 }}>
            {parts.map((p, i) => (
              <div key={i} className="card" style={{ marginBottom: 10, padding: 12 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", flexShrink: 0 }}>
                    Part {i + 1}
                  </span>
                  {parts.length > 2 && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ marginLeft: "auto", padding: "0 8px" }}
                      onClick={() => removePart(i)}
                    >
                      Remove
                    </button>
                  )}
                </div>
                <div className="form-stack">
                  <div className="field">
                    <label className="field-label">Merchant / label</label>
                    <input
                      type="text"
                      value={p.merchant_raw}
                      onChange={(e) => updatePart(i, "merchant_raw", e.target.value)}
                    />
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Amount</label>
                      <div style={{ display: "flex", gap: 6 }}>
                        <input
                          type="number"
                          inputMode="decimal"
                          min="0"
                          step="0.01"
                          placeholder="0.00"
                          value={p.amount}
                          onChange={(e) => updatePart(i, "amount", e.target.value)}
                          style={{ flex: 1, minWidth: 0 }}
                        />
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => fillRemaining(i)}
                          title="Fill with remaining amount"
                        >
                          Fill
                        </button>
                      </div>
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Category</label>
                      <select
                        value={p.category_id}
                        onChange={(e) => updatePart(i, "category_id", e.target.value)}
                      >
                        <option value="">Auto-classify</option>
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="field">
                    <label className="field-label">Notes (optional)</label>
                    <input
                      type="text"
                      value={p.notes}
                      onChange={(e) => updatePart(i, "notes", e.target.value)}
                    />
                  </div>
                </div>
              </div>
            ))}

            <button type="button" className="btn btn-ghost btn-sm" onClick={addPart} style={{ width: "100%", justifyContent: "center" }}>
              + Add another part
            </button>
          </div>

          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "10px 12px", borderRadius: 8, background: "var(--surface-raised)", marginBottom: 12,
          }}>
            <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              Original: {fmtCurrency(txn.amount, 2)}
            </span>
            <span style={{
              fontSize: 13, fontWeight: 600,
              color: balanced ? "var(--green)" : "var(--red)",
            }}>
              {balanced ? "Balanced ✓" : `${remaining > 0 ? "Remaining" : "Over by"} ${fmtCurrency(Math.abs(remaining), 2)}`}
            </span>
          </div>

          {error && <div className="msg msg-error" style={{ marginBottom: 12 }}>{error}</div>}

          <button className="btn btn-primary" type="submit" disabled={saving || !balanced}>
            {saving ? "Splitting…" : `Split into ${parts.length} transactions`}
          </button>
        </form>
      </div>
    </div>
  );
}
