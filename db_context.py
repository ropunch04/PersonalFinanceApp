import sqlite3
from datetime import datetime, timezone
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
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL UNIQUE
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
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    amount      REAL    NOT NULL DEFAULT 0,
    period      TEXT    NOT NULL DEFAULT 'monthly' CHECK(period IN ('monthly', 'yearly')),
    UNIQUE(category_id)
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


def get_user_db(user_id: int) -> sqlite3.Connection:
    if "user_db" not in g:
        db_path = get_db_path(user_id)
        if not Path(db_path).exists():
            init_user_db(user_id)
        conn = sqlite3.connect(db_path, timeout=15)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        _migrate(conn)
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
            "INSERT OR IGNORE INTO categories (name) VALUES (?)",
            [(name,) for name in _DEFAULT_CATEGORIES],
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
