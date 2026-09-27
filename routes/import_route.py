import io
from collections import Counter
from datetime import datetime, timezone

from flask import Blueprint, g, request

from auth.middleware import require_auth
from db_context import get_user_db
from routes.helpers import _err, _ok
from services.categorize import build_category_resolver
from services.import_service import (
    ImportFormatError,
    parse_amex_csv,
    parse_capitalone_csv,
    parse_venmo_csv,
)

bp = Blueprint("import", __name__, url_prefix="/api")

_PARSERS = {
    "capitalone": parse_capitalone_csv,
    "venmo": parse_venmo_csv,
    "amex": parse_amex_csv,
}

# Extensions that are never a CSV. Worth rejecting by name because latin-1
# decodes *any* byte sequence without raising, so a spreadsheet or PDF used to
# sail through decoding and reach the CSV reader as binary noise — producing
# hundreds of per-row errors instead of one saying "that's not a CSV".
_BINARY_EXTENSIONS = (".xlsx", ".xls", ".pdf", ".numbers", ".zip", ".ofx", ".qfx", ".qbo")


def _decode_csv(raw: bytes, filename: str) -> str:
    lowered = (filename or "").lower()
    if lowered.endswith(_BINARY_EXTENSIONS):
        raise ImportFormatError("Not a CSV file — re-export the statement as CSV and try again")
    if not raw.strip():
        raise ImportFormatError("File is empty")
    if b"\x00" in raw[:4096]:
        raise ImportFormatError("Looks like a binary file, not a CSV")
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        # A genuine fallback for Windows-exported statements. Previously this
        # was the only branch that could ever run, and its `else:` clause was
        # unreachable dead code.
        return raw.decode("latin-1")


@bp.post("/import/transactions")
@require_auth
def import_transactions():
    source_type = request.form.get("source_type", "").strip().lower()
    if source_type not in _PARSERS:
        return _err("source_type must be 'capitalone', 'venmo', or 'amex'", 400)

    files = request.files.getlist("file")
    if not files:
        return _err("At least one file is required", 400)

    parse = _PARSERS[source_type]
    conn = get_user_db(g.current_user["user_id"])
    now = datetime.now(timezone.utc).isoformat()

    # One snapshot of the merchant->category history for the whole import,
    # instead of re-running that scan once per row.
    resolver = build_category_resolver(conn)

    all_rows, all_errors, all_skipped = [], [], []
    for upload in files:
        try:
            text = _decode_csv(upload.stream.read(), upload.filename)
            rows, errors, skipped = parse(io.StringIO(text), resolver)
        except ImportFormatError as exc:
            # A whole-file problem (wrong source type, not a CSV). Reported
            # once per file rather than once per row.
            all_errors.append({"file": upload.filename, "reason": str(exc)})
            continue
        all_rows.extend(rows)
        all_errors.extend(errors)
        all_skipped.extend(skipped)

    imported = 0
    duplicates_skipped = 0

    try:
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
    except Exception:
        # Without this the connection was left dirty and only rolled back as
        # a side effect of teardown closing it.
        conn.rollback()
        raise

    # Rows dropped because they mirror money already imported from another
    # source (a card payment, a Venmo cash-out, an internal transfer).
    # Surfaced rather than dropped silently: if a pattern is wrong, it's
    # visible here on the first import instead of quietly skewing totals.
    mirror_counts = Counter((s["reason"], s["description"]) for s in all_skipped)
    skipped_internal = [
        {"reason": reason, "description": description, "count": count}
        for (reason, description), count in sorted(
            mirror_counts.items(), key=lambda kv: (-kv[1], kv[0])
        )
    ]

    return _ok(
        {
            "imported": imported,
            "duplicates_skipped": duplicates_skipped,
            "skipped_internal": skipped_internal,
            "skipped_internal_total": len(all_skipped),
            "errors": all_errors,
        }
    )
