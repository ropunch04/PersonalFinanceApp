import sqlite3
from datetime import date


def get_budget_summary(
    conn: sqlite3.Connection,
    start_date: str = None,
    end_date: str = None,
    pinned_ids: list[int] = None,
) -> dict:
    if not start_date or not end_date:
        today = date.today()
        start_date = today.replace(day=1).isoformat()
        end_date = today.isoformat()

    ids = pinned_ids or []
    if ids:
        ph = ",".join("?" * len(ids))
        w_where = f"(DATE(transaction_at) BETWEEN ? AND ? OR id IN ({ph}))"
        w_join  = f"(DATE(t.transaction_at) BETWEEN ? AND ? OR t.id IN ({ph}))"
        w_null  = f"(category_id IS NULL AND (DATE(transaction_at) BETWEEN ? AND ? OR id IN ({ph})))"
    else:
        w_where = "DATE(transaction_at) BETWEEN ? AND ?"
        w_join  = "DATE(t.transaction_at) BETWEEN ? AND ?"
        w_null  = "category_id IS NULL AND DATE(transaction_at) BETWEEN ? AND ?"
    p = [start_date, end_date] + ids

    totals = conn.execute(f"""
        SELECT
            COALESCE(SUM(CASE WHEN direction = 'outflow' THEN amount ELSE 0 END), 0) AS total_spent,
            COALESCE(SUM(CASE WHEN direction = 'inflow'  THEN amount ELSE 0 END), 0) AS total_income
        FROM transactions
        WHERE {w_where}
    """, p).fetchone()

    total_spent  = totals["total_spent"]
    total_income = totals["total_income"]

    pending_count = conn.execute(
        f"SELECT COUNT(*) FROM transactions WHERE {w_null}",
        p,
    ).fetchone()[0]

    start = date.fromisoformat(start_date)
    end   = date.fromisoformat(end_date)
    days_in_range = (end - start).days + 1
    month_count = max(1, round(days_in_range / 30.44))

    year = end.year
    year_start = f"{year}-01-01"
    year_end   = f"{year}-12-31"

    by_category = conn.execute(f"""
        SELECT
            c.id   AS category_id,
            c.name AS category_name,
            COALESCE(b.period, 'monthly') AS period,
            COALESCE(SUM(
                CASE WHEN t.direction = 'outflow' THEN  t.amount
                     WHEN t.direction = 'inflow'  THEN -t.amount
                     ELSE 0 END
            ), 0) AS spent,
            COALESCE(b.amount, 0) AS budget
        FROM categories c
        LEFT JOIN budgets b ON b.category_id = c.id
        LEFT JOIN transactions t ON t.category_id = c.id AND (
            (COALESCE(b.period, 'monthly') = 'monthly' AND {w_join})
            OR
            (COALESCE(b.period, 'monthly') = 'yearly'  AND DATE(t.transaction_at) BETWEEN ? AND ?)
        )
        GROUP BY c.id, c.name, b.amount, b.period
        ORDER BY spent DESC
    """, p + [year_start, year_end]).fetchall()

    return {
        "total_spent":  total_spent,
        "total_income": total_income,
        "net":          total_income - total_spent,
        "pending_count": pending_count,
        "by_category": [
            {
                "category_id":   r["category_id"],
                "category_name": r["category_name"],
                "period":        r["period"],
                "spent":         r["spent"],
                "budget":        r["budget"] * month_count if r["period"] == "monthly" else r["budget"],
                "remaining":     (r["budget"] * month_count if r["period"] == "monthly" else r["budget"]) - r["spent"],
            }
            for r in by_category
        ],
    }
