# Personal Finance App (Kyle's fork)

A self-hosted personal finance tracker with a Flask/SQLite backend and a React 19 frontend. This is my personal fork — it runs on my own Linux box at home and is exposed at `budget.kotero.dev` via a Cloudflare Tunnel. Transactions are imported from Capital One, Amex, or Venmo CSV/email, or synced automatically from Gmail.

This fork tracks its own history independently of any upstream repo — I don't merge changes from elsewhere into it, and I don't expect it to be merged anywhere. `scripts/manage.sh` (see [Setup & Management Script](#setup--management-script)) is the one command you need for setup, running, and day-to-day upkeep.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Prerequisites](#prerequisites)
3. [Setup & Management Script](#setup--management-script)
4. [Local Development Setup (manual)](#local-development-setup-manual)
5. [Environment Variables](#environment-variables)
6. [Database Architecture](#database-architecture)
7. [API Reference](#api-reference)
8. [Authentication & Security](#authentication--security)
9. [Gmail Sync](#gmail-sync)
10. [Frontend Structure](#frontend-structure)
11. [Production Deployment](#production-deployment)
12. [GitHub & SQLite — What to Commit](#github--sqlite--what-to-commit)
13. [Linting & Formatting](#linting--formatting)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  React 19 (Vite)  ←  served as static files by Flask    │
│  React Router v7, Recharts                               │
└────────────────────┬────────────────────────────────────┘
                     │ /api/* (proxied in dev by Vite)
┌────────────────────▼────────────────────────────────────┐
│  Flask (Gunicorn in production, 2 workers)               │
│  Blueprints: auth, transactions, dashboard,              │
│              categories, import, sync, profile, admin    │
└────────┬───────────────────────────┬────────────────────┘
         │                           │
┌────────▼──────────┐   ┌────────────▼────────────────────┐
│  data/master.db   │   │  data/user_{id}_finance.db       │
│  (users table)    │   │  per-user: transactions,         │
│                   │   │  categories, budgets, profile    │
└───────────────────┘   └─────────────────────────────────┘
```

**Key design decisions:**

- **Per-user SQLite files.** Each user gets their own `data/user_{id}_finance.db`. There is no cross-user data sharing. `master.db` only holds the users table for login.
- **JWT authentication.** Tokens are HS256, 7-day TTL, signed with `SECRET_KEY`. Every API route behind `@require_auth` validates the `Authorization: Bearer <token>` header.
- **Fernet encryption for Gmail app passwords.** The app password is never stored in plaintext — it is encrypted with `ENCRYPTION_KEY` before being written to the `profile` table.
- **APScheduler runs in the gunicorn master process** (via `on_starting` hook in `gunicorn.conf.py`) so only one scheduler instance runs across all workers.
- **Flask serves the React build.** `npm run build` outputs to `frontend/dist/`, and Flask's SPA catch-all route serves `index.html` for all non-API paths.

---

## Prerequisites

| Tool | Version |
|------|---------|
| Python | 3.11+ |
| Node.js | 18+ |
| npm | 9+ |

No external database server required — SQLite is bundled with Python.

---

## Setup & Management Script

`scripts/manage.sh` is a single entry point for everything below — first-time install, running it day to day, and ongoing upkeep. It detects whether it's on my Linux host (systemd + cloudflared present) or a plain dev machine (Mac) and adjusts what it does accordingly.

```bash
./scripts/manage.sh help
```

```
Setup
  setup                     Create venv, install deps, build frontend, write .env
  install-service           (sudo, Linux) Install/enable the systemd units

Run
  dev                       Run Flask + Vite dev servers locally
  start / stop / restart    Control the finance-app systemd service
  status                    Show finance-app (and cloudflared, if installed) status
  logs                      Follow app logs (journalctl in prod, logs/app.log in dev)
  tunnel {start|stop|restart|status|logs}
                             Control the cloudflared systemd service

Maintain
  update                    git pull, reinstall deps, rebuild frontend, restart
  backup                    Snapshot all data/*.db files to data/backups/<timestamp>/
  create-user <user> <email> [--admin]
                             Create an account (owner-only, no public registration)
  set-password <user>       Reset a user's password
```

**First time on a fresh checkout (dev machine or the Linux host):**

```bash
./scripts/manage.sh setup
./scripts/manage.sh create-user <username> <email> --admin
```

- On a Mac/dev machine, `setup` writes a local `.env` (dev secrets, `DEBUG=true`) and you're done — run `./scripts/manage.sh dev` to start both Flask and Vite.
- On the Linux host, `setup` builds `.env` from `deploy/env.production` with freshly generated `SECRET_KEY`/`ENCRYPTION_KEY` (you still need to set `ALLOWED_ORIGIN`), then you run `sudo ./scripts/manage.sh install-service` once to register the `finance-app` and `cloudflared` systemd units, and `./scripts/manage.sh start`.

**Day to day on the host:**

```bash
./scripts/manage.sh status         # is it up?
./scripts/manage.sh logs           # tail logs
./scripts/manage.sh update         # pull latest, reinstall deps, rebuild, restart
./scripts/manage.sh backup         # snapshot the SQLite DBs before anything risky
```

---

## Local Development Setup (manual)

The steps below are what `./scripts/manage.sh setup` + `./scripts/manage.sh dev` do for you — useful if you want to run a step by hand or understand what's happening.

### 1. Backend

```bash
# Create and activate a virtual environment
python3 -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate

# Install Python dependencies
pip install -r requirements.txt
```

### 2. Create your `.env` file

```env
SECRET_KEY=<at-least-64-hex-chars>
ENCRYPTION_KEY=<fernet-key>
DEBUG=true
DB_PATH=data/finance.db
ALLOWED_ORIGIN=http://localhost:5173
RUN_SCHEDULER=false
```

Generate the keys:

```bash
# SECRET_KEY
python3 -c "import secrets; print(secrets.token_hex(32))"

# ENCRYPTION_KEY
python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

### 3. Run the backend

```bash
python app.py
# Starts on http://localhost:5100
```

The `data/` directory and both SQLite databases are created automatically on first run.

### 4. Frontend

```bash
cd frontend
npm install
npm run dev
# Starts on http://localhost:5173
# /api/* requests are proxied to localhost:5100 by Vite
```

### 5. Create your account

There's no public registration form — accounts are created from the shell:

```bash
./scripts/manage.sh create-user <username> <email> --admin
```

---

## Environment Variables

All variables are loaded from `.env` via `python-dotenv`. `config.py` validates them at startup — the app **will not start** if required vars are missing or inconsistent.

| Variable | Required | Description |
|----------|----------|-------------|
| `SECRET_KEY` | Yes | JWT signing key. Minimum 32 characters. Use `secrets.token_hex(32)`. |
| `ENCRYPTION_KEY` | Yes | Fernet key for encrypting Gmail app passwords. Generate with `Fernet.generate_key()`. **Keep this stable** — if it changes, stored Gmail credentials become unreadable. |
| `DEBUG` | Yes | `true` in development, `false` in production. Mismatching this with `ALLOWED_ORIGIN` raises a startup error. |
| `ALLOWED_ORIGIN` | Yes | Frontend origin for CORS. `http://localhost:5173` in dev; your public URL in prod. |
| `DB_PATH` | No | Path for `master.db`. Defaults to `data/finance.db` (the `master.db` is placed in the same directory). |
| `RUN_SCHEDULER` | No | Set `true` to run APScheduler inside Flask (dev/single-process only). Leave `false` in production — gunicorn starts the scheduler via its `on_starting` hook instead. |
| `LOG_FILE` | No | Defaults to `logs/app.log`. |

> **Critical:** `ENCRYPTION_KEY` is tied to the machine where Gmail credentials were saved. If you move to a new machine with a different key, re-enter Gmail credentials through the app so they get re-encrypted with the new key.

---

## Database Architecture

### `data/master.db` — global users

```sql
users (id, username, email, password_hash, is_admin, created_at, last_login_at)
```

Passwords are hashed with bcrypt. This DB is never exposed to the frontend directly.

### `data/user_{id}_finance.db` — per-user data

```sql
categories   (id, name, sort_order, is_misc)
transactions (id, amount, merchant_raw, direction, category_id, notes,
              transaction_at, created_at, source_hash, reimburses_id)
profile      (id=1, gmail_address, gmail_app_password_enc, last_synced_at, ...)
budgets      (id, category_id, amount, period, fold_into_misc)
```

**Key fields:**

- `direction` — `"inflow"` (money received) or `"outflow"` (money spent).
- `source_hash` — SHA hash of the raw email/CSV row, used as a dedup key (`UNIQUE` constraint). Reimporting the same CSV will not create duplicates.
- `reimburses_id` — FK pointing to an outflow transaction that this inflow reimburses. Enables the net-cost calculation. Multiple inflows can point to the same outflow (partial reimbursements).
- `categories.is_misc` — at most one category is flagged as the Misc/Flex bucket. Any other category's spend that exceeds its own budget, plus the full spend of any category with `fold_into_misc` set, rolls into this category's total instead of just going negative. Set via `PUT /api/categories/<id>/misc` or the "Set Misc" control in Profile.
- `budgets.fold_into_misc` — when set, that category's entire spend (not just the overflow) counts toward Misc, effectively giving the category a $0 budget of its own.

All connections use `PRAGMA journal_mode=WAL` for concurrent read safety and `PRAGMA foreign_keys=ON`.

The schema is applied via `db_context.init_user_db()` which is idempotent (`CREATE TABLE IF NOT EXISTS`). A fresh user DB gets 9 default categories and an empty `profile` row automatically.

---

## API Reference

All routes are prefixed `/api/`. Every route except auth requires `Authorization: Bearer <token>`.

### Auth — `/api/auth`

There is intentionally no `/api/auth/register` route — accounts are created owner-side via `./scripts/manage.sh create-user` (see [Setup & Management Script](#setup--management-script)).

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/auth/login` | Returns `{token, user}`. Token TTL: 7 days. Rate-limited: 20/min, 100/hr. |
| `POST` | `/api/auth/change-password` | Body: `{current_password, new_password}`. Rate-limited: 10/hr. |
| `GET` | `/api/auth/me` | Current user info. |

### Transactions — `/api/transactions`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/transactions` | Paginated list. See query params below. |
| `POST` | `/api/transactions` | Create manually. |
| `PUT` | `/api/transactions/<id>` | Update. |
| `DELETE` | `/api/transactions/<id>` | Delete. |

**`GET /api/transactions` query params:**

| Param | Type | Description |
|-------|------|-------------|
| `limit` | int (max 200) | Page size. Default 25. |
| `offset` | int | Pagination offset. |
| `date_from` | `YYYY-MM-DD` | Filter start date (inclusive). |
| `date_to` | `YYYY-MM-DD` | Filter end date (inclusive, extended to 23:59:59). |
| `category_id` | int | Filter by category. |
| `status` | `pending` \| `confirmed` | `pending` = uncategorized, `confirmed` = categorized. |
| `q` | string | Free-text search across merchant, notes, amount. |
| `source` | `venmo` \| `credit` | Filter by transaction source. |
| `sort` | string | `date_desc` (default), `date_asc`, `amount_desc`, `amount_asc`, `merchant_asc`. |
| `include_ids` | comma-separated ints | Always include these transaction IDs regardless of other filters (used for pinned transactions). |

### Dashboard — `/api/dashboard`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/dashboard` | Totals, category breakdown, pending count. |
| `GET` | `/api/dashboard/trend` | Monthly spending trend (bar chart data). |
| `GET` | `/api/dashboard/merchants` | Top merchants by net spend + largest transaction. |
| `GET` | `/api/dashboard/comparison` | Current vs previous period comparison. |

All dashboard endpoints accept `start_date`, `end_date`, and `include_ids` query params.

### Categories — `/api/categories`

CRUD for categories, plus `PUT /api/categories/reorder` and `PUT /api/categories/<id>/misc` (`{is_misc: true|false}`) to designate the Misc/Flex bucket — see [Database Architecture](#database-architecture). `GET /api/transactions/merchants/unclassified` returns merchants with uncategorized transactions for the bulk-classify workflow.

### Import — `/api/import`

`POST /api/import/transactions` — multipart form upload. Fields: `source_type` (`capitalone` | `venmo` | `amex`), `file` (one or more files). Returns `{imported, duplicates_skipped, errors}`.

### Sync — `/api/sync`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sync/status` | Last sync time, credentials configured flag. |
| `POST` | `/api/sync/now` | Trigger manual Gmail sync. |

### Profile — `/api/profile`

`GET`/`PUT` for category budgets and Gmail credentials.

---

## Authentication & Security

**Flow:**
1. `POST /api/auth/login` → bcrypt verifies password → returns a signed JWT.
2. Frontend stores the token in `localStorage` and attaches it as `Authorization: Bearer <token>` on every request.
3. `@require_auth` decorator decodes and validates the token, sets `g.current_user`.
4. `@require_admin` can be stacked after `@require_auth` for admin-only routes.

**Token structure:**
```json
{ "sub": "1", "username": "alice", "is_admin": false, "exp": <7 days from now> }
```

**CORS:** The `ALLOWED_ORIGIN` env var is checked at startup and used for CORS headers. The startup guard prevents running with `DEBUG=true` against a production origin (and vice versa) to catch accidental misconfigurations.

---

## Gmail Sync

The app can read Capital One, Amex, and Venmo transaction notification emails directly from a Gmail inbox using IMAP (Capital One Zelle transfers too).

**Setup (per user):**
1. Enable [2-Step Verification](https://myaccount.google.com/signinoptions/two-step-verification) on the Gmail account.
2. Generate a [Gmail App Password](https://myaccount.google.com/apppasswords).
3. Enter the Gmail address and app password in the app's Profile → Gmail Setup page.
4. The app password is encrypted with `ENCRYPTION_KEY` before being stored in `profile.gmail_app_password_enc`.

**Sync schedule:** Runs daily at 3:00 AM via APScheduler. In production, the scheduler lives in the gunicorn master process (started by `on_starting` in `gunicorn.conf.py`). It iterates all users, decrypts their app passwords, fetches unread notification emails, parses them, and inserts deduplicated transactions.

**Manual sync:** Available via the sync button on the Home page (calls `POST /api/sync/now`).

**Email parsing:** `services/email_parser.py` uses BeautifulSoup to parse HTML emails from Capital One, Amex, and Venmo. Each parsed transaction gets a `source_hash` derived from the raw email content — re-syncing the same emails will not create duplicates.

---

## Frontend Structure

```
frontend/src/
├── api.js                    # All API calls — single source of truth for backend URLs
├── App.jsx                   # Router setup, nav bar, auth gate
├── pages/
│   ├── Dashboard.jsx         # Home page — stat tiles, charts, category breakdown
│   ├── Transactions.jsx      # Full transaction list with filters, sort, pagination
│   ├── Profile.jsx           # Category budgets, Gmail credentials, account settings
│   ├── GmailSetup.jsx        # Gmail IMAP setup instructions
│   ├── Login.jsx
│   ├── Import.jsx            # CSV import UI
│   └── Admin.jsx             # User management (admin only)
├── components/
│   ├── CategoryBreakdown.jsx # Category list with budget progress bars
│   ├── CategoryDonut.jsx     # Donut chart (Recharts)
│   ├── SpendingTrendChart.jsx # Monthly bar chart (Recharts)
│   ├── MerchantInsights.jsx  # Top merchants, largest transaction, recurring
│   ├── ComparisonCard.jsx    # Current vs previous period delta
│   ├── PinPickerModal.jsx    # Search and pin transactions outside the date range
│   ├── ReimbursePickerModal.jsx # Link an inflow to an outflow it reimburses
│   └── DuplicatesModal.jsx   # Review and delete duplicate transactions
├── hooks/
│   ├── useDashboardFilters.js  # Range selection, custom dates, pinned IDs — all persisted to localStorage
│   └── usePwaSync.js           # Background sync on PWA resume
└── context/
    ├── AuthContext.jsx       # JWT storage, login/logout
    └── OnlineContext.jsx     # navigator.onLine listener
```

**State persistence (localStorage):**

| Key | Contents |
|-----|----------|
| `auth_token` | JWT string |
| `dashboard_range` | Active range value (`this_month`, `custom`, etc.) |
| `dashboard_custom_start` / `dashboard_custom_end` | Custom date range |
| `pinned_txn_ids` | JSON array of pinned transaction IDs — shared between Dashboard and Transactions pages |

**Pinned transactions:** The Dashboard allows pinning transactions outside the active date range so they still appear in all metrics. The same `pinned_txn_ids` localStorage key is read by the Transactions page — when a date filter is active and pins exist, the frontend adds `include_ids=<csv>` to the API call so pinned rows always appear in the list.

**Reimbursements:** An inflow transaction can be linked to an outflow via `reimburses_id`. Multiple inflows can reimburse the same outflow. The outflow row shows a "Net" badge and full net-cost breakdown in the expanded view.

---

## Production Deployment

Runs on my home Linux box at `/home/kyleotero/projects/PersonalFinanceApp`, exposed at `https://budget.kotero.dev` via a Cloudflare Tunnel (no ports forwarded on the router). `./scripts/manage.sh` wraps everything below.

### 1. First-time setup on the host

```bash
git clone https://github.com/kyleotero/PersonalFinanceApp.git ~/projects/PersonalFinanceApp
cd ~/projects/PersonalFinanceApp
./scripts/manage.sh setup
# edit .env — set ALLOWED_ORIGIN=https://budget.kotero.dev
```

### 2. Cloudflare Tunnel

```bash
cloudflared tunnel create budget
# prints a Tunnel ID and writes ~/.cloudflared/<TUNNEL_ID>.json

cp deploy/cloudflared-config.yml ~/.cloudflared/config.yml
# edit config.yml — set the tunnel id + credentials-file path to match what was just created

cloudflared tunnel route dns budget budget.kotero.dev
```

### 3. Install and start the systemd services

```bash
sudo ./scripts/manage.sh install-service   # installs + enables finance-app and cloudflared units
./scripts/manage.sh start
./scripts/manage.sh status
```

Gunicorn binds `127.0.0.1:5100` (see `gunicorn.conf.py`) — it's only reachable through the tunnel, not directly on the LAN.

### 4. Create your account

```bash
./scripts/manage.sh create-user <username> <email> --admin
```

### 5. Deploying updates

```bash
./scripts/manage.sh update
```

This runs `git pull --ff-only`, reinstalls Python/npm dependencies, rebuilds the frontend, and restarts `finance-app`. `data/`, `.env`, and `logs/` are never touched by any of this — they aren't tracked by git (see [What to Commit](#github--sqlite--what-to-commit)) and nothing in `update` writes to them.

Before anything that touches the schema or feels risky:

```bash
./scripts/manage.sh backup
```

#### Schema migrations

The schema uses `CREATE TABLE IF NOT EXISTS` for new tables, and `db_context._migrate()` runs on every connection to add any new columns to existing tables (each `ALTER TABLE` is wrapped so it's a no-op once applied) — so a plain `./scripts/manage.sh update` + restart is enough for both. No manual `ALTER TABLE` step needed.

### 6. Logs

```bash
./scripts/manage.sh logs           # journalctl -u finance-app -f
./scripts/manage.sh tunnel logs    # journalctl -u cloudflared -f

# Or directly:
tail -f logs/app.log
tail -f logs/access.log
```

---

## GitHub & SQLite — What to Commit

**The `.gitignore` already excludes the right things:**

```
data/*.db        # All SQLite database files — contain real financial data
data/*.db-shm    # WAL shared memory file
data/*.db-wal    # WAL write-ahead log
data/backups/    # ./scripts/manage.sh backup output
.env             # Secret keys — NEVER commit
logs/
venv/
frontend/node_modules/
frontend/dist/
```

**What this means practically:**

- **Never commit `data/`** — it contains your personal financial transactions, Gmail app passwords (encrypted but still private), and user accounts. Add it to `.gitignore` and keep it there.
- **Never commit `.env`** — it contains your `SECRET_KEY` and `ENCRYPTION_KEY`. If these leak, anyone can forge JWTs and decrypt stored credentials.
- The database schema lives in `db_context.py` and `models/user.py` — the actual `.db` files are created at runtime from code, so nothing is lost by excluding them from git.
- If you want to back up your data, run `./scripts/manage.sh backup` (writes timestamped copies to `data/backups/`, also gitignored) and copy that directory somewhere safe (external drive, encrypted cloud storage). **Do not use git for this.**

---

## Linting & Formatting

```bash
# Run all linters
make lint

# Auto-fix
make format
```

Backend uses [Ruff](https://docs.astral.sh/ruff/) (`ruff.toml`). Frontend uses ESLint with `eslint-plugin-react-hooks` and `eslint-plugin-react-refresh`.

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
