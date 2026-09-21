# 06 — Remediation & Improvement Plan

Sequenced toward one goal the owner stated: **make this codebase safe to extend** before
adding integrations. Every phase is ordered so the next one is cheaper and less risky.

Reading order: [00-INDEX.md](./00-INDEX.md) for the consolidated issue table, then this.

Conventions: **correctness fix** = the app is objectively wrong today; **preference** =
a judgement call. Effort: **S** ≤ half a day, **M** 1–2 days, **L** ≥ 3 days.

### Corrections to prior findings

Three things the audits got wrong or overstated, verified against the live DBs:

- **`02` P1 "30 rows still store `YYYY-MM-DD`, dates render one day early."** True in
  `data/user_1_finance.db` (30 rows) but **`data/prod_db.db` has 0** — all 1,817 rows are
  19 chars. This bug is a stale-dev-copy artifact, **not live in production**. Demote from
  P1 to a data-hygiene guard in the new migration.
- **`02`'s reimbursement-link counts for `user_1_finance.db`.** That file has **no
  `reimbursement_links` table at all** (verified: `sqlite_master` lists only categories,
  transactions, profile, budgets). Doc `03`'s schema-drift note is the correct one. All
  reimbursement-link claims should be read against `prod_db.db`: **119 links, 73 legacy
  `reimburses_id` rows, and all 73 are also represented as links** — the double-booking is
  real and worse than doc `02` estimated (73, not 63).
- **`02` duplicate-group count.** 91 in `user_1_finance.db`; **125 in `prod_db.db`**. The
  P0 severity stands and is larger than reported.

Everything else spot-checked held: bcrypt 5.0.0 does raise `ValueError` on >72 bytes
(reproduced in the project venv); `api.js:14` parses before the status check;
`AuthProvider` is mounted at both `main.jsx:9` and `App.jsx:110`; `_migrate` is called
from `get_user_db` at `db_context.py:225`; `transactions.py:381` deletes the parent with
no `reimburses_id` cleanup while `:315` does it; `email_parser.py:379` uses `RFC822`;
`import_service.py:14` hashes `row_num`; `import_service.py:114-115` is unguarded;
`.github/workflows/` is empty; every DB reports `PRAGMA user_version = 0`.

---

## Phase 0 — Stop the bleeding

Users are losing data or being shown wrong numbers **today**. Nothing here needs a schema
change; all of it should ship before any refactor.

> **Before the first Phase 0 deploy touching the Pi**, take a manual snapshot — this is
> the only recovery path that exists:
> ```
> ssh pi 'cd ~/PersonalFinanceApp && mkdir -p data/backups && \
>   for f in data/*.db; do sqlite3 "$f" ".backup data/backups/$(date +%F)-$(basename $f)"; done'
> rsync -av pi:~/PersonalFinanceApp/data/backups/ ./pi-backups/
> ```
> Automating this is Phase 1, item 6. Do it by hand until then.

### 0.1 Stop losing bank emails — `BODY.PEEK[]` (correctness) — S

- **What.** `services/email_parser.py:379`: `mail.fetch(num, "(RFC822)")` →
  `mail.fetch(num, "(BODY.PEEK[])")`. Keep the explicit
  `mail.store(num, "+FLAGS", "\\Seen")` at `:396`, which then becomes load-bearing
  instead of redundant: mark read **only** after a successful parse.
- **Why now.** The search filter is `UNSEEN` (`:372`). Today, any email a drifted template
  cannot parse is marked read and never fetched again — that is unrecoverable and
  permanent. It's not entirely undetected in the moment (each failure lands in that run's
  `errors` list with `message_id`/`reason`/`subject`), but nothing durable keeps that
  detail: the nightly scheduled sync logs only a *count* of parse errors
  (`sync_service.py:96-108`), and manual sync's error list is returned to the frontend but
  dropped by `Profile.jsx`. In practice there is no way to find or retry the specific
  message afterward.
- **Risk.** Low, but it changes steady-state behaviour: previously-swallowed unparseable
  emails now stay unread and re-appear on every sync, growing the `errors` list.
  Pair with 0.2 so they're at least visible, and with the per-run cap in 3.4.
- **Verify.** Send yourself a Cap One alert; confirm it stays unread after a sync that
  fails to parse it, and flips to read after one that succeeds. On the Pi, re-run a sync
  and confirm `imported` is unchanged (no re-import) — Message-ID dedup should hold.

### 0.2 Make every error readable, front to back (correctness) — S

Two halves of one contract, and the highest-leverage change in the repo because every
future endpoint inherits it.

- **Backend.** Add to `app.py` (there is currently no `@app.errorhandler` at all):
  a handler for `HTTPException` returning `{"data": None, "error": <description>}` with
  the real status, and a catch-all `Exception` handler that logs the traceback and returns
  a generic 500 in the same envelope. This alone fixes the 413 (`app.py:38`), the 429 from
  Flask-Limiter, and every uncaught 500. While there, make unknown `/api/*` paths return a
  JSON 404 instead of falling through the SPA catch-all (`app.py:102-108`).
- **Frontend.** `frontend/src/api.js:14` — move `res.json()` **after** the status check and
  guard it on `content-type`:
  ```js
  const ct = res.headers.get("content-type") || "";
  const json = ct.includes("application/json") ? await res.json().catch(() => ({})) : {};
  ```
  Collapse `importTransactions` (`api.js:101-122`) onto the same helper — it currently
  duplicates the logic and drops the `hadToken` guard at `:113-117`.
- **Why now.** Named independently in all five audits. Until this lands, every fix below
  is un-debuggable in production: the 500s from 0.3 and 0.4 currently surface as
  `Unexpected token '<'`.
- **Verify.** Hit `/api/auth/login` 25× in a minute and confirm the UI says "too many
  attempts", not a parse error. Upload an 11 MB file and confirm a readable message.
  `curl -s /api/does-not-exist` returns JSON 404.

### 0.3 Stop the unauthenticated 500 on long passwords (correctness) — S

- **What.** Add a `len(password.encode()) > 72` rejection (400) alongside the existing
  `< 8` check at `routes/auth_routes.py:39-40` and `:112-113`, and add the same to the two
  unvalidated admin paths (`admin_routes.py:61-67` create, `:104-116` reset). Then wrap the
  four remaining bare `bcrypt` calls — `auth_routes.py:48`, `:76`, `:116`, `:119`,
  `admin_routes.py:67`, `:114` — so none sits outside a `try`.
- **Why now.** `bcrypt==5.0.0` raises `ValueError: password cannot be longer than 72 bytes`
  — reproduced in the project venv. `POST /api/auth/login` is unauthenticated and
  rate-limited only per-IP, so anyone can 500 the server at will. Do **not** silently
  truncate to 72 bytes; that would let two different passwords authenticate.
- **Also here** (same file, same review): admin reset has no length floor and no existence
  check — `POST /api/admin/users/9999/reset-password` returns `{"success": true}`
  (`models/user.py:101-106` is a bare `UPDATE`); `update_user` (`models/user.py:83-98`)
  does `dict(None)` → 500 for a nonexistent id.
- **Verify.** `curl -d '{"username":"x","password":"'$(python -c 'print("a"*100)')'"}'`
  against `/api/auth/login` returns 400 JSON, not 500 HTML.

### 0.4 Make split and delete safe around reimbursements (correctness) — M

Three related data-loss paths in `routes/transactions.py`:

- **Split 500** (`:381`). `split_transaction` deletes the parent without the
  `UPDATE transactions SET reimburses_id = NULL WHERE reimburses_id = ?` that
  `delete_transaction` does at `:315`. With `PRAGMA foreign_keys=ON` (`db_context.py:224`)
  this is an `IntegrityError` → 500. **73 prod rows** point at another transaction via
  `reimburses_id`. Fix: hoist the cleanup into a shared `_detach_references(db, txn_id)`
  used by both paths. This is the immediate patch; Phase 2 retires the column entirely.
- **Silent link cascade** (`:306-318`). Deleting an outflow drops every
  `reimbursement_links` row pointing at it via `ON DELETE CASCADE`, with no warning — while
  `update_transaction:222-231` correctly *refuses* a direction flip for exactly this
  reason. Fix: count links first; if any exist, return a 409 naming the count unless the
  request carries an explicit `?force=true`, and have the UI's confirm dialog say
  "this will also remove N linked reimbursements".
- **Duplicate sweep** (`DuplicatesModal.jsx:41-46`). "Keep first, delete rest" on a
  heuristic with heavy false positives — prod has **125** exact-4-tuple groups, and the
  largest are legitimate repeat purchases. Fix, in order of value: (a) remove the
  bulk-sweep button outright; (b) exclude groups where the rows have **distinct
  non-null `source_hash`** values from the duplicates query
  (`transactions.py:572-588`) — two independently-ingested rows are not duplicates;
  (c) surface `source_hash` and `created_at` per row in the modal so a human can tell.
  Do (a) and (b) now; (c) with Phase 3's provenance columns.
- **Verify.** On a **copy** of `prod_db.db`, split a transaction that another row's
  `reimburses_id` references and confirm 201. Confirm the duplicates endpoint's group
  count drops from 125 to only genuinely-suspicious groups.

### 0.5 Fix the dashboard's wrong numbers (correctness) — M

Four bugs, all showing incorrect money on the home screen:

- **Donut vs tile** (`services/budget_service.py:100-104`). Yearly-period categories join
  the whole calendar year while the tile is range-scoped: prod Aug 2026 shows **$5,911** in
  a donut labelled "Total Spent" over a **$1,416** tile. Fix: scope `by_category` to the
  requested window for *all* periods, and return the yearly figure as a separate field
  (`spent_ytd`) that `BudgetByCategoryWidget` uses only for the budget-progress bar.
- **Two definitions of "spent"** (`budget_service.py:62` vs `:92-96`): the total doesn't
  subtract inflows, the per-category figure does. Pick one — **recommend: spend does not
  net inflows anywhere** (a refund is a reimbursement link or an inflow, not a negative
  expense) — apply it in both, and add `"spend_basis"` to the response so the client can
  label it. Do **not** ship 0.5 without a test from 1.1 asserting
  `total_spent == sum(by_category[].spent) + uncategorised` for the same window.
- **Comparison period** (`routes/dashboard.py:246-248`). Month-to-date is compared against
  a full previous month. Fix: when `end < today`, use the full prior period; when the
  current range is partial, truncate the previous window to the same number of elapsed
  days. Echo `previous: {start_date, end_date}` in the response so
  `ComparisonCard.jsx:16-23` stops guessing (its guess is wrong for 4 of 6 ranges).
- **Pins** (`dashboard.py:104-146`, `:253-254`). `/trend` counts pinned rows in SQL but the
  densification loop never emits their buckets; `/comparison` gives pins to `current` only,
  double-counting any pin dated inside the previous window. Fix: for `/trend`, extend the
  loop bounds to cover pinned dates (or drop pins from `/trend` and say so); for
  `/comparison`, exclude pinned ids from the `previous` window explicitly.
- **Verify.** Against a copy of `prod_db.db` for 2026-08-01..31: tile, donut sum, and trend
  sum must agree. Turn on a pin dated in July and confirm the August comparison doesn't
  move.

### 0.6 Cheap correctness batch (correctness) — S

Ship together; each is one to three lines.

- `routes/transactions.py:49` — floor the limit: `max(1, min(arg, 200))`. `?limit=-1` is
  currently `LIMIT -1` = unlimited.
- `routes/transactions.py:64-70` — the `status`/`category_id` `if/elif` silently discards
  one filter while the UI shows both. Make them independent `AND` clauses.
- `routes/transactions.py:77-82`, `:474`, `:509`, `:532` — escape `%` and `_` in LIKE
  patterns and add `ESCAPE '\'`. 7 prod merchants contain those characters, and
  bulk-categorize matches on an unescaped prefix with no preview and no undo.
- `routes/transactions.py:137-150` — reject `amount < 0` on create, as update already does
  at `:243-244`.
- `routes/transactions.py:509` — `bulk_categorize` omits `direction='outflow'` that the
  list feeding it (`:434`) has, so it categorizes inflows the user never saw.
- `frontend/src/pages/Import.jsx:113-115` — `errors` entries are objects
  (`import_route.py:45`); rendering them raises "Objects are not valid as a React child"
  and white-screens the page exactly when a row fails. Render `e.reason` / `e.row`.
- `services/import_service.py:114-115` — guard the two `next(stream)` calls; a <2-line file
  or a mis-picked source type is currently a 500 (matches three unexplained import 500s in
  `logs/app.log.2`).
- `frontend/src/main.jsx:9-11` — delete the outer `AuthProvider`; keep `App.jsx:110`.
  Halves auth traffic and closes a real logout race.
- `frontend/src/hooks/useDashboardFilters.js:68-74` — validate `Array.isArray` on
  `pinnedIds`; a non-array in localStorage white-screens the whole app
  (`Dashboard.jsx:112`). Wrap the five unguarded `setItem` calls.
- `frontend/src/App.jsx` — add an error boundary around the router. There is none, and
  three separate TypeErrors above white-screen the app.
- `frontend/src/pages/Transactions.jsx:386` — the Add-Transaction date defaults to the
  **UTC** date, so after 19:00 ET it pre-fills tomorrow.
- `frontend/src/components/SpendingTrendChart.jsx:88` — `Math.round(600/1000) > 0` renders
  **$600 as "$1k"**. Everything ≥ $500 is wrong.

---

## Phase 1 — Foundations for safe change

Nothing in Phase 2+ should be attempted before this lands. These are the mechanisms that
let a change be made without hoping.

### 1.1 The first test suite — S for setup, M for the four suites

There are **zero** tests. Add `pytest` + `requirements-dev.txt` (which also fixes `ruff`
being absent from `requirements.txt`, so `make lint` currently fails on a clean install),
and `vitest` for the frontend later. Write these four, in this order:

1. **Aggregation math.** A fixture user DB with hand-computed reimbursements, then assert
   for one window that `total_spent`, `sum(by_category[].spent)`, `sum(trend[].spent)`, and
   `comparison.current.spent` are **equal**. Today, on real data, they are not — this test
   is what makes 0.5 verifiable and what stops the four definitions of "spent" from
   drifting apart again. **Highest value; write it first.**
2. **Parser fixtures.** Golden files for all three CSV parsers and all five email branches
   (`services/email_parser.py`) — real emails with account details scrubbed, checked into
   `tests/fixtures/`. Bank templates change without notice and nothing today fails loudly
   when they do; `05` notes there is no fixture, no golden file, nothing. This is the test
   suite that makes adding a sixth parser cheap, so it must exist before Phase 3.
3. **Dedup.** Same file imported twice ⇒ 0 new rows. Same file re-exported with a shifted
   window ⇒ still 0 new rows (this **fails today**, and is the specification for 3.2).
   Same email synced twice ⇒ 0 new rows.
4. **Auth.** Register/login/change-password happy paths; the >72-byte 400; token expiry;
   `require_admin` rejecting a non-admin; and one asserting that
   `auth/jwt_utils.py:23`'s `sub` string→int coercion holds — it is load-bearing for both
   admin self-guards (`admin_routes.py:91`, `:123`) and untested.

Also add a migration test: build a DB at the **old** schema, run the migration, assert the
reimbursement backfill math (`db_context.py:200-212`) — one-shot, destructive, and
currently uncovered.

### 1.2 A real migration system with `user_version` — M · **touches live data**

The single most important structural fix. Today `_migrate()` (`db_context.py:83-170`) is
ten copy-pasted `try/ALTER/except: pass` blocks run on **every request**
(`db_context.py:225`), plus an unconditional full-table `UPDATE` at `:140` and two more
scans. All six live DBs report `PRAGMA user_version = 0`.

- **Shape.** A `MIGRATIONS: list[tuple[int, str | Callable]]` in a new `migrations.py`.
  Runner reads `PRAGMA user_version`, applies each migration above it inside an explicit
  transaction, and stamps the new version. Failures **raise** — no `except: pass`.
- **Call site.** Run it once per process (or on first `get_user_db` per user per process),
  **not** per request; and delete the `init_user_db(row["id"])` call on every login
  (`routes/auth_routes.py:79`), which re-executes the whole schema plus the backfill.
- **Migration 1** = "current state": squash the ten ALTERs, the `LENGTH=10` date fix
  (idempotent, now a one-shot), the `reimbursement_links` creation (also drop the duplicate
  DDL at `db_context.py:145-153` — it's the second source of truth for `:51-57`), and the
  reimbursement backfill. Stamp existing DBs at version 1 by asserting the expected columns
  exist rather than re-running.
- **Live-data path.** (1) Snapshot all `data/*.db` on the Pi per the Phase 0 preamble.
  (2) Copy them to the dev machine and run the migration against the copies first; diff
  row counts and the four aggregate totals before/after. (3) Deploy with the service
  stopped. (4) Confirm `PRAGMA user_version` on each Pi DB afterwards. **Note the dev
  `data/user_1_finance.db` is on the pre-reimbursement schema and `data/prod_db.db` is
  current — test against both**, they exercise different migration paths.

### 1.3 Indexes — S · included in migration 2 · **touches live data**

Five statements, the highest benefit-to-risk ratio in the repo:

```sql
CREATE INDEX IF NOT EXISTS idx_txn_at        ON transactions(transaction_at);
CREATE INDEX IF NOT EXISTS idx_txn_dir_at    ON transactions(direction, transaction_at);
CREATE INDEX IF NOT EXISTS idx_txn_cat       ON transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_txn_merchant  ON transactions(merchant_raw);
CREATE INDEX IF NOT EXISTS idx_rl_outflow    ON reimbursement_links(outflow_id);
CREATE INDEX IF NOT EXISTS idx_rl_inflow     ON reimbursement_links(inflow_id);
```

`_TXN_SELECT` (`transactions.py:18-30`) runs five correlated subqueries per row against an
unindexed `reimbursement_links` — that's 5 full scans × 25 rows per page. Verify with
`EXPLAIN QUERY PLAN` on a copy of `prod_db.db` before/after; expect `SCAN transactions`
to become `SEARCH`.

### 1.4 One error-handling contract — S

Phase 0.2 fixes the mechanism; this fixes the discipline.

- Unify the response envelope. `routes/helpers.py:4-9` defines `_ok`/`_err` as
  `{"data":…, "error":…}` and 8 modules import it, but `routes/auth_routes.py` hand-rolls
  a different shape at `:57-62`, `:88-98`, `:121`, `:130-138`. Also rename off the leading
  underscore — it's a public cross-module API.
- Flip `allowEmptyCatch` to `false` in `frontend/eslint.config.js:23` and fix the fallout:
  7 empty catches in `Transactions.jsx`, `Dashboard.jsx:147`, `MerchantInsights.jsx:68`,
  `ComparisonCard.jsx:73`, `OwedWidget.jsx:16`. The lint config currently *permits* the
  exact pattern that hides load failures.
- Stop returning raw exception strings to clients (`admin_routes.py:72`, `:99` leak
  `UNIQUE constraint failed: users.email`), and stop coercing every exception to 409.
- Add `.rollback()` boundaries. There is currently **not one** in the codebase; multi-
  statement writes (`transactions.py` split, `categories.py:89` reorder,
  `profile.py:60-76` budgets — which can partially write before a 400) rely on
  `teardown_appcontext` closing the connection, which is accidentally correct.

### 1.5 CI in the empty `.github/workflows/` — S

The directory exists and has been empty since 2026-06-11 across 19+ merged PRs. One
workflow: `ruff check .`, `npx eslint src/`, `npm ci && npm run build`, `pytest`. Add
`requirements-dev.txt` in the same commit so it and `make lint` can actually run
(`ruff` is not in `requirements.txt` today; `Makefile:2` and `README.md:537` both assume
it is). Switch the documented deploy step from `npm install` to `npm ci` — the lockfile is
committed, so builds are reproducible if you use it.

### 1.6 Automated backups — S · **touches the Pi**

The only thing standing between a bad migration and permanent loss. A
`deploy/finance-backup.service` + `.timer` running the `sqlite3 .backup` loop from
`DEPLOYMENT.md:61-69` nightly with a retention prune. `data/backups/` is already
gitignored and the restore procedure (`DEPLOYMENT.md:208-216`) is already written and
looks correct — **only the trigger is missing**. Then actually test a restore once.
Add `logrotate` for `logs/access.log` in the same PR (gunicorn never rotates, unbounded
growth on an SD card) and switch Flask's `RotatingFileHandler` (`app.py:54-58`) to
`WatchedFileHandler`, which resolves the `preload_app=True` multi-process rotation hazard.

### 1.7 Token revocation — M · **schema change on `master.db`**

Closes three P0s at once. Add `token_version INTEGER NOT NULL DEFAULT 0` to `users`
(note `master.db` has **no** migration mechanism at all — `models/user.py:31-34` only runs
`executescript`; this is the moment to give it one). Include it in the JWT payload
(`jwt_utils.py:12-17`); compare against the DB in `auth/middleware.py:20` — one indexed
lookup per request, free at this scale — and read live `is_admin` from the same row so
`require_admin` (`middleware.py:35`) stops trusting a 7-day-old claim. Bump on password
change (`auth_routes.py:120`), demotion (`admin_routes.py:95`), and delete. Also make
delete durable: remove the `-wal`/`-shm` siblings (`admin_routes.py:129-131`), and stop
`get_user_db` from silently recreating a deleted DB (`db_context.py:220-221`).

---

## Phase 2 — Consolidation

Now that changes are testable and versioned, remove the duplication that makes every
future edit cost three edits.

### 2.1 Retire the legacy reimbursement columns — M · **touches live data**

Three models, one truth. In migration 3: backfill any remaining `reimburses_id` /
`reimbursement_status/_mode/_value` into `reimbursement_links`, **then clear the legacy
columns**, then drop them. Note the current backfill guard is `links_exist == 0`
(`db_context.py:179`), so on prod — where 119 links already exist — it has been skipped;
all 73 legacy rows are nonetheless already double-represented as links, so the backfill
step is likely a no-op and the job is mostly deletion. **Verify that claim per row on a
copy before dropping anything.** This retires the shared `_detach_references` helper from
0.4 and removes an entire class of "which delete path forgot?" bugs.

### 2.2 One definition of "spent", one window builder — M

`0.5` picks the definition; this centralises it. The `OR id IN (...)` pinned-ids builder
exists in **five** near-identical copies (`dashboard.py:22-31`, `:101-107`, `:160-168`,
`:257-263`, `budget_service.py:48-58`). Extract one `_window(start, end, ids)` returning
`(sql, params)` and use it everywhere. Move `_excluded_sql` / `_inflow_income_sql` out of
`services/budget_service.py` into a `services/money_sql.py` so `routes/transactions.py:8`
stops importing SQL from a service module. Consider collapsing the four dashboard
endpoints into `/api/dashboard?include=totals,trend,merchants,comparison` — it kills the
refetch storm, guarantees metric consistency, and gives one place to fix a window bug.

### 2.3 Decompose `Transactions.jsx` — M

1,351 lines; `export default function Transactions()` alone is `:569-1351` with 22
`useState` hooks. In order (each independently shippable):

1. Extract the four inline modals — `ImportModal` (`:72-184`), `ClassifyModal`
   (`:187-301`), `AddModal` (`:380-501`), `ReclassifyModal` (`:514-566`). ~400 lines out,
   zero behavioural risk: none touch page state.
2. Extract `<TransactionRow>` from the 337-line inline map callback at `:996-1333`.
3. Extract `useTransactionList()` — `buildParams`/`fetchPage`/filters (`:580-586`,
   `:619-671`). This is also where `AbortController` request sequencing belongs (today
   overlapping debounced searches can overwrite newer results with older ones).
4. Extract `useReimbursementEditor()` (`:596-598`, `:720-762`).
5. Delete the hand-rolled pin logic at `:605-615` and adopt
   `hooks/useDashboardFilters.js:6`, which already owns it.

Alongside: `fmtDate` is defined **five** times (`Transactions.jsx:36`,
`DuplicatesModal.jsx:8`, `ReimbursePickerModal.jsx:5`, `PinPickerModal.jsx:9`,
`OwedWidget.jsx:6`) — move one copy to `format.js` and fix the timezone parse there once.
`fmtCurrency` is redefined at `Dashboard.jsx:16-22`; `barColor` is byte-identical in
`CategoryBreakdown.jsx:8-12` and `BudgetByCategoryWidget.jsx:7-11`. Add a
`CategoriesContext` to end the six-hop prop drilling (and fix the render-phase `setState`
at `CategoryPicker.jsx:13`).

### 2.4 CSS tokens vs ~50 hardcoded hexes — M · *preference, with a correctness edge*

13 good tokens at `index.css:1-27`, then ~50 raw hex literals in JSX inline styles
reproducing them exactly (full inventory in `03`, Styling Notes). `index.css` even
re-states its own tokens as literals at `:295-296`, `:304-305`. Extract
`frontend/src/theme.js` exporting the palette (or read `getComputedStyle` off `:root`) and
replace the literals. Add spacing / radius / z-index tokens while there — there are none,
so radii of 8/12/16/20 and z-indexes of 100/300/9999 are ad hoc, and `.top-bar-loading`
and `InstallPrompt` both claim `9999`. **This is the prerequisite for light mode**: today
that would be a seven-component rewrite, not a CSS change.

### 2.5 Delete dead code — S

- `auth/auth_db.py` (whole file, zero importers) — but **harvest `_DUMMY_HASH` first**
  (`:12`, `:35-41`): it is exactly the fix for the login timing oracle at
  `auth_routes.py:73-77`, which returns 401 without doing any bcrypt work when the user
  doesn't exist. Port it, then delete the file.
- `routes/profile.py:49-58` — `scalar_fields = set()`, so the `UPDATE profile` branch is
  unreachable. Remove or complete it.
- `routes/transactions.py:47-54` — the `try/except (TypeError, ValueError)` is dead;
  `request.args.get(type=int)` returns the default rather than raising, so the documented
  400 is unreachable and bad input is silently coerced.
- `frontend/public/icons.svg` — 5 KB Vite-template sprite (Bluesky/Discord/GitHub/X),
  referenced by nothing, copied into `dist/` and **served in production**. Also
  `frontend/src/App.css` (0 bytes), `frontend/README.md` (stock template), and
  `frontend/public/favicon.svg` (still the Vite logo).
- ~50 lines of dead CSS: `.toast` (`:262-276`), `.input-error` (`:474-477`),
  `.text-amber` (`:579-581`), the whole `.progress-track`/`.progress-fill*` family
  (`:701-721`), `.cat-list`/`.cat-row*` (`:668-687`), `.stat-row` (`:636-641`).
- `gunicorn.conf.py:26-27` (`worker_exit: pass`), `ruff.toml:17` (`per-file-ignores` for a
  `scripts/` directory that does not exist), `routes/sync_routes.py:44-53`
  (`DELETE /api/profile/gmail` has no frontend caller — or wire it up, see 4.4).
- Prune the five merged local/remote branches; resolve the `DO NOT MERGE TO MAIN!!` header
  at `README.md:1`, which is being actively violated.

### 2.6 Fix the docs while the facts are fresh — S

`05` lists ~25 checkable README errors. The ones that matter: `README.md:396` claims
gunicorn binds `0.0.0.0:5100` and is LAN-reachable (it binds `127.0.0.1` —
security-relevant if believed); `README.md:444-472` and `DEPLOYMENT.md:47-53` state
opposite things about migrations (Phase 1.2 makes a third, correct answer possible); the
schema block omits `reimbursement_links` entirely and five `transactions` columns; four
API paths and the localStorage key name are wrong.

---

## Phase 3 — Integration readiness

**Do not add Plaid, a fourth bank, or a sixth email format before this phase.** Each new
source multiplies the cost of not having done it. This is the phase the owner's stated
goal actually depends on.

### 3.1 Provenance columns — M · **schema + backfill on live data**

Migration 4, on `transactions` (`db_context.py:27-43`):

```sql
ALTER TABLE transactions ADD COLUMN source      TEXT;    -- capitalone_csv | capitalone_email | venmo_csv | venmo_email | amex_csv | amex_email | zelle_email | plaid | manual | split
ALTER TABLE transactions ADD COLUMN provider    TEXT;    -- capitalone | venmo | amex | zelle | plaid | manual
ALTER TABLE transactions ADD COLUMN external_id TEXT;    -- the provider's own stable id
ALTER TABLE transactions ADD COLUMN account_id  TEXT;    -- which card/account, for multi-card
ALTER TABLE transactions ADD COLUMN ingested_at TEXT;
CREATE UNIQUE INDEX idx_txn_identity ON transactions(provider, external_id)
  WHERE external_id IS NOT NULL;
```

**Backfill for existing rows** (the tricky part — 1,817 prod rows have no provenance):
`notes LIKE 'venmo:%'` ⇒ `provider='venmo'`; `notes LIKE 'zelle:%'` ⇒ `'zelle'`;
`notes='Refund'` ⇒ `capitalone_email`; `source_hash IS NULL` ⇒ `'manual'`;
`source_hash LIKE '%:split%'` ⇒ `'split'`. Everything else is genuinely ambiguous —
set `provider='capitalone'`, `source='legacy'`, `external_id=NULL`. That is honest, and
the partial unique index means legacy rows don't collide. Keep `source_hash` as a
compatibility key; retire it only once every writer sets `external_id`.

This is what lets `notes LIKE 'venmo:%'` (`categorize.py:40`,
`transactions.py:83-86`, `:434`) stop being load-bearing string matching — three call
sites currently disagree about what "venmo" means, and "credit" is defined as "not venmo",
so Zelle and cash rows are reported as "Credit Card".

### 3.2 Identity-based dedup — M

`_source_hash` (`import_service.py:11-15`) must stop hashing `row_num` — that is the P0
that doubles history on a re-export. Sources already have identity: Venmo's `" ID"` is
read at `:120` and thrown away; Amex's `Reference` (`:89-90`) is the correct model. Cap One
CSV has no id — use a content hash of `(posted_date, transaction_date, amount,
description, card_last4)` plus an intra-file occurrence counter, so a shifted window is
stable. Then add a **cross-path** near-duplicate check at insert (same amount, ±2 days,
fuzzy merchant): the two ingestion paths use non-overlapping hash schemes today, so one
purchase seen as an email alert (`Amazon`) and again in a CSV (`AMAZON RETAIL` — both
observed in `prod_db.db`) makes two rows. Plaid makes this strictly worse: it reports both
pending and posted versions of one transaction. Test 1.1 #3 is the specification.

### 3.3 `sync_runs` audit table — S

```sql
CREATE TABLE sync_runs (id INTEGER PRIMARY KEY, source TEXT, trigger TEXT,
  started_at TEXT, finished_at TEXT, status TEXT,
  imported INT, duplicates INT, error_count INT, error_json TEXT);
CREATE TABLE sync_errors (id INTEGER PRIMARY KEY, run_id INT, external_id TEXT,
  reason TEXT, raw_excerpt TEXT);
```

Today the entire evidence base for "does sync work" is inferring from row `created_at`
timestamps, and scheduled failures are `logger.error` only (`sync_service.py:98-100`) —
if the app password is revoked, the nightly sync fails silently forever. Extend
`GET /api/sync/status` (`sync_routes.py:56-66`) with `last_error`, `last_error_at`,
`unparsed_count`. **Without this you cannot debug a new integration at all.**

### 3.4 Move sync off the request path — M

`sync_routes.py:72` calls `sync_user` synchronously; with `workers = 2` two concurrent
syncs consume the whole app, and `usePwaSync.js:27` fires one on every app open. Return
`202` + a job id, run the work in the scheduler's executor, poll. In the same change: add
`timeout=30` to `IMAP4_SSL` (`email_parser.py:358` has none, so an unresponsive Gmail hangs
forever and the *scheduled* path has no worker-timeout backstop); cap messages per run
(`:371-377` is unbounded — a first sync on the recommended dedicated forwarding account
walks every unread message in one HTTP request); check the `mail.search` status instead of
indexing `msg_nums[0]` blindly (`:372`); add exponential backoff on auth failure. Move the
scheduler out of the gunicorn arbiter into `finance-sync.service` + `.timer`, which also
kills the duplicate `RUN_SCHEDULER` wiring (`app.py:111-115` vs `gunicorn.conf.py:18-23`,
with divergent `daemon` and `misfire_grace_time` settings) and the `SIGHUP` double-start
risk. Pin an explicit `timezone=` — there is none, so DST shifts the job.

### 3.5 Parser plugin interface — M

`import_route.py:13-17` and `email_parser.py:363-369` are hand-maintained literal lists and
each parser re-implements amount/date/merchant handling. Extract:

- `parse_amount()` handling `$`, thousands separators, and parenthesised negatives — the
  current `_parse_amount` (`import_service.py:18`) strips `-` unconditionally and so cannot
  be reused for signed columns, while Cap One and Amex use raw `float()`.
- `parse_date()` taking a **list** of formats that **raises** — never
  `datetime.now()` (`email_parser.py:157`, `:206`, `:208`, `:318`).
- A per-source `ColumnSpec` (required headers, aliases, date formats, sign convention,
  skip patterns) so adding Chase or Discover is data, not code.
- Header-shape **auto-detection**, which removes the `source_type` picker and the 0.6
  `next(stream)` crash class entirely.

Every spec gets a fixture test from 1.1 #2. Also hoist `resolve_category_id`'s `GROUP BY`
scan out of the per-row loop (`categorize.py:34`, called from `import_service.py:53,97,161`
and six sites in `email_parser.py`): benchmarked at 1.51 ms/call at 1,817 rows ⇒ ~2.3 s per
1,500-row import today, ~25 s at 20k rows against a 120 s worker timeout. Load the map once
per import — ~10 lines, removes the quadratic behaviour before a Plaid backfill hits it.

### 3.6 Generalise credential storage — S

Before any OAuth-based source. Add a key-id prefix to the ciphertext
(`encryption_service.py:13`) and support decrypting with a retired key — rotating
`ENCRYPTION_KEY` today silently bricks every stored password with no prompt to re-enter.
Cache the `Fernet` instance (`:6-8` rebuilds it on every call). Replace the single-purpose
`profile.gmail_app_password_enc` column with a `credentials(user_id, provider, ciphertext,
key_id)` table — Plaid access tokens and Gmail OAuth refresh tokens are the same problem.

---

## Phase 4 — UX and feature improvements

Prioritised within each surface. Most are small once Phases 0–2 land.

### 4.1 Auth & session

1. **Session-expiry messaging** (correctness-adjacent). `api.js:19` does
   `window.location.href = "/login"` — a hard navigation with no message, destroying any
   in-progress form. Use the router, call `AuthContext.logout()`, and land on
   `/login?expired=1` with a banner and a return-to path.
2. **Fix the expired-token request loop.** `api.js:19-20` returns `undefined` after
   starting navigation → `setUser(undefined)` → the `[token, user]` effect re-fires →
   `api.me()` again, in a burst until navigation lands (`AuthContext.jsx:12-21`).
3. **Gate `/admin` on `user?.is_admin`**, not just `ProtectedRoute` (`App.jsx:88`). The API
   is correctly `@require_admin`-gated so nothing leaks — but the page renders for any
   authenticated user and then shows a bare `Forbidden` box.
4. **Forgot password.** Nothing exists; the only recovery is an admin reset. See open
   questions — this is gated on the email-normalisation work (lowercase on write, dedupe,
   `COLLATE NOCASE` unique index, real format validation), because as it stands a
   reset-by-email could match two accounts (`models/user.py:12-13` is byte-exact).
5. **Add a `loading` state to `AuthContext`** (`:8-21`) — the Admin tab and the Profile
   account card flicker on every refresh.
6. Confirm-password field on register (`Register.jsx:74-88`); a typo currently creates an
   account nobody can log into. The pattern already exists at `Profile.jsx:513-518`.
7. Expose whether registration is open so `/register` doesn't render a full form the API
   will 403 (`auth_routes.py:29`, `deploy/env.production:16`). Redirect logged-in users
   away from `/login` (`App.jsx:80-81`).

### 4.2 Transactions

1. **Bulk selection** — multi-select delete / categorize / pin. Categorize-one-at-a-time is
   the most repeated action in the app and there is no multi-select at all.
2. **Preview before bulk operations.** Neither bulk-categorize nor reclassify shows which
   rows will be affected, despite matching on a LIKE prefix (0.6 escapes it; a preview is
   what makes it trustworthy). Also surface the `updated: N` count that
   `transactions.py:513`/`:536` already return and `ClassifyModal.assign:224` discards.
3. **Undo.** Nothing is undoable — delete, split, sweep, bulk-categorize, reclassify. With
   3.1's provenance and an `import_batch_id`, "undo this import" becomes possible; that is
   the highest-value single undo (a mis-picked source type produces ~1,200 junk rows with
   no bulk remedy).
4. **Fix "Net cost" sign and label** (`Transactions.jsx:1089`, `:1164`, `:1174`). A $100
   charge fully reimbursed reads **"Net +$0.00"**; with $30 back it reads "Net −$70.00" in
   red. The green/red mapping is inverted relative to the label. Most-glanced-at
   reimbursement number in the app.
5. **Delete confirmation with context** — mention linked reimbursements (0.4), split parts,
   and that a re-sync may resurrect the row.
6. Fix the dead `OwedWidget` deep link: it navigates to `/transactions?q=<merchant>` but
   the page reads only `category_id`/`date_from`/`date_to` from `useSearchParams`
   (`Transactions.jsx:580-584`).
7. Replace the 8 `alert()`/`confirm()` calls with the existing `msg msg-error` component.
8. Pagination is Prev/Next only on 1,500+ row lists (`:1337-1341`).

### 4.3 Dashboard

1. **`useMemo` on `allParams`** (`Dashboard.jsx:111-113`) — one line, removes ~2/3 of
   dashboard traffic. Currently a fresh object literal every render, used as the sole
   `useEffect` dep in three children, producing ~9–12 requests on mount and re-firing all
   three network calls when you click a donut slice.
2. **Fix the trend chart labels** — `fmtLabel` always renders `{month, day}` even for
   monthly buckets (`SpendingTrendChart.jsx:10-17`), and there is no granularity indicator
   despite the backend supporting `?granularity=` that nothing sends. Return the chosen
   granularity in the response.
3. **Show the selected range in the header.** The subtitle always prints today's month
   regardless of range (`Dashboard.jsx:190-192`).
4. **Surface widget errors.** Three widgets `return null` on failure and the page's
   `load()` has a bare `catch {}` — a backend outage renders as widgets quietly not
   appearing, with no retry.
5. **`repeat_merchants` is structurally impossible on the default view**
   (`dashboard.py:215-224` requires >1 distinct month *within* the range, and the default
   range is one month). Either widen its window to 6 months or delete the section.
6. Chart accessibility: no `role="img"`, no `aria-label`, no legend on the trend chart —
   colour is the only encoding distinguishing spend from income.
7. Remove the `AVG(t.amount)` gross field (`dashboard.py:175`) and the `top_category`
   computation (`:43-51`) — both cost table scans per request and neither is ever rendered.
8. Fix the merchant drill-down (`:187-194`): it drops `include_ids` and returns gross
   amounts, so the sheet's sum doesn't equal the row that opened it (prod: $197 net row,
   $450 in the sheet). Also an N+1 — one query per merchant.
9. Rounding: `maximumFractionDigits: 0` on dashboard currency means a visibly-summing list
   never adds up, and `MerchantInsights` uses 2 digits while `ComparisonCard` uses 0.

### 4.4 Import & sync

1. **`POST /api/import/preview`** — parsed rows, detected source, proposed categories,
   would-be duplicates, no writes. Cheapest fix for the worst UX gaps (wrong source type,
   header drift, silent mass-duplication), and essential once there are six sources.
2. **Surface sync failures.** After 3.3, show `last_error` and staleness in
   `Profile.jsx:406-409` — today a sync broken for three weeks looks identical to one that
   ran last night. Show the parse errors `sync_service.py:67` already returns and the UI
   discards.
3. **Server-side file-type validation** (`import_route.py:27-37`). An `.xlsx` decodes as
   latin-1 (which never raises) and feeds `csv.DictReader` binary noise. Also fix the dead
   encoding fallback at `:38-46` — `latin-1` never raises, so the `for/else` is unreachable.
4. **Wire up Gmail disconnect** — `DELETE /api/profile/gmail` (`sync_routes.py:44`) exists
   with no caller, so users cannot disconnect. Add a "test connection" button.
5. **Fix `GmailSetup.jsx`** — `:74-78` omits Amex and Zelle, both implemented and working
   in production (20 Zelle rows in `prod_db.db`); `:93-98` describes the dedup mechanism
   incorrectly in both directions.
6. Rate-limit `/api/sync` and `/api/import/transactions` (`limiter.py` currently covers
   only the three auth routes), and add an in-flight guard to `usePwaSync.js:23-27` plus an
   `isOnline` check (`:6-31` has neither).

### 4.5 Platform / PWA — *preference*

1. **Cache headers before anything else** (`app.py`): `/assets/*` with
   `Cache-Control: public, max-age=31536000, immutable` (safe — Vite content-hashes them),
   `index.html` with `no-store`. ~6 lines, and a bigger win than code splitting: the
   698 KB bundle is currently re-validated on every page load through the tunnel.
2. **Then** `React.lazy` the two Recharts components — Recharts is the bulk of that bundle
   and is used only by `CategoryDonut.jsx` and `SpendingTrendChart.jsx`.
3. **Decide the PWA question** (see open questions). If yes: `manifest.webmanifest` with
   `display: standalone`, real icons, `apple-mobile-web-app-capable`, and `vite-plugin-pwa`
   — and do (1) first, since a service worker plus no cache headers interacts badly.
   If no: delete `InstallPrompt.jsx`, which instructs users to install an app that cannot
   launch standalone (`isStandalone()` at `:13-18` can never return true), and delete the
   "📴 Offline — showing cached data" banner (`Dashboard.jsx:184`), which claims a
   capability that does not exist.
4. **Tighten the CSP** (`app.py:83`): drop `'unsafe-eval'` and `'unsafe-inline'` from
   `script-src` — the built `dist/index.html` has no inline script and needs neither. Add
   `frame-ancestors 'none'`, `base-uri 'self'`, `object-src 'none'`, `form-action 'self'`.
   This matters specifically because the JWT lives in `localStorage`.
5. **Mobile breakpoints.** Four media queries in 1,290 lines. `.summary-grid` is
   `repeat(3, 1fr)` collapsing only below **360px**, so on a 375px iPhone SE three currency
   figures at 22px share ~106px each. Add a real tier at ~480px. Above 960px the app is a
   fixed-width phone column — a desktop grid is a separate, optional project.
6. **Accessibility.** No modal has `role="dialog"`, `aria-modal`, a focus trap, or
   Escape-to-close; transaction rows are bare clickable `<div>`s with no `tabIndex`; labels
   have no `htmlFor`. Do this alongside 2.3's decomposition, when each modal becomes its
   own file.
7. **Export.** There is none — no CSV/JSON download of your own transactions. For a
   self-hosted finance app that is a notable gap, and it's ~20 lines once the
   transaction-query builder from 2.2 exists.

---

## Deliberately not doing / open questions for the owner

These are genuinely your call, not the plan's:

1. **Public registration.** `REGISTRATION_ENABLED` defaults to **open** when unset, and
   prod sets it `false` (`deploy/env.production:16`), so the Register page is reachable
   and fully rendered but cannot succeed (4.1 #7). If you keep it, the following
   move from cosmetic to blocking: password policy beyond `len >= 8`, email verification,
   account enumeration via distinct 409s (`auth_routes.py:43` vs `:46`), the login timing
   oracle, per-account throttling, and a shared rate-limit backend (`memory://` with 2
   workers is not adequate). **Recommendation: remove public registration**, add a
   `create_user` CLI, and delete the Register page. It deletes an entire threat surface.
2. **The two test accounts and the orphaned user-2 files.** A local snapshot of
   `master.db` (this checkout's, not the Pi's — `data/` is never rsynced) shows
   `debugtest` (id 3) and `smoketest2` (id 4) with working credentials as of 2026-07-22,
   and `data/user_2_finance.db` surviving on disk for a user absent from that snapshot's
   `users` table. **Check the live Pi directly** — this checkout's `data/` cannot confirm
   either is still true today. If they are: delete the test accounts, or keep one as a
   deliberate smoke-test account with documented rotation; note that 1.7's revocation
   work and the `-wal`/`-shm` cleanup should land first so a delete is actually durable.
3. **`data/prod_db.db` in the working tree.** 544 KB of real financial data on a laptop,
   created by no code path, gitignored but unencrypted. It has been genuinely useful — most
   of the P0 evidence in these audits came from it. Keep it as a deliberate, documented,
   encrypted fixture? Replace it with a scrubbed fixture generated by a script? Or delete
   it? **Recommendation: replace with a scrubbed generated fixture** once 1.1's tests
   exist, and `chmod 600` the local `.env` (currently 644) either way.
4. **Recurring income.** Not implemented: paychecks and other fixed recurring inflows can
   only arrive via import, Gmail sync, or manual entry, so a month with no synced paycheck
   silently reads as zero income on every dashboard tile. A `recurring_income` table plus
   scheduled materialisation of due rows would close it. If you adopt it, generate the
   rows in the Phase 3.4 job runner — **not** lazily on user-DB open, which would repeat
   the `_migrate()` anti-pattern of putting writes on every request path (5.1).
5. **Light mode.** Dark is the only mode by design (`color-scheme: dark`,
   `index.css:27`). 2.4 makes it *possible*; whether it is *wanted* is yours. If never,
   say so in the CSS and the token work gets simpler.
6. **PWA: commit or delete.** Half-built is the worst of the three options (4.5 #3).
7. **Money type.** `amount REAL` with a 0.01 split tolerance and five different epsilons
   (`1e-6`, `0.005` ×2, `0.01` ×2) is not a foundation. Migrating to integer cents is
   correct and is a **large, whole-codebase, live-data change**. It is deliberately *not*
   in Phases 0–3 — but it gets harder with every integration added. Decide now whether to
   schedule it as its own project between Phase 2 and Phase 3.
8. **Desktop layout.** `#root` is capped at 960px and the app is a phone column at any
   width. Is desktop a target at all?

---

## Suggested PR sequence

Small, independently shippable, in dependency order. Each says what it unblocks.

| # | Branch | Contains | Unblocks |
|---|---|---|---|
| 1 | `fix/error-contract` | 0.2 — Flask error handlers, JSON 404 for `/api/*`, `api.js` status-before-parse, `importTransactions` collapsed onto the shared helper | Everything. Ship first: without it the next five PRs are un-debuggable in prod |
| 2 | `fix/p0-crashes` | 0.3 (bcrypt >72 + admin validation), 0.6's `next(stream)` guard, `Import.jsx` object render, `limit` floor, `AuthProvider` de-dup, `pinnedIds` validation, error boundary | Stops unauthenticated 500s and two white-screens |
| 3 | `fix/data-loss-ingest` | 0.1 — `BODY.PEEK[]` + mark-read-on-success-only | Stops permanent email loss while the rest of the plan runs |
| 4 | `fix/data-loss-txn` | 0.4 — shared `_detach_references`, 409-on-linked-delete, remove the duplicate sweep, `source_hash`-aware duplicate query | Makes split/delete safe; prerequisite for 2.1 |
| 5 | `chore/ci-and-dev-deps` | 1.5 — workflow, `requirements-dev.txt`, `npm ci`, `pytest` scaffold, `Makefile` test target | Every PR after this is checked |
| 6 | `test/aggregation-math` | 1.1 #1 — the tile/donut/trend/comparison equality test. **Expected to fail on merge**; it is the spec for PR 7 | Makes PR 7 verifiable |
| 7 | `fix/dashboard-math` | 0.5 — one definition of spent, window-scoped categories, comparison window, pin handling; 4.3 #1 `useMemo` | Turns PR 6 green. Dashboard becomes trustworthy |
| 8 | `feat/migrations` | 1.2 — `user_version` runner, migration 1 (squash), remove `_migrate` from the request path, remove `init_user_db` from login, migration test. **Backup + dry-run on DB copies before deploy** | Every schema change after this |
| 9 | `perf/indexes` | 1.3 — migration 2, six indexes, `EXPLAIN QUERY PLAN` before/after | Makes growth safe |
| 10 | `ops/backups-and-logs` | 1.6 — backup timer, logrotate, `WatchedFileHandler`; test one restore | Makes every later migration reversible |
| 11 | `feat/token-revocation` | 1.7 — `token_version`, `master.db` migrations, live `is_admin`, durable delete | Closes three P0s; prerequisite for any account management work |
| 12 | `test/parser-fixtures` | 1.1 #2 + #3 — golden files for 3 CSV + 5 email parsers, dedup tests | Prerequisite for PRs 14–16 |
| 13 | `refactor/reimbursement-model` | 2.1 — migration 3, backfill-and-drop the legacy columns; 2.2's `_window` extraction | Removes the "which delete path forgot?" class permanently |
| 14 | `feat/provenance` | 3.1 — migration 4, columns + partial unique index + backfill; retire `notes LIKE 'venmo:%'` at all three call sites | **The Plaid prerequisite** |
| 15 | `feat/identity-dedup` | 3.2 — drop `row_num` from the hash, use Venmo `ID`/Amex `Reference`, cross-path near-duplicate check. Turns PR 12's failing dedup test green | Stops duplicate storms; makes multi-source safe |
| 16 | `feat/sync-audit-and-jobs` | 3.3 + 3.4 — `sync_runs`/`sync_errors`, IMAP timeout + cap, 202-and-poll, scheduler into its own systemd unit | Makes a new integration debuggable and stops sync eating the worker pool |
| 17 | `refactor/parser-registry` | 3.5 — `parse_amount`/`parse_date`, `ColumnSpec`, header auto-detection, hoisted categorization | **Adding a bank becomes data, not code** |
| 18 | `refactor/transactions-page` | 2.3 — modals out, `TransactionRow`, `useTransactionList` with `AbortController`, shared `fmtDate`, `CategoriesContext` | Makes the transactions surface editable again |
| 19 | `refactor/theme-tokens` | 2.4 + 2.5 — `theme.js`, replace ~50 hexes, delete dead CSS/files/config, prune branches | Prerequisite for light mode; smaller bundle |
| 20 | `chore/docs` | 2.6 — README corrections, resolve the `DO NOT MERGE` header | Stops the next reader being misled |

Phase 4 items slot in afterwards, individually, in whatever order matters to you — with
one exception: **4.5 #1 (cache headers)** is ~6 lines and a bigger performance win than
anything else in this document. Ship it whenever you like; it depends on nothing.
