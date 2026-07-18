import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";

function EyeIcon({ open }) {
  return open ? (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function PwField({ label, value, onChange, autoComplete, placeholder }) {
  const [show, setShow] = useState(false);
  return (
    <div className="field">
      <label className="field-label">{label}</label>
      <div className="input-wrap">
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={onChange}
          autoComplete={autoComplete}
          placeholder={placeholder}
        />
        <button type="button" className="toggle-pw" onClick={() => setShow((v) => !v)} tabIndex={-1}>
          <EyeIcon open={show} />
        </button>
      </div>
    </div>
  );
}

export default function Profile({ setup = false }) {
  const { logout, user: authUser } = useAuth();
  const navigate = useNavigate();

  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [budgets, setBudgets] = useState([]);
  const [savingBudget, setSavingBudget] = useState(false);
  const [budgetMsg, setBudgetMsg] = useState(null);

  const [editingCategories, setEditingCategories] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [addingCategory, setAddingCategory] = useState(false);
  const [categoryMsg, setCategoryMsg] = useState(null);
  const [deletingCategoryId, setDeletingCategoryId] = useState(null);
  const [movingCategory, setMovingCategory] = useState(false);

  const [gmailAddress, setGmailAddress] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [savingGmail, setSavingGmail] = useState(false);
  const [gmailMsg, setGmailMsg] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);

  const [showChangePw, setShowChangePw] = useState(false);
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [changingPw, setChangingPw] = useState(false);
  const [pwMsg, setPwMsg] = useState(null);

  useEffect(() => {
    api.getProfile()
      .then((data) => {
        setProfile(data);
        setBudgets(data.budgets.map((b) => ({ ...b })));
        setGmailAddress(data.gmail_address ?? "");
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  async function handleSaveBudget(e) {
    e.preventDefault();
    setSavingBudget(true);
    setBudgetMsg(null);
    try {
      const updated = await api.updateProfile({
        budgets: budgets.map((b) => ({
          category_id: b.category_id,
          amount: parseFloat(b.amount),
          period: b.period ?? "monthly",
          fold_into_misc: !!b.fold_into_misc,
        })),
      });
      setProfile(updated);
      setBudgetMsg("Saved.");
      if (setup) navigate("/");
    } catch (err) {
      setBudgetMsg(`Error: ${err.message}`);
    } finally {
      setSavingBudget(false);
    }
  }

  async function handleSetMisc(categoryId, isMisc) {
    setCategoryMsg(null);
    try {
      await api.setMiscCategory(categoryId, isMisc);
      setBudgets((prev) =>
        prev.map((b) => ({
          ...b,
          is_misc: b.category_id === categoryId ? isMisc : isMisc ? false : b.is_misc,
        }))
      );
    } catch (err) {
      setCategoryMsg(`Error: ${err.message}`);
    }
  }

  async function handleAddCategory(e) {
    e.preventDefault();
    const name = newCategoryName.trim();
    if (!name) return;
    setAddingCategory(true);
    setCategoryMsg(null);
    try {
      const category = await api.createCategory(name);
      setBudgets((prev) => [
        ...prev,
        {
          category_id: category.id,
          category_name: category.name,
          amount: 0,
          period: "monthly",
          fold_into_misc: false,
          is_misc: false,
        },
      ]);
      setNewCategoryName("");
    } catch (err) {
      setCategoryMsg(`Error: ${err.message}`);
    } finally {
      setAddingCategory(false);
    }
  }

  async function handleDeleteCategory(categoryId) {
    setDeletingCategoryId(categoryId);
    setCategoryMsg(null);
    try {
      await api.deleteCategory(categoryId);
      setBudgets((prev) => prev.filter((b) => b.category_id !== categoryId));
    } catch (err) {
      setCategoryMsg(`Error: ${err.message}`);
    } finally {
      setDeletingCategoryId(null);
    }
  }

  async function handleMoveCategory(index, direction) {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= budgets.length || movingCategory) return;

    const reordered = [...budgets];
    [reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];
    setBudgets(reordered);
    setMovingCategory(true);
    setCategoryMsg(null);
    try {
      await api.reorderCategories(reordered.map((b) => b.category_id));
    } catch (err) {
      setBudgets(budgets);
      setCategoryMsg(`Error: ${err.message}`);
    } finally {
      setMovingCategory(false);
    }
  }

  async function handleSaveGmail(e) {
    e.preventDefault();
    setSavingGmail(true);
    setGmailMsg(null);
    try {
      await api.updateGmail({ gmail_address: gmailAddress, app_password: appPassword });
      setAppPassword("");
      setProfile((p) => ({ ...p, gmail_configured: true, gmail_address: gmailAddress }));
      setGmailMsg("Gmail credentials saved.");
    } catch (err) {
      setGmailMsg(`Error: ${err.message}`);
    } finally {
      setSavingGmail(false);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const result = await api.sync();
      setSyncMsg(`Synced: ${result.imported ?? 0} imported, ${result.duplicates_skipped ?? 0} skipped.`);
    } catch (err) {
      setSyncMsg(`Error: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  }

  async function handleChangePassword(e) {
    e.preventDefault();
    setPwMsg(null);
    if (newPw !== confirmPw) {
      setPwMsg("Error: New passwords do not match");
      return;
    }
    setChangingPw(true);
    try {
      await api.changePassword(currentPw, newPw);
      setCurrentPw("");
      setNewPw("");
      setConfirmPw("");
      setPwMsg("Password changed successfully.");
    } catch (err) {
      setPwMsg(`Error: ${err.message}`);
    } finally {
      setChangingPw(false);
    }
  }

  function handleSignOut() {
    api.logout();
    logout();
    navigate("/login");
  }

  if (loading) return <div className="top-bar-loading" />;
  if (error) return (
    <div className="page">
      <div className="page-header"><h1>Profile</h1></div>
      <div className="msg msg-error">{error}</div>
    </div>
  );

  return (
    <div className="page">
      <div className="page-header">
        <h1>{setup ? "Set Up Profile" : "Profile"}</h1>
        {setup && (
          <button className="btn btn-ghost btn-sm" onClick={() => navigate("/")}>
            Skip
          </button>
        )}
      </div>

      <div className="profile-block">
        <p className="section-label">Budget</p>
        <div className="card">
          <form onSubmit={handleSaveBudget}>
            <div className="form-stack">
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <p className="field-label" style={{ marginBottom: 0 }}>Category Budgets</p>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      setEditingCategories((v) => !v);
                      setCategoryMsg(null);
                      setNewCategoryName("");
                    }}
                  >
                    {editingCategories ? "Done" : "Edit"}
                  </button>
                </div>

                {editingCategories && (
                  <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: -4, marginBottom: 10 }}>
                    Pick one category as your Misc/Flex bucket. Spending that goes over any other
                    category's budget — plus any category you fold in — counts against Misc instead.
                  </p>
                )}
                {budgets.length > 0 && (
                  <div className="budget-list">
                    {budgets.map((b, i) => (
                      <div className="budget-row" key={b.category_id} style={{ alignItems: "center", gap: 8 }}>
                        {editingCategories && (
                          <div style={{ display: "flex", flexDirection: "column", gap: 2, flexShrink: 0 }}>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => handleMoveCategory(i, -1)}
                              disabled={i === 0 || movingCategory}
                              title="Move up"
                              style={{ padding: "0 6px", height: 18, minHeight: 18, fontSize: 10, lineHeight: 1 }}
                            >
                              ▲
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => handleMoveCategory(i, 1)}
                              disabled={i === budgets.length - 1 || movingCategory}
                              title="Move down"
                              style={{ padding: "0 6px", height: 18, minHeight: 18, fontSize: 10, lineHeight: 1 }}
                            >
                              ▼
                            </button>
                          </div>
                        )}
                        <span className="budget-cat">
                          {b.category_name}
                          {b.is_misc && (
                            <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: "var(--primary)" }}>
                              MISC
                            </span>
                          )}
                          {!b.is_misc && b.fold_into_misc && (
                            <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: "var(--text-muted)" }}>
                              → MISC
                            </span>
                          )}
                        </span>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={b.amount}
                          disabled={!b.is_misc && b.fold_into_misc}
                          onChange={(e) =>
                            setBudgets((prev) =>
                              prev.map((item, idx) =>
                                idx === i ? { ...item, amount: e.target.value } : item
                              )
                            )
                          }
                          placeholder="0.00"
                        />
                        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                          {["monthly", "yearly"].map((p) => (
                            <button
                              key={p}
                              type="button"
                              disabled={!b.is_misc && b.fold_into_misc}
                              onClick={() =>
                                setBudgets((prev) =>
                                  prev.map((item, idx) =>
                                    idx === i ? { ...item, period: p } : item
                                  )
                                )
                              }
                              style={{
                                padding: "3px 8px",
                                fontSize: 11,
                                fontWeight: 600,
                                borderRadius: 6,
                                border: `1.5px solid ${(b.period ?? "monthly") === p ? "var(--primary)" : "var(--border)"}`,
                                background: (b.period ?? "monthly") === p ? "rgba(108,99,255,0.15)" : "transparent",
                                color: (b.period ?? "monthly") === p ? "var(--primary)" : "var(--text-muted)",
                                cursor: "pointer",
                                minWidth: "unset",
                                minHeight: "unset",
                              }}
                            >
                              {p === "monthly" ? "Mo" : "Yr"}
                            </button>
                          ))}
                        </div>
                        {editingCategories && (
                          <div style={{ display: "flex", flexDirection: "column", gap: 2, flexShrink: 0 }}>
                            <button
                              type="button"
                              onClick={() => handleSetMisc(b.category_id, !b.is_misc)}
                              title="Use as the Misc/Flex bucket"
                              style={{
                                padding: "3px 8px",
                                fontSize: 10,
                                fontWeight: 600,
                                borderRadius: 6,
                                border: `1.5px solid ${b.is_misc ? "var(--primary)" : "var(--border)"}`,
                                background: b.is_misc ? "rgba(108,99,255,0.15)" : "transparent",
                                color: b.is_misc ? "var(--primary)" : "var(--text-muted)",
                                cursor: "pointer",
                                minWidth: "unset",
                                minHeight: "unset",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {b.is_misc ? "★ Misc" : "Set Misc"}
                            </button>
                            {!b.is_misc && (
                              <label
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 4,
                                  fontSize: 10,
                                  color: "var(--text-muted)",
                                  cursor: budgets.some((x) => x.is_misc) ? "pointer" : "not-allowed",
                                  opacity: budgets.some((x) => x.is_misc) ? 1 : 0.5,
                                }}
                              >
                                <input
                                  type="checkbox"
                                  checked={!!b.fold_into_misc}
                                  disabled={!budgets.some((x) => x.is_misc)}
                                  onChange={(e) =>
                                    setBudgets((prev) =>
                                      prev.map((item, idx) =>
                                        idx === i ? { ...item, fold_into_misc: e.target.checked } : item
                                      )
                                    )
                                  }
                                  style={{ width: 12, height: 12 }}
                                />
                                Fold into Misc
                              </label>
                            )}
                          </div>
                        )}
                        {editingCategories && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => handleDeleteCategory(b.category_id)}
                            disabled={deletingCategoryId === b.category_id}
                            title="Remove category"
                            style={{ flexShrink: 0, padding: "0 10px" }}
                          >
                            {deletingCategoryId === b.category_id ? "…" : "Remove"}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {editingCategories && (
                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <input
                      type="text"
                      value={newCategoryName}
                      onChange={(e) => setNewCategoryName(e.target.value)}
                      placeholder="New category name"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleAddCategory(e);
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={handleAddCategory}
                      disabled={addingCategory || !newCategoryName.trim()}
                      style={{ flexShrink: 0 }}
                    >
                      {addingCategory ? "Adding…" : "+ Add Category"}
                    </button>
                  </div>
                )}

                {categoryMsg && (
                  <div className={`msg ${categoryMsg.startsWith("Error") ? "msg-error" : "msg-success"}`} style={{ marginTop: 8 }}>
                    {categoryMsg}
                  </div>
                )}
              </div>

              {budgetMsg && (
                <div className={`msg ${budgetMsg.startsWith("Error") ? "msg-error" : "msg-success"}`}>
                  {budgetMsg}
                </div>
              )}
              <button className="btn btn-primary" type="submit" disabled={savingBudget}>
                {savingBudget ? "Saving…" : "Save Budget"}
              </button>
            </div>
          </form>
        </div>
      </div>

      <div className="profile-block">
        <p className="section-label">Gmail Sync</p>
        <div className="card">
          {profile.last_synced_at && (
            <p className="last-synced">
              Last synced: {new Date(profile.last_synced_at).toLocaleString()}
            </p>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ marginBottom: 14, width: "100%", justifyContent: "center" }}
            onClick={() => navigate("/gmail-setup")}
          >
            How to set this up →
          </button>
          <form onSubmit={handleSaveGmail}>
            <div className="form-stack">
              <div className="field">
                <label className="field-label">Gmail Address</label>
                <input
                  type="text"
                  value={gmailAddress}
                  onChange={(e) => setGmailAddress(e.target.value)}
                  placeholder="you@gmail.com"
                  autoComplete="off"
                />
              </div>
              <PwField
                label="App Password"
                value={appPassword}
                onChange={(e) => setAppPassword(e.target.value)}
                autoComplete="new-password"
                placeholder={profile.gmail_configured ? "••••••••••••••••" : ""}
              />
              {gmailMsg && (
                <div className={`msg ${gmailMsg.startsWith("Error") ? "msg-error" : "msg-success"}`}>
                  {gmailMsg}
                </div>
              )}
              <button className="btn btn-primary" type="submit" disabled={savingGmail}>
                {savingGmail ? "Saving…" : "Save Gmail"}
              </button>
            </div>
          </form>

          <div className="divider" />

          <button
            className="btn btn-secondary"
            style={{ width: "100%" }}
            onClick={handleSync}
            disabled={syncing || !profile.gmail_configured}
            type="button"
          >
            {syncing ? "Syncing…" : "Sync Now"}
          </button>
          {syncMsg && (
            <div className={`msg ${syncMsg.startsWith("Error") ? "msg-error" : "msg-success"}`} style={{ marginTop: 10 }}>
              {syncMsg}
            </div>
          )}
        </div>
      </div>

      <div className="profile-block">
        <p className="section-label">Account</p>
        <div className="card">
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text)" }}>
              {authUser?.username}
            </div>
            {authUser?.email && (
              <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 2 }}>
                {authUser.email}
              </div>
            )}
            {authUser?.is_admin && (
              <div style={{ fontSize: 11, color: "var(--primary)", fontWeight: 500, marginTop: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Admin
              </div>
            )}
          </div>

          <div className="divider" style={{ margin: "0 0 16px" }} />

          <button
            className="btn btn-ghost"
            type="button"
            style={{ width: "100%", marginBottom: showChangePw ? 16 : 0 }}
            onClick={() => { setShowChangePw((v) => !v); setPwMsg(null); }}
          >
            {showChangePw ? "Cancel" : "Change Password"}
          </button>

          {showChangePw && (
            <form onSubmit={handleChangePassword}>
              <div className="form-stack">
                <PwField
                  label="Current Password"
                  value={currentPw}
                  onChange={(e) => setCurrentPw(e.target.value)}
                  autoComplete="current-password"
                />
                <PwField
                  label="New Password"
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  autoComplete="new-password"
                />
                <PwField
                  label="Confirm New Password"
                  value={confirmPw}
                  onChange={(e) => setConfirmPw(e.target.value)}
                  autoComplete="new-password"
                />
                {pwMsg && (
                  <div className={`msg ${pwMsg.startsWith("Error") ? "msg-error" : "msg-success"}`}>
                    {pwMsg}
                  </div>
                )}
                <button className="btn btn-primary" type="submit" disabled={changingPw}>
                  {changingPw ? "Changing…" : "Change Password"}
                </button>
              </div>
            </form>
          )}

          <div className="divider" />

          <button className="btn btn-destructive" type="button" onClick={handleSignOut}>
            Sign Out
          </button>
        </div>
      </div>
    </div>
  );
}
