from datetime import date, datetime, timezone

from flask import Blueprint, g, request

from auth.middleware import require_auth
from db_context import advance_paycheck_date, get_user_db

bp = Blueprint("recurring_income", __name__, url_prefix="/api")

FREQUENCIES = {"weekly", "biweekly", "semimonthly", "monthly"}


def _ok(data):
    return {"data": data, "error": None}


def _err(message, status):
    return {"data": None, "error": message}, status


def _serialize(row):
    return {
        "id": row["id"],
        "label": row["label"],
        "amount": row["amount"],
        "frequency": row["frequency"],
        "start_date": row["start_date"],
        "day_of_month2": row["day_of_month2"],
        "next_run_date": row["next_run_date"],
        "active": bool(row["active"]),
    }


@bp.get("/recurring-income")
@require_auth
def list_recurring_income():
    conn = get_user_db(g.current_user["user_id"])
    rows = conn.execute("SELECT * FROM recurring_income ORDER BY next_run_date").fetchall()
    return _ok([_serialize(r) for r in rows])


@bp.post("/recurring-income")
@require_auth
def create_recurring_income():
    conn = get_user_db(g.current_user["user_id"])
    body = request.get_json(silent=True) or {}

    label = (body.get("label") or "Paycheck").strip() or "Paycheck"
    amount = body.get("amount")
    frequency = body.get("frequency")
    start_date = body.get("start_date")
    day_of_month2 = body.get("day_of_month2")

    if not isinstance(amount, (int, float)) or amount <= 0:
        return _err("amount must be a positive number", 400)
    if frequency not in FREQUENCIES:
        return _err(f"frequency must be one of {sorted(FREQUENCIES)}", 400)
    try:
        start = date.fromisoformat(start_date)
    except (TypeError, ValueError):
        return _err("start_date must be an ISO date (YYYY-MM-DD)", 400)

    if frequency == "semimonthly":
        if not isinstance(day_of_month2, int) or not (1 <= day_of_month2 <= 31):
            return _err("day_of_month2 must be an integer day (1-31) for semimonthly schedules", 400)
    else:
        day_of_month2 = None

    now = datetime.now(timezone.utc).isoformat()
    cur = conn.execute(
        """
        INSERT INTO recurring_income
            (label, amount, frequency, start_date, day_of_month2, next_run_date, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
        """,
        (label, amount, frequency, start.isoformat(), day_of_month2, start.isoformat(), now, now),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM recurring_income WHERE id = ?", (cur.lastrowid,)).fetchone()
    return _ok(_serialize(row))


@bp.put("/recurring-income/<int:item_id>")
@require_auth
def update_recurring_income(item_id):
    conn = get_user_db(g.current_user["user_id"])
    row = conn.execute("SELECT * FROM recurring_income WHERE id = ?", (item_id,)).fetchone()
    if not row:
        return _err("Not found", 404)

    body = request.get_json(silent=True) or {}
    label = row["label"]
    amount = row["amount"]
    was_active = bool(row["active"])
    active = was_active
    next_run_date = row["next_run_date"]

    if "label" in body:
        label = (body.get("label") or "Paycheck").strip() or "Paycheck"
    if "amount" in body:
        amount = body.get("amount")
        if not isinstance(amount, (int, float)) or amount <= 0:
            return _err("amount must be a positive number", 400)
    if "active" in body:
        active = bool(body.get("active"))

    if active and not was_active:
        # Resuming a paused schedule shouldn't dump months of missed paychecks;
        # fast-forward to the next occurrence on/after today without generating any.
        today = date.today()
        next_date = date.fromisoformat(next_run_date)
        anchor_day = date.fromisoformat(row["start_date"]).day
        guard = 0
        while next_date < today and guard < 500:
            next_date = advance_paycheck_date(next_date, row["frequency"], anchor_day, row["day_of_month2"])
            guard += 1
        next_run_date = next_date.isoformat()

    conn.execute(
        "UPDATE recurring_income SET label = ?, amount = ?, active = ?, next_run_date = ?, updated_at = ? WHERE id = ?",
        (label, amount, int(active), next_run_date, datetime.now(timezone.utc).isoformat(), item_id),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM recurring_income WHERE id = ?", (item_id,)).fetchone()
    return _ok(_serialize(row))


@bp.delete("/recurring-income/<int:item_id>")
@require_auth
def delete_recurring_income(item_id):
    conn = get_user_db(g.current_user["user_id"])
    conn.execute("DELETE FROM recurring_income WHERE id = ?", (item_id,))
    conn.commit()
    return _ok(None)
