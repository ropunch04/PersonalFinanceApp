import { useState } from "react";
import { api } from "../api";

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

  return (
    <div className="import-page">
      <h1>Import Transactions</h1>

      <form className="import-form" onSubmit={handleSubmit}>
        <label>
          Source
          <select value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
            <option value="capitalone">Capital One</option>
            <option value="venmo">Venmo</option>
          </select>
        </label>

        <label>
          CSV Files
          <input
            type="file"
            accept=".csv"
            multiple
            onChange={(e) => setFiles(Array.from(e.target.files))}
            required
          />
        </label>

        {error && <p className="error">{error}</p>}

        <button type="submit" disabled={submitting || files.length === 0}>
          {submitting ? "Importing..." : "Import"}
        </button>
      </form>

      {result && (
        <div className="import-result">
          <p>
            Imported <strong>{result.imported}</strong> transaction
            {result.imported !== 1 ? "s" : ""}
            {result.duplicates_skipped > 0
              ? `, ${result.duplicates_skipped} duplicate${result.duplicates_skipped !== 1 ? "s" : ""} skipped`
              : ""}
            .
          </p>
          {result.errors?.length > 0 && (
            <div className="import-errors">
              <p>Row errors:</p>
              <ul>
                {result.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
