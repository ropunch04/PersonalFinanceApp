# Auth, User Management & Admin — Deep-Dive Audit

Read-only audit. Every claim cites `file:line`. Findings are tagged **CONFIRMED** (traced
end-to-end in code, or reproduced with a live check) or **SUSPECTED** (looks wrong, not
fully verified).

Scope: `auth/`, `models/user.py`, `routes/auth_routes.py`, `routes/admin_routes.py`,
`routes/profile.py`, `routes/helpers.py`, `limiter.py`, `config.py`, auth-relevant parts of
`app.py`, and the frontend auth/admin/account surfaces. Rows quoted from `data/master.db`
are a **local, disconnected snapshot** — `data/` is excluded from every rsync deploy, so
this is not the live Pi database. See [00-INDEX.md](./00-INDEX.md) for the full
provenance note.

---

## Overview

Stateless JWT bearer-token auth over a two-tier SQLite layout:

- **One master DB** (`data/master.db`) holds the single `users` table — identity,
  bcrypt hash, admin flag (`models/user.py:9-19`).
- **One DB per user** (`data/user_<id>_finance.db`) holds all financial data
  (`db_context.py:79-80`).

There are no sessions, no server-side token store, no refresh tokens, and no revocation
list. A token is a 7-day HS256 JWT signed with `config.SECRET_KEY`
(`auth/jwt_utils.py:7-18`), stored in `localStorage` on the client
(`frontend/src/api.js:1`). Every authenticated route derives the user id from the token
alone and uses it to select the per-user DB file.

Architecturally this is clean and the tenant-isolation story is genuinely good (see
[Per-user DB routing](#4-per-user-db-routing)). The weaknesses are almost all in the
edges: token lifecycle, input validation, error handling, and the admin surface.

### Notable structural fact: `auth/auth_db.py` is entirely dead code

`auth/auth_db.py` defines `register_user`, `authenticate_user`, `_update_last_login`,
`get_user`, `AuthError`, and a constant-time `_DUMMY_HASH` guard
(`auth/auth_db.py:12-59`). A repo-wide grep for `auth_db`, `authenticate_user`,
`register_user`, and `AuthError` outside that file returns **zero** hits. **CONFIRMED
dead.** `routes/auth_routes.py` reimplements all of it inline — and in doing so drops the
timing-attack mitigation that `auth_db.py` had (see BUG-06). `auth/__init__.py` is empty
(0 bytes).

---

## Data Model

Live schema, read from `data/master.db`:

```sql
CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    email         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0 CHECK(is_admin IN (0, 1)),
    created_at    TEXT    NOT NULL,
    last_login_at TEXT
);
```

Matches `models/user.py:9-19` exactly — no drift.

Rows in this checkout's local `data/master.db` (mtime 2026-07-22 — **a disconnected
snapshot, not the Pi's live master DB**; `data/` is excluded from every rsync deploy per
`DEPLOYMENT.md:23`, so this file has not tracked production since it was copied here):

| id | username | email | is_admin | created_at | last_login_at |
|----|----------|-------|----------|------------|---------------|
| 1 | rohitprasanna | rohit.prasanna1@gmail.com | 1 | 2026-06-08T21:22:38Z | 2026-07-19T15:39:19Z |
| 3 | debugtest | debugtest@example.com | 0 | 2026-07-19T15:34:35Z | 2026-07-23T03:00:13Z |
| 4 | smoketest2 | smoketest2@example.com | 0 | 2026-07-23T03:22:14Z | 2026-07-23T03:22:24Z |

**In this snapshot, user id 2 is gone from `users` but `data/user_2_finance.db` (plus its
`-shm` and `-wal` siblings) still exists on disk.** That demonstrates the orphaned-DB
mechanism (BUG-09 below) really occurs — `admin_routes.py:129-131` genuinely never
deletes those sibling files, which is a static-code finding independent of this snapshot.
Whether user id 2 is *currently* deleted-but-orphaned on the live Pi is unverified from
here — check `data/user_2_finance.db*` on the Pi directly before treating it as current.
Same caveat for `debugtest`/`smoketest2`: this snapshot shows them present as of
2026-07-22; whether they still exist on the Pi needs checking there, not assuming from
this file.

Observations on the model itself:

- No `updated_at`, no `token_version` / `password_changed_at` column — so there is no
  mechanism by which a password change or an admin demotion could invalidate an
  outstanding JWT (BUG-01, BUG-02).
- No `is_active` / `disabled` flag — the only way to stop a user is to delete them.
- `UNIQUE` on `username` and `email` is **byte-exact**, not case-insensitive: SQLite's
  default collation is `BINARY` (`models/user.py:12-13`). See BUG-11.
- No index beyond the implicit unique indexes. Fine at this scale.

Per-user DBs are created by `init_user_db` (`db_context.py:230-259`) with categories,
a singleton `profile` row, and zeroed budgets.

---

## Flows

### 1. Registration

Frontend → backend → DB trace:

1. `frontend/src/pages/Register.jsx:36` — `api.register(username, email, password)`.
2. `frontend/src/api.js:31-32` — `POST /api/auth/register` with a JSON body. No token
   is attached (none exists).
3. `routes/auth_routes.py:25-27` — handler, rate-limited `10 per hour` per client IP.
4. `routes/auth_routes.py:28-29` — reads `REGISTRATION_ENABLED` from `os.environ` **at
   request time**; returns 403 `"Registration is closed"` if literally `"false"`.
5. `routes/auth_routes.py:31-34` — `username` and `email` are `.strip()`ped; `password`
   is not.
6. `routes/auth_routes.py:36-40` — presence check, then `len(password) < 8`. That is the
   entire password policy.
7. `routes/auth_routes.py:42-46` — two separate uniqueness pre-checks against the master
   DB, returning **distinct** 409 messages.
8. `routes/auth_routes.py:48` — `bcrypt.hashpw(..., gensalt(rounds=12))`. **Outside** the
   `try` block that starts on line 50.
9. `routes/auth_routes.py:50-53` — `create_user` (`models/user.py:37-52`) inserts with
   `created_at = now`, `last_login_at` left NULL.
10. `routes/auth_routes.py:55` — `init_user_db(user_id)` creates
    `data/user_<id>_finance.db` and seeds it (`db_context.py:230-259`).
11. `routes/auth_routes.py:56` — `encode_token(user_id, username, is_admin=False)`.
12. `routes/auth_routes.py:57-62` — returns `201` with `{"data": {"token", "user"}}`.
13. `frontend/src/pages/Register.jsx:37-38` — `login(data.token, data.user)` writes the
    token to `localStorage` (`AuthContext.jsx:24-26`) and navigates to `/`.

Note: registration does **not** set `last_login_at`, so a freshly registered user shows
`last_login_at = NULL` even though they are logged in. Cosmetic; see BUG-19.

### 2. Login

1. `frontend/src/pages/Login.jsx:35` — `api.login(username, password)`; the field is
   labelled "Username or Email" (`Login.jsx:53`) and the backend honours both.
2. `routes/auth_routes.py:65-66` — rate-limited `20 per minute; 100 per hour` per IP.
3. `routes/auth_routes.py:72` — `get_user_by_username(identifier) or
   get_user_by_email(identifier)`. Two separate master-DB round trips on the email path.
4. `routes/auth_routes.py:73-74` — **early return** with 401 if no row. No bcrypt work
   happens. This is the timing oracle (BUG-06).
5. `routes/auth_routes.py:76-77` — `bcrypt.checkpw`; 401 on mismatch with the same
   generic message.
6. `routes/auth_routes.py:79` — `init_user_db(row["id"])` runs on **every login**. This
   re-executes the full `_SCHEMA` (`db_context.py:236`) plus `_migrate()`
   (`db_context.py:83-170`) — roughly ten speculative `ALTER TABLE` statements, each in
   its own try/except with its own `commit()`, plus the reimbursement backfill scan
   (`db_context.py:173-214`) and two aggregate queries. See BUG-16.
7. `routes/auth_routes.py:81-85` — `UPDATE users SET last_login_at = ?`.
8. `routes/auth_routes.py:87` — `encode_token(id, username, bool(is_admin))`.
9. `routes/auth_routes.py:88-98` — `200` with token + user.
10. `Login.jsx:36-37` → `AuthContext.login` → `localStorage` → `navigate("/")`.

### 3. JWT issuance and validation

**Issuance** — `auth/jwt_utils.py:11-18`:

```python
payload = {
    "sub": str(user_id),          # string, deliberately (RFC 7519 says sub is a StringOrURI)
    "username": username,
    "is_admin": is_admin,
    "exp": now + timedelta(hours=168),   # 7 days
}
jwt.encode(payload, config.SECRET_KEY, algorithm="HS256")
```

There is no `iat`, no `nbf`, no `jti`, no `iss`/`aud`. TTL is a hard-coded 168 hours
(`auth/jwt_utils.py:8`).

**Validation** — `auth/jwt_utils.py:21-24` and `auth/middleware.py:8-29`:

1. `middleware.py:11-13` — requires an `Authorization` header literally starting with
   `Bearer `; anything else → 401. `.startswith` is case-sensitive, so `bearer x` fails.
2. `middleware.py:15` — `removeprefix("Bearer ")`.
3. `middleware.py:16-19` — `decode_token` inside a bare `except Exception` → 401.
   PyJWT verifies signature and `exp` here; algorithm is pinned to a single-element list
   `["HS256"]` (`jwt_utils.py:22`), so the `alg: none` / algorithm-confusion class of
   attack is correctly blocked. **CONFIRMED good.**
4. `jwt_utils.py:23` — `payload["sub"] = int(payload["sub"])`. Coerces the string `sub`
   back to an int so the rest of the app can compare it with `int` route params and use
   it in DB path construction. A non-numeric `sub` raises `ValueError` here, which the
   `except Exception` in `middleware.py:18` converts to a clean 401. This is the
   `sub`-coercion handling and it is **correct** — but it is load-bearing and undocumented
   (see BUG-21).
5. `middleware.py:21-25` — populates `g.current_user` with `user_id`, `username`,
   `is_admin`, **all read from the token, never from the DB**.

**`require_admin`** — `auth/middleware.py:32-39` — reads `g.current_user["is_admin"]`,
i.e. the token claim. It does not re-check the DB, and it does not itself verify that
`g.current_user` exists: applied without `require_auth` first, it would raise
`AttributeError` → 500. Every current usage stacks them correctly
(`admin_routes.py:47-48`, `54-56`, `80-82`, `104-106`, `119-121`, `136-138`, `151-153`,
`166-168`), so this is latent, not live.

Decorator order matters and is right: `@admin_bp.get(...)` / `@require_auth` /
`@require_admin` produces `require_auth(require_admin(view))`, so auth runs first.

### 4. Per-user DB routing

`get_db_path(user_id)` → `f"data/user_{user_id}_finance.db"` (`db_context.py:79-80`).

Every data route resolves its connection as `get_user_db(g.current_user["user_id"])`.
Verified across `routes/transactions.py` (13 call sites), `routes/categories.py` (5),
`routes/dashboard.py` (4), `routes/sync_routes.py` (3), `routes/profile.py:39,46`, and
`routes/import_route.py:32`. **No route anywhere takes a user id from the request
path, query string, or body to select a DB.** The only user id that ever reaches
`get_db_path` on a data route comes from the verified token. **CONFIRMED: horizontal
tenant isolation is sound.**

`get_user_db` (`db_context.py:217-227`) caches the connection on Flask's `g` and the
app teardown closes it (`app.py:62-66`). The cache key is merely the presence of
`g.user_db` (`db_context.py:218`), not the user id — safe today because a request only
ever touches one user, but fragile (BUG-20).

Admin routes deliberately bypass `get_user_db` and open the target user's DB directly
with `sqlite3.connect(get_db_path(user["id"]))` (`admin_routes.py:30`), which sidesteps
that cache-key problem.

`get_user_db` will **create** a missing DB on the fly (`db_context.py:220-221`) — the
mechanism behind BUG-03's DB resurrection.

### 5. Admin user CRUD

All under `/api/admin`, all `@require_auth` + `@require_admin`, **none rate-limited**.

| Endpoint | Handler | Frontend caller |
|---|---|---|
| `GET /api/admin/users` | `admin_routes.py:46-51` | `api.js:125`, `Admin.jsx:225` |
| `POST /api/admin/users` | `admin_routes.py:54-77` | `api.js:126`, `Admin.jsx:173` |
| `PUT /api/admin/users/<id>` | `admin_routes.py:80-101` | `api.js:127`, `Admin.jsx:21` |
| `POST /api/admin/users/<id>/reset-password` | `admin_routes.py:104-116` | `api.js:128`, `Admin.jsx:34` |
| `DELETE /api/admin/users/<id>` | `admin_routes.py:119-133` | `api.js:130`, `Admin.jsx:48` |
| `POST /api/admin/users/<id>/sync` | `admin_routes.py:136-148` | `api.js:131`, `Admin.jsx:60` |
| `GET /api/admin/system` | `admin_routes.py:151-163` | `api.js:132`, `Admin.jsx:225` |
| `GET /api/admin/logs` | `admin_routes.py:166-180` | `api.js:133`, `Admin.jsx:234` |

Every admin endpoint is wired to the UI — no orphans on this surface.

`list_users` decorates each row with Gmail/sync state by opening that user's finance DB
(`admin_routes.py:28-43`) — an N+1 of file opens, with every exception swallowed into
`gmail_configured: False` (`admin_routes.py:39-42`).

Self-protection guards:
- **Delete self**: blocked, `admin_routes.py:123-124`.
- **Change own admin status**: blocked, `admin_routes.py:91-92`.
- **Demote/delete the last admin**: no explicit guard. In practice it is unreachable —
  an admin cannot demote or delete themselves, so at least one admin always survives any
  single operation. The protection is *incidental*, not intentional (BUG-14).

Both guards compare `user_id` (an `int` from Flask's `<int:user_id>` converter) with
`g.current_user["user_id"]` (an `int` thanks to `jwt_utils.py:23`). Types line up —
**CONFIRMED the guards actually fire**.

### 6. Password change

1. `frontend/src/pages/Profile.jsx:214-233` — validates only that new == confirm
   (`Profile.jsx:217-220`), then `api.changePassword` (`api.js:73-74`).
2. `routes/auth_routes.py:101-103` — `@bp.post` / `@require_auth` / `@limiter.limit("10
   per hour")`. Order means auth is checked before the limiter, so unauthenticated
   requests don't burn quota.
3. `routes/auth_routes.py:109-113` — presence, then `len(new_password) < 8`.
4. `routes/auth_routes.py:115-117` — re-reads the row by token user id and verifies the
   current password with `bcrypt.checkpw`.
5. `routes/auth_routes.py:119-120` — new bcrypt hash at cost 12, `update_password`
   (`models/user.py:101-106`).
6. Returns `{"data": {"success": True}}`. **No token rotation, no session invalidation.**

### 7. Rate limiting

`limiter.py:22` — `Limiter(_client_ip, default_limits=[], storage_uri="memory://")`.
`default_limits=[]` means **nothing is limited unless explicitly decorated.**

Only three endpoints carry limits, all in `routes/auth_routes.py`:
- `/register` — `10 per hour` (line 26)
- `/login` — `20 per minute; 100 per hour` (line 66)
- `/change-password` — `10 per hour` (line 103)

Key function `_client_ip` (`limiter.py:6-14`) prefers `CF-Connecting-IP`, falling back to
`get_remote_address()` (ProxyFix-adjusted via `app.py:35`). `CF-Connecting-IP` is
attacker-controllable if the app is ever reachable without Cloudflare in front (BUG-18).

`memory://` storage is per-worker; `gunicorn.conf.py:8` sets `workers = 2`, so effective
limits are up to 2× nominal and reset on restart. This is documented and accepted
(`limiter.py:17-21`).

---

## What Works

Traced end-to-end and verified working:

1. **Register → auto-login → per-user DB provisioning.** `Register.jsx:36` →
   `auth_routes.py:25-62` → `models/user.py:37-52` + `db_context.py:230-259` →
   `AuthContext.jsx:23-27`. A new user lands on the dashboard with a seeded,
   fully-migrated finance DB.
2. **Login by username *or* email.** `auth_routes.py:72` tries both lookups.
3. **JWT signing/verification is cryptographically correct.** HS256 with a pinned
   algorithm list (`jwt_utils.py:22`), a `SECRET_KEY` enforced at ≥32 chars at import
   time (`config.py:8-9`). Expiry is verified by PyJWT.
4. **`require_auth` / `require_admin` correctly gate every route they decorate**, in the
   right order, at all 8 admin call sites and every data route.
5. **Per-user DB isolation.** No route derives a DB path from user input. Verified across
   all 30+ `get_user_db` call sites.
6. **Admin self-protection guards fire.** Type-compatible int comparison at
   `admin_routes.py:91` and `:123`.
7. **Password change with current-password verification.** `auth_routes.py:115-120`.
8. **`last_login_at` is written on every successful login** (`auth_routes.py:81-85`) and
   surfaced by `/api/auth/me` (`auth_routes.py:136`) and the admin list
   (`models/user.py:78`). Live data confirms plausible timestamps.
9. **bcrypt cost 12** everywhere hashes are produced — `auth_routes.py:48`, `:119`,
   `admin_routes.py:67`, `:114`, `auth_db.py:12`, `:28`. Consistent and adequate for 2026.
10. **Rate limits actually apply** to login, register, and change-password.
11. **Frontend 401 auto-logout works for the *expired-token* case**: `api.js:15-23`
    clears the token and hard-navigates to `/login` when a token *was* present.
12. **Security headers are set on every response** — `nosniff`, `X-Frame-Options: DENY`,
    `Referrer-Policy`, and a CSP (`app.py:78-88`).
13. **CORS is origin-pinned, not wildcarded** (`app.py:71-76`), and does not send
    `Access-Control-Allow-Credentials` — correct for a Bearer-token API.
14. **`config.py:23-32` cross-validates `DEBUG` against `ALLOWED_ORIGIN`**, refusing to
    boot with a debug/production mismatch. Genuinely nice touch.
15. **Admin UI is fully wired** — all 8 admin endpoints have frontend callers.
16. **Committed secrets are clean**: `.env` is gitignored (`.gitignore:4`) and has no git
    history; `deploy/env.production` contains only `REPLACE_WITH_*` placeholders and
    ships `REGISTRATION_ENABLED=false` for prod.

---

## Bugs & Issues

Severity: **P0** = security/data-loss, exploitable now · **P1** = user-visible breakage or
real security weakness · **P2** = correctness/robustness · **P3** = hygiene/dead code.

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| **P0** | `auth/middleware.py:21-25` | **No DB revalidation on any request.** `g.current_user` is built purely from token claims. A user deleted at `admin_routes.py:126` keeps a working token for the remainder of its 7-day TTL. **CONFIRMED.** | Deleted users retain full API access for up to 7 days. Worse: their next request hits `get_user_db` → `db_context.py:220-221` → **`init_user_db` recreates the finance DB the admin just deleted**, resurrecting an orphan file. Deletion is not durable. |
| **P0** | `auth/middleware.py:24` + `auth/jwt_utils.py:14` | **`is_admin` is a token claim, never re-read from the DB.** Demoting a user via `admin_routes.py:95` does not affect their outstanding token. **CONFIRMED.** | A demoted admin keeps full admin powers — create/delete users, reset any password, read logs — for up to 7 days. There is no way to revoke it short of rotating `SECRET_KEY` (which logs everyone out). |
| **P0** | `routes/auth_routes.py:48`, `:76`, `:116`, `:119`; `admin_routes.py:67`, `:114` | **bcrypt 5.0.0 raises `ValueError` on passwords > 72 bytes** — verified live: `ValueError: password cannot be longer than 72 bytes`. `auth_routes.py:48` and `admin_routes.py:67` sit *outside* their `try` blocks; `:76`, `:116`, `:119`, `:114` have no guard at all. **CONFIRMED (reproduced against the project venv).** | Any request with a >72-byte password → unhandled `ValueError` → **HTTP 500**. On login this is trivially triggerable by anyone, unauthenticated. In prod (`DEBUG=false`) the 500 body is HTML, which then crashes the frontend's JSON parse (see next row) into an unreadable error. A user who registers via some other path with a long password can be permanently unable to log in. |
| **P1** | `frontend/src/api.js:14` | **`await res.json()` runs unconditionally before any status check.** Verified live that Flask-Limiter 4.1.1 returns 429 as `text/html`, and Flask's 500/413 handlers do the same. **CONFIRMED.** | Every 429, 500, and 413 becomes an unhandled `SyntaxError` in the fetch layer. The user sees `Unexpected token '<', "<!doctype "... is not valid JSON` instead of "Too many attempts, try again later." Hitting the login rate limit produces gibberish. |
| **P1** | `frontend/src/context/AuthContext.jsx:12-21` + `frontend/src/api.js:19-20` | **Request loop on expired token.** `api.js:19-20` returns `undefined` after starting a `window.location.href` redirect. `AuthContext` does `.then(setUser)` → `setUser(undefined)` → `user` stays falsy → the `[token, user]` effect re-fires → `api.me()` again, repeating until the browser completes navigation. **CONFIRMED by trace.** | A burst of `/api/auth/me` requests on every expired-token page load. Burns the (unlimited) `/me` endpoint and can race the navigation. |
| **P1** | `frontend/src/api.js:15-23` | **No token-refresh mechanism anywhere, and expiry is a hard page reload.** The only handling is "401 → wipe token → `window.location.href = '/login'`". No refresh token, no sliding expiry, no proactive `exp` check. **CONFIRMED.** | Every 7 days, without warning, a user is thrown to the login screen mid-action with **unsaved form state destroyed** (`window.location.href` is a full document navigation, not a router navigate). No "your session expired" message is shown. |
| **P1** | `routes/admin_routes.py:104-116` | **Admin password reset has no length/complexity validation and no existence check.** Line 111 only checks non-empty; the 8-char floor enforced at `auth_routes.py:112` is absent. `update_password` (`models/user.py:101-106`) is a bare `UPDATE` that silently affects 0 rows for a nonexistent id. **CONFIRMED.** | An admin can set a 1-character password (only `Admin.jsx:142`'s `minLength={8}` stands in the way, and that is client-side only — trivially bypassed via the API). `POST /api/admin/users/9999/reset-password` returns `{"success": true}` for a user that does not exist. |
| **P1** | `routes/admin_routes.py:54-77` | **Admin user creation has no password length validation** (line 61-67) and **no email format validation**. The `min 8` rule from registration is not applied. **CONFIRMED.** | Admins can create accounts with 1-char passwords or malformed emails via the API. `Admin.jsx:190` even sets `type="text"` on the email input, so the browser doesn't validate it either. |
| **P1** | `models/user.py:83-98` (called from `admin_routes.py:95`) | **`update_user` returns `dict(row)` where `row` is `None` for a nonexistent user id** → `TypeError` → unhandled 500. Also **no validation of the values**: `username` or `email` can be set to `""`, and `is_admin` is written through unchecked (a non-0/1 value trips the `CHECK` constraint → generic 409). **CONFIRMED.** | `PUT /api/admin/users/9999` with any valid field → HTTP 500. An admin can blank out a user's username, after which that user can never log in by username again. |
| **P1** | `routes/admin_routes.py:129-131` | **User deletion removes only `user_<id>_finance.db`, not the `-wal` and `-shm` siblings**, and does nothing about the still-valid token (see P0 row 1). **CONFIRMED in code and reproduced in a local snapshot** (`data/user_2_finance.db`, `-shm`, and `-wal` all exist there for a user id absent from that snapshot's `users`; whether that specific case is still true on the live Pi is unverified). | Orphaned files accumulate. Worse, since ids come from `AUTOINCREMENT` they are never reused — but if a DB is ever restored or ids are ever reset, a new user would inherit a previous user's stale WAL/SHM state. Financial data survives "deletion" on disk indefinitely. |
| **P1** | `app.py:83` | **CSP allows `'unsafe-inline'` *and* `'unsafe-eval'` in `script-src`.** Combined with the JWT living in `localStorage` (`api.js:1,4`), the CSP provides essentially no XSS containment. **CONFIRMED.** | Any XSS — including one injected via a merchant name or category name rendered somewhere — yields the full 7-day admin token, exfiltrable to any origin (`connect-src` blocks cross-origin `fetch`, but an `img-src`/navigation side channel or the `cloudflareinsights.com` allowance remain). |
| **P1** | `routes/auth_routes.py:73-77` | **Username-enumeration timing oracle.** When the user does not exist, the handler returns at line 74 *without performing any bcrypt work*; when the user exists, it burns a full cost-12 bcrypt comparison (~250 ms). The mitigation for exactly this — comparing against `_DUMMY_HASH` — exists in `auth/auth_db.py:12,35-41` but that module is **dead code**. **CONFIRMED.** | Trivially measurable ~250 ms difference reveals whether a username/email is registered. |
| **P1** | `routes/auth_routes.py:43` vs `:46` | **Account enumeration via distinct registration errors**: `"Username already taken"` (409) vs `"Email already registered"` (409). **CONFIRMED.** | An attacker can confirm whether any given email address has an account, and the `10 per hour` register limit (line 26) only slows it. |
| **P2** | `routes/auth_routes.py:42-51` | **TOCTOU race in registration.** The uniqueness checks at lines 42-46 are separate statements from the `INSERT` at line 51, on separate connections (`models/user.py:56,61,44`). Two concurrent registrations for the same username both pass the check; one hits the `UNIQUE` constraint, is caught by the broad `except Exception` at line 52, and returns a misleading generic **500 `"Registration failed"`**. **CONFIRMED.** | Rare, but produces a 500 and an opaque error for a condition that should be a clean 409. The DB constraint saves correctness; only the error handling is wrong. |
| **P2** | `models/user.py:12-13`; `routes/auth_routes.py:32-33`, `:72` | **Email and username uniqueness are case-sensitive, and neither is normalized.** SQLite's default `BINARY` collation means `Alice@example.com` and `alice@example.com` are two distinct accounts. Login by email (`:72`) is likewise exact-match. **CONFIRMED.** | Two accounts can exist for one real mailbox. A user who registered as `Alice@…` and later types `alice@…` at login gets "Invalid credentials" with no hint why. Note the enumeration guard (BUG-06/07) is also weakened: an attacker can probe casings. |
| **P2** | `routes/auth_routes.py:33` | **No email format validation at all** — `email` is only `.strip()`ped. `Register.jsx:68` uses `type="email"` so browsers catch the obvious cases, but the API accepts `"notanemail"`. `Admin.jsx:190` uses `type="text"`, so the admin path has no validation on either side. **CONFIRMED.** | Garbage emails in the master DB; no path to a future password-reset-by-email feature. |
| **P2** | `routes/auth_routes.py:39-40`, `:112-113` | **Password policy is `len >= 8` and nothing else.** No complexity, no breach-list check, no maximum (see the 72-byte P0). Also no username validation whatsoever — length, charset, or reserved names. **CONFIRMED.** | `password` and `12345678` are both accepted. Combined with a 7-day token and no lockout beyond the IP-keyed limiter, weak passwords are the realistic attack path. |
| **P2** | `routes/auth_routes.py:120` (and the absence of any `token_version` column) | **Changing your password does not invalidate existing tokens.** `update_password` only rewrites the hash. **CONFIRMED.** | The canonical "I think someone has my account" remedy does not work. An attacker holding a stolen token keeps access for the full 7 days after the victim changes their password. |
| **P2** | `limiter.py:22` (`default_limits=[]`) | **No rate limit on `/api/auth/me` (`auth_routes.py:124`) or on any admin route** (`admin_routes.py:46,54,80,104,119,136,151,166). **CONFIRMED.** | `POST /api/admin/users/<id>/reset-password` is unthrottled. `/api/auth/me` is unthrottled and, per BUG-04, can be hit in a loop. |
| **P2** | `frontend/src/pages/Admin.jsx:217-222` | **Client-side JWT decoding with `atob` on a base64url payload.** `atob` throws on the `-` and `_` characters that base64url produces, and the `catch {}` at line 221-222 silently swallows it, leaving `currentUserId = null`. **CONFIRMED fragile / SUSPECTED intermittent failure** (whether it throws depends on the byte content of the specific token's payload). The page never touches `useAuth()`, which already holds `user.id`. | When it fails, `isSelf` is `false` for *every* row (`Admin.jsx:69`): the admin sees a Delete button and an Admin checkbox on their own row. The server correctly rejects both (`admin_routes.py:91`, `:123`), so the outcome is a confusing `alert()` rather than a breach — but the UI is lying. |
| **P2** | `routes/admin_routes.py:72`, `:99` | **Raw exception strings are returned to the client** as the error body: `_err(str(e), 409)`. **CONFIRMED.** | The user sees SQLite internals like `UNIQUE constraint failed: users.email`. That leaks schema details and, in the create-user case, confirms whether an email is already registered. Also, *every* exception is coerced to 409, so a genuine disk error reports as a conflict. |
| **P2** | `routes/auth_routes.py:79` | **`init_user_db` runs on every single login**, re-executing the whole schema script plus `_migrate()` — ~10 speculative `ALTER TABLE`s each with its own `commit()`, the reimbursement backfill scan (`db_context.py:173-214`), and two aggregate queries. **CONFIRMED.** | Every login does a pile of writes to the user's finance DB. Slow logins, needless WAL churn, and if that DB is locked by a concurrent sync, login itself 500s (there is no try/except around line 79). Migration belongs at startup or behind a version check, not on the login path. |
| **P2** | `models/user.py:22-28` and all its callers; `auth/auth_db.py:50-54`; `routes/auth_routes.py:81-85` | **`with sqlite3.connect(...) as conn` commits but does *not* close the connection.** Every function in `models/user.py` uses this pattern and none calls `conn.close()`. **CONFIRMED.** | Each master-DB operation leaks a connection until CPython's refcounting collects it. Practically survivable on CPython, but it is an unbounded-in-principle file-descriptor leak, it defeats `PRAGMA` reuse, and it will misbehave under any non-refcounting runtime. |
| **P2** | `frontend/src/main.jsx:9` **and** `frontend/src/App.jsx:110` | **`AuthProvider` is mounted twice**, nested. The inner one wins for all consumers, but the outer one independently runs its `useEffect` and fires its own `api.me()`. **CONFIRMED.** | Two `/api/auth/me` requests on every page load. Two independent copies of auth state; `logout()` called on the inner provider leaves the outer one still holding a `token` in state (harmless today only because nothing consumes the outer). Dead, confusing, and a latent source of "logged out but still shows logged in". |
| **P2** | `frontend/src/App.jsx:88` | **`/admin` is gated by `ProtectedRoute`, not by an admin check.** Any authenticated non-admin can navigate to `/admin` and render the page. `BottomNav` hides the *link* (`App.jsx:72`) but the route is reachable directly. **CONFIRMED.** | Non-admin sees the Admin page chrome, then a bare `Forbidden` error box (`Admin.jsx:244-249`) after the API rejects it. Server-side authz is correct — this is a UX/leak-of-existence issue, not a privilege escalation. |
| **P2** | `frontend/src/components/ProtectedRoute.jsx:5-6` | **`isAuthenticated` is just `!!token`** (`AuthContext.jsx:36`) — the `exp` claim is never inspected client-side, and there is no `loading` state while `api.me()` is in flight. **CONFIRMED.** | With an expired token the app renders the full protected UI, fires its data requests, gets 401s, and *then* hard-redirects. The user sees a flash of empty dashboard before being bounced. |
| **P3** | `auth/auth_db.py:1-59` (whole file) | **Entire module is dead code.** Zero importers repo-wide. It duplicates registration, authentication, and last-login logic that `routes/auth_routes.py` reimplements inline — and its version is *better* (constant-time dummy-hash comparison at lines 12, 35-41). **CONFIRMED.** | Maintenance hazard: a future fix applied here would have no effect. It also makes the timing-attack fix look like it is already in place when it is not. |
| **P3** | `routes/admin_routes.py:91-92`, `:123-124` | **No explicit last-admin guard.** Only self-targeting is blocked. Losing all admins requires an admin to demote/delete themselves, which is blocked — so it is unreachable today, but by accident rather than by design. **CONFIRMED (guard absent; exploit path not reachable).** | If the self-guards are ever relaxed, or a "bulk demote" is added, the system can be locked out of its own admin surface with no recovery path short of direct SQLite access. |
| **P3** | `routes/admin_routes.py:170`, `:179` | **`lines` query param is unbounded and unvalidated.** `all_lines[-n:]` with a negative `n` (e.g. `?lines=-5`) evaluates to `all_lines[5:]` — returning nearly the whole file instead of a tail. **CONFIRMED.** | Confusing behaviour; memory is bounded only because `RotatingFileHandler` caps the file at 1 MB (`app.py:55`). Admin-only, so low risk. |
| **P3** | `db_context.py:80` | **`get_db_path` returns a relative path** (`data/user_N_finance.db`), so every DB operation depends on the process CWD. `app.py:54` (`os.makedirs("logs")`) and `db_context.py:231` have the same dependency. **CONFIRMED.** | Under systemd/gunicorn without an explicit `WorkingDirectory`, the app silently creates a *fresh empty* `data/` tree elsewhere rather than failing loudly. Contrast `models/user.py:7`, which correctly derives an absolute-ish path from `config.DB_PATH`. |
| **P3** | `routes/admin_routes.py:39-42` | **`_user_with_finance` swallows every exception** into `gmail_configured: False`. **CONFIRMED.** | A corrupt or locked user DB is indistinguishable from "Gmail not set up" in the admin list. Silently misleading. |
| **P3** | `app.py:78-88` | **No `Strict-Transport-Security` header**, and no `Permissions-Policy`. **CONFIRMED.** | Behind a Cloudflare Tunnel HSTS is likely supplied at the edge, but the app itself does not assert it. Low risk given the deployment, worth noting. |
| **P3** | `routes/auth_routes.py:57-62`, `:88-98`, `:121`, `:130-138` vs `routes/helpers.py:4-9` | **Two different response envelopes.** `helpers._ok` emits `{"data": ..., "error": None}`; `auth_routes` hand-rolls `{"data": {...}}` with no `error` key, and its errors are bare `{"error": "..."}` with no `data` key. **CONFIRMED.** | `api.js:24-25` tolerates both, so nothing breaks today. But any consumer that checks `json.error !== null` will misbehave, and it makes the auth blueprint the odd one out. |
| **P3** | `auth/jwt_utils.py:23` | **The `sub` string→int coercion is load-bearing and undocumented.** `admin_routes.py:91` and `:123` compare `g.current_user["user_id"]` against an `int` route param; `db_context.py:80` interpolates it into a filename. If this line were removed, both admin self-guards would silently stop matching (`"1" != 1`). **CONFIRMED correct today; flagged as fragile.** | A one-line change with no test coverage would silently disable the self-delete and self-demote guards. Deserves a comment and a test. |
| **P3** | `models/user.py:37-52`; `routes/auth_routes.py` | **`last_login_at` is not set at registration** — a user who just registered and is holding a valid token shows `last_login_at = NULL`. **CONFIRMED** (contrast `auth_routes.py:81-85` on the login path). | Admin list shows "never" for an active brand-new user. Cosmetic. |
| **P3** | `auth/middleware.py:15` | `removeprefix("Bearer ")` does not strip surrounding whitespace, and `startswith` at line 12 is case-sensitive. **CONFIRMED.** | `bearer <token>` (lowercase) and `Bearer  <token>` (double space) are rejected with a bare 401. Non-conformant with RFC 6750, which specifies a case-insensitive scheme. Only matters for third-party/CLI clients. |
| **P3** | `frontend/src/api.js:110-121` | The `importTransactions` path duplicates the 401 handling from `request()` but **omits the `hadToken` check** (`api.js:113-117`), so it always redirects. Also parses JSON before checking status, same as BUG-03. **CONFIRMED.** | Divergent copy of auth logic that will drift from `request()`. Minor today. |

### Not bugs — checked and cleared

- **JWT algorithm confusion / `alg: none`**: blocked. `jwt_utils.py:22` pins
  `algorithms=["HS256"]`.
- **Horizontal privilege escalation (user A reading user B's finances)**: not possible.
  No data route accepts a user id from the request.
- **Admin `require_admin` bypass by decorator ordering**: correct at all 8 sites.
- **CORS wildcard / credential leakage**: `app.py:71-76` reflects only an exact match on
  `ALLOWED_ORIGIN` and never sets `Allow-Credentials`.
- **Secrets in git**: `.env` is gitignored with no history; `deploy/env.production` has
  placeholders only.
- **SQL injection**: all user-supplied values are parameterized. The two f-string
  `SET` clauses (`models/user.py:88,91` and `routes/profile.py:54,56`) build column names
  from a hardcoded allowlist (`models/user.py:84`; `profile.py:49` — an *empty* set), not
  from user input. Safe, though `profile.py:49-58` is now effectively dead: `scalar_fields`
  is empty, so `updates` is always empty and the `UPDATE profile` branch never executes.
- **Path traversal in the SPA catch-all** (`app.py:102-108`): Werkzeug normalizes `..`
  before routing and `send_from_directory` re-validates. Safe.

---

## UX Gaps

1. **No "forgot password" anywhere.** Grepped `frontend/src` and `routes/` for
   `forgot`/`reset.*email`/`verify.*email` — zero hits. The only recovery path is asking
   an admin to use `POST /api/admin/users/<id>/reset-password`
   (`admin_routes.py:104`). For a single-owner app that is defensible; for anyone else it
   means a locked-out user is permanently locked out. `Login.jsx:85-87` offers only a
   "Create one" link.
2. **Session expiry is silent and destructive.** `api.js:19` does
   `window.location.href = "/login"` — a full page navigation with no message, no
   "your session expired", and no return-to-where-you-were. Any in-progress form
   (a transaction being edited, a budget being set) is lost. There is no warning as the
   7-day expiry approaches, and no refresh to avoid it.
3. **Rate-limit and server errors are unreadable.** Because of BUG-03, hitting the login
   limiter shows the raw JSON-parse error rather than "Too many attempts." Same for any
   500 or the 10 MB upload cap (`app.py:38`).
4. **No email format feedback on the admin create-user form.** `Admin.jsx:190` uses
   `type="text"` for the email field — no browser validation, and the server does not
   validate either (BUG-13).
5. **Admin errors use `alert()`.** `Admin.jsx:24`, `:37`, `:50`. Blocking, unstyled,
   inconsistent with the `msg msg-error` pattern used everywhere else
   (e.g. `Admin.jsx:202`, `Login.jsx:78`).
6. **Admin password reset gives no success feedback.** `Admin.jsx:30-42` clears the field
   and collapses the form on success (`:35-36`) — indistinguishable from the user
   cancelling. Contrast the sync action, which does report (`Admin.jsx:61`).
7. **No password strength meter or requirement text on registration.** `Register.jsx:74-88`
   shows only `minLength={8}` on the input; the rule is never stated to the user. The
   admin create form does better (`Admin.jsx:192` placeholder says "min 8 chars").
8. **No confirm-password field on registration.** `Register.jsx:74-88` — a typo in the
   only password field creates an account nobody can log into. The change-password form
   *does* have confirmation (`Profile.jsx:513-518`), so the pattern exists and was simply
   not applied here.
9. **No confirmation on admin toggle.** `Admin.jsx:104-109` — a single mis-click on the
   checkbox grants or revokes admin instantly, with no confirm dialog (delete gets one at
   `Admin.jsx:45`).
10. **No `loading` state in `AuthContext`.** `AuthContext.jsx:8-21` exposes only
    `token`/`user`. On a refresh with a valid token, `user` is `null` until `me()`
    resolves, so `BottomNav` (`App.jsx:72`) briefly hides the Admin tab and
    `Profile.jsx:473-484` briefly renders an empty account card.
11. **Users cannot edit their own email or username.** `Profile.jsx:468-537` shows them as
    read-only text; the only mutation is `PUT /api/admin/users/<id>`, which requires an
    admin. There is also no self-service account deletion.
12. **No visible indication that registration is closed.** When
    `REGISTRATION_ENABLED=false` (as `deploy/env.production:16` sets for prod), the
    `/register` route still renders a full form (`App.jsx:81`) and `Login.jsx:86` still
    advertises "Create one" — the user only discovers it after filling everything in and
    getting a 403 (`auth_routes.py:29`). There is no endpoint exposing the flag, so the
    frontend *cannot* know.
13. **No logged-in-user redirect away from `/login`.** `App.jsx:80-81` — an authenticated
    user visiting `/login` sees the login form rather than being sent to `/`.
14. **`user` shape differs by code path.** After login, `AuthContext.user` comes from
    `auth_routes.py:90-96` (no `last_login_at`); after a refresh it comes from
    `auth_routes.py:130-137` (*with* `last_login_at`). Any component reading
    `user.last_login_at` would work only after a refresh.
15. **Log viewer has no search, no follow, no level filter, and a hardcoded 100-line
    fetch** (`Admin.jsx:234`), despite the endpoint accepting a `lines` param
    (`admin_routes.py:170`).

---

## Notes for Future Integrations

**If you touch nothing else, fix these three first:** the >72-byte bcrypt 500 (P0, six
call sites, unauthenticated trigger), the `res.json()`-before-status-check in
`api.js:14` (P1, makes every rate-limit and server error unreadable), and the fact that
deleting a user neither revokes their token nor durably removes their data (P0).

**Adding token revocation** is the single highest-leverage change. The minimal version:
add a `token_version INTEGER NOT NULL DEFAULT 0` column to `users`, include it in the JWT
payload (`auth/jwt_utils.py:12-17`), and compare it against the DB in
`auth/middleware.py:20` — one indexed lookup per request, which at this scale is free.
Bump it on password change (`auth_routes.py:120`), on admin demotion
(`admin_routes.py:95`), and on delete. That single change closes the deleted-user,
demoted-admin, and stolen-token-survives-password-change holes at once. The same DB read
lets `require_admin` (`middleware.py:35`) consult the live `is_admin` instead of a
7-day-old claim.

**Before adding a "forgot password" flow**, the email column needs work: normalize to
lowercase on write (`auth_routes.py:33`, `admin_routes.py:60`), backfill and dedupe the
existing rows, add a `COLLATE NOCASE` unique index, and add real format validation. As it
stands, a reset-by-email feature could match two different accounts.

**`auth/auth_db.py` should be deleted, but harvest it first.** Its `_DUMMY_HASH` pattern
(`auth_db.py:12, 35-41`) is exactly the fix for the login timing oracle (BUG-06) — port it
into `routes/auth_routes.py:72-77` before removing the file.

**`init_user_db` on every login (`auth_routes.py:79`) needs to go** before any work that
increases login volume or DB size. Introduce a `schema_version` row in each user DB and
have `_migrate` (`db_context.py:83-170`) short-circuit on it; run migrations at startup or
on first `get_user_db` per process, not per login.

**Anything that adds a second admin-facing writer** should first make
`get_user_db`'s cache key include the user id (`db_context.py:218`). Today it keys only on
`"user_db" not in g`, which is safe solely because no request ever touches two users' DBs.
`admin_routes.py:30` already works around this by opening connections directly — a pattern
that should be replaced with a proper `get_db_for(user_id)` helper rather than duplicated.

**If the app ever gains a second frontend or a mobile client**, `require_auth`
(`middleware.py:11-15`) needs a case-insensitive `Bearer` check, the response envelope
needs unifying on `routes/helpers.py` (`auth_routes.py` is currently the outlier), and the
`/api/auth/me` endpoint needs a rate limit.

**If registration is ever opened to the public**, the following become blocking rather
than cosmetic: password policy beyond `len >= 8` (`auth_routes.py:39`), email
verification, account enumeration via distinct 409s (`auth_routes.py:43,46`), the login
timing oracle, per-account (not just per-IP) login throttling, and account lockout. The
IP-keyed `memory://` limiter (`limiter.py:22`) with 2 gunicorn workers
(`gunicorn.conf.py:8`) is not adequate for an open registration surface — it needs a
shared Redis backend, as `limiter.py:17-21` already anticipates.

**Do not add anything that renders user-supplied strings as HTML** while
`script-src 'unsafe-inline' 'unsafe-eval'` stands (`app.py:83`) and the token lives in
`localStorage` (`api.js:1`). Either tighten the CSP (Vite can emit hashed/nonced scripts)
or move the token to an `HttpOnly; SameSite=Strict` cookie — the latter also requires CSRF
protection, which the app currently needs none of precisely because it uses bearer tokens.

**Housekeeping to check on the live Pi (not confirmed current from this checkout — see
the provenance note in [00-INDEX.md](./00-INDEX.md))**: whether `user_2_finance.db`
(+ `-shm`, `-wal`) is still orphaned there, and whether the `debugtest` (id 3) and
`smoketest2` (id 4) accounts are still present with working credentials — if so, delete
them. `routes/profile.py:49-58` is dead (`scalar_fields` is an empty set, so the `UPDATE profile`
branch is unreachable) and should be removed or completed.
