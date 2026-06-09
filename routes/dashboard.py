from datetime import date, timedelta

from flask import Blueprint, g, request

from auth.middleware import require_auth
from db_context import get_user_db
from services.budget_service import get_budget_summary

bp = Blueprint("dashboard", __name__, url_prefix="/api")


@bp.get("/dashboard")
@require_auth
def dashboard():
    conn = get_user_db(g.current_user["user_id"])
    start_date = request.args.get("start_date")
    end_date = request.args.get("end_date")
    return {"data": get_budget_summary(conn, start_date, end_date), "error": None}


@bp.get("/dashboard/trend")
@require_auth
def dashboard_trend():
    conn = get_user_db(g.current_user["user_id"])
    today = date.today()

    start_str = request.args.get("start_date") or today.replace(day=1).isoformat()
    end_str   = request.args.get("end_date")   or today.isoformat()
    start = date.fromisoformat(start_str)
    end   = date.fromisoformat(end_str)

    span_days = (end - start).days
    granularity = request.args.get("granularity")
    if not granularity:
        if span_days <= 60:
            granularity = "daily"
        elif span_days <= 180:
            granularity = "weekly"
        else:
            granularity = "monthly"

    if granularity == "daily":
        group_expr = "DATE(transaction_at)"
    elif granularity == "weekly":
        group_expr = "strftime('%Y-%W', transaction_at)"
    else:
        group_expr = "strftime('%Y-%m', transaction_at)"

    rows = conn.execute(f"""
        SELECT
            {group_expr} AS bucket,
            SUM(CASE WHEN direction = 'outflow' THEN amount ELSE 0 END) AS spent,
            SUM(CASE WHEN direction = 'inflow'  THEN amount ELSE 0 END) AS income
        FROM transactions
        WHERE transaction_at BETWEEN ? AND ?
        GROUP BY bucket
        ORDER BY bucket ASC
    """, (start_str, end_str)).fetchall()

    data_map = {r["bucket"]: {"spent": r["spent"], "income": r["income"]} for r in rows}
    series = []

    if granularity == "daily":
        cursor = start
        while cursor <= end:
            key = cursor.isoformat()
            vals = data_map.get(key, {"spent": 0, "income": 0})
            series.append({"date": key, "spent": vals["spent"], "income": vals["income"]})
            cursor += timedelta(days=1)
    elif granularity == "weekly":
        cursor = start - timedelta(days=start.weekday())
        while cursor <= end:
            key = cursor.strftime("%Y-%W")
            vals = data_map.get(key, {"spent": 0, "income": 0})
            series.append({"date": cursor.isoformat(), "spent": vals["spent"], "income": vals["income"]})
            cursor += timedelta(weeks=1)
    else:
        cursor = start.replace(day=1)
        while cursor <= end:
            key = cursor.strftime("%Y-%m")
            vals = data_map.get(key, {"spent": 0, "income": 0})
            series.append({"date": cursor.isoformat(), "spent": vals["spent"], "income": vals["income"]})

            if cursor.month == 12:
                cursor = cursor.replace(year=cursor.year + 1, month=1)
            else:
                cursor = cursor.replace(month=cursor.month + 1)

    return {"data": series, "error": None}


@bp.get("/dashboard/merchants")
@require_auth
def dashboard_merchants():
    conn = get_user_db(g.current_user["user_id"])
    today = date.today()
    start_str = request.args.get("start_date") or today.replace(day=1).isoformat()
    end_str   = request.args.get("end_date")   or today.isoformat()

    top_merchants = conn.execute("""
        SELECT
            merchant_raw,
            SUM(amount)  AS total_spent,
            COUNT(*)     AS transaction_count,
            AVG(amount)  AS average_amount
        FROM transactions
        WHERE direction = 'outflow'
          AND transaction_at BETWEEN ? AND ?
          AND merchant_raw IS NOT NULL
        GROUP BY merchant_raw
        ORDER BY total_spent DESC
        LIMIT 8
    """, (start_str, end_str)).fetchall()

    merchant_list = []
    for m in top_merchants:
        txns = conn.execute("""
            SELECT amount, transaction_at
            FROM transactions
            WHERE direction = 'outflow'
              AND merchant_raw = ?
              AND transaction_at BETWEEN ? AND ?
            ORDER BY transaction_at DESC
        """, (m["merchant_raw"], start_str, end_str)).fetchall()
        merchant_list.append({
            "merchant_raw": m["merchant_raw"],
            "total_spent": m["total_spent"],
            "transaction_count": m["transaction_count"],
            "average_amount": m["average_amount"],
            "transactions": [{"amount": t["amount"], "transaction_at": t["transaction_at"]} for t in txns],
        })

    largest = conn.execute("""
        SELECT merchant_raw, amount, transaction_at
        FROM transactions
        WHERE direction = 'outflow'
          AND transaction_at BETWEEN ? AND ?
          AND merchant_raw IS NOT NULL
        ORDER BY amount DESC
        LIMIT 1
    """, (start_str, end_str)).fetchone()

    repeat_merchants = conn.execute("""
        SELECT merchant_raw, COUNT(DISTINCT strftime('%Y-%m', transaction_at)) AS months_seen
        FROM transactions
        WHERE direction = 'outflow'
          AND transaction_at BETWEEN ? AND ?
          AND merchant_raw IS NOT NULL
        GROUP BY merchant_raw
        HAVING months_seen > 1
        ORDER BY months_seen DESC
    """, (start_str, end_str)).fetchall()

    return {"data": {
        "top_merchants": merchant_list,
        "largest_transaction": dict(largest) if largest else None,
        "repeat_merchants": [{"merchant_raw": r["merchant_raw"], "months_seen": r["months_seen"]} for r in repeat_merchants],
    }, "error": None}


def _period_totals(conn, start_str, end_str):
    """Return spent, income, net, and top_category for a date range."""
    row = conn.execute("""
        SELECT
            COALESCE(SUM(CASE WHEN direction='outflow' THEN amount ELSE 0 END),0) AS spent,
            COALESCE(SUM(CASE WHEN direction='inflow'  THEN amount ELSE 0 END),0) AS income
        FROM transactions WHERE transaction_at BETWEEN ? AND ?
    """, (start_str, end_str)).fetchone()
    spent  = row["spent"]
    income = row["income"]
    net    = income - spent

    top = conn.execute("""
        SELECT c.name AS category_name,
               COALESCE(SUM(CASE WHEN t.direction='outflow' THEN t.amount ELSE 0 END),0) AS cat_spent
        FROM categories c
        LEFT JOIN transactions t ON t.category_id = c.id
            AND t.transaction_at BETWEEN ? AND ?
        GROUP BY c.id, c.name
        ORDER BY cat_spent DESC LIMIT 1
    """, (start_str, end_str)).fetchone()
    top_category = top["category_name"] if top and top["cat_spent"] > 0 else None

    return {"spent": spent, "income": income, "net": net, "top_category": top_category}


def _delta_pct(current, previous):
    if not previous or previous == 0:
        return None
    return round((current - previous) / abs(previous) * 100, 1)


@bp.get("/dashboard/comparison")
@require_auth
def dashboard_comparison():
    conn = get_user_db(g.current_user["user_id"])
    today = date.today()

    start_str = request.args.get("start_date") or today.replace(day=1).isoformat()
    end_str   = request.args.get("end_date")   or today.isoformat()
    start = date.fromisoformat(start_str)
    end   = date.fromisoformat(end_str)

    span = (end - start).days + 1
    if start.day == 1:
        prev_end   = start - timedelta(days=1)
        prev_start = prev_end.replace(day=1)
    else:
        prev_start = start - timedelta(days=span)
        prev_end   = start - timedelta(days=1)

    current  = _period_totals(conn, start_str, end_str)
    previous = _period_totals(conn, prev_start.isoformat(), prev_end.isoformat())
    has_prev = previous["spent"] > 0 or previous["income"] > 0

    cur_cats = conn.execute("""
        SELECT c.id, c.name,
               COALESCE(SUM(CASE WHEN t.direction='outflow' THEN t.amount ELSE 0 END),0) AS spent
        FROM categories c
        LEFT JOIN transactions t ON t.category_id=c.id AND t.transaction_at BETWEEN ? AND ?
        GROUP BY c.id, c.name
    """, (start_str, end_str)).fetchall()
    prev_cats = conn.execute("""
        SELECT c.id,
               COALESCE(SUM(CASE WHEN t.direction='outflow' THEN t.amount ELSE 0 END),0) AS spent
        FROM categories c
        LEFT JOIN transactions t ON t.category_id=c.id
            AND t.transaction_at BETWEEN ? AND ?
        GROUP BY c.id
    """, (prev_start.isoformat(), prev_end.isoformat())).fetchall()

    prev_map = {r["id"]: r["spent"] for r in prev_cats}
    biggest  = None
    best_pct = 0
    for r in cur_cats:
        prev_s = prev_map.get(r["id"], 0)
        if prev_s == 0:
            continue
        pct = abs((r["spent"] - prev_s) / prev_s * 100)
        if pct > best_pct:
            best_pct = pct
            biggest  = {
                "category_name": r["name"],
                "delta_pct": round((r["spent"] - prev_s) / prev_s * 100, 1),
                "direction": "up" if r["spent"] > prev_s else "down",
            }

    velocity = None
    range_days = (end - start).days
    if end >= today and range_days < 60 and start.day == 1:
        import calendar
        days_in_month = calendar.monthrange(start.year, start.month)[1]
        days_elapsed  = max((today - start).days, 1)
        daily_rate    = current["spent"] / days_elapsed
        projected     = round(daily_rate * days_in_month, 2)

        profile = conn.execute(
            "SELECT monthly_income FROM profile WHERE id=1"
        ).fetchone()
        monthly_income = (profile["monthly_income"] or 0) if profile else 0

        velocity = {
            "projected_spend":  projected,
            "days_remaining":   days_in_month - days_elapsed,
            "days_elapsed":     days_elapsed,
            "days_in_month":    days_in_month,
            "on_pace":          projected <= monthly_income if monthly_income > 0 else True,
        }

    return {"data": {
        "current":                 current,
        "previous":                previous if has_prev else None,
        "deltas": {
            "spent_delta_pct":  _delta_pct(current["spent"],  previous["spent"])  if has_prev else None,
            "income_delta_pct": _delta_pct(current["income"], previous["income"]) if has_prev else None,
            "net_delta_pct":    _delta_pct(current["net"],    previous["net"])    if has_prev else None,
        } if has_prev else None,
        "biggest_change_category": biggest if has_prev else None,
        "velocity":                velocity,
    }, "error": None}
