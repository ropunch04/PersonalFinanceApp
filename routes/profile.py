from datetime import datetime, timezone

from flask import Blueprint, g, request

from auth.middleware import require_auth
from db_context import get_user_db

bp = Blueprint("profile", __name__, url_prefix="/api")


def _ok(data):
    return {"data": data, "error": None}


def _err(message, status):
    return {"data": None, "error": message}, status


def _fetch_profile(conn) -> dict:
    row = conn.execute(
        "SELECT monthly_income, savings_target, gmail_address, last_synced_at FROM profile WHERE id = 1"
    ).fetchone()
    budgets = conn.execute(
        """
        SELECT b.category_id, c.name AS category_name, b.amount
        FROM budgets b
        JOIN categories c ON c.id = b.category_id
        ORDER BY c.name
        """
    ).fetchall()
    return {
        "monthly_income": row["monthly_income"] if row else 0,
        "savings_target": row["savings_target"] if row else 0,
        "gmail_address": row["gmail_address"] if row else None,
        "gmail_configured": bool(row["gmail_address"]) if row else False,
        "last_synced_at": row["last_synced_at"] if row else None,
        "budgets": [dict(b) for b in budgets],
    }


@bp.get("/profile")
@require_auth
def get_profile():
    conn = get_user_db(g.current_user["user_id"])
    return _ok(_fetch_profile(conn))


@bp.put("/profile")
@require_auth
def update_profile():
    conn = get_user_db(g.current_user["user_id"])
    body = request.get_json(silent=True) or {}

    scalar_fields = {"monthly_income", "savings_target"}
    updates = {k: v for k, v in body.items() if k in scalar_fields}

    if updates:
        updates["updated_at"] = datetime.now(timezone.utc).isoformat()
        set_clause = ", ".join(f"{col} = ?" for col in updates)
        conn.execute(
            f"UPDATE profile SET {set_clause} WHERE id = 1",
            list(updates.values()),
        )

    budgets = body.get("budgets")
    if isinstance(budgets, list):
        for entry in budgets:
            category_id = entry.get("category_id")
            amount = entry.get("amount")
            if category_id is None or amount is None:
                return _err("Each budget entry must include category_id and amount", 400)
            conn.execute(
                "UPDATE budgets SET amount = ? WHERE category_id = ?",
                (amount, category_id),
            )

    conn.commit()
    return _ok(_fetch_profile(conn))
