# 02 — Transactions, Categories, Reimbursements, Splits, Duplicates

Read-only audit. Every claim cites `file:line`. Findings tagged **CONFIRMED** (traced through
code and/or reproduced against the live DB) or **SUSPECTED** (reasoned, not executed).

Scope read in full: `routes/transactions.py` (596), `routes/categories.py` (112),
`routes/reimbursements.py` (184), `routes/helpers.py` (9), `services/categorize.py` (70),
`db_context.py` (259), `frontend/src/pages/Transactions.jsx` (1351), `frontend/src/api.js` (135),
and the seven in-scope components. DB inspected read-only:
`data/user_1_finance.db` (1533 txns), `data/prod_db.db` (1817), `user_3` (10), `user_2`/`user_4` (0)
— **local, disconnected snapshots**, not the live Pi database (`data/` is excluded from
every rsync deploy). See [00-INDEX.md](./00-INDEX.md) for the full provenance note; the
data-derived counts here (duplicate groups, reimbursement double-booking) describe that
snapshot, not necessarily today's live state.

---

## Overview

A single-user-per-SQLite-file Flask API (`data/user_<id>_finance.db`, `db_context.py:79-80`)
behind JWT auth, with a React 19 SPA. The transaction surface is one large page component
(`Transactions.jsx`) plus four modals. Money model:

- Every transaction stores a **positive** `amount` plus a `direction` of `'inflow' | 'outflow'`
  (`db_context.py:29-31`). There is no signed-amount convention anywhere; sign is presentational
  (`Transactions.jsx:30-34`).
- Reimbursements have **two independent mechanisms** that must be kept consistent by hand:
  1. `expected_reimbursement` + `reimbursement_external` on the outflow — an *optimistic* budget
     exclusion applied the moment it is set (`services/budget_service.py:5-20`).
  2. `reimbursement_links(inflow_id, outflow_id, amount)` — the *actual* money that arrived
     (`db_context.py:51-57`).
  A third, **legacy** mechanism, `transactions.reimburses_id`, still exists in the schema and in
  live data (63 rows in `user_1_finance.db`) and is only partially handled.
- Categories are a flat list with `sort_order` and a single `is_misc` flag
  (`db_context.py:20-25`, `routes/categories.py:35-39`).

---

## Data Model (real schema, incl. indexes)

### Schema the code intends (`db_context.py:19-76`)

```
categories(id PK, name TEXT NOT NULL UNIQUE, sort_order INT, is_misc INT)
transactions(
  id PK, amount REAL NOT NULL, merchant_raw TEXT, direction TEXT CHECK(inflow|outflow),
  category_id INT REFERENCES categories(id),        -- no ON DELETE
  notes TEXT, transaction_at TEXT NOT NULL, created_at TEXT NOT NULL,
  source_hash TEXT UNIQUE,
  reimburses_id INT REFERENCES transactions(id),    -- LEGACY, no ON DELETE
  reimbursement_status TEXT, reimbursement_mode TEXT, reimbursement_value REAL,  -- LEGACY
  expected_reimbursement REAL,
  reimbursement_external INT NOT NULL DEFAULT 0)
reimbursement_links(id PK, inflow_id -> transactions ON DELETE CASCADE,
                    outflow_id -> transactions ON DELETE CASCADE,
                    amount REAL CHECK(amount>0), created_at TEXT)
budgets(id PK, category_id UNIQUE -> categories, amount REAL, period, fold_into_misc)
```

### Indexes that actually exist — **there are none of the app's own**

`sqlite3 data/user_1_finance.db "SELECT name FROM sqlite_master WHERE type='index'"` returns only:

```
sqlite_autoindex_categories_1     (categories.name UNIQUE)
sqlite_autoindex_transactions_1   (transactions.source_hash UNIQUE)
sqlite_autoindex_budgets_1        (budgets.category_id UNIQUE)
```

Identical for `prod_db.db`, `user_2/3/4`. **CONFIRMED:** no index on
`transactions.transaction_at`, `.category_id`, `.merchant_raw`, `.direction`, and none on
`reimbursement_links.inflow_id` / `.outflow_id` — the two columns every correlated subquery
in `_TXN_SELECT` (`routes/transactions.py:18-30`) filters on.

### Live-data shape (`user_1_finance.db`)

| Fact | Value |
|---|---|
| transactions | 1533 (1390 outflow / 143 inflow) |
| `category_id IS NULL` | 6 |
| `reimburses_id IS NOT NULL` (legacy) | 63 |
| `source_hash IS NULL` | 4 (manual adds); 1529 have hashes |
| `notes LIKE 'venmo:%'` | 299 |
| `amount < 0` | 0 (sign convention holds in practice) |
| `LENGTH(transaction_at) = 19` | 1503 (`YYYY-MM-DDTHH:MM:SS`) |
| `LENGTH(transaction_at) = 10` | **30** (`YYYY-MM-DD`, e.g. id 6398 `2026-03-24`) |
| exact duplicate groups | **91** |
| merchants containing `%` or `_` | 7 |

`transaction_at` is stored **naive, no timezone, effectively local calendar date at T00:00:00**
(`routes/transactions.py:144-145`, `services/import_service.py:46`). `created_at` is stored as a
**UTC-aware ISO string with offset** (`routes/transactions.py:155`). Mixing the two in one
`ORDER BY` (see `_SORT_MAP`, `transactions.py:106-110`) compares two different clocks.
The `LENGTH=10` rows are supposed to be normalized by `db_context.py:140`, but that migration
has never run against `user_1_finance.db` — see BUG-1.

---

## Feature Walkthroughs

### 1. List / filter / sort / paginate — `GET /api/transactions` (`transactions.py:42-128`)

Query builder, in order:

1. **Params.** `category_id` (int), `limit` = `min(arg, 200)` default 25, `offset` = `max(arg, 0)`,
   `date_from`, `date_to` (`transactions.py:48-52`). The wrapping `try/except (TypeError, ValueError)`
   at `:47-54` is **dead code** — `request.args.get(type=int)` returns the *default* on a parse
   failure and never raises, so the documented 400 is unreachable.
2. **Status / category (mutually exclusive `if/elif` chain, `:64-70`).**
   - `uncategorized=true` or `status=pending` → `category_id IS NULL AND direction='outflow'`
   - `status=confirmed` → `category_id IS NOT NULL` (includes *inflows*)
   - **elif** `category_id` → `t.category_id = ?`
3. **Dates (`:71-76`).** `transaction_at >= date_from` and `transaction_at <= date_to || 'T23:59:59'`.
4. **Search `q` (`:77-82`).** `merchant_raw LIKE %q% OR notes LIKE %q% OR CAST(amount AS TEXT) LIKE %q%`.
5. **Source (`:83-86`).** `venmo` = `notes LIKE 'venmo:%' OR notes = 'venmo'`; `credit` = everything else.
6. **`include_ids` (`:88-103`).** CSV of ints; when present, the whole clause becomes
   `WHERE (<base>) OR t.id IN (...)`, i.e. a union used to keep pinned rows visible under a date filter.
7. **Sort (`:105-113`).** Whitelisted dict lookup with a safe default — **no injection**.
8. **Count then page (`:115-121`).** `COUNT(*)` uses the same `where_sql` (no category join), so
   `total` is consistent with the rows, `include_ids` included.

Frontend: `buildParams` (`Transactions.jsx:619-631`) sends `include_ids` **only when a date filter
is set** (`:629`), `PAGE_SIZE = 25` (`:17`). Filter changes refetch page 0 via an effect on
`[filterCat, filterStatus, dateFrom, dateTo, source, sort, pinnedIds]` (`:668-671`); search is
debounced 250 ms outside that effect (`:673-680`).

### 2. Create / edit / delete

- **Create** `POST /api/transactions` (`:131-180`). Requires `amount`, `direction`,
  `transaction_at`; bare `YYYY-MM-DD` is upgraded to `T00:00:00` (`:144-145`). If no
  `category_id` is supplied it calls `resolve_category_id` (`:158-159`). Returns the full
  `_TXN_SELECT` row, 201.
- **Update** `PUT /api/transactions/<id>` (`:193-303`). Field whitelist at `:206-209`; the
  `SET` clause is interpolated (`:297`) but only from those whitelisted keys — **safe**.
  Guards, in order: direction flip blocked while links exist (`:222-231`); negative amount
  rejected (`:243-244`); amount can't drop below already-applied/received (`:246-259`);
  `expected_reimbursement` must be ≥0, ≤ amount, outflow-only (`:263-276`);
  `reimbursement_external` outflow-only and mutually exclusive with real links (`:278-295`).
- **Delete** `DELETE /api/transactions/<id>` (`:306-318`). Nulls legacy `reimburses_id`
  back-references (`:315`) then deletes. `reimbursement_links` rows disappear silently via
  `ON DELETE CASCADE` + `PRAGMA foreign_keys=ON` (`db_context.py:224`).

### 3. Categorize

- `GET /api/categories` (`categories.py:14-21`), `POST` (`:46-70`, `INSERT OR IGNORE` → 409 on dup),
  `DELETE` (`:73-90`, **blocked with 409 if any transaction still references it** — no reassign/merge
  path), `PUT /reorder` (`:93-112`), `PUT /<id>/misc` (`:24-43`, clears the flag globally then sets one).
- Inference: `services/categorize.py:26-70` scores every historical `(merchant_raw, category_id)`
  pair by longest overlap → frequency → recency, with a 5-char minimum (`:17`) and Venmo rows
  excluded from learning (`:40`).
- Bulk paths: `/merchants/unclassified` (`transactions.py:428-445`), `/auto-classify` (`:448-493`),
  `/bulk-categorize` (`:496-513`), `/reclassify` (`:516-536`) — all keyed on
  `merchant_prefix()` + `LIKE 'prefix%'`.
- UI: inline category pills on an expanded uncategorized row (`Transactions.jsx:1104-1114`),
  `ClassifyModal` for per-merchant bulk assignment (`:187-301`), `ReclassifyModal` for
  category→category moves (`:514-566`).

### 4. Reimburse

- Link create `POST /api/reimbursement-links` (`reimbursements.py:25-83`): validates directions,
  refuses linking to an `reimbursement_external` charge (`:56-60`), caps at the outflow's amount
  (`:61-62`) and at the inflow's unapplied remainder (`:64-70`). Delete at `:86-95`.
- `GET /api/transactions/<id>/links` (`:98-148`) returns both sides plus
  `received_total`, `applied_total`, `inflow_remaining`, `outstanding`.
- `GET /api/transactions/owed` (`:151-184`) lists outflows whose
  `expected_reimbursement - received > $0.005`.
- **Net cost** is computed *client-side only*: `reimbursed_by_total - amount`
  (`Transactions.jsx:1089` and again at `:1164`) — see BUG-9 for the sign.
- **Budget exclusion** is server-side: `MIN(MAX(expected, received), amount)`
  (`budget_service.py:11-20`), surfaced as `reimbursement_excluded_amount` in `_TXN_SELECT`
  (`transactions.py:17`).
- UI: `ReimbursePickerModal` for an inflow (`ReimbursePickerModal.jsx:10-229`); the
  "Expensed / Expect amount…/ Clear" pills for an outflow (`Transactions.jsx:1197-1269`).

### 5. Split — `POST /api/transactions/<id>/split` (`transactions.py:321-425`)

Validates ≥2 parts, each amount > 0, and `abs(sum - original) <= 0.01` (`:359`). Refuses if the
parent has an `expected_reimbursement` (`:365-366`) or any link (`:368-376`). Then it
**deletes the parent** (`:381`) and inserts N new rows sharing the parent's `direction`,
`transaction_at`, and `created_at`. `source_hash` handling (`:385-393`): part 0 inherits the
parent's hash so a re-sync still dedupes; parts 1..n get `<hash>:split<i>`.
Client: `SplitModal.jsx` with a live balance indicator and a "Fill" button (`:30-34`).

### 6. Duplicates — `GET /api/transactions/duplicates` (`transactions.py:567-596`)

Self-join on an exact 4-tuple: `(transaction_at, amount, merchant_raw, direction)` with
`HAVING COUNT(*) > 1`. `DuplicatesModal.jsx` renders the groups with per-row Delete and a
"Keep first, delete rest" sweep (`:41-46`).

### 7. Pinning

Purely client-side, `localStorage["pinned_txn_ids"]`. Two independent implementations:
`Transactions.jsx:605-615` (hand-rolled) and `hooks/useDashboardFilters.js:6` (used by Dashboard +
`PinPickerModal`). Pins are sent to the server as `include_ids` so an out-of-range transaction
still appears under a date filter.

---

## What Works

Traced end-to-end and sound:

- **No SQL injection anywhere in scope.** Every dynamic fragment is either a whitelisted constant
  (`_SORT_MAP.get` with default, `transactions.py:112-113`), a `?`-placeholder string built from
  `len()` (`:97`, `:421`, `:483`), or a `SET` clause restricted to the `allowed` key set
  (`:206-210`, `:297`). Verified column-by-column.
- **Reimbursement-link arithmetic is genuinely well guarded.** Over-application, over-linking,
  direction flips, and amount reductions below what's already applied are all rejected with
  clear 400/409 messages and consistent epsilons (`reimbursements.py:22,61,69`;
  `transactions.py:251,258,272`).
- **Optimistic vs. realized reimbursement is a deliberate, documented split** and the two are kept
  mutually exclusive (`transactions.py:283-294`, `budget_service.py:5-10`).
- **Category deletion is safe** — it refuses rather than orphaning (`categories.py:81-85`).
- `total`/`limit`/`offset` are internally consistent, including under `include_ids`.
- Split's balance check, its parent-has-links refusal, and the source_hash-preservation trick are
  all correct and well commented (`transactions.py:378-393`).
- `merchant_prefix` / `resolve_category_id` ranking is a genuinely good heuristic with a sensible
  minimum-overlap floor and Venmo exclusion (`categorize.py:17,40,66`).
- Frontend request/response envelope, 401 → logout redirect (`api.js:15-23`), offline banner
  (`Transactions.jsx:771`), debounced search, and month grouping headers all work.

---

## Bugs & Issues

Severity: **P0** data loss / wrong money · **P1** wrong results or broken feature ·
**P2** fragile / degrades · **P3** polish.

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| **P0** | `transactions.py:381` (vs `:315`) | **Split deletes the parent without nulling legacy `reimburses_id` back-references.** `delete_transaction` does this at `:315`; `split_transaction` does not. With `PRAGMA foreign_keys=ON` (`db_context.py:224`) and `reimburses_id INTEGER REFERENCES transactions(id)` with no `ON DELETE`, deleting a row another row points at raises `IntegrityError`. `user_1_finance.db` has **63 rows with `reimburses_id IS NOT NULL`**. CONFIRMED (code traced + data counted; not executed against a live server) | Splitting a legacy-reimbursed charge 500s; the user sees `Unexpected token '<'` (see P1 no-error-handler row) |
| **P0** | `transactions.py:306-318` + `db_context.py:53-54` | **Deleting an outflow silently cascades away its `reimbursement_links`.** The endpoint refuses nothing and warns nothing; `ON DELETE CASCADE` drops every payment applied to that charge. The paying inflow's `applied_total` silently drops and its money becomes "unapplied income" in `budget_service.py:29-31`. Compare `update_transaction:222-231`, which *does* refuse a direction flip for exactly this reason. CONFIRMED | Reimbursement history destroyed with a `confirm("Delete this transaction?")` and no mention of links; income totals shift |
| **P0** | `DuplicatesModal.jsx:41-46` + `transactions.py:572-588` | **"Keep first, delete rest" on a heuristic that has heavy false positives.** The heuristic is exact `(transaction_at, amount, merchant_raw, direction)` equality with no `source_hash` awareness. In `user_1_finance.db` the top groups are **7× `MTA*NYCT PAYGO` $2.90 on 2025-01-25** (ids 6140-6146), 6× on 2025-02-01, 5× on 2025-08-10 — legitimate separate subway swipes. One click deletes 6 real transactions, unconfirmed, irreversibly. CONFIRMED against live data | Silent, unrecoverable loss of real transactions |
| **P1** | `transactions.py:49` | `limit = min(request.args.get("limit", default=25, type=int), 200)` — **a negative limit is not floored.** `?limit=-1` yields `LIMIT -1`, which SQLite treats as *unlimited*. Verified: `SELECT COUNT(*) FROM (SELECT id FROM transactions LIMIT -1 OFFSET 0)` → 1533. CONFIRMED | The 200-row cap is trivially bypassed; full-table dump in one request |
| **P1** | `transactions.py:64-70` | **The `status` filter silently swallows the `category_id` filter** (`if/elif` chain). The UI shows the Pending/Confirmed pills (`Transactions.jsx:886-908`) and the category dropdown (`:934-939`) side by side with no interlock, so selecting both returns results for only one. CONFIRMED | Filters lie; user sees a category-filtered list that isn't |
| **P1** | `db_context.py:140` never applied to `user_1_finance.db`; `Transactions.jsx:38` | **Date-only rows render one day early.** 30 rows still store `YYYY-MM-DD` (id 6398 = `2026-03-24`). `fmtDate` does `new Date(s)`; per ECMA-262, a date-only string parses as **UTC midnight** while `...T00:00:00` parses as **local** — so in any negative-UTC-offset timezone (the app's users are NYC-based, per `MTA*NYCT`) those 30 rows display as the previous day while the other 1503 display correctly. CONFIRMED | Inconsistent dates within one list; the same transaction shows a different day than its filter bucket |
| **P1** | `Transactions.jsx:386` | `useState(new Date().toISOString().slice(0, 10))` — **the Add-Transaction date defaults to the UTC date**, not the local one. After 19:00 ET (20:00 EDT) it pre-fills *tomorrow*. CONFIRMED | Silently misdated manual entries every evening |
| **P1** | `app.py` (no `@app.errorhandler`) + `api.js:14` | **No global JSON error handler.** Any uncaught exception returns Flask's HTML 500 page; `api.js:14` unconditionally `await res.json()`, which throws `SyntaxError: Unexpected token '<'`. That message is what lands in `alert()` / the error banner. CONFIRMED | Every server-side bug surfaces as gibberish; unhandled rejections in `.then`-only chains |
| **P1** | `Transactions.jsx:580-584` vs `OwedWidget.jsx:35` | **Dead deep link.** `OwedWidget` navigates to `/transactions?q=<merchant>`, but `Transactions` reads only `category_id`, `date_from`, `date_to` from `useSearchParams`. `q` is dropped. CONFIRMED | Clicking an "Owed to You" row lands on an unfiltered list |
| **P1** | `db_context.py:225` | **`_migrate()` runs on every `get_user_db()` call**, i.e. every authenticated request: ~10 `ALTER TABLE` attempts inside try/except, a `CREATE TABLE IF NOT EXISTS`, the legacy backfill queries in `_migrate_reimbursements` (`:179-199`), plus two `COUNT` queries. This puts **write transactions on every read path**, against a `timeout=15` connection. CONFIRMED | Per-request latency and needless write-lock contention; a slow query here blocks all reads for that user |
| **P1** | `transactions.py:73-76` | **`date_to` inclusivity is string-comparison-dependent.** `transaction_at <= date_to || 'T23:59:59'` is correct for the two formats present today, but excludes anything with sub-second precision (`...T23:59:59.5`) and there is no format validation on `date_from`/`date_to` at all — a malformed value silently returns zero rows instead of a 400. CONFIRMED (edge), SUSPECTED (impact) | Silent empty results; future precision change breaks the last second of the range |
| **P1** | `transactions.py:96-99` | **`include_ids` acts as a filter, not a union, when no other clause exists.** With `include_ids` and no other filter the WHERE becomes `WHERE t.id IN (...)` — the endpoint returns *only* the pinned rows. The UI never hits this (`Transactions.jsx:629` gates on a date filter) but any other caller will. CONFIRMED | Trap for the next consumer of this endpoint |
| **P1** | `transactions.py:77-82`, `:509`, `:474`, `:532` | **LIKE wildcards in user input are never escaped.** `q` becomes `%q%` verbatim, so searching `50%` or `_` matches everything. Worse, `bulk_categorize`/`reclassify`/`auto_classify` build `LIKE 'prefix%'` from `merchant_prefix(merchant_raw)`; **7 merchants in `user_1_finance.db` contain `%` or `_`**. CONFIRMED | Bulk-categorize can reassign a far wider set of transactions than the user intended |
| **P1** | `transactions.py:137-150` | **Create does not validate `amount >= 0`**, while update does (`:243-244`). A negative amount is accepted, then the sign is *ignored* by the UI (`Transactions.jsx:30-34` prepends `-`), producing a `-$-40.00`-style row and a negative contribution to spend totals. CONFIRMED (asymmetry traced; no negative rows exist yet in live data) | Corrupt totals from a hand-crafted or buggy client |
| **P2** | `transactions.py:18-30` + missing indexes | **N+1-by-subquery on an unindexed join column.** `_TXN_SELECT` carries 4 correlated subqueries over `reimbursement_links` per row (plus a 5th inside `_excluded_sql`), and there is **no index on `reimbursement_links.inflow_id`/`.outflow_id`** — verified above. That's 5 full scans × 25 rows per page. Same for `transactions.transaction_at`/`.category_id`/`.merchant_raw` on every filter and sort. CONFIRMED | Fine at 1.5k rows; degrades quadratically. Cheapest high-value fix in the codebase |
| **P2** | `transactions.py:469-487` | `auto_classify` issues **one query per merchant prefix** inside a Python loop, each a `GROUP BY` over the whole (unindexed) `transactions` table. CONFIRMED | Auto-classify cost is O(prefixes × rows) |
| **P2** | `transactions.py:359` | **Split tolerance is `0.01`, so up to a full cent can vanish or be conjured** per split, and `amount` is `REAL` throughout (`db_context.py:29`) rather than integer cents. Live data confirms floats are inexact (`9.79`, `16.33`, `36.41` all fail `CAST(amount*100 AS INT) = ROUND(amount*100)`). CONFIRMED | Parts don't provably sum to the parent; drift accumulates across splits and reimbursement arithmetic |
| **P2** | `transactions.py:381-417` | **Split destroys the parent's identity.** New rows get new ids, so any client-side pin (`localStorage["pinned_txn_ids"]`, `Transactions.jsx:605`) pointing at the parent becomes a dangling id that is silently sent as `include_ids` forever. Nothing prunes it, and `SplitModal` never warns that the original row is deleted rather than kept as a parent. CONFIRMED | Stale pins; users expect a parent/child relationship they don't get |
| **P2** | `transactions.py:356` | Split parts inherit the parent's `notes` when blank — including `venmo:payment:<person>`, which the UI treats as a source marker (`Transactions.jsx:1020`) and which `source=credit`/`venmo` filtering keys off (`transactions.py:83-86`). CONFIRMED | Split parts are misfiled by source |
| **P2** | `transactions.py:83-86` | **The "source" derivation is a `notes` string prefix, not a real field.** `credit` is defined as *not venmo*, so Zelle, cash, and manual rows are all reported as "Credit Card". Live `notes` values include `Zelle`, `zelle from s…`, `cash to etha…`, `nan xiang` — all bucketed as credit. Note also `venmo:` detection here (`OR notes = 'venmo'`) disagrees with `:434`/`:455`/`categorize.py:40`, which check only `NOT LIKE 'venmo:%'`. CONFIRMED | Source filter is wrong for every non-Venmo non-card row; three call sites can disagree about the same transaction |
| **P2** | `transactions.py:108-109` | `amount_desc`/`amount_asc` sort by the **unsigned** amount, mixing inflows and outflows, so a `+$500` deposit ranks above a `-$400` charge under "Amount (high→low)". CONFIRMED | Sort is meaningless on a mixed list |
| **P2** | `transactions.py:110` | `merchant_asc` uses `ASC NULLS LAST`, which requires **SQLite ≥ 3.30**. Local is 3.39.5 (works), but nothing pins or checks the runtime SQLite version, and a `SELECT` syntax error here is an uncaught 500. SUSPECTED (deploy-environment dependent) | One sort option 500s on an older SQLite |
| **P2** | `transactions.py:509` | `bulk_categorize` updates `WHERE category_id IS NULL AND merchant_raw LIKE 'prefix%'` — **it does not filter `direction='outflow'`**, unlike the unclassified list that feeds it (`:434`). CONFIRMED | Categorizing a merchant also categorizes matching inflows the user never saw in the picker |
| **P2** | `Transactions.jsx:636-648`, `ReimbursePickerModal.jsx:30-36`, `PinPickerModal.jsx:26-32` | **No request sequencing or `AbortController`.** Debounced search fires overlapping requests; a slow earlier response overwrites a newer one. CONFIRMED | Search results flicker to stale content |
| **P2** | `Transactions.jsx:683`, `:711` | **Optimistic local row replacement without re-evaluating the active filter.** After categorizing a row while `status=pending` is active, the row stays in the list (now non-matching) and `total` is not adjusted. Same for `handleSaved` after an edit that moves the row out of the date range or category. CONFIRMED | Client list drifts from server truth until the next full fetch |
| **P2** | `Transactions.jsx:644-647` | On a fetch error the component sets `error` but **leaves the previous `transactions` rendered**, so a stale list sits under a red error banner with working Delete/Edit buttons. CONFIRMED | Actions taken against data that may no longer be current |
| **P2** | `Transactions.jsx:689-699` | `handleDelete` recomputes `maxPage` from the **stale** `total` and never calls `refreshUnclassifiedCount()` (every other mutation does: `:686`, `:704`, `:713`). CONFIRMED | The amber "Classify N" badge goes stale after deleting an uncategorized row |
| **P2** | `Transactions.jsx:197-199` | `ClassifyModal.loadMerchants` chains `.then(setMerchants).finally(...)` with **no `.catch`** → unhandled promise rejection on failure and a modal stuck showing "All merchants classified". CONFIRMED | Silent failure presented as success |
| **P2** | `CategoryPicker.jsx:13` | `if (propCats && propCats !== cats) setCats(propCats)` — **`setState` during render**, plus a redundant state mirror of a prop. If a parent ever passes a freshly-constructed array each render this loops. CONFIRMED (anti-pattern) | Render-loop hazard; the whole `cats` state should be deleted |
| **P2** | `Transactions.jsx:214`, `:227`, `:714`; `CategoryPicker.jsx:9`; `OwedWidget.jsx:16`; `ReimbursePickerModal.jsx:27`, `:34` | **Seven empty `catch {}` blocks** that discard errors entirely. `handleAssignCategory` (`:714`) is the worst: a failed categorization looks identical to a successful one. CONFIRMED | Failures are invisible to the user |
| **P2** | `transactions.py:47-54` | Dead `try/except` — `request.args.get(type=int)` returns the default rather than raising, so `Invalid query parameters` (400) is unreachable and bad input is silently coerced. CONFIRMED | No input validation feedback at all on the list endpoint |
| **P3** | `Transactions.jsx:1089`, `:1164`, `:1174` | **"Net cost" is labelled and signed backwards.** `net = reimbursed_by_total - amount`, then rendered `+` when `net >= 0`. A $100 charge fully reimbursed shows **"Net +$0.00"**; a $100 charge with $30 back shows **"Net −$70.00"** in red — the correct reading is "net cost $70". The green/red mapping (`:1091`, `:1173`) is inverted relative to the label. CONFIRMED | The single most-glanced-at reimbursement number reads as the opposite of what it says |
| **P3** | `categories.py:56-60`, `db_context.py:22` | Category `name` is `UNIQUE` but **case-sensitive and length-unbounded** — `dining` and `Dining` coexist; a 10 KB name is accepted. CONFIRMED | Duplicate-looking categories; broken layout |
| **P3** | `services/import_service.py:11-15` | `source_hash` includes **`row_num`**, so re-exporting the same CSV with one extra earlier row shifts every row number and every hash → the entire file re-imports as new transactions. This is the most likely origin of the 91 duplicate groups. CONFIRMED (mechanism traced) | Duplicate storms; drives users to the dangerous Duplicates sweep above |
| **P3** | `Transactions.jsx:1016` | `<div className="txn-row-main" onClick={...}>` — **the primary interaction is a bare div**: no `role`, `tabIndex`, or keyboard handler. Rows cannot be opened by keyboard. CONFIRMED | Keyboard/AT users cannot expand a transaction |
| **P3** | all modals (`Transactions.jsx:102`, `:238`, `:415`, `:534`; `SplitModal.jsx:57`; `DuplicatesModal.jsx:49`; `ReimbursePickerModal.jsx:93`; `PinPickerModal.jsx:45`) | **No `role="dialog"`, no `aria-modal`, no `aria-labelledby`, no focus trap, no Escape-to-close, no focus restore.** The backdrop is a click-only div. CONFIRMED | Modals are invisible to screen readers and inescapable by keyboard |
| **P3** | `Transactions.jsx:334`, `:338`, `:343`, `:347`, `:355`, `:365`; `SplitModal.jsx:90`, `:99`, `:122` | **`<label className="field-label">` with no `htmlFor` and no wrapped input** — the labels are visually associated only. CONFIRMED | Fields are unlabelled to assistive tech; tapping a label doesn't focus the input |
| **P3** | `Transactions.jsx:524`, `:697`, `:727`, `:753`; `DuplicatesModal.jsx:35`; `ReimbursePickerModal.jsx:62`, `:72`, `:86` | **Eight `alert()`/`confirm()` calls** as the error and confirmation channel, in an app that otherwise has a `msg msg-error` component. CONFIRMED | Inconsistent, unstyled, unaccessible error UX |
| **P3** | `DuplicatesModal.jsx:75`, `SplitModal.jsx:72` | Array-index `key`s on lists that support removal. CONFIRMED | Focus and input state jump when a part/group is removed |
| **P3** | `Transactions.jsx:634`, `:839` | A single boolean `loading` renders a thin top bar and **never disables the row action buttons** or the filter controls. CONFIRMED | Double-submits during a slow request |

### Cross-cutting: the three-headed reimbursement model

Not a single line, but the largest structural risk. `reimburses_id` (legacy, `db_context.py:37`),
`reimbursement_status`/`_mode`/`_value` (legacy, `:38-40`), and `reimbursement_links` (`:51-57`)
all coexist. `_migrate_reimbursements` (`:173-214`) backfills the legacy columns into the new
table but **never clears them** — so the 63 legacy rows in `user_1_finance.db` are now represented
*twice*, once in `reimburses_id` and once in `reimbursement_links`. `delete_transaction:315` and
`split_transaction:381` disagree about which representation they have to clean up (see P0 #1).
The backfill guard is `links_exist == 0` (`:179`), so if a user creates a *new* link before their
first migration touch, the legacy backfill is skipped forever and those 63 relationships are lost
from the new model while still present in the old column. **CONFIRMED** (guard traced).

---

## Code Quality / Refactor Targets

### `Transactions.jsx` — 1351 lines, 5 components, 22 `useState` hooks in one function

`export default function Transactions()` alone spans `:569-1351` (782 lines) with **22 pieces of
state** (`:573-607`). Decomposition targets, highest value first:

1. **Extract the four inline modals into `components/`** — `ImportModal` (`:72-184`, 113 lines),
   `ClassifyModal` (`:187-301`, 115), `AddModal` (`:380-501`, 122), `ReclassifyModal`
   (`:514-566`, 53). None of them touch page state; all four are pure props. That's **~400 lines
   out of the file** with zero behavioural risk.
2. **Extract `<TransactionRow>`** — the map callback at `:996-1333` is a **337-line inline JSX
   expression** containing two IIFEs (`:1088`, `:1163`), the whole expanded panel, the reimbursement
   editor, and the edit form. It should be a component taking `(txn, categories, handlers)`.
3. **Extract a `useTransactionList()` hook** — `buildParams` / `fetchPage` / `page` / `total` /
   `loading` / `error` / all seven filter states (`:580-586`, `:619-671`) are one cohesive unit
   and would let the page own only presentation. This is also where request cancellation belongs.
4. **Extract `useReimbursementEditor()`** — `reimbSavingId`, `expectEditId`, `expectValue`,
   `handleSetReimbursement`, `handleToggleExpensed`, `openExpectEditor`, `handleSaveExpected`,
   `handleClearExpected` (`:596-598`, `:720-762`) are a self-contained state machine currently
   scattered across the page.
5. **Adopt the existing pin hook.** `Transactions.jsx:605-615` and `:973` reimplement what
   `hooks/useDashboardFilters.js:6` already owns, including a raw
   `localStorage.setItem("pinned_txn_ids", "[]")` that bypasses the setter. **Duplicated logic.**

### Duplicated logic (frontend)

- **`fmtDate` is defined four times, identically**: `Transactions.jsx:36`, `DuplicatesModal.jsx:8`,
  `ReimbursePickerModal.jsx:5`, `PinPickerModal.jsx:9`, plus a fifth variant in `OwedWidget.jsx:6`.
  `format.js` already exists and exports `fmtCurrency` — `fmtDate` belongs there (and needs the
  timezone fix from P1 in exactly one place).
- **`fmtAmt` is defined twice**: `Transactions.jsx:30` and `PinPickerModal.jsx:4`.
- **Ad-hoc currency formatting bypasses `fmtCurrency`** at `Transactions.jsx:1092`, `:1169`,
  `:1174` (`` `$${x.toFixed(2)}` ``) while the same file imports `fmtCurrency` and uses it 8 lines away.
- **`Dashboard.jsx:16-22` redefines `fmtCurrency`** rather than importing it from `format.js`.
- **Venmo/Zelle note parsing** (`Transactions.jsx:41-69`) is display logic that duplicates the
  server's source classification (`transactions.py:83-86`) — a `source` column would remove both.

### Inline styles vs `index.css`

The file leans overwhelmingly on inline style objects rather than the existing class system.
Non-exhaustive: `:280-282`, `:295`, `:843`, `:853`, `:857-863`, `:870-883`, `:892-903`,
`:915-926`, `:951`, `:965-977`, `:1006-1011`, `:1034-1040`, `:1046`, `:1051-1057`,
`:1060-1068`, `:1071-1077`, `:1080-1086`, `:1091`, `:1124`, `:1131`, `:1155`, `:1168`, `:1173`,
`:1191`, `:1203-1205`, `:1213-1215`, `:1235`, `:1247-1251`, `:1291`, `:1306`. The
filter-pill blocks at `:886-931` are the same 11-property style object written twice, differing
only in the `map` source — that is a `.filter-pill` / `.filter-pill.active` CSS pair.
`ReimbursePickerModal.jsx` and `PinPickerModal.jsx` each re-inline the same search-input style
(`:163-168` and `:76-80` respectively). Components are also styled inconsistently: the same
"badge" appears with hand-rolled styles at `Transactions.jsx:1051`, `:1060`, `:1071`, `:1080`.

### Prop drilling

Mild but real: `categories` is fetched once at `:658` and threaded into `AddModal` (`:818`),
`ClassifyModal` (`:810`), `SplitModal` (`:791`), `ReclassifyModal` (`:827`), `TxnForm` (`:1321`),
and `CategoryPicker` (`:478`) — six hops for what is app-global reference data. `CategoryPicker`
already has a self-fetching fallback (`:8-11`), which is the seam for a `CategoriesContext`
(one would also fix the render-phase `setState` at `CategoryPicker.jsx:13`).

### Backend

- `_TXN_SELECT` (`transactions.py:13-35`) is a 22-line f-string interpolating
  `_excluded_sql("t")` from `budget_service` — a **route module importing SQL from a service module**
  that the service also uses for a different purpose. That coupling is why the exclusion semantics
  are hard to reason about in two places at once.
- `_row_to_dict` (`:38-39`) is `dict(row)` with a name; used 5 times, while `dict(r)` is used
  directly at `:564`, `:594`, `reimbursements.py:83`, `:142-143`. Pick one.
- `db_context._migrate` (`:83-170`) is **10 copy-pasted `try/ALTER/except: pass` blocks**. This
  should be a `user_version`-based migration list; as written it cannot express a migration that
  is allowed to fail loudly, and it runs per request (P1 above).
- `routes/helpers.py` is 9 lines defining `_ok`/`_err` with **leading underscores on a public
  cross-module API** — imported by 8 modules.

---

## UX Gaps

1. **No undo anywhere.** Delete, split, "keep first delete rest", bulk-categorize, and reclassify
   are all irreversible with at most a `confirm()`.
2. **Delete gives no context.** `confirm("Delete this transaction?")` (`Transactions.jsx:690`)
   doesn't mention linked reimbursements, split parts, or that a re-sync may resurrect the row.
3. **`bulk_categorize` and `reclassify` report `updated: N` (`transactions.py:513`, `:536`) but the
   UI discards the count** in `ClassifyModal.assign` (`:224`) — the user never learns how many rows
   they just moved. `ReclassifyModal` does pass it (`:523`) but `onDone` ignores the argument (`:829`).
4. **No preview before a bulk operation.** Neither bulk-categorize nor reclassify shows which rows
   will be affected, despite both matching on an unescaped `LIKE` prefix.
5. **The pin feature is undiscoverable from Transactions.** Pins can be set per row (`:1122-1128`)
   but only *take effect* when a date filter is active (`:629`), and the explanatory chip only
   renders under that same condition (`:964`).
6. **No empty/error state inside `ReimbursePickerModal`'s link list**, and `remaining` initializes
   to the full inflow amount (`ReimbursePickerModal.jsx:17`) before `loadLinks` returns — the
   header briefly claims the full amount is unapplied.
7. **Split gives no warning that the original is destroyed** and no way to see the parts afterwards
   as a group (`SplitModal.jsx:64-67` describes it as "break into separate transactions", which is
   accurate but does not say the original disappears).
8. **No bulk selection** on the transaction list — no multi-select delete, categorize, or pin,
   despite categorize-one-at-a-time being the most repeated action.
9. **Duplicates modal shows no `source_hash`, no `created_at`, and no import provenance** — the
   only discriminators a user could use to tell a real duplicate from two real subway swipes.
10. **Pagination is Prev/Next only** (`:1337-1341`) with no jump-to-page and no total row count
    shown, on lists of 1500+.

---

## Notes for Future Integrations

- **Fix the money type before adding features.** `amount REAL` (`db_context.py:29`) plus a
  `0.01` split tolerance (`transactions.py:359`) plus five different epsilons
  (`1e-6` at `reimbursements.py:22`, `0.005` at `:171` and `Transactions.jsx:1070`, `0.01` at
  `SplitModal.jsx:16`) is not a foundation to build on. Integer cents, one epsilon constant.
- **Add a real `source` column.** Three call sites currently disagree about what "venmo" means
  (`transactions.py:84` vs `:434` vs `categorize.py:40`), and "credit" is defined as "not venmo".
  Any new import source (bank, Zelle, Apple Card) makes this worse immediately.
- **Add a real `split_parent_id` / lineage.** The current design deletes the parent
  (`transactions.py:381`), which is why pins dangle and why re-sync resurrection needs the
  `source_hash` trick at `:385-393`. A parent row marked `is_split` with child rows would make
  splits reversible and auditable.
- **Retire `reimburses_id` and the `reimbursement_status/_mode/_value` triplet.** Write a real,
  one-shot, `user_version`-gated migration that backfills *and clears* them, then drop the columns.
  Until then, every new delete path must remember `transactions.py:315` — `split_transaction`
  already forgot.
- **Add the indexes.** `transactions(transaction_at)`, `transactions(category_id)`,
  `transactions(merchant_raw)`, `reimbursement_links(outflow_id)`, `reimbursement_links(inflow_id)`.
  Five statements; they are currently the highest ratio of benefit to risk in the repo.
- **`_TXN_SELECT`'s derived fields are the de-facto transaction API contract**
  (`reimbursed_by_count`, `reimbursed_by_total`, `applied_total`, `outstanding`,
  `reimbursement_excluded_amount`). Any new consumer should read `transactions.py:13-35` first;
  note that `outstanding` is `NULL` (not `0`) whenever the transaction isn't a trackable outflow
  (`:31`), and the UI relies on `NULL > 0.005` being falsy (`Transactions.jsx:1070`).
- **Move `_excluded_sql` out of `services/budget_service.py`.** A route module importing SQL
  from a service (`transactions.py:8`) means the budget-exclusion semantics can't change without
  touching the transaction list.
- **Add `@app.errorhandler(Exception)` returning the `_ok`/`_err` envelope** before anything else —
  it's a ~5-line change that turns every future 500 from `Unexpected token '<'` into a readable message.
