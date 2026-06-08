import io
from datetime import datetime, timezone

from flask import Blueprint, g, request

from auth.middleware import require_auth
from db_context import get_user_db
from services.import_service import parse_capitalone_csv, parse_venmo_csv

bp = Blueprint("import", __name__, url_prefix="/api")

_PARSERS = {
    "capitalone": parse_capitalone_csv,
    "venmo": parse_venmo_csv,
}


def _ok(data):
    return {"data": data, "error": None}


def _err(message, status):
    return {"data": None, "error": message}, status


@bp.post("/import/transactions")
@require_auth
def import_transactions():
    source_type = request.form.get("source_type", "").strip().lower()
    if source_type not in _PARSERS:
        return _err("source_type must be 'capitalone' or 'venmo'", 400)

    files = request.files.getlist("file")
    if not files:
        return _err("At least one file is required", 400)

    parse = _PARSERS[source_type]
    conn = get_user_db(g.current_user["user_id"])
    now = datetime.now(timezone.utc).isoformat()

    all_rows, all_errors = [], []
    for upload in files:
        stream = io.StringIO(upload.stream.read().decode("utf-8-sig"))
        rows, errors = parse(stream, conn)
        all_rows.extend(rows)
        all_errors.extend(errors)

    imported = 0
    duplicates_skipped = 0

    for row in all_rows:
        cur = conn.execute(
            """
            INSERT OR IGNORE INTO transactions
                (source_hash, category_id, amount, merchant_raw,
                 direction, notes, transaction_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row["source_hash"],
                row["category_id"],
                row["amount"],
                row["merchant_raw"],
                row["direction"],
                row.get("notes"),
                row["transaction_at"],
                now,
            ),
        )
        if cur.rowcount == 1:
            imported += 1
        else:
            duplicates_skipped += 1

    conn.commit()

    return _ok(
        {
            "imported": imported,
            "duplicates_skipped": duplicates_skipped,
            "errors": all_errors,
        }
    )
