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
           c.name AS category_name, t.notes, t.transaction_at, t.created_at,
           t.reimburses_id,
           rt.merchant_raw    AS reimburses_merchant,
           rt.amount          AS reimburses_amount,
           rt.transaction_at  AS reimburses_date,
           (SELECT COUNT(*)                    FROM transactions ri WHERE ri.reimburses_id = t.id) AS reimbursed_by_count,
           (SELECT COALESCE(SUM(ri.amount), 0) FROM transactions ri WHERE ri.reimburses_id = t.id) AS reimbursed_by_total
    FROM transactions t
    LEFT JOIN categories c  ON t.category_id = c.id
    LEFT JOIN transactions rt ON rt.id = t.reimburses_id
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
    status = request.args.get("status")
    q = request.args.get("q", "").strip()
    source = request.args.get("source", "")

    where_clauses = []
    params: list = []

    if uncategorized or status == "pending":
        where_clauses.append("t.category_id IS NULL")
    elif status == "confirmed":
        where_clauses.append("t.category_id IS NOT NULL")
    elif category_id is not None:
        where_clauses.append("t.category_id = ?")
        params.append(category_id)
    if date_from:
        where_clauses.append("t.transaction_at >= ?")
        params.append(date_from)
    if date_to:
        where_clauses.append("t.transaction_at <= ?")
        params.append(date_to + "T23:59:59")
    if q:
        where_clauses.append(
            "(t.merchant_raw LIKE ? OR t.notes LIKE ? OR CAST(t.amount AS TEXT) LIKE ?)"
        )
        like = f"%{q}%"
        params.extend([like, like, like])
    if source == "venmo":
        where_clauses.append("(t.notes LIKE 'venmo:%' OR t.notes = 'venmo')")
    elif source == "credit":
        where_clauses.append("(t.notes IS NULL OR (t.notes NOT LIKE 'venmo:%' AND t.notes != 'venmo'))")

    include_ids_raw = request.args.get("include_ids", "")
    include_ids: list[int] = []
    if include_ids_raw:
        try:
            include_ids = [int(x) for x in include_ids_raw.split(",") if x.strip()]
        except ValueError:
            pass

    if include_ids:
        ph = ",".join("?" * len(include_ids))
        base = " AND ".join(where_clauses)
        where_sql = f"WHERE ({base}) OR t.id IN ({ph})" if base else f"WHERE t.id IN ({ph})"
        extra_params = include_ids
    else:
        where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
        extra_params = []

    _SORT_MAP = {
        "date_desc":    "t.transaction_at DESC",
        "date_asc":     "t.transaction_at ASC",
        "amount_desc":  "t.amount DESC",
        "amount_asc":   "t.amount ASC",
        "merchant_asc": "t.merchant_raw ASC NULLS LAST",
    }
    sort_key = request.args.get("sort", "date_desc")
    order_by = _SORT_MAP.get(sort_key, "t.transaction_at DESC")

    total = db.execute(
        f"SELECT COUNT(*) FROM transactions t {where_sql}", params + extra_params
    ).fetchone()[0]
    rows = db.execute(
        _TXN_SELECT + f"{where_sql} ORDER BY {order_by} LIMIT ? OFFSET ?",
        params + extra_params + [limit, offset],
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
    allowed = {"amount", "direction", "merchant_raw", "category_id", "notes", "transaction_at", "reimburses_id"}
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

    if "reimburses_id" in updates:
        rid = updates["reimburses_id"]
        if rid is not None:
            if rid == txn_id:
                return _err("A transaction cannot reimburse itself", 400)
            target = db.execute(
                "SELECT id, direction FROM transactions WHERE id = ?", (rid,)
            ).fetchone()
            if target is None:
                return _err("Linked transaction not found", 404)
            if target["direction"] != "outflow":
                return _err("reimburses_id must point to an outflow transaction", 400)

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

    db.execute("UPDATE transactions SET reimburses_id = NULL WHERE reimburses_id = ?", (txn_id,))
    db.execute("DELETE FROM transactions WHERE id = ?", (txn_id,))
    db.commit()
    return _ok({"deleted": True})


@bp.get("/transactions/merchants/unclassified")
@require_auth
def unclassified_merchants():
    db = get_user_db(g.current_user["user_id"])
    rows = db.execute(
        "SELECT merchant_raw, COUNT(*) as count FROM transactions WHERE category_id IS NULL AND (notes IS NULL OR notes NOT LIKE 'venmo:%') GROUP BY merchant_raw"
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
        "SELECT id, merchant_raw FROM transactions WHERE category_id IS NULL AND (notes IS NULL OR notes NOT LIKE 'venmo:%')"
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


@bp.get("/transactions/linkable-outflows")
@require_auth
def linkable_outflows():
    db = get_user_db(g.current_user["user_id"])
    q = request.args.get("q", "").strip()
    limit = min(request.args.get("limit", default=20, type=int), 100)

    where = "WHERE t.direction = 'outflow'"
    params = []
    if q:
        where += " AND t.merchant_raw LIKE ?"
        params.append(f"%{q}%")

    rows = db.execute(f"""
        SELECT t.id, t.amount, t.merchant_raw, t.transaction_at,
               c.name AS category_name
        FROM transactions t
        LEFT JOIN categories c ON t.category_id = c.id
        {where}
        ORDER BY t.transaction_at DESC
        LIMIT ?
    """, params + [limit]).fetchall()

    return _ok([dict(r) for r in rows])


@bp.get("/transactions/duplicates")
@require_auth
def find_duplicates():
    db = get_user_db(g.current_user["user_id"])

    rows = db.execute("""
        SELECT t.id, t.amount, t.merchant_raw, t.direction,
               t.transaction_at, t.notes, c.name AS category_name
        FROM transactions t
        LEFT JOIN categories c ON t.category_id = c.id
        INNER JOIN (
            SELECT transaction_at, amount, merchant_raw, direction
            FROM transactions
            GROUP BY transaction_at, amount, merchant_raw, direction
            HAVING COUNT(*) > 1
        ) dups
            ON  t.transaction_at = dups.transaction_at
            AND t.amount         = dups.amount
            AND COALESCE(t.merchant_raw, '') = COALESCE(dups.merchant_raw, '')
            AND t.direction      = dups.direction
        ORDER BY t.merchant_raw, t.transaction_at, t.amount, t.id
    """).fetchall()

    from collections import OrderedDict
    groups = OrderedDict()
    for r in rows:
        key = f"{r['transaction_at']}|{r['amount']}|{r['merchant_raw']}|{r['direction']}"
        groups.setdefault(key, []).append(dict(r))

    return _ok({"groups": list(groups.values())})
