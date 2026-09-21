# 05 — Platform: Data Access, App Shell, Build, PWA, Deploy, Tooling

Read-only audit. Every finding is tagged **CONFIRMED** (verified by reading the file or
running the command) or **SUSPECTED** (inferred, would need a runtime test).

Working dir: `/Users/rohitprasanna/Documents/Projects/FinanceApps/PersonalFinanceApp`
Audit date: 2026-09-08. HEAD: `20f7f41 fix` (2026-08-23), branch `main`, tree clean.

---

## Overview

The platform layer is a small, hand-rolled Flask + SQLite stack with no framework
scaffolding for the things that usually bite in production: no migration tool, no test
suite, no CI, no backup automation, no error monitoring. It works, and several parts
(systemd hardening, the Cloudflare Tunnel ingress, ProxyFix + `CF-Connecting-IP` rate
limiting, the config startup guard) are genuinely well done. But the data layer runs its
entire migration script on **every single request**, the PWA is a shell with no manifest
and no service worker, and the React tree mounts `AuthProvider` twice.

**Component map (all CONFIRMED by reading the files):**

| Concern | Where | State |
|---|---|---|
| Per-user SQLite routing | `db_context.py` | Works; heavy per-request cost |
| Master users DB | `models/user.py` | Works; connections never closed |
| App shell / config / CSP | `app.py`, `config.py` | Works; CSP weak, no cache headers |
| Rate limiting | `limiter.py` | Correct behind CF; in-memory, per-worker |
| WSGI | `gunicorn.conf.py` | 2 sync workers; scheduler in arbiter |
| Deploy | `deploy/*.service`, `deploy/cloudflared-config.yml` | Solid |
| Frontend build | `frontend/vite.config.js` | Stock Vite, 715 KB single chunk |
| PWA | `InstallPrompt.jsx`, `usePwaSync.js`, `OnlineContext.jsx` | Half-built |
| CI | `.github/workflows/` | **Empty directory** |
| Tests | anywhere | **None exist** |

---

## Data Layer (full schema as code defines it)

### Physical layout

- `models/user.py:7` — `MASTER_DB = Path(config.DB_PATH).parent / "master.db"`. With the
  default `DB_PATH=data/finance.db` this resolves to `data/master.db`. Note `DB_PATH`
  itself is **never opened by anything** — only its parent directory is used. `config.py:13`
  defines it; grep shows no other consumer. (CONFIRMED — `DB_PATH` referenced only in
  `config.py:13` and `models/user.py:7`.)
- `db_context.py:79-80` — `get_db_path(user_id) -> f"data/user_{user_id}_finance.db"`.
  This is a **relative path**, so correctness depends entirely on the process CWD. The
  systemd unit sets `WorkingDirectory=/home/rohitpras/PersonalFinanceApp`
  (`deploy/finance-app.service:11`), so it works in prod — but any invocation from another
  CWD silently creates a *new empty* database rather than erroring. (CONFIRMED)

### `data/master.db` — schema exactly as defined (`models/user.py:9-19`)

```sql
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    email         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0 CHECK(is_admin IN (0, 1)),
    created_at    TEXT    NOT NULL,
    last_login_at TEXT
);
```

There is **no `_migrate()` equivalent for master.db** — `init_master_db()`
(`models/user.py:31-34`) only runs `executescript(SCHEMA)`. Adding a column to `users`
genuinely does require the manual `ALTER TABLE` documented in `README.md:453-459`.
(CONFIRMED)

### `data/user_{id}_finance.db` — schema exactly as defined (`db_context.py:19-76`)

**`categories`** (`db_context.py:20-25`)

| Column | Type | Constraints |
|---|---|---|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT |
| `name` | TEXT | NOT NULL UNIQUE |
| `sort_order` | INTEGER | NOT NULL DEFAULT 0 |
| `is_misc` | INTEGER | NOT NULL DEFAULT 0 |

**`transactions`** (`db_context.py:27-43`)

| Column | Type | Constraints |
|---|---|---|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT |
| `amount` | REAL | NOT NULL |
| `merchant_raw` | TEXT | — |
| `direction` | TEXT | NOT NULL CHECK IN ('inflow','outflow') |
| `category_id` | INTEGER | REFERENCES categories(id) |
| `notes` | TEXT | — |
| `transaction_at` | TEXT | NOT NULL (ISO string) |
| `created_at` | TEXT | NOT NULL |
| `source_hash` | TEXT | UNIQUE (dedup key) |
| `reimburses_id` | INTEGER | REFERENCES transactions(id) — **legacy** |
| `reimbursement_status` | TEXT | CHECK IN ('partial','expensed') — **legacy** |
| `reimbursement_mode` | TEXT | CHECK IN ('flat','percent') — **legacy** |
| `reimbursement_value` | REAL | — **legacy** |
| `expected_reimbursement` | REAL | — |
| `reimbursement_external` | INTEGER | NOT NULL DEFAULT 0 |

**`reimbursement_links`** (`db_context.py:51-57`, duplicated at `db_context.py:145-153`)

| Column | Type | Constraints |
|---|---|---|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT |
| `inflow_id` | INTEGER | NOT NULL REFERENCES transactions(id) ON DELETE CASCADE |
| `outflow_id` | INTEGER | NOT NULL REFERENCES transactions(id) ON DELETE CASCADE |
| `amount` | REAL | NOT NULL CHECK(amount > 0) |
| `created_at` | TEXT | NOT NULL |

**`profile`** (`db_context.py:59-66`) — single-row table, `CHECK(id = 1)`

| Column | Type | Constraints |
|---|---|---|
| `id` | INTEGER | PRIMARY KEY CHECK(id = 1) |
| `gmail_address` | TEXT | — |
| `gmail_app_password_enc` | TEXT | Fernet ciphertext |
| `last_synced_at` | TEXT | — |
| `created_at` | TEXT | NOT NULL |
| `updated_at` | TEXT | NOT NULL |

**`budgets`** (`db_context.py:68-75`)

| Column | Type | Constraints |
|---|---|---|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT |
| `category_id` | INTEGER | NOT NULL REFERENCES categories(id), UNIQUE |
| `amount` | REAL | NOT NULL DEFAULT 0 |
| `period` | TEXT | NOT NULL DEFAULT 'monthly' CHECK IN ('monthly','yearly') |
| `fold_into_misc` | INTEGER | NOT NULL DEFAULT 0 |

**Indexes: there are none.** No `CREATE INDEX` statement exists anywhere in the repo.
Only the implicit indexes from `UNIQUE`/`PRIMARY KEY` (`transactions.source_hash`,
`categories.name`, `budgets.category_id`). Every dashboard query that filters on
`transaction_at`, `direction`, or `category_id` is a full table scan. (CONFIRMED —
`grep -rn "CREATE INDEX" .` over the tracked tree returns nothing.)

**Seed data** (`db_context.py:7-17, 241-256`): 9 default categories (Dining, Groceries,
Travel, Entertainment, Shopping, Housing, Transportation, Health & Personal Care, Other),
"Other" flagged `is_misc=1`, one `profile` row with `id=1`, and one zero-amount `budgets`
row per category.

### Connection lifecycle

`db_context.py:217-227`:

```python
def get_user_db(user_id: int) -> sqlite3.Connection:
    if "user_db" not in g:
        db_path = get_db_path(user_id)
        if not Path(db_path).exists():
            init_user_db(user_id)
        conn = sqlite3.connect(db_path, timeout=15)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        _migrate(conn)
        g.user_db = conn
    return g.user_db
```

- Cached on Flask's request-scoped `g` under the fixed key `"user_db"` — **the `user_id`
  is not part of the cache key.** If any request ever calls `get_user_db()` for two
  different users, the second call silently returns the first user's database. Today all
  38 call sites pass `g.current_user["user_id"]` (CONFIRMED by grep across
  `routes/`, `services/`, `auth/`), so this is latent, not live — but it is a
  cross-user data leak waiting for the first admin "act as user" feature.
  (CONFIRMED as a latent defect.)
- Closed in `app.py:62-66` via `@app.teardown_appcontext`. Correct — one connection per
  request, closed at request end. No pooling, which is fine for SQLite.
- `timeout=15` is the SQLite busy timeout (15 s) — reasonable for WAL contention.
- **`PRAGMA journal_mode=WAL` is NOT set here.** It is set only in `init_user_db`
  (`db_context.py:235`) and `models.user._connect` (`models/user.py:25`). WAL is a
  *persistent* property of the database file, so once set it survives — but a user DB
  created by any path that skips `init_user_db` would silently run in rollback-journal
  mode. `services/sync_service._open_user_db` (`services/sync_service.py:13-17`) and
  `routes/admin_routes.py:30` also open connections **without** setting WAL.
  (CONFIRMED; impact SUSPECTED-low because every DB is created via `init_user_db`.)

### Schema-init idempotency

`init_user_db` (`db_context.py:230-259`) is genuinely idempotent: `CREATE TABLE IF NOT
EXISTS`, `INSERT OR IGNORE`, and a guarded `UPDATE … AND NOT EXISTS`. It is called from
registration (`routes/auth_routes.py:55`), **login** (`routes/auth_routes.py:79`), and
admin user-create (`routes/admin_routes.py:74`). Calling it on login is what fixed the
"500 on login for pre-existing user DBs" bug (commit `60a49d8`). It closes its connection
in a `finally` (`db_context.py:258-259`). Good.

### `_migrate()` — the real migration story

`db_context.py:83-170`. This is the heart of the problem.

1. It is **called on every `get_user_db()`**, i.e. once per authenticated request
   (`db_context.py:225`). It is not guarded by a `user_version` pragma or a
   `schema_migrations` table.
2. Its structure is 9 copies of:
   ```python
   try:
       conn.execute("ALTER TABLE … ADD COLUMN …")
       conn.commit()
   except Exception:
       pass  # column already exists
   ```
   (`db_context.py:85-137`). Every one of those raises `OperationalError` on every
   request after the first deploy. Nine caught exceptions, plus:
3. `db_context.py:140` — an unconditional
   `UPDATE transactions SET transaction_at = transaction_at || 'T00:00:00' WHERE LENGTH(transaction_at) = 10`
   **on every request**. A full table scan + write transaction, forever.
4. `db_context.py:145-154` — `CREATE TABLE IF NOT EXISTS reimbursement_links` + `commit()`,
   duplicating the definition already in `_SCHEMA` (`db_context.py:51-57`). Two sources of
   truth for one table; they currently agree, but nothing enforces that.
5. `db_context.py:156` — `_migrate_reimbursements(conn)`, which itself runs
   `SELECT COUNT(*) FROM reimbursement_links` and a
   `SELECT … WHERE reimbursement_status IS NOT NULL AND expected_reimbursement IS NULL`
   scan on every request (`db_context.py:179, 193-199`).
6. `db_context.py:157-170` — two more scans (`SELECT id FROM categories ORDER BY …`,
   `SELECT COUNT(DISTINCT sort_order)`, `SELECT COUNT(*) … WHERE is_misc = 1`) plus
   conditional writes, on every request.

**Net cost per authenticated API call: ~9 failed DDL statements, ~5 SELECTs, and at least
one full scan of `transactions`.** On a Raspberry Pi with a growing transaction table this
is the dominant cost of a cheap endpoint. (CONFIRMED by reading; magnitude SUSPECTED —
not benchmarked.)

**The bare `except Exception: pass`** at `db_context.py:88, 93, 100, 106, 112, 118, 124,
130, 136, 142` swallows *every* failure, not just "duplicate column name" — a disk-full,
a locked database, or a genuinely malformed ALTER all vanish silently. (CONFIRMED)

**The manual-migration problem.** `README.md:444-472` says new columns need hand-run
`ALTER TABLE` on the Pi. `DEPLOYMENT.md:47-53` says the opposite — "**No manual `ALTER
TABLE` on the Pi is ever needed**". The truth is in between and neither doc states it:
adding a column requires **editing `_migrate()` to append another try/except block** and
redeploying. Nothing is automatic; the automation is a hand-maintained, ever-growing,
never-pruned list. There is no Alembic, no `yoyo`, no `user_version` tracking, and no way
to roll a migration back. (CONFIRMED — the two docs directly contradict each other.)

### Transaction / commit discipline

- Routes call `db.commit()` explicitly (19 call sites across `routes/` and
  `services/sync_service.py:65` — CONFIRMED by grep). Python's sqlite3 default
  `isolation_level=""` means implicit `BEGIN` before DML, so this is coherent.
- **No `rollback()` anywhere in the codebase** (CONFIRMED — grep for `.rollback()`
  returns zero hits). An exception mid-multi-statement write leaves the implicit
  transaction open; `teardown_appcontext` calls `conn.close()`, which discards the
  uncommitted work. That happens to be the right outcome, but it is accidental rather
  than designed, and there is no `try/except/rollback` boundary anywhere.
- Multi-statement operations (e.g. split-transaction at `routes/transactions.py:499-512`,
  category reorder at `routes/categories.py:89`) rely on this implicit behavior. A
  partial failure is silently discarded with no log and no error distinction.
  (CONFIRMED that no explicit rollback exists; SUSPECTED that some path can leave
  inconsistent committed state if a `commit()` sits mid-sequence.)
- `models/user.py` uses `with _connect() as conn:` (lines 33, 44, 56, 61, 66, 71, 77, 89,
  102, 110). **`with sqlite3.Connection` commits/rolls back but does NOT close.** These
  connections leak until garbage collection. Ten functions, every one of them.
  (CONFIRMED — this is documented sqlite3 behavior.)

### Connections vs gunicorn workers

`gunicorn.conf.py:8-10`: `workers = 2`, `preload_app = True`, no `threads` setting, so
sync workers — one request at a time per worker, 2 concurrent requests total.

- Two processes × one connection per in-flight request = at most 2 concurrent writers to
  the same SQLite file, plus the scheduler in the arbiter (see below). WAL handles
  concurrent readers + one writer; the 15 s busy timeout absorbs write contention.
  This is adequate. (CONFIRMED)
- **`preload_app = True` forks after `app.py` has executed at module level.** That means
  `init_master_db()` (`app.py:52`) and the `RotatingFileHandler` (`app.py:55`) are created
  in the master and inherited by both workers. **Two processes now hold open file handles
  on the same `logs/app.log` and will both attempt `doRollover()`** when it crosses 1 MB.
  `RotatingFileHandler` is not multi-process safe — interleaved rollovers can truncate or
  lose log lines. (CONFIRMED as a known Python stdlib limitation; concrete data loss
  SUSPECTED.)
- The long-running Gmail sync (`POST /api/sync`, `routes/sync_routes.py:34`) runs an IMAP
  fetch **synchronously inside a request**. With 2 sync workers, two users syncing at once
  blocks the entire application until `timeout = 120` (`gunicorn.conf.py:9`) kills them.
  (CONFIRMED as a design property.)

---

## App Shell & API Client

### Flask side (`app.py`)

- `ProxyFix(x_for=1, x_proto=1, x_host=1)` at `app.py:35` — correct for exactly one
  trusted hop, matching the cloudflared setup. The comment at `app.py:31-34` correctly
  documents the assumption. Good.
- `MAX_CONTENT_LENGTH = 10 MB` (`app.py:38`).
- CORS is hand-rolled in `@app.after_request` (`app.py:69-89`) plus an explicit
  `OPTIONS` handler (`app.py:92-99`). The `after_request` version checks
  `origin == config.ALLOWED_ORIGIN` before echoing (good), but the `OPTIONS` handler at
  `app.py:96` echoes `ALLOWED_ORIGIN` **unconditionally** with no origin check —
  harmless (it's a fixed value, not a reflection) but inconsistent, and it omits the
  `Vary: Origin` header that the other path sets at `app.py:76`. (CONFIRMED)
- **SPA catch-all** `app.py:102-108`:
  ```python
  @app.get("/", defaults={"path": ""})
  @app.get("/<path:path>")
  def spa(path):
      full = os.path.join(DIST_DIR, path)
      if path and os.path.isfile(full):
          return send_from_directory(DIST_DIR, path)
      return send_from_directory(DIST_DIR, "index.html")
  ```
  - `os.path.join(DIST_DIR, path)` on a user-controlled `path` is used for the
    `isfile` probe. `send_from_directory` uses `safe_join` so it will not actually
    serve outside `dist/`, but the probe itself can be steered outside the directory
    — a traversal would reach the `isfile` branch and then be rejected by
    `send_from_directory` with a 404/500 rather than falling through to the SPA.
    Not exploitable for file read; sloppy. (CONFIRMED that the probe is unsanitized;
    exploitability CONFIRMED-negative.)
  - **Unknown `GET /api/*` paths fall into this route and return `index.html` with a
    200.** Blueprints are matched first, so a real endpoint wins, but a typo'd or
    removed API path returns HTML/200 instead of 404/JSON. Combined with the api.js
    issue below, the frontend reports this as a JSON parse error. (CONFIRMED)
  - **No cache headers of any kind.** `SEND_FILE_MAX_AGE_DEFAULT` is never set
    (grep: absent from `app.py` and `config.py`), so Flask sends `ETag` +
    `Last-Modified` with **no `Cache-Control: max-age`**. Consequences:
    - Vite's content-hashed assets (`/assets/index-BW9ejKHZ.js`, 715 KB) are
      **re-validated on every page load** instead of being cached for a year. Every
      visit costs a conditional round-trip through the Cloudflare tunnel for a file
      that can never change.
    - `index.html` is **not** `no-store`. It gets an ETag, which is *mostly* the right
      behavior, but a stale intermediary could pin an old `index.html` pointing at a
      deleted hashed asset.
    (CONFIRMED)

### CSP (`app.py:81-88`)

```
default-src 'self';
script-src 'self' 'unsafe-inline' 'unsafe-eval' https://static.cloudflareinsights.com;
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src 'self' https://fonts.gstatic.com;
img-src 'self' data:;
connect-src 'self' https://cloudflareinsights.com;
```

Compatibility with the built bundle: **fine.** `frontend/dist/index.html` loads
`<script type="module" crossorigin src="/assets/…js">` and a same-origin stylesheet, plus
the Google Fonts stylesheet (`frontend/index.html:11`) which `style-src` allows and whose
`.woff2` files come from `fonts.gstatic.com` which `font-src` allows. Components use React
inline `style={{…}}` objects (not `<style>` tags), which CSP does not govern. So the page
would work even without `'unsafe-inline'`.

Weaknesses (CONFIRMED):
- `'unsafe-eval'` in `script-src` is **not needed** by a Vite production build and defeats
  a large part of the XSS protection.
- `'unsafe-inline'` in `script-src` is likewise unnecessary — `dist/index.html` has no
  inline script.
- Missing `frame-ancestors 'none'` (relying on the legacy `X-Frame-Options` at
  `app.py:79`), `base-uri 'self'`, `object-src 'none'`, and `form-action 'self'`.
- The `X-Frame-Options`/`Referrer-Policy`/`nosniff` trio at `app.py:78-80` is good.
- No `Strict-Transport-Security` header — Cloudflare can add one, but the origin does not.

### React routing (`App.jsx`)

Routes (`App.jsx:79-91`):

| Path | Element | Guard |
|---|---|---|
| `/login` | `Login` | none |
| `/register` | `Register` | none |
| `/` | `Dashboard` | `ProtectedRoute` |
| `/queue` | redirect → `/transactions?status=pending` | none |
| `/transactions` | `Transactions` | `ProtectedRoute` |
| `/insights` | redirect → `/` | none |
| `/profile` | `Profile` | `ProtectedRoute` |
| `/profile/setup` | `Profile setup` | `ProtectedRoute` |
| `/admin` | `Admin` | `ProtectedRoute` |
| `/gmail-setup` | `GmailSetup` | `ProtectedRoute` |
| `*` | redirect → `/` | none |

- **`/admin` is guarded by `ProtectedRoute` only, not by an admin check**
  (`App.jsx:88`). `ProtectedRoute` (`components/ProtectedRoute.jsx:4-8`) tests only
  `isAuthenticated`. The Admin nav item is conditionally rendered on `user?.is_admin`
  (`App.jsx:72`), but any authenticated non-admin can type `/admin` and render the page.
  The API routes behind it use `@require_admin` (`routes/admin_routes.py:48-50`), so no
  data leaks — the page just renders empty/erroring. Client-side authorization gap, not a
  data breach. (CONFIRMED)
- **`ProtectedRoute` redirects on `!isAuthenticated`, where `isAuthenticated = !!token`
  (`AuthContext.jsx:36`).** There is no "loading" state: on a hard refresh with a valid
  token in localStorage, `token` is set synchronously from `localStorage` in the
  `useState` initializer (`AuthContext.jsx:9`), so there is no flash-to-login. Good.
  But `user` is still `null` for one render while `api.me()` is in flight, so
  `user?.is_admin` is false and the Admin nav item **flickers in** after the fetch
  resolves. (CONFIRMED)
- **`AuthProvider` is mounted twice.** `main.jsx:9-11` wraps `<App/>` in
  `<AuthProvider>`, and `App.jsx:110` wraps the router in `<AuthProvider>` again. The
  inner provider wins for all `useAuth()` consumers; the outer one is dead — except that
  its `useEffect` (`AuthContext.jsx:12-21`) still fires, so **every page load issues two
  `GET /api/auth/me` requests**, and a 401 in the outer provider clears the shared
  `localStorage` token out from under the inner one. (CONFIRMED — this is the single
  most concrete app-shell bug.)
- `OnlineProvider` wraps `AuthProvider` wraps `BrowserRouter` (`App.jsx:108-116`) — fine.

### API client (`api.js`)

`api.js:3-26` is the whole error model:

```js
const res = await fetch(path, { method, headers, body: … });
const json = await res.json();
if (res.status === 401) {
  const hadToken = !!localStorage.getItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_KEY);
  if (hadToken) { window.location.href = "/login"; return; }
  throw new Error(json.error || "Invalid credentials");
}
if (!res.ok) throw new Error(json.error || "Request failed");
return json.data;
```

**Base URL handling.** All paths are relative (`/api/…`). In dev, Vite proxies `/api` to
`http://localhost:5100` (`vite.config.js:6-10`); in prod, Flask serves both the SPA and
the API from the same origin. Clean — there is no `VITE_API_URL` to misconfigure, and no
`import.meta.env` usage anywhere. This is the best part of the client. (CONFIRMED)

**Does a 401 log the user out?** Yes, but via a full-page navigation, and *only* if a
token was present (`api.js:15-23`). The `hadToken` distinction is deliberate and correct
— it lets `/api/auth/login` return 401 as "Invalid credentials" rather than bouncing.
Two problems:
- `window.location.href = "/login"` is a **hard reload**, discarding all React state
  rather than using the router. It also does not call `AuthContext.logout()`, so the
  in-memory `token`/`user` state stays populated until the reload lands. (CONFIRMED)
- The `return;` at `api.js:20` returns `undefined` to the caller. Any `await`ing code that
  does `const d = await api.getDashboard(); setData(d)` gets `undefined` and will often
  throw a `TypeError` in the ~100 ms before navigation completes. (CONFIRMED)

**Are errors surfaced or swallowed?** Mixed, and the swallowing is real:
- `await res.json()` at `api.js:14` runs **before** the status check, unconditionally.
  Any non-JSON response — Flask's HTML 404/405/413/500 pages, a Cloudflare 502/504
  interstitial, an unknown `/api/*` path caught by the SPA route (`app.py:102-108`), or a
  10 MB+ upload hitting `MAX_CONTENT_LENGTH` — throws
  `SyntaxError: Unexpected token '<'` instead of a usable message. The real status code
  is never seen. (CONFIRMED)
- A 204 No Content or empty body would throw the same way. (CONFIRMED)
- No timeout, no `AbortController`, no retry. A hung request hangs the UI forever.
  (CONFIRMED)
- Callers frequently discard errors entirely: `Dashboard.jsx:146-147` is
  `} catch { } finally { setLoading(false); }` — a dashboard load failure produces a
  silent blank page. (CONFIRMED)
- `api.js:101-122` (`importTransactions`) duplicates the whole fetch/401/error block
  because it needs `FormData`. Its 401 branch (`api.js:113-117`) drops the `hadToken`
  guard, so it always hard-navigates. Divergent copy of the same logic.
  (CONFIRMED)

`format.js` is 7 lines — one `fmtCurrency` helper, no issues.

---

## PWA Status

**Verdict: not a PWA. It is a mobile-styled SPA with an "Add to Home Screen" poster and
an online/offline banner.**

Evidence (all CONFIRMED):
- **No web app manifest exists.** `grep -rn "manifest"` across `frontend/index.html`,
  `frontend/src/`, `frontend/public/`, `frontend/vite.config.js`, and
  `frontend/dist/index.html` returns **zero hits**. There is no `manifest.json`,
  no `manifest.webmanifest`, and no `<link rel="manifest">`.
- **No service worker exists.** Zero hits for `serviceWorker`, `service-worker`,
  `workbox`, or `sw.js` anywhere in the frontend. `vite.config.js` has exactly two
  plugins-worth of config (`react()` and a dev proxy) — no `vite-plugin-pwa`, and
  `package.json:19-29` lists no PWA dependency.
- **No iOS PWA meta tags.** `frontend/index.html:4-11` has `theme-color`, `viewport`
  with `viewport-fit=cover`, and a favicon — but no `apple-mobile-web-app-capable`,
  no `apple-mobile-web-app-status-bar-style`, and no `apple-touch-icon`.

**What this means for `InstallPrompt.jsx`:**
- The component (`components/InstallPrompt.jsx:20-86`) shows iOS Safari users a
  three-step "tap Share → Add to Home Screen" card after a 2.5 s delay
  (`InstallPrompt.jsx:26`).
- Users *can* follow those steps — iOS will add a bookmark icon. But **without
  `apple-mobile-web-app-capable` or a manifest with `display: standalone`, the launched
  app opens in a normal Safari tab with browser chrome**, not standalone.
- Therefore `isStandalone()` (`InstallPrompt.jsx:13-18`), which tests
  `navigator.standalone === true` or `matchMedia("(display-mode: standalone)")`, will
  **never return true** — the install prompt reappears on every visit forever, until the
  user hits the ✕ which writes `finance-install-prompt-dismissed` to localStorage
  (`InstallPrompt.jsx:32`). The prompt is essentially a one-shot dismissible banner
  whose install instructions do not produce the promised result. (CONFIRMED for the
  missing meta tags; the standalone-launch consequence is CONFIRMED by iOS documented
  behavior.)
- There is no `beforeinstallprompt` handling at all, so Android/Chrome — the platform
  that actually supports programmatic install — gets nothing. (CONFIRMED)
- The whole component is styled with inline objects (`InstallPrompt.jsx:39-82`), a
  different approach from the rest of the app's class-based CSS. It does correctly use
  `var(--safe-bottom)` (`InstallPrompt.jsx:42`).
- Minor: `React.Fragment` elements are used as array values with `key={icon}` where the
  key is an emoji (`InstallPrompt.jsx:72-81`) — works, but fragile.

**What `usePwaSync.js` actually does** (`hooks/usePwaSync.js:1-32`):
- Not a PWA feature at all. It is a `visibilitychange` listener that calls
  `POST /api/sync` when the tab becomes visible and more than 10 minutes have passed
  since `lastSyncedAt` (`usePwaSync.js:4, 10-15, 23-25`). It also fires once on mount
  (`usePwaSync.js:27`). It would behave identically in a normal browser tab.
- It has **no `isOnline` guard** — resuming a tab with no network fires a `fetch` that
  rejects and surfaces "Sync failed" via `onError`. (CONFIRMED)
- Its `useEffect` deps include `onSynced` and `onError` (`usePwaSync.js:31`). The
  call site correctly wraps both in `useCallback` with `[]` deps
  (`Dashboard.jsx:128, 132`), so it does not loop — but that safety is entirely on the
  caller, and `Dashboard.jsx:128` needs an
  `// eslint-disable-line react-hooks/exhaustive-deps` to achieve it. Any future call
  site passing inline arrows gets an infinite sync loop. (CONFIRMED as a fragile
  contract.)
- The `lastSyncedAt.replace("+00:00", "Z")` normalization (`usePwaSync.js:12`) is a
  workaround for Python's `datetime.isoformat()` output (`db_context.py:240` etc.) —
  correct, but it only handles that one format; a naive timestamp with no offset would
  be parsed as local time and could make `shouldSync()` wrong by hours.
  (CONFIRMED as a latent format assumption.)

**`OnlineContext.jsx`** (`context/OnlineContext.jsx:1-31`) is a clean, correct
`navigator.onLine` wrapper — `online`/`offline` listeners, proper cleanup. Consumed by
`Dashboard.jsx:44, 100` and `Transactions.jsx:571`. But `navigator.onLine` only reports
link-layer connectivity, not reachability, and **there is no offline data cache**, so the
"offline" experience is a banner over an empty screen. There is no request queue, no
IndexedDB, no optimistic writes.

**Leftover Vite template assets shipped to production** (CONFIRMED):
- `frontend/public/favicon.svg` is the purple Vite/Claude-style lightning-bolt logo
  (9.5 KB of blur filters), not a finance icon.
- `frontend/public/icons.svg` is a **5 KB sprite of Bluesky, Discord, GitHub, X, docs
  and social icons** from the Vite starter template. It is referenced by **nothing**
  (`grep -rn "icons.svg" frontend/src frontend/index.html` → zero hits) yet is copied
  into `frontend/dist/icons.svg` and served publicly.
- `frontend/README.md` is still the unmodified stock "React + Vite" template readme.
- `frontend/src/App.css` is a **0-byte file** imported by nothing.

---

## Build & Deploy Pipeline

### Vite (`vite.config.js`)

Nine lines: `react()` plugin plus a dev proxy for `/api` → `localhost:5100`. No
`build.outDir` override (defaults to `dist/`, which is what Flask reads at `app.py:27`),
no manual chunking, no compression plugin, no source-map config, no `base`.

Result (CONFIRMED from `frontend/dist/assets/`, built 2026-08-15):

| Asset | Size |
|---|---|
| `index-BW9ejKHZ.js` | **714,762 bytes (~698 KB)** |
| `index-BLndMcO_.css` | 17,168 bytes |

One 698 KB JS chunk, unsplit, containing React 19 + React Router 7 + **all of Recharts**
(`package.json:17`). Recharts is the bulk of it and is only needed by `CategoryDonut.jsx`
and `SpendingTrendChart.jsx`. No `React.lazy` / dynamic `import()` anywhere. On a phone
over a Cloudflare tunnel from a Raspberry Pi, with **no `Cache-Control: max-age`** (see
above), this is re-validated on every visit. (CONFIRMED)

`frontend/dist/` is gitignored (`.gitignore:11`, `frontend/.gitignore:10`) and confirmed
untracked (`git ls-files frontend/dist` → empty), but it **exists in the working tree and
is stale** — built 2026-08-15 while `App.jsx` and other sources were last touched
2026-07-19 through the 08-23 commits. Since Flask serves whatever is in `dist/`, running
`python app.py` locally without rebuilding serves an old bundle. (CONFIRMED the dist
exists and predates HEAD's commit date of 2026-08-23.)

### Flask serving `dist/`

Covered under App Shell. Summary: works; **no cache headers**; hashed assets not
long-cached; `index.html` not `no-store`; unknown `/api/*` GETs return the SPA.

### Gunicorn (`gunicorn.conf.py`)

```python
bind = "127.0.0.1:5100"   # line 7 — correct, tunnel-only
workers = 2               # line 8
timeout = 120             # line 9
preload_app = True        # line 10
accesslog = "logs/access.log"; errorlog = "logs/gunicorn.log"; loglevel = "info"
```

- `bind 127.0.0.1` is right and `DEPLOYMENT.md:184-187` correctly warns not to change it
  (the `CF-Connecting-IP` rate limiting depends on it).
- **`README.md:396` claims "The service runs gunicorn on `0.0.0.0:5100`. The app is
  accessible at `http://<pi-ip>:5100` on your local network."** This is **false** —
  `gunicorn.conf.py:7` binds `127.0.0.1`. `DEPLOYMENT.md:4` has it right. (CONFIRMED
  contradiction.)
- 2 sync workers with no `threads` — max 2 concurrent requests. Appropriate for SQLite,
  but see the sync-blocking issue above.
- `preload_app = True` + `RotatingFileHandler` = multi-process log rotation hazard
  (see Data Layer).

**The `on_starting` scheduler hook** (`gunicorn.conf.py:18-23`):

```python
def on_starting(server):
    global _scheduler
    _scheduler = BackgroundScheduler(daemon=True)
    _scheduler.add_job(scheduled_sync_all, trigger="cron", hour=3, minute=0,
                       misfire_grace_time=300)
    _scheduler.start()
    atexit.register(lambda: _scheduler.running and _scheduler.shutdown(wait=False))
```

- The intent — one scheduler in the arbiter rather than one per worker — is correct and
  well documented (`README.md:60`, `DEPLOYMENT.md:177`). `on_starting` runs in the
  arbiter before any fork, and forked children do not inherit non-forking threads, so
  workers genuinely do not run it. (CONFIRMED)
- `daemon=True` here vs `daemon=False` in the `app.py:112` dev path — inconsistent but
  each is right for its context.
- **Risks (SUSPECTED):**
  - `systemctl reload` / `SIGHUP` makes the gunicorn arbiter re-exec, which re-runs
    `on_starting`. The old `_scheduler` reference is lost, so a duplicate scheduler
    thread can survive → the 3 AM sync fires twice. `DEPLOYMENT.md` only documents
    `restart`, never `reload`, so this is not currently triggered.
  - The scheduler runs `scheduled_sync_all` (`services/sync_service.py:76+`) **inside the
    gunicorn arbiter process**. The arbiter is meant to do nothing but supervise; a long
    IMAP fetch there delays worker health checks. It also opens SQLite connections from
    the arbiter (`sync_service.py:14, 77`) concurrently with the workers — WAL-safe, but
    architecturally it should be a separate `systemd` timer or unit.
  - No job-level error boundary: `scheduled_sync_all` catches per-user errors
    (`sync_service.py:69-72`), but an exception in the loop scaffolding itself would kill
    the job silently with no alert.
- `worker_exit(server, worker): pass` (`gunicorn.conf.py:26-27`) is a dead no-op hook.

### systemd (`deploy/finance-app.service`)

Genuinely good hardening for a hobby deploy (CONFIRMED):
- `Type=notify` + `NotifyAccess=main` (lines 7-8) — correct for gunicorn 23.
- Runs as unprivileged `rohitpras`, not root (line 10).
- `EnvironmentFile=…/.env` (line 13) — secrets never in the unit file.
- `PrivateTmp=true`, `NoNewPrivileges=true`, `ProtectSystem=full` (lines 25-27) with
  `ReadWritePaths` limited to `data/` and `logs/` (lines 28-29).
- `Restart=on-failure`, `RestartSec=5` (lines 18-19).

Gaps (CONFIRMED absent):
- No `ProtectHome=` — with `ProtectSystem=full`, `/home` stays writable; the two
  `ReadWritePaths` are additive to that, not a whitelist. `ProtectSystem=strict` plus the
  same `ReadWritePaths` would be the actual lockdown the comment on line 24 claims
  ("OS is read-only to the service; only data/ and logs/ are writable" — that is
  **overstated** for `ProtectSystem=full`).
- No `PrivateDevices=`, `ProtectKernelTunables=`, `ProtectControlGroups=`,
  `RestrictAddressFamilies=`, `MemoryMax=`, `LimitNOFILE=`.
- No `After=` ordering relative to `cloudflared` (harmless — the tunnel retries).

`deploy/cloudflared.service` mirrors the same hardening (lines 20-23) and correctly uses
`--no-autoupdate` with an explicit config path (line 12).

### Cloudflare Tunnel (`deploy/cloudflared-config.yml`)

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /home/rohitpras/.cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: trackmyspend.xyz      → http://localhost:5100
  - hostname: www.trackmyspend.xyz  → http://localhost:5100
  - service: http_status:404
```

Correct and minimal: explicit hostnames, catch-all 404 so the tunnel is never a generic
proxy, credentials outside the repo, placeholders (not real UUIDs) committed. Nothing is
port-forwarded. This is the strongest piece of the deployment. (CONFIRMED)

One gap: `DEPLOYMENT.md:5` and the app both assume Cloudflare Access is *not* in front —
`limiter.py:17-21` mentions "behind Cloudflare Access" but the ingress config has no
`access:` block and nothing enforces it. **Registration is the only gate**, and
`REGISTRATION_ENABLED` defaults to *open* when unset (`DEPLOYMENT.md:181-182`,
`README.md:155`). (CONFIRMED)

### Deploy mechanics

Manual `rsync` + `ssh npm run build` + `ssh systemctl restart`, documented twice
(`README.md:398-442`, `DEPLOYMENT.md:12-53`). No script, no Makefile target, no CI.
The build happens **on the Pi** (`DEPLOYMENT.md:30`), meaning a Raspberry Pi runs a Vite
build of a 698 KB bundle on every frontend deploy, and `node_modules` must live in
production. No rollback path other than "rsync an older checkout".

---

## Tooling & CI

### Linting — both clean

```
$ ./venv/bin/ruff check .
ruff 0.15.16
All checks passed!

$ cd frontend && npx eslint src/
(no findings — only a Node ExperimentalWarning about CommonJS/ESM in npm's own debug module)
```

Both CONFIRMED by actually running them. `ruff.toml` selects `E,F,I,W,UP` with `E501`
ignored, `line-length = 100`, `target-version = "py310"`. `frontend/eslint.config.js`
uses flat config with `js.configs.recommended`, `react-hooks`, `react-refresh`, and
`no-unused-vars: warn`, `no-console: warn`, `no-empty` with `allowEmptyCatch: true`.

Notes:
- `ruff.toml:17` has a `per-file-ignores` entry for `"scripts/*"` — **there is no
  `scripts/` directory**. Dead config. (CONFIRMED)
- `no-empty` with `allowEmptyCatch: true` (`eslint.config.js:23`) is precisely what lets
  `Dashboard.jsx:146` (`} catch { }`) pass lint. The tooling is configured to permit the
  error-swallowing pattern.
- `ruff` is **not in `requirements.txt`** — it exists only in the local `venv/bin/ruff`.
  A fresh `pip install -r requirements.txt` gives you a checkout where `make lint`
  fails with "command not found". `README.md:521-543` documents `make lint` with no
  mention of installing ruff. (CONFIRMED — I hit exactly this; `ruff` was not on PATH
  and had to be invoked as `./venv/bin/ruff`.)
- `Makefile` has only `lint` and `format`, no `.PHONY`, no `test`, no `build`, no `run`.

### CI — none

```
$ find .github
.github
.github/workflows
$ ls -la .github/workflows
total 0   (empty)
```

`.github/workflows/` **exists and is completely empty** (CONFIRMED). It was created
2026-06-11 and never populated. Nothing runs ruff, eslint, a build, or any check on push
or PR — despite 19+ merged PRs in the history.

### Dependency management

`requirements.txt` (20 lines) — **every package is pinned to an exact version** with `==`.
Good practice. But (CONFIRMED):
- It is a **flat `pip freeze` dump**, not a declared-dependency file: it includes
  transitive-only packages (`cffi`, `pycparser`, `soupsieve`, `blinker`, `MarkupSafe`,
  `itsdangerous`, `typing_extensions`, `tzlocal`, `click`) mixed with real dependencies.
  There is no `requirements-dev.txt` and no way to tell what the project actually
  depends on.
- **`ruff` is missing** even though `Makefile:2` and `README.md:537` require it.
- **`google-auth-oauthlib` is missing** — `venv/bin/` contains a `google-oauthlib-tool`
  binary, meaning something was pip-installed into the venv and never recorded. If any
  code path needs it, a clean install breaks. (CONFIRMED that the binary exists and the
  package is absent from `requirements.txt`; whether code needs it is SUSPECTED — the
  Gmail path uses IMAP + app passwords, not OAuth, so this is likely an abandoned
  experiment.)
- No hashes, no lockfile, no `pip-tools`/`uv`/Poetry.
- `frontend/package.json` uses **caret ranges** (`^19.2.6`, `^8.0.12`, …) for everything,
  which is the opposite discipline from the backend. `package-lock.json` **is** committed
  (CONFIRMED via `git ls-files`), so builds are reproducible via `npm ci` — but
  `DEPLOYMENT.md:44` and `README.md:370` both tell you to run `npm install`, which
  *can* update the lockfile. Should be `npm ci`.

---

## Repo Hygiene & Secrets

### What is gitignored, and does it actually cover the sensitive files?

`.gitignore` (11 lines):
```
venv/  __pycache__/  *.pyc  .env
data/*.db  data/*.db-shm  data/*.db-wal  data/backups/
logs/  frontend/node_modules/  frontend/dist/
```

**Verification (CONFIRMED):**
```
$ git ls-files | grep -Ei 'env|\.db'
deploy/env.production          ← the only match

$ git ls-files | grep -E '^(data|logs)/'
(nothing)

$ git log --all --diff-filter=A --name-only --pretty=format: | sort -u \
    | grep -Ei '\.env$|\.db$|^data/|^logs/'
(nothing)
```

So: **no `.env`, no `.db`, no `data/`, no `logs/` file has ever been committed on any
branch, at any point in history.** That is a clean result and the single best hygiene
finding in this audit.

`deploy/env.production` is tracked, but it contains only placeholders
(`SECRET_KEY=REPLACE_WITH_64_CHAR_HEX`, `ENCRYPTION_KEY=REPLACE_WITH_FERNET_KEY`) —
correct as a template. (CONFIRMED by reading all 16 lines.)

### What is in the working tree

`data/` holds **real user databases** (CONFIRMED):

| File | Size | Modified |
|---|---|---|
| `master.db` | 20 KB | 2026-07-22 |
| `user_1_finance.db` | 450 KB | 2026-07-19 |
| `user_2_finance.db` | 36 KB | 2026-06-10 |
| `user_3_finance.db` | 40 KB | 2026-07-22 |
| `user_4_finance.db` | 40 KB | 2026-07-22 |
| **`prod_db.db`** | **544 KB** | **2026-08-23** |

- `prod_db.db` (544 KB, the largest file) is **not created by any code path** —
  `get_db_path()` only produces `user_{id}_finance.db` and `MASTER_DB` only produces
  `master.db`. It is a **hand-copied production database sitting in a developer working
  tree.** It matches `data/*.db` so it is gitignored, but it is real financial data on a
  laptop with no stated encryption. (CONFIRMED that no code creates it; its provenance is
  SUSPECTED-manual-copy.)
- `.env` exists in the working tree with mode **`-rw-r--r--` (644)** — world-readable on
  a multi-user machine. `DEPLOYMENT.md:160` prescribes `chmod 600` **on the Pi only**;
  the dev machine's `.env` holding a real `SECRET_KEY` and `ENCRYPTION_KEY` is not
  covered. (CONFIRMED)
- `logs/` holds 2.3 MB across `app.log` (843 KB), `app.log.1`, `app.log.2` — gitignored,
  but see rotation issues below.
- `.ruff_cache/` is **not in `.gitignore`** (it ships its own `.gitignore` internally, so
  it stays untracked by accident, not by intent). `__pycache__/` is covered.

### Backups

- `DEPLOYMENT.md:57-77` documents a manual `sqlite3 .backup` loop into
  `data/backups/$(date …)` and a manual `rsync` to pull them off the Pi. **`README.md:511-517`
  documents a second, different, manual procedure.**
- **There is no automation of any kind** — no cron entry, no systemd timer, no script in
  the repo, no `Makefile` target. `data/backups/` is gitignored (`.gitignore:8`), and it
  does not exist in the working tree. (CONFIRMED)
- The restore procedure (`DEPLOYMENT.md:208-216`) is documented and looks correct
  (stops the service, copies, removes stale `-wal`/`-shm`). It has evidently never been
  tested by anything automated.

### Logging & rotation

- `app.py:54-58`: `RotatingFileHandler(config.LOG_FILE, maxBytes=1_000_000, backupCount=5)`
  attached to the **root logger** at `INFO`. Combined with `preload_app=True`, both
  workers inherit the same handler and open file — not multi-process safe. (CONFIRMED)
- `gunicorn.conf.py:11-12` writes `logs/access.log` and `logs/gunicorn.log` with
  **no rotation at all** — gunicorn does not rotate, and there is no `logrotate` config
  in `deploy/`. `logs/access.log` grows without bound. `DEPLOYMENT.md:204` acknowledges
  the problem only as a manual "check disk space" troubleshooting step.
  (CONFIRMED)
- `app.py:57` attaches to the root logger, so **every** library's INFO logs land in
  `app.log` — including anything an HTTP or IMAP client emits. Combined with
  `logger.exception("sync_user(%s) failed")` (`sync_service.py:70`), stack traces
  containing Gmail addresses land in a world-readable-by-default file.
  (CONFIRMED for the root-logger attachment; PII-in-logs is SUSPECTED without reading
  the actual log contents, which I did not do.)
- There is an admin endpoint that serves logs to the browser
  (`api.js:133` → `GET /api/admin/logs?lines=N`, `routes/admin_routes.py`), which is
  admin-gated.

### Error monitoring

**None.** No Sentry, no Rollbar, no healthcheck endpoint, no uptime monitor, no alerting
on the 3 AM sync failing. `grep` finds no `sentry`, `rollbar`, `/health`, or `/healthz`
anywhere. If the scheduler dies or the tunnel drops, the only signal is the user noticing.
`DEPLOYMENT.md:98-103` offers manual `curl` health checks. `runtime_state.py` (3 lines)
records `APP_START_TIME` purely so `/api/admin/system` can display uptime.
(CONFIRMED)

### Git state

```
HEAD: 20f7f41 "fix"    (2026-08-23)
      f26a20b "fix"
      2f30eb5 "fixes"
      d521282 "Merge remote-tracking branch 'origin/main' into main (preserving …)"
```

- Working tree clean, `main` in sync with `origin/main`.
- Local branches: `auto-categorization`, `main`, `port-kyle-features`,
  `reimbursement-status`, `reimbursement-v2`. Remotes add `fix-amex-email-scan` and
  `kotero`. **Five merged feature branches are still present locally and remotely** —
  `port-kyle-features` (PR #15), `reimbursement-status` (#18), and `reimbursement-v2`
  (#19) are all merged per the log but never deleted.
- The three most recent commits are titled `fix`, `fix`, and `fixes`. Commit hygiene
  degrades toward HEAD — the middle of the history (`49d9342`, `dbd0bb8`, `26b0a0d`) has
  genuinely descriptive messages.

### The "DO NOT MERGE TO MAIN!!" header

`README.md:1` is literally `# DO NOT MERGE TO MAIN!!`, added in commit `8e42eb7`
("Add warning against merging to main branch"). What it implies (CONFIRMED context):

- **It is currently being violated.** The audit is running *on* `main`, `main` is clean
  and in sync with `origin/main`, and `git log` shows PRs #15, #18, and #19 **merged into
  main** (`3d96d5c`, `ed9796e`, `a68e7ef`) plus a manual merge commit `d521282` whose
  message ("preserving reimbursement v2 and transaction sorting") reads like a conflict
  was resolved by hand.
- It appears to date from a period of large feature-porting merges (`dbd0bb8`,
  `204045b`) and reads as a warning tied to that now-finished work, not to any
  currently-followed rule.
- Practical consequence: the README's very first line is a stale operational note aimed
  at a contributor workflow that is no longer being followed, sitting above the title of
  a 544-line document that new readers are supposed to trust. It undermines the document
  and should either be enforced (branch protection — of which there is none, since there
  is no CI) or removed.

---

## Testing Situation

**There are zero tests. Not "thin coverage" — zero.**

```
$ find . -path ./venv -prune -o -path ./frontend/node_modules -prune -o -path ./.git -prune \
    -o \( -iname '*test*' -o -iname '*spec*' -o -iname 'conftest.py' \
          -o -iname 'pytest.ini' -o -iname 'tox.ini' \) -print
(no output)
```

CONFIRMED:
- No `tests/` directory, no `test_*.py`, no `*_test.py`, no `conftest.py`.
- No `*.test.jsx`, `*.spec.js`, no `__tests__/`.
- No `pytest`, `unittest` runner config, `pytest.ini`, `tox.ini`, or `[tool.pytest]`
  anywhere. `requirements.txt` contains no test dependency.
- `package.json:6-12` has `dev`, `build`, `lint`, `lint:fix`, `preview` — **no `test`
  script**. No `vitest`, `jest`, `@testing-library/*`, or Playwright in
  `devDependencies` (lines 19-29).
- `Makefile` has no `test` target.
- No CI to run tests even if they existed.

The only automated quality gate in the entire repository is `make lint`, which must be
run by hand and which currently cannot run on a clean install because `ruff` is not in
`requirements.txt`.

**What this means for the highest-risk code.** The parts of this codebase most in need of
tests are exactly the parts with none:
- `_migrate()` / `_migrate_reimbursements()` (`db_context.py:83-214`) — mutates real
  financial data on every request, with 10 bare `except: pass` blocks. A regression here
  is silent and irreversible without a backup, and backups are manual.
- The money math in the reimbursement backfill (`db_context.py:200-212`) — flat vs
  percent vs expensed, `min(value, amount)`, `amount * value / 100.0`. One-shot,
  destructive, untested.
- `services/email_parser.py` — parses HTML from two banks with BeautifulSoup. Bank email
  templates change without notice; there is no fixture, no golden file, nothing that
  would fail loudly when Capital One reformats an email.

---

## Bugs & Issues

| Severity | file:line | Issue | Impact | Status |
|---|---|---|---|---|
| **High** | `frontend/src/main.jsx:9` + `frontend/src/App.jsx:110` | `AuthProvider` mounted twice; inner shadows outer, but the outer's `useEffect` still runs | Two `GET /api/auth/me` on every load; the dead outer provider can clear the shared localStorage token on a 401, logging the user out from a provider nothing reads | CONFIRMED |
| **High** | `db_context.py:225` | `_migrate()` runs on **every** `get_user_db()` call | ~9 failing `ALTER TABLE`s, a full-table `UPDATE` (line 140), and ~5 SELECTs per authenticated request; dominant per-request cost on a Pi | CONFIRMED |
| **High** | `db_context.py:88,93,100,106,112,118,124,130,136,142` | Ten bare `except Exception: pass` in the migration path | Disk-full, locked-DB, and genuinely broken migrations are all indistinguishable from "column already exists"; silent data-layer corruption | CONFIRMED |
| **High** | `frontend/src/api.js:14` | `await res.json()` runs before the status check, unconditionally | Any non-JSON response (Flask HTML 404/405/413/500, CF 502, unknown `/api/*` caught by the SPA route) surfaces as `SyntaxError: Unexpected token '<'`; real status is never seen | CONFIRMED |
| **High** | `.github/workflows/` (empty dir) | No CI whatsoever | 19+ merged PRs, none linted or built by anything automated; `make lint` can't even run on a clean install | CONFIRMED |
| **High** | repo-wide | **Zero tests** | The destructive one-shot money migration (`db_context.py:200-212`) and the bank-email HTML parsers have no safety net at all | CONFIRMED |
| **High** | `DEPLOYMENT.md:57-77` / `README.md:511-517` | Backups are fully manual, documented two different ways, never automated | The only recovery path for a bad `_migrate()` is a backup a human remembered to take | CONFIRMED |
| **Medium** | `db_context.py:218` | `g` cache key is the constant `"user_db"`, not `(user_id)` | Latent cross-user data leak the moment any request touches two users' DBs (e.g. an admin "view as user"). All 38 current call sites pass `g.current_user`, so not live today | CONFIRMED (latent) |
| **Medium** | `models/user.py:33,44,56,61,66,71,77,89,102,110` | `with sqlite3.connect(...)` commits but **does not close** | Ten functions leak a connection per call until GC; file descriptors accumulate under load | CONFIRMED |
| **Medium** | `app.py:102-108` | No `Cache-Control` on any static asset (`SEND_FILE_MAX_AGE_DEFAULT` never set) | Content-hashed 698 KB JS bundle is re-validated on **every** page load through the tunnel instead of being cached immutably for a year | CONFIRMED |
| **Medium** | `app.py:102-108` | SPA catch-all swallows unknown `GET /api/*` and returns `index.html` with **200** | Typo'd/removed endpoints look like JSON parse failures instead of 404s | CONFIRMED |
| **Medium** | `app.py:83` | CSP `script-src` includes `'unsafe-eval'` **and** `'unsafe-inline'` | Neither is needed by the Vite production build (`dist/index.html` has no inline script); a large share of CSP's XSS value is given away for nothing | CONFIRMED |
| **Medium** | `app.py:81-88` | CSP missing `frame-ancestors`, `base-uri`, `object-src`, `form-action`; no HSTS header | Weaker-than-necessary defense-in-depth on a public financial app | CONFIRMED |
| **Medium** | `frontend/src/App.jsx:88` | `/admin` guarded by `ProtectedRoute` (auth only), not an admin check | Any authenticated non-admin can render the Admin page by typing the URL. API is `@require_admin`-gated so no data leaks, but it is a broken authorization boundary | CONFIRMED |
| **Medium** | `app.py:54-58` + `gunicorn.conf.py:10` | `RotatingFileHandler` inherited by both workers via `preload_app=True` | `RotatingFileHandler` is not multi-process safe; concurrent `doRollover()` can truncate or drop log lines | CONFIRMED (mechanism) / SUSPECTED (observed loss) |
| **Medium** | `gunicorn.conf.py:11-12` | `logs/access.log` and `logs/gunicorn.log` have **no rotation** and no `logrotate` config in `deploy/` | Unbounded growth on a Pi SD card; only mitigation is a manual `df -h` in `DEPLOYMENT.md:204` | CONFIRMED |
| **Medium** | `frontend/index.html:1-17` | No manifest, no service worker, no `apple-mobile-web-app-capable` | `InstallPrompt.jsx` instructs users to install an app that will not launch standalone; `isStandalone()` (`InstallPrompt.jsx:13-18`) can never return true | CONFIRMED |
| **Medium** | `frontend/vite.config.js:4-10` | No code splitting; all of Recharts in the main chunk | Single 698 KB `dist/assets/index-BW9ejKHZ.js` (measured), uncached, over a home-broadband tunnel | CONFIRMED |
| **Medium** | `requirements.txt` | `ruff` absent though `Makefile:2` and `README.md:537` require it; `google-auth-oauthlib` installed in `venv/` but unrecorded | `make lint` fails on a clean install (I hit this — had to use `./venv/bin/ruff`); env is not reproducible from the file | CONFIRMED |
| **Medium** | `routes/sync_routes.py:34` + `gunicorn.conf.py:8,9` | Synchronous IMAP fetch inside a request, 2 sync workers | Two concurrent syncs block the **entire** app until the 120 s timeout | CONFIRMED |
| **Medium** | `.env` (mode 644) | Dev `.env` with real `SECRET_KEY`/`ENCRYPTION_KEY` is world-readable; `DEPLOYMENT.md:160` only hardens the Pi | Local secret exposure on a shared machine | CONFIRMED |
| **Medium** | `data/prod_db.db` (544 KB, 2026-08-23) | A production database copy sits in the dev working tree; no code path creates this filename | Real financial data outside the deployment, gitignored but unencrypted | CONFIRMED (file) / SUSPECTED (provenance) |
| **Low** | `db_context.py:51-57` vs `145-153` | `reimbursement_links` DDL defined twice | Two sources of truth; they agree today, nothing enforces it | CONFIRMED |
| **Low** | `db_context.py:79-80` | `get_db_path` returns a **relative** path | Running from any other CWD silently creates a fresh empty DB instead of failing | CONFIRMED |
| **Low** | `db_context.py:217-227`, `services/sync_service.py:13-17`, `routes/admin_routes.py:30` | `PRAGMA journal_mode=WAL` set only in `init_user_db`/`models.user._connect` | WAL is persistent so it holds today, but three of five connection paths don't assert it | CONFIRMED |
| **Low** | repo-wide | No `CREATE INDEX` anywhere; only implicit UNIQUE/PK indexes | Every dashboard filter on `transaction_at`/`direction`/`category_id` is a full scan | CONFIRMED |
| **Low** | repo-wide | No `.rollback()` anywhere | Mid-transaction failures are discarded only by accident (`teardown_appcontext` closing the conn), not by design | CONFIRMED |
| **Low** | `frontend/src/api.js:20` | 401 path does `window.location.href` then `return;` (undefined) | Hard reload discards React state, bypasses `AuthContext.logout()`, and callers get `undefined` → `TypeError` before navigation lands | CONFIRMED |
| **Low** | `frontend/src/api.js:101-122` | `importTransactions` duplicates the fetch/401/error logic and drops the `hadToken` guard | Divergent copy; the two paths already behave differently on 401 | CONFIRMED |
| **Low** | `frontend/src/api.js:3-26` | No timeout, no `AbortController`, no retry | A hung request hangs the UI indefinitely | CONFIRMED |
| **Low** | `frontend/src/hooks/usePwaSync.js:7-31` | No `isOnline` guard; correctness depends on callers wrapping `onSynced`/`onError` in `useCallback` | Offline resume fires a doomed sync; any future inline-arrow call site gets an infinite loop | CONFIRMED |
| **Low** | `app.py:92-99` | `OPTIONS` handler emits `Access-Control-Allow-Origin` unconditionally and omits `Vary: Origin` (which `app.py:76` does set) | Inconsistent CORS between preflight and actual response; cache-poisoning-adjacent, not exploitable (fixed value, not reflected) | CONFIRMED |
| **Low** | `gunicorn.conf.py:18-23` | `on_starting` re-runs on arbiter re-exec (`SIGHUP`/`systemctl reload`), losing the old `_scheduler` handle | Duplicate 3 AM sync. Not currently triggered — docs only ever use `restart` | SUSPECTED |
| **Low** | `gunicorn.conf.py:20-22` | The scheduler (and its IMAP fetch + SQLite writes) runs **inside the gunicorn arbiter** | The supervisor process does application work; a long fetch delays worker supervision. Belongs in its own unit/timer | CONFIRMED |
| **Low** | `gunicorn.conf.py:26-27` | `worker_exit` is an empty `pass` hook | Dead code | CONFIRMED |
| **Low** | `ruff.toml:17` | `per-file-ignores` for `"scripts/*"`; no `scripts/` directory exists | Dead config | CONFIRMED |
| **Low** | `frontend/eslint.config.js:23` | `no-empty` with `allowEmptyCatch: true` | Lint is configured to permit `} catch { }` (e.g. `Dashboard.jsx:146`), the exact pattern that hides load failures | CONFIRMED |
| **Low** | `frontend/public/icons.svg` | 5 KB Vite-template sprite (Bluesky/Discord/GitHub/X icons), referenced by nothing, copied into `dist/` and served | Dead asset shipped to production | CONFIRMED |
| **Low** | `frontend/public/favicon.svg`, `frontend/README.md`, `frontend/src/App.css` | Stock Vite logo; unmodified template README; 0-byte `App.css` imported by nothing | Template debris | CONFIRMED |
| **Low** | `frontend/dist/` (built 2026-08-15) | Stale build in the working tree, older than HEAD (2026-08-23) | `python app.py` locally serves an outdated bundle unless you remember to rebuild | CONFIRMED |
| **Low** | `config.py:13` + `models/user.py:7` | `DB_PATH` is only ever used for its **parent directory**; the path itself is never opened | Confusing config surface; `README.md:153` half-admits it ("`master.db` is placed in the same directory") | CONFIRMED |
| **Low** | `deploy/finance-app.service:24-29` | Comment claims "OS is read-only to the service" but `ProtectSystem=full` leaves `/home` writable; no `ProtectHome=`, `PrivateDevices=`, `MemoryMax=` | Hardening is weaker than the comment asserts | CONFIRMED |
| **Low** | `routes/admin_routes.py:30-36` | `conn.close()` only on the success path, inside a `try` whose `except` (line 39) swallows everything | Connection leak whenever a user's finance DB is missing or malformed | CONFIRMED |
| **Low** | `frontend/src/index.css:262-276, 474-477, 579-581, 701-721` | Dead rules: `.toast`, `.input-error`, `.text-amber`, `.progress-track`/`.progress-fill*` — zero references in any `.jsx` | ~50 lines of dead CSS shipped in the bundle | CONFIRMED |
| **Low** | `frontend/src/index.css:295,296,304,305` | Token values hardcoded as raw hex (`#22263A`, `#94A3B8`, `#6C63FF`) instead of `var(--surface-raised)`, `var(--text-secondary)`, `var(--primary)` | Theme drift: changing `--primary` leaves `.range-pill.active` behind | CONFIRMED |

---

## `frontend/src/index.css` — structural analysis (1,290 lines)

**Organization.** One flat file, no `@import`, no layers, no partials. Ordered roughly:
tokens → reset → layout primitives → nav → shared components → page-specific blocks
(`.auth-*` 589-635, `.stat-*` 636-667, `.cat-*` 668-722, `.txn-*` 742-837, `.drop-zone`
894-943, `.import-*` 944-983, `.budget-*` 984-1026, `.admin-*` 1027-1140, `.modal-*`
1231-1286). It reads as append-only: page-specific rules are grouped by page but the file
never revisits earlier sections, so `.cat-list`/`.cat-row` (668) and `.cat-pills`/`.cat-pill`
(1196) — two unrelated things sharing a prefix — sit 500 lines apart. Roughly 190 top-level
selectors.

**Tokens** (`:root`, lines 1-27). 13 color tokens + 3 layout tokens:
`--bg #0f1117`, `--surface #1a1d27`, `--surface-raised #22263a`, `--border #2e3250`,
`--primary #6c63ff`, `--primary-dim #3d3880`, `--primary-glow rgba(108,99,255,.35)`,
`--green #22c55e`, `--red #ef4444`, `--amber #f59e0b`, `--text #f1f5f9`,
`--text-secondary #94a3b8`, `--text-muted #475569`; plus `--bottom-nav-height 60px`,
`--safe-bottom env(safe-area-inset-bottom, 0px)`, `--safe-top env(safe-area-inset-top, 0px)`.

The token set is well-chosen and genuinely used — 121 `var(--…)` references, led by
`--text-secondary` (23), `--border` (19), `--primary` (16). But **there are no
spacing, radius, font-size, shadow, or z-index tokens**, so those are magic numbers
throughout (radii of 8/12/16/20px, z-indexes of 100/300/9999 chosen ad hoc —
`.top-bar-loading` and `InstallPrompt` both claim `z-index: 9999`).

**Duplication.** 25 hardcoded hex values, 12 of which are the token definitions
themselves. The remaining 13 are the problem:
- Lines 295-296 and 304-305 re-state `--surface-raised`, `--text-secondary`, and
  `--primary` as literals (in a different case: `#22263A` vs `#22263a`).
- Lines 204, 237, 364, 887, 1190 use bare `#fff`; 268 uses `#0f172a`.
- Lines 215-217 (`.offline-banner`) introduce three amber shades (`#78350f`, `#92400e`,
  `#fde68a`) with no token, unrelated to `--amber`.
- `rgba(108, 99, 255, …)` — the primary as raw channels — appears in `body`'s gradient
  (line 45) alongside `var(--primary-glow)`, which is the *same* color as a token.

**Dead rules.** Verified by grepping every class against `pages/`, `components/`,
`hooks/`, `context/`: `.toast` (262-276, ~15 lines), `.input-error` (474-477),
`.text-amber` (579-581), and the entire progress-bar family `.progress-track` /
`.progress-fill` / `.progress-fill.green|.amber|.red` (701-721, ~21 lines) have **zero**
references in any JSX. `@keyframes pulse` (129-133) *is* used, but only from three inline
`style={{ animation: "pulse …" }}` props in `SpendingTrendChart.jsx:54`,
`ComparisonCard.jsx:81`, `MerchantInsights.jsx:76` — a class-less coupling that no tool
can verify.

**Responsive strategy.** Mobile-first with only **four** media queries, three of them the
same breakpoint:
- `@media (min-width: 768px)` × 3 — `.page` padding (88), `.page-header` sizing (107),
  `.fab` position (255). These are scattered rather than consolidated, and 768px is not
  a token.
- `@media (max-width: 360px)` × 1 — `.summary-grid` collapses 3 columns to 1 (315).

Everything else responds via `flex`/`grid` with `repeat(3, 1fr)`, `overflow-x: auto` with
hidden scrollbars (`.range-pills` 277-286, `.filter-row` 321-329), and a `max-width: 960px`
centered `#root` (75-81). There is **no tablet tier and no desktop layout** — above 960 px
the app is a fixed-width phone column with a bottom tab bar, and the `.bottom-nav`
(149-198) is `position: fixed` at every viewport size. The safe-area handling is the best
part: `--safe-top`/`--safe-bottom` from `env()` (17-18) applied to `body` padding (49),
`.page` bottom padding (85), `.bottom-nav`, `.fab`, `.toast`, and `InstallPrompt.jsx:42`.
`100dvh` (46, 76) rather than `100vh` is correct for mobile browser chrome. Tap targets are
enforced globally via a `min-height: 44px` rule with a four-class `:not()` exclusion
chain (58-61) — effective, but brittle: every new small-button class must be added to that
selector.

**Dark mode.** There is none — or rather, **dark is the only mode.** `color-scheme: dark`
is declared at line 27, and the file contains **zero** `@media (prefers-color-scheme: …)`
blocks and zero `[data-theme]` selectors (verified by grep). The tokens are single-valued.
A light theme would require re-authoring `:root` plus the 13 stray hex literals. This is a
deliberate, consistent choice rather than a bug — but it means a user with a light-mode OS
preference gets no accommodation, and the token structure is not shaped to ever allow one.

---

## README Accuracy Corrections

`README.md` is 544 lines and mostly good, but it has drifted from the code. Corrections,
in file order:

| README | Claim | Reality | Status |
|---|---|---|---|
| `:1` | `# DO NOT MERGE TO MAIN!!` | Being actively violated — PRs #15/#18/#19 are merged into `main`, HEAD is on `main`, and there is no branch protection (no CI exists to enforce any) | CONFIRMED |
| `:69` | "Python 3.11+" | `ruff.toml:2` targets `py310`; the venv is `python3.10` (`venv/bin/python3.10`) and `__pycache__` files are `cpython-310`. Should read 3.10+ | CONFIRMED |
| `:139` | "By default `REGISTRATION_ENABLED` is not set so registration is open in dev" | True, but the same default applies **in production** — `DEPLOYMENT.md:181-182` warns about this and the README does not | CONFIRMED |
| `:153` | "`DB_PATH` — Path for `master.db`" | `DB_PATH` is never opened; only `Path(DB_PATH).parent` is used (`models/user.py:7`). Setting it to a filename in the wrong directory silently relocates every database | CONFIRMED |
| `:175` | `categories (id, name)` | Missing `sort_order` and `is_misc` (`db_context.py:23-24`) | CONFIRMED |
| `:176-177` | `transactions (…, source_hash, reimburses_id)` | Missing **five** columns: `reimbursement_status`, `reimbursement_mode`, `reimbursement_value`, `expected_reimbursement`, `reimbursement_external` (`db_context.py:38-42`) | CONFIRMED |
| `:174-180` | The per-user schema block | **Omits the `reimbursement_links` table entirely** (`db_context.py:51-57`) — the current model for reimbursements | CONFIRMED |
| `:179` | `budgets (id, category_id, amount)` | Missing `period` and `fold_into_misc` (`db_context.py:72-73`) | CONFIRMED |
| `:186` | "`reimburses_id` — FK … Enables the net-cost calculation" | `reimburses_id` is **legacy**; `db_context.py:45-50` documents that it is superseded by `reimbursement_links` and back-filled by `_migrate_reimbursements()` | CONFIRMED |
| `:188` | "All connections use `PRAGMA journal_mode=WAL`" | **False.** WAL is set only in `init_user_db` (`db_context.py:235`) and `models/user.py:25`. `get_user_db` (217-227), `sync_service._open_user_db` (13-17), and `admin_routes.py:30` do not set it | CONFIRMED |
| `:190` | "schema is applied via `init_user_db()` which is idempotent" | True as far as it goes, but omits that `_migrate()` also runs on **every request** (`db_context.py:225`) — the single most important fact about the data layer | CONFIRMED |
| `:206` | `PUT /api/auth/me/password` | The client calls `POST /api/auth/change-password` (`api.js:73-74`) | CONFIRMED |
| `:249` | `POST /api/import/csv` with field `source` | The client posts to `/api/import/transactions` with field `source_type` (`api.js:101-110`) | CONFIRMED |
| `:256` | `POST /api/sync/now` | The client calls `POST /api/sync` (`api.js:98`) | CONFIRMED |
| `:245` | `GET /api/categories/unclassified-merchants` | The client calls `GET /api/transactions/merchants/unclassified` (`api.js:83-84`) | CONFIRMED |
| `:293` | "Manual sync … calls `POST /api/sync/now`" | Same wrong path as `:256` | CONFIRMED |
| `:302-328` | Frontend tree | Omits `components/InstallPrompt.jsx`, `ProtectedRoute.jsx`, `SplitModal.jsx`, `CategoryPicker.jsx`, `CategoryEditModal.jsx`, `OwedWidget.jsx`, `BudgetByCategoryWidget.jsx`, `hooks/useDashboardWidgets.js`, and `format.js` — 9 real modules | CONFIRMED |
| `:324` | "`usePwaSync.js` — Background sync on PWA resume" | It is a `visibilitychange` listener that works identically in a normal tab; there is no PWA and no background sync (no service worker, no Background Sync API) | CONFIRMED |
| `:334` | localStorage key `auth_token` | The actual key is **`finance_token`** (`api.js:1`, `AuthContext.jsx:5`) | CONFIRMED |
| `:341` | "An inflow transaction can be linked to an outflow via `reimburses_id`" | Superseded by `reimbursement_links` (`db_context.py:51-57`); `api.js:62-64` posts to `/api/reimbursement-links` | CONFIRMED |
| `:396` | "The service runs gunicorn on `0.0.0.0:5100`. The app is accessible at `http://<pi-ip>:5100` on your local network" | **False and security-relevant.** `gunicorn.conf.py:7` binds `127.0.0.1:5100`. It is *not* reachable on the LAN. `DEPLOYMENT.md:4` has it right | CONFIRMED |
| `:444-472` | "**new columns on existing tables** are not [automatic] — you must run `ALTER TABLE` manually on the Pi" | **Directly contradicts `DEPLOYMENT.md:47-53`** ("No manual `ALTER TABLE` on the Pi is ever needed"). Neither is right: you must edit `_migrate()` and redeploy | CONFIRMED |
| `:491-502` | Reproduces `.gitignore` | Accurate — matches the real file, and `git ls-files` confirms nothing sensitive is tracked | CONFIRMED CORRECT |
| `:521-543` | `make lint` / `ruff check .` | `ruff` is not in `requirements.txt`; a clean install cannot run either command | CONFIRMED |
| — | Missing entirely | No mention that there are **no tests**, **no CI**, and **no automated backups** | CONFIRMED |

`DEPLOYMENT.md` is markedly more accurate than `README.md` — it is newer (2026-07-19 vs
2026-06-24) and describes the real trackmyspend.xyz deployment. Its one significant error
is the migration claim at lines 47-53.

---

## Notes for Future Integrations

Ordered by leverage, for whoever picks this up next.

**1. Fix the double `AuthProvider` first — one line.** Delete the `AuthProvider` wrapper
from `main.jsx:9-11` (keep `App.jsx:110`, since `OnlineProvider` is already the outermost
there) or vice versa. This halves auth traffic and closes a real logout-race. Nothing else
in this report is as cheap.

**2. Gate `_migrate()` behind `PRAGMA user_version`.** The minimal change that preserves
today's behavior:
```python
v = conn.execute("PRAGMA user_version").fetchone()[0]
if v < TARGET: … ; conn.execute(f"PRAGMA user_version = {TARGET}")
```
This removes ~14 statements from every request, eliminates the perpetual full-table
`UPDATE` at `db_context.py:140`, and gives you a real version number to migrate against.
Do this **before** adding any feature that needs a new column — otherwise the try/except
list grows again. Take a backup first (`DEPLOYMENT.md:57-77`); there is no rollback.

**3. Make `get_user_db` cache key include `user_id`** (`db_context.py:218`) before
building anything admin- or multi-user-facing. It is a one-line change now and a data
breach later.

**4. Add indexes.** At minimum
`CREATE INDEX IF NOT EXISTS idx_txn_at ON transactions(transaction_at)` and
`(direction, transaction_at)`. Every dashboard endpoint scans the whole table today. Add
them inside the versioned migration from (2).

**5. Add cache headers before optimizing the bundle.** In `app.py`, serve
`/assets/*` with `Cache-Control: public, max-age=31536000, immutable` (safe — Vite
content-hashes them) and `index.html` with `no-store`. This is a bigger win than code
splitting and is ~6 lines. *Then* consider `React.lazy` for the two Recharts components.

**6. Fix `api.js` error handling before adding endpoints.** Move `res.json()` after the
status check and guard it:
```js
const ct = res.headers.get("content-type") || "";
const json = ct.includes("application/json") ? await res.json().catch(() => ({})) : {};
```
Every future endpoint inherits this. While there, make the 401 path call
`AuthContext.logout()` + `navigate("/login")` instead of `window.location.href`, and
collapse `importTransactions` (`api.js:101-122`) onto the shared helper.

**7. Decide what the PWA is.** Either commit — add a `manifest.webmanifest` with
`display: standalone` and real icons, add `apple-mobile-web-app-capable`, and adopt
`vite-plugin-pwa` for an app-shell service worker — or delete `InstallPrompt.jsx`, which
currently promises an install experience the app cannot deliver. Half-built is the worst
of the three. If you commit: note that a service worker plus the current no-cache-headers
setup will interact badly, so do (5) first.

**8. Populate `.github/workflows/`.** The directory already exists. A 20-line workflow
running `ruff check .` and `npx eslint src/` on PRs would have caught nothing today (both
pass) but establishes the hook for tests. Add `ruff` to a `requirements-dev.txt` in the
same commit so the workflow — and `make lint` — actually run.

**9. First tests should target `_migrate_reimbursements()`** (`db_context.py:173-214`).
It does destructive one-shot money math (flat / percent / expensed at lines 200-212) on
real balances, runs on every request, and has zero coverage. A `pytest` fixture that
builds an in-memory DB at the old schema and asserts the backfill is ~40 lines and covers
the highest-consequence code in the repo. Second priority: golden-file tests for
`services/email_parser.py`, which will break silently when a bank changes its email
template.

**10. Automate backups before the next schema change.** A systemd timer running the
`sqlite3 .backup` loop from `DEPLOYMENT.md:61-69` nightly, with a retention prune, is
~15 lines and is the only thing standing between a bad migration and permanent data loss.
`data/backups/` is already gitignored (`.gitignore:8`) and the restore path
(`DEPLOYMENT.md:208-216`) is already written — only the trigger is missing.

**11. Move the scheduler out of the gunicorn arbiter.** A separate
`finance-sync.service` + `finance-sync.timer` invoking `scheduled_sync_all` would remove
application work from the supervisor process, remove the `SIGHUP`-duplication risk, give
you `journalctl -u finance-sync` for free, and let you drop the `on_starting` hook
(`gunicorn.conf.py:18-23`) and the `RUN_SCHEDULER` env var (`app.py:111`) entirely. It
would also stop long IMAP fetches from occupying one of only two workers if you route
manual sync through it too.

**12. Add `logrotate` for `logs/access.log`.** Gunicorn never rotates
(`gunicorn.conf.py:11-12`). A `deploy/logrotate.conf` alongside the existing unit files
fits the repo's existing "version the ops config" pattern. Consider switching Flask's
handler to `WatchedFileHandler` at the same time, which *is* multi-process safe when
paired with logrotate — that also resolves the `preload_app` rotation hazard.

**13. Housekeeping that costs nothing:** delete `frontend/public/icons.svg` (dead Vite
template sprite, currently served in prod), the 0-byte `frontend/src/App.css`, the
~50 lines of dead CSS (`index.css:262-276, 474-477, 579-581, 701-721`), the
`worker_exit` no-op (`gunicorn.conf.py:26-27`), and the `scripts/*` entry in
`ruff.toml:17`. Replace `frontend/README.md` (still the stock Vite template) and
`frontend/public/favicon.svg` (still the Vite logo). Prune the five merged branches. Move
`data/prod_db.db` off the dev machine or encrypt it, and `chmod 600 .env` locally.

**14. Reconcile the docs.** `README.md:444-472` and `DEPLOYMENT.md:47-53` say opposite
things about migrations, and `README.md:396` states a bind address that would be a
security finding if it were true. Fix the schema block (`README.md:174-180`), the four
wrong API paths, and the `auth_token`/`finance_token` key — then resolve the
`DO NOT MERGE TO MAIN!!` header one way or the other. A README that is wrong in a dozen
checkable places is worse than a shorter one that is right.
