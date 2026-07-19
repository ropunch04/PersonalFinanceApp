import { useState } from "react";

export default function CategoryEditModal({ category, onClose, onSave, onSetMisc, onRemove }) {
  const isMisc = !!category.is_misc;

  const [period, setPeriod] = useState(category.period ?? "monthly");
  const [foldIntoMisc, setFoldIntoMisc] = useState(!!category.fold_into_misc);
  const [saving, setSaving] = useState(false);
  const [settingMisc, setSettingMisc] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await onSave({ period, fold_into_misc: foldIntoMisc });
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleMisc() {
    setSettingMisc(true);
    setError(null);
    try {
      await onSetMisc(!isMisc);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSettingMisc(false);
    }
  }

  async function handleRemove() {
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    setRemoving(true);
    setError(null);
    try {
      await onRemove();
      onClose();
    } catch (err) {
      setError(err.message);
      setRemoving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2>{category.category_name}</h2>
          <button className="modal-close" onClick={onClose} type="button">×</button>
        </div>

        <div className="form-stack">
          <div className="field">
            <label className="field-label">Budget Period</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {["monthly", "yearly"].map((p) => (
                <button
                  key={p}
                  type="button"
                  disabled={isMisc}
                  onClick={() => setPeriod(p)}
                  className="btn btn-sm"
                  style={{
                    border: `1.5px solid ${period === p ? "var(--primary)" : "var(--border)"}`,
                    background: period === p ? "rgba(108,99,255,0.15)" : "transparent",
                    color: period === p ? "var(--primary)" : "var(--text-muted)",
                  }}
                >
                  {p === "monthly" ? "Monthly" : "Yearly"}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label className="field-label">Misc / Catch-all</label>
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: -4, marginBottom: 8 }}>
              The Misc category is just the default bucket for spend that
              doesn't fit anywhere else.
            </p>
            <button
              type="button"
              className="btn btn-sm"
              onClick={handleToggleMisc}
              disabled={settingMisc}
              style={{
                border: `1.5px solid ${isMisc ? "var(--primary)" : "var(--border)"}`,
                background: isMisc ? "rgba(108,99,255,0.15)" : "transparent",
                color: isMisc ? "var(--primary)" : "var(--text-muted)",
              }}
            >
              {settingMisc ? "…" : isMisc ? "★ This is the Misc category" : "Set as Misc category"}
            </button>
          </div>

          {!isMisc && (
            <div className="field">
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 13,
                  color: "var(--text-muted)",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={foldIntoMisc}
                  onChange={(e) => setFoldIntoMisc(e.target.checked)}
                />
                Flexible (share one combined budget pool with other flexible categories)
              </label>
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>
                Keeps its own budget and shows its own spend, but going over here
                is only a problem if the combined pool across all flexible
                categories runs out — underspending in one covers overspending
                in another.
              </p>
            </div>
          )}

          {error && <div className="msg msg-error">{error}</div>}

          <button className="btn btn-primary" type="button" onClick={handleSave} disabled={saving || isMisc}>
            {saving ? "Saving…" : "Save"}
          </button>

          <div className="divider" />

          <button
            className="btn btn-destructive"
            type="button"
            onClick={handleRemove}
            disabled={removing}
            style={{ width: "100%" }}
          >
            {removing ? "Removing…" : confirmRemove ? "Click again to confirm removal" : "Remove Category"}
          </button>
        </div>
      </div>
    </div>
  );
}
