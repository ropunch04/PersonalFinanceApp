from datetime import UTC, datetime

import bcrypt

from models.user import (
    _connect,
    create_user,
    get_user_by_id,
    get_user_by_username,
)

_DUMMY_HASH = bcrypt.hashpw(b"dummy", bcrypt.gensalt(rounds=12))


class AuthError(Exception):
    pass


def register_user(
    username: str,
    email: str,
    password: str,
    is_admin: bool = False,
) -> int:
    if get_user_by_username(username):
        raise AuthError(f"Username '{username}' is already taken.")

    password_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()
    return create_user(username, email, password_hash, is_admin=is_admin)


def authenticate_user(username: str, password: str) -> dict:
    row = get_user_by_username(username)

    if row:
        stored = row["password_hash"].encode()
    else:
        stored = _DUMMY_HASH

    match = bcrypt.checkpw(password.encode(), stored)
    if not row or not match:
        raise AuthError("Invalid credentials")

    _update_last_login(row["id"])
    return dict(get_user_by_username(username))


def _update_last_login(user_id: int) -> None:
    now = datetime.now(UTC).isoformat()
    with _connect() as conn:
        conn.execute(
            "UPDATE users SET last_login_at = ? WHERE id = ?",
            (now, user_id),
        )


def get_user(user_id: int) -> dict | None:
    row = get_user_by_id(user_id)
    return dict(row) if row else None
