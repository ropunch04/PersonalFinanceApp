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
    tbl = prefix if prefix else "transactions"
    received = (
        f"COALESCE((SELECT SUM(rl.amount) FROM reimbursement_links rl "
        f"WHERE rl.outflow_id = {tbl}.id), 0)"
    )
    return (
        f"MIN(MAX(COALESCE({p}expected_reimbursement, 0), {received}), {p}amount)"
    )


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

    # `spent` here is ALWAYS scoped to the requested [start_date, end_date]
    # window, for every category regardless of budget period. Previously a
    # yearly-period category was joined against the *full calendar year* here
    # while total_spent (above) and the trend/comparison endpoints were scoped
    # to the requested window — so the category-breakdown donut (which sums
    # these `spent` values) could show a full year of a yearly category's
    # spend inside a one-month "Total Spent" tile. Also dropped the inflow
    # subtraction that used to apply only here: total_spent and every other
    # "spent" figure in the app already don't net inflows against spend (a
    # refund is a reimbursement link or its own inflow, not negative expense),
    # so this now uses the same definition everywhere — see spend_basis below.
    by_category = conn.execute(f"""
        SELECT
            c.id   AS category_id,
            c.name AS category_name,
            c.is_misc AS is_misc,
            COALESCE(b.fold_into_misc, 0) AS fold_into_misc,
            COALESCE(b.period, 'monthly') AS period,
            COALESCE(b.amount, 0) AS budget,
            COALESCE(SUM(
                CASE WHEN t.direction = 'outflow' THEN t.amount - {_excluded_sql("t")} ELSE 0 END
            ), 0) AS spent
        FROM categories c
        LEFT JOIN budgets b ON b.category_id = c.id
        LEFT JOIN transactions t ON t.category_id = c.id AND t.direction = 'outflow' AND {w_join}
        GROUP BY c.id, c.name, c.is_misc, b.amount, b.period, b.fold_into_misc
        ORDER BY spent DESC
    """, p).fetchall()

    # Separately, a yearly-period category's *budget progress* (used for its
    # remaining/over-budget state) tracks the whole calendar year, not just
    # the viewed window — that's what "yearly" means. Computed independently
    # of `spent` above so the two concerns (donut consistency vs. budget
    # tracking) can't leak into each other again.
    ytd_rows = conn.execute(f"""
        SELECT c.id AS category_id,
               COALESCE(SUM(
                   CASE WHEN t.direction = 'outflow' THEN t.amount - {_excluded_sql("t")} ELSE 0 END
               ), 0) AS spent_ytd
        FROM categories c
        LEFT JOIN transactions t ON t.category_id = c.id AND t.direction = 'outflow'
            AND DATE(t.transaction_at) BETWEEN ? AND ?
        GROUP BY c.id
    """, [year_start, year_end]).fetchall()
    ytd_map = {r["category_id"]: r["spent_ytd"] for r in ytd_rows}

    entries = []
    for r in by_category:
        is_yearly = r["period"] == "yearly"
        budget = r["budget"] if is_yearly else r["budget"] * month_count
        spent_ytd = ytd_map.get(r["category_id"], 0) if is_yearly else None
        basis_spent = spent_ytd if is_yearly else r["spent"]
        entries.append({
            "category_id":   r["category_id"],
            "category_name": r["category_name"],
            "period":        r["period"],
            "spent":         r["spent"],       # window-scoped; sums to total_spent (+ uncategorized)
            "spent_ytd":     spent_ytd,         # yearly categories only; drives their budget bar
            "budget":        budget,
            "is_misc":       bool(r["is_misc"]),
            "is_flex":       bool(r["fold_into_misc"]),
            "remaining":     budget - basis_spent,
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

    uncategorized_spent = round(total_spent - sum(e["spent"] for e in entries), 2)

    return {
        "total_spent":  total_spent,
        "total_income": total_income,
        "net":          total_income - total_spent,
        "pending_count": pending_count,
        "by_category": entries,
        "uncategorized_spent": uncategorized_spent,
        # Documents the definition so a client (or a future test) can check
        # it: spend never nets inflows against it anywhere in this response.
        # total_spent == sum(by_category[].spent) + uncategorized_spent.
        "spend_basis": "gross_outflow_minus_reimbursed",
        "flex_pool": flex_pool,
    }
