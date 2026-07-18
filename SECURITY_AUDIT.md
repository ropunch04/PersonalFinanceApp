# Security Audit — PersonalFinanceApp

**Scope:** Defensive static-analysis review of the Flask + SQLite backend and React 19/Vite
frontend prior to self-hosting on a Raspberry Pi and exposing it to the internet via
ngrok / Cloudflare Tunnel. No code was modified; no app or exploit was run.

**Reviewed at:** branch `kotero` (with `fix-amex-email-scan` merged), 2026-07-18.

---

## Verdict: NOT SAFE to expose as-is — SAFE WITH FIXES

The core auth model is reasonable: bcrypt (cost 12), HS256 JWTs decoded with a pinned
algorithm list, parameterized SQL almost everywhere, per-user SQLite databases keyed on the
JWT `sub`, Fernet-encrypted Gmail passwords, and `@require_auth`/`@require_admin` present on
every non-public route. I found **no SQL injection, no path traversal, no IDOR, and no
command injection.**

However, several issues make public exposure unsafe **as-is**:

- Rate limiting is effectively **broken behind a tunnel** (all clients collapse to one source
  IP), so the login/register brute-force protection either fails open per-worker or locks out
  everyone — see H1.
- **Open self-registration is on by default**, so anyone on the internet gets an account and a
  server-side DB the moment the tunnel is up (H2).
- No **token revocation** and a 7-day TTL mean a stolen/forged token is valid for a week and a
  password change does not cut it off (H3).
- A **weak CSP** (`unsafe-inline`, `unsafe-eval`) plus **JWT in `localStorage`** means any XSS
  is a full account takeover of financial data (M-tier).

None of these are hard to fix. After the Critical/High items below are addressed, exposure is
reasonable for a single-owner deployment — with the residual risks noted at the end.

---

## Findings by severity

### CRITICAL

_No Critical (RCE / SQLi / auth bypass / cross-tenant data access) issues were found._ The
items below are High/Medium hardening gaps that collectively make internet exposure unsafe
until fixed.

---

### HIGH

#### H1 — Rate limiting collapses to a single client behind ngrok / Cloudflare Tunnel
**Files:** `limiter.py:4`, `routes/auth_routes.py:26,66,103`, no `ProxyFix` anywhere.

`Limiter(get_remote_address, ...)` keys every limit on `request.remote_addr`. With a Cloudflare
Tunnel (or ngrok) the connection to Flask originates from the local tunnel daemon, so
`remote_addr` is `127.0.0.1` (or the proxy address) for **every** internet client. Two
consequences, both bad:

- The real client IP lives in `X-Forwarded-For`, which is never consulted (no `ProxyFix`,
  no trusted-proxy config). So all remote users share one bucket.
- Result is either a **global lockout** (one attacker's 20 login attempts/min freeze the login
  route for all legitimate users — a trivial DoS) or, per-worker with `memory://` storage
  across 2 gunicorn workers, an effective **2× the intended limit** and reset on every restart.

Attack scenario: an attacker hammers `/api/auth/login`; because every request shares the
`127.0.0.1` bucket, they either brute-force under a per-worker limit that resets on restart, or
they intentionally trip the shared limit to deny login to the owner.

**Fix:** Put `werkzeug.middleware.proxy_fix.ProxyFix(app.wsgi_app, x_for=1)` in front of the
app (only when behind a trusted single proxy), and configure Flask-Limiter to key on the
forwarded client IP. Move limiter storage off `memory://` (e.g. a shared SQLite/Redis
`storage_uri`) so limits are consistent across both workers and survive restarts. Cloudflare
Tunnel sets `CF-Connecting-IP` — prefer that header when using Cloudflare.

#### H2 — Open self-registration is enabled by default
**Files:** `routes/auth_routes.py:28` (`REGISTRATION_ENABLED` defaults to `"true"`),
`config.py` (no default set), `README.md:139,155`.

`register()` only closes when `REGISTRATION_ENABLED` is explicitly `"false"`. The shipped `.env`
does not set it, and the README documents "registration is open in dev." If the owner exposes
the tunnel before setting this, **anyone who finds the URL can create an account**, each of
which provisions a server-side SQLite DB (`init_user_db`) and can then configure Gmail IMAP
sync. There is no email verification and no CAPTCHA. Registration is only rate-limited at
`10/hour` — and that limit is subject to H1.

Attack scenario: attacker discovers the hostname, mass-registers accounts (resource
exhaustion / disk fill on the Pi), and uses the app as an oracle or a foothold.

**Fix:** Default `REGISTRATION_ENABLED` to `false`; require it be explicitly enabled. Document
that the owner must create their account, then set it false. Better: bind registration to an
invite token for a single-user deployment.

#### H3 — No token revocation; 7-day TTL; password change does not invalidate sessions
**Files:** `auth/jwt_utils.py:8` (`_TTL_HOURS = 168`), `auth/jwt_utils.py:21` (`decode_token`),
`routes/auth_routes.py:101-121` (change-password), `auth/middleware.py`.

JWTs are stateless HS256 tokens valid for 7 days with no server-side revocation list, no `jti`,
and no per-user token version. Changing a password (`change_password`, admin `reset_password`)
does **not** invalidate existing tokens — a stolen or shared token keeps working for up to a
week regardless. There is also no logout-server-side (frontend just drops `localStorage`).

Attack scenario: a token leaks (XSS, shared device, proxy log); the victim changes their
password to respond, but the attacker's token stays valid for the remainder of the 7 days.

**Fix:** Add a `token_version` (or `password_changed_at`) column to `users`, embed it in the JWT,
and reject tokens whose version is stale in `decode_token`/`require_auth`. Shorten the access
TTL (e.g. 1–24h) and/or add refresh tokens. Bump the version on password change and on demand
("log out everywhere").

#### H4 — Admin bootstrap is undefined; first admin must be created out-of-band
**Files:** `routes/auth_routes.py:56` (registration always `is_admin=False`),
`routes/admin_routes.py:61-84` (creating admins requires being an admin), `models/user.py`.

There is no code path that creates the first admin — registration is always non-admin, and the
only admin-creating route requires an existing admin. In practice the owner must hand-edit
`master.db` (`UPDATE users SET is_admin=1`). This isn't itself a vuln, but it's a footgun: if an
admin is ever provisioned by flipping a bit and the process is ad hoc, it's easy to end up with
an unintended admin, and there's no audit of admin actions. The admin surface is powerful
(reset any password, read app logs, trigger any user's Gmail sync, see every user's Gmail
address / last-sync — `routes/admin_routes.py:35-50,111-123,143-155,173-187`).

**Fix:** Provide an explicit, documented CLI/one-shot script to create the first admin (reading
a password from env/stdin, never a hardcoded default). Keep admin creation off the public API.
Consider basic audit logging of admin actions.

---

### MEDIUM

#### M1 — Weak Content-Security-Policy combined with JWT in localStorage
**Files:** `app.py:71-78` (CSP), `frontend/src/api.js:4,17`, `frontend/src/context/AuthContext.jsx:9,24`,
`frontend/src/pages/Admin.jsx:217`.

The CSP allows `script-src 'self' 'unsafe-inline' 'unsafe-eval'`. That defeats most of CSP's XSS
value. The auth token is stored in `localStorage` (`finance_token`), which is readable by any
script in the origin. So **any** XSS — including a future regression — becomes full account
takeover (exfiltrate the token, act as the user, including admin). No stored-XSS sink exists
today (React escapes by default and there is **no `dangerouslySetInnerHTML`** anywhere — good),
but the blast radius of any XSS is maximal.

**Fix:** Remove `unsafe-inline`/`unsafe-eval` from `script-src` (Vite builds don't need them;
use hashed/nonce'd inline if any). Prefer storing the token in a `HttpOnly`, `Secure`,
`SameSite=Strict` cookie with CSRF protection, so script cannot read it. At minimum, tighten CSP
and add `Strict-Transport-Security` (missing) since the tunnel serves HTTPS.

#### M2 — Missing HSTS and permissive-ish header posture
**File:** `app.py:59-79`.

Headers set `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, and a CSP, but
there is **no `Strict-Transport-Security`** header. Behind an HTTPS tunnel, HSTS should be sent.
CORS reflection is correctly limited to an exact `ALLOWED_ORIGIN` match (`app.py:61-66`) — that
part is fine.

**Fix:** Add `Strict-Transport-Security: max-age=63072000; includeSubDomains`. (Cloudflare can
also enforce this at the edge.)

#### M3 — Email-parser transaction poisoning via spoofed sender
**Files:** `services/email_parser.py:347-405` (IMAP search by `FROM`), `:151-337` (parsers),
`services/sync_service.py:35-65`.

The Gmail sync trusts the `From` header (`FROM "capitalone.com"`, `FROM "venmo@venmo.com"`,
`FROM "americanexpress.com"`) to decide what to parse, and parses attacker-controllable body
text into financial rows. Email `From` is trivially spoofable; anything that lands in the
victim's inbox matching these patterns is ingested as a real transaction (wrong balances,
injected merchants/amounts, fake refunds inflating "income"). Additionally, `_source_hash` for
email is derived from the attacker-influenced `Message-ID` (`email_parser.py:60-62,374`), so a
crafted `Message-ID` colliding with a legitimate one could **suppress** a real transaction via
the `INSERT OR IGNORE` dedup.

This is a data-integrity issue, not RCE (no `eval`, BeautifulSoup `html.parser` with `get_text`
only, amounts parsed via regex + `float`). Impact is bounded to the user's own DB.

**Fix:** Require DKIM/SPF-verified senders (check `Authentication-Results`) before trusting a
`From`. Don't derive the dedup hash from the attacker-controlled `Message-ID` alone — include
server-assigned data (IMAP UID + account) and/or the parsed fields. Treat parse output as
untrusted and cap per-sync ingestion.

#### M4 — Rate-limit storage is in-memory and per-worker
**File:** `limiter.py:4` (`storage_uri="memory://"`), `gunicorn.conf.py:8` (`workers = 2`).

Even after fixing H1's IP keying, `memory://` means each of the 2 gunicorn workers keeps its own
counters, so real limits are ~2× configured and reset on every deploy/restart. (Called out
separately from H1 because it persists after the proxy fix.)

**Fix:** Use a shared backend (`storage_uri` pointing at Redis, or a file/SQLite moving-window
store) so limits are global and durable.

#### M5 — Weak password policy
**Files:** `routes/auth_routes.py:39,112`, `routes/admin_routes.py:71` (admin-created users and
`reset_password` enforce **no** length at all — `admin_routes.py:114-123`).

Registration and change-password require only `len >= 8`, no complexity or breach check. Admin
`create_user_route` and `reset_password` enforce no minimum length whatsoever (`reset_password`
accepts any non-empty string). On an internet-exposed login this invites credential stuffing /
weak passwords.

**Fix:** Enforce a consistent minimum (e.g. ≥12) everywhere including admin paths, and consider
a breached-password check (k-anonymity HIBP) or zxcvbn strength estimate.

---

### LOW

#### L1 — DEBUG=true in the committed working `.env`
**Files:** `.env:3` (`DEBUG=true`), `config.py:11,24-33`.

The on-disk `.env` sets `DEBUG=true`. `config.py` does guard against `DEBUG=true` with a
non-localhost `ALLOWED_ORIGIN` (raises at startup), and gunicorn never passes `debug` to
`app.run`, so the Werkzeug debugger won't be exposed in the documented prod path. Still, shipping
a `DEBUG=true` default is a footgun; a misconfiguration (running `python app.py` on the Pi) would
bind `0.0.0.0:5100` with the interactive debugger. Note `.env` is correctly **git-ignored and
not present in git history** (verified), and no real secrets are committed.

**Fix:** Ship `DEBUG=false` as the default; keep debug strictly opt-in for local dev.

#### L2 — Secrets live in a plaintext `.env` read by the systemd unit
**Files:** `.env:1-2` (real 64-hex `SECRET_KEY` and a valid Fernet `ENCRYPTION_KEY`),
`deploy/finance-app.service:13` (`EnvironmentFile=.../.env`).

The `SECRET_KEY` signs all JWTs and the `ENCRYPTION_KEY` decrypts every user's Gmail app
password. Both sit in a plaintext file on the Pi. This is acceptable for self-hosting **only if**
(a) the file is `chmod 600` and owned by the service user, and (b) the keys used in production
are freshly generated and never the dev values in this repo's `.env`. If the current `.env` keys
were ever shared/screenshotted, an attacker with `SECRET_KEY` can forge an admin JWT and with
`ENCRYPTION_KEY` can decrypt exfiltrated Gmail passwords.

**Fix:** Generate fresh keys for production, `chmod 600 .env`, ensure it is owned by the service
user, and never reuse the committed dev keys. Consider `systemd` `LoadCredential` or a secrets
manager. Rotate if there's any doubt about exposure.

#### L3 — CSV / stored values are not spreadsheet-formula-sanitized
**Files:** `services/import_service.py`, `routes/transactions.py`.

Merchant/notes strings from CSV/email are stored verbatim. There's no CSV **export** feature, so
classic formula injection (`=cmd|...`) has no sink today, and React escapes on render (no HTML
sink). Flagged only so that if an export-to-CSV feature is added later, values beginning with
`= + - @` must be prefixed/quoted.

**Fix:** If/when adding export, sanitize leading formula characters.

#### L4 — Verbose error strings returned to clients in a few places
**Files:** `routes/admin_routes.py:79,105-106,150` and `services/sync_service.py:71`
(`return {"error": str(exc)...}`).

Admin routes and the sync path surface raw exception text to the response. Admin routes are
admin-gated (limited exposure), but `sync_user` errors reach the authenticated user via
`sync_routes.py:79-82`. This can leak internal detail (paths, driver messages). Most other routes
return generic messages — login correctly uses a single generic error and a dummy-hash timing
defense (`auth/auth_db.py:12,32-42`), which is good.

**Fix:** Log full exceptions server-side; return generic messages to clients.

---

### INFO / Notes (things checked that are OK)

- **SQL injection:** No string-interpolated user values found. Dynamic `SET`/`ORDER BY`/`IN (...)`
  clauses are built only from **whitelisted column names** (`models/user.py:84-93`,
  `routes/transactions.py:106-114,197-227`, `routes/profile.py:52-61`) or `?`-placeholder counts
  for integer ID lists (`transactions.py:97-101`, `dashboard.py`, `budget_service.py`). Safe.
- **Path traversal:** `get_db_path` interpolates only the integer `user_id` from the JWT `sub`
  (cast to `int` in `jwt_utils.decode_token`) — `db_context.py:58-59`. The SPA catch-all
  (`app.py:92-98`) serves via `send_from_directory`, which uses Werkzeug `safe_join` and rejects
  `../`. Uploads are streamed in memory, never written by name. Safe.
- **IDOR / multi-tenancy:** Every data route resolves the DB from `g.current_user["user_id"]`
  and all record IDs (`txn_id`, `category_id`, `include_ids`) are scoped within that user's own
  DB file. There is no route that takes another user's ID for data access except the admin
  routes, which are `@require_admin`. No cross-tenant path found.
- **JWT algorithm confusion:** `decode_token` pins `algorithms=["HS256"]`; `exp` is validated by
  PyJWT automatically. No `alg:none`/RS↔HS confusion possible.
- **Auth decorator coverage:** All non-public routes carry `@require_auth`; admin routes carry
  `@require_auth` + `@require_admin`. `require_admin` reads `g.current_user` which is only set by
  `require_auth`, and the decorators are always stacked in that order.
- **Upload size:** `MAX_CONTENT_LENGTH = 10 MB` set globally (`app.py:29`).
- **Frontend XSS sinks:** No `dangerouslySetInnerHTML`, no `innerHTML` assignment in `src/`.
- **Dependencies:** Pinned versions (`requirements.txt`, `frontend/package.json`) are all at or
  above current releases (Flask 3.1.3, Werkzeug 3.1.8, cryptography 48, bcrypt 5, PyJWT 2.13,
  React 19.2, Vite 8). No known-vulnerable release identified among them. Re-run `pip-audit` /
  `npm audit` at deploy time to catch anything published after this review.
- **Gunicorn binding:** `gunicorn.conf.py` binds `127.0.0.1:5100` (correct — not `0.0.0.0`). The
  README's "0.0.0.0:5100" wording (`README.md:396`) is inconsistent with the actual config;
  ensure the tunnel targets `127.0.0.1:5100` and the Pi's port 5100 is **not** also opened on the
  LAN/WAN firewall.

---

## Residual risk (remains even after all fixes)

Even with every item above fixed, exposing this app to the internet concentrates unusually
sensitive assets on a single, owner-managed Raspberry Pi:

1. **Gmail app passwords + financial history in one place.** The Pi holds every user's Fernet-
   encrypted Gmail app password *and* the `ENCRYPTION_KEY` that decrypts them (in `.env` on the
   same disk). Any host compromise (SSH weakness, unpatched Pi OS, physical access, SD-card
   theft) yields both the ciphertext and the key — i.e., plaintext Gmail credentials and full
   transaction history. Encryption-at-rest only helps against DB theft *without* the key, which
   is not the case here.
2. **Background scheduler decrypts every user's Gmail password.** `scheduled_sync_all`
   (`services/sync_service.py:76-108`, wired in `gunicorn.conf.py:on_starting`) runs daily in-
   process with the ability to decrypt and use **all** users' credentials. A code-execution bug
   anywhere in the worker reaches that capability.
3. **Tunnel exposure is real exposure.** ngrok/Cloudflare Tunnel makes the app reachable by the
   entire internet; there is no network-level allowlist unless you add Cloudflare Access / an
   auth layer at the edge. The app's own auth is the only gate.
4. **Statelessness of JWT** means even a shortened TTL leaves a window where a leaked token is
   usable, and stateless tokens can't be centrally killed without the `token_version` change.
5. **Single-owner operational risk:** no backups strategy, key-rotation process, OS patching, or
   monitoring is defined in-repo; these are load-bearing for anything internet-facing.

**Recommendation:** For a personal, single-user deployment, keep registration closed, put
Cloudflare Access (or equivalent) in front of the tunnel so the app is never raw-internet-
reachable, run only as an unprivileged user (the systemd unit already sets `NoNewPrivileges` and
`PrivateTmp` — good), keep `.env` at `chmod 600` with production-only keys, and treat the Pi as
holding live Gmail credentials for backup/patching purposes. Prefer a dedicated, low-value Gmail
app password scoped as narrowly as Gmail allows.
