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
    <form className="txn-form" onSubmit={handleSubmit}>
      <label>
        Date
        <input type="date" name="transaction_at" value={form.transaction_at} onChange={handleChange} required />
      </label>
      <label>
        Merchant
        <input type="text" name="merchant_raw" value={form.merchant_raw} onChange={handleChange} placeholder="e.g. Whole Foods" />
      </label>
      <label>
        Amount
        <input type="number" name="amount" value={form.amount} onChange={handleChange} step="0.01" min="0" required />
      </label>
      <label>
        Direction
        <select name="direction" value={form.direction} onChange={handleChange}>
          <option value="outflow">Debit (outflow)</option>
          <option value="inflow">Credit (inflow)</option>
        </select>
      </label>
      <label>
        Category
        <select name="category_id" value={form.category_id} onChange={handleChange}>
          <option value="">— None —</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </label>
      <label>
        Notes
        <input type="text" name="notes" value={form.notes} onChange={handleChange} />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button type="submit" disabled={submitting}>{submitting ? "Saving..." : submitLabel}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function EditRow({ txn, categories, onSaved, onCancel }) {
  async function handleSave(payload) {
    const updated = await api.updateTransaction(txn.id, payload);
    onSaved(updated);
  }

  return (
    <tr>
      <td colSpan={7}>
        <TxnForm
          initial={txnToForm(txn)}
          categories={categories}
          onSave={handleSave}
          onCancel={onCancel}
          submitLabel="Save"
        />
      </td>
    </tr>
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
  const [editingId, setEditingId] = useState(null);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function fetchPage(p) {
    setLoading(true);
    setError(null);
    api.getTransactions({ limit: PAGE_SIZE, offset: p * PAGE_SIZE })
      .then((data) => {
        setTransactions(data.transactions);
        setTotal(data.total);
        setPage(p);
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

  async function handleCreate(payload) {
    const created = await api.createTransaction(payload);
    // Created transaction is most recent — go to first page to show it
    setShowCreate(false);
    fetchPage(0);
    return created;
  }

  async function handleDelete(id) {
    if (!confirm("Delete this transaction?")) return;
    try {
      await api.deleteTransaction(id);
      // Refresh current page; if it becomes empty go back one
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
  }

  return (
    <div className="transactions-page">
      <div className="page-header">
        <h1>Transactions</h1>
        <button onClick={() => { setShowCreate((v) => !v); setEditingId(null); }}>
          {showCreate ? "Cancel" : "+ New"}
        </button>
      </div>

      {showCreate && (
        <TxnForm
          initial={EMPTY_FORM}
          categories={categories}
          onSave={handleCreate}
          onCancel={() => setShowCreate(false)}
          submitLabel="Create"
        />
      )}

      {loading ? (
        <p>Loading...</p>
      ) : error ? (
        <p className="error">{error}</p>
      ) : transactions.length === 0 ? (
        <p>No transactions yet.</p>
      ) : (
        <>
          <table className="txn-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Merchant</th>
                <th>Amount</th>
                <th>Category</th>
                <th>Direction</th>
                <th>Notes</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((t) =>
                editingId === t.id ? (
                  <EditRow
                    key={t.id}
                    txn={t}
                    categories={categories}
                    onSaved={handleSaved}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <tr key={t.id}>
                    <td>{t.transaction_at?.slice(0, 10)}</td>
                    <td>{t.merchant_raw || "—"}</td>
                    <td>${parseFloat(t.amount).toFixed(2)}</td>
                    <td>{t.category_name || "—"}</td>
                    <td>{t.direction === "inflow" ? "Credit" : "Debit"}</td>
                    <td>{t.notes || "—"}</td>
                    <td className="row-actions">
                      <button onClick={() => { setEditingId(t.id); setShowCreate(false); }}>Edit</button>
                      <button className="delete-btn" onClick={() => handleDelete(t.id)} aria-label="Delete">✕</button>
                    </td>
                  </tr>
                )
              )}
            </tbody>
          </table>

          <div className="pagination">
            <button onClick={() => fetchPage(page - 1)} disabled={page === 0}>← Prev</button>
            <span>Page {page + 1} of {totalPages} ({total} total)</span>
            <button onClick={() => fetchPage(page + 1)} disabled={page >= totalPages - 1}>Next →</button>
          </div>
        </>
      )}
    </div>
  );
}
