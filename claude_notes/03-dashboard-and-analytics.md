# 03 — Dashboard, Analytics, Charts & Budgets

Read-only audit. Every claim cites `file:line`. Each finding is marked **CONFIRMED**
(traced through code and/or verified against `data/prod_db.db`) or **SUSPECTED**
(strong inference, not executed).

Evidence base: full read of `routes/dashboard.py`, `services/budget_service.py`,
`routes/profile.py`, the seven dashboard components, both dashboard hooks,
`format.js`, `api.js`, `index.css`, plus read-only SQL against local copies of
`data/prod_db.db` (1817 transactions, 2024-01-09 → 2026-08-23, 119
`reimbursement_links`, 12 rows with `expected_reimbursement`) and
`data/user_1_finance.db`. **These are disconnected local snapshots, not the live
Pi database** — `data/` is excluded from every rsync deploy — so treat the illustrative
numbers below (e.g. the $5,911-vs-$1,416 example) as evidence the code *can* produce
this on real historical data, not as today's live figures. The underlying logic bugs
(period mismatches, netting inconsistencies) are pure code findings and hold regardless.
See [00-INDEX.md](./00-INDEX.md) for the full provenance note.

---

## Overview

The Home page (`frontend/src/pages/Dashboard.jsx`) is a single-column, widget-stack
dashboard. It:

1. Computes a `{start_date, end_date}` pair **client-side** from a range pill
   (`useDashboardFilters.js:17-56`), persisted in `localStorage`.
2. Optionally appends `include_ids` — a list of "pinned" transaction ids that are
   force-included regardless of date (`Dashboard.jsx:111-113`).
3. Issues **four independent GETs**: `/api/dashboard` (owned by the page),
   and `/api/dashboard/comparison`, `/trend`, `/merchants` (each owned by its own
   child component, each with its own `useEffect`). A fifth,
   `/api/transactions/owed`, is fetched by `OwedWidget` with no date filter at all.
4. Renders widgets in a user-configurable order/visibility set stored in
   `localStorage` under `dashboard_widgets_v1` (`useDashboardWidgets.js:3`).

Backend is Flask + per-user SQLite (`db_context.get_user_db`). All money maths is
done in SQL; two shared SQL fragments in `services/budget_service.py` implement
reimbursement netting.

### The two netting primitives

`services/budget_service.py:11-20` — `_excluded_sql(prefix)`:

```sql
MIN( MAX( COALESCE(<t>.expected_reimbursement, 0),
          COALESCE((SELECT SUM(rl.amount) FROM reimbursement_links rl
                    WHERE rl.outflow_id = <t>.id), 0) ),
     <t>.amount )
```

The portion of an **outflow** that does not count as the user's own spend. Takes
the *larger* of "what I expect back" and "what actually arrived", capped at the
transaction amount. Optimistic: it deducts the expectation before any money lands.
The cap matters — `data/prod_db.db` has 1 row where linked reimbursements exceed
the outflow amount (verified), which without `MIN(..., amount)` would produce
negative spend.

`services/budget_service.py:29-31` — `_inflow_income_sql(prefix)`:

```sql
MAX(0, <t>.amount - COALESCE((SELECT SUM(rl.amount) FROM reimbursement_links rl
                              WHERE rl.inflow_id = <t>.id), 0))
```

The portion of an **inflow** that is real income rather than an expense offset.

Live check on `prod_db.db` for 2026-08-01..2026-08-31:

| metric | gross | netted |
|---|---|---|
| outflow | 2933.66 | **1415.55** |
| inflow  | 2010.72 | **15.11** |

Netting is not cosmetic here — it changes the headline numbers by >2x.

---

## Endpoint Reference

### 1. `GET /api/dashboard` — `routes/dashboard.py:62-69` → `get_budget_summary` (`services/budget_service.py:37-142`)

Params: `start_date`, `end_date`, `include_ids`.
Default range if either is missing: **month-to-date, server-local** (`budget_service.py:43-46`).

Predicates built at `budget_service.py:48-58`:
- `w_where` = `DATE(transaction_at) BETWEEN ? AND ?` — plus `OR id IN (...)` when pinned.
- `w_join`  = same, `t.`-prefixed.
- `w_null`  = uncategorised outflows, same window.

Queries:
- **Totals** (`:60-66`): `SUM(outflow: amount - excluded)` → `total_spent`;
  `SUM(inflow: inflow_income)` → `total_income`. `net = income - spent` (`:138`).
- **Pending count** (`:71-74`): `COUNT(*)` of `category_id IS NULL AND direction='outflow'`
  inside the window. Drives the red "N to review" pill (`Dashboard.jsx:202-213`).
- **By-category** (`:85-107`): `categories LEFT JOIN budgets LEFT JOIN transactions`.
  The join window is **period-dependent**:
  - `period='monthly'` → the requested `[start,end]` window (+ pinned ids)
  - `period='yearly'`  → `[<end.year>-01-01, <end.year>-12-31]` (`:81-83`, `:103`)

  The per-category `spent` expression **nets inflows** (`:92-96`):
  `outflow → +(amount - excluded)`, `inflow → -(inflow_income)`.
  This differs from the totals query, which never subtracts inflows from spend.
- **Budget scaling** (`:78-79`, `:111`):
  `month_count = max(1, round(days_in_range / 30.44))`; monthly budgets are
  multiplied by `month_count`, yearly budgets are used as-is.
- **Flex pool** (`:123-133`): categories with `budgets.fold_into_misc = 1` are
  summed into a shared `{budget, spent, remaining, category_ids}` pool.

Response: `{total_spent, total_income, net, pending_count, by_category[], flex_pool}`.

### 2. `GET /api/dashboard/trend` — `routes/dashboard.py:72-148`

Defaults: month-to-date, **server-local `date.today()`** (`:76-79`).

Granularity auto-picked from `span_days = (end - start).days` (`:84-92`):
`<=60 → daily`, `<=180 → weekly`, else `monthly`. A `granularity` query param is
supported but **no caller ever sends it** (`api.js:46-49`).

Group expression (`:94-99`): `DATE(transaction_at)` /
`strftime('%Y-%W', transaction_at)` / `strftime('%Y-%m', transaction_at)`.

One aggregate query (`:109-118`) computing `spent` and `income` with the same
netting fragments as `/dashboard`. Then a **densification loop** (`:123-146`) walks
the calendar from `start` and emits a zero row for every bucket with no data, so
the chart has no gaps. Weekly buckets are keyed on the Monday of the week
(`:131`); the emitted `date` is the ISO Monday, the emitted key is `%Y-%W`.

I verified Python's `%W` and SQLite's `%W` agree on edge dates
(`2026-01-01 → 2026-00`, `2025-12-29 → 2025-52`, `2024-12-30 → 2024-53`), so the
weekly key join is sound.

Response: `[{date, spent, income}, ...]`.

### 3. `GET /api/dashboard/merchants` — `routes/dashboard.py:151-230`

Defaults: month-to-date, server-local (`:155-157`).

- **top_merchants** (`:170-183`): outflows only, `GROUP BY merchant_raw`,
  `SUM(amount - excluded) AS net_spent`, `COUNT(id)`, **`AVG(t.amount)` (gross,
  un-netted)**, `ORDER BY net_spent DESC LIMIT 8`.
- **Per-merchant drill-down** (`:187-194`): an **N+1 query** (one per merchant, up
  to 8) fetching raw `amount, transaction_at`. This subquery **omits
  `include_ids`** and returns **gross amounts**.
- **largest_transaction** (`:203-213`): single outflow with max `amount - excluded`.
- **repeat_merchants** (`:215-224`): `COUNT(DISTINCT strftime('%Y-%m', ...)) AS
  months_seen ... HAVING months_seen > 1`, restricted to the same window.

### 4. `GET /api/dashboard/comparison` — `routes/dashboard.py:233-322`

Defaults: month-to-date, server-local (`:239-240`).

**Previous-period definition** (`:245-251`):
```python
span = (end - start).days + 1
if start.day == 1:
    prev_end   = start - timedelta(days=1)
    prev_start = prev_end.replace(day=1)     # the whole preceding calendar month
else:
    prev_start = start - timedelta(days=span)
    prev_end   = start - timedelta(days=1)   # a same-length window immediately before
```

Two calls to `_period_totals` (`:22-53`, `:253-254`): current gets `pinned_ids`,
previous does not. `_period_totals` also computes `top_category` via a
`categories LEFT JOIN transactions ... ORDER BY cat_spent DESC LIMIT 1` (`:43-51`).

`has_prev = previous["spent"] > 0 or previous["income"] > 0` (`:255`). When false,
`previous`, `deltas` and `biggest_change_category` are all nulled (`:314-320`).

`_delta_pct` (`:56-59`) guards `not previous or previous == 0` → returns `None`;
otherwise `round((cur - prev) / abs(prev) * 100, 1)`.

**biggest_change_category** (`:265-295`): per-category current vs previous spend,
skipping categories where `prev_s == 0`, picking max `|pct|`.

**velocity** (`:297-310`): only when `end >= today AND range_days < 60 AND start.day == 1`.
`days_elapsed = max((today - start).days, 1)`, `daily_rate = current.spent / days_elapsed`,
`projected = daily_rate * days_in_month`.

### 5. `GET /api/transactions/owed` — `routes/reimbursements.py:151-183`

Not date filtered. Rows where `expected_reimbursement IS NOT NULL AND
reimbursement_external = 0`; `outstanding = max(0, expected - received)`, kept when
`> 0.005`.

---

## Metric Definitions (and where they disagree)

| Metric | Source | Reimbursement netting | Date window | Pins |
|---|---|---|---|---|
| `total_spent` (stat tile) | `budget_service.py:62` | outflow netted, inflows **not** subtracted | requested range | yes |
| `total_income` | `budget_service.py:63` | inflow netted | requested range | yes |
| `by_category[].spent` (donut + breakdown) | `budget_service.py:92-96` | outflow netted **and inflows subtracted** | monthly → range; **yearly → whole calendar year** | monthly only |
| `trend[].spent` | `dashboard.py:112` | outflow netted | requested range, bucketed | yes, but pins outside range are silently dropped |
| `merchants[].net_spent` | `dashboard.py:173` | outflow netted | requested range | yes |
| `merchants[].average_amount` | `dashboard.py:175` | **none (gross)** | requested range | yes |
| `merchants[].transactions[].amount` | `dashboard.py:188` | **none (gross)** | requested range | **no** |
| `comparison.current.spent` | `dashboard.py:35` | outflow netted | requested range | yes |
| `comparison.previous.spent` | `dashboard.py:35` | outflow netted | derived window | **no** |
| `owed.total_outstanding` | `reimbursements.py:170` | n/a | **all time** | n/a |

Four different "spend" definitions coexist on one screen.

**Concrete disagreement**, measured on `data/prod_db.db` for August 2026:

| widget | value |
|---|---|
| Money Out stat tile (`total_spent`) | **$1,415.55** |
| Sum of `by_category[].spent` (what the donut totals) | **$5,910.99** |

The gap is Travel ($3,747.15) and Housing ($1,026.58) — both `period='yearly'`
budgets, so their `spent` is **year-to-date**, not August. The donut's centre label
literally reads "Total Spent" (`CategoryDonut.jsx:106`) while showing a number 4.2x
the Money Out tile directly above it.

---

## Widget System

`frontend/src/hooks/useDashboardWidgets.js`

- Six widgets, fixed catalogue (`:5-12`): `comparison, trend, donut, budget,
  merchants, owed`.
- State `{order: string[], hidden: string[]}` in `localStorage` key
  `dashboard_widgets_v1` (`:3`).
- `load()` (`:17-30`) does real migration work: filters stored keys against
  `VALID_KEYS`, then **appends any new default key not present** (`:23`), so adding
  a widget to `WIDGETS` auto-appears for existing users. `hidden` is filtered the
  same way. Whole thing is `try/catch`-wrapped with a default fallback.
- `toggleWidget` (`:39-48`) and `moveWidget` (`:50-61`) are pure swaps, persisted
  on every change.
- `visibleOrder` (`:63`) = order minus hidden; consumed by the `switch` at
  `Dashboard.jsx:333-365`.
- The config UI is inline in `Dashboard.jsx:223-269` — checkbox + ▲/▼ buttons.

`frontend/src/hooks/useDashboardFilters.js`

- Four separate `localStorage` keys, **unversioned** (`:3-6`):
  `dashboard_range`, `dashboard_custom_start`, `dashboard_custom_end`,
  `pinned_txn_ids`.
- `dateParams` is `useMemo`'d on `[range, customStart, customEnd]` (`:104-107`) —
  stable identity, which matters (see BUG-11).
- `toDateParams` (`:17-56`) builds dates from the **browser's local clock** with a
  manual `YYYY-MM-DD` formatter (correctly avoiding `toISOString()` UTC shift).
  - `this_month`: 1st of month → today
  - `last_month`: 1st → last day of previous month
  - `3_months` / `6_months`: `today - 90` / `today - 180` days → today
  - `this_year`: Jan 1 → today
  - `custom`: the two date inputs, falling back to month-to-date

---

## What Works

- **Reimbursement netting is genuinely correct where applied.** The
  `MIN(MAX(expected, received), amount)` construction handles all four cases
  (expectation only, receipt only, both, over-receipt) and is capped so it can
  never produce negative spend. Verified against a real over-linked row.
- **Trend densification.** The calendar walk (`dashboard.py:123-146`) means a chart
  never has holes, and month-length/leap-year rollovers are handled explicitly
  (`:143-146`). Python/SQLite `%W` agreement verified across year boundaries.
- **Pinned-transaction union semantics.** `(DATE(...) BETWEEN ? AND ? OR id IN (...))`
  is a union, not an append, so pinning an in-range transaction does not
  double-count it.
- **Widget persistence + forward migration** (`useDashboardWidgets.js:17-30`) is the
  best-written piece of state code in scope — validated, self-healing, versioned key.
- **Flex-pool budgeting** is a genuinely nice feature and the two-segment stacked
  bar (`BudgetByCategoryWidget.jsx:56-87`) renders it coherently, with the fixed/flex
  legend and explanatory copy (`:89-105`).
- **Over-budget affordances**: `barColor` thresholds at 0.75/1.0
  (`CategoryBreakdown.jsx:8-12`, `BudgetByCategoryWidget.jsx:7-11`), `"X over"` vs
  `"X left"` (`BudgetByCategoryWidget.jsx:50-53`), red amount when over
  (`CategoryBreakdown.jsx:77`). Bars are `Math.min(...,100%)` clamped.
- **Category → transactions drill-down** (`CategoryBreakdown.jsx:47-59`) correctly
  passes `Jan 1–Dec 31` for yearly-period categories rather than the dashboard range.
- **Empty states exist** for donut (`CategoryDonut.jsx:29-56`), trend
  (`SpendingTrendChart.jsx:60-66`), merchants (`MerchantInsights.jsx:84`), owed
  (`OwedWidget.jsx:19`), and empty-category collapse (`CategoryBreakdown.jsx:107-120`).
- **Loading skeletons** with a shared `pulse` keyframe (`index.css:129-132`) and a
  top progress bar (`:117-127`).
- Per-user DB isolation and `@require_auth` on all four endpoints.
- Every SQL string is parameterised; the only f-string interpolation is of
  server-generated placeholder counts (`dashboard.py:25`, `103`, `161`,
  `budget_service.py:50`) — no injection surface.

---

## Bugs & Issues

Severity: **P0** = wrong numbers shown to user / crash · **P1** = materially
misleading or broken UX · **P2** = fragile, perf, or polish.

| Sev | file:line | Issue | Impact | Status |
|---|---|---|---|---|
| P0 | `services/budget_service.py:100-104` + `CategoryDonut.jsx:27,106` | Categories with `period='yearly'` join on the **whole calendar year**, but their `spent` is rendered in the same donut/list as month-scoped categories and summed into a centre label reading "Total Spent". | On prod data, donut total = **$5,911** vs Money Out tile = **$1,416** for the same month. The headline chart contradicts the headline number. | **CONFIRMED** (SQL executed) |
| P0 | `services/budget_service.py:62` vs `:92-96` | `total_spent` does **not** subtract inflows; `by_category[].spent` **does** (`inflow → -inflow_income`). Two definitions of "spent" in one response object. | Category bars and the total can never be reconciled; a refund in a category silently shrinks that bar but not the total. | **CONFIRMED** |
| P0 | `routes/dashboard.py:246-248` | When `start.day == 1`, "previous period" is the **entire preceding calendar month**, but the current period is month-**to-date**. On the 3rd of the month you compare 3 days against 31. | Every delta badge on `ComparisonCard` is wildly negative for the first ~3 weeks of every month, and `biggest_change_category` is noise. | **CONFIRMED** |
| P0 | `routes/dashboard.py:246-248` with `range="this_year"` | `this_year` starts Jan 1 → `start.day == 1` → previous period = **December alone**. YTD (8 months) is compared against one month. | Comparison card is meaningless for the This Year range; deltas read as huge increases. | **CONFIRMED** |
| P0 | `routes/dashboard.py:104-107` vs `:123-146` | `/trend` includes pinned ids in the SQL `WHERE`, but the densification loop only emits buckets between `start` and `end`. A pinned transaction outside the range lands in `data_map` under a key the loop never asks for. | Pinned spend is counted by `/dashboard` and `/comparison` but **silently vanishes** from the trend chart. Chart total ≠ tile total whenever pins are used. | **CONFIRMED** |
| P0 | `routes/dashboard.py:253-254` | `current` gets `pinned_ids`; `previous` does not — but a pinned transaction dated inside the previous window is counted in `previous` naturally **and** in `current` via the pin. | Double counting across the comparison; deltas are wrong in both directions. | **CONFIRMED** |
| P1 | `routes/dashboard.py:215-224` | `repeat_merchants` requires `COUNT(DISTINCT strftime('%Y-%m'))>1` **within the selected range**. The default range is a single month. | The "RECURRING" section (`MerchantInsights.jsx:150-174`) is **structurally impossible** to populate on the default view. Verified: returns 0 rows for Aug 2026 on prod data. | **CONFIRMED** (SQL executed) |
| P1 | `routes/dashboard.py:175` | `AVG(t.amount)` is gross while the sibling `net_spent` is netted. | `average_amount` is inconsistent with everything around it. It is also **never rendered** (`MerchantInsights.jsx` ignores it) — dead payload that will mislead the next integrator. | **CONFIRMED** |
| P1 | `routes/dashboard.py:187-194` | The merchant drill-down subquery drops `include_ids` **and** returns gross `amount`. | Opening the merchant sheet shows a transaction list whose sum does not equal the `net_spent` shown on the row that opened it (prod: Ticketmaster row = $197 net, sheet shows one $450 txn). | **CONFIRMED** (SQL executed) |
| P1 | `routes/dashboard.py:302,307` | `days_elapsed = max((today - start).days, 1)` is off by one — on Aug 23 with start Aug 1 it yields **22**, not 23. | Projected spend over-estimated by ~4.5% mid-month and by 100% on the 1st (`daily_rate = full day-1 spend / 1`). `days_remaining` also off by one. | **CONFIRMED** |
| P1 | `routes/dashboard.py:302` | `daily_rate` uses `current["spent"]`, which **includes pinned out-of-range transactions**. | Pinning an old large charge inflates the month-end projection. | **CONFIRMED** |
| P1 | `ComparisonCard.jsx:16-23` | `prevPeriodLabel` unconditionally subtracts **one month** from `start_date`, but the backend uses a span-shifted window when `start.day != 1` (`dashboard.py:250-251`). | For 3 Months / 6 Months / most Custom ranges the column header names a period that is not the period whose numbers are in the column. Same for `periodLabel` (`:8-14`), which labels a 90-day window "Aug 2026". | **CONFIRMED** |
| P1 | `SpendingTrendChart.jsx:88` | `` `$${Math.round(v/1000) > 0 ? `${Math.round(v/1000)}k` : v}` `` — `Math.round(600/1000) = 1 > 0`, so **$600 renders as "$1k"**. Everything from $500 up is bucketed to the nearest thousand. | Y-axis is materially wrong for the typical personal-finance value range. | **CONFIRMED** |
| P1 | `SpendingTrendChart.jsx:10-17,69` | `fmtLabel` always formats as `{month, day}`. Monthly buckets carry `date = "2026-08-01"` (`dashboard.py:142`) and weekly buckets carry a Monday (`:135`). | The 6-month/This-Year charts label monthly points "Aug 1", implying a single day. No indication of granularity anywhere in the UI. | **CONFIRMED** |
| P1 | `services/budget_service.py:79,111` | `month_count = max(1, round(days_in_range/30.44))` prorates monthly budgets by a **rounded** month count. 45 days → 1; 46 days → 2. Python's banker's rounding makes the boundary non-obvious. | Budget targets jump discontinuously as the custom range is dragged. For `this_year` on Aug 23 (235 days) budgets scale by 8 while only 7.7 months of spend exist → every category looks under budget. | **CONFIRMED** |
| P1 | `services/budget_service.py:85-107` | Uncategorised outflows (`category_id IS NULL`) never appear in `by_category`. | They are in `total_spent` but not in the donut or the breakdown list, another source of tile-vs-chart divergence. (Not currently visible on prod data — 0 uncategorised in Aug 2026 — but structural.) | **CONFIRMED** |
| P1 | `services/budget_service.py:103` | The yearly-period branch of the transaction join omits the `OR t.id IN (...)` pinned clause that the monthly branch has (`:101`). | Pins affect monthly categories but not yearly ones. | **CONFIRMED** |
| P1 | `useDashboardFilters.js:68-74` | `pinnedIds` is `JSON.parse`d with a `try/catch` but **no shape validation** — unlike the widgets hook. `JSON.parse('{"a":1}')` succeeds and yields a non-array. | `pinnedIds.length` → `undefined`, `pinnedIds.join(",")` (`Dashboard.jsx:112`) → **TypeError, whole page white-screens**. No error boundary anywhere in `App.jsx`. | **CONFIRMED** |
| P1 | `useDashboardFilters.js:3-6` | The four filter keys are unversioned, and `dashboard_range` is read back with no validation (`:60`). A stale/renamed range value falls through `toDateParams`'s `default:` branch and silently becomes This Month while the pill row shows nothing active. | Silent, confusing state. Contrast `dashboard_widgets_v1`, which does this properly. | **CONFIRMED** |
| P1 | `useDashboardFilters.js:77,82,87,94,100` + `useDashboardWidgets.js:33` | Every `localStorage.setItem` is unguarded. | Throws in Safari Private Browsing / storage-full, taking down the click handler. | **CONFIRMED** |
| P1 | `api.js:14` | `const json = await res.json()` runs before any status check. A 502/504 HTML page, or an empty 204, throws `SyntaxError`. | Every dashboard caller swallows it (`Dashboard.jsx:147 catch {}`, `MerchantInsights.jsx:68`, `ComparisonCard.jsx:73`, `OwedWidget.jsx:16`), so a backend outage renders as widgets that quietly never appear, with no error surfaced. | **CONFIRMED** |
| P1 | `OwedWidget.jsx:19` | `!data || data.items.length === 0` — dereferences `.items` without checking it exists. | If the endpoint shape changes or returns a partial object, TypeError → white screen. | **CONFIRMED** |
| P2 | `Dashboard.jsx:111-113` + `SpendingTrendChart.jsx:48`, `ComparisonCard.jsx:75`, `MerchantInsights.jsx:70` | `allParams` is built with an object literal on **every render** and used as the sole `useEffect` dependency in three children. `dateParams` itself is memoised (`useDashboardFilters.js:104`) — `allParams` throws that away. | **Refetch storm.** A single `load()` triggers 3 Dashboard renders (`setLoading(true)` → `setData` → `setLoading(false)`), each producing 3 new fetches → ~9–12 requests on mount. Clicking a donut slice (`setSelectedCategoryId`, `Dashboard.jsx:96`) re-fires all three network calls for no reason. Fix is a one-line `useMemo`. | **CONFIRMED** |
| P2 | `Dashboard.jsx:115-117,141-151` and children | All four requests are independent `useEffect`s that fire on mount — genuinely parallel, not a waterfall. But there is **no shared cache, no dedupe, no `AbortController`** (only a `cancelled` boolean, so responses are still downloaded and parsed). | Wasted bandwidth; combined with the storm above, real load. | **CONFIRMED** |
| P2 | `Dashboard.jsx:123-128` | `handleSynced` is `useCallback(..., [])` but closes over `allParams`. | After a background PWA sync, the dashboard reloads using the range that was active **at first mount**, not the current one. | **CONFIRMED** |
| P2 | `Dashboard.jsx:16-22`, `format.js:1-6` | `maximumFractionDigits: 0` on all dashboard currency. | Category values are individually rounded, so a visibly-summing list never adds up. `$-0.40` renders as `-$0`, and `Dashboard.jsx:327` prefixes `+` only when `net >= 0`, so a tiny negative net shows `-$0`. `MerchantInsights` uses 2 digits (`:4`) while `ComparisonCard` uses 0 (`:4`) — inconsistent within one screen. | **CONFIRMED** |
| P2 | `format.js:1-6` | `en-US` / `USD` hardcoded, no `minimumFractionDigits`, no locale plumbing. | Single-currency lock-in; a future multi-currency or non-US user has one file to rewrite but ~40 call sites. | **CONFIRMED** |
| P2 | `useDashboardFilters.js:28-31` vs `routes/dashboard.py:76,155,239` | Range boundaries come from the **browser's** clock; endpoint defaults and `/comparison`'s `velocity` (`:299,301`) use the **server's** `date.today()`. `transaction_at` is stored as a naive local ISO string (verified: all 1817 rows are 19 chars, no `Z`/offset) and compared with SQLite `DATE()`. | Three clocks in one feature. A user in UTC+13 near midnight, or a server in a different TZ, gets a `velocity` block computed against a different "today" than the range it describes. No test coverage. | **CONFIRMED** |
| P2 | `CategoryDonut.jsx:80-87` | `outerRadius` is passed to `<Cell>` (`:84`). `outerRadius` is a `<Pie>` prop; Recharts `<Cell>` forwards presentation attributes to the SVG sector, not geometry. | The "pop out selected slice" affordance is almost certainly a **no-op**; only the 0.35 opacity dim actually renders. | **SUSPECTED** (Recharts 3.8.1, not executed) |
| P2 | `CategoryDonut.jsx:75-77` | `onClick={(entry) => ...entry.category_id}` relies on Recharts' first callback arg spreading the original datum's fields. Recharts 3.x has been moving toward `(data, index, event)` where `data` wraps the datum in `payload`. | If the shape is `{payload: {...}}`, `entry.category_id` is `undefined` and every click deselects. Worth a manual click-test. | **SUSPECTED** |
| P2 | `CategoryDonut.jsx:29-56` | Empty state renders a **fake full-circle slice** (`data=[{value:1}]`) coloured `#22263A`. | Reads as a real (grey) category to anyone not looking closely; also has no `role`/label. | **CONFIRMED** |
| P2 | all chart components | No `role="img"`, no `aria-label`, no `<title>`/`<desc>`, no table fallback, no keyboard interaction. Donut slices are click-only `<Cell>`s (`CategoryDonut.jsx:85` sets `outline: "none"`). Trend has no legend at all — red vs green lines are unlabelled (`SpendingTrendChart.jsx:91-106`). Colour is the **only** encoding distinguishing spend from income. | Charts are invisible to screen readers and ambiguous to colour-blind users. `outline: none` removes the focus ring without replacement. | **CONFIRMED** |
| P2 | `SpendingTrendChart.jsx:60-66` | `error \|\| !data?.length` collapses "request failed" and "no transactions in range" into the same string, "Trend data unavailable". | A user with a legitimately empty month is told the feature is broken. | **CONFIRMED** |
| P2 | `MerchantInsights.jsx:81` / `ComparisonCard.jsx:86` | `if (!data) return null` after a failed fetch. | The widget silently disappears from the stack even though the user explicitly enabled it in the Widgets panel. No retry. | **CONFIRMED** |
| P2 | `ComparisonCard.jsx:26-30` | `const isUp = pct > 0` — `pct === 0` renders `↓ 0%` in "good" green. | Cosmetic wrongness on flat months. | **CONFIRMED** |
| P2 | `useDashboardFilters.js:18-26` | Custom range has **no validation** that `customEnd >= customStart`. | Inverted range → empty everything; `/comparison` computes `span <= 0` and a `prev_start` **after** `prev_end` (`dashboard.py:245-251`), producing a nonsense empty previous period rather than an error. | **CONFIRMED** |
| P2 | `Dashboard.jsx:190-192` | The subtitle under "Home" always prints `new Date()`'s current month/year, regardless of the selected range. | Select "Last Month" or a 2024 custom range and the page still says "September 2026". | **CONFIRMED** |
| P2 | `Dashboard.jsx:184` | `📴 Offline — showing cached data` — there is **no service worker** (`frontend/public/` contains only `favicon.svg`, `icons.svg`) and no cache layer; `OnlineContext` is a bare `navigator.onLine` wrapper. | The banner claims a capability that does not exist. Offline, all four fetches fail and widgets vanish. | **CONFIRMED** |
| P2 | `MerchantInsights.jsx:42`, `:94`, `:156` | `key={i}` (array index) on three lists that re-order when the range changes. | Wrong DOM reuse / animation glitches on range switch. | **CONFIRMED** |
| P2 | `routes/dashboard.py:43-51` | `top_category` is computed on every `/comparison` request (2x, once per period) via a full `categories LEFT JOIN transactions` scan — and is **never rendered** by `ComparisonCard.jsx`. | Two wasted table scans per request. | **CONFIRMED** |
| P2 | `routes/dashboard.py:187-194` | N+1: up to 8 extra queries per `/merchants` call. | Fine at 1.8k rows; will not scale. No index on `merchant_raw` or `transaction_at` in the schema (`db_context.py:27-49`). | **CONFIRMED** |
| P2 | `routes/dashboard.py:13-19` | `_parse_include_ids` returns `[]` on any `ValueError`, so `include_ids=1,abc,3` silently discards **all** pins. There is also no length cap — a 10k-id list becomes a 10k-placeholder `IN`. | Silent data loss; unbounded query size. | **CONFIRMED** |
| P2 | `routes/profile.py:49-50` | `scalar_fields = set()` — the entire scalar-update path is dead code that can never execute. | Dead branch; `updates` is always empty. | **CONFIRMED** |
| P2 | `routes/profile.py:71-74` | Budget update is `UPDATE ... WHERE category_id = ?` with **no upsert and no rowcount check**. A category with no `budgets` row can never get a budget through this endpoint, and the request still returns 200. | Silent no-op for new categories. Also no validation that `amount >= 0`. | **CONFIRMED** |
| P2 | `routes/profile.py:60-76` | Budgets are written in a loop, and a validation failure on entry N returns 400 **after** entries 0..N-1 were already executed (no rollback before `_err`). | Partial writes on invalid payloads. The `conn.commit()` at `:76` is skipped, which saves this **only** if the connection is not in autocommit — worth verifying in `db_context.py`. | **SUSPECTED** |
| P2 | `Dashboard.jsx:333-365` | The widget `switch` has six cases; `OwedWidget` ignores `dateParams` entirely (`OwedWidget.jsx:15-17`, `api.getOwed()` takes no params). | "Owed to You" sits inside a date-filtered dashboard showing all-time data with no label saying so. | **CONFIRMED** |

---

## Styling / CSS Notes

`frontend/src/index.css` — 1290 lines, one flat file, no imports, no preprocessor.
`frontend/src/App.css` is **0 bytes** (dead file, still on disk).

**Structure.** Roughly, and only roughly, grouped: tokens (`:1-27`), reset
(`:29-73`), layout (`:75-115`), loaders (`:117-147`), nav/chrome (`:149-275`),
dashboard bits (`:277-336`), buttons (`:338-418`), forms (`:420-537`), utilities
(`:539-587`), auth (`:589-634`), stats (`:636-666`), category rows (`:668-721`),
transactions (`:723-856`), import (`:858-982`), profile/admin (`:984-1194`), pills
(`:1196-1229`), modal (`:1231-1285`). No section comments, no BEM, no naming
convention — `.stat-tile`, `.txn-row`, `.admin-user-top` and `.mono` share one
namespace.

**Design tokens** (`:1-18`) are well chosen: `--bg --surface --surface-raised
--border --primary --green --red --amber --text --text-secondary --text-muted`,
plus `--bottom-nav-height` and `env(safe-area-inset-*)` for iOS notch handling.

**The central problem: the tokens are bypassed in every dashboard component.**
The JSX uses raw hex values that duplicate the token palette:

- `#F1F5F9` (= `--text`): `CategoryDonut.jsx:97`, `CategoryBreakdown.jsx:62,77`,
  `MerchantInsights.jsx:109,136,162`, `ComparisonCard.jsx:53,100,135,153`
- `#94A3B8` (= `--text-secondary`): `CategoryDonut.jsx:52,103`,
  `CategoryBreakdown.jsx:90,114`, `SpendingTrendChart.jsx:28,63`,
  `MerchantInsights.jsx:37,47,112,139,167`, `ComparisonCard.jsx:57,100,134,151`
- `#475569` (= `--text-muted`): `CategoryBreakdown.jsx:95,98`,
  `SpendingTrendChart.jsx:80,87`, `MerchantInsights.jsx:105`,
  `ComparisonCard.jsx:52,57,103,144,165`
- `#22263A` (= `--surface-raised`): `CategoryDonut.jsx:43`,
  `SpendingTrendChart.jsx:53`, `MerchantInsights.jsx:75,159`,
  `ComparisonCard.jsx:36,80,159`
- `#2E3250` (= `--border`): `SpendingTrendChart.jsx:26,76`, `MerchantInsights.jsx:159,165`
- `#EF4444` / `#22C55E` / `#F59E0B` / `#6C63FF` (= `--red/--green/--amber/--primary`):
  throughout, including both duplicated `barColor` helpers
  (`CategoryBreakdown.jsx:8-12` and `BudgetByCategoryWidget.jsx:7-11` are
  **byte-identical** and should be one shared function).

Even `index.css` itself hardcodes: `.range-pill` uses `#22263A`/`#94A3B8` and
`.range-pill.active` uses `#6C63FF` (`:288-306`) rather than the tokens defined 280
lines above.

**Dark mode.** There is none — or rather, there is *only* dark mode.
`color-scheme: dark` is pinned at `:27`, there is no `prefers-color-scheme` block
and no `[data-theme]` hook anywhere in the file. Because ~50 hex literals are baked
into JSX inline styles, adding a light theme is not a CSS change; it is a rewrite of
all seven components. This is the single highest-leverage cleanup in scope.

**Responsiveness.** Only **four** media queries in 1290 lines (`:88`, `:107`,
`:255`, `:315`) — three `min-width: 768px` and one `max-width: 360px`. Consequences:

- `.summary-grid` (`:308-313`) is `repeat(3, 1fr)` and only collapses below **360px**
  (`:315-319`). Between 361px and 767px, three `$X,XXX` figures at 22px
  (`.stat-value`, `:653`) share the viewport width minus 32px of padding. On a
  375px iPhone SE that is ~106px per tile — values will wrap or clip.
- `#root` is capped at `max-width: 960px` (`:79`) but the dashboard never uses the
  extra width: on a 1440px desktop the widget stack stays a single 960px column with
  200px-tall charts. There is no desktop grid layout at all.
- Charts are `ResponsiveContainer width="100%"` with a **fixed `height={200}`**
  (`CategoryDonut.jsx:32,65`, `SpendingTrendChart.jsx:74`) — no aspect-ratio
  adaptation. The donut's `innerRadius={60}/outerRadius={90}` are absolute pixels
  (`CategoryDonut.jsx:36-37,70-71`), so the donut is identical at 320px and 960px.
- `ComparisonCard`'s `gridTemplateColumns: "80px 1fr 1fr"` (`:47,96`) is unguarded;
  at 320px each value column is ~100px for a currency figure plus a delta badge.
- `MerchantInsights`'s bottom sheet is `maxWidth: 960` `position: fixed`
  (`:23-28`) — it does not respect `#root`'s centring on desktop in the same way the
  rest of the app does, and uses `70dvh` while `PinPickerModal` uses `80dvh`.

**Dead rules** (defined in CSS, zero `className` references in `frontend/src`):
`.stat-row` (`:636-641`, a near-duplicate of `.summary-grid` at `:308-313`),
`.cat-list` (`:668`), `.cat-row` / `:last-child` / `.cat-row-top` (`:673-687`),
`.cat-name` (`:689`), `.cat-amounts` (`:695`), `.progress-track` (`:701`),
`.progress-fill` + `.green/.amber/.red` (`:708-721`), `.text-amber` (`:579`),
`.toast` (`:262`), `.inline-error` (`:533`), `.input-error` (`:474`).

That is roughly 90 lines of an abandoned earlier dashboard implementation —
`.cat-row` + `.progress-fill` is clearly the predecessor of what
`CategoryBreakdown.jsx` now does with inline styles. The inline-style rewrite
happened and the CSS was never deleted.

**Other duplication**: `.summary-grid` vs `.stat-row` (identical rule bodies);
`.range-pills` and `.filter-row` (`:277-284` / `:321-328`) are both
scrollbar-hidden horizontal flex rows differing only in `padding-bottom`.

**Good bits worth keeping**: `font-variant-numeric: tabular-nums` on `.stat-value`
(`:657`) and `.cat-amounts` (`:698`); safe-area handling on `.page` (`:84`);
`scrollbar-width: none` + `::-webkit-scrollbar` pairs done correctly; `100dvh`
rather than `100vh`.

---

## UX Gaps

1. **No granularity indicator or control on the trend chart.** The backend supports
   `?granularity=` (`dashboard.py:85`) and nothing sends it (`api.js:46-49`). The
   user cannot tell whether a point is a day, a week, or a month — and the labels
   actively lie (BUG: `SpendingTrendChart.jsx:10-17`).
2. **No legend anywhere.** Trend has two unlabelled lines; the donut has no slice
   labels, no legend, and no tooltip — only a centre number that changes on click.
   The only way to learn what a slice is, is to click it.
3. **The donut and the breakdown list are redundant** but disagree (yearly
   categories inflate the donut). They are also separate widgets in the config panel
   ("Category Chart" / "Budget by Category"), so a user can enable one without the
   other and get a chart with no key.
4. **No date range shown in the header.** Selecting a custom range gives no
   confirmation text; the subtitle shows today's month regardless
   (`Dashboard.jsx:190-192`).
5. **Pin affordance is opaque.** The pill reads `+3 pinned` (`Dashboard.jsx:286`)
   and `PinPickerModal.jsx:60` says "pinned outside range" even for in-range pins.
   There is no indication in any widget that pinned data is folded in — and in the
   trend chart it silently is not.
6. **Errors are invisible.** Three widgets return `null` on failure; the page's
   `load()` has a bare `catch {}` (`Dashboard.jsx:147`). Nothing is retryable.
7. **No error boundary.** `App.jsx` has none, so any of the several TypeErrors above
   white-screens the whole app.
8. **Widget config is not discoverable** — a "Widgets" ghost button
   (`Dashboard.jsx:214-219`); reorder is ▲/▼ only, no drag, no reset-to-default,
   and hiding all six leaves a blank page with no explanation.
9. **`velocity` appears and disappears with no explanation** — it requires
   `end >= today AND range_days < 60 AND start.day == 1` (`dashboard.py:299`), so it
   silently vanishes on Last Month / 3 Months / most custom ranges.
10. **Budgets have no editing affordance on the dashboard.** They are configured on
    `/profile`, but `CategoryBreakdown` rows navigate to `/transactions` instead —
    an over-budget bar is not clickable to the thing that would fix it.
11. **Over-budget is under-signalled.** Bars clamp at 100% (`CategoryBreakdown.jsx:36`),
    so 101% and 400% look identical; only the amount's colour differs.

---

## Notes for Future Integrations

- **Consolidate the four endpoints into one.** They already share `start_date`,
  `end_date`, `include_ids` and re-derive the same predicates four times
  (`dashboard.py:22-31`, `:101-107`, `:160-168`, `:257-263`,
  `budget_service.py:48-58` — five near-identical copies of the same
  `OR id IN (...)` builder). A single `/api/dashboard?include=totals,trend,merchants,comparison`
  would kill the refetch storm, guarantee metric consistency, and let one
  `_window(start, end, ids)` helper be the sole source of truth.
- **Pick one definition of "spent" and centralise it.** The four current definitions
  (table in *Metric Definitions*) are the root cause of three P0s. Decide explicitly:
  does spend net inflows? Do yearly-budget categories report year-to-date or
  range-scoped spend? Publish the answer in the response
  (`{"spend_basis": "net_of_reimbursements", "window": {...}}`) so the client can
  label it.
- **Return the window the server actually used.** `/comparison` should echo
  `previous: {start_date, end_date}` rather than making `ComparisonCard.jsx:16-23`
  guess — that guess is currently wrong for 4 of 6 ranges. Same for `/trend`:
  return the chosen `granularity` so labels can adapt.
- **Move date-range computation server-side.** Three clocks (browser, server
  `date.today()`, naive stored `transaction_at`) is one too many. Send
  `?range=this_month&tz=America/New_York` and let one place resolve it.
- **Add `useMemo` to `allParams`** (`Dashboard.jsx:111-113`) before anything else —
  one line, removes ~2/3 of dashboard traffic.
- **Extract the shared palette.** A `frontend/src/theme.js` exporting the token hexes
  (or, better, reading `getComputedStyle` off `:root`) would let the ~50 hardcoded
  literals collapse and make light mode a possibility. Also deduplicate the two
  identical `barColor` functions.
- **Version the filter localStorage** the way `dashboard_widgets_v1` already does,
  and validate shapes on read — `pinnedIds` is a live white-screen vector
  (`useDashboardFilters.js:68-74`).
- **Indexes before scale.** `db_context.py:27-49` defines no index on
  `transactions(transaction_at)`, `transactions(category_id)`, or
  `transactions(merchant_raw)`. Every dashboard query is a full scan plus a
  correlated subquery per row against `reimbursement_links`. Fine at 1,817 rows;
  it will not be at 50,000.
- **`/dashboard/merchants` N+1** (`dashboard.py:187-194`) should become one
  windowed query with `ROW_NUMBER() OVER (PARTITION BY merchant_raw)`.
- **Schema drift is real.** `data/user_1_finance.db` and `user_2_finance.db` are
  still on the pre-reimbursement schema (no `reimbursement_links` table, no
  `expected_reimbursement` column) — verified. Migrations in `db_context.py:86-210`
  run lazily on connection open, so any tooling or analytics that opens these files
  directly (as this audit did) will fail on the dashboard SQL. Do not assume the
  on-disk schema is current.
- **No tests exist for any of this.** Given four P0 numeric bugs, the highest-value
  first test is a fixture DB with known reimbursements asserting that
  `total_spent`, `sum(by_category.spent)`, `sum(trend.spent)`, and
  `comparison.current.spent` are equal for the same window. Today, on real data,
  they are not.
