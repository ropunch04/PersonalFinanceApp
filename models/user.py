import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import config

MASTER_DB = Path(config.DB_PATH).parent / "master.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    email         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0 CHECK(is_admin IN (0, 1)),
    created_at    TEXT    NOT NULL,
    last_login_at TEXT
);
"""


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(MASTER_DB)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")

    return conn


def init_master_db() -> None:
    MASTER_DB.parent.mkdir(parents=True, exist_ok=True)
    with _connect() as conn:
        conn.executescript(SCHEMA)


def create_user(
    username: str,
    email: str,
    password_hash: str,
    is_admin: bool = False,
) -> int:
    now = datetime.now(timezone.utc).isoformat()
    with _connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO users (username, email, password_hash, is_admin, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (username, email, password_hash, int(is_admin), now),
        )
        return cur.lastrowid


def get_user_by_username(username: str) -> sqlite3.Row | None:
    with _connect() as conn:
        return conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()


def get_user_by_email(email: str) -> sqlite3.Row | None:
    with _connect() as conn:
        return conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()


def get_user_by_id(user_id: int) -> sqlite3.Row | None:
    with _connect() as conn:
        return conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()


def count_users() -> int:
    with _connect() as conn:
        return conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]


def list_all_users() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, username, email, is_admin, created_at, last_login_at FROM users ORDER BY created_at"
        ).fetchall()
        return [dict(r) for r in rows]


def update_user(user_id: int, fields: dict) -> dict:
    allowed = {"username", "email", "is_admin"}
    updates = {k: v for k, v in fields.items() if k in allowed}
    if not updates:
        raise ValueError("No updatable fields provided")
    set_clause = ", ".join(f"{col} = ?" for col in updates)
    with _connect() as conn:
        cur = conn.execute(
            f"UPDATE users SET {set_clause} WHERE id = ?",
            [*updates.values(), user_id],
        )
        if cur.rowcount == 0:
            raise LookupError(f"User {user_id} not found")
        row = conn.execute(
            "SELECT id, username, email, is_admin, created_at, last_login_at FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        return dict(row)


def update_password(user_id: int, new_hash: str) -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (new_hash, user_id),
        )


def delete_user(user_id: int) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
