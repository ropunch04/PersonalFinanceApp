from functools import wraps

from flask import g, request

from auth.jwt_utils import decode_token


def require_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return {"error": "Unauthorized"}, 401

        token = auth_header.removeprefix("Bearer ")
        try:
            payload = decode_token(token)
        except Exception:
            return {"error": "Unauthorized"}, 401

        g.current_user = {
            "user_id": payload["sub"],
            "username": payload["username"],
            "is_admin": payload["is_admin"],
        }

        return f(*args, **kwargs)

    return decorated


def require_admin(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not g.current_user.get("is_admin"):
            return {"error": "Forbidden"}, 403
        return f(*args, **kwargs)

    return decorated
