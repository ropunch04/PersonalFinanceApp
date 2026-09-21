from datetime import datetime, timezone

from flask import Blueprint, g, request

from auth.middleware import require_auth
from db_context import get_user_db
from routes.helpers import _err, _ok
from services.budget_service import _excluded_sql
from services.categorize import merchant_prefix, resolve_category_id

bp = Blueprint("transactions", __name__, url_prefix="/api")

_TXN_SELECT = f"""
    SELECT t.id, t.amount, t.merchant_raw, t.direction, t.category_id,
           c.name AS category_name, t.notes, t.transaction_at, t.created_at,
           t.expected_reimbursement, t.reimbursement_external,
           {_excluded_sql("t")} AS reimbursement_excluded_amount,
           (SELECT COUNT(*)
              FROM reimbursement_links rl WHERE rl.outflow_id = t.id) AS reimbursed_by_count,
           (SELECT COALESCE(SUM(rl.amount), 0)
              FROM reimbursement_links rl WHERE rl.outflow_id = t.id) AS reimbursed_by_total,
           (SELECT COALESCE(SUM(rl.amount), 0)
              FROM reimbursement_links rl WHERE rl.inflow_id = t.id)  AS applied_total,
           CASE
               WHEN t.direction = 'outflow' AND t.expected_reimbursement IS NOT NULL
                    AND t.reimbursement_external = 0
                   THEN MAX(0, t.expected_reimbursement - (
                       SELECT COALESCE(SUM(rl.amount), 0)
                       FROM reimbursement_links rl WHERE rl.outflow_id = t.id
                   ))
               ELSE NULL
           END AS outstanding
    FROM transactions t
    LEFT JOIN categories c ON t.category_id = c.id
"""


def _row_to_dict(row) -> dict:
    return dict(row)


def _detach_references(db, txn_id: int) -> None:
    """Clear the legacy reimburses_id pointer on any row that references
    txn_id, so deleting/splitting txn_id doesn't hit an IntegrityError under
    PRAGMA foreign_keys=ON. Must run in the same transaction as the delete."""
    db.execute("UPDATE transactions SET reimburses_id = NULL WHERE reimburses_id = ?", (txn_id,))


def _linked_reimbursement_count(db, txn_id: int) -> int:
    return db.execute(
        "SELECT COUNT(*) AS n FROM reimbursement_links WHERE outflow_id = ? OR inflow_id = ?",
        (txn_id, txn_id),
    ).fetchone()["n"]


def _like_escape(raw: str) -> str:
    """Escapes %, _, and \\ for a LIKE pattern using ESCAPE '\\'. Without this,
    a merchant name that itself contains % or _ (7 in prod) turns a prefix
    match into an unintended wildcard match."""
    return raw.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


@bp.get("/transactions")
@require_auth
def list_transactions():
    db = get_user_db(g.current_user["user_id"])

    category_id = request.args.get("category_id", type=int)
    # request.args.get(type=int) returns the default on a bad value instead of
    # raising, so the try/except this used to be wrapped in never actually
    # fired — bad input was silently coerced rather than rejected. `?limit=-1`
    # in particular became `LIMIT -1`, i.e. unlimited, in the query below.
    limit = max(1, min(request.args.get("limit", default=25, type=int), 200))
    offset = max(request.args.get("offset", default=0, type=int), 0)
    date_from = request.args.get("date_from")
    date_to = request.args.get("date_to")

    uncategorized = request.args.get("uncategorized", "false").lower() == "true"
    status = request.args.get("status")
    q = request.args.get("q", "").strip()
    source = request.args.get("source", "")

    where_clauses = []
    params: list = []

    # Independent AND clauses — status and category_id used to be an if/elif,
    # so picking both in the UI silently dropped one of them.
    if uncategorized or status == "pending":
        where_clauses.append("t.category_id IS NULL AND t.direction = 'outflow'")
    elif status == "confirmed":
        where_clauses.append("t.category_id IS NOT NULL")
    if category_id is not None:
        where_clauses.append("t.category_id = ?")
        params.append(category_id)
    if date_from:
        where_clauses.append("t.transaction_at >= ?")
        params.append(date_from)
    if date_to:
        where_clauses.append("t.transaction_at <= ?")
        params.append(date_to + "T23:59:59")
    if q:
        # Escape LIKE's own wildcard characters in user input so a merchant
        # name containing a literal % or _ (7 in prod) is matched exactly
        # instead of as a wildcard.
        where_clauses.append(
            "(t.merchant_raw LIKE ? ESCAPE '\\' OR t.notes LIKE ? ESCAPE '\\' "
            "OR CAST(t.amount AS TEXT) LIKE ? ESCAPE '\\')"
        )
        like = f"%{_like_escape(q)}%"
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
        "date_desc":    "t.transaction_at DESC, t.created_at DESC, t.id DESC",
        "date_asc":     "t.transaction_at ASC, t.created_at ASC, t.id ASC",
        "amount_desc":  "t.amount DESC, t.transaction_at DESC, t.created_at DESC, t.id DESC",
        "amount_asc":   "t.amount ASC, t.transaction_at DESC, t.created_at DESC, t.id DESC",
        "merchant_asc": "t.merchant_raw ASC NULLS LAST, t.transaction_at DESC, t.created_at DESC, t.id DESC",
    }
    sort_key = request.args.get("sort", "date_desc")
    order_by = _SORT_MAP.get(sort_key, "t.transaction_at DESC, t.created_at DESC, t.id DESC")

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

    if isinstance(transaction_at, str) and len(transaction_at) == 10:
        transaction_at = f"{transaction_at}T00:00:00"

    try:
        amount = float(amount)
    except (TypeError, ValueError):
        return _err("amount must be a number", 400)

    if amount < 0:
        return _err("amount cannot be negative", 400)

    if direction not in ("inflow", "outflow"):
        return _err("direction must be 'inflow' or 'outflow'", 400)

    created_at = datetime.now(timezone.utc).isoformat()

    category_id = body.get("category_id")
    if category_id is None and body.get("merchant_raw"):
        category_id = resolve_category_id(db, body.get("merchant_raw"))

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
            category_id,
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

    existing = db.execute(
        "SELECT id, amount, direction, expected_reimbursement, reimbursement_external FROM transactions WHERE id = ?",
        (txn_id,),
    ).fetchone()
    if existing is None:
        return _err("Transaction not found", 404)

    body = request.get_json(silent=True) or {}
    allowed = {
        "amount", "direction", "merchant_raw", "category_id", "notes",
        "transaction_at", "expected_reimbursement", "reimbursement_external",
    }
    updates = {k: v for k, v in body.items() if k in allowed}

    if not updates:
        return _err("No updatable fields provided", 400)

    if "transaction_at" in updates and isinstance(updates["transaction_at"], str) and len(updates["transaction_at"]) == 10:
        updates["transaction_at"] = f"{updates['transaction_at']}T00:00:00"

    if "direction" in updates and updates["direction"] not in ("inflow", "outflow"):
        return _err("direction must be 'inflow' or 'outflow'", 400)

    final_direction = updates.get("direction", existing["direction"])
    if final_direction != existing["direction"]:
        linked = db.execute(
            "SELECT COUNT(*) AS n FROM reimbursement_links WHERE outflow_id = ? OR inflow_id = ?",
            (txn_id, txn_id),
        ).fetchone()["n"]
        if linked > 0:
            return _err(
                "This transaction has linked reimbursement payments — unlink those before changing its direction",
                409,
            )
        if final_direction == "inflow":
            if "expected_reimbursement" not in updates:
                updates["expected_reimbursement"] = None
            if "reimbursement_external" not in updates:
                updates["reimbursement_external"] = 0

    if "amount" in updates:
        try:
            updates["amount"] = float(updates["amount"])
        except (TypeError, ValueError):
            return _err("amount must be a number", 400)
        if updates["amount"] < 0:
            return _err("amount cannot be negative", 400)

        if final_direction == "inflow":
            applied = db.execute(
                "SELECT COALESCE(SUM(amount), 0) AS n FROM reimbursement_links WHERE inflow_id = ?",
                (txn_id,),
            ).fetchone()["n"]
            if updates["amount"] < applied - 1e-6:
                return _err(f"Amount cannot be less than ${applied:.2f} already applied to reimbursements", 400)
        else:
            received = db.execute(
                "SELECT COALESCE(SUM(amount), 0) AS n FROM reimbursement_links WHERE outflow_id = ?",
                (txn_id,),
            ).fetchone()["n"]
            if updates["amount"] < received - 1e-6:
                return _err(f"Amount cannot be less than ${received:.2f} already received from reimbursements", 400)

    final_amount = updates.get("amount", existing["amount"])

    if "expected_reimbursement" in updates:
        value = updates["expected_reimbursement"]
        if value is not None:
            try:
                value = float(value)
            except (TypeError, ValueError):
                return _err("expected_reimbursement must be a number or null", 400)
            if value < 0:
                return _err("expected_reimbursement cannot be negative", 400)
            if value > final_amount + 1e-6:
                return _err("expected_reimbursement cannot exceed transaction amount", 400)
            if final_direction != "outflow":
                return _err("expected_reimbursement can only be set on outflow (debit) transactions", 400)
            updates["expected_reimbursement"] = value

    if "reimbursement_external" in updates:
        external = bool(updates["reimbursement_external"])
        if external:
            if final_direction != "outflow":
                return _err("reimbursement_external can only be set on outflow (debit) transactions", 400)
            # "External" means this charge settles outside the app (e.g. payroll) —
            # it shouldn't also have real linked payments, or the two ways of
            # tracking it would disagree about whether it's been paid.
            linked = db.execute(
                "SELECT COUNT(*) AS n FROM reimbursement_links WHERE outflow_id = ?", (txn_id,)
            ).fetchone()["n"]
            if linked > 0:
                return _err(
                    "This charge already has linked payments applied to it — unlink those "
                    "first, or leave it trackable instead of marking it settled outside the app",
                    409,
                )
        updates["reimbursement_external"] = int(external)

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

    # reimbursement_links rows pointing at this transaction cascade-delete
    # silently (ON DELETE CASCADE). Require the caller to acknowledge that
    # before it happens, unless update_transaction's own direction-flip guard
    # already would have refused — deletion is the one path that doesn't ask.
    linked = _linked_reimbursement_count(db, txn_id)
    if linked > 0 and request.args.get("force", "").lower() != "true":
        return _err(
            f"This will also remove {linked} linked reimbursement"
            f"{'s' if linked != 1 else ''} — pass ?force=true to confirm",
            409,
        )

    _detach_references(db, txn_id)
    db.execute("DELETE FROM transactions WHERE id = ?", (txn_id,))
    db.commit()
    return _ok({"deleted": True})


@bp.post("/transactions/<int:txn_id>/split")
@require_auth
def split_transaction(txn_id):
    db = get_user_db(g.current_user["user_id"])

    existing = db.execute(
        "SELECT id, amount, merchant_raw, direction, notes, transaction_at, created_at, "
        "source_hash, expected_reimbursement FROM transactions WHERE id = ?",
        (txn_id,),
    ).fetchone()
    if existing is None:
        return _err("Transaction not found", 404)

    body = request.get_json(silent=True) or {}
    parts = body.get("parts")
    if not isinstance(parts, list) or len(parts) < 2:
        return _err("parts must be a list of at least 2 pieces", 400)

    cleaned = []
    total = 0.0
    for part in parts:
        if not isinstance(part, dict):
            return _err("Each part must be an object", 400)
        try:
            amount = float(part.get("amount"))
        except (TypeError, ValueError):
            return _err("Each part needs a numeric amount", 400)
        if amount <= 0:
            return _err("Each part's amount must be greater than 0", 400)
        total += amount
        merchant_raw = (part.get("merchant_raw") or "").strip() or existing["merchant_raw"]
        cleaned.append({
            "amount": amount,
            "category_id": part.get("category_id"),
            "merchant_raw": merchant_raw,
            "notes": part.get("notes") if part.get("notes") not in (None, "") else existing["notes"],
        })

    if abs(total - existing["amount"]) > 0.01:
        return _err(
            f"Parts must add up to the original amount (${existing['amount']:.2f}), got ${total:.2f}",
            400,
        )

    if existing["expected_reimbursement"] is not None:
        return _err("Clear this transaction's reimbursement expectation before splitting it", 409)

    linked = _linked_reimbursement_count(db, txn_id)
    if linked > 0:
        return _err(
            "This transaction has linked reimbursement payments — unlink those before splitting it",
            409,
        )

    # Delete the original first (within this same uncommitted transaction) so
    # inserting a new row that reuses its source_hash below doesn't collide
    # with the UNIQUE constraint. Detach first — otherwise, with
    # PRAGMA foreign_keys=ON, deleting a row another transaction's
    # reimburses_id still points at raises an IntegrityError (500).
    _detach_references(db, txn_id)
    db.execute("DELETE FROM transactions WHERE id = ?", (txn_id,))

    created_ids = []
    for i, part in enumerate(cleaned):
        if existing["source_hash"] is None:
            source_hash = None
        elif i == 0:
            # Preserve the original hash on the first part so a future
            # re-import or re-sync of the same source row is still recognized
            # as a duplicate, instead of resurrecting the un-split transaction.
            source_hash = existing["source_hash"]
        else:
            source_hash = f"{existing['source_hash']}:split{i}"

        category_id = part["category_id"]
        if category_id is None and part["merchant_raw"]:
            category_id = resolve_category_id(db, part["merchant_raw"])

        cur = db.execute(
            """
            INSERT INTO transactions
                (amount, merchant_raw, direction, category_id, notes,
                 transaction_at, created_at, source_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                part["amount"],
                part["merchant_raw"],
                existing["direction"],
                category_id,
                part["notes"],
                existing["transaction_at"],
                existing["created_at"],
                source_hash,
            ),
        )
        created_ids.append(cur.lastrowid)

    db.commit()

    placeholders = ",".join("?" * len(created_ids))
    rows = db.execute(
        _TXN_SELECT + f"WHERE t.id IN ({placeholders}) ORDER BY t.id", created_ids
    ).fetchall()
    return _ok([_row_to_dict(r) for r in rows]), 201


@bp.get("/transactions/merchants/unclassified")
@require_auth
def unclassified_merchants():
    db = get_user_db(g.current_user["user_id"])
    rows = db.execute(
        "SELECT merchant_raw, COUNT(*) as count FROM transactions "
        "WHERE category_id IS NULL AND direction = 'outflow' AND (notes IS NULL OR notes NOT LIKE 'venmo:%') "
        "GROUP BY merchant_raw"
    ).fetchall()

    groups: dict[str, dict] = {}
    for row in rows:
        prefix = merchant_prefix(row["merchant_raw"])
        if prefix not in groups:
            groups[prefix] = {"prefix": prefix, "count": 0, "example": row["merchant_raw"]}
        groups[prefix]["count"] += row["count"]

    return _ok(sorted(groups.values(), key=lambda x: -x["count"]))


@bp.post("/transactions/auto-classify")
@require_auth
def auto_classify():
    db = get_user_db(g.current_user["user_id"])

    uncategorized = db.execute(
        "SELECT id, merchant_raw FROM transactions "
        "WHERE category_id IS NULL AND direction = 'outflow' AND (notes IS NULL OR notes NOT LIKE 'venmo:%')"
    ).fetchall()

    if not uncategorized:
        return _ok({"classified": 0, "unmatched": 0})

    prefix_groups: dict[str, list[int]] = {}
    for row in uncategorized:
        prefix = merchant_prefix(row["merchant_raw"])
        prefix_groups.setdefault(prefix, []).append(row["id"])

    classified = 0
    unmatched = 0

    for prefix, ids in prefix_groups.items():
        best = db.execute(
            """
            SELECT category_id, COUNT(*) AS freq
            FROM transactions
            WHERE category_id IS NOT NULL AND merchant_raw LIKE ? ESCAPE '\\'
            GROUP BY category_id
            ORDER BY freq DESC
            LIMIT 1
            """,
            (f"{_like_escape(prefix)}%",),
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

    prefix = merchant_prefix(merchant_raw)
    result = db.execute(
        # direction='outflow' matches the unclassified-merchants list this is
        # driven from (:489) — without it, an inflow sharing the same prefix
        # (e.g. a refund) got silently categorized too, though the user never
        # saw it in the list they picked "categorize all of these" from.
        "UPDATE transactions SET category_id = ? "
        "WHERE category_id IS NULL AND direction = 'outflow' AND merchant_raw LIKE ? ESCAPE '\\'",
        (category_id, f"{_like_escape(prefix)}%"),
    )
    db.commit()
    return _ok({"updated": result.rowcount, "prefix": prefix})


@bp.post("/transactions/reclassify")
@require_auth
def reclassify():
    db = get_user_db(g.current_user["user_id"])
    body = request.get_json(silent=True) or {}
    merchant_raw = body.get("merchant_raw", "").strip()
    from_id = body.get("from_category_id")
    to_id = body.get("to_category_id")

    if not merchant_raw or from_id is None or to_id is None:
        return _err("merchant_raw, from_category_id and to_category_id are required", 400)
    if from_id == to_id:
        return _err("from and to categories must differ", 400)

    prefix = merchant_prefix(merchant_raw)
    result = db.execute(
        "UPDATE transactions SET category_id = ? WHERE category_id = ? AND merchant_raw LIKE ? ESCAPE '\\'",
        (to_id, from_id, f"{_like_escape(prefix)}%"),
    )
    db.commit()
    return _ok({"updated": result.rowcount, "prefix": prefix})


@bp.get("/transactions/linkable-outflows")
@require_auth
def linkable_outflows():
    db = get_user_db(g.current_user["user_id"])
    q = request.args.get("q", "").strip()
    limit = min(request.args.get("limit", default=20, type=int), 100)

    where = "WHERE t.direction = 'outflow' AND t.reimbursement_external = 0"
    params = []
    if q:
        where += " AND t.merchant_raw LIKE ? ESCAPE '\\'"
        params.append(f"%{_like_escape(q)}%")

    rows = db.execute(f"""
        SELECT t.id, t.amount, t.merchant_raw, t.transaction_at,
               c.name AS category_name, t.expected_reimbursement,
               (SELECT COALESCE(SUM(rl.amount), 0)
                  FROM reimbursement_links rl WHERE rl.outflow_id = t.id) AS received_total
        FROM transactions t
        LEFT JOIN categories c ON t.category_id = c.id
        {where}
        ORDER BY t.transaction_at DESC, t.created_at DESC, t.id DESC
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
            -- Two rows independently ingested (each with its own non-null
            -- source_hash) are two real transactions that happen to match on
            -- these fields, not a duplicate — e.g. two identical vending-
            -- machine purchases the same day. Only flag a group where fewer
            -- distinct source_hash values exist than rows: either some rows
            -- share a hash (shouldn't happen, UNIQUE), or at least one row
            -- has no hash at all (manual entry / older import) and so can't
            -- be told apart from a real duplicate by hash alone.
            HAVING COUNT(*) > 1
               AND COUNT(DISTINCT source_hash) < COUNT(*)
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
