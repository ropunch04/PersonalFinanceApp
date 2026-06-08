import os

import bcrypt
from flask import Blueprint, g, request
from auth.jwt_utils import encode_token
from auth.middleware import require_auth
from db_context import init_user_db
from models.user import create_user, get_user_by_email, get_user_by_username

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
    return {"data": {"token": token, "user": {"id": user_id, "username": username, "email": email, "is_admin": False}}}, 201


@bp.post("/login")
def login():
    body = request.get_json(silent=True) or {}
    username = body.get("username", "").strip()
    password = body.get("password", "")

    row = get_user_by_username(username)
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


@bp.get("/me")
@require_auth
def me():
    return g.current_user
