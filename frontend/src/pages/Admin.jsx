import { useEffect, useState } from "react";
import { api } from "../api";

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, `${m}m`].filter(Boolean).join(" ");
}

function UserRow({ user, currentUserId, onUpdated, onDeleted }) {
  const [expanded, setExpanded] = useState(false);
  const [resetPw, setResetPw] = useState("");
  const [showReset, setShowReset] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleToggleAdmin() {
    setBusy(true);
    try {
      const updated = await api.admin.updateUser(user.id, { is_admin: !user.is_admin });
      onUpdated({ ...user, ...updated });
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleResetPassword(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.admin.resetPassword(user.id, resetPw);
      setResetPw("");
      setShowReset(false);
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete user "${user.username}"? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await api.admin.deleteUser(user.id);
      onDeleted(user.id);
    } catch (e) {
      alert(e.message);
      setBusy(false);
    }
  }

  async function handleSync() {
    setBusy(true);
    setSyncMsg(null);
    try {
      const result = await api.admin.syncUser(user.id);
      setSyncMsg(`Imported ${result.imported ?? 0}, skipped ${result.duplicates_skipped ?? 0}`);
    } catch (e) {
      setSyncMsg(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  const isSelf = user.id === currentUserId;

  return (
    <div className="admin-user-row">
      <div className="admin-user-top">
        <div>
          <div className="admin-user-name">
            {user.username}
            {user.is_admin && <span className="admin-badge" style={{ marginLeft: 6 }}>Admin</span>}
          </div>
          <div className="admin-user-meta">{user.email || "—"}</div>
        </div>
        <div className="admin-user-actions">
          <button className="btn-icon" title="Expand" onClick={() => setExpanded((v) => !v)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              {expanded ? <polyline points="18 15 12 9 6 15" /> : <polyline points="6 9 12 15 18 9" />}
            </svg>
          </button>
          {!isSelf && (
            <button className="btn-icon danger" title="Delete user" onClick={handleDelete} disabled={busy}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14H6L5 6" />
                <path d="M10 11v6M14 11v6" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="admin-user-expanded">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {!isSelf && (
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={user.is_admin}
                  onChange={handleToggleAdmin}
                  disabled={busy}
                />
                Admin
              </label>
            )}
            <button
              className="btn btn-ghost btn-sm"
              onClick={handleSync}
              disabled={busy || !user.gmail_configured}
            >
              Sync Gmail
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setShowReset((v) => !v)}
            >
              {showReset ? "Cancel" : "Reset PW"}
            </button>
          </div>

          {syncMsg && (
            <div className={`msg ${syncMsg.startsWith("Error") ? "msg-error" : "msg-success"}`}>
              {syncMsg}
            </div>
          )}

          {showReset && (
            <form className="inline-form" onSubmit={handleResetPassword}>
              <input
                type="password"
                placeholder="New password (min 8 chars)"
                value={resetPw}
                onChange={(e) => setResetPw(e.target.value)}
                required
                minLength={8}
              />
              <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>Save</button>
            </form>
          )}

          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            Gmail: {user.gmail_configured ? "configured" : "not set"} ·
            Last synced: {user.last_synced_at ? new Date(user.last_synced_at).toLocaleDateString() : "never"}
          </div>
        </div>
      )}
    </div>
  );
}

function CreateUserForm({ onCreated }) {
  const [form, setForm] = useState({ username: "", email: "", password: "", is_admin: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  function handleChange(e) {
    const { name, value, type, checked } = e.target;
    setForm((f) => ({ ...f, [name]: type === "checkbox" ? checked : value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await api.admin.createUser(form);
      onCreated(user);
      setForm({ username: "", email: "", password: "", is_admin: false });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="create-user-form">
      <h3>Create User</h3>
      <form onSubmit={handleSubmit}>
        <div className="form-stack">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <input name="username" placeholder="Username" value={form.username} onChange={handleChange} required autoComplete="off" />
            <input name="email" type="text" placeholder="Email" value={form.email} onChange={handleChange} required autoComplete="off" />
          </div>
          <input name="password" type="password" placeholder="Password (min 8 chars)" value={form.password} onChange={handleChange} required minLength={8} autoComplete="new-password" />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <label className="checkbox-label">
              <input name="is_admin" type="checkbox" checked={form.is_admin} onChange={handleChange} />
              Admin
            </label>
            <button className="btn btn-secondary btn-sm" type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create"}
            </button>
          </div>
          {error && <div className="msg msg-error">{error}</div>}
        </div>
      </form>
    </div>
  );
}

export default function Admin() {
  const [users, setUsers] = useState([]);
  const [system, setSystem] = useState(null);
  const [logs, setLogs] = useState(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const token = localStorage.getItem("finance_token");
  let currentUserId = null;
  try {
    currentUserId = JSON.parse(atob(token.split(".")[1])).sub;
  } catch {
  }

  useEffect(() => {
    Promise.all([api.admin.listUsers(), api.admin.getSystem()])
      .then(([u, s]) => { setUsers(u); setSystem(s); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  async function loadLogs() {
    setLogsLoading(true);
    try {
      const data = await api.admin.getLogs(100);
      setLogs(data);
    } catch (e) {
      setLogs({ lines: [`Error: ${e.message}`], total_lines: 0 });
    } finally {
      setLogsLoading(false);
    }
  }

  if (loading) return <div className="top-bar-loading" />;
  if (error) return (
    <div className="page">
      <div className="page-header"><h1>Admin</h1></div>
      <div className="msg msg-error">{error}</div>
    </div>
  );

  return (
    <div className="page">
      <div className="page-header"><h1>Admin</h1></div>

      {system && (
        <div className="admin-section">
          <p className="section-label">System</p>
          <div className="card">
            <dl className="system-grid">
              <dt>Uptime</dt><dd>{formatUptime(system.uptime_seconds)}</dd>
              <dt>Users</dt><dd>{system.user_count}</dd>
              <dt>Platform</dt><dd>{system.platform}</dd>
              <dt>Python</dt><dd>{system.python_version.split(" ")[0]}</dd>
            </dl>
          </div>
        </div>
      )}

      <div className="admin-section">
        <p className="section-label">Users</p>
        <CreateUserForm onCreated={(u) => setUsers((prev) => [...prev, u])} />
        <div className="card admin-user-list">
          {users.map((u) => (
            <UserRow
              key={u.id}
              user={u}
              currentUserId={currentUserId}
              onUpdated={(updated) =>
                setUsers((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))
              }
              onDeleted={(id) => setUsers((prev) => prev.filter((x) => x.id !== id))}
            />
          ))}
        </div>
      </div>

      <div className="admin-section">
        <p className="section-label">Logs</p>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
          <button className="btn btn-secondary btn-sm" onClick={loadLogs} disabled={logsLoading}>
            {logsLoading ? "Loading…" : logs ? "Refresh" : "Load Logs"}
          </button>
          {logs && <span className="text-muted" style={{ fontSize: 12 }}>{logs.total_lines} total lines</span>}
        </div>
        {logs && (
          <div className="log-box">
            {logs.lines.length > 0 ? logs.lines.join("\n") : "No log entries."}
          </div>
        )}
      </div>
    </div>
  );
}
