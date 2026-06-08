import { useState } from "react";
import { api } from "../api";

const SOURCE_TYPES = [
  { value: "capitalone", label: "Capital One" },
  { value: "venmo", label: "Venmo" },
];

export default function Import() {
  const [sourceType, setSourceType] = useState("capitalone");
  const [files, setFiles] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (files.length === 0) return;
    setSubmitting(true);
    setResult(null);
    setError(null);
    try {
      const data = await api.importTransactions(sourceType, files);
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  function handleFileDrop(e) {
    e.preventDefault();
    const dropped = Array.from(e.dataTransfer.files).filter((f) => f.name.endsWith(".csv"));
    if (dropped.length) setFiles(dropped);
  }

  return (
    <div className="page">
      <div className="page-header"><h1>Import</h1></div>

      {/* Source type segmented control */}
      <div className="segmented">
        {SOURCE_TYPES.map((s) => (
          <button
            key={s.value}
            type="button"
            className={sourceType === s.value ? "seg-active" : ""}
            onClick={() => setSourceType(s.value)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit}>
        {/* Drop zone */}
        <div
          className={`drop-zone${files.length > 0 ? " has-files" : ""}`}
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleFileDrop}
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
          {files.length === 0 && <div className="drop-zone-hint">Supports Capital One and Venmo exports</div>}
        </div>

        {error && <div className="msg msg-error" style={{ marginBottom: 12 }}>{error}</div>}

        <button
          className="btn btn-primary"
          type="submit"
          disabled={submitting || files.length === 0}
        >
          {submitting ? "Importing…" : "Import"}
        </button>
      </form>

      {result && (
        <div className="import-result" style={{ marginTop: 20 }}>
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
          {result.errors?.length > 0 && (
            <div className="import-errors">
              {result.errors.map((e, i) => (
                <div key={i} className="import-error-item">{e}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
