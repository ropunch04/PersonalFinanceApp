import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";

export default function Profile() {
  const { logout } = useAuth();
  const navigate = useNavigate();

  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Budget form state
  const [income, setIncome] = useState("");
  const [savingsTarget, setSavingsTarget] = useState("");
  const [budgets, setBudgets] = useState([]);
  const [savingBudget, setSavingBudget] = useState(false);
  const [budgetMsg, setBudgetMsg] = useState(null);

  // Gmail form state
  const [gmailAddress, setGmailAddress] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [savingGmail, setSavingGmail] = useState(false);
  const [gmailMsg, setGmailMsg] = useState(null);

  // Sync state
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);

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
      setSyncMsg(
        `Synced: ${result.imported ?? 0} imported, ${result.duplicates_skipped ?? 0} duplicates skipped.`
      );
    } catch (err) {
      setSyncMsg(`Error: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  }

  function handleSignOut() {
    api.logout();
    logout();
    navigate("/login");
  }

  if (loading) return <p>Loading...</p>;
  if (error) return <p className="error">{error}</p>;

  return (
    <div className="profile-page">
      <h1>Profile</h1>

      {/* Budget Settings */}
      <section className="profile-section">
        <h2>Budget Settings</h2>
        <form onSubmit={handleSaveBudget}>
          <label>
            Monthly Income ($)
            <input
              type="number"
              value={income}
              onChange={(e) => setIncome(e.target.value)}
              step="0.01"
              min="0"
            />
          </label>
          <label>
            Savings Target ($)
            <input
              type="number"
              value={savingsTarget}
              onChange={(e) => setSavingsTarget(e.target.value)}
              step="0.01"
              min="0"
            />
          </label>

          {budgets.length > 0 && (
            <table className="budget-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Budget ($)</th>
                </tr>
              </thead>
              <tbody>
                {budgets.map((b, i) => (
                  <tr key={b.category_id}>
                    <td>{b.category_name}</td>
                    <td>
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
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {budgetMsg && <p className={budgetMsg.startsWith("Error") ? "error" : "success"}>{budgetMsg}</p>}
          <button type="submit" disabled={savingBudget}>
            {savingBudget ? "Saving..." : "Save"}
          </button>
        </form>
      </section>

      {/* Gmail Sync */}
      <section className="profile-section">
        <h2>Gmail Sync</h2>
        {profile.last_synced_at && (
          <p className="last-synced">Last synced: {new Date(profile.last_synced_at).toLocaleString()}</p>
        )}
        <form onSubmit={handleSaveGmail}>
          <label>
            Gmail Address
            <input
              type="email"
              value={gmailAddress}
              onChange={(e) => setGmailAddress(e.target.value)}
              placeholder="you@gmail.com"
            />
          </label>
          <label>
            App Password
            <input
              type="password"
              value={appPassword}
              onChange={(e) => setAppPassword(e.target.value)}
              placeholder={profile.gmail_configured ? "••••••••••••••••" : ""}
            />
          </label>
          {gmailMsg && <p className={gmailMsg.startsWith("Error") ? "error" : "success"}>{gmailMsg}</p>}
          <button type="submit" disabled={savingGmail}>
            {savingGmail ? "Saving..." : "Save Gmail"}
          </button>
        </form>

        <div className="sync-row">
          <button onClick={handleSync} disabled={syncing || !profile.gmail_configured}>
            {syncing ? "Syncing..." : "Sync Now"}
          </button>
          {syncMsg && <p className={syncMsg.startsWith("Error") ? "error" : "success"}>{syncMsg}</p>}
        </div>
      </section>

      <section className="profile-section">
        <button className="signout-btn" onClick={handleSignOut}>
          Sign Out
        </button>
      </section>
    </div>
  );
}
