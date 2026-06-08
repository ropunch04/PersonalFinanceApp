from flask import Blueprint, g, request

from auth.middleware import require_auth
from db_context import get_user_db

bp = Blueprint("categories", __name__, url_prefix="/api")


def _ok(data):
    return {"data": data, "error": None}


def _err(message, status):
    return {"data": None, "error": message}, status


@bp.get("/categories")
@require_auth
def list_categories():
    db = get_user_db(g.current_user["user_id"])
    rows = db.execute("SELECT id, name FROM categories ORDER BY name").fetchall()
    return _ok([dict(r) for r in rows])


@bp.post("/categories")
@require_auth
def create_category():
    db = get_user_db(g.current_user["user_id"])
    body = request.get_json(silent=True) or {}
    name = body.get("name", "").strip()

    if not name:
        return _err("name is required", 400)

    cur = db.execute("INSERT OR IGNORE INTO categories (name) VALUES (?)", (name,))
    db.commit()

    if cur.rowcount == 0:
        return _err("Category already exists", 409)

    row = db.execute("SELECT id, name FROM categories WHERE id = ?", (cur.lastrowid,)).fetchone()
    return _ok(dict(row)), 201
