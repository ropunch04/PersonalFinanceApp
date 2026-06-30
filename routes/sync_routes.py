import imaplib

from flask import Blueprint, g, request

from auth.middleware import require_auth
from db_context import get_user_db
from services.encryption_service import encrypt
from services.sync_service import sync_user

bp = Blueprint("sync", __name__, url_prefix="/api")


def _ok(data):
    return {"data": data, "error": None}


def _err(message, status):
    return {"data": None, "error": message}, status


@bp.put("/profile/gmail")
@require_auth
def save_gmail():
    body = request.get_json(silent=True) or {}
    gmail_address = body.get("gmail_address", "").strip()
    app_password = body.get("app_password", "").strip()

    if not gmail_address or not app_password:
        return _err("gmail_address and app_password are required", 400)

    try:
        mail = imaplib.IMAP4_SSL("imap.gmail.com", 993)
        mail.login(gmail_address, app_password)
        mail.logout()
    except imaplib.IMAP4.error:
        return _err("Invalid Gmail address or app password — please check and try again", 400)
    except Exception:
        return _err("Could not connect to Gmail — check your internet connection and try again", 400)

    encrypted = encrypt(app_password)
    conn = get_user_db(g.current_user["user_id"])
    conn.execute(
        "UPDATE profile SET gmail_address = ?, gmail_app_password_enc = ? WHERE id = 1",
        (gmail_address, encrypted),
    )
    conn.commit()

    return _ok({"gmail_address": gmail_address, "gmail_configured": True})


@bp.delete("/profile/gmail")
@require_auth
def delete_gmail():
    conn = get_user_db(g.current_user["user_id"])
    conn.execute(
        "UPDATE profile SET gmail_address = NULL, gmail_app_password_enc = NULL WHERE id = 1"
    )
    conn.commit()

    return _ok({"gmail_configured": False})


@bp.get("/sync/status")
@require_auth
def sync_status():
    conn = get_user_db(g.current_user["user_id"])
    row = conn.execute(
        "SELECT gmail_address, last_synced_at FROM profile WHERE id = 1"
    ).fetchone()
    return _ok({
        "credentials_configured": bool(row and row["gmail_address"]),
        "last_synced_at": row["last_synced_at"] if row else None,
    })


@bp.post("/sync")
@require_auth
def trigger_sync():
    result = sync_user(g.current_user["user_id"])
    if "error" in result and result["error"]:
        return _err(result["error"], 400)
    return _ok(result)
