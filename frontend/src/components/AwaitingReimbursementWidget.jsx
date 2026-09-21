import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { fmtCurrency } from "../format";

function fmtDate(s) {
  if (!s) return "";
  return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function AwaitingReimbursementWidget() {
  const [data, setData] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.getAwaitingReimbursement().then(setData).catch(() => {});
  }, []);

  if (!data || data.items.length === 0) return null;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
        <p className="section-label" style={{ marginBottom: 0 }}>Awaiting Reimbursement</p>
        <span style={{ fontSize: 15, fontWeight: 700, color: "var(--red)" }}>
          {fmtCurrency(data.total_gap, 2)}
        </span>
      </div>
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: -4, marginBottom: 10 }}>
        Charges you've flagged as waiting on a Venmo/Zelle-style payback — mark one complete
        on the Transactions page once it's settled.
      </p>
      {data.items.map((item) => (
        <div
          key={item.id}
          onClick={() => navigate(`/transactions?q=${encodeURIComponent(item.merchant_raw || "")}`)}
          style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "8px 0", borderBottom: "1px solid var(--border)", cursor: "pointer",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{
              fontSize: 13, fontWeight: 500, color: "var(--text)",
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            }}>
              {item.merchant_raw || "Untitled"}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 1 }}>
              {fmtDate(item.transaction_at)}
              {item.received > 0 ? ` · ${fmtCurrency(item.received, 2)} received` : ""}
            </div>
          </div>
          <span style={{ fontSize: 13, fontWeight: 600, color: item.gap > 0.005 ? "var(--red)" : "var(--green)", flexShrink: 0 }}>
            {item.gap > 0.005 ? fmtCurrency(item.gap, 2) : "✓ fully linked"}
          </span>
        </div>
      ))}
    </div>
  );
}
