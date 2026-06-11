import { useNavigate } from "react-router-dom";

function Step({ n, children }) {
  return (
    <div style={{ display: "flex", gap: 12, marginBottom: 14 }}>
      <div style={{
        flexShrink: 0, width: 24, height: 24, borderRadius: "50%",
        background: "var(--primary)", color: "#fff",
        fontSize: 12, fontWeight: 700,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {n}
      </div>
      <div style={{ fontSize: 14, color: "var(--text)", lineHeight: 1.6, paddingTop: 3 }}>
        {children}
      </div>
    </div>
  );
}

function ExternalLink({ href, children }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer"
      style={{ color: "var(--primary)", textDecoration: "underline" }}>
      {children}
    </a>
  );
}

function Note({ children }) {
  return (
    <div style={{
      background: "rgba(255, 180, 0, 0.1)", border: "1px solid rgba(255, 180, 0, 0.4)",
      borderRadius: 8, padding: "10px 12px",
      fontSize: 13, color: "var(--text)", lineHeight: 1.5, marginBottom: 16,
    }}>
      {children}
    </div>
  );
}

function TipBox({ children }) {
  return (
    <div style={{
      background: "rgba(108, 99, 255, 0.08)", border: "1px solid rgba(108, 99, 255, 0.25)",
      borderRadius: 8, padding: "10px 12px",
      fontSize: 13, color: "var(--text)", lineHeight: 1.5, marginBottom: 16,
    }}>
      {children}
    </div>
  );
}

export default function GmailSetup() {
  const navigate = useNavigate();

  return (
    <div className="page">
      <div className="page-header">
        <button className="btn btn-ghost btn-sm" onClick={() => navigate(-1)}>← Back</button>
        <h1 style={{ marginLeft: 8 }}>Gmail Sync Setup</h1>
      </div>

      <div className="profile-block">
        <p className="section-label">How It Works</p>
        <div className="card">
          <p style={{ fontSize: 14, color: "var(--text)", lineHeight: 1.6, marginBottom: 12 }}>
            The app connects to your Gmail over IMAP and automatically imports transactions
            from notification emails sent by your linked accounts.
          </p>
          <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}>
            Supported emails
          </p>
          <ul style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.8, paddingLeft: 18, marginBottom: 14 }}>
            <li>Capital One — transaction alerts</li>
            <li>Capital One — credits &amp; refund notifications</li>
            <li>Venmo — "paid you" and "you paid" notifications</li>
          </ul>
          <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}>
            Sync schedule
          </p>
          <ul style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.8, paddingLeft: 18, marginBottom: 0 }}>
            <li>Automatically at 3 am every day</li>
            <li>When you open the app (if last sync was &gt;10 min ago)</li>
            <li>Manually via Profile → Sync Now</li>
          </ul>
        </div>
      </div>

      <div className="profile-block">
        <p className="section-label">Important: Unread Emails Only</p>
        <div className="card">
          <Note>
            <strong>The sync only imports unread emails.</strong> Once an email is processed it is
            marked as read so it is not imported twice. If you have already read your Capital One
            or Venmo notification emails before setting this up, they will not be picked up
            automatically — you would need to mark them as unread in Gmail first.
          </Note>
          <p style={{ fontSize: 14, color: "var(--text)", lineHeight: 1.6 }}>
            The recommended setup below avoids this problem entirely by using a dedicated
            Gmail account where every forwarded email arrives unread.
          </p>
        </div>
      </div>

      <div className="profile-block">
        <p className="section-label">Recommended: Dedicated Gmail + Forwarding</p>
        <div className="card">
          <TipBox>
            Create a separate Gmail account just for this app. Your main account forwards
            Capital One and Venmo emails there, so they always arrive unread and your main
            inbox stays clean.
          </TipBox>

          <Step n={1}>
            Create a new Gmail account — e.g.{" "}
            <code style={{ background: "var(--surface-raised)", borderRadius: 4, padding: "1px 5px", fontSize: 12 }}>
              yourname.finance@gmail.com
            </code>
          </Step>

          <Step n={2}>
            In your <strong>main Gmail</strong>, create a forwarding filter:
            <ul style={{ marginTop: 6, paddingLeft: 18, lineHeight: 1.8 }}>
              <li>Open Gmail Settings → See all settings → Filters and Blocked Addresses</li>
              <li>Create a new filter with <em>From</em>: <code style={{ background: "var(--surface-raised)", borderRadius: 4, padding: "1px 4px", fontSize: 12 }}>capitalone.com</code></li>
              <li>Action: <strong>Forward to</strong> your new finance address + optionally <strong>Skip Inbox</strong> to keep your main inbox tidy</li>
              <li>Repeat for <code style={{ background: "var(--surface-raised)", borderRadius: 4, padding: "1px 4px", fontSize: 12 }}>venmo@venmo.com</code></li>
            </ul>
          </Step>

          <Step n={3}>
            In the <strong>new Gmail account</strong>, enable 2-Step Verification — required before
            you can create an App Password:{" "}
            <ExternalLink href="https://myaccount.google.com/security">
              myaccount.google.com → Security → 2-Step Verification
            </ExternalLink>
          </Step>

          <Step n={4}>
            Create an App Password:{" "}
            <ExternalLink href="https://myaccount.google.com/apppasswords">
              myaccount.google.com/apppasswords
            </ExternalLink>
            <ul style={{ marginTop: 6, paddingLeft: 18, lineHeight: 1.8 }}>
              <li>Select app: <strong>Mail</strong></li>
              <li>Select device: <strong>Other (custom name)</strong> → type "Finance App"</li>
              <li>Click Generate — copy the <strong>16-character code</strong> (no spaces needed)</li>
            </ul>
          </Step>

          <Step n={5}>
            In this app, go to <strong>Profile → Gmail Sync</strong> and enter:
            <ul style={{ marginTop: 6, paddingLeft: 18, lineHeight: 1.8 }}>
              <li>Gmail Address: the new finance Gmail address</li>
              <li>App Password: the 16-character code from step 4</li>
            </ul>
          </Step>
        </div>
      </div>

      <div className="profile-block">
        <p className="section-label">Troubleshooting</p>
        <div className="card">
          {[
            {
              q: "Sync runs but 0 transactions imported",
              a: "Your notification emails are probably already read. Mark them as unread in Gmail and sync again, or use the dedicated account setup so all forwarded emails arrive unread.",
            },
            {
              q: "Connection error / authentication failed",
              a: "Double-check the App Password — it should be 16 characters with no spaces. Make sure 2-Step Verification is enabled on the Gmail account you're connecting.",
            },
            {
              q: "Capital One emails not found",
              a: "Make sure transaction alert emails are enabled in your Capital One account notification settings. You should be receiving emails like \"A transaction was made with your card.\"",
            },
            {
              q: "Venmo emails not found",
              a: "Check that Venmo email notifications are turned on in the Venmo app under Settings → Notifications.",
            },
            {
              q: "App Password option doesn't appear",
              a: "App Passwords are only available when 2-Step Verification is active. Some Google Workspace accounts administered by an organization may not allow App Passwords.",
            },
          ].map(({ q, a }) => (
            <div key={q} style={{ marginBottom: 16, paddingBottom: 16, borderBottom: "1px solid var(--border)" }}>
              <p style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>{q}</p>
              <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6, margin: 0 }}>{a}</p>
            </div>
          ))}
          <div>
            <p style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>
              Still stuck?
            </p>
            <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6, margin: 0 }}>
              You can always import transactions manually via the CSV import on the Transactions page.
              Capital One and Venmo both let you export your transaction history as a CSV.
            </p>
          </div>
        </div>
      </div>

      <div style={{ height: 32 }} />
    </div>
  );
}
