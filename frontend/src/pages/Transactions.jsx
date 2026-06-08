import { useEffect, useState } from "react";
import { api } from "../api";

const PAGE_SIZE = 25;

const EMPTY_FORM = {
  merchant_raw: "",
  amount: "",
  direction: "outflow",
  transaction_at: new Date().toISOString().slice(0, 10),
  category_id: "",
  notes: "",
};

function txnToForm(t) {
  return {
    merchant_raw: t.merchant_raw ?? "",
    amount: String(t.amount),
    direction: t.direction,
    transaction_at: t.transaction_at?.slice(0, 10) ?? "",
    category_id: t.category_id != null ? String(t.category_id) : "",
    notes: t.notes ?? "",
  };
}

function fmtAmt(t) {
  const sign = t.direction === "inflow" ? "+" : "-";
  const n = parseFloat(t.amount).toFixed(2);
  return `${sign}$${n}`;
}

function fmtDate(s) {
  if (!s) return "";
  return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function TxnForm({ initial, categories, onSave, onCancel, submitLabel }) {
  const [form, setForm] = useState(initial);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await onSave({
        ...form,
        amount: parseFloat(form.amount),
        category_id: form.category_id ? parseInt(form.category_id) : null,
      });
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  return (
    <form className="txn-form-grid" onSubmit={handleSubmit}>
      <div className="txn-form-row">
        <div className="field">
          <label className="field-label">Date</label>
          <input type="date" name="transaction_at" value={form.transaction_at} onChange={handleChange} required />
        </div>
        <div className="field">
          <label className="field-label">Amount</label>
          <input type="number" name="amount" value={form.amount} onChange={handleChange} step="0.01" min="0" required placeholder="0.00" />
        </div>
      </div>

      <div className="field">
        <label className="field-label">Merchant</label>
        <input type="text" name="merchant_raw" value={form.merchant_raw} onChange={handleChange} placeholder="e.g. Whole Foods" />
      </div>

      <div className="txn-form-row">
        <div className="field">
          <label className="field-label">Direction</label>
          <select name="direction" value={form.direction} onChange={handleChange}>
            <option value="outflow">Debit</option>
            <option value="inflow">Credit</option>
          </select>
        </div>
        <div className="field">
          <label className="field-label">Category</label>
          <select name="category_id" value={form.category_id} onChange={handleChange}>
            <option value="">None</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="field">
        <label className="field-label">Notes</label>
        <input type="text" name="notes" value={form.notes} onChange={handleChange} />
      </div>

      {error && <div className="msg msg-error">{error}</div>}

      <div className="form-actions">
        <button className="btn btn-primary" type="submit" disabled={submitting} style={{ flex: 1 }}>
          {submitting ? "Saving…" : submitLabel}
        </button>
        <button className="btn btn-ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export default function Transactions() {
  const [transactions, setTransactions] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [showCreate, setShowCreate] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [editingId, setEditingId] = useState(null);

  // Filter state
  const [filterCat, setFilterCat] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function buildParams(p) {
    const params = { limit: PAGE_SIZE, offset: p * PAGE_SIZE };
    if (filterCat) params.category_id = parseInt(filterCat);
    if (dateFrom) params.date_from = dateFrom;
    if (dateTo) params.date_to = dateTo;
    return params;
  }

  function fetchPage(p) {
    setLoading(true);
    setError(null);
    api.getTransactions(buildParams(p))
      .then((data) => {
        setTransactions(data.transactions);
        setTotal(data.total);
        setPage(p);
        setExpandedId(null);
        setEditingId(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    Promise.all([
      api.getCategories(),
      api.getTransactions({ limit: PAGE_SIZE, offset: 0 }),
    ])
      .then(([cats, data]) => {
        setCategories(cats);
        setTransactions(data.transactions);
        setTotal(data.total);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  function applyFilters() {
    setPage(0);
    setLoading(true);
    setError(null);
    const params = { limit: PAGE_SIZE, offset: 0 };
    if (filterCat) params.category_id = parseInt(filterCat);
    if (dateFrom) params.date_from = dateFrom;
    if (dateTo) params.date_to = dateTo;
    api.getTransactions(params)
      .then((data) => {
        setTransactions(data.transactions);
        setTotal(data.total);
        setExpandedId(null);
        setEditingId(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }

  async function handleCreate(payload) {
    await api.createTransaction(payload);
    setShowCreate(false);
    fetchPage(0);
  }

  async function handleDelete(id) {
    if (!confirm("Delete this transaction?")) return;
    try {
      await api.deleteTransaction(id);
      const newTotal = total - 1;
      const maxPage = Math.max(0, Math.ceil(newTotal / PAGE_SIZE) - 1);
      fetchPage(Math.min(page, maxPage));
    } catch (err) {
      alert(err.message);
    }
  }

  function handleSaved(updated) {
    setTransactions((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    setEditingId(null);
    setExpandedId(updated.id);
  }

  function toggleRow(id) {
    if (editingId === id) return;
    setExpandedId((prev) => (prev === id ? null : id));
  }

  return (
    <div className="page">
      {loading && <div className="top-bar-loading" />}

      <div className="page-header">
        <h1>Transactions</h1>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => { setShowCreate((v) => !v); setExpandedId(null); setEditingId(null); }}
        >
          {showCreate ? "Cancel" : "+ New"}
        </button>
      </div>

      {showCreate && (
        <div className="txn-form-wrap card" style={{ marginBottom: 12 }}>
          <TxnForm
            initial={EMPTY_FORM}
            categories={categories}
            onSave={handleCreate}
            onCancel={() => setShowCreate(false)}
            submitLabel="Create"
          />
        </div>
      )}

      {/* Filter bar */}
      <div className="filter-bar">
        <select value={filterCat} onChange={(e) => setFilterCat(e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
      </div>
      <button className="btn btn-ghost btn-sm" style={{ marginBottom: 12 }} onClick={applyFilters}>
        Apply
      </button>

      {error && <div className="msg msg-error">{error}</div>}

      {!loading && transactions.length === 0 && !error && (
        <div className="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="2" y="5" width="20" height="14" rx="2" />
            <path d="M2 10h20" />
          </svg>
          No transactions found
        </div>
      )}

      {transactions.length > 0 && (
        <>
          <div className="txn-list card">
            {transactions.map((t) => (
              <div className="txn-row" key={t.id}>
                <div className="txn-row-main" onClick={() => toggleRow(t.id)}>
                  <div>
                    <div className="txn-merchant">{t.merchant_raw || "Untitled"}</div>
                    <div className="txn-row-sub">{fmtDate(t.transaction_at)} · {t.category_name || "Uncategorized"}</div>
                  </div>
                  <span className={`txn-amount ${t.direction === "inflow" ? "text-green" : "text-red"}`}>
                    {fmtAmt(t)}
                  </span>
                </div>

                {expandedId === t.id && editingId !== t.id && (
                  <div className="txn-expanded">
                    <dl className="txn-meta">
                      {t.notes && <><dt className="txn-meta-key">Notes</dt><dd className="txn-meta-val">{t.notes}</dd></>}
                      <dt className="txn-meta-key">Direction</dt>
                      <dd className="txn-meta-val">{t.direction === "inflow" ? "Credit" : "Debit"}</dd>
                    </dl>
                    <div className="txn-expanded-actions">
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => { setEditingId(t.id); setExpandedId(null); setShowCreate(false); }}
                      >
                        Edit
                      </button>
                      <button className="btn btn-sm" style={{ color: "var(--red)", border: "1px solid var(--red)", background: "transparent" }} onClick={() => handleDelete(t.id)}>
                        Delete
                      </button>
                    </div>
                  </div>
                )}

                {editingId === t.id && (
                  <div className="txn-expanded">
                    <TxnForm
                      initial={txnToForm(t)}
                      categories={categories}
                      onSave={async (payload) => {
                        const updated = await api.updateTransaction(t.id, payload);
                        handleSaved(updated);
                      }}
                      onCancel={() => { setEditingId(null); setExpandedId(t.id); }}
                      submitLabel="Save"
                    />
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="pagination">
            <button onClick={() => fetchPage(page - 1)} disabled={page === 0 || loading}>← Prev</button>
            <span>{page + 1} / {totalPages}</span>
            <button onClick={() => fetchPage(page + 1)} disabled={page >= totalPages - 1 || loading}>Next →</button>
          </div>
        </>
      )}
    </div>
  );
}
