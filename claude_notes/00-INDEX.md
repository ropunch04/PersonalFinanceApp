# 00 — Index & State of the App

Entry point for `claude_notes/`. Written 2026-09-08 against HEAD `20f7f41` on `main`.
All five feature audits are read-only; this file consolidates them.
The full feature walkthrough is **[07-feature-map.md](./07-feature-map.md)**;
the actionable plan is **[06-remediation-plan.md](./06-remediation-plan.md)**.

---

## What this app is

A self-hosted personal-finance tracker. Flask (Python 3.10) + SQLite on the backend,
React 19 + Vite + React Router 7 + Recharts on the frontend, built to `frontend/dist/`
and served by Flask's own SPA catch-all (`app.py:102-108`). Auth is stateless HS256 JWT
with a 7-day TTL in `localStorage` (`auth/jwt_utils.py:7-18`, `frontend/src/api.js:1`).
Data lives in **one SQLite file per user** (`data/user_<id>_finance.db`,
`db_context.py:79-80`) plus a single `master.db` holding only `users`
(`models/user.py:9-19`) — tenant isolation is genuinely sound; no route ever takes a
user id from the request. Ingestion is two paths into one `transactions` table: CSV
upload (Capital One / Venmo / Amex, `services/import_service.py`) and nightly Gmail
IMAP scraping of bank alert emails (`services/email_parser.py`, five search branches),
both deduped only by a `source_hash TEXT UNIQUE` column. Deployed by manual `rsync` to
a Raspberry Pi, gunicorn (2 sync workers) on `127.0.0.1:5100` behind a Cloudflare Tunnel
at **trackmyspend.xyz**, with an APScheduler cron in the gunicorn arbiter running a
3 AM sync. This is a real, in-daily-use app with real money data — but **the app's
live database lives only on the Raspberry Pi.** `data/` is excluded from every rsync
deploy (`DEPLOYMENT.md:23`, `README.md:353,409`), so the `.db` files in this working
tree are disconnected local snapshots, not a live view of production. `data/prod_db.db`
(1,817 transactions, 2024-01-09 → 2026-08-23, last write Aug 23) is the most recent and
most useful of them, but it is a manually-pulled copy, not something this checkout reads
or writes. There are **zero tests**, **zero CI**, **zero indexes**, and **no automated
backups**.

> **⚠ Read before trusting any number below.** Findings that cite `prod_db.db`,
> `user_1_finance.db`, or `master.db` (duplicate-group counts, the dashboard math
> mismatches, reimbursement double-booking, which accounts exist, which files are
> orphaned) describe that **Aug-23 snapshot**, not the Pi's current state. They are solid
> evidence that the underlying code can produce these outcomes — the numbers came from
> real historical activity — but re-verify anything you're about to act on against the
> live Pi database first. Two claims in particular are not just dated but **specifically
> unverifiable from this checkout**: that `debugtest`/`smoketest2` are still live
> accounts, and that `user_2_finance.db` is still orphaned in production — both are
> read from this laptop's `master.db`, last touched 2026-07-22, which is not the
> production master DB. Check the Pi directly before deleting anything on that basis.
> Every finding that cites only `file:line` in the application source (not a database)
> is unaffected by this — those are static-code findings, true regardless of which
> machine runs them.

---

## Map of the notes

| Doc | Covers | Questions it answers |
|---|---|---|
| [01-auth-and-admin.md](./01-auth-and-admin.md) | JWT lifecycle, register/login/password change, `require_auth`/`require_admin`, admin user CRUD, rate limiting, per-user DB routing, CSP/CORS | Can a deleted or demoted user still act? What actually gates `/admin`? Where can an unauthenticated request 500 the server? What must change before opening registration? |
| [02-transactions-and-categories.md](./02-transactions-and-categories.md) | `GET/POST/PUT/DELETE /api/transactions`, filters/sort/pagination, categorization engine, reimbursement links, splits, duplicates, `Transactions.jsx` | Where can a user destroy data in one click? Which filters silently lie? Why are there three reimbursement models? What does the 1,351-line page component decompose into? |
| [03-dashboard-and-analytics.md](./03-dashboard-and-analytics.md) | `/api/dashboard`, `/trend`, `/merchants`, `/comparison`, `budget_service`, the seven widgets, `index.css` | Why does the donut disagree with the tile above it? What are the four definitions of "spent"? Why does the comparison card always show a crash in spending? Where are the ~50 hardcoded hexes? |
| [04-import-and-gmail-sync.md](./04-import-and-gmail-sync.md) | CSV format specs as implemented, IMAP pipeline, the five email parsers, auto-categorization, Fernet credential storage, scheduler | Why do emails get silently lost? Why can a re-exported CSV double your history? What must exist before Plaid or a fourth bank? |
| [05-platform-data-and-deploy.md](./05-platform-data-and-deploy.md) | Full schema, connection lifecycle, `_migrate()`, app shell, `api.js`, PWA status, Vite build, gunicorn/systemd/tunnel, tooling, README accuracy | Why is every request paying a migration cost? Is anything secret committed? Is it a PWA? What does the README get wrong? |

**Start with [07-feature-map.md](./07-feature-map.md)** if you want the single
walkthrough of *every* feature — what it is, how it works, what functions, what's broken,
and what to improve — with all 31 features in one place. Docs `01`-`05` above are the
per-area evidence behind it.

These documents are self-contained: every finding was derived from this repository's own
source, its live SQLite databases, and its logs. Nothing here depends on any other project
in the parent directory.

---

## State of the app

**Genuinely works well — do not touch casually:**

- **Per-user DB isolation.** All 38 `get_user_db` call sites pass the token's user id;
  no route derives a DB path from user input (`01`, §4). This is the app's best
  structural property.
- **JWT crypto.** HS256 with a pinned algorithm list (`auth/jwt_utils.py:22`) and a
  ≥32-char `SECRET_KEY` enforced at import (`config.py:8-9`).
- **Reimbursement-link arithmetic.** Over-application, over-linking, direction flips and
  amount reductions below what's applied are all correctly rejected
  (`routes/reimbursements.py:56-70`, `routes/transactions.py:222-295`). The netting SQL
  `MIN(MAX(expected, received), amount)` (`services/budget_service.py:11-20`) handles all
  four cases and cannot go negative — verified against a real over-linked prod row.
- **The Gmail pipeline in production.** Nightly 03:00 EDT sync has been writing rows
  continuously through 2026-08-23; all five parser branches have produced real data, and
  **zero** rows carry a fallback merchant (`Unknown Merchant`/`Venmo`/`Zelle`).
- **Credential validation before storage** — a live IMAP login probe before encrypting
  (`routes/sync_routes.py:24-31`). Good design.
- **Deployment posture**: localhost-only bind, explicit tunnel ingress with a 404
  catch-all, systemd hardening, ProxyFix + `CF-Connecting-IP` rate-limit keying.
- **Secrets hygiene**: no `.env`, `.db`, `data/` or `logs/` file has ever been committed
  on any branch (`05`, verified via `git log --diff-filter=A`).
- **Widget persistence** (`useDashboardWidgets.js:17-30`) — validated, self-healing,
  versioned. The best state code in the frontend; copy this pattern.

**Fragile:**

- Every authenticated request re-runs the whole migration script (`db_context.py:225`):
  ~9 failing `ALTER TABLE`s, a full-table `UPDATE`, and ~5 SELECTs, each swallowed by a
  bare `except: pass`. There is no `user_version`, no versioning of any kind.
- Zero indexes anywhere; every dashboard query is a full scan plus a correlated subquery
  per row against an unindexed `reimbursement_links`.
- Three coexisting reimbursement models; on prod **all 73 legacy `reimburses_id` rows are
  also represented as `reimbursement_links`** — double-booked, with two delete paths that
  disagree about which to clean up.
- Ingestion has no provenance: no `source`, `provider`, `external_id`, or `account_id`
  column. Everything infers source from `notes LIKE 'venmo:%'`.
- Sync runs synchronously inside a request with 2 workers and no IMAP timeout.
- 22 `useState` hooks in one 782-line component; ~50 hardcoded hexes duplicating CSS
  tokens; 7 empty `catch {}` blocks on the transactions page alone.

**Outright broken (users see wrong data or lose data today):**

- Splitting a transaction that a legacy reimbursement points at throws `IntegrityError`
  → 500 (73 such rows in prod).
- Deleting an outflow silently cascades away its reimbursement links with no warning.
- "Keep first, delete rest" in the duplicates modal deletes real transactions — the
  heuristic is exact 4-tuple equality and prod has **125** such groups, most of which are
  legitimate repeat purchases (7× MTA $2.90 on one day).
- Any password over 72 bytes → unhandled `ValueError` → HTTP 500, triggerable
  unauthenticated at `/api/auth/login` (reproduced: bcrypt 5.0.0 raises).
- The category donut labelled "Total Spent" shows **$5,911** while the "Money Out" tile
  directly above it shows **$1,416** for the same month.
- Every comparison delta is wildly negative for the first three weeks of every month
  (month-to-date compared against a full previous month).
- A drifted bank email template silently marks the message read and loses it forever.
- Deleting a user neither revokes their token nor durably deletes their data — their next
  request recreates the DB.

---

## Top ~25 issues, consolidated

Severity: **P0** = data loss, wrong money shown, or unauthenticated 500 · **P1** =
user-visible breakage or real security weakness · **P2** = fragility that blocks
extension.

| Sev | Area | file:line | Issue | Impact | Doc |
|---|---|---|---|---|---|
| P0 | Ingestion | `services/email_parser.py:379` | `mail.fetch(num,"(RFC822)")` implicitly sets `\Seen`; search filter is `UNSEEN`. The failure *is* counted in that sync's `errors` list, but nothing durable records which message or why (nightly sync logs only a count; manual sync's error list is returned but the UI drops it) | A template drift ⇒ email parses to `None`, is marked read, **never fetched again**. Effectively unrecoverable even though it's briefly counted | [04](./04-import-and-gmail-sync.md#bugs--issues) |
| P0 | Ingestion | `services/import_service.py:14` | `row_num` is inside the dedup hash | Re-exporting a CSV with a different window shifts every hash ⇒ **entire file re-imports**. Prod has 125 duplicate groups | [04](./04-import-and-gmail-sync.md#bugs--issues) |
| P0 | Transactions | `routes/transactions.py:381` (cf. `:315`) | Split deletes the parent without nulling legacy `reimburses_id` back-refs | `IntegrityError` → 500. **73 prod rows** are exposed | [02](./02-transactions-and-categories.md#bugs--issues) |
| P0 | Transactions | `routes/transactions.py:306-318` + `db_context.py:53-54` | Delete cascades `reimbursement_links` silently | Reimbursement history destroyed behind a bare `confirm()`; income totals shift | [02](./02-transactions-and-categories.md#bugs--issues) |
| P0 | Transactions | `DuplicatesModal.jsx:41-46` + `transactions.py:572-588` | "Keep first, delete rest" on exact-4-tuple matching | One click deletes 6 real subway swipes. Irreversible, no undo, no backup | [02](./02-transactions-and-categories.md#bugs--issues) |
| P0 | Auth | `routes/auth_routes.py:48,76,116,119`; `admin_routes.py:67,114` | bcrypt 5.0.0 raises on >72-byte passwords; four sites have no guard at all | Unauthenticated HTTP 500 at `/api/auth/login`. **Reproduced** | [01](./01-auth-and-admin.md#bugs--issues) |
| P0 | Auth | `auth/middleware.py:21-25` | `g.current_user` built purely from token claims; no DB revalidation | A deleted user keeps access 7 days and their next request **recreates the deleted DB** (`db_context.py:220-221`) | [01](./01-auth-and-admin.md#bugs--issues) |
| P0 | Auth | `auth/middleware.py:24` + `jwt_utils.py:14` | `is_admin` is a token claim, never re-read | A demoted admin keeps full admin powers for 7 days; only remedy is rotating `SECRET_KEY` | [01](./01-auth-and-admin.md#bugs--issues) |
| P0 | Dashboard | `services/budget_service.py:100-104` + `CategoryDonut.jsx:106` | `period='yearly'` categories join the whole calendar year but render in a month-scoped donut labelled "Total Spent" | Prod Aug 2026: donut **$5,911** vs tile **$1,416** | [03](./03-dashboard-and-analytics.md#bugs--issues) |
| P0 | Dashboard | `services/budget_service.py:62` vs `:92-96` | `total_spent` does not subtract inflows; `by_category[].spent` does | Two definitions of "spent" in one response object; can never be reconciled | [03](./03-dashboard-and-analytics.md#bugs--issues) |
| P0 | Dashboard | `routes/dashboard.py:246-248` | When `start.day == 1`, previous period is the whole prior month vs a month-**to-date** current | Every delta badge is wildly negative for ~3 weeks of every month; meaningless on This Year | [03](./03-dashboard-and-analytics.md#bugs--issues) |
| P0 | Dashboard | `routes/dashboard.py:104-146`, `:253-254` | `/trend` counts pinned ids in SQL but the densification loop never emits their buckets; `/comparison` gives pins to `current` only | Pinned spend vanishes from the chart and is double-counted across the comparison | [03](./03-dashboard-and-analytics.md#bugs--issues) |
| P0 | Ingestion | `services/import_service.py:114-115` | Unguarded `next(stream); next(stream)` outside the per-row `try` | Picking "Venmo" for a Cap One file ⇒ HTTP 500. Matches 3 unexplained import 500s in `logs/app.log.2` | [04](./04-import-and-gmail-sync.md#bugs--issues) |
| P0 | Ingestion | `email_parser.py:157,206,208,318` | Every date-parse failure defaults to `datetime.now()` | Template drift files transactions under today, silently. Corrupts every month-boundary report | [04](./04-import-and-gmail-sync.md#bugs--issues) |
| P1 | Platform | `frontend/src/api.js:14` | `await res.json()` runs before any status check | Every 429/500/413/502 and every unknown `/api/*` becomes `SyntaxError: Unexpected token '<'`. **Appears in 4 of 5 docs** | [05](./05-platform-data-and-deploy.md#bugs--issues) |
| P1 | Ingestion | `frontend/src/pages/Import.jsx:113-115` | `errors.map(e => <div>{e}</div>)` where entries are objects | React throws "Objects are not valid as a React child" — the page **white-screens exactly when a row fails** | [04](./04-import-and-gmail-sync.md#bugs--issues) |
| P1 | Platform | `db_context.py:225` | `_migrate()` runs on every `get_user_db()` | ~9 failed DDLs, a full-table `UPDATE`, ~5 SELECTs per authenticated request, on a Pi | [05](./05-platform-data-and-deploy.md#bugs--issues) |
| P1 | Platform | `db_context.py:88,93,100,106,112,118,124,130,136,142` | Ten bare `except Exception: pass` in the migration path | Disk-full, locked DB, and a genuinely broken migration are indistinguishable from "column exists" | [05](./05-platform-data-and-deploy.md#bugs--issues) |
| P1 | Platform | `main.jsx:9` + `App.jsx:110` | `AuthProvider` mounted twice, nested | Two `GET /api/auth/me` per load; the dead outer provider can clear the shared token on a 401 | [05](./05-platform-data-and-deploy.md#bugs--issues) |
| P1 | Ingestion | `email_parser.py:358`, `:371-377`; `sync_routes.py:72` | No IMAP `timeout=`, unbounded fetch, fully synchronous inside the request | Two concurrent syncs consume the entire 2-worker pool; a wedged scheduled run blocks every later user | [04](./04-import-and-gmail-sync.md#bugs--issues) |
| P1 | Ingestion | `db_context.py:27-43`, `:59-66` | No `source`/`provider`/`external_id` column; no `sync_runs` audit table | Cannot reconcile paths, filter by account, or debug a sync. **Hard blocker for Plaid** | [04](./04-import-and-gmail-sync.md#notes-for-future-integrations) |
| P1 | Transactions | `routes/transactions.py:49` | `min(limit, 200)` with no floor ⇒ `?limit=-1` is `LIMIT -1` = unlimited | 200-row cap trivially bypassed; full-table dump in one request | [02](./02-transactions-and-categories.md#bugs--issues) |
| P1 | Transactions | `routes/transactions.py:64-70` | `status` filter and `category_id` filter are an `if/elif`; the UI shows both | Selecting both silently applies one. The filter lies | [02](./02-transactions-and-categories.md#bugs--issues) |
| P1 | Transactions | `routes/transactions.py:77-82`, `:474`, `:509`, `:532` | LIKE wildcards in user input never escaped; 7 prod merchants contain `%`/`_` | Bulk-categorize can reassign a far wider set than intended, with no preview and no undo | [02](./02-transactions-and-categories.md#bugs--issues) |
| P1 | Dashboard | `useDashboardFilters.js:68-74` + no error boundary in `App.jsx` | `pinnedIds` parsed with no shape validation; `.join(",")` on a non-array | TypeError → **white screen for the whole app** | [03](./03-dashboard-and-analytics.md#bugs--issues) |
| P2 | Platform | repo-wide | Zero tests, empty `.github/workflows/`, no automated backups, no indexes | Nothing prevents any of the above from recurring; the only recovery from a bad migration is a backup a human remembered to take | [05](./05-platform-data-and-deploy.md#testing-situation) |

---

## Cross-cutting themes (each appears in 3+ docs)

1. **`res.json()` before the status check** (`api.js:14`, duplicated at `:101-122`).
   Named independently in `01`, `02`, `03`, `04`, and `05`. It is the single reason every
   backend failure — rate limit, 500, 413, 502, unknown route — reaches the user as
   `Unexpected token '<'`. There is also no `@app.errorhandler` on the Flask side, so
   there is nothing to parse even if the client checked. **One contract, two ends,
   ~15 lines total.**
2. **Errors swallowed by design.** 7 empty `catch {}` in `Transactions.jsx`, `catch {}`
   in `Dashboard.jsx:147`, three widgets returning `null` on failure, every exception in
   `_migrate` and `admin_routes.py:39-42` caught by a bare `except`, scheduled-sync
   failures written only to a log nobody reads. `eslint.config.js:23` sets
   `allowEmptyCatch: true` — the tooling is configured to permit the pattern.
3. **No migration versioning.** `db_context.py:83-170` is ten copy-pasted
   `try/ALTER/except: pass` blocks re-run on every request, with no `user_version`. All
   six live DBs report `PRAGMA user_version = 0`, and `data/user_1_finance.db` is still on
   the pre-reimbursement schema. `README.md:444-472` and `DEPLOYMENT.md:47-53` state
   directly contradictory things about how migrations work.
4. **No indexes.** `grep -rn "CREATE INDEX"` returns nothing. Named in `02`, `03`, `05`.
   The five that matter — `transactions(transaction_at)`, `(category_id)`,
   `(merchant_raw)`, `reimbursement_links(outflow_id)`, `(inflow_id)` — are the highest
   benefit-to-risk change in the repo.
5. **Three competing reimbursement models.** `reimburses_id` (legacy),
   `reimbursement_status/_mode/_value` (legacy), and `reimbursement_links` (current), plus
   `expected_reimbursement`/`reimbursement_external` as an optimistic overlay. The backfill
   (`db_context.py:173-214`) copies legacy into the new table but never clears it — on prod
   all 73 legacy rows are double-represented. Two delete paths disagree about which model
   to clean up, which is P0 #3.
6. **Four definitions of "spent" on one screen** (`03`, Metric Definitions table), plus a
   fifth notion in `transactions.py` and a sixth in `/owed`. The netting SQL fragments live
   in `services/budget_service.py` but are imported by `routes/transactions.py:8` — a route
   module importing SQL from a service.
7. **Duplicated logic everywhere.** The pinned-ids `OR id IN (...)` builder exists in five
   near-identical copies (`dashboard.py:22-31`, `:101-107`, `:160-168`, `:257-263`,
   `budget_service.py:48-58`); `fmtDate` is defined five times; `fmtCurrency` twice;
   `barColor` byte-identically twice; `api.js` duplicates its own fetch/401 logic;
   the scheduler is wired twice with divergent settings; `reimbursement_links` DDL is
   defined twice.
8. **No provenance on ingested rows**, so source is inferred from free-text `notes`, and
   three call sites disagree about what "venmo" means (`transactions.py:84` vs `:434` vs
   `categorize.py:40`).
9. **Design tokens defined then bypassed.** 13 well-chosen CSS tokens
   (`index.css:1-27`) and ~50 raw hex literals in JSX inline styles reproducing them
   exactly — which is why a light mode would be a seven-component rewrite rather than a
   CSS change. `index.css` even re-states its own tokens as literals at `:295-305`.
10. **Documentation drift.** `05` catalogues ~25 checkable README errors including a wrong
    bind address, four wrong API paths, a wrong localStorage key, and a schema block
    missing an entire table.
