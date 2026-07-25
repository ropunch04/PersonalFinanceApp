"""Reimbursement bucket links and the outstanding-payments tracker.

A payment (inflow) can be applied, in whole or in part, against one or more
charges (outflows) via reimbursement_links — see db_context.py's schema
comment. This blueprint owns creating/removing those links, inspecting a
transaction's link graph, and listing charges where the user still expects
money back that hasn't actually arrived yet (see expected_reimbursement on
routes/transactions.py's _TXN_SELECT for the "optimistic" exclusion this
complements).
"""

from datetime import datetime, timezone

from flask import Blueprint, g, request

from auth.middleware import require_auth
from db_context import get_user_db
from routes.helpers import _err, _ok

bp = Blueprint("reimbursements", __name__, url_prefix="/api")

_EPS = 1e-6


@bp.post("/reimbursement-links")
@require_auth
def create_link():
    db = get_user_db(g.current_user["user_id"])
    body = request.get_json(silent=True) or {}

    inflow_id = body.get("inflow_id")
    outflow_id = body.get("outflow_id")
    if not isinstance(inflow_id, int) or not isinstance(outflow_id, int):
        return _err("inflow_id and outflow_id are required", 400)

    try:
        amount = float(body.get("amount"))
    except (TypeError, ValueError):
        return _err("amount must be a number", 400)
    if amount <= 0:
        return _err("amount must be greater than 0", 400)

    inflow = db.execute(
        "SELECT id, amount, direction FROM transactions WHERE id = ?", (inflow_id,)
    ).fetchone()
    outflow = db.execute(
        "SELECT id, amount, direction, reimbursement_external FROM transactions WHERE id = ?",
        (outflow_id,),
    ).fetchone()
    if inflow is None or outflow is None:
        return _err("Transaction not found", 404)
    if inflow["direction"] != "inflow":
        return _err("inflow_id must reference an inflow transaction", 400)
    if outflow["direction"] != "outflow":
        return _err("outflow_id must reference an outflow transaction", 400)
    if outflow["reimbursement_external"]:
        return _err(
            "That charge is marked as settled outside the app — clear that before linking a payment to it",
            409,
        )
    if amount > outflow["amount"] + _EPS:
        return _err("amount cannot exceed the charge's own amount", 400)

    already_applied = db.execute(
        "SELECT COALESCE(SUM(amount), 0) AS n FROM reimbursement_links WHERE inflow_id = ?",
        (inflow_id,),
    ).fetchone()["n"]
    remaining = inflow["amount"] - already_applied
    if amount > remaining + _EPS:
        return _err(f"That payment only has ${remaining:.2f} left unapplied", 400)

    now = datetime.now(timezone.utc).isoformat()
    cur = db.execute(
        "INSERT INTO reimbursement_links (inflow_id, outflow_id, amount, created_at) VALUES (?, ?, ?, ?)",
        (inflow_id, outflow_id, amount, now),
    )
    db.commit()

    row = db.execute(
        "SELECT id, inflow_id, outflow_id, amount, created_at FROM reimbursement_links WHERE id = ?",
        (cur.lastrowid,),
    ).fetchone()
    return _ok(dict(row)), 201


@bp.delete("/reimbursement-links/<int:link_id>")
@require_auth
def delete_link(link_id):
    db = get_user_db(g.current_user["user_id"])
    row = db.execute("SELECT id FROM reimbursement_links WHERE id = ?", (link_id,)).fetchone()
    if row is None:
        return _err("Link not found", 404)
    db.execute("DELETE FROM reimbursement_links WHERE id = ?", (link_id,))
    db.commit()
    return _ok({"id": link_id})


@bp.get("/transactions/<int:txn_id>/links")
@require_auth
def get_links(txn_id):
    db = get_user_db(g.current_user["user_id"])
    txn = db.execute(
        "SELECT id, direction, amount, expected_reimbursement, reimbursement_external "
        "FROM transactions WHERE id = ?",
        (txn_id,),
    ).fetchone()
    if txn is None:
        return _err("Transaction not found", 404)

    as_outflow = db.execute(
        """
        SELECT rl.id AS link_id, rl.amount, rl.created_at,
               t.id AS inflow_id, t.merchant_raw AS inflow_merchant,
               t.amount AS inflow_amount, t.transaction_at AS inflow_date
        FROM reimbursement_links rl
        JOIN transactions t ON t.id = rl.inflow_id
        WHERE rl.outflow_id = ?
        ORDER BY rl.created_at
        """,
        (txn_id,),
    ).fetchall()
    as_inflow = db.execute(
        """
        SELECT rl.id AS link_id, rl.amount, rl.created_at,
               t.id AS outflow_id, t.merchant_raw AS outflow_merchant,
               t.amount AS outflow_amount, t.transaction_at AS outflow_date
        FROM reimbursement_links rl
        JOIN transactions t ON t.id = rl.outflow_id
        WHERE rl.inflow_id = ?
        ORDER BY rl.created_at
        """,
        (txn_id,),
    ).fetchall()

    received = sum(r["amount"] for r in as_outflow)
    applied = sum(r["amount"] for r in as_inflow)
    outstanding = None
    if txn["direction"] == "outflow" and txn["expected_reimbursement"] is not None and not txn["reimbursement_external"]:
        outstanding = max(0.0, txn["expected_reimbursement"] - received)

    return _ok({
        "as_outflow": [dict(r) for r in as_outflow],
        "as_inflow": [dict(r) for r in as_inflow],
        "received_total": received,
        "applied_total": applied,
        "inflow_remaining": (txn["amount"] - applied) if txn["direction"] == "inflow" else None,
        "outstanding": outstanding,
    })


@bp.get("/transactions/owed")
@require_auth
def list_owed():
    db = get_user_db(g.current_user["user_id"])
    rows = db.execute(
        """
        SELECT t.id, t.merchant_raw, t.amount, t.transaction_at, t.expected_reimbursement,
               COALESCE((SELECT SUM(rl.amount) FROM reimbursement_links rl
                         WHERE rl.outflow_id = t.id), 0) AS received
        FROM transactions t
        WHERE t.direction = 'outflow'
          AND t.expected_reimbursement IS NOT NULL
          AND t.reimbursement_external = 0
        """
    ).fetchall()

    items = []
    total = 0.0
    for r in rows:
        outstanding = max(0.0, r["expected_reimbursement"] - r["received"])
        if outstanding > 0.005:
            items.append({
                "id": r["id"],
                "merchant_raw": r["merchant_raw"],
                "amount": r["amount"],
                "transaction_at": r["transaction_at"],
                "expected_reimbursement": r["expected_reimbursement"],
                "received": r["received"],
                "outstanding": outstanding,
            })
            total += outstanding

    items.sort(key=lambda o: o["transaction_at"])
    return _ok({"items": items, "total_outstanding": total})
