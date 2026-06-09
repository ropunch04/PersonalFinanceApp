import os

import bcrypt
from flask import Blueprint, g, request

from auth.jwt_utils import encode_token
from auth.middleware import require_auth
from db_context import init_user_db
from models.user import (
    create_user,
    get_user_by_email,
    get_user_by_id,
    get_user_by_username,
    update_password,
)

bp = Blueprint("auth", __name__, url_prefix="/api/auth")

_GENERIC_LOGIN_ERROR = {"error": "Invalid credentials"}


@bp.post("/register")
def register():
    if os.environ.get("REGISTRATION_ENABLED", "true").lower() == "false":
        return {"error": "Registration is closed"}, 403

    body = request.get_json(silent=True) or {}
    username = body.get("username", "").strip()
    email = body.get("email", "").strip()
    password = body.get("password", "")

    if not username or not email or not password:
        return {"error": "username, email, and password are required"}, 400

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
def login():
    body = request.get_json(silent=True) or {}
    identifier = body.get("username", "").strip()
    password = body.get("password", "")

    row = get_user_by_username(identifier) or get_user_by_email(identifier)
    if not row:
        return _GENERIC_LOGIN_ERROR, 401

    if not bcrypt.checkpw(password.encode(), row["password_hash"].encode()):
        return _GENERIC_LOGIN_ERROR, 401

    init_user_db(row["id"])
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
def change_password():
    body = request.get_json(silent=True) or {}
    current_password = body.get("current_password", "")
    new_password = body.get("new_password", "")

    if not current_password or not new_password:
        return {"error": "current_password and new_password are required"}, 400

    if len(new_password) < 8:
        return {"error": "new_password must be at least 8 characters"}, 400

    row = get_user_by_id(g.current_user["user_id"])
    if not row or not bcrypt.checkpw(current_password.encode(), row["password_hash"].encode()):
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
