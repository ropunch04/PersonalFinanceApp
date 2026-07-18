# Security Review (of the audit) + Hosting Recommendation — PersonalFinanceApp

**Prepared:** 2026-07-18. Static analysis only; the running dev instance on port 5100 was not
touched. This document does two things: (1) adversarially reviews `SECURITY_AUDIT.md` against the
actual code, and (2) ranks safe remote-access options for a Raspberry-Pi self-host.

---

## PART 1 — Adversarial review of `SECURITY_AUDIT.md`

### Overall grade: **A− / strong and trustworthy, with one factual error and a few gaps**

The audit is genuinely good. Its structural conclusions are correct and verifiable in the code:

- **No SQL injection.** Confirmed. Every dynamic SQL fragment is built from whitelisted column
  names (`transactions.py:106-114`, `models/user.py:84-93`, `budget_service.py`) or from
  `?`-placeholder counts over integer ID lists (`transactions.py:97-101`, `dashboard.py:26-31`,
  `budget_service.py:17-26`). The `include_ids`/`pinned_ids` params are parsed with
  `int(x)` inside a try/except that discards the whole list on any bad element
  (`dashboard.py:13-19`, `transactions.py:91-95`) — no injection reaches the `IN (...)` clause.
- **No path traversal / IDOR / cross-tenant access.** Confirmed. `get_db_path` interpolates only
  the integer `user_id` derived from the JWT `sub` (cast to `int` in `jwt_utils.decode_token:23`);
  every data route resolves its DB from `g.current_user["user_id"]` and all record IDs are scoped
  inside that user's own SQLite file. The SPA catch-all serves through `send_from_directory`
  (Werkzeug `safe_join`), so `../` is rejected even though `spa()` does a raw `os.path.isfile`
  pre-check first (the pre-check never becomes the serving path).
- **No JWT algorithm confusion.** `decode_token` pins `algorithms=["HS256"]` (`jwt_utils.py:22`).
- **Auth-decorator coverage.** Confirmed on every blueprint: `@require_auth` on all data routes,
  `@require_auth` + `@require_admin` stacked (auth first) on every `/api/admin/*` route.
- **`.env` is git-ignored and absent from history.** Confirmed (`git log --all -- .env` is empty;
  `.gitignore` lists `.env`).

The four HIGH findings (H1 tunnel/ProxyFix rate-limit collapse, H2 open registration default, H3
no token revocation, H4 undefined admin bootstrap) are all real and correctly diagnosed against
the code. The verdict — **NOT SAFE as-is, SAFE WITH FIXES** — holds.

Below are the corrections and additions.

---

### 1.1 — Finding that is WRONG (factual error)

#### ✗ L4 credits a login timing-defense that the login route never executes

The audit's L4 note says: *"login correctly uses a single generic error and a dummy-hash timing
defense (`auth/auth_db.py:12,32-42`), which is good."*

**This is false.** `authenticate_user()` (the function containing the `_DUMMY_HASH` constant-time
defense at `auth_db.py:12,32-42`) and `register_user()` are **dead code** — nothing imports or
calls them anywhere in the project:

```
$ grep -rn "authenticate_user\|register_user" --include="*.py" . | grep -v auth/auth_db.py
(no results)
```

The actual login endpoint (`routes/auth_routes.py:65-98`) rolls its own logic and does **not** use
the dummy hash:

```python
row = get_user_by_username(identifier) or get_user_by_email(identifier)
if not row:
    return _GENERIC_LOGIN_ERROR, 401          # returns immediately, no bcrypt
if not bcrypt.checkpw(password.encode(), row["password_hash"].encode()):
    return _GENERIC_LOGIN_ERROR, 401          # only runs bcrypt when the user exists
```

**Consequence — a real (missed) finding:** the login route has a **username/email-enumeration
timing side channel**. A request for a non-existent identifier returns in microseconds; a request
for an existing identifier pays a full bcrypt-cost-12 verification (tens of milliseconds). An
attacker can distinguish valid usernames/emails by response latency even though the error string
is identical. Severity is Low-to-Medium (bcrypt is slow but the delta is large and stable), and it
directly undercuts the audit's claim that this path is "good." **Fix:** route login through the
existing `authenticate_user()` (which already always runs a bcrypt compare against `_DUMMY_HASH`
for missing users), or inline the same dummy-hash compare in the endpoint.

---

### 1.2 — Things the audit MISSED

#### M-NEW-1 — Login username/email enumeration via timing (see 1.1)
Not just a correction to L4 — it is an independent finding the audit does not list anywhere.

#### M-NEW-2 — No rate limit on `/api/sync` or `/api/import/transactions` (authenticated DoS)
`limiter.limit` appears **only** in `routes/auth_routes.py` (register/login/change-password). Every
other route, including the two expensive ones, is unthrottled:

- `POST /api/sync` (`sync_routes.py:76`) performs a live IMAP SSL login + INBOX search + fetch on
  every call. An authenticated user (or a stolen token) can loop this and (a) hammer the Pi's CPU
  and network, and (b) trigger Gmail's own rate-limiting / temporary IMAP lockout of the account.
- `POST /api/import/transactions` (`import_route.py:26`) parses uploaded CSVs in memory.

Impact is bounded to authenticated users and is mostly self-inflicted in a 1–3 user deployment, so
this is **Low** — but it belongs in the report and is trivial to fix (`@limiter.limit("6/minute")`
on sync). Note also that `MAX_CONTENT_LENGTH = 10 MB` is global and correctly caps upload size.

#### M-NEW-3 — On-disk `.env` and DB files are world-readable (0644)
The audit's L2 says the `.env` posture is "acceptable **only if** the file is `chmod 600`." The
current on-disk reality fails that condition:

```
-rw-r--r-- kyleotero .env               # 0644 — world-readable
-rw-r--r-- kyleotero data/master.db     # 0644
-rw-r--r-- kyleotero data/user_1_finance.db
```

`.env` holds a real 64-hex `SECRET_KEY` and a valid Fernet `ENCRYPTION_KEY` in cleartext, and it is
readable by **any** local account on the Pi. On a single-user Pi this is only a defense-in-depth
gap, but the audit stated the precondition without checking that it is currently violated. **Fix:**
`chmod 600 .env` and `chmod 700 data/` (plus `chmod 600 data/*.db`), owned by the service user.

#### M-NEW-4 — systemd unit ships a foreign user/path and no hardening for the data dir
`deploy/finance-app.service` hardcodes `User=rohitpras` and
`WorkingDirectory=/home/rohitpras/PersonalFinanceApp` (upstream author's home, not this owner's).
Copy-pasting it as-is will fail or, worse, silently run under an unexpected account. The audit
praises `NoNewPrivileges`/`PrivateTmp` (correctly present) but does not flag that the unit is not
portable and grants the service write access to its whole working tree (where `.env` lives).
**Fix:** correct `User`/paths for this Pi; consider `ProtectSystem=strict` with an explicit
`ReadWritePaths=` for `data/` and `logs/` only, and `systemd LoadCredential` for the keys.

#### M-NEW-5 — `is_admin` is read from the token, not the DB, on every request
`require_auth` populates `g.current_user["is_admin"]` straight from the JWT payload
(`middleware.py:24`). Combined with H3 (no revocation, 7-day TTL), **demoting an admin — or an
admin who is compromised — does not take effect until their token expires** (up to a week). This is
a specific and important consequence of H3 that the audit's H3 write-up (framed around password
change) does not spell out. The `token_version` fix proposed for H3 also resolves this if the
version check is enforced in `decode_token`/`require_auth`.

#### M-NEW-6 (informational) — `_source_hash` collision suppression is confirmed exploitable-in-principle
The audit's M3 correctly notes the email dedup hash derives from the attacker-influenceable
`Message-ID`. Confirmed: `_source_hash(provider, message_id)` (`email_parser.py:60-62`) feeds the
`source_hash UNIQUE` column via `INSERT OR IGNORE` (`sync_service.py:43-58`). A spoofed inbound
email whose `Message-ID` collides with a not-yet-synced legitimate alert would suppress the real
row. Good catch by the audit; flagging only that it is real, not theoretical. (The CSV importer
uses a safer server-side composite hash including `row_num` — `import_service.py:8-12`.)

---

### 1.3 — Findings that are correct but slightly OVERSTATED

- **H1 (rate-limit collapse) — valid, but the "brute-force" framing is the weaker half.** The real,
  high-confidence impact is **availability**: because `get_remote_address` returns `127.0.0.1` for
  every tunneled client, one attacker tripping `20/minute` on `/login` locks out *all* users from a
  shared bucket — a trivial DoS. The *credential* brute-force angle is weaker than implied: bcrypt
  cost-12 plus identical generic errors make online guessing slow regardless. Net: keep it High for
  the DoS reason; don't oversell the password-cracking risk. The proposed `ProxyFix(x_for=1)` fix is
  correct **only** because the tunnel daemon is the sole, trusted local peer — do not apply it if the
  app is ever exposed without exactly one proxy in front.
- **H2 (open registration) — correct; note the mitigating detail.** `REGISTRATION_ENABLED` does
  default to `"true"` (`auth_routes.py:28`) and `config.py` never sets it, so the finding stands.
  Worth adding: registration is the *one* unauthenticated write path besides login, it is rate
  limited (`10/hour`, subject to H1), and it provisions a per-user DB — so mass-registration disk
  exhaustion is the primary concrete harm, exactly as the audit says.
- **M5 (weak password policy) — correct and arguably understated for admin paths.** Verified:
  `admin_routes.py:114-123` `reset_password` accepts any non-empty string (zero length floor) and
  `create_user_route:71-74` enforces no minimum. That's worse than the ≥8 on the public routes and
  deserves at least Medium on its own.

Everything else in the MEDIUM/LOW/INFO sections checks out as written (CSP `unsafe-inline`/`unsafe-eval`
present at `app.py:73`; JWT in `localStorage` at `api.js:1` and `AuthContext.jsx:5`; no HSTS in
`apply_headers`; `memory://` limiter storage with 2 workers; gunicorn binds `127.0.0.1:5100`; no
`dangerouslySetInnerHTML`/`innerHTML` in `frontend/src`; `DEBUG=true` in the working `.env`).

---

### 1.4 — Scorecard

| Dimension | Assessment |
|---|---|
| Injection / traversal / IDOR / authz coverage | Correct and independently verified. |
| The 4 HIGH findings | All real, correctly located, correctly fixed. |
| Factual errors | **One:** L4's login timing-defense claim (dead code path). |
| Missed findings | Login timing enumeration; no rate limit on sync/import; live 0644 perms on `.env`+DBs; portability/hardening gaps in the systemd unit; token-sourced `is_admin` staleness. All Low–Medium. |
| Overstatements | H1 brute-force emphasis; otherwise none material. |
| Verdict ("unsafe as-is, safe with fixes") | **Holds.** None of the misses change it; they add a couple of easy Low/Medium items. |

**Bottom line:** trust the audit's severity ranking and its "safe with fixes" verdict. Correct L4,
add the login timing fix, tighten file perms, and fix the systemd unit before relying on it.

---

## PART 2 — Hosting / remote-access options, ranked

**Situation:** remote access for a tiny trusted group (owner + maybe 1–2 friends) to an app holding
financial history **and** Fernet-encrypted Gmail app-passwords whose decrypting key sits in the same
`.env` on the same SD card. The owner already pays for **ngrok** and the repo ships a **Cloudflare
Tunnel** unit. The single most valuable security property here is **keeping the app off the raw
public internet** so that the app's own auth is *not* the only gate.

A key idea used below: *"mandatory vs optional"* code fixes depend on **who can reach the login
page**. If an identity layer (Access, VPN, ngrok auth) fronts the app, unauthenticated internet
traffic never reaches Flask, which downgrades several audit findings from mandatory to
belt-and-suspenders.

### Option A — Tailscale (WireGuard mesh), app never publicly exposed  ★ recommended for max security
- **Security posture:** Best. The Pi is reachable **only** by devices in the owner's tailnet;
  there is no public hostname, no public TLS endpoint, nothing to scan or brute-force. Friends are
  added by inviting their Tailscale identity (Google/GitHub SSO) and sharing the node. Network layer
  = zero-trust identity; the app's auth becomes a second factor rather than the only gate.
- **Audit fixes that stay MANDATORY:** H4 admin bootstrap (still need a real admin), L2/M-NEW-3 key
  hygiene (`chmod 600 .env`, fresh prod keys — the SD card still holds Gmail creds + key), keep
  `DEBUG=false`. Basic account hygiene (strong owner password).
- **Fixes that become OPTIONAL / low-priority:** H1 (ProxyFix / rate-limit collapse) — no untrusted
  IPs reach the app, so brute-force/DoS from the internet is impossible; H2 open registration — the
  page isn't publicly reachable; M1/M2 CSP/HSTS — no hostile network path; H3 token revocation
  drops to nice-to-have. You would still want most of these eventually, but none block go-live.
- **Setup effort on a Pi:** Low. `curl -fsSL https://tailscale.com/install.sh | sh` →
  `tailscale up`. Bind gunicorn to the tailnet IP or `0.0.0.0` **behind the host firewall**, or
  keep `127.0.0.1` and use Tailscale Serve. `ALLOWED_ORIGIN` = the MagicDNS name. No port-forwarding,
  no public DNS.
- **Cost:** Free tier (up to 100 devices / 3 users) easily covers this. ngrok subscription unused
  here.
- **Trade-off:** every user must install the Tailscale client and be added to the tailnet — the
  least "click a link" friendly for non-technical friends, and no access from a random borrowed
  device. For financial data holding live Gmail credentials, that friction is a feature.

### Option B — Cloudflare Tunnel + Cloudflare Access (zero-trust)  ★ recommended best balance
- **Security posture:** Very strong and the best usability/security balance. The shipped
  `deploy/cloudflared.service` already gives an outbound-only tunnel (no inbound ports). Adding
  **Cloudflare Access** (free for up to 50 users) puts an identity gate **at Cloudflare's edge**:
  a request must pass an Access policy (allow-list specific Google emails / one-time PIN) *before*
  Cloudflare will forward anything to the Pi. Unauthenticated internet traffic never reaches Flask.
  Friends just log in with their email — no client install.
- **Audit fixes that stay MANDATORY:** H1 **still matters but is easy** — behind Cloudflare the real
  client IP arrives in `CF-Connecting-IP`; add `ProxyFix` + key the limiter on that header so rate
  limits work and don't collapse (do this because Access is an allow-list, not a brute-force shield
  for the app's own login if you also leave app login reachable to allowed users). H4 admin
  bootstrap; L2/M-NEW-3 key hygiene; `DEBUG=false`; set `ALLOWED_ORIGIN` to the public hostname
  (config.py enforces the non-localhost pairing). **Lock the tunnel origin** so the app is reachable
  *only* via the tunnel (bind `127.0.0.1:5100`, which gunicorn already does; do not open 5100 on the
  LAN/WAN firewall).
- **Fixes that become OPTIONAL:** H2 open registration (Access blocks the page for anyone not on the
  email allow-list — but still set `REGISTRATION_ENABLED=false` as defense in depth, it's one line);
  M1/M2 CSP-hardening and HSTS become lower priority (Cloudflare can add HSTS at the edge for free);
  H3 revocation drops to nice-to-have because the exposure window requires first passing Access.
- **Setup effort on a Pi:** Low–Medium. Requires a domain on Cloudflare (free plan). `cloudflared
  tunnel create`, map a hostname, install the shipped unit (fix the `User`/tunnel-name first), then
  create one Access application + policy in the dashboard. ~30–45 min including DNS propagation.
- **Cost:** $0 (Cloudflare Tunnel + Access free tiers). Needs a domain (~$10/yr if you don't own
  one). ngrok subscription unused.
- **Trade-off:** Cloudflare terminates TLS and can see plaintext HTTP to your app; you're trusting
  Cloudflare's edge. For this threat model that's an acceptable, well-understood trust.

### Option C — ngrok with paid edge auth (OAuth / IP-restriction / basic-auth) in front
- **Security posture:** Good **if and only if** you enable a paid edge policy — ngrok OAuth
  (Google) or IP restrictions or mTLS or at minimum Traffic Policy basic-auth — so the ngrok edge
  authenticates before forwarding to the Pi. Conceptually equivalent to Option B (identity at the
  edge, outbound-only agent). Without an edge policy, an ngrok URL is raw public exposure (see D)
  and the free/random-URL "security by obscurity" is not security.
- **Audit fixes MANDATORY:** same shape as B — H1 (ngrok forwards real IP in `X-Forwarded-For`; add
  `ProxyFix(x_for=1)` + key limiter on it), H4, key hygiene, `DEBUG=false`, `ALLOWED_ORIGIN` = the
  ngrok hostname. **Optional** with edge OAuth/IP-allowlist on: H2, and CSP/HSTS/H3 drop in priority
  (edge HSTS available).
- **Setup effort on a Pi:** Low. `ngrok` agent + a reserved domain and a Traffic Policy / OAuth rule
  in the ngrok dashboard. Reserve a stable domain so the URL doesn't churn.
- **Cost:** **$0 marginal** — the owner already pays for ngrok, and OAuth/IP-restriction/reserved
  domains are exactly what the paid plan buys. This is the cheapest way to get edge auth given the
  existing subscription.
- **Trade-off:** vs Cloudflare, ngrok is oriented at dev tunnels; a persistent home-server tunnel is
  fine but Cloudflare's free Access + tunnel is the more "productized" always-on posture. Pick C over
  B mainly to avoid needing a Cloudflare-managed domain, or if you already have ngrok OAuth dialed in.

### Option D — Raw public exposure after code fixes (baseline for comparison)  ✗ not recommended
- **Security posture:** Weakest of the remote options. The app's own auth is the *only* gate; every
  internet scanner can hit `/api/auth/login` and `/api/auth/register`. For an app holding Gmail
  credentials + finances on a hobby-maintained Pi, that is a poor bet.
- **Audit fixes: ALL of them become MANDATORY** — every HIGH (H1 ProxyFix + shared limiter storage,
  H2 close registration, H3 token revocation + shorter TTL, H4 admin bootstrap), plus M1/M2
  (CSP hardening, HSTS), M5 (password policy), the M-NEW items (login timing fix, sync/import rate
  limits), and rigorous key hygiene. This is the only option where the audit's full checklist is
  load-bearing.
- **Setup effort:** Highest — you must implement and verify every fix, and own OS patching, backups,
  monitoring, and TLS. **Cost:** $0 but highest operational risk.
- **Verdict:** only sensible as a fallback, and even then put a WAF/Access in front. Given A/B/C
  exist at $0, there is no reason to choose D.

### Option E — LAN-only (no remote access)  ★ most secure, if it meets the need
- **Security posture:** Strongest possible — nothing leaves the house network. Verified feasible:
  gunicorn already binds `127.0.0.1:5100`; the README's mention of `0.0.0.0:5100` (`README.md:396`)
  is the LAN-access path.
- **Audit fixes MANDATORY:** essentially only local hygiene — H4 admin bootstrap, `chmod 600 .env`,
  fresh keys, strong owner password, `DEBUG=false`. All internet-facing findings (H1/H2/H3, M1/M2)
  become moot on a trusted home LAN.
- **Setup effort:** Lowest. Bind to the LAN IP (or keep `127.0.0.1` + reverse proxy), open 5100 on
  the host firewall to the LAN only. **Cost:** $0.
- **Trade-off:** no access away from home and no easy sharing with friends — which is the stated
  goal, so this fails the requirement unless combined with A (Tailscale effectively makes "LAN-only"
  portable).

### Ranking summary

| Rank | Option | Public exposure | Friend-friendliness | Marginal cost | Mandatory audit fixes |
|---|---|---|---|---|---|
| 1 | **B — CF Tunnel + Access** | None (edge-gated) | High (email login, no install) | $0 (+domain) | H1 (easy, `CF-Connecting-IP`), H4, key hygiene |
| 2 | **A — Tailscale** | None (private mesh) | Medium (client install) | $0 | H4, key hygiene |
| 3 | **C — ngrok + edge OAuth** | None (edge-gated) | High | $0 (already paid) | H1, H4, key hygiene |
| 4 | **E — LAN-only** | None | Low (home only) | $0 | key hygiene, H4 |
| 5 | **D — raw public + fixes** | Full | High | $0 | **all HIGH+MEDIUM+M-NEW** |

---

## FINAL RECOMMENDATION

**Use Option B — Cloudflare Tunnel + Cloudflare Access — as the primary, with Tailscale (Option A)
as the even-more-locked-down alternative if every user is willing to install a client.**

Rationale for this specific situation: it gives the decisive security win (the app is **never**
raw-internet-reachable — Access authenticates strangers at Cloudflare's edge before any packet
reaches the Pi), it costs **$0**, the repo already ships the `cloudflared` unit, and friends get in
with an email login and no software to install. That combination — zero public attack surface plus
zero-friction sharing plus free — fits a tiny trusted group better than the alternatives. Tailscale
is marginally stronger (no third party terminates your TLS) and is the right call if you'd rather
not hand plaintext-to-origin trust to Cloudflare and everyone will run the client. The **paid ngrok
plan (Option C) is a perfectly good equivalent** if you prefer not to manage a Cloudflare domain —
same edge-auth model, and it's already paid for. Do **not** choose raw public exposure (D).

Whichever of B/A/C you pick, the app is behind an identity gate, so only a short mandatory-fix list
blocks go-live. Everything else from the audit becomes hardening you can do at leisure.

### Minimal pre-launch checklist (for Option B; A/C differ only where noted)

1. **Rotate the keys.** Generate a fresh `SECRET_KEY` (`python -c "import secrets;print(secrets.token_hex(32))"`)
   and a fresh `ENCRYPTION_KEY` (`python -c "from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())"`).
   Never reuse the values currently in the repo `.env` — treat those as burned. (If any Gmail creds
   were already saved under the old key, re-enter them after rotating.)
2. **Lock down secrets on disk.** `chmod 600 .env`, `chmod 700 data/`, `chmod 600 data/*.db`,
   all owned by the service user. (Fixes M-NEW-3 / L2.)
3. **Set production env:** in `.env` set `DEBUG=false`, `REGISTRATION_ENABLED=false`,
   `RUN_SCHEDULER=false`, and `ALLOWED_ORIGIN=https://<your-public-hostname>` (config.py refuses to
   start on a DEBUG/origin mismatch, which is a useful guardrail).
4. **Create the first admin out-of-band** (H4): with registration open *locally only*, register your
   account over `127.0.0.1`, then `sqlite3 data/master.db "UPDATE users SET is_admin=1 WHERE
   username='<you>';"`, then set `REGISTRATION_ENABLED=false` and restart. (Document this; don't
   leave it ad hoc.)
5. **Fix the systemd unit** (`deploy/finance-app.service`): correct `User=` and all `/home/...`
   paths to this Pi's service account; keep `NoNewPrivileges`/`PrivateTmp`; confirm gunicorn binds
   `127.0.0.1:5100` and that **port 5100 is NOT opened on the LAN/WAN firewall**.
6. **Add `ProxyFix` + fix limiter keying** (H1) — even behind Access: put
   `app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1)` and key Flask-Limiter on `CF-Connecting-IP`
   (Cloudflare) / `X-Forwarded-For` (ngrok). Cheap insurance against an allowed user or a leaked
   session abusing login/register. *(A/Tailscale: skip — no untrusted IPs reach the app.)*
7. **Stand up the tunnel + Access:** `cloudflared tunnel create finance-app`, map the hostname to
   `http://127.0.0.1:5100`, install the (fixed) `cloudflared.service`. In the Cloudflare dashboard
   create **one Access application** over the hostname with a policy that **allow-lists only the 1–3
   specific Google emails**. Enable edge HSTS. *(Option A: `tailscale up` and share the node instead.
   Option C: reserve an ngrok domain and attach a Google-OAuth / IP-allow Traffic Policy.)*
8. **Verify the gate before trusting it:** from a browser with no Access/VPN session, confirm the
   public hostname returns the Access login (or is unreachable), **not** the app's own login page.
   Confirm `http://<pi-lan-ip>:5100` is refused from another LAN host.
9. **Quick hardening you can do now (optional but 10 minutes):** route the login endpoint through
   `authenticate_user()` to kill the timing-enumeration side channel (§1.1); add
   `@limiter.limit("6/minute")` to `/api/sync`; set a real minimum length in `admin` reset/create
   password paths (M5).
10. **Operational baseline:** set up a periodic encrypted backup of `data/` **and** a securely stored
    copy of `ENCRYPTION_KEY` (losing it makes stored Gmail creds unrecoverable), enable unattended
    OS security updates on the Pi, and use a **dedicated, narrowly-scoped Gmail app password** rather
    than the account's primary credentials.

Once 1–8 are done the app is behind an identity gate with rotated keys and locked-down secrets;
9–10 are the leisure hardening the audit's remaining Medium/Low items call for.
