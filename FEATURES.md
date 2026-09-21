# Feature Map

Every feature this app has, grouped by area. Written directly against the current code
(routes/, services/, frontend/src/) as of 2026-09-21 — not a marketing description, a
reference for "does it do X, and how." For known bugs, severities, and the fix roadmap, see
`claude_notes/06-remediation-plan.md` and `claude_notes/07-feature-map.md`.

---

## Contents

- [Accounts & Sessions](#accounts--sessions)
- [Transactions](#transactions)
- [Categories](#categories)
- [Reimbursements](#reimbursements)
- [Budgets](#budgets)
- [Dashboard](#dashboard)
- [Ingestion (CSV & Gmail)](#ingestion-csv--gmail)
- [Admin](#admin)
- [Platform](#platform)

---

## Accounts & Sessions

### Registration
Self-service signup — username, email, password (≥8 chars, ≤72 bytes). Gated by the
`REGISTRATION_ENABLED` env var: any value other than the literal `"false"` (including unset)
allows signups. Auto-provisions a fresh per-user database and logs the new account in
immediately. Rate-limited 10/hour.

### Login
By username *or* email, bcrypt-verified (cost 12). Rate-limited 20/minute and 100/hour.
Returns a JWT and stamps `last_login_at`.

### Sessions
Stateless JWT bearer tokens, HS256-signed, 7-day expiry, stored in the browser's
`localStorage` (`finance_token`) and sent as `Authorization: Bearer <token>`. No server-side
session store, no refresh flow — the token is valid until it expires or `SECRET_KEY` is
rotated. A demoted admin or a changed password does not invalidate an already-issued token
until it naturally expires.

### Change password
Requires the current password; new password same 8–72-byte rule. Does not invalidate other
active sessions.

### Password recovery
None. There is no email-based "forgot password" flow — only an admin can reset another
user's password. Appropriate for a small, owner-operated deployment; a real limitation for
anyone else.

### Admin & user management
Admin-only (`is_admin` flag) pages and API for: listing all users (with Gmail-configured
status and last sync time), creating a user, editing username/email/admin flag, resetting
anyone's password, deleting a user (removes their account and finance database), triggering
a sync for another user, and viewing recent application log lines. Self-protections: an
admin can't demote or delete their own account through these endpoints.

---

## Transactions

### List, filter, search, sort
Paginated list (25/page by default, capped at 200) with: date range, category, status
(`pending` = uncategorized outflows, `confirmed` = categorized), free-text search across
merchant/notes/amount, source (`venmo` vs `credit`, inferred from a note prefix), and five
sort orders (date/amount ascending or descending, merchant alphabetical). `include_ids` lets
specific transaction ids always appear regardless of other filters — this is the mechanism
pinning uses.

### Manual create / edit / delete
Add a transaction by hand (amount, direction, merchant, category, notes, date). Edit any
field with guardrails: direction can't flip while reimbursement links exist, amount can't
drop below what's already been paid/received against it, `expected_reimbursement` is
outflow-only and capped at the transaction's amount. Deleting a transaction that has linked
reimbursements asks for confirmation naming how many links will go with it (pass
`?force=true` to proceed).

### Pinning
Force specific transactions (from any date) into every dashboard metric regardless of the
active date range — useful for including a bill you know falls just outside the visible
window. Persisted client-side (`pinned_txn_ids` in `localStorage`), shared between the
Dashboard and Transactions pages. Counted in the dashboard tile, merchant insights, and
period comparison; deliberately **not** shown in the spending trend chart, since a pin's
real date may fall outside the chart's fixed buckets.

### Auto-categorization
New transactions inherit a category automatically by matching merchant name against
previously-categorized history (exact match, then a prefix match with a 5-character floor).
Runs at import/sync time and via a manual "auto-classify" pass over anything still
uncategorized.

### Bulk classify & reclassify
A "classify" workflow groups all uncategorized outflows by merchant prefix so you can assign
a whole group to a category in one action, and a separate reclassify tool moves every
transaction under one merchant prefix from one category to another.

### Split transactions
Break one transaction into two or more pieces (e.g. a shared bill), each with its own
amount, merchant, category, and notes — the pieces must sum to the original amount. Blocked
if the original has any reimbursement expectation or linked payment; unlink or clear those
first.

### Duplicate detection
Finds groups of transactions that share the same date, amount, merchant, and direction, for
manual review and deletion. Rows that were independently imported (each carrying its own
distinct dedup hash) are excluded from the results — only truly ambiguous or hash-less rows
surface, since two identical-looking charges from different sources usually aren't
duplicates at all.

---

## Categories

Flat, user-defined list (9 defaults seeded on account creation: Dining, Groceries, Travel,
Entertainment, Shopping, Housing, Transportation, Health & Personal Care, Other). Supports:
create, delete (blocked with a clear error if any transaction still references it),
drag-to-reorder (persisted), and designating exactly one category as the **Misc** bucket
(used as the flex-budget default and migration fallback).

---

## Reimbursements

Two complementary ways to record that money you spent isn't really your own cost:

### Linked reimbursements
Tie a specific inflow (a Venmo payment, a refund) to a specific outflow it's paying back,
for any portion of either amount. One payment can be split across several charges and vice
versa. The charge shows a running "received" total and, once you set an
`expected_reimbursement` on it, an "outstanding" amount still owed.

### Optimistic exclusion
Mark an outflow with an `expected_reimbursement` amount (or flag it `reimbursement_external`
— settled outside the app entirely, e.g. via payroll) and that portion is excluded from your
spend totals **immediately**, before the money actually arrives. The excluded amount is
`MIN(MAX(expected, actually received), transaction amount)` — it can't exceed the charge
itself and always reflects whichever is larger, the expectation or what's actually landed.

### Owed / outstanding
A dedicated view listing every charge where you're still waiting on money back — the
expected amount, what's arrived so far via links, and the remaining gap — sorted oldest
first.

This exclusion is applied identically everywhere spend is shown: dashboard totals, category
breakdown, trend chart, merchant insights, and period comparison all agree with each other
by construction (see `services/budget_service.py`).

---

## Budgets

Per-category budget amount with a `monthly` or `yearly` period. Monthly budgets scale
automatically with however many months the selected date range spans; yearly budgets always
track the full calendar year regardless of the window you're viewing (so a one-month view
still shows accurate year-to-date progress against a yearly budget).

### Misc / Flex pool
One category is the designated **Misc** bucket. Any other category can be flagged to
**fold into Misc** — its spending then counts against a shared pooled budget instead of its
own, rendered as a combined fixed-vs-flex progress bar. Lets "eating out" and "coffee" share
one flexible envelope instead of two rigid ones.

---

## Dashboard

### Stat tiles
Total spent, total income, net, and how many transactions are still pending categorization,
for the selected date range (defaults to month-to-date).

### Category donut & breakdown
A donut chart plus a list, both scoped to the exact same window as the stat tiles — every
category's slice, summed, reconciles to the "Total Spent" tile. Each row shows its budget
progress bar (green / amber ≥75% / red ≥100%); a yearly-budget category's progress bar
tracks its calendar-year spend even though its slice in the donut only reflects the current
window.

### Spending trend chart
A line chart of spend/income over the selected range, auto-choosing daily, weekly, or
monthly buckets based on how wide the range is (≤60 days daily, ≤180 weekly, else monthly).
Empty buckets are filled with zero so the line has no gaps.

### Merchant insights
Top 8 merchants by net spend in the window, each with its own transaction list; the single
largest transaction; and merchants you've spent with in more than one distinct month within
the range.

### Period comparison
Current period vs. the equivalent previous one, with percent deltas on spend/income/net and
the single category that moved the most. A completed calendar month compares against the
prior full calendar month; a still-in-progress range (including "this month" viewed today)
compares against the same number of elapsed days immediately before it, so a 10-day-old
month isn't measured against a full 31-day one. Also shows a month-end spend projection
based on your pace so far, when viewing the current month.

### Date range selection
This Month, Last Month, 3/6 Months, This Year, or a custom range — persisted across visits.

### Widget customization
Hide or reorder the five dashboard widgets (comparison, trend, donut, budget breakdown,
merchant insights) to match what you actually look at; persisted per-browser.

---

## Ingestion (CSV & Gmail)

### CSV import
Upload one or more exports and the app parses, deduplicates, and inserts them:

| Source | What it reads |
|---|---|
| Capital One | Standard transaction-history export (`Debit`/`Credit` columns) |
| Amex | Standard transaction export, dedups on the card's own `Reference` field |
| Venmo | Personal statement export — captures the payment/charge memo and who was on the other end |

Autopay/payment rows are skipped automatically so your card payment doesn't double-count as
spend. Every row gets a stable dedup key so re-uploading the same file (even a
differently-windowed export of the same data) doesn't create duplicates.

### Gmail sync
Connect a Gmail inbox (via an app password, validated with a live login check before it's
saved, then encrypted at rest) and the app reads unread bank notification emails directly:
Capital One purchases and credits, Amex "large purchase" alerts, Venmo payment/charge
notifications, and Capital One Zelle transfers (sent and received). Runs automatically every
night at 3 AM, or on demand via "Sync now." An email is only marked read once it's
successfully parsed, so a template your parser doesn't yet handle stays unread and gets
retried on the next sync instead of being silently lost.

### Gmail credential management
Set up, view (address only, never the password), and disconnect Gmail sync from Profile.

---

## Admin

Covered under [Accounts & Sessions](#accounts--sessions) above — user CRUD, password
resets, per-user sync triggers, and a live log viewer, all gated behind `is_admin`.

---

## Platform

- **Per-user data isolation.** Every account gets its own SQLite file
  (`data/user_<id>_finance.db`); there is no cross-user table anything is ever joined
  against. A separate `master.db` holds only login credentials.
- **Automatic schema migrations.** Opening any user's database brings its schema up to date
  (new columns, the reimbursement-links table, one-time data backfills) — no manual step
  needed when the schema changes.
- **Security posture.** bcrypt password hashing, Fernet-encrypted Gmail credentials, JWT
  auth on every route but registration/login, a restrictive CSP, CORS locked to one
  configured origin, and IP-aware rate limiting on the auth endpoints (keyed on
  `CF-Connecting-IP` when behind Cloudflare, so a tunnel doesn't collapse every visitor into
  one bucket).
- **Deployment.** Runs under Gunicorn behind a Cloudflare Tunnel, with a systemd unit,
  rsync-based deploys, and manual SQLite backup/restore (see `DEPLOYMENT.md`).
- **Install prompt & offline banner.** A mobile "add to home screen" hint and an
  online/offline indicator exist, but there's no service worker or manifest — this is a
  mobile-styled web app, not an installable/offline-capable PWA today.

---

## Known gaps (not features, but worth knowing)

- No forgot-password flow, no CSV/JSON export of your own data, no multi-currency or
  investment tracking, no bank API integration (Plaid, etc.) — ingestion is CSV + Gmail
  parsing only, for the specific sources listed above.
- No automated test suite or CI.
- Rate limiting resets on a process restart and isn't shared across workers (fine for a
  single-owner deployment; not a hardened multi-tenant guarantee).

See `claude_notes/06-remediation-plan.md` for the sequenced plan addressing these and other
findings from the last full audit.
