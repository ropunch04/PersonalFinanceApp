from datetime import datetime, timedelta, timezone

import jwt

import config

_ALGORITHM = "HS256"
_TTL_HOURS = 168


def encode_token(user_id: int, username: str, is_admin: bool) -> str:
    payload = {
        "sub": str(user_id),
        "username": username,
        "is_admin": is_admin,
        "exp": datetime.now(timezone.utc) + timedelta(hours=_TTL_HOURS),
    }
    return jwt.encode(payload, config.SECRET_KEY, algorithm=_ALGORITHM)


def decode_token(token: str) -> dict:
    payload = jwt.decode(token, config.SECRET_KEY, algorithms=[_ALGORITHM])
    payload["sub"] = int(payload["sub"])
    return payload
