# 04 — Data Ingestion: CSV Import & Gmail Sync

Read-only audit. Scope: CSV import, Gmail IMAP sync, email parsing, auto-categorization,
credential encryption, scheduler. Every claim is tagged **CONFIRMED** (traced in code, logs,
or the SQLite data) or **SUSPECTED** (inferred, not directly observed). The SQLite data
referenced throughout is a **local, disconnected snapshot** — `data/` is excluded from
every rsync deploy, so this is not the live Pi database. See
[00-INDEX.md](./00-INDEX.md) for the full provenance note; the sync-pipeline conclusions
(what works, what's brittle) hold regardless, since they're demonstrated on real
historical activity, but exact current counts (e.g. "0 transactions for user 2/4") should
be re-checked against the live Pi before being treated as current.

---

## Overview

Two ingestion paths write into one table, `transactions` (`db_context.py:27-43`), deduplicated
only by a `source_hash TEXT UNIQUE` column (`db_context.py:36`) and `INSERT OR IGNORE`.

| Path | Entry point | Parsers | Dedup key |
|---|---|---|---|
| CSV upload | `routes/import_route.py:20` | `services/import_service.py` (capitalone / venmo / amex) | `sha256(provider\|date\|amount\|merchant\|row_num)` |
| Gmail IMAP | `routes/sync_routes.py:69` + `services/sync_service.py:20` | `services/email_parser.py` (5 branches) | `sha256(provider\|Message-ID)` |

Both call `services.categorize.resolve_category_id()` per row to guess a category from history.
Gmail credentials are Fernet-encrypted (`services/encryption_service.py`) into
`profile.gmail_app_password_enc` (`db_context.py:59-66`). A nightly APScheduler cron job at
03:00 runs `scheduled_sync_all()` for every user.

**The single most important structural fact: there is no `source` / `provider` column on
`transactions`** (`db_context.py:27-43`). Once a row lands, the database cannot tell you whether
it came from a Capital One CSV, an Amex email, or a manual entry. Everything downstream infers
source from the free-text `notes` column (`notes LIKE 'venmo:%'` in `categorize.py:40`). This is
the #1 blocker for adding Plaid or any new integration.

---

## CSV Import (format spec as actually implemented)

`POST /api/import/transactions`, multipart. `source_type` form field must be one of
`capitalone` / `venmo` / `amex` (`import_route.py:13-25`); `file` may be repeated for multi-file
upload (`import_route.py:27`). All files in one request are parsed with the **same** parser.

### Request handling (`import_route.py:36-49`)
- Whole file read into memory (`upload.stream.read()`, line 37) — no streaming.
- Encoding: tries `utf-8-sig` then `latin-1` (line 38-46). Handles BOM correctly.
- Rows from all files are accumulated, then inserted in one loop (lines 54-78), single
  `conn.commit()` at line 78.
- Response: `{imported, duplicates_skipped, errors[]}` where each error is a **dict**
  `{row, reason, data}` or `{file, reason}`.

### Capital One (`import_service.py:22-64`)
Expected headers (exact, case-sensitive, via `csv.DictReader`):

| Column | Used at | Notes |
|---|---|---|
| `Transaction Date` | line 45 | parsed strictly as `%Y-%m-%d`; stored `YYYY-MM-DDT00:00:00` |
| `Description` | line 28 | becomes `merchant_raw` verbatim |
| `Debit` | line 32 | non-empty ⇒ `direction=outflow`, `amount=float(debit)` |
| `Credit` | line 33 | non-empty ⇒ `direction=inflow` |

- Rows whose `Description` contains `AUTOPAY PYMT` or `MOBILE PYMT` are skipped silently
  (`import_service.py:7,29`) — card payments, correctly excluded.
- Neither column populated ⇒ error row `"No value in Debit or Credit"` (line 40).
- `float(debit)` is **raw** (line 36) — no `$`/comma/paren handling. `_parse_amount` exists at
  line 18 but is used only by the Venmo parser.
- `row_num` starts at 2 (line 26) and is folded into the hash (line 55).

### Amex (`import_service.py:67-108`)
| Column | Used at | Notes |
|---|---|---|
| `Date` | line 86 | strict `%m/%d/%Y` |
| `Description` | line 73 | `merchant_raw` |
| `Amount` | line 77 | `float()`; **positive = outflow**, negative = inflow (line 83) |
| `Reference` | line 89 | stripped of `'`; used as the dedup key when present |

- Skips `AUTOPAY PAYMENT` (line 8, 74).
- Amex is the **only** source with a stable dedup key (`Reference`, line 90). Falls back to
  `row_num` when absent.
- `signed_amount == 0.0` classifies as `inflow` (line 83). Cosmetic.

### Venmo (`import_service.py:111-173`)
- Unconditionally consumes **two** header lines before `DictReader` (lines 114-115) to skip
  Venmo's preamble; row numbering starts at 4.
- `" ID"` (leading space) or `"ID"` — read at line 120, used only as a "is this a real row"
  test. Blank ⇒ skipped (statement rows / the trailing balance row).
- `Type` must be `Payment` or `Charge` (line 124); Standard Transfers, Merchant, etc. dropped
  silently.
- `Amount (total)` (line 128) must start with `+` (inflow) or `-` (outflow); anything else is an
  error row. `_parse_amount` (line 18) strips `+ - $ ,` and whitespace.
- `Datetime` (line 144) is stored **verbatim, unmodified** — see the timezone bug below.
- `Note` becomes `merchant_raw` (line 145) — i.e. the memo, not a merchant.
- `From`/`To` (also tolerating leading-space variants, lines 147-148) plus type/direction produce
  `notes = "venmo:{payment|charge}:{person}"` (lines 149-154). This string is load-bearing:
  `categorize.py:40` excludes it from learning, and the dashboard/reimbursement code keys off it.

### Dedup
`_source_hash()` (`import_service.py:11-15`) = `sha256("{provider}|{date}|{amount}|{merchant}|{row_num}")`.
Re-uploading the *identical* file is a clean no-op (`duplicates_skipped`). See Bugs #1 for why
that guarantee is far weaker than it looks.

---

## Gmail Sync Pipeline

`services/email_parser.py:355` `fetch_emails()`:

1. `imaplib.IMAP4_SSL("imap.gmail.com", 993)` (line 358) — **no `timeout=` argument**.
2. `login()`, `select("INBOX")` (lines 360-361). INBOX only; no All Mail, no label support.
3. Five searches (lines 363-369), each ANDed with `UNSEEN`:

| # | IMAP criteria (line) | Parser |
|---|---|---|
| 1 | `FROM "capitalone.com" SUBJECT "transaction"` (364) | auto-routed: credit vs charge |
| 2 | `FROM "capitalone.com" SUBJECT "credit"` (365) | auto-routed |
| 3 | `FROM "capitalone.com" SUBJECT "Zelle"` (366) | `_parse_zelle_email` |
| 4 | `FROM "venmo@venmo.com"` — **no subject filter** (367) | `_parse_venmo_email` |
| 5 | `FROM "americanexpress.com" SUBJECT "Large Purchase Approved"` (368) | `_parse_amex_email` |

4. Per message: `mail.fetch(num, "(RFC822)")` (line 379), `message_from_bytes`, `Message-ID`
   (line 382, falling back to the volatile sequence number).
5. For searches 1-2 the router at lines 387-391 reads the body and picks `_parse_credit_email`
   if any of `_CREDIT_PHRASES` appears, else `_parse_charge_email`.
6. On success: append + `mail.store(num, "+FLAGS", "\\Seen")` (line 396). On `None`: append an
   error dict (lines 398-404). Per-message `except Exception` (line 405) records
   `{message_id, reason}` and continues.
7. `finally: mail.logout()` wrapped in `except Exception: pass` (lines 407-411).

`services/sync_service.py:20` `sync_user()` then decrypts the password (line 31), calls
`fetch_emails` **holding an open SQLite connection for the entire IMAP session** (lines 21-35),
inserts with `INSERT OR IGNORE` (lines 41-58), stamps `profile.last_synced_at` (line 64), and
returns `{imported, duplicates_skipped, errors}`. Broad `except Exception` at line 69 logs and
returns `{"synced": 0, "error": str(exc).strip("b'\"")}`.

`scheduled_sync_all()` (line 76) reads all users from `MASTER_DB`, skips those without a
`gmail_address` (lines 88-94), then syncs each **serially**. Results go to the log only.

---

## Email Parser Coverage

Text extraction (`_get_text`, line 74): prefers the first `text/plain` part; falls back to
`BeautifulSoup(html,"html.parser").get_text(separator=" ")` (line 92). Attachments skipped.

### 1. Capital One charge — `_parse_charge_email` (160)
- **Gate**: `Subject` matches `transaction|purchase|charge|alert` (line 162).
- **Amount**: first `$N,NNN.NN` in the body (`_CAP1_AMOUNT`, line 19). No match ⇒ `None`.
- **Merchant**: `_CAP1_MERCHANT_SPECIFIC` (line 20) — `at <X>, a (pending|purchase)` — else
  `_CAP1_MERCHANT` (line 24) — `(at|from|purchase at|used at|charged at) <X>` up to ` on `/
  ` for `/`.`/`,`. No match ⇒ literal `"Unknown Merchant"` (line 173).
- **Date**: `_parse_cap1_date` (147) tries four shapes; **falls back to today** (line 157).
- Always `direction="outflow"`, `notes=None`.

### 2. Capital One credit/refund — `_parse_credit_email` (186)
- **Gate**: body contains one of `credit has posted`, `credited your account for`,
  `is in your account now` (lines 35, 189).
- **Amount**: `credited your account for $X` else `+$X` (lines 36-37).
- **Merchant**: `_CREDIT_MERCHANT` (line 38) — `([A-Z][A-Z\s\*\-0-9]+)\n.*Card\.\.\.` — an
  all-caps line immediately followed by a line containing `Card...`. Falls back to the raw
  `Subject` (line 198).
- **Date**: `%b %d %Y` only (line 39, 204); else today.
- `direction="inflow"`, `notes="Refund"`.
- **Evidence it works**: 7 rows with `notes='Refund'` in `data/prod_db.db` (`UBER *TRIP` 61.43,
  five `AMAZON MKTPLACE PMTS`, `eBay O*13-14972-45519`) — merchant regex hit, not the subject
  fallback. CONFIRMED working.

### 3. Zelle — `_parse_zelle_email` (308)
- **Gate**: `zelle` in the Subject (line 310).
- **Date**: the `Date:` **header** (line 316), truncated to midnight — the only parser that uses
  the header rather than the body.
- Incoming branch (Subject matches `someone sent you money`, line 320): amount from
  `in the amount of $X` (line 43); sender from `^(.+?) has just sent you money` (line 44), else
  `"Zelle"`. `notes="zelle:received:<person>"`.
- Outgoing branch: amount from `Amount: $X` (line 41); recipient from group **2** of
  `Memo:\s*(.+?)\s+to:(.+?)$` (line 42) — i.e. the *memo* is captured but thrown away and the
  recipient is used as `merchant_raw`. If the memo line is absent the whole regex fails and the
  recipient degrades to `"Zelle"` (line 343).
- **Evidence**: 20 `zelle:%` rows in `data/prod_db.db`, all with a real name. But note the
  outgoing rows show `merchant_raw = "ANDREW QIAN"` / `"RISHI SONI"` while one
  (`Piccola Cucina`, 2026-07-05) has a memo-looking merchant — inconsistent extraction.
  Two rows on 2026-07-26 for the same $1.00 (`zelle:sent:RISHI SONI` outflow and
  `zelle:received:Rishi Soni` inflow) suggest a self-test.

### 4. Venmo email — `_parse_venmo_email` (221)
- **Gate**: Subject matches `paid|charged|payment` (line 223).
- Three mutually exclusive body regexes (lines 46-48): `paid you $X` ⇒ inflow/payment;
  `you paid ... $X` ⇒ outflow/payment; `charged you $X` ⇒ outflow/charge. None ⇒ `None`.
- **Counterparty**: subject regex first (lines 50-52), body regex as fallback (54-56), else
  `"Venmo"`.
- **merchant_raw is the memo**, scraped from `<... class="transaction-note">` via BeautifulSoup
  (`_get_venmo_memo`, line 96-111) — a **single hard-coded CSS class**. Missing ⇒ `"Venmo"`.
- `notes = "venmo:{type}:{person}"`, matching the CSV parser's convention. Good.
- **Date**: `_parse_cap1_date` over the whole Venmo body (line 273) — the first date-like string
  anywhere in a marketing-heavy HTML email.

### 5. Amex — `_parse_amex_email` (279)
- **Gate**: Subject matches `large purchase` (line 281). Only the "Large Purchase Approved"
  alert is supported — normal Amex charges are not ingested at all.
- **Primary extraction is by inline CSS colour** (`_get_amex_styled_text`, line 114-132): find
  the first `<div style=...>` whose de-spaced style contains `color:#006fcf` **and**
  `font-weight:bold` ⇒ merchant; `color:#333333` + bold ⇒ amount text (lines 65-66).
- Fallback `_AMEX_TXN` (line 58) is a three-blank-line-separated `MERCHANT / $AMT / Day, Mon D,
  YYYY` block regex — only consulted when the *amount* is None (line 290), so a colour change
  that breaks only the merchant div silently yields `"Unknown Merchant"` (line 289).
- **Date**: `_parse_cap1_date` over the body; today on failure.

### Not covered
No Chase, BofA, Discover, Citi, PayPal, Apple Card, Cash App, ACH/direct deposit, or any
Capital One **checking/savings** notification. No bank statement PDF. No Plaid.

---

## Auto-Categorization (`services/categorize.py`)

`resolve_category_id(conn, merchant_raw)` (line 26) runs on **every** parsed row, at parse time.

1. Loads *all* `(merchant_raw, category_id)` groups with a non-null category, excluding
   `notes LIKE 'venmo:%'` rows (lines 34-43) — person-to-person payments teach nothing.
2. Scores each known merchant against the target (lines 47-63):
   - exact (upper-cased) match ⇒ `common = len(target)`
   - one is a prefix of the other ⇒ `common = min(len)`, requires `>= 5` chars (`_MIN_PREFIX_LEN`, line 17)
   - same `merchant_prefix()` group ⇒ `common = len(group)`
3. `merchant_prefix()` (line 21) strips a trailing ` #123…` / ` *123…` / ` 123…` run of 3+ digits
   and everything after: `TRADER JOES #552` → `TRADER JOES` (verified). Note `MTA*NYCT PAYGO`
   is **unchanged** (the `*` is not preceded by whitespace) — the rule only fires on a
   whitespace-delimited numeric suffix.
4. Wins by `(common, count, last_transaction_at)` (line 66).

There is **no rule table, no user-editable mapping, and no MCC/merchant taxonomy** — purely
"what did you do last time". A brand-new merchant always lands uncategorized.
Measured cost: **1.51 ms/call at 1,817 rows** (benchmarked against a copy of `prod_db.db`)
⇒ ~2.3 s of pure categorization for a 1,500-row CSV, growing quadratically.

---

## Credential Encryption (`services/encryption_service.py`)

- `get_fernet()` (line 6) builds a `Fernet` from `config.ENCRYPTION_KEY` on **every single call**
  — no caching. `config.py:15-17` hard-fails at import if the var is missing.
- `encrypt()` is called exactly once, at `sync_routes.py:33`, after a live IMAP login probe
  (lines 24-31) validates the credential before storing it. That probe is a genuinely good
  design touch.
- `decrypt()` (line 17) converts `InvalidToken` into `ValueError("Decryption failed — wrong key
  or corrupted data.")`, caught at `sync_service.py:32`.
- **No key versioning, no `kid` prefix, no re-encryption path, no rotation tooling.** Rotating
  `ENCRYPTION_KEY` silently bricks every stored password; the only signal is a per-user sync
  error string, and the scheduled path writes that only to the log.
- `DELETE /api/profile/gmail` (`sync_routes.py:44`) clears both fields but has **no caller in
  the frontend** — dead code.

---

## Scheduler

Two independent wirings, both scheduling the same `scheduled_sync_all` cron at 03:00 **server
local time** (no `timezone=` argument, so APScheduler uses `tzlocal`):

| | `app.py:111-115` | `gunicorn.conf.py:18-23` |
|---|---|---|
| Gate | `RUN_SCHEDULER=true` env | always, in `on_starting` (master only) |
| `daemon` | `False` | `True` |
| `misfire_grace_time` | none | `300` |
| atexit shutdown | yes (115) | yes (23) |

Production (`deploy/env.production:14`, `.env:5`) sets `RUN_SCHEDULER=false`, so only the
gunicorn master hook runs — **and it demonstrably works**: `data/prod_db.db` shows insert
batches at `2026-08-23T07:00:01`, `2026-08-22T07:00:07`, `2026-08-21T07:00:03`,
`2026-08-20T07:00:04`, … i.e. 03:00 EDT nightly, every night.

The duplication is still a live hazard: setting `RUN_SCHEDULER=true` alongside gunicorn's
`preload_app = True` (`gunicorn.conf.py:10`) means `app.py`'s module-level scheduler starts in
the master *before* fork, and a `daemon=False` thread does not survive `fork()` into workers —
you get a stopped scheduler object per worker plus the master's, with the two jobs racing on the
same SQLite files. `worker_exit` (`gunicorn.conf.py:26-27`) is a no-op `pass`.

Development is worse: Werkzeug's reloader runs the module twice.
`logs/app.log:208-220` shows **two** `Scheduler started` lines per boot, 18 in that file total.

---

## Evidence from Logs

`logs/app.log` (6,387 lines, 2026-06-09 → 2026-07-25), `app.log.1` (3,565), `app.log.2` (6,564).
All three are **development** logs (`werkzeug`, debugger active). Totals: 16,281 INFO,
140 WARNING (all `Debugger is active!`), **1 ERROR**, 1 traceback.

**The single logged ERROR** — `logs/app.log.2:573`:
```
2026-06-09 03:00:06,673 ERROR apscheduler.scheduler: Error submitting job
  "scheduled_sync_all (trigger: cron[hour='3', minute='0'], ...)" to executor "default"
  ...
  RuntimeError: cannot schedule new futures after interpreter shutdown
```
The nightly sync fired and was **dropped**. This is the `daemon=False` + `atexit` shutdown-order
bug in `app.py:112-115`: the interpreter's thread-pool was already torn down. Nobody was told.

**Request outcomes across all three logs:**
- `GET /api/sync/status` → 200 × 170
- `POST /api/sync` → 200 × 16 (never a non-200 — the route returns 400 inside a 200-shaped
  envelope only via `_err`, so a failed sync would show as 400; none observed)
- `POST /api/import/transactions` → 200 × 36, **500 × 3**, 401 × 1
- The three import 500s cluster on 2026-06-09 at `15:52:04`, `15:52:55`, `15:53:48`
  (`logs/app.log.2`), interleaved with 200s at `15:52:52` / `15:53:01`. **No traceback was
  written for any of them** — the file handler never saw them (Werkzeug's debugger caught them
  first). Server-side you have a 500 with zero diagnostic trail.
- 1,757 lines contain ` 500 ` overall (mostly ANSI-coloured werkzeug lines across all routes).
- **Zero** occurrences of `sync failed for user`, `synced user`, or `sync_user(...) failed` —
  `scheduled_sync_all`'s own logging (`sync_service.py:98-108`) never fired in any captured log.

**No production log is present in the repo** (`logs/gunicorn.log`, `logs/access.log` per
`gunicorn.conf.py:11-12` are not committed; `logs/` is gitignored). Everything above therefore
describes the dev environment; prod behaviour is reconstructed from `data/prod_db.db`.

**Database evidence (`data/prod_db.db`, 1,817 rows; `data/user_1_finance.db`, 1,533 rows):**
- Nightly 07:00Z insert batches confirm the prod scheduler works.
- `notes='Refund'` × 7 ⇒ the credit parser works. `notes LIKE 'zelle:%'` × 20 ⇒ the Zelle parser
  works. `notes LIKE 'venmo:%'` × 343 ⇒ Venmo works.
- **Zero rows with `merchant_raw` = `'Unknown Merchant'`, `'Venmo'`, or `'Zelle'`** in either DB
  ⇒ across ~thousands of ingested emails the merchant-extraction fallbacks have never fired.
  The regexes currently match the live templates.
- **Truncated merchants from email**: `LOS TACOS NO. 1 -`, `THE HANDPULLED NOO`,
  `ANTICO VINAIO - 8T`, `CULTURE AN AMERICA`, `XING FU TANG - ST`, `PICCOLA CUCINA - S`,
  `MALA PROJECT 53RD` — all cut at ~17-18 chars by Capital One's own alert field.
- **Two merchant naming systems in one column**: the same account produces
  `AMAZON RETAIL` / `AMAZON MKTPLACE PMTS` (CSV + one email template) *and* `Amazon`,
  `Chipotle`, `Apple`, `Domino's Pizza`, `Lyft Bike & Scooter`, `MTA Transit - NYC`
  (a newer, title-cased Capital One template). `resolve_category_id` treats these as
  **different merchants** — `AMAZON RETAIL` vs `Amazon` share only 6 chars and fail the
  prefix test. Category learning is silently fragmented.
- `user_1_finance.db`: 288 rows carry a raw Venmo timestamp (`2024-01-10T04:58:53`,
  `2026-05-25T21:19:14`, …) — never normalized. 4 rows have `source_hash IS NULL` (manual entry).
- `data/user_2_finance.db` and `user_4_finance.db` contain **0 transactions**;
  `user_3_finance.db` has 10. Sync has never produced anything for those users.

---

## What Works

- **Capital One and Venmo CSV import** — the primary corpus. 1,220 rows in one batch on
  2026-06-10, 283 in another, all correctly signed and dated. CONFIRMED.
- **The Gmail pipeline end to end in production.** Nightly cron + on-open sync have been
  writing rows continuously through 2026-08-23. All five parser branches have produced real
  rows. CONFIRMED from `prod_db.db`.
- **Credential validation before storage** (`sync_routes.py:24-31`) — a live IMAP login probe
  means you cannot save a bad app password. Genuinely good.
- **`INSERT OR IGNORE` + `UNIQUE(source_hash)`** — re-uploading the exact same file is a clean
  no-op, and Message-ID-keyed email hashes make re-syncing the same message safe. CONFIRMED.
- **The `venmo:` / `zelle:` `notes` convention** is consistent between the CSV and email paths
  (`import_service.py:154` ↔ `email_parser.py:267`), which lets `categorize.py:40` exclude P2P
  rows from learning. Well thought out.
- **BOM/encoding handling** (`import_route.py:38`) — `utf-8-sig` first. European merchant names
  (`Abegglen Sport AG Mürr`) survived intact. CONFIRMED.
- **Amex `Reference`-based dedup** (`import_service.py:89-90`) — the one source with a stable
  identity key.
- **Multi-file upload** works and aggregates counts correctly.
- Per-row `try/except` in all three CSV parsers means one bad row cannot abort an import.

---

## Bugs & Issues

Severity: **P0** = data loss / silent corruption · **P1** = user-visible failure or blocks
extension · **P2** = fragility / scaling · **P3** = polish.

| Sev | file:line | Issue | Impact |
|---|---|---|---|
| **P0** | `email_parser.py:379` | `mail.fetch(num, "(RFC822)")` uses `RFC822`, **not `BODY.PEEK[]`**. Per RFC 3501, `RFC822` implicitly sets `\Seen`. Every fetched email is marked read **whether or not it parsed**. CONFIRMED (protocol semantics + the explicit `store` at line 396 being redundant). **Correction**: a parse failure is not undetected within that sync run — it's appended to the `errors` list with `message_id`/`reason`/`subject` (`email_parser.py:398-404`). But the email is still marked `\Seen`, so it drops out of every future `UNSEEN` search — there is no retry — and *durable* persistence of that detail is thin: the scheduled path (`sync_service.py:96-108`, the one that actually runs nightly) logs only a **count** of parse errors, never the message content; the manual-sync path returns the full list in the HTTP response, but `Profile.jsx` renders only `imported`/`duplicates_skipped` and drops it (see the UX row below). | An email whose template drifted parses to `None`, is marked read, and is **never fetched again**. The failure is counted, not lost from view entirely within that run — but nothing durable records *which* email or *why*, so in practice it is unrecoverable and the user is never prompted to go find it in Gmail manually. |
| **P0** | `import_service.py:14` | `row_num` is part of the dedup hash for Capital One and Venmo. CONFIRMED. | Any re-export with a different date window shifts every row's index ⇒ every hash changes ⇒ **the entire file re-imports as new**, doubling your history. Venmo's stable `" ID"` is read at line 120 and thrown away; Capital One's `Posted Date`/`Card No.` are ignored. |
| **P0** | `email_parser.py:69-71` vs `import_service.py:11-15` | The two paths use **completely different, non-overlapping hash schemes**. CONFIRMED. | A purchase ingested from an alert email (`Amazon`, `$32.65`) and later from the monthly CSV (`AMAZON.COM*ABC`, `$32.65`) produces **two rows for one transaction**, with no cross-path dedup possible. SUSPECTED in prod only because the user appears to have stopped CSV-importing after enabling sync. |
| **P0** | `import_service.py:114-115` | `next(stream); next(stream)` with **no guard**, and outside the per-row `try`. CONFIRMED. | `StopIteration` on a file with <2 lines, or on picking "Venmo" for a Capital One file, escapes the parser and the route ⇒ **HTTP 500**. Matches the 3 unexplained import 500s at `logs/app.log.2` 15:52-15:53 on 2026-06-09. |
| **P0** | `email_parser.py:157`, `206`, `208`, `318` | Every date-extraction failure **silently defaults to `datetime.now()`**. CONFIRMED. | A template change to the date line files the transaction under today with no error, no flag, no log line. Corrupts every month-boundary report. |
| **P1** | `Import.jsx:113-115` | `result.errors.map((e) => <div>{e}</div>)` — but `errors` entries are **objects** (`import_route.py:45`, `import_service.py:41,62,79,106,134,171`). CONFIRMED. | React throws *"Objects are not valid as a React child"* the moment any row fails ⇒ the Import page white-screens exactly when the user most needs the error. Never triggered in the success-path testing visible in the logs. |
| **P1** | `email_parser.py:358` | `IMAP4_SSL(host, port)` with **no `timeout=`**. CONFIRMED. | Default socket timeout is `None` ⇒ an unresponsive Gmail hangs forever. Manual sync burns a gunicorn worker until `timeout=120` (`gunicorn.conf.py:9`) kills it; the **scheduled** run has no such backstop and can wedge `scheduled_sync_all` permanently, blocking every later user in the serial loop (`sync_service.py:84`). |
| **P1** | `sync_routes.py:72`, `sync_service.py:20` | Manual sync is **fully synchronous** inside the request. CONFIRMED. | With `workers = 2`, two concurrent syncs consume the entire pool. `usePwaSync.js:27` fires one automatically on every app open ⇒ trivially self-inflicted. No job queue, no 202-and-poll. |
| **P1** | `email_parser.py:371-377` | **Unbounded fetch**: no `[-N:]` slice, no date bound (`SINCE`), no per-run cap. CONFIRMED. | First sync on the recommended dedicated forwarding account (`GmailSetup.jsx:107`) walks *every* unread message, one sequential `FETCH` each, in one HTTP request. Guaranteed worker timeout on a real backlog. |
| **P1** | `sync_service.py:98-100` | Scheduled-sync failures are `logger.error` **only**. No table, no flag, no notification. CONFIRMED. | If the app password is revoked or `ENCRYPTION_KEY` rotates, the nightly sync fails silently forever. The user's only clue is a stale `last_synced_at`, which the UI shows as a passive timestamp (`Profile.jsx:406-409`) with no staleness warning. |
| **P1** | `db_context.py:59-66` | **No sync-history / audit table.** `profile.last_synced_at` is a single overwritten timestamp. CONFIRMED. | No answer to "what did last night's sync do?", "when did this row arrive and from where?", "why is this missing?". Also makes any incremental/resumable strategy impossible. |
| **P1** | `db_context.py:27-43` | **No `source` / `provider` / `external_id` column** on `transactions`. CONFIRMED. | Source is inferred from `notes LIKE 'venmo:%'` (`categorize.py:40`). Cannot filter by account, cannot reconcile, cannot dedup across paths, cannot add a second Capital One card. Hard blocker for Plaid. |
| **P1** | `email_parser.py:114-132`, `65-66` | Amex extraction keys on the literal hex strings `color:#006fcf` / `color:#333333` plus `font-weight:bold`. CONFIRMED. | A brand-refresh CSS tweak breaks it. Worse, the plain-text fallback at line 291 is only consulted when the **amount** is None (line 290) — a merchant-only break yields `"Unknown Merchant"` silently, at full confidence. |
| **P1** | `email_parser.py:108` | Venmo memo is `soup.find(class_="transaction-note")` — one hard-coded class name. CONFIRMED. | Silently degrades `merchant_raw` to the literal `"Venmo"` (line 266) on any template change. Since `merchant_raw` *is* the memo for Venmo, that is the row's entire descriptive content. |
| **P1** | `app.py` (no handler) | `MAX_CONTENT_LENGTH = 10MB` (`app.py:38`) with **no 413 error handler**. CONFIRMED. | Flask returns an HTML 413 body; `api.js:112` does `await res.json()` unconditionally ⇒ `SyntaxError: Unexpected token '<'`. The user sees a JSON parse error instead of "file too large". |
| **P1** | `import_route.py:27-37` | **No server-side file-type validation.** `Import.jsx:64` `accept=".csv"` is advisory; the drop handler filters (`Import.jsx:35`) but the picker does not. CONFIRMED. | An `.xlsx`/`.pdf` decodes as latin-1 (which never raises) and feeds `csv.DictReader` binary noise. Best case: hundreds of confusing error rows. No magic-byte or extension check. |
| **P1** | `sync_routes.py:69`, `import_route.py:20` | **No rate limit** on either endpoint. `limiter.py` is applied only to auth routes (`auth_routes.py:26,66,103`). CONFIRMED. | Nothing between the app and Gmail's IMAP throttling. No backoff, no retry policy, no circuit breaker. Repeated failed logins can get the app password blocked by Google. |
| **P1** | `encryption_service.py:6-10` | **No key versioning or rotation path.** CONFIRMED. | Rotating `ENCRYPTION_KEY` bricks every stored credential. The failure surfaces as a per-user string (`sync_service.py:33`) that the scheduled path only logs. Recovery requires every user to re-enter their app password with no prompt telling them to. |
| **P2** | `import_service.py:144` | Venmo `Datetime` stored **verbatim** — Venmo exports UTC without an offset marker. CONFIRMED: 288 such rows in `user_1_finance.db` (`2024-01-10T04:58:53`, `2026-05-25T21:19:14`). | Evening ET transactions land on the **next calendar day**. Month-boundary spend is wrong; Venmo rows sort inconsistently against every other source, which is date-only midnight. |
| **P2** | `email_parser.py:38` | `_CREDIT_MERCHANT` = `([A-Z][A-Z\s\*\-0-9]+)\n.*Card\.\.\.` — depends on a literal newline *and* the literal string `Card...`. CONFIRMED. | Only survives because `_get_text` prefers `text/plain`. If Capital One drops the plain-text part, `get_text(separator=" ")` (line 92) produces no newlines and the regex can never match ⇒ every refund gets the raw Subject as its merchant. |
| **P2** | `email_parser.py:367` | Venmo search has **no subject filter**, unlike every other search. CONFIRMED. | Every Venmo promo, security alert, and "your card shipped" email is fetched, marked read (see P0 #1), fails the gate at line 223 or the amount regexes at 228-230, and adds noise to `errors`. |
| **P2** | `import_service.py:36,38,82` | `float(debit)` / `float(credit)` / `float(amount_raw)` are raw — no `$`, thousands separator, or `(1,234.56)` accounting-negative handling. `_parse_amount` (line 18) exists but is Venmo-only. CONFIRMED. | Any header/format drift toward currency-formatted amounts turns every row into an error. Note `_parse_amount` also strips `-` unconditionally, so it cannot be reused for signed columns as written. |
| **P2** | `import_service.py:46,87` | `strptime` with a **single hard-coded format** per source (`%Y-%m-%d` / `%m/%d/%Y`). CONFIRMED. | A date-format change ⇒ 100% row failure with a raw `time data '...' does not match format` string shown to the user. |
| **P2** | `import_service.py:28,73` and `csv.DictReader` | Header names are exact and case-sensitive; a missing column yields `""` from `.get(...)`, not an error. CONFIRMED. | Uploading the Capital One **checking** export (`Transaction Amount`, `Transaction Type`, `Transaction Description`) produces *N* identical `"No value in Debit or Credit"` errors instead of "this looks like the wrong file". No header-shape validation, no source auto-detection. |
| **P2** | `sync_service.py:21-35` | The SQLite connection is opened **before** and held **across** the entire IMAP session. CONFIRMED. | A multi-minute sync holds a connection on a WAL SQLite file the request workers also use; combined with `timeout=15` (line 14) this is a plausible `database is locked` source under concurrency. |
| **P2** | `categorize.py:34-43` called from `import_service.py:53,97,161` and `email_parser.py:179,214,272,301,331,348` | Full `GROUP BY` scan of `transactions` **per row**. Benchmarked at **1.51 ms/call at 1,817 rows**. CONFIRMED. | O(rows × history). ~2.3 s today for a 1,500-row import; ~25 s at 20k history rows, against a 120 s worker timeout. Trivially fixed by hoisting the query out of the loop. |
| **P2** | `categorize.py` (whole module) | Category inference has **no memory of merchant identity across naming systems**. CONFIRMED by data: `AMAZON RETAIL` (CSV) vs `Amazon` (email) vs `AMAZON MKTPLACE PMTS` never unify. | Learning is fragmented across the same real merchant; the user re-categorizes the "same" store repeatedly. |
| **P2** | `email_parser.py:372` | `mail.search(...)` return status is **discarded**; `msg_nums[0]` is indexed blindly. CONFIRMED. | A `NO`/`BAD` response makes `msg_nums[0]` `None` ⇒ `AttributeError`, caught only by the outer `except Exception` in `sync_service.py:69`, aborting **all remaining searches** for that user. |
| **P2** | `email_parser.py:382` | `msg.get("Message-ID", num.decode())` falls back to the **IMAP sequence number**. CONFIRMED. | Sequence numbers are per-session and mutable. A message without a Message-ID gets a hash that changes between runs ⇒ silent duplicate rows. |
| **P2** | `app.py:111-115` + `gunicorn.conf.py:18-23` | Duplicated scheduler wiring with **divergent** settings (`daemon` False/True, `misfire_grace_time` 300/absent). CONFIRMED double-start in dev: two `Scheduler started` per boot at `logs/app.log:208-220`. | Correct today only because `RUN_SCHEDULER=false` is set in `.env:5` and `deploy/env.production:14`. One env-var mistake ⇒ concurrent syncs against the same SQLite files. The `daemon=False` variant already caused the one logged production-shaped failure (`app.log.2:573`). |
| **P2** | `app.py:113`, `gunicorn.conf.py:21` | Cron has **no `timezone=`** ⇒ APScheduler uses `tzlocal`. CONFIRMED (`prod_db.db` batches land at 07:00Z = 03:00 EDT). | Silently shifts an hour at every DST transition and moves entirely if the server TZ changes. |
| **P2** | `import_route.py:37` | `upload.stream.read()` loads every file fully into memory; all parsed rows are held in `all_rows` before any insert. CONFIRMED. | 10 MB × N files in RAM per request, plus the parsed dicts. Bounded only by `MAX_CONTENT_LENGTH`. |
| **P2** | `import_route.py:38-46` | The encoding fallback is dead: `latin-1` **never** raises `UnicodeDecodeError`, so the `for/else` branch at line 44 is unreachable. CONFIRMED. | A UTF-16 or genuinely binary file is silently mojibaked into rows rather than rejected with the intended "unknown encoding" message. |
| **P3** | `sync_service.py:71` | `str(exc).strip("b'\"")` — `str.strip` takes a *character set*, not a prefix. CONFIRMED. | Mangles error messages by chewing any leading/trailing `b`, `'`, `"` off real text. |
| **P3** | `sync_routes.py:44-53` | `DELETE /api/profile/gmail` has **no frontend caller** (grep of `frontend/src` finds only `updateGmail`). CONFIRMED. | Dead code; users cannot disconnect Gmail from the UI. |
| **P3** | `import_service.py:83` | `signed_amount == 0.0` classifies as `inflow`. CONFIRMED. | Cosmetic; $0 Amex authorizations land on the wrong side. |
| **P3** | `gunicorn.conf.py:26-27` | `worker_exit` is `pass`. CONFIRMED. | Dead hook. |
| **P3** | `gunicorn.conf.py:5` | Imports `services.sync_service` → `config` at **config-file parse time**. CONFIRMED. | A missing `SECRET_KEY`/`ENCRYPTION_KEY` fails gunicorn during config load with a bare `ValueError` traceback rather than a startup message. |
| **P3** | `usePwaSync.js:6-31` | Does **not** consult `OnlineContext`, unlike `Dashboard.jsx:152` (`handleRefreshSync` checks `isOnline`). CONFIRMED. | Offline app opens fire a doomed sync and surface a raw `Failed to fetch` via `onError` → `Dashboard` `setSyncError`. |
| **P3** | `usePwaSync.js:23-27` | No in-flight guard. `shouldSync()` reads `lastSyncedAt` from state, updated only *after* the response. CONFIRMED. | Two rapid `visibilitychange` events (tab switching) can double-fire a sync, doubling the IMAP load and the worker cost. |

---

## UX Gaps

1. **No preview / dry-run before import.** `Import.jsx:24` posts straight to the write endpoint.
   The user cannot see what will be created, and there is no undo — the only correction path is
   deleting rows one at a time on the Transactions page.
2. **No "undo this import" / batch identity.** `created_at` is a shared timestamp per request
   (`import_route.py:33`) but nothing exposes it. A mis-picked `source_type` that produces 1,200
   junk rows has no bulk remedy.
3. **Wrong-file feedback is unusable.** Picking "Venmo" for a Capital One file 500s
   (`import_service.py:114`); picking "Capital One" for a Venmo file yields N rows of
   `"No value in Debit or Credit"` — and per the P1 React bug those errors **crash the page**
   rather than render. No format auto-detection despite the headers being trivially
   distinguishable.
4. **Errors render as `[object Object]` at best, a white screen at worst** (`Import.jsx:115`).
5. **`duplicates_skipped` is unexplained.** `Import.jsx:106-110` shows a bare count with no way
   to see *which* rows were skipped or why — and given the `row_num` hash bug, a "0 duplicates"
   result on a re-export is actively misleading.
6. **No file-size or type guidance.** No stated 10 MB limit; exceeding it produces a JSON parse
   error (P1 above), not a message.
7. **The user is never told a background sync failed.** `sync_status` (`sync_routes.py:56-66`)
   returns only `credentials_configured` and `last_synced_at`. No `last_error`, no
   `last_error_at`, no unread-count. `Profile.jsx:406-409` prints the timestamp with no staleness
   styling — a sync broken for three weeks looks identical to one that ran last night.
8. **Parse errors are returned and discarded.** `sync_service.py:67` returns `errors`, but
   `Profile.jsx:206` renders only `imported` and `duplicates_skipped`, and `Dashboard.jsx:123`
   ignores them entirely. Given the P0 mark-as-read bug, those dropped emails are *gone* and the
   user is never told which ones.
9. **`GmailSetup.jsx:74-78` is out of date.** It lists Capital One transactions, Capital One
   credits, and Venmo. **Amex ("Large Purchase Approved") and Zelle are implemented and working
   in production** (20 Zelle rows in `prod_db.db`) but undocumented — a user who would benefit
   never turns those alerts on.
10. **`GmailSetup.jsx:93-98` describes the wrong mechanism.** "Once an email is processed it is
    marked as read so it is not imported twice" — dedup is actually by Message-ID hash, and
    (P0 #1) *every fetched email* is marked read including failures. The guidance is wrong in
    both directions.
11. **No way to disconnect Gmail** in the UI, though the endpoint exists (`sync_routes.py:44`).
12. **No connection health indicator.** After saving, `Profile.jsx:192` optimistically sets
    `gmail_configured: true`; there is no "test connection" button and no display of *which*
    address is currently connected versus what is typed in the box.
13. **No first-sync expectation setting.** The recommended dedicated-account flow
    (`GmailSetup.jsx:107`) guarantees a large unread backlog on first run — exactly the case that
    will hang the request (P1, unbounded fetch) — with no warning and no progress indication.
14. **`Sync Now` gives no progress and no cancel** (`Profile.jsx:454-458`) for an operation that
    can legitimately take minutes.

---

## Notes for Future Integrations

This is the area you most want to extend (Plaid, more banks, more email formats). In dependency
order, these must be fixed **before** adding a source — each new integration multiplies the cost
of not having done them.

### 1. Add provenance columns to `transactions` — prerequisite for everything else
`db_context.py:27-43` needs `source` (`capitalone_csv` / `capitalone_email` / `venmo_csv` /
`amex_email` / `zelle_email` / `plaid` / `manual`), `external_id` (the provider's own stable id),
`account_id`, and `ingested_at`. Then `UNIQUE(source, external_id)` replaces the ad-hoc
`source_hash`, and `notes LIKE 'venmo:%'` (`categorize.py:40`) stops being load-bearing string
matching. Without this you cannot tell a Plaid row from a CSV row, cannot reconcile them, and
cannot let the user filter by account.

### 2. Make dedup identity-based, not position-based
`_source_hash` (`import_service.py:11`) must stop hashing `row_num`. Venmo already gives you
`" ID"` (read and discarded at line 120); Amex already uses `Reference` (line 89-90) and is the
correct model. Capital One CSV has no id — use a content hash of
`(posted_date, transaction_date, amount, description, card_last4)` plus an intra-file occurrence
counter, so a shifted export window is stable. Then add a **cross-path** near-duplicate check
(same amount, ±2 days, fuzzy merchant) at insert time, because email alerts and CSV statements
describe the same purchase differently (`Amazon` vs `AMAZON RETAIL` — observed in `prod_db.db`).
Plaid will make this worse: it reports both pending and posted versions of one transaction.

### 3. Introduce a parser registry with declarative specs
`import_route.py:13-17` and `email_parser.py:363-369` are both hand-maintained literal lists, and
each parser re-implements amount/date/merchant handling. Extract:
- a shared `parse_amount()` that handles `$`, thousands separators, parentheses-negatives, and
  signed columns (today `_parse_amount` at `import_service.py:18` strips `-` unconditionally and
  so cannot be reused);
- a shared `parse_date()` that tries a **list** of formats and **raises** rather than defaulting
  to `now()` (`email_parser.py:157,206,318`);
- a per-source `ColumnSpec` (required headers, aliases, date formats, sign convention, skip
  patterns) so adding Chase or Discover is data, not code;
- header-shape **auto-detection**, which also removes the `source_type` picker and the P0 Venmo
  `next(stream)` crash.

### 4. Move sync off the request path
`sync_routes.py:72` calling `sync_user` synchronously does not survive a second source. Return
`202` with a job id, run the work in the scheduler's executor or a small worker, and poll. This
is also the only way to make Plaid webhooks and IMAP IDLE coexist sanely. Add `timeout=30` to
`IMAP4_SSL` (`email_parser.py:358`), cap messages per run, and add exponential backoff on auth
failure so a revoked password does not hammer Google nightly.

### 5. Stop destroying emails; add a sync_runs audit table
Switch `RFC822` → `BODY.PEEK[]` (`email_parser.py:379`) and mark `\Seen` **only** after a
successful insert — the current code loses every message a drifted template cannot parse.
Then add `sync_runs (id, user_id, source, started_at, finished_at, status, imported,
duplicates, error_count, error_json)` and a `sync_errors` table keyed by Message-ID, so failures
are inspectable, replayable, and surfaceable. Extend `GET /api/sync/status` (`sync_routes.py:56`)
with `last_error`, `last_error_at`, and `unparsed_count`, and surface staleness in
`Profile.jsx:406`. Without this table you cannot debug a new integration at all — the entire
current evidence base for "does sync work" is inference from row `created_at` timestamps.

### 6. Fix credential storage before adding OAuth-based sources
Plaid access tokens and Gmail OAuth refresh tokens are the same problem as the app password.
Add a key-id prefix to the ciphertext (`encryption_service.py:13`), support decrypting with a
retired key, and add a re-encrypt migration. Cache the `Fernet` instance
(`encryption_service.py:6-8` rebuilds it on every call). A `credentials` table keyed by
`(user_id, provider)` generalizes better than the single-purpose
`profile.gmail_app_password_enc` column (`db_context.py:62`).

### 7. Unify the scheduler and hoist categorization
Delete one of the two wirings (`app.py:111-115` or `gunicorn.conf.py:18-23`) — keep the gunicorn
master hook, pin an explicit `timezone=`, and keep `misfire_grace_time`. Separately, hoist the
`resolve_category_id` query out of the per-row loop (`categorize.py:34`, called from
`import_service.py:53,97,161`): load the merchant→category map **once** per import. That is a
~10-line change that removes the quadratic behaviour before a Plaid backfill of tens of
thousands of rows makes it a hard timeout.

### 8. Add a preview endpoint
`POST /api/import/preview` returning the parsed rows, the detected source, the proposed
categories, and the would-be duplicates — without writing. It is the cheapest fix for the worst
UX gaps (wrong source type, header drift, silent mass-duplication) and becomes essential once
there are six sources instead of three.
