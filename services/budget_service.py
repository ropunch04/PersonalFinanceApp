import sqlite3
from datetime import date


def get_budget_summary(conn: sqlite3.Connection, start_date: str = None, end_date: str = None) -> dict:
    if not start_date or not end_date:
        today = date.today()
        start_date = today.replace(day=1).isoformat()
        end_date = today.isoformat()

    profile = conn.execute(
        "SELECT monthly_income, savings_target FROM profile WHERE id = 1"
    ).fetchone()

    monthly_income = (profile["monthly_income"] or 0) if profile else 0
    savings_target = (profile["savings_target"] or 0) if profile else 0

    totals = conn.execute("""
        SELECT
            COALESCE(SUM(CASE WHEN direction = 'outflow' THEN amount ELSE 0 END), 0) AS total_spent,
            COALESCE(SUM(CASE WHEN direction = 'inflow'  THEN amount ELSE 0 END), 0) AS total_income
        FROM transactions
        WHERE transaction_at BETWEEN ? AND ?
    """, (start_date, end_date)).fetchone()

    total_spent = totals["total_spent"]
    total_income = totals["total_income"]

    pending_count = conn.execute(
        "SELECT COUNT(*) FROM transactions WHERE category_id IS NULL AND transaction_at BETWEEN ? AND ?",
        (start_date, end_date)
    ).fetchone()[0]

    by_category = conn.execute("""
        SELECT
            c.id   AS category_id,
            c.name AS category_name,
            COALESCE(SUM(
                CASE WHEN t.direction = 'outflow' THEN  t.amount
                     WHEN t.direction = 'inflow'  THEN -t.amount
                     ELSE 0 END
            ), 0) AS spent,
            COALESCE(b.amount, 0) AS budget
        FROM categories c
        LEFT JOIN transactions t ON t.category_id = c.id
            AND t.transaction_at BETWEEN ? AND ?
        LEFT JOIN budgets b ON b.category_id = c.id
        GROUP BY c.id, c.name, b.amount
        ORDER BY spent DESC
    """, (start_date, end_date)).fetchall()

    return {
        "monthly_income": monthly_income,
        "savings_target": savings_target,
        "total_spent": total_spent,
        "total_income": total_income,
        "net": total_income - total_spent,
        "savings_amount": monthly_income * (savings_target / 100),
        "pending_count": pending_count,
        "by_category": [
            {
                "category_id": r["category_id"],
                "category_name": r["category_name"],
                "spent": r["spent"],
                "budget": r["budget"],
                "remaining": r["budget"] - r["spent"],
            }
            for r in by_category
        ],
    }
