import sqlite3
from datetime import date


# Portion of an outflow's amount the user expects to get back (whether via a
# real payment they'll eventually link, or settled outside the app entirely,
# e.g. payroll) and which should not count against their own spend/budget
# totals. This is optimistic — it's excluded the moment it's set, before any
# money actually arrives; see reimbursement_links / the /owed endpoint for
# whether that expectation has actually been paid down yet.
def _excluded_sql(prefix: str = "") -> str:
    p = f"{prefix}." if prefix else ""
    return f"MIN(COALESCE({p}expected_reimbursement, 0), {p}amount)"


_EXCLUDED_SQL = _excluded_sql()


# Portion of an inflow that represents real income (unapplied to any reimbursement).
# Inflows that are applied to reimburse outflows via reimbursement_links are expense
# offsets and must not be counted as income.
def _inflow_income_sql(prefix: str = "") -> str:
    table = prefix if prefix else "transactions"
    return f"MAX(0, {table}.amount - COALESCE((SELECT SUM(rl.amount) FROM reimbursement_links rl WHERE rl.inflow_id = {table}.id), 0))"


_INFLOW_INCOME_SQL = _inflow_income_sql()


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
        w_null  = f"(category_id IS NULL AND direction = 'outflow' AND (DATE(transaction_at) BETWEEN ? AND ? OR id IN ({ph})))"
    else:
        w_where = "DATE(transaction_at) BETWEEN ? AND ?"
        w_join  = "DATE(t.transaction_at) BETWEEN ? AND ?"
        w_null  = "category_id IS NULL AND direction = 'outflow' AND DATE(transaction_at) BETWEEN ? AND ?"
    p = [start_date, end_date] + ids

    totals = conn.execute(f"""
        SELECT
            COALESCE(SUM(CASE WHEN direction = 'outflow' THEN amount - {_EXCLUDED_SQL} ELSE 0 END), 0) AS total_spent,
            COALESCE(SUM(CASE WHEN direction = 'inflow'  THEN {_INFLOW_INCOME_SQL} ELSE 0 END), 0) AS total_income
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
            c.is_misc AS is_misc,
            COALESCE(b.fold_into_misc, 0) AS fold_into_misc,
            COALESCE(b.period, 'monthly') AS period,
            COALESCE(SUM(
                CASE WHEN t.direction = 'outflow' THEN  t.amount - {_excluded_sql("t")}
                     WHEN t.direction = 'inflow'  THEN -{_inflow_income_sql("t")}
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
        GROUP BY c.id, c.name, c.is_misc, b.amount, b.period, b.fold_into_misc
        ORDER BY spent DESC
    """, p + [year_start, year_end]).fetchall()

    entries = []
    for r in by_category:
        budget = r["budget"] * month_count if r["period"] == "monthly" else r["budget"]
        entries.append({
            "category_id":   r["category_id"],
            "category_name": r["category_name"],
            "period":        r["period"],
            "spent":         r["spent"],
            "budget":        budget,
            "is_misc":       bool(r["is_misc"]),
            "is_flex":       bool(r["fold_into_misc"]),
            "remaining":     budget - r["spent"],
        })

    flex_entries = [e for e in entries if e["is_flex"]]
    flex_pool = None
    if flex_entries:
        pool_budget = sum(e["budget"] for e in flex_entries)
        pool_spent  = sum(e["spent"]  for e in flex_entries)
        flex_pool = {
            "budget":       pool_budget,
            "spent":        pool_spent,
            "remaining":    pool_budget - pool_spent,
            "category_ids": [e["category_id"] for e in flex_entries],
        }

    return {
        "total_spent":  total_spent,
        "total_income": total_income,
        "net":          total_income - total_spent,
        "pending_count": pending_count,
        "by_category": entries,
        "flex_pool": flex_pool,
    }
