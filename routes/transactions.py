import re
from datetime import datetime, timezone

from flask import Blueprint, g, request

from auth.middleware import require_auth
from db_context import get_user_db


def _merchant_prefix(name: str) -> str:
    cleaned = re.sub(r"\s+[#*]?\d{3,}.*$", "", name.strip()).strip()
    return cleaned if cleaned else name.strip()

bp = Blueprint("transactions", __name__, url_prefix="/api")

_TXN_SELECT = """
    SELECT t.id, t.amount, t.merchant_raw, t.direction, t.category_id,
           c.name AS category_name, t.notes, t.transaction_at, t.created_at
    FROM transactions t
    LEFT JOIN categories c ON t.category_id = c.id
"""


def _ok(data):
    return {"data": data, "error": None}


def _err(message, status):
    return {"data": None, "error": message}, status


def _row_to_dict(row) -> dict:
    return dict(row)


@bp.get("/transactions")
@require_auth
def list_transactions():
    db = get_user_db(g.current_user["user_id"])

    try:
        category_id = request.args.get("category_id", type=int)
        limit = min(request.args.get("limit", default=25, type=int), 200)
        offset = max(request.args.get("offset", default=0, type=int), 0)
        date_from = request.args.get("date_from")
        date_to = request.args.get("date_to")
    except (TypeError, ValueError):
        return _err("Invalid query parameters", 400)

    uncategorized = request.args.get("uncategorized", "false").lower() == "true"

    where_clauses = []
    params: list = []

    if uncategorized:
        where_clauses.append("t.category_id IS NULL")
    elif category_id is not None:
        where_clauses.append("t.category_id = ?")
        params.append(category_id)
    if date_from:
        where_clauses.append("t.transaction_at >= ?")
        params.append(date_from)
    if date_to:
        where_clauses.append("t.transaction_at <= ?")
        params.append(date_to + "T23:59:59")

    where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""

    total = db.execute(
        f"SELECT COUNT(*) FROM transactions t {where_sql}", params
    ).fetchone()[0]
    rows = db.execute(
        _TXN_SELECT + f"{where_sql} ORDER BY t.transaction_at DESC LIMIT ? OFFSET ?",
        params + [limit, offset],
    ).fetchall()

    return _ok({
        "transactions": [_row_to_dict(r) for r in rows],
        "total": total,
        "limit": limit,
        "offset": offset,
    })


@bp.post("/transactions")
@require_auth
def create_transaction():
    db = get_user_db(g.current_user["user_id"])
    body = request.get_json(silent=True) or {}

    amount = body.get("amount")
    direction = body.get("direction")
    transaction_at = body.get("transaction_at")

    if amount is None or direction is None or transaction_at is None:
        return _err("amount, direction, and transaction_at are required", 400)

    try:
        amount = float(amount)
    except (TypeError, ValueError):
        return _err("amount must be a number", 400)

    if direction not in ("inflow", "outflow"):
        return _err("direction must be 'inflow' or 'outflow'", 400)

    created_at = datetime.now(timezone.utc).isoformat()

    cur = db.execute(
        """
        INSERT INTO transactions
            (amount, merchant_raw, direction, category_id, notes, transaction_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            amount,
            body.get("merchant_raw"),
            direction,
            body.get("category_id"),
            body.get("notes"),
            transaction_at,
            created_at,
        ),
    )
    db.commit()

    row = db.execute(_TXN_SELECT + "WHERE t.id = ?", (cur.lastrowid,)).fetchone()
    return _ok(_row_to_dict(row)), 201


@bp.get("/transactions/<int:txn_id>")
@require_auth
def get_transaction(txn_id):
    db = get_user_db(g.current_user["user_id"])
    row = db.execute(_TXN_SELECT + "WHERE t.id = ?", (txn_id,)).fetchone()
    if row is None:
        return _err("Transaction not found", 404)
    return _ok(_row_to_dict(row))


@bp.put("/transactions/<int:txn_id>")
@require_auth
def update_transaction(txn_id):
    db = get_user_db(g.current_user["user_id"])

    existing = db.execute("SELECT id FROM transactions WHERE id = ?", (txn_id,)).fetchone()
    if existing is None:
        return _err("Transaction not found", 404)

    body = request.get_json(silent=True) or {}
    allowed = {"amount", "direction", "merchant_raw", "category_id", "notes", "transaction_at"}
    updates = {k: v for k, v in body.items() if k in allowed}

    if not updates:
        return _err("No updatable fields provided", 400)

    if "direction" in updates and updates["direction"] not in ("inflow", "outflow"):
        return _err("direction must be 'inflow' or 'outflow'", 400)

    if "amount" in updates:
        try:
            updates["amount"] = float(updates["amount"])
        except (TypeError, ValueError):
            return _err("amount must be a number", 400)

    set_clause = ", ".join(f"{col} = ?" for col in updates)
    values = list(updates.values()) + [txn_id]
    db.execute(f"UPDATE transactions SET {set_clause} WHERE id = ?", values)
    db.commit()

    row = db.execute(_TXN_SELECT + "WHERE t.id = ?", (txn_id,)).fetchone()
    return _ok(_row_to_dict(row))


@bp.delete("/transactions/<int:txn_id>")
@require_auth
def delete_transaction(txn_id):
    db = get_user_db(g.current_user["user_id"])

    existing = db.execute("SELECT id FROM transactions WHERE id = ?", (txn_id,)).fetchone()
    if existing is None:
        return _err("Transaction not found", 404)

    db.execute("DELETE FROM transactions WHERE id = ?", (txn_id,))
    db.commit()
    return _ok({"deleted": True})


@bp.get("/transactions/merchants/unclassified")
@require_auth
def unclassified_merchants():
    db = get_user_db(g.current_user["user_id"])
    rows = db.execute(
        "SELECT merchant_raw, COUNT(*) as count FROM transactions WHERE category_id IS NULL GROUP BY merchant_raw"
    ).fetchall()

    groups: dict[str, dict] = {}
    for row in rows:
        prefix = _merchant_prefix(row["merchant_raw"])
        if prefix not in groups:
            groups[prefix] = {"prefix": prefix, "count": 0, "example": row["merchant_raw"]}
        groups[prefix]["count"] += row["count"]

    return _ok(sorted(groups.values(), key=lambda x: -x["count"]))


@bp.post("/transactions/auto-classify")
@require_auth
def auto_classify():
    db = get_user_db(g.current_user["user_id"])

    uncategorized = db.execute(
        "SELECT id, merchant_raw FROM transactions WHERE category_id IS NULL"
    ).fetchall()

    if not uncategorized:
        return _ok({"classified": 0, "unmatched": 0})

    prefix_groups: dict[str, list[int]] = {}
    for row in uncategorized:
        prefix = _merchant_prefix(row["merchant_raw"])
        prefix_groups.setdefault(prefix, []).append(row["id"])

    classified = 0
    unmatched = 0

    for prefix, ids in prefix_groups.items():
        best = db.execute(
            """
            SELECT category_id, COUNT(*) AS freq
            FROM transactions
            WHERE category_id IS NOT NULL AND merchant_raw LIKE ?
            GROUP BY category_id
            ORDER BY freq DESC
            LIMIT 1
            """,
            (f"{prefix}%",),
        ).fetchone()

        if best:
            placeholders = ",".join("?" * len(ids))
            db.execute(
                f"UPDATE transactions SET category_id = ? WHERE id IN ({placeholders})",
                [best["category_id"]] + ids,
            )
            classified += len(ids)
        else:
            unmatched += len(ids)

    db.commit()
    return _ok({"classified": classified, "unmatched": unmatched})


@bp.post("/transactions/bulk-categorize")
@require_auth
def bulk_categorize():
    db = get_user_db(g.current_user["user_id"])
    body = request.get_json(silent=True) or {}
    merchant_raw = body.get("merchant_raw", "").strip()
    category_id = body.get("category_id")

    if not merchant_raw or category_id is None:
        return _err("merchant_raw and category_id are required", 400)

    prefix = _merchant_prefix(merchant_raw)
    result = db.execute(
        "UPDATE transactions SET category_id = ? WHERE category_id IS NULL AND merchant_raw LIKE ?",
        (category_id, f"{prefix}%"),
    )
    db.commit()
    return _ok({"updated": result.rowcount, "prefix": prefix})
