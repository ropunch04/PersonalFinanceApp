from datetime import datetime, timezone

from flask import Blueprint, g, request

from auth.middleware import require_auth
from db_context import get_user_db

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
        limit = request.args.get("limit", default=50, type=int)
    except (TypeError, ValueError):
        return _err("Invalid query parameters", 400)

    if category_id is not None:
        rows = db.execute(
            _TXN_SELECT + "WHERE t.category_id = ? ORDER BY t.transaction_at DESC LIMIT ?",
            (category_id, limit),
        ).fetchall()
    else:
        rows = db.execute(
            _TXN_SELECT + "ORDER BY t.transaction_at DESC LIMIT ?",
            (limit,),
        ).fetchall()

    return _ok([_row_to_dict(r) for r in rows])


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

    row = db.execute(
        _TXN_SELECT + "WHERE t.id = ?", (cur.lastrowid,)
    ).fetchone()
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
