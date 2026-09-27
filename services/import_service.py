"""CSV statement parsing.

Dedup identity is the load-bearing concern here. A statement re-exported over
a different date window must produce the *same* source_hash for a row it
shares with an earlier export, or re-importing doubles your history. So the
hash is built from provider identity, never from row position:

- Amex and Venmo both publish a stable per-transaction id (`Reference` /
  ` ID`), so their hash is that id alone. A restated amount against the same
  id is then a no-op on import rather than a second row.
- Capital One publishes no id, so the hash is a content key (card, date,
  amount, description) plus an occurrence index, which keeps two genuinely
  identical same-day charges distinct (two $2.90 transit swipes are two
  transactions, not a duplicate) while staying stable across re-exports.
"""

import csv
import hashlib
import re
from collections import Counter
from datetime import datetime

_CAPITALONE_SKIP = ("AUTOPAY PYMT", "MOBILE PYMT")
_AMEX_SKIP = ("AUTOPAY PAYMENT",)

# Rows in a *deposit* (checking/savings) export that mirror money movement
# already imported from another source. Left in, each one double-counts:
# a card payment re-counts every charge on that card, a Venmo cash-out
# re-counts the Venmo activity, an internal transfer inflates both the
# outflow and inflow totals at once. Only applied to deposit exports — every
# row on a card statement is real spending.
#
# Matched case-insensitively as substrings against the description. These are
# reported back per import (see `skipped`) rather than dropped silently, so a
# pattern that's too broad or too narrow shows up on the first real import.
_DEPOSIT_MIRRORS = (
    ("Zelle transfer (already imported from email)", ("ZELLE",)),
    ("Venmo transfer (already imported)", ("VENMO",)),
    (
        "credit card payment",
        ("CRCARDPMT", "CAPITAL ONE CRCARD", "AUTOPAY PYMT", "MOBILE PYMT",
         "AMERICAN EXPRESS", "AMEX EPAYMENT", "AMEX ACH PMT"),
    ),
    (
        "transfer between your own Capital One accounts",
        ("360 CHECKING", "360 PERFORMANCE SAVINGS", "360 SAVINGS", "360 MONEY MARKET"),
    ),
    (
        "transfer to/from an investment or outside account",
        ("FID BKG SVC", "FIDELITY", "ROBINHOOD", "VANGUARD", "SCHWAB", "COINBASE",
         "BETTERMENT", "WEALTHFRONT", "E*TRADE", "ETRADE", "MERRILL", "TD AMERITRADE",
         "INTERACTIVE BROKERS", "PUBLIC.COM", "SOFI", "MARCUS", "ALLY BANK",
         "CHASE", "WELLS FARGO", "BANK OF AMERICA", "CITIBANK", "DISCOVER BANK",
         "ACH TRANSFER", "WIRE TRANSFER", "OUTGOING WIRE", "INCOMING WIRE"),
    ),
)

# A masked account number in the description ("... XXXXXXX7527") means the
# counterparty is an account, not a merchant — i.e. money moving rather than
# money spent or earned. Catches account-to-account movement whose institution
# isn't in the lists above.
_ACCOUNT_MASK = re.compile(r"X{4,}\d{3,}")

# Matching is on the counterparty, never the verb: a real Capital One deposit
# export uses "Withdrawal from" for an ACH utility bill, a card payment, and a
# brokerage transfer alike ("Withdrawal from SPECTRUM SPECTRUM" vs "Withdrawal
# from CAPITAL ONE CRCARDPMT" vs "Withdrawal from FID BKG SVC LLC MONEYLINE"),
# and "Deposit from" for both payroll and an internal transfer. Only the name
# after the verb separates spending from money moving between your own
# accounts.


def _deposit_mirror_reason(description: str) -> str | None:
    upper = description.upper()
    for reason, needles in _DEPOSIT_MIRRORS:
        if any(n in upper for n in needles):
            return reason
    if _ACCOUNT_MASK.search(upper):
        return "transfer between accounts"
    return None

_MONEY_STRIP = re.compile(r"[$,\s]")


class ImportFormatError(Exception):
    """The file's headers don't match the selected source type.

    Raised instead of letting every row fail individually — picking the wrong
    source type used to produce one error per row (~1,200 for a year of
    history) with nothing saying the real cause.
    """


def _parse_money(raw: str) -> float | None:
    """Parses a money cell, preserving sign. Returns None for an empty cell.

    Handles `$`, thousands separators, a leading `+`, and accounting-style
    parenthesised negatives. Sign is preserved so this can be used for both
    signed-amount columns and separate debit/credit columns — the previous
    helper stripped `-` unconditionally and so could only serve the latter.
    """
    if raw is None:
        return None
    cleaned = _MONEY_STRIP.sub("", raw.strip())
    if not cleaned:
        return None
    negative = False
    if cleaned.startswith("(") and cleaned.endswith(")"):
        negative, cleaned = True, cleaned[1:-1]
    if cleaned.startswith("+"):
        cleaned = cleaned[1:]
    value = float(cleaned)
    return -value if negative else value


def _parse_date(raw: str, formats: tuple[str, ...]) -> str:
    """Parses a date cell into the app's `YYYY-MM-DDTHH:MM:SS` convention.

    Raises with the value and the formats tried, rather than silently
    substituting today's date.
    """
    value = (raw or "").strip()
    if not value:
        raise ValueError("Missing date")
    for fmt in formats:
        try:
            return datetime.strptime(value, fmt).strftime("%Y-%m-%dT%H:%M:%S")
        except ValueError:
            continue
    raise ValueError(f"Unrecognized date {value!r} (tried {', '.join(formats)})")


def _identity_hash(provider: str, *parts) -> str:
    raw = "|".join([provider, *(str(p) for p in parts)])
    return hashlib.sha256(raw.encode()).hexdigest()


def _require_headers(reader, required: set[str], source_label: str) -> None:
    found = {(h or "").strip() for h in (reader.fieldnames or [])}
    missing = required - found
    if missing:
        raise ImportFormatError(
            f"This doesn't look like a {source_label} export. "
            f"Missing column(s): {', '.join(sorted(missing))}. "
            f"Found: {', '.join(sorted(h for h in found if h)) or '(no header row)'}"
        )


def _resolve(resolver, merchant_raw):
    return resolver(merchant_raw) if resolver else None


def parse_capitalone_csv(stream, resolver=None) -> tuple[list[dict], list[dict], list[dict]]:
    """Parses either Capital One export shape.

    Card statements use separate `Debit`/`Credit` columns; the 360
    checking/savings export uses a single `Transaction Amount` with a
    `Transaction Type`. Both are accepted so a checking export — the only
    place an ACH autopay (a utility bill, say) ever appears — doesn't need a
    separate source type in the UI.
    """
    transactions, errors, skipped = [], [], []
    reader = csv.DictReader(stream)
    found = {(h or "").strip() for h in (reader.fieldnames or [])}

    is_card = "Debit" in found or "Credit" in found
    is_deposit = "Transaction Amount" in found

    if is_card:
        desc_col, date_col = "Description", "Transaction Date"
        _require_headers(reader, {"Transaction Date", "Description"}, "Capital One card")
    elif is_deposit:
        desc_col = "Transaction Description" if "Transaction Description" in found else "Description"
        date_col = "Transaction Date"
        _require_headers(reader, {"Transaction Date", "Transaction Amount"}, "Capital One checking")
    else:
        raise ImportFormatError(
            "This doesn't look like a Capital One export. Expected either "
            "`Debit`/`Credit` columns (card statement) or `Transaction Amount` "
            f"(checking export). Found: {', '.join(sorted(h for h in found if h)) or '(no header row)'}"
        )

    seen = Counter()
    for row_num, row in enumerate(reader, start=2):
        try:
            description = (row.get(desc_col) or "").strip()
            if any(skip in description.upper() for skip in _CAPITALONE_SKIP):
                continue

            # Deposit accounts only: drop movements already imported elsewhere.
            if not is_card:
                mirror = _deposit_mirror_reason(description)
                if mirror:
                    skipped.append({"description": description, "reason": mirror})
                    continue

            if is_card:
                debit = _parse_money(row.get("Debit", ""))
                credit = _parse_money(row.get("Credit", ""))
                if debit is not None:
                    direction, amount = "outflow", abs(debit)
                elif credit is not None:
                    direction, amount = "inflow", abs(credit)
                else:
                    errors.append({"row": row_num, "reason": "No value in Debit or Credit", "data": dict(row)})
                    continue
            else:
                signed = _parse_money(row.get("Transaction Amount", ""))
                if signed is None:
                    errors.append({"row": row_num, "reason": "No value in Transaction Amount", "data": dict(row)})
                    continue
                txn_type = (row.get("Transaction Type") or "").strip().lower()
                if txn_type.startswith("debit") or txn_type in ("withdrawal", "payment"):
                    direction = "outflow"
                elif txn_type.startswith("credit") or txn_type == "deposit":
                    direction = "inflow"
                else:
                    # No usable type column — fall back to the sign.
                    direction = "outflow" if signed < 0 else "inflow"
                amount = abs(signed)

            transaction_at = _parse_date(
                row.get(date_col, ""), ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y")
            )

            # Capital One publishes no transaction id, so identity is the
            # content key plus how many times that exact key has already
            # appeared in this file. Card number is included where present so
            # two cards (or a card and a checking account) can't collide.
            card = (row.get("Card No.") or row.get("Account Number") or "").strip()
            content_key = (card, transaction_at, f"{amount:.2f}", description, direction)
            occurrence = seen[content_key]
            seen[content_key] += 1

            transactions.append({
                "amount": amount,
                "direction": direction,
                "merchant_raw": description,
                "category_id": _resolve(resolver, description),
                "transaction_at": transaction_at,
                "source_hash": _identity_hash("capitalone", *content_key, occurrence),
            })

        except Exception as exc:
            errors.append({"row": row_num, "reason": str(exc), "data": dict(row)})

    return transactions, errors, skipped


def parse_amex_csv(stream, resolver=None) -> tuple[list[dict], list[dict], list[dict]]:
    transactions, errors = [], []
    reader = csv.DictReader(stream)
    _require_headers(reader, {"Date", "Description", "Amount"}, "Amex")

    seen = Counter()
    for row_num, row in enumerate(reader, start=2):
        try:
            description = (row.get("Description") or "").strip()
            if any(skip in description.upper() for skip in _AMEX_SKIP):
                continue

            signed_amount = _parse_money(row.get("Amount", ""))
            if signed_amount is None:
                errors.append({"row": row_num, "reason": "No value in Amount", "data": dict(row)})
                continue

            # Amex signs charges positive and credits negative.
            direction = "outflow" if signed_amount > 0 else "inflow"
            amount = abs(signed_amount)
            transaction_at = _parse_date(row.get("Date", ""), ("%m/%d/%Y", "%Y-%m-%d", "%m/%d/%y"))

            reference = (row.get("Reference") or "").strip().strip("'")
            if reference:
                # Amex's own id is stable across exports, so it alone is the
                # identity — a row whose amount later settles differently is
                # then the same transaction, not a new one.
                source_hash = _identity_hash("amex", reference)
            else:
                content_key = (transaction_at, f"{amount:.2f}", description, direction)
                occurrence = seen[content_key]
                seen[content_key] += 1
                source_hash = _identity_hash("amex", *content_key, occurrence)

            transactions.append({
                "amount": amount,
                "direction": direction,
                "merchant_raw": description,
                "category_id": _resolve(resolver, description),
                "transaction_at": transaction_at,
                "source_hash": source_hash,
            })

        except Exception as exc:
            errors.append({"row": row_num, "reason": str(exc), "data": dict(row)})

    return transactions, errors, []


def parse_venmo_csv(stream, resolver=None) -> tuple[list[dict], list[dict], list[dict]]:
    transactions, errors = [], []

    # Venmo's CSV has two banner lines before the header row. A short file (or
    # a file of the wrong source type entirely) has fewer than two lines,
    # which used to raise an unguarded StopIteration -> 500 instead of a
    # readable error.
    try:
        next(stream)
        next(stream)
    except StopIteration:
        raise ImportFormatError("File is too short to be a Venmo export") from None

    reader = csv.DictReader(stream)
    _require_headers(reader, {"Datetime", "Type", "Amount (total)"}, "Venmo")

    for row_num, row in enumerate(reader, start=4):
        try:
            txn_id = (row.get(" ID") or row.get("ID") or "").strip()
            if not txn_id:
                continue

            txn_type = (row.get("Type") or "").strip()
            if txn_type not in ("Payment", "Charge"):
                continue

            amount_raw = (row.get("Amount (total)") or "").strip()
            if amount_raw.startswith("+"):
                direction = "inflow"
            elif amount_raw.startswith("-"):
                direction = "outflow"
            else:
                errors.append({
                    "row": row_num,
                    "reason": f"Unexpected amount format: {amount_raw!r}",
                    "data": dict(row),
                })
                continue

            parsed = _parse_money(amount_raw)
            if parsed is None:
                errors.append({"row": row_num, "reason": "No value in Amount (total)", "data": dict(row)})
                continue
            amount = abs(parsed)

            # Previously inserted raw and unvalidated, so an unexpected or
            # empty Datetime became a transaction with a blank/odd date that
            # every date filter then silently dropped.
            transaction_at = _parse_date(
                (row.get("Datetime") or "").replace("Z", "").strip(),
                ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"),
            )
            merchant_raw = (row.get("Note") or "").strip()

            from_name = (row.get("From") or row.get(" From") or "").strip()
            to_name = (row.get("To") or row.get(" To") or "").strip()
            venmo_type = "charge" if txn_type == "Charge" else "payment"
            if venmo_type == "charge":
                person = from_name if direction == "outflow" else to_name
            else:
                person = from_name if direction == "inflow" else to_name
            notes = f"venmo:{venmo_type}:{person}" if person else "venmo"

            transactions.append({
                "amount": amount,
                "direction": direction,
                "merchant_raw": merchant_raw,
                "category_id": _resolve(resolver, merchant_raw),
                "transaction_at": transaction_at,
                # Venmo's own id, read but discarded before — row position was
                # hashed instead, so a re-export re-imported everything.
                "source_hash": _identity_hash("venmo", txn_id),
                "notes": notes,
            })

        except Exception as exc:
            errors.append({"row": row_num, "reason": str(exc), "data": dict(row)})

    return transactions, errors, []
