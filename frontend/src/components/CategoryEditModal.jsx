import { useState } from "react";

export default function CategoryEditModal({ category, canFold, onClose, onSave, onSetMisc, onRemove }) {
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
            <div style={{ display: "flex", gap: 8 }}>
              {["monthly", "yearly"].map((p) => (
                <button
                  key={p}
                  type="button"
                  disabled={isMisc || foldIntoMisc}
                  onClick={() => setPeriod(p)}
                  className="btn btn-sm"
                  style={{
                    border: `1.5px solid ${period === p ? "var(--primary)" : "var(--border)"}`,
                    background: period === p ? "rgba(34,197,94,0.15)" : "transparent",
                    color: period === p ? "var(--primary)" : "var(--text-muted)",
                  }}
                >
                  {p === "monthly" ? "Monthly" : "Yearly"}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label className="field-label">Misc / Flex Bucket</label>
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: -4, marginBottom: 8 }}>
              The Misc category absorbs spending that goes over any other category's
              own budget, plus the full spend of any category folded into it.
            </p>
            <button
              type="button"
              className="btn btn-sm"
              onClick={handleToggleMisc}
              disabled={settingMisc}
              style={{
                border: `1.5px solid ${isMisc ? "var(--primary)" : "var(--border)"}`,
                background: isMisc ? "rgba(34,197,94,0.15)" : "transparent",
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
                  cursor: canFold ? "pointer" : "not-allowed",
                  opacity: canFold ? 1 : 0.5,
                }}
              >
                <input
                  type="checkbox"
                  checked={foldIntoMisc}
                  disabled={!canFold}
                  onChange={(e) => setFoldIntoMisc(e.target.checked)}
                />
                Fold entirely into Misc (this category keeps no budget of its own)
              </label>
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
