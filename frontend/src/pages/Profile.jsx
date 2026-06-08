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

export default function Profile() {
  const { logout } = useAuth();
  const navigate = useNavigate();

  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Budget state
  const [income, setIncome] = useState("");
  const [savingsTarget, setSavingsTarget] = useState("");
  const [budgets, setBudgets] = useState([]);
  const [savingBudget, setSavingBudget] = useState(false);
  const [budgetMsg, setBudgetMsg] = useState(null);

  // Gmail state
  const [gmailAddress, setGmailAddress] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [savingGmail, setSavingGmail] = useState(false);
  const [gmailMsg, setGmailMsg] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);

  // Password state
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [changingPw, setChangingPw] = useState(false);
  const [pwMsg, setPwMsg] = useState(null);

  useEffect(() => {
    api.getProfile()
      .then((data) => {
        setProfile(data);
        setIncome(data.monthly_income ?? "");
        setSavingsTarget(data.savings_target ?? "");
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
        monthly_income: parseFloat(income),
        savings_target: parseFloat(savingsTarget),
        budgets: budgets.map((b) => ({
          category_id: b.category_id,
          amount: parseFloat(b.amount),
        })),
      });
      setProfile(updated);
      setBudgetMsg("Saved.");
    } catch (err) {
      setBudgetMsg(`Error: ${err.message}`);
    } finally {
      setSavingBudget(false);
    }
  }

  async function handleSaveGmail(e) {
    e.preventDefault();
    setSavingGmail(true);
    setGmailMsg(null);
    try {
      await api.updateGmail({ gmail_address: gmailAddress, app_password: appPassword });
      setAppPassword("");
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
      <div className="page-header"><h1>Profile</h1></div>

      {/* BUDGET */}
      <div className="profile-block">
        <p className="section-label">Budget</p>
        <div className="card">
          <form onSubmit={handleSaveBudget}>
            <div className="form-stack">
              <div className="field">
                <label className="field-label">Monthly Income</label>
                <input
                  type="number"
                  value={income}
                  onChange={(e) => setIncome(e.target.value)}
                  step="0.01"
                  min="0"
                  placeholder="0.00"
                />
              </div>
              <div className="field">
                <label className="field-label">Savings Target</label>
                <input
                  type="number"
                  value={savingsTarget}
                  onChange={(e) => setSavingsTarget(e.target.value)}
                  step="0.01"
                  min="0"
                  placeholder="0.00"
                />
              </div>

              {budgets.length > 0 && (
                <div>
                  <p className="field-label" style={{ marginBottom: 8 }}>Category Budgets</p>
                  <div className="budget-list">
                    {budgets.map((b, i) => (
                      <div className="budget-row" key={b.category_id}>
                        <span className="budget-cat">{b.category_name}</span>
                        <input
                          type="number"
                          value={b.amount}
                          onChange={(e) =>
                            setBudgets((prev) =>
                              prev.map((item, idx) =>
                                idx === i ? { ...item, amount: e.target.value } : item
                              )
                            )
                          }
                          step="0.01"
                          min="0"
                          placeholder="0.00"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

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

      {/* GMAIL SYNC */}
      <div className="profile-block">
        <p className="section-label">Gmail Sync</p>
        <div className="card">
          {profile.last_synced_at && (
            <p className="last-synced">
              Last synced: {new Date(profile.last_synced_at).toLocaleString()}
            </p>
          )}
          <form onSubmit={handleSaveGmail}>
            <div className="form-stack">
              <div className="field">
                <label className="field-label">Gmail Address</label>
                <input
                  type="email"
                  value={gmailAddress}
                  onChange={(e) => setGmailAddress(e.target.value)}
                  placeholder="you@gmail.com"
                  autoComplete="email"
                />
              </div>
              <PwField
                label="App Password"
                value={appPassword}
                onChange={(e) => setAppPassword(e.target.value)}
                autoComplete="off"
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

      {/* ACCOUNT */}
      <div className="profile-block">
        <p className="section-label">Account</p>
        <div className="card">
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

          <div className="divider" />

          <button className="btn btn-destructive" type="button" onClick={handleSignOut}>
            Sign Out
          </button>
        </div>
      </div>
    </div>
  );
}
