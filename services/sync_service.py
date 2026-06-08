import logging
import sqlite3
from datetime import datetime, timezone

from db_context import get_db_path
from models.user import MASTER_DB
from services.email_parser import fetch_emails
from services.encryption_service import decrypt

logger = logging.getLogger(__name__)


def _open_user_db(user_id: int) -> sqlite3.Connection:
    conn = sqlite3.connect(get_db_path(user_id))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def sync_user(user_id: int) -> dict:
    conn = _open_user_db(user_id)
    try:
        profile = conn.execute(
            "SELECT gmail_address, gmail_app_password_enc FROM profile WHERE id = 1"
        ).fetchone()

        if not profile or not profile["gmail_address"] or not profile["gmail_app_password_enc"]:
            return {"synced": 0, "error": "Gmail not configured"}

        try:
            app_password = decrypt(profile["gmail_app_password_enc"])
        except ValueError as exc:
            return {"synced": 0, "error": f"Failed to decrypt app password: {exc}"}

        transactions, parse_errors = fetch_emails(profile["gmail_address"], app_password, conn)

        now = datetime.now(timezone.utc).isoformat()
        synced = 0
        for row in transactions:
            cur = conn.execute(
                """
                INSERT OR IGNORE INTO transactions
                    (source_hash, category_id, amount, merchant_raw,
                     direction, notes, transaction_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    row["source_hash"],
                    row.get("category_id"),
                    row["amount"],
                    row["merchant_raw"],
                    row["direction"],
                    row.get("notes"),
                    row["transaction_at"],
                    now,
                ),
            )
            if cur.rowcount == 1:
                synced += 1

        conn.execute("UPDATE profile SET last_synced_at = ? WHERE id = 1", (now,))
        conn.commit()

        return {"synced": synced, "errors": parse_errors}

    except Exception as exc:
        logger.exception("sync_user(%s) failed", user_id)
        return {"synced": 0, "error": str(exc).strip("b'\"")}
    finally:
        conn.close()


def scheduled_sync_all() -> None:
    master = sqlite3.connect(MASTER_DB)
    master.row_factory = sqlite3.Row
    try:
        users = master.execute("SELECT id, username FROM users").fetchall()
    finally:
        master.close()

    for user in users:
        user_id = user["id"]
        conn = _open_user_db(user_id)
        try:
            profile = conn.execute("SELECT gmail_address FROM profile WHERE id = 1").fetchone()
            has_gmail = profile and profile["gmail_address"]
        finally:
            conn.close()

        if not has_gmail:
            continue

        result = sync_user(user_id)
        if "error" in result:
            logger.error(
                "sync failed for user %s (%s): %s", user_id, user["username"], result["error"]
            )
        else:
            logger.info(
                "synced user %s (%s): %d new, %d parse errors",
                user_id,
                user["username"],
                result["synced"],
                len(result.get("errors", [])),
            )
