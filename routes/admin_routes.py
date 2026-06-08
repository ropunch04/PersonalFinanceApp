import sqlite3
import sys
from datetime import datetime, timezone

import bcrypt
from flask import Blueprint, g, request

import config
from auth.middleware import require_admin, require_auth
from db_context import get_db_path, init_user_db
from models.user import (
    count_users,
    create_user,
    delete_user,
    get_user_by_id,
    list_all_users,
    update_password,
    update_user,
)
from runtime_state import APP_START_TIME
from services import sync_service

admin_bp = Blueprint("admin", __name__, url_prefix="/api/admin")


def _ok(data):
    return {"data": data, "error": None}


def _err(message, status):
    return {"data": None, "error": message}, status


def _user_with_finance(user: dict) -> dict:
    try:
        conn = sqlite3.connect(get_db_path(user["id"]))
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT gmail_address, last_synced_at FROM profile WHERE id = 1"
        ).fetchone()
        conn.close()
        user["gmail_address"] = row["gmail_address"] if row else None
        user["last_synced_at"] = row["last_synced_at"] if row else None
        user["gmail_configured"] = bool(user["gmail_address"])
    except Exception:
        user["gmail_address"] = None
        user["last_synced_at"] = None
        user["gmail_configured"] = False
    return user


# ── Users ────────────────────────────────────────────────────────────────────

@admin_bp.get("/users")
@require_auth
@require_admin
def list_users():
    users = [_user_with_finance(u) for u in list_all_users()]
    return _ok(users)


@admin_bp.post("/users")
@require_auth
@require_admin
def create_user_route():
    body = request.get_json(silent=True) or {}
    username = body.get("username", "").strip()
    email = body.get("email", "").strip()
    password = body.get("password", "")
    is_admin = bool(body.get("is_admin", False))

    if not username or not email or not password:
        return _err("username, email, and password are required", 400)

    password_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()

    try:
        user_id = create_user(username, email, password_hash, is_admin=is_admin)
    except Exception as e:
        return _err(str(e), 409)

    init_user_db(user_id)
    user = _user_with_finance(dict(get_user_by_id(user_id)))
    user.pop("password_hash", None)
    return _ok(user), 201


@admin_bp.put("/users/<int:user_id>")
@require_auth
@require_admin
def update_user_route(user_id):
    body = request.get_json(silent=True) or {}
    allowed = {"username", "email", "is_admin"}
    fields = {k: v for k, v in body.items() if k in allowed}

    if not fields:
        return _err("No updatable fields provided", 400)

    if "is_admin" in fields and user_id == g.current_user["user_id"]:
        return _err("Cannot change your own admin status", 400)

    try:
        updated = update_user(user_id, fields)
    except ValueError as e:
        return _err(str(e), 400)
    except Exception as e:
        return _err(str(e), 409)

    return _ok(updated)


@admin_bp.post("/users/<int:user_id>/reset-password")
@require_auth
@require_admin
def reset_password(user_id):
    body = request.get_json(silent=True) or {}
    new_password = body.get("new_password", "")

    if not new_password:
        return _err("new_password is required", 400)

    new_hash = bcrypt.hashpw(new_password.encode(), bcrypt.gensalt(rounds=12)).decode()
    update_password(user_id, new_hash)
    return _ok({"success": True})


@admin_bp.delete("/users/<int:user_id>")
@require_auth
@require_admin
def delete_user_route(user_id):
    if user_id == g.current_user["user_id"]:
        return _err("Cannot delete your own account", 400)

    delete_user(user_id)
    return _ok({"deleted": True})


@admin_bp.post("/users/<int:user_id>/sync")
@require_auth
@require_admin
def sync_user(user_id):
    try:
        result = sync_service.sync_user(user_id)
    except Exception as e:
        return _err(str(e), 500)

    if result.get("error"):
        return _err(result["error"], 400)

    return _ok(result)


# ── System ───────────────────────────────────────────────────────────────────

@admin_bp.get("/system")
@require_auth
@require_admin
def system_info():
    uptime = (datetime.now(timezone.utc) - APP_START_TIME).total_seconds()
    return _ok({
        "uptime_seconds": uptime,
        "user_count": count_users(),
        "python_version": sys.version,
        "platform": sys.platform,
    })


# ── Logs ─────────────────────────────────────────────────────────────────────

@admin_bp.get("/logs")
@require_auth
@require_admin
def get_logs():
    n = request.args.get("lines", default=100, type=int)

    try:
        with open(config.LOG_FILE, "r") as f:
            all_lines = f.readlines()
    except FileNotFoundError:
        return _ok({"lines": [], "total_lines": 0})

    total = len(all_lines)
    tail = [line.rstrip("\n") for line in all_lines[-n:]]
    return _ok({"lines": tail, "total_lines": total})
