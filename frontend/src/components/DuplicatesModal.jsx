import { useEffect, useState } from "react";
import { api } from "../api";
import { fmtCurrency } from "../format";
const fmt = (n) => fmtCurrency(n, 2);



function fmtDate(s) {
  if (!s) return "";
  return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function DuplicatesModal({ onClose, onDeleted }) {
  const [groups, setGroups]     = useState(null);
  const [loading, setLoading]   = useState(true);
  const [deleting, setDeleting] = useState(null);

  useEffect(() => {
    api.getDuplicates()
      .then((d) => { setGroups(d.groups ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  async function handleDelete(id) {
    setDeleting(id);
    try {
      await api.deleteTransaction(id);
      setGroups((prev) =>
        prev
          .map((g) => g.filter((t) => t.id !== id))
          .filter((g) => g.length > 1)
      );
      onDeleted();
    } catch (e) {
      alert("Error: " + e.message);
    } finally {
      setDeleting(null);
    }
  }

  async function handleKeepFirst(group) {
    const toDelete = group.slice(1);
    for (const t of toDelete) {
      await handleDelete(t.id);
    }
  }

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxHeight: "80dvh", display: "flex", flexDirection: "column" }}>
        <div className="modal-header">
          <h2>Review Duplicates</h2>
          <button className="modal-close" onClick={onClose} type="button">×</button>
        </div>

        <div style={{ overflowY: "auto", flex: 1 }}>
          {loading && <div className="top-bar-loading" />}

          {!loading && groups?.length === 0 && (
            <div className="empty-state" style={{ padding: "40px 16px" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 36, height: 36 }}>
                <polyline points="20 6 9 17 4 12" />
              </svg>
              No duplicates found
            </div>
          )}

          {!loading && groups?.length > 0 && (
            <div style={{ padding: "0 16px 16px" }}>
              <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 16 }}>
                {groups.length} duplicate group{groups.length !== 1 ? "s" : ""} found. Keep the one you want and delete the rest.
              </p>

              {groups.map((group, gi) => (
                <div key={gi} className="card" style={{ padding: 0, marginBottom: 12 }}>
                  <div style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "10px 14px",
                    borderBottom: "1px solid var(--border)",
                    background: "var(--bg)", borderRadius: "12px 12px 0 0",
                  }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                      {group[0].merchant_raw || "Unknown"} · {fmtDate(group[0].transaction_at)} · {fmt(group[0].amount)}
                    </span>
                    <button
                      className="btn btn-sm"
                      style={{ fontSize: 11, padding: "3px 10px", opacity: deleting ? 0.5 : 1 }}
                      disabled={!!deleting}
                      onClick={() => handleKeepFirst(group)}
                    >
                      Keep first, delete rest
                    </button>
                  </div>

                  {group.map((t, ti) => (
                    <div key={t.id} style={{
                      display: "flex", alignItems: "center", gap: 10,
                      padding: "10px 14px",
                      borderBottom: ti < group.length - 1 ? "1px solid var(--border)" : "none",
                      opacity: deleting === t.id ? 0.4 : 1,
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: "var(--text)", fontWeight: 500 }}>
                          {t.direction === "inflow" ? "+" : "−"}{fmt(t.amount)}
                          <span style={{ fontWeight: 400, color: "var(--text-secondary)", marginLeft: 8 }}>
                            {t.category_name ?? "Uncategorized"}
                          </span>
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                          ID #{t.id} · {fmtDate(t.transaction_at)}
                          {t.notes && ` · ${t.notes.startsWith("venmo:") ? t.notes.slice(6) : t.notes}`}
                        </div>
                      </div>
                      <button
                        className="btn btn-sm"
                        style={{
                          color: "var(--red)", borderColor: "var(--red)",
                          background: "transparent", flexShrink: 0,
                          opacity: deleting ? 0.5 : 1,
                        }}
                        disabled={!!deleting}
                        onClick={() => handleDelete(t.id)}
                      >
                        {deleting === t.id ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
