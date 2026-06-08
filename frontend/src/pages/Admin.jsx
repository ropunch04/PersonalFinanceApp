import { useEffect, useState } from "react";
import { api } from "../api";

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, `${m}m`].filter(Boolean).join(" ");
}

function UserRow({ user, currentUserId, onUpdated, onDeleted }) {
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
    <>
      <tr>
        <td>{user.username}</td>
        <td>{user.email}</td>
        <td>{user.is_admin ? "Admin" : "User"}</td>
        <td>{user.last_synced_at ? new Date(user.last_synced_at).toLocaleDateString() : "—"}</td>
        <td>{user.gmail_configured ? "Yes" : "No"}</td>
        <td className="user-actions">
          <button onClick={() => setShowReset((v) => !v)} disabled={busy}>
            Reset PW
          </button>
          {!isSelf && (
            <button onClick={handleToggleAdmin} disabled={busy}>
              {user.is_admin ? "Revoke Admin" : "Make Admin"}
            </button>
          )}
          <button onClick={handleSync} disabled={busy || !user.gmail_configured}>
            Sync
          </button>
          {!isSelf && (
            <button className="delete-btn" onClick={handleDelete} disabled={busy}>
              Delete
            </button>
          )}
        </td>
      </tr>
      {showReset && (
        <tr>
          <td colSpan={6}>
            <form className="inline-form" onSubmit={handleResetPassword}>
              <input
                type="password"
                placeholder="New password"
                value={resetPw}
                onChange={(e) => setResetPw(e.target.value)}
                required
              />
              <button type="submit" disabled={busy}>Save</button>
              <button type="button" onClick={() => setShowReset(false)}>Cancel</button>
            </form>
          </td>
        </tr>
      )}
      {syncMsg && (
        <tr>
          <td colSpan={6}>
            <span className={syncMsg.startsWith("Error") ? "error" : "success"}>{syncMsg}</span>
          </td>
        </tr>
      )}
    </>
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
    <form className="create-user-form" onSubmit={handleSubmit}>
      <h3>Create User</h3>
      <div className="form-row">
        <input name="username" placeholder="Username" value={form.username} onChange={handleChange} required />
        <input name="email" type="email" placeholder="Email" value={form.email} onChange={handleChange} required />
        <input name="password" type="password" placeholder="Password" value={form.password} onChange={handleChange} required />
        <label className="checkbox-label">
          <input name="is_admin" type="checkbox" checked={form.is_admin} onChange={handleChange} />
          Admin
        </label>
        <button type="submit" disabled={busy}>{busy ? "Creating..." : "Create"}</button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

export default function Admin() {
  const [users, setUsers] = useState([]);
  const [system, setSystem] = useState(null);
  const [logs, setLogs] = useState(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Read current user id from token payload
  const token = localStorage.getItem("finance_token");
  let currentUserId = null;
  try {
    currentUserId = JSON.parse(atob(token.split(".")[1])).sub;
  } catch {
    // token missing or malformed — currentUserId stays null
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

  if (loading) return <p>Loading...</p>;
  if (error) return <p className="error">{error}</p>;

  return (
    <div className="admin-page">
      <h1>Admin</h1>

      {system && (
        <section className="admin-section">
          <h2>System</h2>
          <div className="system-grid">
            <span>Uptime</span><span>{formatUptime(system.uptime_seconds)}</span>
            <span>Users</span><span>{system.user_count}</span>
            <span>Platform</span><span>{system.platform}</span>
            <span>Python</span><span>{system.python_version.split(" ")[0]}</span>
          </div>
        </section>
      )}

      <section className="admin-section">
        <h2>Users</h2>
        <CreateUserForm
          onCreated={(u) => setUsers((prev) => [...prev, u])}
        />
        <table className="admin-table">
          <thead>
            <tr>
              <th>Username</th>
              <th>Email</th>
              <th>Role</th>
              <th>Last Synced</th>
              <th>Gmail</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
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
          </tbody>
        </table>
      </section>

      <section className="admin-section">
        <h2>Logs</h2>
        <div className="logs-header">
          <button onClick={loadLogs} disabled={logsLoading}>
            {logsLoading ? "Loading..." : logs ? "Refresh" : "Load Logs"}
          </button>
          {logs && <span>{logs.total_lines} total lines</span>}
        </div>
        {logs && (
          <pre className="log-box">
            {logs.lines.length > 0 ? logs.lines.join("\n") : "No log entries."}
          </pre>
        )}
      </section>
    </div>
  );
}
