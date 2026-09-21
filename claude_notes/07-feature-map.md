# 07 — Feature Map

Every feature in the app, in one place: **what it is, how it works, what functions, what
is broken, and what to improve.** This is the reference doc — the per-area audits
(`01`–`05`) hold the full evidence, and `06-remediation-plan.md` holds the sequenced plan.

Written 2026-09-08 against HEAD `20f7f41` on `main`. Every claim cites `file:line`.

**Reading the tables.** Severity: **P0** = data loss, wrong money shown, or an
unauthenticated 500 · **P1** = user-visible breakage or a real security weakness ·
**P2** = fragility that blocks extension · **P3** = polish.

**A note on evidence.** Findings were checked against three local database files:
`data/prod_db.db` (1,817 rows, the most recent and most useful — a manually-pulled
snapshot of production data, last written 2026-08-23), `data/user_1_finance.db` (1,533
rows, an **even staler dev copy**, still on the pre-reimbursement schema), and
`data/master.db` (last touched 2026-07-22). **None of these are live.** `data/` is
excluded from every rsync deploy (`DEPLOYMENT.md:23`), so the app's actual, currently-
updated database exists only on the Raspberry Pi and was not read for this audit. Treat
every number below sourced from these files as "true of an Aug-23 snapshot, demonstrating
the code can do this" — not as "true of production right now." Two claims (§4's test
accounts, §29's orphaned `user_2_finance.db`) are flagged inline as needing verification
against the live Pi specifically. Findings sourced only from `file:line` in the
application code are unaffected by any of this. Where `prod_db.db` and
`user_1_finance.db` disagreed, prod's numbers were used; three findings in `02` were
corrected on exactly this basis (`06:11-34`).

---

## Contents

| # | Feature | Status |
|---|---|---|
| 1 | [Registration & Login](#1-registration--login) | Works; token lifecycle is the weak point |
| 2 | [Sessions & JWT](#2-sessions--jwt) | Works; no revocation of any kind |
| 3 | [Password Management](#3-password-management) | Works; no self-service recovery |
| 4 | [Admin & User Management](#4-admin--user-management) | Works; deletion is not durable |
| 5 | [Transaction List, Filters & Search](#5-transaction-list-filters--search) | Works; two filters silently lie |
| 6 | [Transaction Create / Edit / Delete](#6-transaction-create--edit--delete) | Works; delete destroys linked data silently |
| 7 | [Categories](#7-categories) | Works |
| 8 | [Auto-Categorization](#8-auto-categorization) | Works; quadratic, and fragmented by merchant naming |
| 9 | [Bulk Classify & Reclassify](#9-bulk-classify--reclassify) | Works; unescaped LIKE, no preview, no undo |
| 10 | [Reimbursements](#10-reimbursements) | Arithmetic is sound; **three competing models** |
| 11 | [Split Transactions](#11-split-transactions) | **Broken on legacy-reimbursed rows** |
| 12 | [Duplicate Detection](#12-duplicate-detection) | **Actively dangerous** |
| 13 | [Pinned Transactions](#13-pinned-transactions) | Works on 3 of 4 widgets; silently wrong on trend |
| 14 | [Dashboard Totals & Stat Tiles](#14-dashboard-totals--stat-tiles) | **Disagrees with the chart below it** |
| 15 | [Category Donut & Breakdown](#15-category-donut--breakdown) | **Wrong total on yearly budgets** |
| 16 | [Spending Trend Chart](#16-spending-trend-chart) | Works; axis labels are wrong |
| 17 | [Merchant Insights](#17-merchant-insights) | Works; "Recurring" is structurally impossible |
| 18 | [Period Comparison](#18-period-comparison) | **Wrong for ~3 weeks of every month** |
| 19 | [Budgets & Flex Pool](#19-budgets--flex-pool) | Works; proration is discontinuous |
| 20 | [Owed / Outstanding](#20-owed--outstanding) | Works; ignores the date filter |
| 21 | [Dashboard Widget Customization](#21-dashboard-widget-customization) | **Best code in the frontend** |
| 22 | [CSV Import](#22-csv-import) | Works; **dedup hash is position-based** |
| 23 | [Gmail Sync](#23-gmail-sync) | Works in prod; **silently destroys unparseable email** |
| 24 | [Email Parsers](#24-email-parsers) | All five work today; all five are brittle |
| 25 | [Gmail Credentials](#25-gmail-credentials) | Works; no key rotation path |
| 26 | [Scheduler](#26-scheduler) | Works in prod; wired twice |
| 27 | [Profile Page](#27-profile-page) | Works |
| 28 | [PWA, Offline & Install](#28-pwa-offline--install) | **Not a PWA** |
| 29 | [Platform: Data Layer](#29-platform-data-layer) | Migration runs on every request |
| 30 | [Platform: API Client & Errors](#30-platform-api-client--errors) | **Breaks every error message** |
| 31 | [Platform: Build & Deploy](#31-platform-build--deploy) | Solid; no cache headers, no CI |

---

# Accounts

## 1. Registration & Login

**What it is.** Self-service signup and login by username *or* email.

**How it works.**
`Register.jsx:36` → `POST /api/auth/register` (`auth_routes.py:25`, rate-limited 10/hr).
The handler reads `REGISTRATION_ENABLED` from the environment at request time
(`auth_routes.py:28-29`), strips username and email, enforces `len(password) >= 8` and
nothing else (`:36-40`), pre-checks uniqueness with two separate queries returning
*distinct* 409 messages (`:42-46`), bcrypt-hashes at cost 12 (`:48`), inserts
(`models/user.py:37-52`), provisions `data/user_<id>_finance.db` via `init_user_db`
(`:55`), and returns a token. The client stores it and navigates home.

Login (`auth_routes.py:65`, 20/min + 100/hr) looks the identifier up as a username then as
an email (`:72`), verifies with `bcrypt.checkpw` (`:76`), re-runs `init_user_db` on **every
login** (`:79`), stamps `last_login_at` (`:81-85`), and issues a token.

**What works.** Register → auto-login → seeded per-user DB, end to end. Login by either
identifier. bcrypt cost 12 consistently. Rate limits genuinely apply.

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| P0 | `auth_routes.py:48,76,116,119`; `admin_routes.py:67,114` | bcrypt 5.0.0 raises `ValueError` on >72-byte passwords (reproduced in the project venv). Four sites have no guard; two sit outside their `try` | **Unauthenticated HTTP 500 at `/api/auth/login`**, triggerable by anyone |
| P1 | `auth_routes.py:73-77` | Nonexistent user returns before any bcrypt work; existing user burns ~250 ms. The `_DUMMY_HASH` fix already exists in `auth/auth_db.py:35-41` — a file with **zero importers** | Username-enumeration timing oracle |
| P1 | `auth_routes.py:43` vs `:46` | Distinct 409s: "Username already taken" vs "Email already registered" | Account enumeration |
| P2 | `models/user.py:12-13` | `UNIQUE` is byte-exact (SQLite `BINARY` collation); no normalization anywhere | `Alice@x.com` and `alice@x.com` are two accounts. Blocks any future password reset by email |
| P2 | `auth_routes.py:33` | No email format validation at all | `"notanemail"` is accepted by the API |
| P2 | `auth_routes.py:42-51` | Uniqueness check and INSERT are separate statements on separate connections | Concurrent signup → `UNIQUE` violation → misleading generic **500** instead of a 409 |
| P2 | `auth_routes.py:79` | `init_user_db` on **every login** re-runs the full schema + `_migrate()` | Writes on every login; if the DB is locked by a concurrent sync, login itself 500s (no try/except) |
| P3 | `auth_routes.py` / `models/user.py:37-52` | `last_login_at` not set at registration | Admin list shows "never" for a brand-new active user |

**Improvements.**
- Confirm-password field on register (`Register.jsx:74-88`) — the pattern already exists at
  `Profile.jsx:513-518`. A typo currently creates an account nobody can log into.
- State the password rule to the user; only `minLength={8}` is present, never explained.
- Expose whether registration is open. With `REGISTRATION_ENABLED=false`
  (`deploy/env.production:16`), `/register` still renders a full form and Login still
  advertises "Create one" — the frontend has no way to know it will 403.
- Harvest `auth/auth_db.py`'s constant-time dummy-hash pattern, then delete the file.

---

## 2. Sessions & JWT

**What it is.** Stateless bearer-token auth, 7-day TTL, token in `localStorage`.

**How it works.**
`encode_token` (`jwt_utils.py:11-18`) signs `{sub, username, is_admin, exp}` with HS256 and
a 168-hour expiry. No `iat`, `nbf`, `jti`, `iss`, or `aud`. `require_auth`
(`middleware.py:8-29`) requires a literal `Bearer ` prefix, decodes with the algorithm
pinned to `["HS256"]` (`jwt_utils.py:22`), coerces `sub` back to `int` (`:23`), and
populates `g.current_user` **entirely from token claims** (`middleware.py:21-25`).
Per-user DB routing is `get_user_db(g.current_user["user_id"])` at all 38 call sites.

**What works — and this is the app's best structural property.** No route anywhere takes a
user id from the path, query, or body to select a database. Horizontal tenant isolation is
sound, verified across every call site. Algorithm confusion / `alg: none` is correctly
blocked. `config.py:8-9` enforces a ≥32-char `SECRET_KEY` at import.

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| P0 | `middleware.py:21-25` | **No DB revalidation on any request.** A deleted user keeps a working token for the rest of its 7-day TTL — and their next request hits `db_context.py:220-221`, which **recreates the finance DB the admin just deleted** | Deletion is not durable |
| P0 | `middleware.py:24` + `jwt_utils.py:14` | `is_admin` is a token claim, never re-read | A demoted admin keeps full admin powers for 7 days. Only remedy is rotating `SECRET_KEY`, which logs everyone out |
| P1 | `api.js:15-23` | No refresh, no sliding expiry, no proactive `exp` check. Expiry is `window.location.href = "/login"` | Every 7 days the user is dumped to login mid-action with **unsaved form state destroyed** and no message |
| P1 | `AuthContext.jsx:12-21` + `api.js:19-20` | `api.js` returns `undefined` after starting navigation → `setUser(undefined)` → the `[token, user]` effect re-fires → `api.me()` again | **Request loop** on every expired-token page load |
| P2 | `auth_routes.py:120` | Password change does not invalidate existing tokens (no `token_version` column) | "Someone has my account" has no working remedy |
| P2 | `ProtectedRoute.jsx:5-6` | `isAuthenticated` is just `!!token`; `exp` never checked client-side | Expired token renders the full UI, fires requests, 401s, then bounces — a flash of empty dashboard |
| P2 | `main.jsx:9` + `App.jsx:110` | **`AuthProvider` mounted twice**, nested. The outer is shadowed but its `useEffect` still runs | Two `GET /api/auth/me` per load; the dead outer provider can clear the shared token on a 401 |
| P2 | `app.py:83` | CSP allows `'unsafe-inline'` **and** `'unsafe-eval'` while the token lives in `localStorage` | Any XSS yields a 7-day token. Neither directive is needed by the Vite build |
| P3 | `middleware.py:15` | `startswith("Bearer ")` is case-sensitive; no whitespace tolerance | `bearer <token>` is rejected. Non-conformant with RFC 6750 |

**Improvements.** The single highest-leverage change in the app: add
`token_version INTEGER NOT NULL DEFAULT 0` to `users`, put it in the JWT, and compare it
against the DB in `middleware.py:20`. One indexed lookup per request closes the
deleted-user, demoted-admin, and stolen-token-survives-password-change holes at once — and
the same read lets `require_admin` consult live `is_admin`.

---

## 3. Password Management

**How it works.** `Profile.jsx:214-233` validates new == confirm, then
`POST /api/auth/change-password` (`auth_routes.py:101`, 10/hr, auth checked before the
limiter so unauthenticated requests don't burn quota). The handler enforces `len >= 8`,
verifies the current password, and writes a new cost-12 hash.

**What works.** Current-password verification is present and correct.

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| P1 | `admin_routes.py:104-116` | Admin reset has **no length validation** and **no existence check**; `update_password` is a bare `UPDATE` | An admin can set a 1-char password via the API. `POST /api/admin/users/9999/reset-password` returns `{"success": true}` |
| P2 | `auth_routes.py:39-40,112-113` | Policy is `len >= 8` and nothing else — no complexity, no breach check, no maximum | `12345678` is accepted; >72 bytes 500s (see §1) |

**Improvements.**
- **No forgot-password exists anywhere** (grepped `frontend/src` and `routes/` — zero
  hits). The only recovery is asking an admin. Defensible for a single-owner app; a hard
  lockout for anyone else. Gated on the email-normalization work in §1.
- Admin reset gives no success feedback — the form just collapses (`Admin.jsx:35-36`),
  indistinguishable from cancelling.

---

## 4. Admin & User Management

**How it works.** Eight endpoints under `/api/admin`, all `@require_auth` +
`@require_admin` in the correct decorator order, **none rate-limited**. All eight are wired
to `Admin.jsx` — no orphans. `list_users` decorates each row with Gmail/sync state by
opening that user's finance DB (`admin_routes.py:28-43`).

Self-protection: delete-self blocked (`:123-124`), change-own-admin blocked (`:91-92`).
Both compare ints correctly, so **the guards actually fire**.

**What works.** All eight endpoints, the admin UI, and both self-guards.

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| P0 | `admin_routes.py:126` + `db_context.py:220-221` | Deleting a user neither revokes their token nor durably removes their data | See §2. Their next request recreates the DB |
| P1 | `models/user.py:83-98` | `update_user` returns `dict(None)` for a nonexistent id; no validation of values | `PUT /api/admin/users/9999` → **500**. An admin can blank a username, locking that user out permanently |
| P1 | `admin_routes.py:54-77` | Create-user has no password-length and no email-format validation; `Admin.jsx:190` even uses `type="text"` for email | Neither side validates |
| P1 | `admin_routes.py:129-131` | Deletion removes `user_<id>_finance.db` but **not** the `-wal`/`-shm` siblings | **Confirmed in code**, and reproduced in a local snapshot (`data/user_2_finance.db` + `-shm` + `-wal` all survive there for a user absent from that snapshot's `users`) — ⚠ check the live Pi to confirm this specific case still holds; see the evidence note at the top |
| P2 | `admin_routes.py:72,99` | Raw exception strings returned to the client, and *every* exception coerced to 409 | Leaks `UNIQUE constraint failed: users.email`; a disk error reports as a conflict |
| P2 | `limiter.py:22` | `default_limits=[]` — no limit on any admin route or on `/api/auth/me` | `reset-password` is unthrottled |
| P2 | `Admin.jsx:217-222` | Client-side JWT decode with `atob` on a **base64url** payload, wrapped in `catch {}` | When it throws, `isSelf` is false for every row — the admin sees Delete on their own row. Server correctly rejects, so it's a lying UI, not a breach. The page never uses `useAuth()`, which already has `user.id` |
| P2 | `App.jsx:88` | `/admin` is gated by `ProtectedRoute` (auth only), not an admin check | Any authenticated user can render the page, then sees a bare `Forbidden` box |
| P3 | `admin_routes.py:91-92,123-124` | No explicit last-admin guard — unreachable today only because self-targeting is blocked | Incidental protection, not intentional |
| P3 | `admin_routes.py:170,179` | `lines` param unbounded and unvalidated; `all_lines[-n:]` with `n=-5` returns nearly the whole file | Confusing; bounded only by the 1 MB log cap |
| P3 | `admin_routes.py:39-42` | `_user_with_finance` swallows every exception into `gmail_configured: False` | A corrupt or locked DB looks identical to "Gmail not set up" |

**Improvements.** Replace the three `alert()` calls (`Admin.jsx:24,37,50`) with the
`msg msg-error` pattern used everywhere else. Add a confirm to the admin toggle
(`:104-109`) — delete has one, admin-grant doesn't. Give the log viewer search, level
filtering, and a line-count control (the endpoint already accepts `lines`).

**Housekeeping — check the live Pi.** A local snapshot of `master.db` (not the Pi's —
see the evidence note at the top) shows two throwaway accounts, `debugtest` (id 3) and
`smoketest2` (id 4), with working credentials as of 2026-07-22. Verify on the Pi whether
they still exist before deleting anything based on this.

---

# Transactions

## 5. Transaction List, Filters & Search

**How it works.** `GET /api/transactions` (`transactions.py:42-128`) builds a query in
order: params (`limit` capped at 200, default 25) → status/category → dates → free-text `q`
→ source → `include_ids` → whitelisted sort → `COUNT(*)` then page. `_TXN_SELECT`
(`:13-35`) carries five correlated subqueries over `reimbursement_links` per row.

Frontend: `buildParams` (`Transactions.jsx:619-631`) sends `include_ids` **only when a date
filter is set**; filter changes refetch page 0; search is debounced 250 ms.

**What works.** **No SQL injection anywhere** — every dynamic fragment is a whitelisted
constant, a `?`-placeholder string built from `len()`, or a `SET` clause restricted to an
allowed key set. Verified column by column. `total`/`limit`/`offset` stay consistent even
under `include_ids`. Month grouping headers, debounced search, and the offline banner work.

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| P1 | `transactions.py:49` | `min(limit, 200)` with **no floor** — `?limit=-1` is `LIMIT -1`, which SQLite treats as unlimited (verified: returns all 1,533 rows) | The 200-row cap is trivially bypassed |
| P1 | `transactions.py:64-70` | `status` and `category_id` are an `if/elif` chain, but the UI shows both controls side by side with no interlock | **Selecting both silently applies only one.** The filter lies |
| P1 | `transactions.py:77-82` | LIKE wildcards in `q` never escaped | Searching `50%` or `_` matches everything |
| P1 | `transactions.py:96-99` | With `include_ids` and no other filter, the WHERE collapses to `WHERE id IN (...)` — a filter, not a union | The UI never hits this; a trap for the next consumer |
| P2 | `transactions.py:83-86` | **"Source" is a `notes` string prefix, not a column.** `credit` is defined as *not venmo* | Zelle, cash, and manual rows all report as "Credit Card". Three call sites (`:84`, `:434`, `categorize.py:40`) disagree about what "venmo" means |
| P2 | `transactions.py:108-109` | `amount_desc/asc` sorts the **unsigned** amount across mixed directions | A +$500 deposit outranks a −$400 charge under "Amount (high→low)" |
| P2 | `transactions.py:18-30` | Five correlated subqueries per row against an **unindexed** `reimbursement_links` | 5 full scans × 25 rows per page |
| P2 | `transactions.py:47-54` | Dead `try/except` — `request.args.get(type=int)` returns the default rather than raising | The documented 400 is unreachable; bad input is silently coerced |
| P2 | `transactions.py:73-76` | `date_to` inclusivity is string-comparison-dependent, and neither date is format-validated | Malformed dates silently return zero rows instead of a 400 |
| P2 | `Transactions.jsx:636-648` | No `AbortController` or request sequencing on debounced search | A slow earlier response overwrites a newer one |
| P2 | `Transactions.jsx:644-647` | On fetch error, `error` is set but the previous list stays rendered | A stale list sits under a red banner with working Delete/Edit buttons |
| P1 | `Transactions.jsx:580-584` vs `OwedWidget.jsx:35` | `OwedWidget` deep-links to `/transactions?q=<merchant>`, but the page only reads `category_id`, `date_from`, `date_to` | `q` is dropped; the link lands on an unfiltered list |

**Improvements.** Pagination is Prev/Next only with no total shown, on lists of 1,500+.
There is **no bulk selection** despite categorize-one-at-a-time being the most repeated
action in the app. Rows are bare `<div onClick>` (`Transactions.jsx:1016`) — no `role`,
`tabIndex`, or keyboard handler, so they cannot be opened by keyboard.

---

## 6. Transaction Create / Edit / Delete

**How it works.** Create (`:131-180`) requires `amount`, `direction`, `transaction_at`;
upgrades a bare `YYYY-MM-DD` to `T00:00:00`; calls `resolve_category_id` when no category
is supplied. Update (`:193-303`) uses a field whitelist and a well-ordered guard chain.
Delete (`:306-318`) nulls legacy `reimburses_id` back-references (`:315`), then deletes.

Money model: every transaction stores a **positive** `amount` plus a `direction`; sign is
purely presentational (`Transactions.jsx:30-34`).

**What works.** The update guard chain is genuinely well built — direction flips blocked
while links exist, negative amounts rejected, amount can't drop below what's already
applied, `expected_reimbursement` bounded and outflow-only, `reimbursement_external`
mutually exclusive with real links. All with clear 400/409 messages.

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| P0 | `transactions.py:306-318` + `db_context.py:53-54` | Deleting an outflow **silently cascades away its `reimbursement_links`**. The endpoint warns nothing; the paying inflow's money reverts to counting as income | Reimbursement history destroyed behind `confirm("Delete this transaction?")`. Note `update_transaction:222-231` *does* refuse a direction flip for exactly this reason |
| P1 | `transactions.py:137-150` | Create does **not** validate `amount >= 0` while update does (`:243-244`) | A negative amount is accepted, then its sign is ignored by the UI, producing `-$-40.00` and corrupt totals |
| P1 | `Transactions.jsx:386` | Add-form date defaults to `new Date().toISOString().slice(0,10)` — the **UTC** date | After 19:00 ET it pre-fills *tomorrow*. Silently misdated entries every evening |
| P2 | `transactions.py:243` (money type) | `amount REAL` throughout, with five different epsilons in play (`1e-6`, `0.005` ×2, `0.01` ×2) | Live data confirms floats are inexact (`9.79`, `16.33`, `36.41` all fail an exact-cents check) |
| P2 | `Transactions.jsx:683,711` | Optimistic row replacement without re-evaluating the active filter | Categorizing a row while `status=pending` leaves the now-non-matching row in the list; `total` is not adjusted |
| P2 | `Transactions.jsx:689-699` | `handleDelete` recomputes `maxPage` from a **stale** `total` and never calls `refreshUnclassifiedCount()` (every other mutation does) | The amber "Classify N" badge goes stale |
| P2 | `Transactions.jsx:214,227,714` + 4 more | **Seven empty `catch {}` blocks.** `handleAssignCategory` (`:714`) is the worst | A failed categorization looks identical to a successful one |

**Improvements.** **No undo anywhere** — delete, split, bulk-categorize and reclassify are
all irreversible behind at most a `confirm()`. The delete dialog should name what else it
will destroy (links, and the fact that a re-sync may resurrect the row).

---

## 7. Categories

**How it works.** Flat list with `sort_order` and a single `is_misc` flag. `GET`
(`categories.py:14-21`), `POST` (`:46-70`, `INSERT OR IGNORE` → 409 on duplicate), `DELETE`
(`:73-90`), `PUT /reorder` (`:93-112`), `PUT /<id>/misc` (`:24-43`, clears the flag globally
then sets one).

**What works.** **Deletion is safe** — it refuses with a 409 if any transaction still
references the category, rather than orphaning rows (`categories.py:81-85`). Single-misc is
correctly enforced.

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| P3 | `categories.py:56-60`, `db_context.py:22` | `name` is `UNIQUE` but **case-sensitive and length-unbounded** | `dining` and `Dining` coexist; a 10 KB name is accepted and breaks layout |

**Improvements.** Deletion refuses but offers **no reassign-or-merge path**, so the only
way to remove a used category is to re-categorize every row by hand first.

---

## 8. Auto-Categorization

**What it is.** New transactions inherit a category from history by merchant match. A
PFA-original feature.

**How it works.** `resolve_category_id` (`categorize.py:26`) runs on **every parsed row at
parse time**. It loads all `(merchant_raw, category_id)` groups with a non-null category,
excluding `notes LIKE 'venmo:%'` rows (person-to-person payments teach nothing), scores each
against the target (exact match > prefix match with a 5-char floor > same
`merchant_prefix()` group), and wins by `(common, count, last_transaction_at)`.
`merchant_prefix()` strips a trailing whitespace-delimited numeric suffix:
`TRADER JOES #552` → `TRADER JOES`.

**What works.** A genuinely good heuristic with a sensible minimum-overlap floor and the
right Venmo exclusion.

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| P2 | `categorize.py:34-43`, called per row from 9 sites | Full `GROUP BY` scan of `transactions` **per row**. Benchmarked at **1.51 ms/call at 1,817 rows** | ~2.3 s for a 1,500-row import today; ~25 s at 20k history, against a 120 s worker timeout. Quadratic |
| P2 | `categorize.py` (whole module) | No merchant identity across naming systems. Confirmed in prod: `AMAZON RETAIL` (CSV), `AMAZON MKTPLACE PMTS`, and `Amazon` (newer email template) never unify — they share only 6 chars and fail the prefix test | Category learning is silently fragmented; the user re-categorizes the "same" store repeatedly |

**Improvements.** Hoist the query out of the per-row loop — load the merchant→category map
once per import. ~10 lines, removes the quadratic behaviour before any bulk backfill. There
is no rule table, no user-editable mapping, and no MCC/merchant taxonomy; a brand-new
merchant always lands uncategorized.

---

## 9. Bulk Classify & Reclassify

**How it works.** `/merchants/unclassified` (`transactions.py:428-445`) feeds a
per-merchant assignment modal; `/auto-classify` (`:448-493`), `/bulk-categorize`
(`:496-513`) and `/reclassify` (`:516-536`) apply changes. All key on `merchant_prefix()` +
`LIKE 'prefix%'`.

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| P1 | `transactions.py:474,509,532` | **LIKE wildcards never escaped** in the prefix. **7 merchants in the live DB contain `%` or `_`** | Bulk-categorize can reassign a far wider set than intended — with no preview and no undo |
| P2 | `transactions.py:509` | `bulk_categorize` does **not** filter `direction='outflow'`, unlike the unclassified list that feeds it (`:434`) | Categorizing a merchant also categorizes matching inflows the user never saw in the picker |
| P2 | `transactions.py:469-487` | `auto_classify` issues one `GROUP BY` query **per merchant prefix** inside a Python loop | O(prefixes × rows) |
| P2 | `Transactions.jsx:197-199` | `loadMerchants` chains `.then().finally()` with **no `.catch`** | Unhandled rejection; the modal shows "All merchants classified" on failure — silent failure presented as success |

**Improvements.** Both endpoints return `updated: N` but the UI discards it
(`Transactions.jsx:224`; `:829` ignores the argument), so the user never learns how many
rows moved. Neither operation previews which rows will be affected — on an unescaped LIKE
prefix, that is the gap that matters most.

---

## 10. Reimbursements

**What it is.** Recording that money you spent was (or will be) paid back, so it stops
counting as your own spend.

**How it works — two intended mechanisms.**
1. **Optimistic**: `expected_reimbursement` + `reimbursement_external` on the outflow,
   excluded from budgets the moment it's set.
2. **Realized**: `reimbursement_links(inflow_id, outflow_id, amount)` — the money that
   actually arrived.

Netting SQL lives in `budget_service.py:11-20`:
`MIN(MAX(expected, received), amount)` — takes the larger of "what I expect" and "what
arrived", capped at the transaction amount. Its counterpart `_inflow_income_sql` (`:29-31`)
computes the portion of an inflow that is real income rather than an expense offset.

`POST /api/reimbursement-links` (`reimbursements.py:25-83`) validates directions, refuses
linking to an `reimbursement_external` charge, and caps at both the outflow's amount and
the inflow's unapplied remainder.

**What works — genuinely well.** The netting construction handles all four cases
(expectation only, receipt only, both, over-receipt) and **cannot produce negative spend** —
verified against a real over-linked row in prod. Over-application, over-linking, direction
flips, and amount reductions below what's applied are all correctly rejected. On prod
data, netting changes the headline numbers by more than 2×: August outflow $2,933 gross →
**$1,415 netted**.

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| **P0 (structural)** | `db_context.py:37-40` vs `:51-57` | **Three coexisting reimbursement models**: `reimburses_id` (legacy), the `reimbursement_status/_mode/_value` triplet (legacy), and `reimbursement_links` (current) — plus `expected_reimbursement` as an optimistic overlay. `_migrate_reimbursements` (`:173-214`) backfills legacy into the new table but **never clears it**. On prod: **119 links, 73 legacy `reimburses_id` rows, all 73 double-represented** | Two delete paths disagree about which model to clean up — that is §11's P0. The backfill guard is `links_exist == 0` (`:179`), so a user who creates a link before their first migration touch **loses the legacy data permanently** |
| P3 | `Transactions.jsx:1089,1164,1174` | **"Net cost" is signed backwards.** `net = reimbursed_by_total - amount`, rendered `+` when `net >= 0`. A $100 charge fully reimbursed shows **"Net +$0.00"**; $100 with $30 back shows **"Net −$70.00" in red** when $70 *is* the net cost. The green/red mapping is inverted relative to the label | The most-glanced-at reimbursement number reads as the opposite of what it says |

**Improvements.** Retire the legacy columns with a real, one-shot, `user_version`-gated
migration that backfills **and clears**, then drop them. Until then every new delete path
must remember `transactions.py:315` — `split_transaction` already forgot. Move
`_excluded_sql` out of `services/budget_service.py`: a route module importing SQL from a
service (`transactions.py:8`) means budget-exclusion semantics can't change without
touching the transaction list.

---

## 11. Split Transactions

**How it works.** `POST /api/transactions/<id>/split` (`transactions.py:321-425`) validates
≥2 parts, each > 0, and `abs(sum - original) <= 0.01`. It refuses if the parent has an
`expected_reimbursement` or any link. Then it **deletes the parent** (`:381`) and inserts N
new rows. Part 0 inherits the parent's `source_hash` so a re-sync still dedupes; parts 1..n
get `<hash>:split<i>` — a clever, well-commented trick.

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| **P0** | `transactions.py:381` (vs `:315`) | Split deletes the parent **without nulling legacy `reimburses_id` back-references** — the exact cleanup `delete_transaction` does. With `PRAGMA foreign_keys=ON` and no `ON DELETE` on that self-FK, this raises `IntegrityError`. **73 prod rows are exposed** | Splitting a legacy-reimbursed charge **500s** — and the user sees `Unexpected token '<'` |
| P2 | `transactions.py:381-417` | Split destroys the parent's identity; new rows get new ids | Any pin pointing at the parent becomes a dangling id, silently sent as `include_ids` forever. Nothing prunes it |
| P2 | `transactions.py:359` | Tolerance is `0.01`, so up to a full cent can vanish or be conjured per split | Parts don't provably sum to the parent; drift accumulates |
| P2 | `transactions.py:356` | Parts inherit the parent's `notes` when blank — including `venmo:payment:<person>` | Split parts are misfiled by source |

**Improvements.** Add a real `split_parent_id` / lineage instead of deleting the parent.
That makes splits reversible and auditable, fixes dangling pins, and removes the need for
the `source_hash` trick. `SplitModal.jsx:64-67` never warns that the original is destroyed.

---

## 12. Duplicate Detection

**How it works.** `GET /api/transactions/duplicates` (`transactions.py:567-596`)
self-joins on an exact 4-tuple — `(transaction_at, amount, merchant_raw, direction)` —
with `HAVING COUNT(*) > 1`. `DuplicatesModal.jsx` renders the groups with per-row Delete
and a **"Keep first, delete rest"** sweep (`:41-46`).

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| **P0** | `DuplicatesModal.jsx:41-46` + `transactions.py:572-588` | The heuristic has **heavy false positives** and no `source_hash` awareness. Live data: **7× `MTA*NYCT PAYGO` $2.90 on 2025-01-25** (ids 6140-6146), 6× on 2025-02-01, 5× on 2025-08-10 — legitimate separate subway swipes. **125 such groups exist in prod** | One click deletes six real transactions. Unconfirmed, irreversible, no undo, no backup |

**Root cause.** The duplicate storms this feature exists to clean up are largely
self-inflicted: `import_service.py:14` folds `row_num` into the dedup hash (§22), so a
re-exported CSV re-imports wholesale.

**Improvements.** The modal shows no `source_hash`, no `created_at`, and no import
provenance — precisely the discriminators a user would need to tell a real duplicate from
two real subway swipes. Fix the hash first, then make the sweep opt-in per group with the
provenance visible.

---

## 13. Pinned Transactions

**What it is.** Force specific transactions to count in all metrics regardless of the
active date filter.

**How it works.** Purely client-side, `localStorage["pinned_txn_ids"]`, sent to the server
as `include_ids`, which becomes `OR id IN (...)` — a **union**, so pinning an in-range
transaction does not double-count it. Two independent implementations exist:
`Transactions.jsx:605-615` (hand-rolled) and `hooks/useDashboardFilters.js:6`.

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| P0 | `dashboard.py:104-107` vs `:123-146` | `/trend` includes pins in the SQL but the densification loop only emits buckets inside `[start,end]` | **Pinned spend silently vanishes from the chart** while still counting in the tiles |
| P0 | `dashboard.py:253-254` | `/comparison` gives pins to `current` but not `previous` | A pin dated in the previous window is counted in `previous` naturally **and** in `current` via the pin — double-counted |
| P1 | `budget_service.py:103` | The yearly-period branch omits the pinned clause the monthly branch has (`:101`) | Pins affect monthly categories but not yearly ones |
| P1 | `useDashboardFilters.js:68-74` | `pinnedIds` is `JSON.parse`d with a `try/catch` but **no shape validation** (unlike the widgets hook). `JSON.parse('{"a":1}')` yields a non-array | `.join(",")` → **TypeError → the whole app white-screens**. There is no error boundary in `App.jsx` |
| P2 | `dashboard.py:13-19` | `_parse_include_ids` returns `[]` on any `ValueError`, and has no length cap | `include_ids=1,abc,3` silently discards **all** pins; a 10k-id list becomes a 10k-placeholder `IN` |
| P2 | `dashboard.py:187-194` | The merchant drill-down subquery drops `include_ids` | The sheet never sums to the row that opened it |

**Improvements.** Adopt the existing hook in `Transactions.jsx` rather than the hand-rolled
copy (which includes a raw `localStorage.setItem` bypassing the setter). The affordance is
opaque: the pill reads `+3 pinned` and `PinPickerModal.jsx:60` says "pinned outside range"
even for in-range pins, and no widget indicates that pinned data is folded in — least of
all the trend chart, where it silently is not.

---

# Dashboard

## 14. Dashboard Totals & Stat Tiles

**How it works.** `GET /api/dashboard` (`dashboard.py:62-69` → `budget_service.py:37-142`)
returns `{total_spent, total_income, net, pending_count, by_category[], flex_pool}`.
`total_spent` sums netted outflows; `total_income` sums netted inflows; `net = income −
spent`. Default range is month-to-date, server-local.

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| **P0** | `budget_service.py:62` vs `:92-96` | `total_spent` does **not** subtract inflows; `by_category[].spent` **does** | Two definitions of "spent" in one response object. Irreconcilable by construction — a refund shrinks the bar but not the total |
| P1 | `budget_service.py:85-107` | Uncategorised outflows never appear in `by_category` | They're in `total_spent` but not in the donut — another tile-vs-chart divergence |
| P2 | `Dashboard.jsx:16-22` | `maximumFractionDigits: 0`, and `fmtCurrency` is redefined here instead of imported from `format.js` | A visibly-summing list never adds up; `MerchantInsights` uses 2 digits while `ComparisonCard` uses 0 — inconsistent within one screen |
| P2 | `Dashboard.jsx:190-192` | The subtitle always prints `new Date()`'s month | Select "Last Month" and the page still says "September 2026" |

---

## 15. Category Donut & Breakdown

**How it works.** `by_category[]` comes from `categories LEFT JOIN budgets LEFT JOIN
transactions`. The join window is **period-dependent**: `monthly` uses the requested range;
`yearly` uses `[<end.year>-01-01, <end.year>-12-31]` (`budget_service.py:81-83,103`).

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| **P0** | `budget_service.py:100-104` + `CategoryDonut.jsx:27,106` | Yearly-period categories join the **whole calendar year** but render in a month-scoped donut whose centre label literally reads **"Total Spent"** | **Measured on prod for Aug 2026: donut $5,911 vs Money Out tile $1,416** — 4.2×. The leak is Travel ($3,747 YTD) and Housing ($1,027 YTD) |
| P2 | `CategoryDonut.jsx:80-87` | `outerRadius` passed to `<Cell>`, which forwards presentation attributes, not geometry | The "pop out selected slice" affordance is almost certainly a no-op *(SUSPECTED — Recharts 3.8.1, not executed)* |
| P2 | `CategoryDonut.jsx:75-77` | `onClick={(entry) => entry.category_id}` relies on Recharts spreading the datum; 3.x has been moving toward `{payload: {...}}` | If wrapped, every click deselects *(SUSPECTED — worth a manual click-test)* |
| P2 | `CategoryDonut.jsx:29-56` | Empty state renders a **fake full-circle slice** coloured `#22263A` | Reads as a real grey category |

**What works.** Over-budget affordances are good: `barColor` thresholds at 0.75/1.0,
`"X over"` vs `"X left"`, red amount when over, bars clamped at 100%. The category
drill-down correctly passes Jan 1–Dec 31 for yearly categories.

**Improvements.** The donut and the breakdown list are redundant *and* disagree, yet are
separate widgets in the config panel — a user can enable the chart without its key. The
donut has no slice labels, no legend, and no tooltip; the only way to learn what a slice is
is to click it. Bars clamp at 100%, so 101% and 400% look identical.

---

## 16. Spending Trend Chart

**How it works.** `GET /api/dashboard/trend` (`dashboard.py:72-148`) auto-picks
granularity from the span (`≤60d` daily, `≤180d` weekly, else monthly), runs one aggregate
query, then **densifies** — walking the calendar and emitting a zero row for every empty
bucket so the chart has no gaps.

**What works.** The densification loop handles month-length and leap-year rollovers
explicitly, and Python's `%W` was verified to agree with SQLite's across year boundaries
(`2026-01-01 → 2026-00`, `2024-12-30 → 2024-53`).

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| P0 | `dashboard.py:104-146` | Pinned spend vanishes (see §13) | Chart total ≠ tile total whenever pins are used |
| P1 | `SpendingTrendChart.jsx:88` | `Math.round(v/1000) > 0 ? '${k}k' : v` — `Math.round(600/1000) = 1` | **$600 renders as "$1k".** Everything from $500 up is bucketed to the nearest thousand |
| P1 | `SpendingTrendChart.jsx:10-17,69` | `fmtLabel` always formats `{month, day}`, but monthly buckets carry `2026-08-01` and weekly buckets carry a Monday | The 6-month chart labels monthly points "Aug 1", implying a single day |
| P2 | `SpendingTrendChart.jsx:60-66` | `error \|\| !data?.length` collapses "request failed" and "no transactions" into "Trend data unavailable" | A legitimately empty month is reported as a broken feature |

**Improvements.** The backend supports `?granularity=` and **nothing ever sends it**
(`api.js:46-49`). There is no legend — two unlabelled lines where colour is the only
encoding distinguishing spend from income.

---

## 17. Merchant Insights

**How it works.** `GET /api/dashboard/merchants` (`dashboard.py:151-230`) returns top 8
merchants by netted spend, a per-merchant drill-down, the largest transaction, and repeat
merchants.

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| P1 | `dashboard.py:215-224` | `repeat_merchants` requires `COUNT(DISTINCT month) > 1` **within the selected range** — but the default range is a single month | The "RECURRING" section is **structurally impossible** to populate on the default view. Verified: 0 rows for Aug 2026 |
| P1 | `dashboard.py:187-194` | Drill-down drops `include_ids` **and** returns gross amounts | The sheet doesn't sum to the row that opened it (prod: Ticketmaster row $197 net, sheet shows one $450 txn) |
| P1 | `dashboard.py:175` | `AVG(t.amount)` is gross while the sibling `net_spent` is netted — and it is **never rendered** | Dead payload that will mislead the next integrator |
| P2 | `dashboard.py:187-194` | N+1: up to 8 extra queries per call, against unindexed `merchant_raw` | Fine at 1.8k rows; won't scale |

---

## 18. Period Comparison

**How it works.** `GET /api/dashboard/comparison` (`dashboard.py:233-322`) computes a
previous period, two `_period_totals` calls, deltas, a biggest-change category, and a
month-end velocity projection.

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| **P0** | `dashboard.py:246-248` | When `start.day == 1`, "previous" is the **entire preceding calendar month** while "current" is month-**to-date**. On the 3rd you compare 3 days against 31 | **Every delta badge is wildly negative for the first ~3 weeks of every month.** `biggest_change_category` is noise |
| **P0** | `dashboard.py:246-248` with `this_year` | Jan 1 → `start.day == 1` → previous period is **December alone**. YTD (8 months) vs one month | The card is meaningless on This Year |
| P0 | `dashboard.py:253-254` | Pins given to `current` only (see §13) | Double-counting in both directions |
| P1 | `ComparisonCard.jsx:16-23` | `prevPeriodLabel` unconditionally subtracts one month, but the backend uses a span-shifted window when `start.day != 1` | For 3 Months / 6 Months / most custom ranges, the column header **names a period that is not the one in the column** |
| P1 | `dashboard.py:302,307` | `days_elapsed = max((today - start).days, 1)` is off by one | Projection over-estimated ~4.5% mid-month, and by 100% on the 1st |
| P2 | `dashboard.py:43-51` | `top_category` computed twice per request via a full join — and **never rendered** | Two wasted table scans per request |
| P2 | `ComparisonCard.jsx:26-30` | `isUp = pct > 0`, so `pct === 0` renders `↓ 0%` in green | Cosmetic wrongness on flat months |

**Improvements.** `/comparison` should **echo the window it actually used** rather than
making the client guess — that guess is currently wrong for 4 of 6 ranges. `velocity`
appears and disappears with no explanation (it requires `end >= today AND range_days < 60
AND start.day == 1`).

---

## 19. Budgets & Flex Pool

**How it works.** Per-category budgets with `monthly` or `yearly` periods. Monthly budgets
scale by `month_count = max(1, round(days_in_range / 30.44))`. Categories flagged
`fold_into_misc` pool their entire spend into a shared **flex pool**
(`budget_service.py:123-133`), rendered as a two-segment stacked bar.

**What works.** The flex pool is a genuinely nice feature and
`BudgetByCategoryWidget.jsx:56-87` renders it coherently, with a fixed/flex legend.

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| P1 | `budget_service.py:79,111` | Proration uses a **rounded** month count — 45 days → 1, 46 days → 2, with banker's rounding at the boundary | Budget targets jump discontinuously as a custom range is dragged. For `this_year` on Aug 23, budgets scale by 8 while only 7.7 months of spend exist → every category looks under budget |
| P2 | `profile.py:71-74` | Budget update is `UPDATE ... WHERE category_id = ?` with **no upsert and no rowcount check** | A category with no `budgets` row can never get a budget — and the request still returns 200 |
| P2 | `profile.py:60-76` | Budgets written in a loop; a validation failure on entry N returns 400 *after* 0..N-1 executed, with no rollback | Partial writes on invalid payloads *(SUSPECTED — saved only if the connection isn't autocommit)* |
| P2 | `profile.py:49-50` | `scalar_fields = set()` — the entire scalar-update path is dead code | `updates` is always empty; the branch can never execute |

**Improvements.** Budgets are configured on `/profile`, but `CategoryBreakdown` rows
navigate to `/transactions` — an over-budget bar isn't clickable to the thing that fixes it.

---

## 20. Owed / Outstanding

**How it works.** `GET /api/transactions/owed` (`reimbursements.py:151-184`) lists outflows
where `expected_reimbursement − received > $0.005`.

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| P2 | `OwedWidget.jsx:15-17` | `api.getOwed()` takes **no params** — the widget is all-time | It sits inside a date-filtered dashboard showing all-time data with no label saying so |
| P1 | `OwedWidget.jsx:19` | `!data \|\| data.items.length === 0` dereferences `.items` unchecked | Partial response → TypeError → white screen |
| P1 | `OwedWidget.jsx:35` | Deep-links to `/transactions?q=…`, which the page ignores (see §5) | The link does nothing useful |

---

## 21. Dashboard Widget Customization

**How it works.** `useDashboardWidgets.js` — six widgets, `{order, hidden}` persisted to
`localStorage` under the **versioned** key `dashboard_widgets_v1`.

**What works — this is the best state code in the frontend.** `load()` (`:17-30`) filters
stored keys against `VALID_KEYS`, then **appends any new default key not present**, so
adding a widget auto-appears for existing users. The whole thing is `try/catch`-wrapped
with a default fallback. **Copy this pattern** — `useDashboardFilters.js` does none of it,
which is why `pinnedIds` is a live white-screen vector (§13).

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| P1 | `useDashboardWidgets.js:33` + `useDashboardFilters.js:77,82,87,94,100` | Every `localStorage.setItem` is unguarded | Throws in Safari Private Browsing, taking down the click handler |

**Improvements.** Not discoverable (a "Widgets" ghost button); reorder is ▲/▼ only, no
drag, no reset-to-default, and hiding all six leaves a blank page with no explanation.

---

## Cross-cutting: dashboard performance

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| P2 | `Dashboard.jsx:111-113` | `allParams` is an **object literal rebuilt every render**, used as the sole `useEffect` dep in three children — discarding the memoisation `dateParams` already has | **Refetch storm**: ~9–12 requests on mount instead of 3. Clicking a donut slice re-fires all three network calls. **Fixed by one `useMemo`** |
| P2 | `Dashboard.jsx:123-128` | `handleSynced` is `useCallback(..., [])` but closes over `allParams` | After a background sync the dashboard reloads using the range active at **first mount** |
| P2 | `useDashboardFilters.js:28-31` vs `dashboard.py:76,155,239` | **Three clocks**: browser-local range boundaries, server `date.today()` defaults, and naive stored `transaction_at` | A user in UTC+13 near midnight gets a `velocity` block computed against a different "today" than the range it describes |

---

# Ingestion

## 22. CSV Import

**How it works.** `POST /api/import/transactions`, multipart, `source_type` ∈
`capitalone | venmo | amex`, `file` repeatable. Files are read fully into memory, decoded
`utf-8-sig` then `latin-1`, parsed with `csv.DictReader`, accumulated, then inserted in one
loop with a single commit. Dedup is `INSERT OR IGNORE` on
`sha256(provider|date|amount|merchant|row_num)`.

Per-source specs as actually implemented:

| Source | Date | Amount | Merchant | Skips | Dedup key |
|---|---|---|---|---|---|
| Capital One (`import_service.py:22-64`) | `Transaction Date`, strict `%Y-%m-%d` | `Debit`/`Credit`, raw `float()` | `Description` | `AUTOPAY PYMT`, `MOBILE PYMT` | row_num |
| Amex (`:67-108`) | `Date`, strict `%m/%d/%Y` | `Amount`; **positive = outflow** | `Description` | `AUTOPAY PAYMENT` | **`Reference`** ✅ |
| Venmo (`:111-173`) | `Datetime`, stored **verbatim** | `Amount (total)`, must start `+`/`-` | **`Note`** (the memo) | non-`Payment`/`Charge` types | row_num |

Venmo also builds `notes = "venmo:{payment|charge}:{person}"` — a load-bearing string that
`categorize.py:40` and the source filter both key off.

**What works.** 1,220 rows in one batch, correctly signed and dated. BOM/UTF-8 handled
(European merchant names survived intact). Per-row `try/except` in all three parsers means
one bad row can't abort an import. Multi-file upload aggregates correctly. **Amex is the
one source that got dedup right.**

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| **P0** | `import_service.py:14` | **`row_num` is inside the dedup hash** for Capital One and Venmo | Re-exporting with a different date window shifts every index ⇒ every hash changes ⇒ **the entire file re-imports**. Venmo's stable `" ID"` is read at line 120 and thrown away. This is the origin of prod's 125 duplicate groups |
| **P0** | `import_service.py:114-115` | `next(stream); next(stream)` **unguarded and outside the per-row `try`** | Picking "Venmo" for a Capital One file → `StopIteration` escapes the route → **HTTP 500**. Matches three unexplained import 500s in `logs/app.log.2` at 15:52-15:53 on 2026-06-09 |
| **P0** | `email_parser.py:69-71` vs `import_service.py:11-15` | The CSV and email paths use **entirely disjoint hash schemes** | One purchase seen as both an alert email (`Amazon`) and a statement row (`AMAZON RETAIL`) becomes two rows, with no cross-path dedup possible |
| P1 | `Import.jsx:113-115` | `errors.map(e => <div>{e}</div>)` where entries are **objects** | React throws "Objects are not valid as a React child" — **the page white-screens exactly when a row fails** |
| P1 | `import_route.py:27-37` | No server-side file-type validation; `accept=".csv"` is advisory | An `.xlsx`/`.pdf` decodes as latin-1 (which never raises) and feeds binary noise to `DictReader` |
| P1 | `app.py:38` | `MAX_CONTENT_LENGTH = 10MB` with **no 413 handler** | Oversized upload → HTML 413 → `SyntaxError: Unexpected token '<'` |
| P2 | `import_service.py:144` | Venmo `Datetime` stored **verbatim** — Venmo exports UTC without an offset marker. 288 such rows in the dev DB | Evening ET transactions land on the **next calendar day** |
| P2 | `import_service.py:36,38,82` | `float()` is raw — no `$`, thousands separator, or `(1,234.56)` accounting-negative handling | Any format drift turns every row into an error |
| P2 | `import_service.py:28,73` | Headers exact and case-sensitive; a missing column yields `""`, not an error | Uploading the Capital One **checking** export produces N identical "No value in Debit or Credit" errors instead of "wrong file" |
| P2 | `import_route.py:38-46` | The encoding fallback is dead — `latin-1` **never** raises | UTF-16 or binary is silently mojibaked rather than rejected |

**Improvements.** No preview/dry-run — `Import.jsx:24` posts straight to the write
endpoint, and there is no undo. No batch identity, so a mis-picked `source_type` producing
1,200 junk rows has no bulk remedy. `duplicates_skipped` is a bare count with no way to see
which rows were skipped — and given the hash bug, a "0 duplicates" result on a re-export is
actively misleading.

---

## 23. Gmail Sync

**How it works.** `email_parser.py:355` connects `IMAP4_SSL("imap.gmail.com", 993)`, selects
INBOX, and runs **five searches** each ANDed with `UNSEEN`. Per message it fetches, parses,
and on success appends and marks `\Seen`. `sync_service.py:20` decrypts the password, calls
`fetch_emails` **holding an open SQLite connection for the entire IMAP session**, inserts
with `INSERT OR IGNORE`, and stamps `last_synced_at`. `scheduled_sync_all` iterates users
**serially**, skipping those with no `gmail_address`.

**What works — genuinely, in production.** `prod_db.db` shows nightly insert batches at
07:00Z (03:00 EDT) continuously through 2026-08-23. All five parser branches have produced
real rows: 343 Venmo, 20 Zelle, 7 Capital One refunds, plus hundreds of charge alerts.
**Zero rows anywhere carry a fallback merchant** (`Unknown Merchant` / `Venmo` / `Zelle`),
so every regex currently matches the live templates. Message-ID-keyed hashes make re-syncing
the same message safe.

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| **P0** | `email_parser.py:379` | `mail.fetch(num, "(RFC822)")` — **not `BODY.PEEK[]`**. Per RFC 3501, `RFC822` implicitly sets `\Seen`. Every fetched email is marked read **whether or not it parsed**, and the search filter is `UNSEEN`. A parse failure *is* captured in that run's `errors` list (message_id/reason/subject) — but the nightly scheduled sync only logs a **count** of parse errors, never the detail, and manual sync's error list is returned to the frontend but dropped by `Profile.jsx` | An email whose template drifted parses to `None`, is marked read, and is **never fetched again**. "Failures retry next run" is false. Effectively unrecoverable — briefly counted, never durably recorded with enough detail to find or retry the specific email. The explicit `store` at `:396` is redundant |
| **P0** | `email_parser.py:157,206,208,318` | Every date-extraction failure **silently defaults to `datetime.now()`** | A template change files the transaction under today with no error, no flag, no log line. Corrupts every month-boundary report |
| P1 | `email_parser.py:358` | `IMAP4_SSL` with **no `timeout=`** | Default socket timeout is `None`. Manual sync burns a worker until gunicorn's 120 s kill; the **scheduled** run has no backstop and can wedge `scheduled_sync_all` for every later user |
| P1 | `email_parser.py:371-377` | **Unbounded fetch** — no `SINCE`, no slice, no per-run cap | The recommended dedicated-account flow guarantees a large unread backlog on first run — exactly the case that will hang the request |
| P1 | `sync_routes.py:72` | Manual sync is **fully synchronous** inside the request, with 2 workers — and `usePwaSync.js:27` fires one on **every app open** | Two concurrent syncs consume the entire pool. Trivially self-inflicted |
| P1 | `sync_service.py:98-100` | Scheduled failures are `logger.error` **only** — no table, no flag, no notification | If the app password is revoked, the nightly sync fails silently forever. The only clue is a stale `last_synced_at`, shown as a passive timestamp |
| P1 | `db_context.py:59-66` | **No sync-history / audit table**; `last_synced_at` is one overwritten timestamp | No answer to "what did last night's sync do?" or "where did this row come from?" |
| P1 | `db_context.py:27-43` | **No `source` / `provider` / `external_id` column** on `transactions` | Source is inferred from `notes LIKE 'venmo:%'`. Cannot filter by account, reconcile, dedup across paths, or add a second card. **Hard blocker for Plaid** |
| P1 | `sync_routes.py:69`, `import_route.py:20` | **No rate limit** on either endpoint; no backoff, no circuit breaker | Repeated failed logins can get the app password blocked by Google |
| P2 | `sync_service.py:21-35` | The SQLite connection is opened **before** and held **across** the entire IMAP session | Plausible `database is locked` source under concurrency |
| P2 | `email_parser.py:372` | `mail.search(...)` status is discarded; `msg_nums[0]` indexed blindly | A `NO`/`BAD` response → `AttributeError` → aborts **all remaining searches** for that user |
| P2 | `email_parser.py:382` | Message-ID falls back to the **IMAP sequence number**, which is per-session and mutable | A message without a Message-ID gets a hash that changes between runs → silent duplicates |
| P3 | `sync_service.py:71` | `str(exc).strip("b'\"")` — `strip` takes a *character set*, not a prefix | Chews leading/trailing `b`, `'`, `"` off real error text |

**Improvements.** The user is **never told a background sync failed**: `sync_status`
returns only `credentials_configured` and `last_synced_at` — no `last_error`, no
`last_error_at`. Parse errors are returned by `sync_service.py:67` and then discarded by
both callers. Given the mark-as-read bug, those dropped emails are *gone* and nobody is
told which. `Sync Now` offers no progress and no cancel for an operation that can take
minutes.

---

## 24. Email Parsers

Five branches, all currently working against live templates, all brittle in a specific way.

| # | Source | Gate | How it extracts | Fragility |
|---|---|---|---|---|
| 1 | Cap One charge (`:160`) | Subject `transaction\|purchase\|charge\|alert` | First `$N,NNN.NN`; merchant via two regexes | Falls back to literal `"Unknown Merchant"` |
| 2 | Cap One credit (`:186`) | Body contains `credit has posted` etc. | `_CREDIT_MERCHANT` = an all-caps line **followed by a literal newline** and `Card...` | **P2** (`:38`): survives only because `_get_text` prefers `text/plain`. If Cap One drops the plain-text part, `get_text(separator=" ")` produces no newlines and every refund gets the raw Subject as its merchant |
| 3 | Zelle (`:308`) | `zelle` in Subject | Uses the `Date:` **header** — the only parser that does | Outgoing branch captures the memo at group 1 and **throws it away**, using the recipient. If the memo line is absent the whole regex fails |
| 4 | Venmo (`:221`) | Subject `paid\|charged\|payment` | Memo scraped from `class_="transaction-note"` — **one hard-coded CSS class** | **P1** (`:108`): any template change degrades `merchant_raw` to the literal `"Venmo"` — and for Venmo the memo *is* the row's entire descriptive content |
| 5 | Amex (`:279`) | Subject `large purchase` | **Primary extraction is by inline CSS colour** — `color:#006fcf` + bold ⇒ merchant, `color:#333333` + bold ⇒ amount | **P1** (`:114-132`): a brand-refresh CSS tweak breaks it. The plain-text `_AMEX_TXN` fallback is only consulted when the **amount** is None, so a merchant-only break silently yields `"Unknown Merchant"` at full confidence |

Search #4 has **no subject filter** (`:367`), unlike every other search — so every Venmo
promo and security alert is fetched, marked read (see §23 P0), and fails the gate.

**Not covered.** No Chase, BofA, Discover, Citi, PayPal, Apple Card, Cash App, ACH/direct
deposit, or any Capital One **checking/savings** notification. Only the Amex "Large Purchase
Approved" alert — normal Amex charges are not ingested by email at all.

**Data-quality observations from prod.** Merchants arrive truncated at ~17-18 chars by
Capital One's own alert field (`LOS TACOS NO. 1 -`, `THE HANDPULLED NOO`, `ANTICO VINAIO -
8T`). And **two merchant naming systems coexist in one column** — `AMAZON RETAIL` /
`AMAZON MKTPLACE PMTS` from CSV alongside `Amazon`, `Chipotle`, `Apple`, `MTA Transit - NYC`
from a newer title-cased Cap One template. See §8 for why that fragments categorization.

---

## 25. Gmail Credentials

**How it works.** `PUT /api/profile/gmail` performs a **live IMAP login probe**
(`sync_routes.py:24-31`) before Fernet-encrypting the app password into
`profile.gmail_app_password_enc`. `config.py:15-17` hard-fails at import if
`ENCRYPTION_KEY` is missing.

**What works.** Validating the credential with a real login before storing it is a
genuinely good design touch.

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| P1 | `encryption_service.py:6-10` | **No key versioning, no `kid` prefix, no re-encryption path, no rotation tooling** | Rotating `ENCRYPTION_KEY` silently bricks every stored password. Recovery requires every user to re-enter theirs, with nothing prompting them |
| P3 | `encryption_service.py:6` | `get_fernet()` rebuilds the Fernet on **every call** | Trivial waste |
| P3 | `sync_routes.py:44-53` | `DELETE /api/profile/gmail` has **no frontend caller** | Dead code — users cannot disconnect Gmail from the UI |

**Improvements.** `GmailSetup.jsx:74-78` is out of date: it lists Cap One transactions, Cap
One credits, and Venmo. **Amex and Zelle are implemented and working in production** (20
Zelle rows) but undocumented, so a user who'd benefit never turns those alerts on. And
`GmailSetup.jsx:93-98` describes the wrong mechanism — "once an email is processed it is
marked as read so it is not imported twice" — when dedup is by Message-ID hash and *every*
fetched email is marked read, failures included. Wrong in both directions.

---

## 26. Scheduler

**How it works.** Two independent wirings of the same 03:00 cron:

| | `app.py:111-115` | `gunicorn.conf.py:18-23` |
|---|---|---|
| Gate | `RUN_SCHEDULER=true` | always, in `on_starting` (arbiter only) |
| `daemon` | `False` | `True` |
| `misfire_grace_time` | none | `300` |

Production sets `RUN_SCHEDULER=false`, so only the gunicorn hook runs — and it demonstrably
works (nightly batches through 2026-08-23). `on_starting` runs in the arbiter before any
fork, and forked children don't inherit non-forking threads, so workers genuinely don't
run it.

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| P2 | `app.py:111-115` + `gunicorn.conf.py:18-23` | Duplicated wiring with **divergent** settings. Confirmed double-start in dev: two `Scheduler started` per boot (`logs/app.log:208-220`) | Correct today **only** because of one env var. Set `RUN_SCHEDULER=true` alongside `preload_app=True` and you get concurrent syncs racing on the same SQLite files |
| P2 | `app.py:113`, `gunicorn.conf.py:21` | Cron has **no `timezone=`** ⇒ APScheduler uses `tzlocal` | Silently shifts an hour at every DST transition |
| Low | `gunicorn.conf.py:18-23` | `on_starting` re-runs on arbiter re-exec (`SIGHUP` / `systemctl reload`), losing the old handle | Duplicate 3 AM sync *(SUSPECTED — docs only ever use `restart`)* |
| Low | `gunicorn.conf.py:20-22` | The scheduler and its IMAP fetch run **inside the gunicorn arbiter** | The supervisor process does application work; a long fetch delays worker supervision |

**Log evidence.** The **only ERROR in ~16k log lines** is `logs/app.log.2:573` — the 03:00
job dropped with `RuntimeError: cannot schedule new futures after interpreter shutdown`,
caused by `app.py:112`'s `daemon=False` plus atexit ordering. Nobody was told. Separately,
`scheduled_sync_all`'s own logging (`sync_service.py:98-108`) **never fired once** in any
captured log.

**Improvements.** Delete one wiring (keep the gunicorn hook), pin an explicit `timezone=`,
keep `misfire_grace_time`. Better still, move it to its own `finance-sync.service` +
`.timer` — that removes application work from the supervisor, kills the SIGHUP duplication
risk, and gives you `journalctl -u finance-sync` for free.

---

# Platform

## 27. Profile Page

Category budgets, Gmail credentials, and account settings. Works.

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| P2 | `Profile.jsx:192` | Optimistically sets `gmail_configured: true` after saving | No "test connection" button, and no display of *which* address is connected versus what's typed |
| P2 | `Profile.jsx:406-409` | `last_synced_at` printed with no staleness styling | A sync broken for three weeks looks identical to one that ran last night |
| P3 | `Profile.jsx:468-537` | Username and email are **read-only**; the only mutation path is an admin endpoint | No self-service account edit, and no account deletion |

---

## 28. PWA, Offline & Install

**Verdict: this is not a PWA.** It is a mobile-styled SPA with an "Add to Home Screen"
poster and an online/offline banner.

Evidence: **zero hits** for `manifest`, `serviceWorker`, `workbox`, or `sw.js` anywhere in
the frontend. No `<link rel="manifest">`, no `apple-mobile-web-app-capable`, no
`apple-touch-icon`, no `vite-plugin-pwa`, no PWA dependency in `package.json`.

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| P2 | `frontend/index.html:1-17` + `InstallPrompt.jsx:13-18` | The component instructs iOS users through "Share → Add to Home Screen", but without a manifest or `apple-mobile-web-app-capable` the result **launches in a normal Safari tab**, not standalone. So `isStandalone()` can **never return true** | The prompt reappears forever until dismissed, and its instructions don't produce the promised result. There's no `beforeinstallprompt` handling either, so Android/Chrome — the platform that actually supports programmatic install — gets nothing |
| P2 | `Dashboard.jsx:184` | Banner reads `📴 Offline — showing cached data` | **There is no cache and no service worker.** Offline, all four fetches fail and the widgets vanish |
| P3 | `usePwaSync.js:6-31` | Not a PWA feature — a `visibilitychange` listener that would behave identically in a normal tab. No `isOnline` guard, and no in-flight guard | Offline resumes fire a doomed sync; two rapid tab switches can double-fire |
| Low | `frontend/public/icons.svg` | A **5 KB Vite-template sprite of Bluesky/Discord/GitHub/X icons**, referenced by nothing, copied into `dist/` and served publicly | Dead asset shipped to production |

**Improvements.** Commit or delete. Half-built is the worst of the three options. If
committing, do cache headers (§31) first — a service worker plus the current no-cache setup
interacts badly.

---

## 29. Platform: Data Layer

**How it works.** One `master.db` (`users` only) plus one `data/user_<id>_finance.db` per
user, holding `categories`, `transactions`, `reimbursement_links`, `profile`, `budgets`.
`get_user_db` (`db_context.py:217-227`) caches one connection per request on Flask's `g`,
closed at teardown. `init_user_db` is genuinely idempotent and seeds 9 default categories,
a `profile` row, and zeroed budgets.

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| P1 | `db_context.py:225` | **`_migrate()` runs on every `get_user_db()`** — i.e. every authenticated request. Nine `ALTER TABLE`s that fail-and-`pass` forever, an unconditional full-table `UPDATE` (`:140`), a `CREATE TABLE IF NOT EXISTS`, the reimbursement backfill scan, and ~5 more SELECTs. **No `user_version` gate — all six live DBs report `PRAGMA user_version = 0`** | ~14 wasted statements and a write transaction on every read path, on a Raspberry Pi |
| P1 | `db_context.py:88,93,100,106,112,118,124,130,136,142` | **Ten bare `except Exception: pass`** in the migration path | Disk-full, locked DB, and a genuinely broken migration are indistinguishable from "column already exists" |
| Med | `db_context.py:218` | The `g` cache key is the constant `"user_db"`, **not the user id** | Latent cross-user leak the moment any request touches two users' DBs. All 38 call sites pass `g.current_user` today, so latent, not live |
| Med | `models/user.py:33,44,56,…` (10 sites) | `with sqlite3.connect(...)` commits but **does not close** | Ten functions leak a connection per call until GC |
| Low | repo-wide | **No `CREATE INDEX` anywhere** — only implicit UNIQUE/PK indexes | Every dashboard filter on `transaction_at`/`direction`/`category_id` is a full scan |
| Low | repo-wide | **No `.rollback()` anywhere** | Mid-transaction failures are discarded only by accident (teardown closing the conn), not by design |
| Low | `db_context.py:79-80` | `get_db_path` returns a **relative** path | Running from another CWD silently creates a fresh empty DB rather than failing |
| Low | `db_context.py:51-57` vs `:145-153` | `reimbursement_links` DDL defined **twice** | Two sources of truth; they agree today, nothing enforces it |

**Schema drift is real.** `data/user_1_finance.db` and `user_2_finance.db` are still on the
pre-reimbursement schema — no `reimbursement_links` table at all. Migrations run lazily on
connection open, so any tooling that opens these files directly will fail on the dashboard
SQL. **Do not assume the on-disk schema is current.**

**Improvements.** Gate `_migrate()` behind `PRAGMA user_version` — that alone removes ~14
statements from every request and gives you a real version to migrate against. Do it
*before* adding any feature that needs a column, and take a backup first: there is no
rollback, and backups are manual.

---

## 30. Platform: API Client & Errors

**How it works.** `api.js:3-26` is the entire error model: fetch → `await res.json()` →
check 401 → check `res.ok` → return `json.data`. All paths are relative, proxied by Vite in
dev and same-origin in prod — clean, with no `VITE_API_URL` to misconfigure.

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| **P1** | `api.js:14` | **`await res.json()` runs before any status check.** Verified live that Flask-Limiter 4.1.1 returns 429 as `text/html`; Flask's 500/413 pages do the same, and unknown `/api/*` paths are swallowed by the SPA catch-all (`app.py:102-108`) returning HTML with a **200** | Every 429, 500, 413 and 502 becomes `SyntaxError: Unexpected token '<'`. **This finding appears independently in all five audits.** There is also **no `@app.errorhandler`** on the Flask side, so there'd be nothing to parse even if the client checked |
| Low | `api.js:20` | 401 does `window.location.href` then `return` (undefined) | Hard reload discards React state, bypasses `AuthContext.logout()`, and callers get `undefined` → TypeError before navigation lands |
| Low | `api.js:101-122` | `importTransactions` duplicates the whole fetch/401 block and **drops the `hadToken` guard** | Divergent copy that already behaves differently on 401 |
| Low | `api.js:3-26` | No timeout, no `AbortController`, no retry | A hung request hangs the UI forever |

**Cross-cutting: errors are swallowed by design.** Seven empty `catch {}` in
`Transactions.jsx`, `catch {}` in `Dashboard.jsx:147`, three widgets returning `null` on
failure, ten bare excepts in `_migrate`, and scheduled-sync failures written only to a log
nobody reads. `eslint.config.js:23` sets `allowEmptyCatch: true` — **the tooling is
configured to permit the pattern.**

---

## 31. Platform: Build & Deploy

**How it works.** Vite builds to `dist/`, Flask serves it via the SPA catch-all. Gunicorn
(2 sync workers, `preload_app=True`) binds `127.0.0.1:5100` behind a Cloudflare Tunnel to
trackmyspend.xyz. Deploys are manual rsync + `ssh npm run build` + `ssh systemctl restart`.

**What works — the strongest part of the project.** The tunnel config is correct and
minimal (explicit hostnames, catch-all 404 so it's never a generic proxy, credentials
outside the repo, placeholders committed). systemd has real hardening (`Type=notify`,
unprivileged user, `EnvironmentFile`, `PrivateTmp`, `NoNewPrivileges`, `ProtectSystem=full`
with `ReadWritePaths` limited to `data/` and `logs/`). ProxyFix + `CF-Connecting-IP`
rate-limit keying is correct for the deployment. **And secrets hygiene is clean: no `.env`,
`.db`, `data/` or `logs/` file has ever been committed on any branch, at any point in
history** (verified via `git log --diff-filter=A`).

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| High | `.github/workflows/` | **The directory exists and is completely empty.** No CI whatsoever | 19+ merged PRs, none linted or built by anything automated |
| High | repo-wide | **Zero tests.** No `tests/`, no `test_*.py`, no `*.test.jsx`, no runner config, no `test` script, no `Makefile` target | The destructive one-shot money migration (`db_context.py:200-212`) and the bank-email parsers have **no safety net at all** |
| High | `DEPLOYMENT.md:57-77` / `README.md:511-517` | Backups are fully manual, documented **two different ways**, never automated | The only recovery from a bad `_migrate()` is a backup a human remembered to take |
| Med | `app.py:102-108` | **No `Cache-Control` on any static asset** (`SEND_FILE_MAX_AGE_DEFAULT` never set) | The content-hashed **698 KB** JS bundle is re-validated on every page load through the tunnel instead of cached immutably |
| Med | `vite.config.js` | No code splitting; all of Recharts in the main chunk, used by only two components | One 698 KB unsplit bundle |
| Med | `app.py:83` | CSP carries `'unsafe-eval'` **and** `'unsafe-inline'`, neither needed by the Vite build (`dist/index.html` has no inline script) | A large share of CSP's value given away for nothing. Also missing `frame-ancestors`, `base-uri`, `object-src`, `form-action`, HSTS |
| Med | `app.py:54-58` + `gunicorn.conf.py:10` | `RotatingFileHandler` inherited by both workers via `preload_app` | Not multi-process safe; concurrent `doRollover()` can truncate log lines |
| Med | `gunicorn.conf.py:11-12` | `logs/access.log` and `gunicorn.log` have **no rotation** and no logrotate config | Unbounded growth on a Pi SD card |
| Med | `requirements.txt` | **`ruff` is absent** though `Makefile:2` and the README require it. Also a flat `pip freeze` dump mixing transitive packages | **`make lint` fails on a clean install** |
| Med | `.env` (mode 644) | Dev `.env` with real `SECRET_KEY`/`ENCRYPTION_KEY` is world-readable; `DEPLOYMENT.md:160` hardens the Pi only | Local secret exposure |
| Med | `data/prod_db.db` (544 KB) | A production DB copy in the dev working tree — **no code path creates this filename** | Real financial data on a laptop, gitignored but unencrypted |
| Low | `frontend/dist/` | Built 2026-08-15, **older than HEAD** (2026-08-23) | `python app.py` locally serves an outdated bundle |
| Low | `ruff.toml:17` | `per-file-ignores` for `"scripts/*"` — **no `scripts/` directory exists** | Dead config |

**Linting.** Both `ruff check .` and `npx eslint src/` **pass clean** — verified by running
them.

**Documentation drift.** `README.md` has ~25 checkable errors, including a **false and
security-relevant** claim that gunicorn binds `0.0.0.0` and is LAN-accessible
(`README.md:396`) when `gunicorn.conf.py:7` binds `127.0.0.1`; four wrong API paths; the
wrong localStorage key (`auth_token` vs the real `finance_token`); a schema block missing
the entire `reimbursement_links` table and seven columns; and a migration section that
**directly contradicts `DEPLOYMENT.md:47-53`**. Neither doc is right: adding a column
requires editing `_migrate()` and redeploying. `README.md:1` is still
`# DO NOT MERGE TO MAIN!!` — a stale note above a 544-line document readers are meant to
trust.

---

## Where to go next

The consolidated severity table and cross-cutting themes are in
[00-INDEX.md](./00-INDEX.md). The sequenced fix plan — Phase 0 (stop the bleeding) through
Phase 4 (UX), with a 20-PR order — is in
[06-remediation-plan.md](./06-remediation-plan.md).

If you read only one thing beyond this page: the single biggest structural risk to
extending this app is that **there is no versioned migration system and no test asserting
anything about the data.** Every integration on the roadmap — provenance columns, identity
dedup, `sync_runs`, a credentials table — is a schema change against live financial data,
and today each one would be an unrehearsed, irreversible, untested write.
