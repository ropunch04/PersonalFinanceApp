import os
from datetime import datetime, timezone

import bcrypt
from flask import Blueprint, g, request

from auth.jwt_utils import encode_token
from auth.middleware import require_auth
from db_context import init_user_db
from limiter import limiter
from models.user import (
    _connect,
    create_user,
    get_user_by_email,
    get_user_by_id,
    get_user_by_username,
    update_password,
)

bp = Blueprint("auth", __name__, url_prefix="/api/auth")

_GENERIC_LOGIN_ERROR = {"error": "Invalid credentials"}

# bcrypt (as of 5.0.0) raises ValueError on a password whose UTF-8 encoding
# exceeds 72 bytes, rather than truncating it. Every endpoint that hashes or
# checks a password must reject long ones *before* calling bcrypt — silently
# truncating instead would let two different passwords authenticate as the
# same account.
_MAX_PASSWORD_BYTES = 72


def _password_too_long(password: str) -> bool:
    return len(password.encode()) > _MAX_PASSWORD_BYTES


@bp.post("/register")
@limiter.limit("10 per hour")
def register():
    if os.environ.get("REGISTRATION_ENABLED", "true").lower() == "false":
        return {"error": "Registration is closed"}, 403

    body = request.get_json(silent=True) or {}
    username = body.get("username", "").strip()
    email = body.get("email", "").strip()
    password = body.get("password", "")

    if not username or not email or not password:
        return {"error": "username, email, and password are required"}, 400

    if len(password) < 8:
        return {"error": "Password must be at least 8 characters"}, 400

    if _password_too_long(password):
        return {"error": f"Password must be at most {_MAX_PASSWORD_BYTES} bytes"}, 400

    if get_user_by_username(username):
        return {"error": "Username already taken"}, 409

    if get_user_by_email(email):
        return {"error": "Email already registered"}, 409

    password_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()

    try:
        user_id = create_user(username, email, password_hash)
    except Exception:
        return {"error": "Registration failed"}, 500

    init_user_db(user_id)
    token = encode_token(user_id, username, is_admin=False)
    return {
        "data": {
            "token": token,
            "user": {"id": user_id, "username": username, "email": email, "is_admin": False},
        }
    }, 201


@bp.post("/login")
@limiter.limit("20 per minute; 100 per hour")
def login():
    body = request.get_json(silent=True) or {}
    identifier = body.get("username", "").strip()
    password = body.get("password", "")

    row = get_user_by_username(identifier) or get_user_by_email(identifier)
    if not row:
        return _GENERIC_LOGIN_ERROR, 401

    # A too-long password can never match a stored hash; treat it as a normal
    # wrong-password case (401) instead of letting bcrypt raise ValueError (500).
    # Login is unauthenticated and only rate-limited per-IP, so this is directly
    # reachable by anyone.
    if _password_too_long(password):
        return _GENERIC_LOGIN_ERROR, 401

    try:
        if not bcrypt.checkpw(password.encode(), row["password_hash"].encode()):
            return _GENERIC_LOGIN_ERROR, 401
    except ValueError:
        return _GENERIC_LOGIN_ERROR, 401

    init_user_db(row["id"])

    with _connect() as conn:
        conn.execute(
            "UPDATE users SET last_login_at = ? WHERE id = ?",
            (datetime.now(timezone.utc).isoformat(), row["id"]),
        )

    token = encode_token(row["id"], row["username"], bool(row["is_admin"]))
    return {
        "data": {
            "token": token,
            "user": {
                "id": row["id"],
                "username": row["username"],
                "email": row["email"],
                "is_admin": bool(row["is_admin"]),
            },
        }
    }


@bp.post("/change-password")
@require_auth
@limiter.limit("10 per hour")
def change_password():
    body = request.get_json(silent=True) or {}
    current_password = body.get("current_password", "")
    new_password = body.get("new_password", "")

    if not current_password or not new_password:
        return {"error": "current_password and new_password are required"}, 400

    if len(new_password) < 8:
        return {"error": "new_password must be at least 8 characters"}, 400

    if _password_too_long(new_password):
        return {"error": f"new_password must be at most {_MAX_PASSWORD_BYTES} bytes"}, 400

    row = get_user_by_id(g.current_user["user_id"])
    if not row:
        return {"error": "Current password is incorrect"}, 400

    try:
        current_ok = not _password_too_long(current_password) and bcrypt.checkpw(
            current_password.encode(), row["password_hash"].encode()
        )
    except ValueError:
        current_ok = False
    if not current_ok:
        return {"error": "Current password is incorrect"}, 400

    new_hash = bcrypt.hashpw(new_password.encode(), bcrypt.gensalt(rounds=12)).decode()
    update_password(g.current_user["user_id"], new_hash)
    return {"data": {"success": True}}


@bp.get("/me")
@require_auth
def me():
    row = get_user_by_id(g.current_user["user_id"])
    if not row:
        return {"error": "User not found"}, 404
    return {
        "data": {
            "id": row["id"],
            "username": row["username"],
            "email": row["email"],
            "is_admin": bool(row["is_admin"]),
            "last_login_at": row["last_login_at"],
        }
    }
