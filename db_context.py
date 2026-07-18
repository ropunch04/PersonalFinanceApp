import calendar
import sqlite3
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from flask import g

_DEFAULT_CATEGORIES = [
    "Dining",
    "Groceries",
    "Travel",
    "Entertainment",
    "Shopping",
    "Housing",
    "Transportation",
    "Health & Personal Care",
    "Other",
]

_SCHEMA = """
CREATE TABLE IF NOT EXISTS categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_misc    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS transactions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    amount         REAL    NOT NULL,
    merchant_raw   TEXT,
    direction      TEXT    NOT NULL CHECK(direction IN ('inflow', 'outflow')),
    category_id    INTEGER REFERENCES categories(id),
    notes          TEXT,
    transaction_at TEXT    NOT NULL,
    created_at     TEXT    NOT NULL,
    source_hash    TEXT    UNIQUE,
    reimburses_id  INTEGER REFERENCES transactions(id)
);

CREATE TABLE IF NOT EXISTS profile (
    id                      INTEGER PRIMARY KEY CHECK(id = 1),
    gmail_address           TEXT,
    gmail_app_password_enc  TEXT,
    last_synced_at          TEXT,
    created_at              TEXT    NOT NULL,
    updated_at              TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS budgets (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id     INTEGER NOT NULL REFERENCES categories(id),
    amount          REAL    NOT NULL DEFAULT 0,
    period          TEXT    NOT NULL DEFAULT 'monthly' CHECK(period IN ('monthly', 'yearly')),
    fold_into_misc  INTEGER NOT NULL DEFAULT 0,
    UNIQUE(category_id)
);

CREATE TABLE IF NOT EXISTS recurring_income (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    label          TEXT    NOT NULL DEFAULT 'Paycheck',
    amount         REAL    NOT NULL,
    frequency      TEXT    NOT NULL CHECK(frequency IN ('weekly', 'biweekly', 'semimonthly', 'monthly')),
    start_date     TEXT    NOT NULL,
    day_of_month2  INTEGER,
    next_run_date  TEXT    NOT NULL,
    active         INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT    NOT NULL,
    updated_at     TEXT    NOT NULL
);
"""


def get_db_path(user_id: int) -> str:
    return f"data/user_{user_id}_finance.db"


def _migrate(conn: sqlite3.Connection) -> None:
    """Apply any schema migrations needed for existing DBs."""
    try:
        conn.execute("ALTER TABLE budgets ADD COLUMN period TEXT NOT NULL DEFAULT 'monthly'")
        conn.commit()
    except Exception:
        pass  # column already exists

    try:
        conn.execute("ALTER TABLE categories ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
        conn.commit()
    except Exception:
        pass  # column already exists

    try:
        conn.execute("ALTER TABLE categories ADD COLUMN is_misc INTEGER NOT NULL DEFAULT 0")
        conn.commit()
    except Exception:
        pass  # column already exists

    try:
        conn.execute("ALTER TABLE budgets ADD COLUMN fold_into_misc INTEGER NOT NULL DEFAULT 0")
        conn.commit()
    except Exception:
        pass  # column already exists

    conn.execute("""
        CREATE TABLE IF NOT EXISTS recurring_income (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            label          TEXT    NOT NULL DEFAULT 'Paycheck',
            amount         REAL    NOT NULL,
            frequency      TEXT    NOT NULL CHECK(frequency IN ('weekly', 'biweekly', 'semimonthly', 'monthly')),
            start_date     TEXT    NOT NULL,
            day_of_month2  INTEGER,
            next_run_date  TEXT    NOT NULL,
            active         INTEGER NOT NULL DEFAULT 1,
            created_at     TEXT    NOT NULL,
            updated_at     TEXT    NOT NULL
        )
    """)
    conn.commit()

    rows = conn.execute("SELECT id FROM categories ORDER BY sort_order, name").fetchall()
    distinct_orders = conn.execute("SELECT COUNT(DISTINCT sort_order) AS n FROM categories").fetchone()["n"]
    if len(rows) > 1 and distinct_orders <= 1:
        for index, row in enumerate(rows):
            conn.execute("UPDATE categories SET sort_order = ? WHERE id = ?", (index, row["id"]))
        conn.commit()

    misc_count = conn.execute("SELECT COUNT(*) AS n FROM categories WHERE is_misc = 1").fetchone()["n"]
    if misc_count == 0:
        conn.execute(
            "UPDATE categories SET is_misc = 1 "
            "WHERE id = (SELECT id FROM categories WHERE LOWER(name) = 'other' ORDER BY id LIMIT 1)"
        )
        conn.commit()


def _days_in_month(year: int, month: int) -> int:
    return calendar.monthrange(year, month)[1]


def advance_paycheck_date(current: date, frequency: str, anchor_day: int, day_of_month2: int = None) -> date:
    """Compute the next paycheck date after `current` for a given recurring schedule."""
    if frequency == "weekly":
        return current + timedelta(days=7)
    if frequency == "biweekly":
        return current + timedelta(days=14)
    if frequency == "monthly":
        year = current.year + (1 if current.month == 12 else 0)
        month = 1 if current.month == 12 else current.month + 1
        return date(year, month, min(anchor_day, _days_in_month(year, month)))
    if frequency == "semimonthly":
        days = sorted({anchor_day, day_of_month2 or anchor_day})
        if len(days) > 1 and current.day == days[0]:
            return current.replace(day=min(days[1], _days_in_month(current.year, current.month)))
        year = current.year + (1 if current.month == 12 else 0)
        month = 1 if current.month == 12 else current.month + 1
        return date(year, month, min(days[0], _days_in_month(year, month)))
    raise ValueError(f"Unknown frequency: {frequency}")


def _generate_due_recurring_income(conn: sqlite3.Connection) -> None:
    today = date.today()
    rows = conn.execute(
        "SELECT * FROM recurring_income WHERE active = 1 AND next_run_date <= ?",
        (today.isoformat(),),
    ).fetchall()
    if not rows:
        return

    now = datetime.now(timezone.utc).isoformat()
    for row in rows:
        next_date = date.fromisoformat(row["next_run_date"])
        anchor_day = date.fromisoformat(row["start_date"]).day
        day_of_month2 = row["day_of_month2"]
        guard = 0
        while next_date <= today and guard < 500:
            conn.execute(
                """
                INSERT OR IGNORE INTO transactions
                    (amount, merchant_raw, direction, notes, transaction_at, created_at, source_hash)
                VALUES (?, ?, 'inflow', ?, ?, ?, ?)
                """,
                (
                    row["amount"],
                    row["label"],
                    "Recurring paycheck",
                    next_date.isoformat(),
                    now,
                    f"recurring-income:{row['id']}:{next_date.isoformat()}",
                ),
            )
            next_date = advance_paycheck_date(next_date, row["frequency"], anchor_day, day_of_month2)
            guard += 1
        conn.execute(
            "UPDATE recurring_income SET next_run_date = ? WHERE id = ?",
            (next_date.isoformat(), row["id"]),
        )
    conn.commit()


def get_user_db(user_id: int) -> sqlite3.Connection:
    if "user_db" not in g:
        db_path = get_db_path(user_id)
        if not Path(db_path).exists():
            init_user_db(user_id)
        conn = sqlite3.connect(db_path, timeout=15)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        _migrate(conn)
        _generate_due_recurring_income(conn)
        g.user_db = conn
    return g.user_db


def init_user_db(user_id: int) -> None:
    Path("data").mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(get_db_path(user_id), timeout=15)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(_SCHEMA)
        now = datetime.now(timezone.utc).isoformat()
        conn.executemany(
            "INSERT OR IGNORE INTO categories (name, sort_order) VALUES (?, ?)",
            [(name, i) for i, name in enumerate(_DEFAULT_CATEGORIES)],
        )
        conn.execute(
            "INSERT OR IGNORE INTO profile (id, created_at, updated_at) VALUES (1, ?, ?)",
            (now, now),
        )
        conn.execute(
            "INSERT OR IGNORE INTO budgets (category_id, amount) SELECT id, 0 FROM categories"
        )
        conn.commit()
    finally:
        conn.close()
