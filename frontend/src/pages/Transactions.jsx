import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import CategoryPicker from "../components/CategoryPicker";
import DuplicatesModal from "../components/DuplicatesModal";
import ReimbursePickerModal from "../components/ReimbursePickerModal";
import { useOnline } from "../context/OnlineContext";

const SOURCE_TYPES = [
  { value: "capitalone", label: "Capital One" },
  { value: "venmo", label: "Venmo" },
];

const PAGE_SIZE = 25;

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
  return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function venmoLabel(notes, direction, expanded = false) {
  if (!notes?.startsWith("venmo:")) return null;
  const rest = notes.slice(6);
  let type, person;
  if (rest.startsWith("payment:")) {
    type = "payment";
    person = rest.slice(8);
  } else if (rest.startsWith("charge:")) {
    type = "charge";
    person = rest.slice(7);
  } else {
    person = rest;
    type = "payment";
  }
  if (direction === "inflow") return expanded ? `Received from ${person}` : `From ${person}`;
  if (type === "charge") return expanded ? `Charged by ${person}` : `From ${person}`;
  return expanded ? `Sent to ${person}` : `To ${person}`;
}


function ImportModal({ onClose, onImported }) {
  const [sourceType, setSourceType] = useState("capitalone");
  const [files, setFiles] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const backdropRef = useRef(null);

  function handleBackdropClick(e) {
    if (e.target === backdropRef.current) onClose();
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (files.length === 0) return;
    setSubmitting(true);
    setResult(null);
    setError(null);
    try {
      const data = await api.importTransactions(sourceType, files);
      setResult(data);
      onImported();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" ref={backdropRef} onClick={handleBackdropClick}>
      <div className="modal">
        <div className="modal-header">
          <h2>Import CSV</h2>
          <button className="modal-close" onClick={onClose} type="button">×</button>
        </div>

        <div className="segmented" style={{ marginBottom: 16 }}>
          {SOURCE_TYPES.map((s) => (
            <button
              key={s.value}
              type="button"
              className={sourceType === s.value ? "seg-active" : ""}
              onClick={() => { setSourceType(s.value); setResult(null); }}
            >
              {s.label}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit}>
          <div
            className={`drop-zone${files.length > 0 ? " has-files" : ""}`}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const dropped = Array.from(e.dataTransfer.files).filter((f) => f.name.endsWith(".csv"));
              if (dropped.length) { setFiles(dropped); setResult(null); }
            }}
          >
            <input
              type="file"
              accept=".csv"
              multiple
              onChange={(e) => { setFiles(Array.from(e.target.files)); setResult(null); }}
            />
            <svg className="drop-zone-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            {files.length > 0 ? (
              <div className="drop-zone-text">
                <strong>{files.length} file{files.length !== 1 ? "s" : ""} selected</strong>
                {files.map((f) => f.name).join(", ")}
              </div>
            ) : (
              <div className="drop-zone-text">
                <strong>Tap to choose CSV files</strong>
                or drag and drop here
              </div>
            )}
          </div>

          {error && <div className="msg msg-error" style={{ marginBottom: 12 }}>{error}</div>}

          {result && (
            <div className="import-result" style={{ marginBottom: 12 }}>
              <div className="import-stat green">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                {result.imported} transaction{result.imported !== 1 ? "s" : ""} imported
              </div>
              {(result.duplicates_skipped ?? 0) > 0 && (
                <div className="import-stat grey">
                  {result.duplicates_skipped} duplicate{result.duplicates_skipped !== 1 ? "s" : ""} skipped
                </div>
              )}
              {result.errors?.length > 0 && result.errors.map((e, i) => (
                <div key={i} className="import-error-item">{e}</div>
              ))}
            </div>
          )}

          <button className="btn btn-primary" type="submit" disabled={submitting || files.length === 0}>
            {submitting ? "Importing…" : "Import"}
          </button>
        </form>
      </div>
    </div>
  );
}


function ClassifyModal({ categories, onClose, onDone }) {
  const backdropRef = useRef(null);
  const [merchants, setMerchants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingPrefix, setSavingPrefix] = useState(null);
  const [autoRunning, setAutoRunning] = useState(false);
  const [autoResult, setAutoResult] = useState(null);

  function loadMerchants() {
    setLoading(true);
    api.getUnclassifiedMerchants()
      .then(setMerchants)
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadMerchants();
  }, []);

  async function handleAutoClassify() {
    setAutoRunning(true);
    setAutoResult(null);
    try {
      const result = await api.autoClassify();
      setAutoResult(result);
      loadMerchants();
      onDone();
    } catch {
    } finally {
      setAutoRunning(false);
    }
  }

  async function assign(merchant, categoryId) {
    setSavingPrefix(merchant.prefix);
    try {
      await api.bulkCategorize(merchant.example, categoryId);
      setMerchants((prev) => prev.filter((m) => m.prefix !== merchant.prefix));
      onDone();
    } catch {
    } finally {
      setSavingPrefix(null);
    }
  }

  function handleBackdrop(e) {
    if (e.target === backdropRef.current) onClose();
  }

  return (
    <div className="modal-backdrop" ref={backdropRef} onClick={handleBackdrop}>
      <div className="modal">
        <div className="modal-header">
          <h2>Classify Merchants</h2>
          <button className="modal-close" type="button" onClick={onClose}>×</button>
        </div>

        {loading && <div className="top-bar-loading" />}

        <div style={{ marginBottom: 20 }}>
          <button
            className="btn btn-primary"
            style={{ width: "100%" }}
            onClick={handleAutoClassify}
            disabled={autoRunning || loading}
          >
            {autoRunning ? "Running…" : "Auto-classify from history"}
          </button>
          {autoResult && (
            <div className={`msg ${autoResult.classified > 0 ? "msg-success" : "msg-error"}`} style={{ marginTop: 8 }}>
              {autoResult.classified > 0
                ? `${autoResult.classified} transaction${autoResult.classified !== 1 ? "s" : ""} classified automatically.${autoResult.unmatched > 0 ? ` ${autoResult.unmatched} still need review.` : ""}`
                : "No historical matches found — classify some manually first."}
            </div>
          )}
        </div>

        {merchants.length > 0 && (
          <p className="section-label" style={{ marginBottom: 12 }}>Manual</p>
        )}

        {!loading && merchants.length === 0 && (
          <div className="empty-state" style={{ padding: "32px 0" }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            All merchants classified
          </div>
        )}

        {merchants.map((m) => (
          <div key={m.prefix} style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{m.prefix}</span>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{m.count} transaction{m.count !== 1 ? "s" : ""}</span>
            </div>
            <div className="cat-pills">
              {categories.map((c) => (
                <button
                  key={c.id}
                  className={`cat-pill${savingPrefix === m.prefix ? " saving" : ""}`}
                  onClick={() => assign(m, c.id)}
                >
                  {c.name}
                </button>
              ))}
            </div>
            <div style={{ height: 1, background: "var(--border)", marginTop: 16 }} />
          </div>
        ))}
      </div>
    </div>
  );
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


function AddModal({ categories, onClose, onSaved }) {
  const [merchant, setMerchant] = useState("");
  const [amount, setAmount] = useState("");
  const [direction, setDirection] = useState("outflow");
  const [categoryId, setCategoryId] = useState(null);
  const [notes, setNotes] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function save(e) {
    e.preventDefault();
    if (!merchant.trim()) { setError("Merchant is required."); return; }
    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      setError("Enter a valid amount."); return;
    }
    setSaving(true);
    setError(null);
    try {
      const txn = await api.createTransaction({
        merchant_raw: merchant.trim(),
        amount: parseFloat(amount),
        direction,
        category_id: categoryId,
        notes: notes.trim(),
        transaction_at: date,
      });
      onSaved(txn);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Add Transaction</h2>
          <button className="modal-close" type="button" onClick={onClose}>×</button>
        </div>

        <form onSubmit={save}>
          <div className="form-stack">
            <div className="field">
              <label className="field-label">Direction</label>
              <div className="segmented">
                <button
                  type="button"
                  className={direction === "outflow" ? "seg-active" : ""}
                  onClick={() => setDirection("outflow")}
                  style={direction === "outflow" ? { background: "var(--red)" } : {}}
                >
                  Money Out
                </button>
                <button
                  type="button"
                  className={direction === "inflow" ? "seg-active" : ""}
                  onClick={() => setDirection("inflow")}
                  style={direction === "inflow" ? { background: "var(--green)" } : {}}
                >
                  Money In
                </button>
              </div>
            </div>

            <div className="field">
              <label className="field-label">Merchant / Description</label>
              <input
                type="text"
                value={merchant}
                onChange={(e) => setMerchant(e.target.value)}
                placeholder="e.g. Farmer's Market"
                autoFocus
              />
            </div>

            <div className="txn-form-row">
              <div className="field">
                <label className="field-label">Amount ($)</label>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                />
              </div>
              <div className="field">
                <label className="field-label">Date</label>
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
            </div>

            <div className="field">
              <label className="field-label">Category</label>
              <CategoryPicker value={categoryId} onChange={setCategoryId} categories={categories} />
            </div>

            <div className="field">
              <label className="field-label">Notes (optional)</label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional note"
              />
            </div>

            {error && <div className="msg msg-error">{error}</div>}

            <button className="btn btn-primary" type="submit" disabled={saving}>
              {saving ? "Saving…" : "Add Transaction"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}


const STATUS_OPTIONS = [
  { value: "", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "confirmed", label: "Confirmed" },
];

function needsReview(t) {
  return t.category_id == null;
}

function ReclassifyModal({ txn, categories, onClose, onDone }) {
  const [toCategoryId, setToCategoryId] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleConfirm() {
    if (!toCategoryId) return;
    setSaving(true);
    try {
      const result = await api.reclassify(txn.merchant_raw, txn.category_id, parseInt(toCategoryId));
      onDone(result.updated);
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  const choices = categories.filter((c) => c.id !== txn.category_id);

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <span style={{ fontWeight: 600, fontSize: 16 }}>Reclassify all</span>
          <button className="modal-close" onClick={onClose} type="button">×</button>
        </div>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 4 }}>
          Move all <strong style={{ color: "var(--text)" }}>{txn.merchant_raw}</strong> transactions
        </p>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 16 }}>
          from <strong style={{ color: "var(--text)" }}>{txn.category_name}</strong> to:
        </p>
        <select
          value={toCategoryId}
          onChange={(e) => setToCategoryId(e.target.value)}
          style={{ width: "100%", marginBottom: 16 }}
        >
          <option value="">Select category…</option>
          {choices.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <button
          className="btn btn-primary"
          onClick={handleConfirm}
          disabled={!toCategoryId || saving}
        >
          {saving ? "Moving…" : "Move all"}
        </button>
      </div>
    </div>
  );
}


export default function Transactions() {
  const [searchParams] = useSearchParams();
  const { isOnline } = useOnline();

  const [transactions, setTransactions] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [filterCat, setFilterCat] = useState(searchParams.get("category_id") || "");
  const [filterStatus, setFilterStatus] = useState("");
  const [dateFrom, setDateFrom] = useState(searchParams.get("date_from") || "");
  const [dateTo, setDateTo]     = useState(searchParams.get("date_to")   || "");
  const [search, setSearch] = useState("");
  const [source, setSource] = useState("");
  const [sort, setSort] = useState("date_desc");
  const searchDebounceRef = useRef(null);

  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showDuplicates, setShowDuplicates] = useState(false);
  const [showClassify, setShowClassify] = useState(false);
  const [reimburseLinkingTxn, setReimburseLinkingTxn] = useState(null);
  const [reclassifyFrom, setReclassifyFrom] = useState(null);

  const [expandedId, setExpandedId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [assigningId, setAssigningId] = useState(null);
  const [unclassifiedCount, setUnclassifiedCount] = useState(0);

  const [pinnedIds, setPinnedIds] = useState(() => {
    try { return JSON.parse(localStorage.getItem("pinned_txn_ids") ?? "[]"); } catch { return []; }
  });

  function togglePin(id) {
    setPinnedIds((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      localStorage.setItem("pinned_txn_ids", JSON.stringify(next));
      return next;
    });
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function buildParams(p, overrides = {}) {
    const f = { filterCat, filterStatus, dateFrom, dateTo, search, source, sort, ...overrides };
    const params = { limit: PAGE_SIZE, offset: p * PAGE_SIZE };
    if (f.filterCat) params.category_id = parseInt(f.filterCat);
    if (f.filterStatus) params.status = f.filterStatus;
    if (f.dateFrom) params.date_from = f.dateFrom;
    if (f.dateTo) params.date_to = f.dateTo;
    if (f.search) params.q = f.search;
    if (f.source) params.source = f.source;
    if (f.sort && f.sort !== "date_desc") params.sort = f.sort;
    if (pinnedIds.length && (f.dateFrom || f.dateTo)) params.include_ids = pinnedIds.join(",");
    return params;
  }

  function fetchPage(p, overrides = {}) {
    setLoading(true);
    setError(null);
    api.getTransactions(buildParams(p, overrides))
      .then((data) => {
        setTransactions(data.transactions ?? data);
        setTotal(data.total ?? (data.transactions ?? data).length);
        setPage(p);
        setExpandedId(null);
        setEditingId(null);
      })
      .catch((e) => {
        if (!isOnline) return;
        setError(e.message);
      })
      .finally(() => setLoading(false));
  }

  function refreshUnclassifiedCount() {
    api.getUnclassifiedMerchants()
      .then((list) => setUnclassifiedCount(list.length))
      .catch(() => {});
  }

  useEffect(() => {
    Promise.all([api.getCategories(), api.getUnclassifiedMerchants()])
      .then(([cats, merchants]) => {
        setCategories(cats);
        setUnclassifiedCount(merchants.length);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchPage(0);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchPage(0);
  }, [filterCat, filterStatus, dateFrom, dateTo, source, sort, pinnedIds]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleSearchChange(e) {
    const val = e.target.value;
    setSearch(val);
    clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      fetchPage(0, { search: val });
    }, 250);
  }

  function handleSaved(updated) {
    setTransactions((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    setEditingId(null);
    setExpandedId(updated.id);
    refreshUnclassifiedCount();
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

  function handleAdded() {
    setShowAdd(false);
    fetchPage(0);
    refreshUnclassifiedCount();
  }

  async function handleAssignCategory(txn, categoryId) {
    setAssigningId(txn.id);
    try {
      const updated = await api.updateTransaction(txn.id, { category_id: categoryId });
      setTransactions((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      setExpandedId(null);
      refreshUnclassifiedCount();
    } catch {
    } finally {
      setAssigningId(null);
    }
  }

  function toggleRow(id) {
    if (editingId === id) return;
    setExpandedId((prev) => (prev === id ? null : id));
  }

  return (
    <>
      {!isOnline && <div className="offline-banner">📴 Offline — showing cached transactions</div>}

      {showDuplicates && (
        <DuplicatesModal
          onClose={() => setShowDuplicates(false)}
          onDeleted={() => fetchPage(page)}
        />
      )}

      {reimburseLinkingTxn && (
        <ReimbursePickerModal
          inflowTxn={reimburseLinkingTxn}
          onClose={() => setReimburseLinkingTxn(null)}
          onLinked={(updated) => {
            setTransactions((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
            setReimburseLinkingTxn(null);
          }}
        />
      )}

      {showImport && (
        <ImportModal
          onClose={() => setShowImport(false)}
          onImported={() => { fetchPage(0); refreshUnclassifiedCount(); }}
        />
      )}

      {showClassify && (
        <ClassifyModal
          categories={categories}
          onClose={() => setShowClassify(false)}
          onDone={() => { fetchPage(page); refreshUnclassifiedCount(); }}
        />
      )}

      {showAdd && (
        <AddModal
          categories={categories}
          onClose={() => setShowAdd(false)}
          onSaved={handleAdded}
        />
      )}

      {reclassifyFrom && (
        <ReclassifyModal
          txn={reclassifyFrom}
          categories={categories}
          onClose={() => setReclassifyFrom(null)}
          onDone={() => {
            setReclassifyFrom(null);
            setExpandedId(null);
            fetchPage(page);
            refreshUnclassifiedCount();
          }}
        />
      )}

      <div className="page">
        {loading && <div className="top-bar-loading" />}

        <div className="page-header">
          <h1>Transactions</h1>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setShowDuplicates(true)}>
              Duplicates
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setShowImport(true)}>
              Import CSV
            </button>
            {unclassifiedCount > 0 && (
              <button
                className="btn btn-ghost btn-sm"
                style={{ position: "relative", color: "var(--amber)", borderColor: "var(--amber)" }}
                onClick={() => setShowClassify(true)}
              >
                Classify
                <span style={{
                  position: "absolute", top: -6, right: -6,
                  background: "var(--amber)", color: "#000",
                  fontSize: 10, fontWeight: 700,
                  borderRadius: "999px", minWidth: 16, height: 16,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  padding: "0 4px",
                }}>{unclassifiedCount}</span>
              </button>
            )}
          </div>
        </div>

        <div style={{ position: "relative", marginBottom: 12 }}>
          <svg
            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", width: 15, height: 15, color: "var(--text-muted)", pointerEvents: "none" }}
          >
            <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            type="search"
            placeholder="Search merchant, notes, amount…"
            value={search}
            onChange={handleSearchChange}
            style={{ width: "100%", paddingLeft: 32, boxSizing: "border-box" }}
          />
        </div>

        <div className="filter-row" style={{ marginBottom: 12 }}>
          {STATUS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setFilterStatus(opt.value)}
              style={{
                padding: "7px 14px",
                borderRadius: 20,
                fontSize: 13,
                fontWeight: 600,
                border: `1.5px solid ${filterStatus === opt.value ? "var(--primary)" : "var(--border)"}`,
                background: filterStatus === opt.value ? "rgba(108,99,255,0.15)" : "transparent",
                color: filterStatus === opt.value ? "var(--primary)" : "var(--text-muted)",
                cursor: "pointer",
                whiteSpace: "nowrap",
                minHeight: 36,
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="filter-row" style={{ marginBottom: 12 }}>
          {[{ value: "", label: "All" }, { value: "credit", label: "Credit Card" }, { value: "venmo", label: "Venmo" }].map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setSource(opt.value)}
              style={{
                padding: "7px 14px",
                borderRadius: 20,
                fontSize: 13,
                fontWeight: 600,
                border: `1.5px solid ${source === opt.value ? "var(--primary)" : "var(--border)"}`,
                background: source === opt.value ? "rgba(108,99,255,0.15)" : "transparent",
                color: source === opt.value ? "var(--primary)" : "var(--text-muted)",
                cursor: "pointer",
                whiteSpace: "nowrap",
                minHeight: 36,
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="filter-bar">
          <select value={filterCat} onChange={(e) => setFilterCat(e.target.value)}>
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="date_desc">Newest first</option>
            <option value="date_asc">Oldest first</option>
            <option value="amount_desc">Amount (high→low)</option>
            <option value="amount_asc">Amount (low→high)</option>
            <option value="merchant_asc">Merchant (A–Z)</option>
          </select>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          {(filterCat || filterStatus || dateFrom || dateTo || search || source || sort !== "date_desc") && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setFilterCat(""); setFilterStatus(""); setDateFrom(""); setDateTo(""); setSearch(""); setSource(""); setSort("date_desc");
                clearTimeout(searchDebounceRef.current);
                fetchPage(0, { filterCat: "", filterStatus: "", dateFrom: "", dateTo: "", search: "", source: "", sort: "date_desc" });
              }}
            >
              Clear filters
            </button>
          )}
          {pinnedIds.length > 0 && (dateFrom || dateTo) && (
            <div style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              padding: "4px 10px", borderRadius: 20, fontSize: 12, fontWeight: 600,
              background: "rgba(108,99,255,0.15)", border: "1.5px solid var(--primary)",
              color: "var(--primary)",
            }}>
              {pinnedIds.length} pinned included
              <button
                onClick={() => { localStorage.setItem("pinned_txn_ids", "[]"); setPinnedIds([]); }}
                style={{ background: "none", border: "none", color: "var(--primary)", cursor: "pointer", padding: 0, fontSize: 14, lineHeight: 1 }}
                title="Clear pins"
              >×</button>
            </div>
          )}
        </div>

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
              {transactions.map((t, i) => {
                const month = t.transaction_at?.slice(0, 7) ?? "";
                const prevMonth = transactions[i - 1]?.transaction_at?.slice(0, 7) ?? "";
                const showHeader = month && month !== prevMonth;
                const headerLabel = showHeader
                  ? new Date(month + "-02").toLocaleDateString("en-US", { month: "long", year: "numeric" })
                  : null;
                return (
                <div key={t.id}>
                  {showHeader && (
                    <div style={{
                      padding: "10px 16px 4px",
                      fontSize: 11, fontWeight: 700, color: "var(--text-muted)",
                      textTransform: "uppercase", letterSpacing: "0.06em",
                      borderTop: i > 0 ? "1px solid var(--border)" : "none",
                    }}>
                      {headerLabel}
                    </div>
                  )}
                <div className="txn-row">
                  <div className="txn-row-main" onClick={() => toggleRow(t.id)}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="txn-merchant">
                        {t.merchant_raw || "Untitled"}
                        {t.notes?.startsWith("venmo:") && (
                          <span style={{ fontSize: 11, fontWeight: 500, color: "var(--text-secondary)", marginLeft: 6 }}>
                            · {venmoLabel(t.notes, t.direction)}
                          </span>
                        )}
                      </div>
                      <div className="txn-row-sub">
                        {fmtDate(t.transaction_at)}
                        {needsReview(t) ? (
                          <span style={{
                            marginLeft: 6,
                            fontSize: 10, fontWeight: 600,
                            color: "var(--amber)",
                            textTransform: "uppercase",
                            letterSpacing: "0.05em",
                          }}>· Needs Review</span>
                        ) : (
                          <span> · {t.category_name}</span>
                        )}
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3, flexShrink: 0 }}>
                      <span className={`txn-amount ${t.direction === "inflow" ? "text-green" : "text-red"}`}>
                        {fmtAmt(t)}
                      </span>
                      {t.direction === "inflow" && t.reimburses_id && (
                        <span style={{
                          fontSize: 10, fontWeight: 600, color: "var(--primary)",
                          border: "1px solid var(--primary)", borderRadius: 4,
                          padding: "1px 5px", lineHeight: 1.4,
                        }}>
                          Reimb
                        </span>
                      )}
                      {pinnedIds.includes(t.id) && (
                        <span style={{
                          fontSize: 10, fontWeight: 600, color: "var(--text-muted)",
                          border: "1px solid var(--border)", borderRadius: 4,
                          padding: "1px 5px", lineHeight: 1.4,
                        }}>
                          Pinned
                        </span>
                      )}
                      {t.direction === "outflow" && t.reimbursed_by_count > 0 && (() => {
                        const net = parseFloat(t.reimbursed_by_total) - parseFloat(t.amount);
                        return (
                          <span style={{ fontSize: 11, color: net >= 0 ? "var(--green)" : "var(--red)", fontWeight: 600 }}>
                            Net {net >= 0 ? "+" : "-"}${Math.abs(net).toFixed(2)}
                          </span>
                        );
                      })()}
                    </div>
                  </div>

                  {expandedId === t.id && editingId !== t.id && (
                    <div className="txn-expanded">
                      {needsReview(t) ? (
                        <>
                          <p className="field-label" style={{ marginBottom: 8 }}>Categorize</p>
                          <div className="cat-pills">
                            {categories.map((c) => (
                              <button
                                key={c.id}
                                className={`cat-pill${assigningId === t.id ? " saving" : ""}`}
                                onClick={() => handleAssignCategory(t, c.id)}
                              >
                                {c.name}
                              </button>
                            ))}
                          </div>
                          <div className="txn-expanded-actions" style={{ marginTop: 10 }}>
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => { setEditingId(t.id); setExpandedId(null); }}
                            >
                              Edit details
                            </button>
                            <button
                              className="btn btn-ghost btn-sm"
                              style={pinnedIds.includes(t.id) ? { color: "var(--primary)", borderColor: "var(--primary)" } : {}}
                              onClick={(e) => { e.stopPropagation(); togglePin(t.id); }}
                            >
                              {pinnedIds.includes(t.id) ? "Unpin" : "Pin"}
                            </button>
                            <button
                              className="btn btn-sm"
                              style={{ color: "var(--red)", border: "1px solid var(--red)", background: "transparent" }}
                              onClick={() => handleDelete(t.id)}
                            >
                              Delete
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <dl className="txn-meta">
                            {t.notes && !t.notes.startsWith("venmo") && (
                              <><dt className="txn-meta-key">Notes</dt><dd className="txn-meta-val">{t.notes}</dd></>
                            )}
                            <dt className="txn-meta-key">Type</dt>
                            <dd className="txn-meta-val">
                              {t.notes?.startsWith("venmo")
                                ? `Venmo · ${venmoLabel(t.notes, t.direction, true)}`
                                : t.direction === "inflow" ? "Credit" : "Debit"}
                            </dd>
                            {t.reimburses_id && (
                              <>
                                <dt className="txn-meta-key">Reimburses</dt>
                                <dd className="txn-meta-val">
                                  {t.reimburses_merchant || "expense"} · -${parseFloat(t.reimburses_amount).toFixed(2)}
                                  {t.reimburses_date ? ` (${fmtDate(t.reimburses_date)})` : ""}
                                </dd>
                              </>
                            )}
                            {t.reimbursed_by_count > 0 && (() => {
                              const net = parseFloat(t.reimbursed_by_total) - parseFloat(t.amount);
                              return (
                                <>
                                  <dt className="txn-meta-key">Reimbursed by</dt>
                                  <dd className="txn-meta-val" style={{ color: "var(--green)" }}>
                                    +${parseFloat(t.reimbursed_by_total).toFixed(2)}
                                    {t.reimbursed_by_count > 1 ? ` · ${t.reimbursed_by_count} payments` : ""}
                                  </dd>
                                  <dt className="txn-meta-key">Net cost</dt>
                                  <dd className="txn-meta-val" style={{ color: net >= 0 ? "var(--green)" : "var(--red)", fontWeight: 600 }}>
                                    {net >= 0 ? "+" : "-"}${Math.abs(net).toFixed(2)}
                                  </dd>
                                </>
                              );
                            })()}
                          </dl>
                          <div className="txn-expanded-actions">
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => { setEditingId(t.id); setExpandedId(null); }}
                            >
                              Edit
                            </button>
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => setReclassifyFrom(t)}
                            >
                              Reclassify all
                            </button>
                            <button
                              className="btn btn-ghost btn-sm"
                              style={pinnedIds.includes(t.id) ? { color: "var(--primary)", borderColor: "var(--primary)" } : {}}
                              onClick={(e) => { e.stopPropagation(); togglePin(t.id); }}
                            >
                              {pinnedIds.includes(t.id) ? "Unpin" : "Pin"}
                            </button>
                            {t.direction === "inflow" && (
                              <button
                                className="btn btn-ghost btn-sm"
                                onClick={(e) => { e.stopPropagation(); setReimburseLinkingTxn(t); }}
                              >
                                {t.reimburses_id ? "Change Link" : "Link Reimbursement"}
                              </button>
                            )}
                            <button
                              className="btn btn-sm"
                              style={{ color: "var(--red)", border: "1px solid var(--red)", background: "transparent" }}
                              onClick={() => handleDelete(t.id)}
                            >
                              Delete
                            </button>
                          </div>
                        </>
                      )}
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
                </div>
                );
              })}
            </div>

            <div className="pagination">
              <button onClick={() => fetchPage(page - 1)} disabled={page === 0 || loading}>← Prev</button>
              <span>{page + 1} / {totalPages}</span>
              <button onClick={() => fetchPage(page + 1)} disabled={page >= totalPages - 1 || loading}>Next →</button>
            </div>
          </>
        )}
      </div>

      <button className="fab" onClick={() => setShowAdd(true)} aria-label="Add transaction" title="Add transaction">
        +
      </button>
    </>
  );
}
