# DO NOT MERGE TO MAIN!!

# Personal Finance App

A self-hosted personal finance tracker with a Flask/SQLite backend and a React 19 frontend. Designed to run on a Raspberry Pi (or any Linux box) and optionally exposed via Cloudflare Tunnel. Transactions can be imported from Capital One or Venmo CSV exports, or synced automatically from Gmail.

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

## Local Development Setup

### 1. Clone and enter the repo

```bash
git clone <repo-url>
cd PersonalFinanceApp
```

### 2. Backend

```bash
# Create and activate a virtual environment
python3 -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate

# Install Python dependencies
pip install -r requirements.txt
```

### 3. Create your `.env` file

Copy the example and fill in the two required secrets (see [Environment Variables](#environment-variables)):

```bash
cp deploy/env.production .env
```

Minimal `.env` for local dev:

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

### 4. Run the backend

```bash
python app.py
# Starts on http://localhost:5100
```

The `data/` directory and both SQLite databases are created automatically on first run.

### 5. Frontend

```bash
cd frontend
npm install
npm run dev
# Starts on http://localhost:5173
# /api/* requests are proxied to localhost:5100 by Vite
```

### 6. Register your first account

Open `http://localhost:5173` and register. By default `REGISTRATION_ENABLED` is not set so registration is open in dev. Set `REGISTRATION_ENABLED=false` in production after creating your account.

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
| `REGISTRATION_ENABLED` | No | Any value other than `false` allows new registrations. Omit or set `false` in production. |
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
categories   (id, name)
transactions (id, amount, merchant_raw, direction, category_id, notes,
              transaction_at, created_at, source_hash, reimburses_id)
profile      (id=1, monthly_income, savings_target,
              gmail_address, gmail_app_password_enc, last_synced_at, ...)
budgets      (id, category_id, amount)
```

**Key fields:**

- `direction` — `"inflow"` (money received) or `"outflow"` (money spent).
- `source_hash` — SHA hash of the raw email/CSV row, used as a dedup key (`UNIQUE` constraint). Reimporting the same CSV will not create duplicates.
- `reimburses_id` — FK pointing to an outflow transaction that this inflow reimburses. Enables the net-cost calculation. Multiple inflows can point to the same outflow (partial reimbursements).

All connections use `PRAGMA journal_mode=WAL` for concurrent read safety and `PRAGMA foreign_keys=ON`.

The schema is applied via `db_context.init_user_db()` which is idempotent (`CREATE TABLE IF NOT EXISTS`). A fresh user DB gets 9 default categories and an empty `profile` row automatically.

---

## API Reference

All routes are prefixed `/api/`. Every route except auth requires `Authorization: Bearer <token>`.

### Auth — `/api/auth`

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/auth/register` | Create account. Body: `{username, email, password}` |
| `POST` | `/api/auth/login` | Returns `{token, user}`. Token TTL: 7 days. |
| `GET` | `/api/auth/me` | Current user info. |
| `PUT` | `/api/auth/me` | Update username/email. |
| `PUT` | `/api/auth/me/password` | Change password. |

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

CRUD for categories. `GET /api/categories/unclassified-merchants` returns merchants with uncategorized transactions for bulk-classify workflow.

### Import — `/api/import`

`POST /api/import/csv` — multipart form upload. Accepts Capital One or Venmo CSV files. Field: `source` (`capitalone` | `venmo`), `file` (one or more CSVs).

### Sync — `/api/sync`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sync/status` | Last sync time, credentials configured flag. |
| `POST` | `/api/sync/now` | Trigger manual Gmail sync. |

### Profile — `/api/profile`

`GET`/`PUT` for monthly income, savings target, Gmail credentials.

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

The app can read Capital One and Venmo transaction notification emails directly from a Gmail inbox using IMAP.

**Setup (per user):**
1. Enable [2-Step Verification](https://myaccount.google.com/signinoptions/two-step-verification) on the Gmail account.
2. Generate a [Gmail App Password](https://myaccount.google.com/apppasswords).
3. Enter the Gmail address and app password in the app's Profile → Gmail Setup page.
4. The app password is encrypted with `ENCRYPTION_KEY` before being stored in `profile.gmail_app_password_enc`.

**Sync schedule:** Runs daily at 3:00 AM via APScheduler. In production, the scheduler lives in the gunicorn master process (started by `on_starting` in `gunicorn.conf.py`). It iterates all users, decrypts their app passwords, fetches unread notification emails, parses them, and inserts deduplicated transactions.

**Manual sync:** Available via the sync button on the Home page (calls `POST /api/sync/now`).

**Email parsing:** `services/email_parser.py` uses BeautifulSoup to parse HTML emails from Capital One and Venmo. Each parsed transaction gets a `source_hash` derived from the raw email content — re-syncing the same emails will not create duplicates.

---

## Frontend Structure

```
frontend/src/
├── api.js                    # All API calls — single source of truth for backend URLs
├── App.jsx                   # Router setup, nav bar, auth gate
├── pages/
│   ├── Dashboard.jsx         # Home page — stat tiles, charts, category breakdown
│   ├── Transactions.jsx      # Full transaction list with filters, sort, pagination
│   ├── Profile.jsx           # Monthly income, savings target
│   ├── GmailSetup.jsx        # Gmail credentials form
│   ├── Login.jsx / Register.jsx
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

## Production Deployment (Raspberry Pi)

### 1. Rsync the project to the Pi

Run this **on your Mac**, not the Pi:

```bash
rsync -avz --exclude='.env' --exclude='venv/' --exclude='frontend/node_modules/' \
      --exclude='frontend/dist/' --exclude='data/' --exclude='logs/' \
      --exclude='__pycache__/' \
      /path/to/PersonalFinanceApp/ rohitpras@<pi-ip>:~/PersonalFinanceApp/
```

### 2. On the Pi — first-time setup

```bash
cd ~/PersonalFinanceApp

# Python environment
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Node / frontend build
cd frontend
npm install
npm run build
cd ..

# Create production .env from the template
cp deploy/env.production .env
# Edit .env — fill in SECRET_KEY, ENCRYPTION_KEY, ALLOWED_ORIGIN
nano .env

# Create required directories
mkdir -p data logs
```

### 3. Install systemd service

```bash
sudo cp deploy/finance-app.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable finance-app
sudo systemctl start finance-app

# Check status
sudo systemctl status finance-app
sudo journalctl -u finance-app -f
```

The service runs gunicorn on `0.0.0.0:5100`. The app is accessible at `http://<pi-ip>:5100` on your local network.

### 4. Deploying updates

Run all three commands **from your Mac**. The `data/` and `.env` excludes mean user databases and secrets are never touched, regardless of what changed in the codebase.

```bash
# Step 1 — sync code to the Pi (safe to run anytime; never overwrites data/ or .env)
rsync -avz \
  --exclude='.env' \
  --exclude='venv/' \
  --exclude='frontend/node_modules/' \
  --exclude='frontend/dist/' \
  --exclude='data/' \
  --exclude='logs/' \
  --exclude='__pycache__/' \
  /path/to/PersonalFinanceApp/ rohitpras@<pi-ip>:~/PersonalFinanceApp/

# Step 2 — rebuild the frontend (only needed if you changed any frontend code)
ssh rohitpras@<pi-ip> "cd ~/PersonalFinanceApp/frontend && npm run build"

# Step 3 — restart the service to pick up backend changes
ssh rohitpras@<pi-ip> "sudo systemctl restart finance-app"
```

**What rsync never touches on the Pi:**

| Path | Why it's excluded |
|------|-------------------|
| `data/` | All SQLite databases — master + every user's finance DB |
| `.env` | Production secret keys |
| `logs/` | Runtime log files |
| `venv/` | Python environment (already installed) |
| `frontend/node_modules/` | npm packages (already installed) |
| `frontend/dist/` | Built assets — rebuilt separately in step 2 |

**Backend-only change** (no frontend edits): skip step 2, just steps 1 and 3.

**Frontend-only change**: all three steps — rsync delivers the source, step 2 rebuilds the bundle, step 3 restarts so Flask serves the new `dist/`.

**New Python dependency added** (`requirements.txt` changed): after step 1, run:

```bash
ssh rohitpras@<pi-ip> "cd ~/PersonalFinanceApp && source venv/bin/activate && pip install -r requirements.txt"
```

Then proceed to step 3.

#### Schema migrations

The schema uses `CREATE TABLE IF NOT EXISTS`, so **new tables** are created automatically on the next restart. However, **new columns on existing tables** are not — you must run `ALTER TABLE` manually on the Pi for each affected database.

```bash
ssh rohitpras@<pi-ip>
cd ~/PersonalFinanceApp
source venv/bin/activate

# Run for master.db if users table changed
python3 -c "
import sqlite3
conn = sqlite3.connect('data/master.db')
conn.execute('ALTER TABLE users ADD COLUMN new_col TEXT')
conn.commit(); conn.close()
"

# Run for each user's finance DB
python3 -c "
import sqlite3, glob
for path in glob.glob('data/user_*_finance.db'):
    conn = sqlite3.connect(path)
    conn.execute('ALTER TABLE transactions ADD COLUMN new_col TEXT')
    conn.commit(); conn.close()
    print('migrated', path)
"
```

Then restart the service.

### 5. Logs

```bash
# App logs
tail -f ~/PersonalFinanceApp/logs/app.log

# Gunicorn access log
tail -f ~/PersonalFinanceApp/logs/access.log

# Systemd journal
sudo journalctl -u finance-app -f
```

---

## GitHub & SQLite — What to Commit

**The `.gitignore` already excludes the right things:**

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

**What this means practically:**

- **Never commit `data/`** — it contains your personal financial transactions, Gmail app passwords (encrypted but still private), and user accounts. Add it to `.gitignore` and keep it there.
- **Never commit `.env`** — it contains your `SECRET_KEY` and `ENCRYPTION_KEY`. If these leak, anyone can forge JWTs and decrypt stored credentials.
- The database schema lives in `db_context.py` and `models/user.py` — the actual `.db` files are created at runtime from code, so nothing is lost by excluding them from git.
- If you want to back up your data, use `sqlite3` directly or copy the `data/` directory to a safe location (external drive, encrypted cloud storage). **Do not use git for this.**

**Backup your production databases manually:**

```bash
# On the Pi
sqlite3 ~/PersonalFinanceApp/data/master.db ".backup /path/to/backup/master.db"
sqlite3 ~/PersonalFinanceApp/data/user_1_finance.db ".backup /path/to/backup/user_1_finance.db"
```

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
