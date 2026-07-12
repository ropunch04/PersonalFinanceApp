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
    rows = db.execute("SELECT id, name FROM categories ORDER BY sort_order, id").fetchall()
    return _ok([dict(r) for r in rows])


@bp.post("/categories")
@require_auth
def create_category():
    db = get_user_db(g.current_user["user_id"])
    body = request.get_json(silent=True) or {}
    name = body.get("name", "").strip()

    if not name:
        return _err("name is required", 400)

    cur = db.execute(
        "INSERT OR IGNORE INTO categories (name, sort_order) "
        "VALUES (?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM categories))",
        (name,),
    )

    if cur.rowcount == 0:
        db.commit()
        return _err("Category already exists", 409)

    db.execute("INSERT OR IGNORE INTO budgets (category_id, amount) VALUES (?, 0)", (cur.lastrowid,))
    db.commit()

    row = db.execute("SELECT id, name FROM categories WHERE id = ?", (cur.lastrowid,)).fetchone()
    return _ok(dict(row)), 201


@bp.delete("/categories/<int:category_id>")
@require_auth
def delete_category(category_id):
    db = get_user_db(g.current_user["user_id"])
    row = db.execute("SELECT id FROM categories WHERE id = ?", (category_id,)).fetchone()
    if row is None:
        return _err("Category not found", 404)

    in_use = db.execute(
        "SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?", (category_id,)
    ).fetchone()["n"]
    if in_use > 0:
        return _err(f"Cannot delete: {in_use} transaction(s) still use this category", 409)

    db.execute("DELETE FROM budgets WHERE category_id = ?", (category_id,))
    db.execute("DELETE FROM categories WHERE id = ?", (category_id,))
    db.commit()
    return _ok({"id": category_id})


@bp.put("/categories/reorder")
@require_auth
def reorder_categories():
    db = get_user_db(g.current_user["user_id"])
    body = request.get_json(silent=True) or {}
    order = body.get("order")

    if not isinstance(order, list) or not order:
        return _err("order must be a non-empty list of category ids", 400)

    existing_ids = {r["id"] for r in db.execute("SELECT id FROM categories").fetchall()}
    if set(order) != existing_ids:
        return _err("order must include every category id exactly once", 400)

    for index, category_id in enumerate(order):
        db.execute("UPDATE categories SET sort_order = ? WHERE id = ?", (index, category_id))
    db.commit()

    rows = db.execute("SELECT id, name FROM categories ORDER BY sort_order, id").fetchall()
    return _ok([dict(r) for r in rows])
