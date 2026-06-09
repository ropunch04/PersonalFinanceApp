import csv
import hashlib
from datetime import datetime

_CAPITALONE_SKIP = ("AUTOPAY PYMT", "MOBILE PYMT")


def _source_hash(
    provider: str, transaction_at: str, amount: float, merchant_raw: str, row_num: int
) -> str:
    raw = f"{provider}|{transaction_at}|{amount}|{merchant_raw}|{row_num}"
    return hashlib.sha256(raw.encode()).hexdigest()


def _get_category_id(conn, merchant_raw: str) -> int | None:
    row = conn.execute(
        "SELECT id FROM categories WHERE LOWER(name) = LOWER(?)", (merchant_raw,)
    ).fetchone()
    return row["id"] if row else None


def _parse_amount(raw: str) -> float:
    return float(raw.replace("+", "").replace("-", "").replace("$", "").replace(",", "").strip())


def parse_capitalone_csv(stream, conn) -> tuple[list[dict], list[dict]]:
    transactions, errors = [], []

    reader = csv.DictReader(stream)
    for row_num, row in enumerate(reader, start=2):
        try:
            description = row.get("Description", "").strip()
            if any(skip in description for skip in _CAPITALONE_SKIP):
                continue

            debit = row.get("Debit", "").strip()
            credit = row.get("Credit", "").strip()

            if debit:
                direction, amount = "outflow", float(debit)
            elif credit:
                direction, amount = "inflow", float(credit)
            else:
                errors.append(
                    {"row": row_num, "reason": "No value in Debit or Credit", "data": dict(row)}
                )
                continue

            date_str = row.get("Transaction Date", "").strip()
            transaction_at = datetime.strptime(date_str, "%Y-%m-%d").strftime("%Y-%m-%dT00:00:00")

            transactions.append(
                {
                    "amount": amount,
                    "direction": direction,
                    "merchant_raw": description,
                    "category_id": _get_category_id(conn, description),
                    "transaction_at": transaction_at,
                    "source_hash": _source_hash(
                        "capitalone", transaction_at, amount, description, row_num
                    ),
                }
            )

        except Exception as exc:
            errors.append({"row": row_num, "reason": str(exc), "data": dict(row)})

    return transactions, errors


def parse_venmo_csv(stream, conn) -> tuple[list[dict], list[dict]]:
    transactions, errors = [], []

    next(stream)
    next(stream)

    reader = csv.DictReader(stream)
    for row_num, row in enumerate(reader, start=4):
        try:
            txn_id = row.get(" ID", row.get("ID", "")).strip()
            if not txn_id:
                continue

            txn_type = row.get("Type", "").strip()
            if txn_type not in ("Payment", "Charge"):
                continue

            amount_raw = row.get("Amount (total)", "").strip()
            if amount_raw.startswith("+"):
                direction = "inflow"
            elif amount_raw.startswith("-"):
                direction = "outflow"
            else:
                errors.append(
                    {
                        "row": row_num,
                        "reason": f"Unexpected amount format: {amount_raw!r}",
                        "data": dict(row),
                    }
                )
                continue

            amount = _parse_amount(amount_raw)
            transaction_at = row.get("Datetime", "").strip()
            merchant_raw = row.get("Note", "").strip()

            from_name = (row.get("From") or row.get(" From") or "").strip()
            to_name = (row.get("To") or row.get(" To") or "").strip()
            venmo_type = "charge" if txn_type == "Charge" else "payment"
            if venmo_type == "charge":
                person = from_name if direction == "outflow" else to_name
            else:
                person = from_name if direction == "inflow" else to_name
            notes = f"venmo:{venmo_type}:{person}" if person else "venmo"

            transactions.append(
                {
                    "amount": amount,
                    "direction": direction,
                    "merchant_raw": merchant_raw,
                    "category_id": _get_category_id(conn, merchant_raw),
                    "transaction_at": transaction_at,
                    "source_hash": _source_hash(
                        "venmo", transaction_at, amount, merchant_raw, row_num
                    ),
                    "notes": notes,
                }
            )

        except Exception as exc:
            errors.append({"row": row_num, "reason": str(exc), "data": dict(row)})

    return transactions, errors
