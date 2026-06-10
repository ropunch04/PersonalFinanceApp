import { useEffect, useState } from "react";
import { api } from "../api";

function fmt(n) {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 2,
  }).format(n ?? 0);
}

function fmtDate(s) {
  if (!s) return "";
  return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function MerchantSheet({ merchant, onClose }) {
  const txns = merchant.transactions ?? [];
  return (
    <>
      <div
        style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 200,
        }}
        onClick={onClose}
      />
      <div style={{
        position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)",
        width: "100%", maxWidth: 960,
        background: "var(--surface)", borderRadius: "16px 16px 0 0",
        zIndex: 201, maxHeight: "70dvh", display: "flex", flexDirection: "column",
      }}>
        <div style={{ display: "flex", justifyContent: "center", padding: "12px 0 4px" }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: "var(--border)" }} />
        </div>
        <div style={{ padding: "0 16px 12px", fontWeight: 700, fontSize: 16, color: "var(--text)" }}>
          {merchant.merchant_raw}
        </div>
        <div style={{ overflowY: "auto", flex: 1, paddingBottom: 24 }}>
          {txns.length === 0 ? (
            <div style={{ padding: "24px 16px", textAlign: "center", color: "#94A3B8", fontSize: 13 }}>
              No transactions found
            </div>
          ) : (
            txns.map((t, i) => (
              <div key={i} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "12px 16px",
                borderBottom: i < txns.length - 1 ? "1px solid var(--border)" : "none",
              }}>
                <div style={{ fontSize: 13, color: "#94A3B8" }}>{fmtDate(t.transaction_at)}</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#EF4444" }}>{fmt(t.amount)}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}

export default function MerchantInsights({ dateParams }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeSheet, setActiveSheet] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); // eslint-disable-line react-hooks/set-state-in-effect
    api.getMerchants(dateParams)
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [dateParams]);

  if (loading && !data) {
    return (
      <div style={{
        height: 120, borderRadius: 12, background: "#22263A",
        animation: "pulse 1.5s ease-in-out infinite", marginBottom: 20,
      }} />
    );
  }

  if (!data) return null;

  const { top_merchants = [], largest_transaction, repeat_merchants = [] } = data;
  if (top_merchants.length === 0 && !largest_transaction) return null;

  return (
    <>
      <div className="card" style={{ padding: 0, marginBottom: 20 }}>
        {top_merchants.length > 0 && (
          <>
            <p className="section-label" style={{ padding: "14px 16px 10px", margin: 0 }}>
              TOP MERCHANTS
            </p>
            {top_merchants.map((m, i) => (
              <div
                key={i}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "12px 16px",
                  borderTop: "1px solid var(--border)",
                  cursor: "pointer",
                }}
                onClick={() => setActiveSheet(m)}
              >
                <span style={{ fontSize: 13, color: "#475569", minWidth: 18, textAlign: "center" }}>
                  {i + 1}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 500, color: "#F1F5F9", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {m.merchant_raw}
                  </div>
                  <div style={{ fontSize: 12, color: "#94A3B8", marginTop: 1 }}>
                    {m.transaction_count} transaction{m.transaction_count !== 1 ? "s" : ""}
                  </div>
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#EF4444", flexShrink: 0 }}>
                  {fmt(m.net_spent)}
                </div>
              </div>
            ))}
          </>
        )}

        {largest_transaction && (
          <>
            <p className="section-label" style={{ padding: "14px 16px 10px", margin: 0 }}>
              LARGEST TRANSACTION
            </p>
            <div style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "12px 16px",
              borderTop: "1px solid var(--border)",
              borderLeft: "3px solid #F59E0B",
            }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 500, color: "#F1F5F9" }}>
                  {largest_transaction.merchant_raw}
                </div>
                <div style={{ fontSize: 12, color: "#94A3B8", marginTop: 1 }}>
                  {fmtDate(largest_transaction.transaction_at)}
                </div>
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#EF4444" }}>
                {fmt(largest_transaction.net_amount ?? largest_transaction.amount)}
              </div>
            </div>
          </>
        )}

        {repeat_merchants.length > 0 && (
          <>
            <p className="section-label" style={{ padding: "14px 16px 6px", margin: 0 }}>
              RECURRING
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "0 16px 14px", borderTop: "1px solid var(--border)" }}>
              {repeat_merchants.map((m, i) => (
                <div key={i} style={{
                  display: "flex", alignItems: "center", gap: 6,
                  background: "#22263A", border: "1px solid #2E3250",
                  borderRadius: 20, padding: "5px 10px",
                }}>
                  <span style={{ fontSize: 13, color: "#F1F5F9" }}>{m.merchant_raw}</span>
                  <span style={{
                    background: "#2E3250", borderRadius: 10,
                    fontSize: 10, fontWeight: 700, color: "#94A3B8",
                    padding: "1px 5px",
                  }}>
                    {m.months_seen}mo
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {activeSheet && <MerchantSheet merchant={activeSheet} onClose={() => setActiveSheet(null)} />}
    </>
  );
}
