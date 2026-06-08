import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from flask import g

_DEFAULT_CATEGORIES = [
    "Food",
    "Transport",
    "Shopping",
    "Entertainment",
    "Health",
    "Housing",
    "Utilities",
    "Income",
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
    source_hash    TEXT    UNIQUE
);

CREATE TABLE IF NOT EXISTS profile (
    id                      INTEGER PRIMARY KEY CHECK(id = 1),
    monthly_income          REAL    NOT NULL DEFAULT 0,
    savings_target          REAL    NOT NULL DEFAULT 0,
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
    UNIQUE(category_id)
);
"""


def get_db_path(user_id: int) -> str:
    return f"data/user_{user_id}_finance.db"


def get_user_db(user_id: int) -> sqlite3.Connection:
    if "user_db" not in g:
        conn = sqlite3.connect(get_db_path(user_id))
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        g.user_db = conn
    return g.user_db


def init_user_db(user_id: int) -> None:
    Path("data").mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(get_db_path(user_id))
    try:
        conn.executescript(_SCHEMA)
        now = datetime.now(UTC).isoformat()
        conn.executemany(
            "INSERT OR IGNORE INTO categories (name) VALUES (?)",
            [(name,) for name in _DEFAULT_CATEGORIES],
        )
        conn.execute(
            "INSERT OR IGNORE INTO profile (id, monthly_income, savings_target, created_at, updated_at)"
            " VALUES (1, 0, 0, ?, ?)",
            (now, now),
        )
        conn.execute(
            "INSERT OR IGNORE INTO budgets (category_id, amount) SELECT id, 0 FROM categories"
        )
        conn.commit()
    finally:
        conn.close()
