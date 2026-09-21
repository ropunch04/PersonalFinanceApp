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
    awaiting_reimbursement INTEGER NOT NULL DEFAULT 0
);

-- A payment (inflow) can be applied, in whole or in part, against one or
-- more charges (outflows) — and one charge can be paid down by several
-- payments.
CREATE TABLE IF NOT EXISTS reimbursement_links (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    inflow_id    INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    outflow_id   INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    amount       REAL    NOT NULL CHECK(amount > 0),
    created_at   TEXT    NOT NULL
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

    try:
        conn.execute("ALTER TABLE transactions ADD COLUMN awaiting_reimbursement INTEGER NOT NULL DEFAULT 0")
        conn.commit()
    except Exception:
        pass  # column already exists

    try:
        conn.execute("UPDATE transactions SET transaction_at = transaction_at || 'T00:00:00' WHERE LENGTH(transaction_at) = 10")
        conn.commit()
    except Exception:
        pass

    conn.execute("""
        CREATE TABLE IF NOT EXISTS reimbursement_links (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            inflow_id    INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
            outflow_id   INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
            amount       REAL    NOT NULL CHECK(amount > 0),
            created_at   TEXT    NOT NULL
        )
    """)
    conn.commit()

    _migrate_reimbursements(conn)
    _migrate_awaiting_reimbursement(conn)
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


def _migrate_reimbursements(conn: sqlite3.Connection) -> None:
    """One-time backfill from the old reimburses_id / status columns into the
    new reimbursement_links table and expected_reimbursement column, then
    drops those legacy columns entirely. Guarded on the columns' presence, so
    this is a no-op on a DB that's already been through it (or a fresh
    install that never had them) — safe to call on every connection.
    """
    legacy_cols = {row["name"] for row in conn.execute("PRAGMA table_info(transactions)").fetchall()}
    if "reimburses_id" not in legacy_cols:
        return

    # This backfill writes into expected_reimbursement / reimbursement_external,
    # which are themselves legacy by now (see _migrate_awaiting_reimbursement) —
    # but a DB this old may not have them yet either, so provision them here,
    # just long enough for that later step to fold them into
    # awaiting_reimbursement and drop them for good.
    if "expected_reimbursement" not in legacy_cols:
        conn.execute("ALTER TABLE transactions ADD COLUMN expected_reimbursement REAL")
    if "reimbursement_external" not in legacy_cols:
        conn.execute("ALTER TABLE transactions ADD COLUMN reimbursement_external INTEGER NOT NULL DEFAULT 0")
    conn.commit()

    links_exist = conn.execute("SELECT COUNT(*) AS n FROM reimbursement_links").fetchone()["n"]
    if links_exist == 0:
        legacy_links = conn.execute(
            "SELECT id, amount, reimburses_id FROM transactions WHERE reimburses_id IS NOT NULL"
        ).fetchall()
        if legacy_links:
            now = datetime.now(timezone.utc).isoformat()
            conn.executemany(
                "INSERT INTO reimbursement_links (inflow_id, outflow_id, amount, created_at) "
                "VALUES (?, ?, ?, ?)",
                [(row["id"], row["reimburses_id"], row["amount"], now) for row in legacy_links],
            )
            conn.commit()

    if "reimbursement_status" in legacy_cols:
        legacy_status = conn.execute(
            """
            SELECT id, amount, reimbursement_status, reimbursement_mode, reimbursement_value
            FROM transactions
            WHERE reimbursement_status IS NOT NULL AND expected_reimbursement IS NULL
            """
        ).fetchall()
        for row in legacy_status:
            if row["reimbursement_status"] == "expensed":
                expected, external = row["amount"], 1
            elif row["reimbursement_mode"] == "flat":
                expected, external = min(row["reimbursement_value"] or 0, row["amount"]), 0
            elif row["reimbursement_mode"] == "percent":
                expected, external = row["amount"] * (row["reimbursement_value"] or 0) / 100.0, 0
            else:
                continue
            conn.execute(
                "UPDATE transactions SET expected_reimbursement = ?, reimbursement_external = ? WHERE id = ?",
                (expected, external, row["id"]),
            )
        if legacy_status:
            conn.commit()

    for col in ("reimburses_id", "reimbursement_status", "reimbursement_mode", "reimbursement_value"):
        try:
            conn.execute(f"ALTER TABLE transactions DROP COLUMN {col}")
        except Exception:
            pass  # already dropped, or this SQLite build predates DROP COLUMN
    conn.commit()


def _migrate_awaiting_reimbursement(conn: sqlite3.Connection) -> None:
    """Folds the old amount-based expected_reimbursement / reimbursement_external
    columns into a single awaiting_reimbursement boolean (a charge either is or
    isn't flagged as waiting on a Venmo/Zelle-style reimbursement — clearing it
    is always a manual "mark complete", not amount math), then drops the old
    columns. Guarded on their presence, so a no-op once done (or on a fresh
    install that never had them) — safe to call on every connection.
    """
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(transactions)").fetchall()}
    if "expected_reimbursement" not in cols:
        return

    conn.execute(
        "UPDATE transactions SET awaiting_reimbursement = 1 "
        "WHERE expected_reimbursement IS NOT NULL AND awaiting_reimbursement = 0"
    )
    conn.commit()

    for col in ("expected_reimbursement", "reimbursement_external"):
        try:
            conn.execute(f"ALTER TABLE transactions DROP COLUMN {col}")
        except Exception:
            pass  # already dropped, or this SQLite build predates DROP COLUMN
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
        g.user_db = conn
    return g.user_db


def init_user_db(user_id: int) -> None:
    Path("data").mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(get_db_path(user_id), timeout=15)
    try:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(_SCHEMA)
        # Login calls this for existing DBs too — bring them up to the current
        # schema before the seed statements below reference new columns.
        _migrate(conn)
        now = datetime.now(timezone.utc).isoformat()
        conn.executemany(
            "INSERT OR IGNORE INTO categories (name, sort_order) VALUES (?, ?)",
            [(name, i) for i, name in enumerate(_DEFAULT_CATEGORIES)],
        )
        conn.execute(
            "UPDATE categories SET is_misc = 1 "
            "WHERE id = (SELECT id FROM categories WHERE LOWER(name) = 'other' ORDER BY id LIMIT 1) "
            "AND NOT EXISTS (SELECT 1 FROM categories WHERE is_misc = 1)"
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
