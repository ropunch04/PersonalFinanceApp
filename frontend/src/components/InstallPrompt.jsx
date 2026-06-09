import { useEffect, useState } from "react";

const DISMISS_KEY = "finance-install-prompt-dismissed";

function isIosSafari() {
  if (typeof window === "undefined") return false;
  const ua = window.navigator.userAgent;
  const isIos = /iphone|ipad|ipod/i.test(ua);
  const isSafari = /safari/i.test(ua) && !/crios|fxios|opios|chrome/i.test(ua);
  return isIos && isSafari;
}

function isStandalone() {
  return (
    window.navigator.standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches
  );
}

export default function InstallPrompt() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const dismissed = localStorage.getItem(DISMISS_KEY);
    if (!dismissed && isIosSafari() && !isStandalone()) {
      const t = setTimeout(() => setShow(true), 2500);
      return () => clearTimeout(t);
    }
  }, []);

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, "1");
    setShow(false);
  }

  if (!show) return null;

  return (
    <div style={{
      position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 9999,
      padding: "0 12px",
      paddingBottom: "calc(16px + var(--safe-bottom))",
      pointerEvents: "none",
    }}>
      <div style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 16,
        padding: "18px 20px 16px",
        boxShadow: "0 -4px 32px rgba(0,0,0,0.6)",
        pointerEvents: "auto",
        position: "relative",
      }}>
        <button
          onClick={dismiss}
          style={{
            position: "absolute", top: 12, right: 14,
            background: "transparent", border: "none",
            color: "var(--text-muted)", fontSize: 20, cursor: "pointer",
            lineHeight: 1, padding: "2px 6px", minWidth: 32, minHeight: 32,
          }}
        >✕</button>

        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)", marginBottom: 8, paddingRight: 32 }}>
          Install Finance Tracker
        </div>
        <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>
          Add this app to your home screen for the full experience:
        </div>

        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
          {[
            ["1️⃣", <>Tap the <strong style={{ color: "var(--primary)" }}>Share</strong> button in Safari's toolbar</>],
            ["2️⃣", <>Scroll down and tap <strong style={{ color: "var(--primary)" }}>"Add to Home Screen"</strong></>],
            ["3️⃣", <>Tap <strong style={{ color: "var(--primary)" }}>"Add"</strong> to install</>],
          ].map(([icon, text]) => (
            <div key={icon} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--text)" }}>
              <span style={{ fontSize: 20, flexShrink: 0, minWidth: 28, textAlign: "center" }}>{icon}</span>
              <span>{text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
