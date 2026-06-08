import { useEffect, useState } from "react";
import { api } from "../api";

const EMPTY_FORM = {
  merchant_raw: "",
  amount: "",
  direction: "outflow",
  transaction_at: new Date().toISOString().slice(0, 10),
  category_id: "",
  notes: "",
};

export default function Transactions() {
  const [transactions, setTransactions] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);

  useEffect(() => {
    Promise.all([api.getTransactions(), api.getCategories()])
      .then(([txns, cats]) => {
        setTransactions(txns);
        setCategories(cats);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
  }

  async function handleCreate(e) {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      const payload = {
        ...form,
        amount: parseFloat(form.amount),
        category_id: form.category_id ? parseInt(form.category_id) : null,
      };
      const created = await api.createTransaction(payload);
      setTransactions((prev) => [created, ...prev]);
      setForm(EMPTY_FORM);
      setShowForm(false);
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id) {
    try {
      await api.deleteTransaction(id);
      setTransactions((prev) => prev.filter((t) => t.id !== id));
    } catch (err) {
      alert(err.message);
    }
  }

  if (loading) return <p>Loading...</p>;
  if (error) return <p className="error">{error}</p>;

  return (
    <div className="transactions-page">
      <div className="page-header">
        <h1>Transactions</h1>
        <button onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Cancel" : "+ New"}
        </button>
      </div>

      {showForm && (
        <form className="txn-form" onSubmit={handleCreate}>
          <label>
            Date
            <input
              type="date"
              name="transaction_at"
              value={form.transaction_at}
              onChange={handleChange}
              required
            />
          </label>
          <label>
            Merchant
            <input
              type="text"
              name="merchant_raw"
              value={form.merchant_raw}
              onChange={handleChange}
              placeholder="e.g. Whole Foods"
            />
          </label>
          <label>
            Amount
            <input
              type="number"
              name="amount"
              value={form.amount}
              onChange={handleChange}
              step="0.01"
              min="0"
              required
            />
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
            <input
              type="text"
              name="notes"
              value={form.notes}
              onChange={handleChange}
            />
          </label>
          {formError && <p className="error">{formError}</p>}
          <button type="submit" disabled={submitting}>
            {submitting ? "Saving..." : "Save"}
          </button>
        </form>
      )}

      {transactions.length === 0 ? (
        <p>No transactions yet.</p>
      ) : (
        <table className="txn-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Merchant</th>
              <th>Amount</th>
              <th>Category</th>
              <th>Direction</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {transactions.map((t) => (
              <tr key={t.id}>
                <td>{t.transaction_at?.slice(0, 10)}</td>
                <td>{t.merchant_raw || "—"}</td>
                <td>${parseFloat(t.amount).toFixed(2)}</td>
                <td>{t.category_name || "—"}</td>
                <td>{t.direction === "inflow" ? "Credit" : "Debit"}</td>
                <td>
                  <button
                    className="delete-btn"
                    onClick={() => handleDelete(t.id)}
                    aria-label="Delete transaction"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
