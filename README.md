# DO NOT MERGE TO MAIN (without letting me know)!!

# Personal Finance App

A self-hosted personal finance tracker with a Flask/SQLite backend and a React 19 frontend.
Designed to run on a Raspberry Pi (or any Linux box) and optionally exposed via a Cloudflare
Tunnel. Transactions arrive via CSV import (Capital One, Amex, Venmo) or automatic Gmail
sync (Capital One, Amex, Venmo, and Capital One Zelle notification emails).

For a full walkthrough of what the app actually does, see **[FEATURES.md](./FEATURES.md)**.
This README covers running and deploying it.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Prerequisites](#prerequisites)
3. [Local Development Setup](#local-development-setup)
4. [Environment Variables](#environment-variables)
5. [Database Architecture](#database-architecture)
6. [API Reference](#api-reference)
7. [Authentication & Security](#authentication--security)
8. [Gmail Sync](#gmail-sync)
9. [Frontend Structure](#frontend-structure)
10. [Production Deployment (Raspberry Pi)](#production-deployment-raspberry-pi)
11. [GitHub & SQLite — What to Commit](#github--sqlite--what-to-commit)
12. [Linting & Formatting](#linting--formatting)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  React 19 (Vite), React Router v7, Recharts              │
│  served as static files by Flask in production;          │
│  served by the Vite dev server (proxying /api) in dev    │
└────────────────────┬────────────────────────────────────┘
                     │ /api/*
┌────────────────────▼────────────────────────────────────┐
│  Flask (Gunicorn in production, 2 sync workers)          │
│  Blueprints: auth, transactions, reimbursements,         │
│    categories, dashboard, import, sync, profile, admin   │
└────────┬───────────────────────────┬────────────────────┘
         │                           │
┌────────▼──────────┐   ┌────────────▼────────────────────┐
│  data/master.db   │   │  data/user_{id}_finance.db       │
│  (users table)    │   │  per-user: transactions,         │
│                   │   │  reimbursement_links, categories,│
│                   │   │  budgets, profile                │
└───────────────────┘   └─────────────────────────────────┘
```

**Key design decisions:**

- **Per-user SQLite files.** Each account gets its own `data/user_{id}_finance.db`. There is
  no cross-user data sharing anywhere — every query is scoped to the authenticated user's
  own database file. `master.db` holds only the `users` table, used for login.
- **JWT authentication.** Tokens are HS256, 7-day TTL, signed with `SECRET_KEY`. Every route
  except `/api/auth/register` and `/api/auth/login` requires
  `Authorization: Bearer <token>`, validated by the `@require_auth` decorator.
- **Fernet encryption for Gmail app passwords.** Never stored in plaintext — encrypted with
  `ENCRYPTION_KEY` before being written to the `profile` table.
- **Automatic, idempotent schema migrations.** Every time a per-user database connection is
  opened, `db_context._migrate()` brings its schema up to date (adds any missing columns,
  creates the `reimbursement_links` table if absent, runs one-time data backfills). New
  columns and tables added to the schema in code appear on existing databases the next time
  they're opened — no manual `ALTER TABLE` step, on the Pi or anywhere else.
- **APScheduler runs once, in the Gunicorn arbiter process** (`on_starting` hook in
  `gunicorn.conf.py`), not inside a worker — so exactly one scheduler instance runs
  regardless of worker count, and it survives worker restarts.
- **Flask serves the React build in production.** `npm run build` outputs to
  `frontend/dist/`; Flask's catch-all route serves `index.html` for any non-`/api` path
  (client-side routing), and a real file under `dist/` for anything that matches one.

---

## Prerequisites

| Tool | Version |
|------|---------|
| Python | 3.10+ (developed against 3.10; no version-specific syntax used beyond that) |
| Node.js | 18+ |
| npm | 9+ |

No external database server required — SQLite is bundled with Python.

---

## Local Development Setup

### 1. Clone and enter the repo

```bash
git clone <repo-url>
cd PersonalFinanceApp
```

### 2. Backend

```bash
python3 -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

### 3. Create your `.env` file

```bash
cp deploy/env.production .env
```

Minimal `.env` for local dev:

```env
SECRET_KEY=<at-least-32-chars>
ENCRYPTION_KEY=<fernet-key>
DEBUG=true
ALLOWED_ORIGIN=http://localhost:5173
RUN_SCHEDULER=false
```

Generate the keys:

```bash
# SECRET_KEY (config.py requires at least 32 characters)
python3 -c "import secrets; print(secrets.token_hex(32))"

# ENCRYPTION_KEY (must be a valid Fernet key)
python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

`config.py` validates all of this at import time and refuses to start the app if a required
variable is missing, `SECRET_KEY` is too short, or `DEBUG`/`ALLOWED_ORIGIN` look
inconsistent with each other (e.g. `DEBUG=true` against a non-localhost origin).

### 4. Run the backend

```bash
python app.py
# Starts on http://0.0.0.0:5100 (dev only — see note below)
```

The `data/` directory and `master.db` are created automatically on first run; each user's
finance database is created the moment their account is registered.

> Running `python app.py` directly binds `0.0.0.0`, i.e. reachable from your whole LAN,
> which is fine for local development. **Production does not use this path** — it runs
> under Gunicorn, which binds `127.0.0.1` only (see
> [Production Deployment](#production-deployment-raspberry-pi)).

### 5. Frontend

```bash
cd frontend
npm install
npm run dev
# Starts on http://localhost:5173
# /api/* requests are proxied to localhost:5100 by Vite (see vite.config.js)
```

### 6. Register your first account

Open `http://localhost:5173` and register. `REGISTRATION_ENABLED` is open by default (any
value other than the literal string `"false"`, including leaving it unset) — set it to
`false` once you've created the accounts you need, especially before exposing the app
publicly.

---

## Environment Variables

All variables load from `.env` via `python-dotenv`. `config.py` validates them at startup —
the app **will not start** if a required one is missing or looks inconsistent.

| Variable | Required | Description |
|----------|----------|-------------|
| `SECRET_KEY` | Yes | JWT signing key. Minimum 32 characters. Use `secrets.token_hex(32)`. |
| `ENCRYPTION_KEY` | Yes | Fernet key for encrypting Gmail app passwords. Generate with `Fernet.generate_key()`. **Keep this stable** — if it changes, every already-stored Gmail credential becomes undecryptable and must be re-entered. |
| `DEBUG` | Yes | `true` in development, `false` in production. `config.py` raises a startup error if this doesn't match what `ALLOWED_ORIGIN` looks like (a localhost URL vs. a real domain). |
| `ALLOWED_ORIGIN` | Yes | The single frontend origin allowed via CORS. `http://localhost:5173` in dev; your public URL in production. |
| `DB_PATH` | No | Controls only where `master.db` is placed — its *directory* is used (`Path(DB_PATH).parent`), defaulting to `data/`; the filename portion is ignored. **Per-user finance databases are unaffected by this variable** — `db_context.get_db_path()` always writes them to a hardcoded `data/user_<id>_finance.db`, regardless of `DB_PATH`. In practice, leave this unset and everything lives under `data/`. |
| `RUN_SCHEDULER` | No | Set `true` to also run APScheduler inside the Flask dev process (`python app.py`). Leave unset/`false` in production — Gunicorn's `on_starting` hook (`gunicorn.conf.py`) starts the scheduler once, in the arbiter, instead. |
| `REGISTRATION_ENABLED` | No | Set to the literal string `false` to close public registration. Any other value, or leaving it unset, leaves registration open. |
| `LOG_FILE` | No | Defaults to `logs/app.log`. |

---

## Database Architecture

### `data/master.db` — global users

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

Passwords are hashed with bcrypt (cost 12). This database is never exposed to the frontend
directly — only individual fields via `/api/auth/me` and the admin endpoints.

### `data/user_{id}_finance.db` — per-user data

```sql
categories (
    id, name, sort_order, is_misc
)

transactions (
    id, amount, merchant_raw, direction, category_id, notes,
    transaction_at, created_at, source_hash,
    reimburses_id,                -- legacy single-link column, superseded by reimbursement_links
    reimbursement_status, reimbursement_mode, reimbursement_value,  -- legacy, superseded by expected_reimbursement
    expected_reimbursement,       -- current: optimistic exclusion amount
    reimbursement_external        -- current: 1 if settled outside the app entirely
)

reimbursement_links (
    id, inflow_id, outflow_id, amount, created_at
)

budgets (
    id, category_id, amount, period,       -- period: 'monthly' | 'yearly'
    fold_into_misc                          -- 1 = pools into the Misc/Flex bucket
)

profile (
    id=1, gmail_address, gmail_app_password_enc, last_synced_at,
    created_at, updated_at
)
```

**Key fields:**

- `direction` — `"inflow"` (money received) or `"outflow"` (money spent). Amounts are always
  stored positive; sign is purely presentational.
- `source_hash` — a `UNIQUE` dedup key computed from the raw CSV row or email content.
  Re-importing/re-syncing the same source never creates duplicate rows.
- `reimbursement_links` is the current model for recording that a specific inflow pays back
  a specific outflow (partially or fully; many-to-many). `reimburses_id` is an older,
  single-link column kept only so pre-existing rows still read correctly — it's backfilled
  into `reimbursement_links` automatically and should be treated as legacy.
- `expected_reimbursement` / `reimbursement_external` let you mark an outflow as (partially)
  not your own cost the moment you know it, before any money actually arrives.

All connections use `PRAGMA journal_mode=WAL` and `PRAGMA foreign_keys=ON`. Schema
migrations (new columns, the `reimbursement_links` table, one-time backfills) are applied
automatically and idempotently every time a per-user database is opened — see
`db_context.py:_migrate()`. A fresh account gets 9 default categories, a zeroed budget row
per category, and an empty `profile` row.

---

## API Reference

All routes are prefixed `/api/`. Every route except `POST /api/auth/register` and
`POST /api/auth/login` requires `Authorization: Bearer <token>`. Every response is
`{"data": ..., "error": null}` on success or `{"data": null, "error": "<message>"}` on
failure, with an appropriate HTTP status.

### Auth — `/api/auth`

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/register` | Create account. Body: `{username, email, password}`. 10/hour. |
| `POST` | `/login` | Body: `{username, password}` (username or email). Returns `{token, user}`. 20/min, 100/hour. |
| `POST` | `/change-password` | Body: `{current_password, new_password}`. 10/hour. |
| `GET`  | `/me` | Current user info. |

### Transactions — `/api/transactions`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/transactions` | Paginated list. See query params below. |
| `POST` | `/transactions` | Create manually. |
| `GET` | `/transactions/<id>` | Fetch one. |
| `PUT` | `/transactions/<id>` | Update. |
| `DELETE` | `/transactions/<id>` | Delete. Add `?force=true` to confirm removing linked reimbursements too. |
| `POST` | `/transactions/<id>/split` | Split into ≥2 parts. Body: `{parts: [{amount, category_id?, merchant_raw?, notes?}, ...]}`. |
| `GET` | `/transactions/merchants/unclassified` | Merchant groups with no category yet, for bulk classify. |
| `POST` | `/transactions/auto-classify` | Auto-assign categories to everything uncategorized, from history. |
| `POST` | `/transactions/bulk-categorize` | Body: `{merchant_raw, category_id}`. |
| `POST` | `/transactions/reclassify` | Body: `{merchant_raw, from_category_id, to_category_id}`. |
| `GET` | `/transactions/linkable-outflows` | Outflows eligible to be reimbursed, for the link picker. |
| `GET` | `/transactions/duplicates` | Grouped likely-duplicate rows for review. |
| `GET` | `/transactions/owed` | Outflows with an unrealized `expected_reimbursement`. |

**`GET /api/transactions` query params:**

| Param | Type | Description |
|-------|------|-------------|
| `limit` | int (1–200) | Page size. Default 25. |
| `offset` | int | Pagination offset. |
| `date_from` / `date_to` | `YYYY-MM-DD` | Inclusive range filter. |
| `category_id` | int | Filter by category (combinable with `status`). |
| `status` | `pending` \| `confirmed` | `pending` = uncategorized outflows; `confirmed` = categorized. |
| `q` | string | Free-text search across merchant, notes, amount. |
| `source` | `venmo` \| `credit` | Filter by inferred source. |
| `sort` | string | `date_desc` (default), `date_asc`, `amount_desc`, `amount_asc`, `merchant_asc`. |
| `include_ids` | comma-separated ints | Always include these ids regardless of other filters (pinning). |

### Reimbursements — `/api`

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/reimbursement-links` | Body: `{inflow_id, outflow_id, amount}`. |
| `DELETE` | `/reimbursement-links/<id>` | Remove a link. |
| `GET` | `/transactions/<id>/links` | Every link involving this transaction, either direction. |

### Categories — `/api/categories`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/categories` | List, ordered by `sort_order`. |
| `POST` | `/categories` | Body: `{name}`. |
| `DELETE` | `/categories/<id>` | 409 if any transaction still references it. |
| `PUT` | `/categories/reorder` | Body: `{order: [id, id, ...]}` — every id, exactly once. |
| `PUT` | `/categories/<id>/misc` | Body: `{is_misc}` — enforces exactly one Misc category. |

### Dashboard — `/api/dashboard`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/dashboard` | Totals, category breakdown, flex pool, pending count. |
| `GET` | `/dashboard/trend` | Spending/income series (daily/weekly/monthly, auto-picked). |
| `GET` | `/dashboard/merchants` | Top merchants, largest transaction, repeat merchants. |
| `GET` | `/dashboard/comparison` | Current vs. previous period, deltas, month-end projection. |

All four accept `start_date`, `end_date` (default: month-to-date). `/dashboard`,
`/dashboard/merchants`, and `/dashboard/comparison` also accept `include_ids` for pinned
transactions; `/dashboard/trend` deliberately does not (see
[FEATURES.md](./FEATURES.md#transactions) on pinning) — its fixed daily/weekly/monthly
buckets have nowhere to place a pinned date outside the chart's own range.

### Import — `/api/import`

`POST /api/import/transactions` — multipart form upload. Fields: `source_type`
(`capitalone` | `venmo` | `amex`), `file` (repeatable — multiple files in one request).

### Sync — `/api`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/sync/status` | Whether Gmail is configured and when it last synced. |
| `POST` | `/sync` | Trigger a synchronous sync now. |
| `PUT` | `/profile/gmail` | Save Gmail credentials (does a live IMAP login check first). |
| `DELETE` | `/profile/gmail` | Disconnect Gmail. |

### Profile — `/api/profile`

`GET` / `PUT` — category budgets (`{budgets: [{category_id, amount, period, fold_into_misc}, ...]}`).

### Admin — `/api/admin` (all require `is_admin`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/users` | List every account. |
| `POST` | `/users` | Create an account. |
| `PUT` | `/users/<id>` | Update username/email/admin flag. |
| `POST` | `/users/<id>/reset-password` | Set a new password for another user. |
| `DELETE` | `/users/<id>` | Delete an account and its finance database. |
| `POST` | `/users/<id>/sync` | Trigger a sync for another user. |
| `GET` | `/system` | Uptime, user count, runtime info. |
| `GET` | `/logs` | Tail of the application log. |

---

## Authentication & Security

**Flow:**
1. `POST /api/auth/login` → bcrypt verifies the password → a signed JWT is returned.
2. The frontend stores the token in `localStorage` (`finance_token`) and attaches it as
   `Authorization: Bearer <token>` on every request.
3. `@require_auth` decodes and validates the token and populates `g.current_user` from its
   claims.
4. `@require_admin` stacks after `@require_auth` for admin-only routes, checking the
   `is_admin` claim.

**Token payload:**
```json
{ "sub": "1", "username": "alice", "is_admin": false, "exp": <unix timestamp, 7 days out> }
```

**CORS/CSP:** `ALLOWED_ORIGIN` is the only origin ever granted CORS headers, checked at
startup for consistency with `DEBUG`. Every response carries a Content-Security-Policy,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and
`Referrer-Policy: strict-origin-when-cross-origin`.

**Rate limiting:** keyed on `CF-Connecting-IP` when present (so requests through the
Cloudflare Tunnel resolve to the real visitor, not the tunnel daemon), falling back to the
request's remote address otherwise. Limits are per-process (`memory://` storage) — with 2
Gunicorn workers, effective limits can run up to ~2x the configured number, and all counters
reset on a restart. Acceptable for a small, owner-operated deployment; upgrade to a shared
store (e.g. Redis) if you need a hard global limit.

---

## Gmail Sync

The app reads bank/payment notification emails directly from a Gmail inbox over IMAP —
no OAuth, no Google API project required, just an app password.

**Setup (per user, from Profile → Gmail Setup):**
1. Enable [2-Step Verification](https://myaccount.google.com/signinoptions/two-step-verification)
   on the Gmail account.
2. Generate a [Gmail App Password](https://myaccount.google.com/apppasswords).
3. Enter the Gmail address and app password. The app performs a live IMAP login check
   before saving, so a typo is caught immediately rather than failing silently overnight.
4. The password is Fernet-encrypted (`ENCRYPTION_KEY`) before being written to
   `profile.gmail_app_password_enc` — never stored in plaintext.

**What it parses:** Capital One purchase/credit alerts, Amex "Large Purchase Approved"
alerts, Venmo payment/charge notifications, and Capital One Zelle transfers (sent and
received).

**Schedule:** Daily at 3:00 AM, via APScheduler started once in the Gunicorn arbiter process
(`on_starting` in `gunicorn.conf.py`) — not per-worker, so it can't run twice concurrently.
"Sync now" on the Home/Profile page triggers the same logic immediately.

**Dedup & safety:** Each parsed email gets a stable hash from its Message-ID; re-syncing
never re-imports. An email is only marked `\Seen` once it's been **successfully** parsed —
one your parser doesn't yet recognize stays unread and is retried on the next sync, rather
than being silently marked read and lost.

---

## Frontend Structure

```
frontend/src/
├── api.js                        # All API calls — single source of truth for backend URLs
├── App.jsx                       # Router, bottom nav, auth gate, top-level error boundary
├── format.js                     # Shared currency formatting
├── pages/
│   ├── Dashboard.jsx             # Home — stat tiles, charts, category breakdown
│   ├── Transactions.jsx          # Full transaction list: filters, sort, pagination, modals
│   ├── Profile.jsx               # Category budgets, Gmail credentials, account settings
│   ├── GmailSetup.jsx            # Gmail IMAP setup instructions
│   ├── Import.jsx                # CSV import UI
│   ├── Login.jsx / Register.jsx
│   └── Admin.jsx                 # User management (admin only)
├── components/
│   ├── CategoryBreakdown.jsx     # Category list with budget progress bars
│   ├── CategoryDonut.jsx         # Donut chart (Recharts)
│   ├── CategoryEditModal.jsx / CategoryPicker.jsx
│   ├── SpendingTrendChart.jsx    # Spend/income line chart (Recharts)
│   ├── MerchantInsights.jsx      # Top merchants, largest transaction, repeat merchants
│   ├── ComparisonCard.jsx        # Current vs. previous period delta
│   ├── BudgetByCategoryWidget.jsx
│   ├── OwedWidget.jsx            # Outstanding-reimbursement tracker
│   ├── PinPickerModal.jsx        # Search and pin transactions outside the date range
│   ├── ReimbursePickerModal.jsx  # Link an inflow to an outflow it reimburses
│   ├── SplitModal.jsx / DuplicatesModal.jsx
│   ├── InstallPrompt.jsx
│   └── ProtectedRoute.jsx
├── hooks/
│   ├── useDashboardFilters.js    # Range selection, custom dates, pinned ids — localStorage-backed
│   ├── useDashboardWidgets.js    # Widget visibility/order — localStorage-backed
│   └── usePwaSync.js             # Re-sync on app resume/visibility change
└── context/
    ├── AuthContext.jsx           # Token storage, login/logout, current user
    └── OnlineContext.jsx         # navigator.onLine listener
```

**localStorage keys:**

| Key | Contents |
|-----|----------|
| `finance_token` | The JWT |
| `dashboard_range` | Active range value (`this_month`, `custom`, etc.) |
| `dashboard_custom_start` / `dashboard_custom_end` | Custom date range bounds |
| `pinned_txn_ids` | JSON array of pinned transaction ids — shared between Dashboard and Transactions |
| `dashboard_widgets_v1` | Widget order/visibility |

---

## Production Deployment (Raspberry Pi)

See **[DEPLOYMENT.md](./DEPLOYMENT.md)** for the full runbook — rsync deploy steps, systemd
service setup, the Cloudflare Tunnel config, backup/restore procedure, and troubleshooting.
The short version:

- Gunicorn binds `127.0.0.1:5100` only (`gunicorn.conf.py`) — reachable exclusively through
  whatever reverse proxy/tunnel you put in front of it. This is **not** the same as running
  `python app.py` directly, which binds `0.0.0.0` for local dev convenience.
- `data/`, `.env`, and `logs/` are never touched by a code deploy (rsync excludes them) —
  updating the app never risks your databases or secrets.
- New schema columns/tables apply themselves automatically on the next request after a
  restart; no manual `ALTER TABLE` step is needed on the server.

---

## GitHub & SQLite — What to Commit

**`.gitignore` already excludes:**

```
data/*.db        # All SQLite database files — contain real financial data
data/*.db-shm    # WAL shared memory file
data/*.db-wal    # WAL write-ahead log
.env             # Secret keys — NEVER commit
logs/
venv/
frontend/node_modules/
frontend/dist/
```

- **Never commit `data/`** — it holds real transactions, encrypted Gmail credentials, and
  account records.
- **Never commit `.env`** — it holds `SECRET_KEY` and `ENCRYPTION_KEY`. If these leak,
  anyone can forge JWTs and decrypt stored Gmail passwords.
- The schema lives in code (`db_context.py`, `models/user.py`) — nothing is lost by
  excluding the `.db` files; they're recreated from scratch by that code.
- To back up your data, copy the `data/` directory (or use `sqlite3 .backup`, see
  `DEPLOYMENT.md`) to a safe location. **Do not use git for this.**

---

## Linting & Formatting

```bash
make lint      # ruff check . && cd frontend && npx eslint src/
make format    # ruff format . && cd frontend && npx eslint src/ --fix
```

> `ruff` is not currently pinned in `requirements.txt` — install it separately into your venv
> (`pip install ruff`) or globally (`pipx install ruff`) before running `make lint`.

Backend uses [Ruff](https://docs.astral.sh/ruff/) (`ruff.toml`). Frontend uses ESLint with
`eslint-plugin-react-hooks` and `eslint-plugin-react-refresh`.

Individual commands:

```bash
# Backend
ruff check .
ruff format .

# Frontend
cd frontend
npx eslint src/
npx eslint src/ --fix
```
