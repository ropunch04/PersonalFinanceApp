from flask import Blueprint, g

from auth.middleware import require_auth
from db_context import get_user_db
from services.budget_service import get_budget_summary

bp = Blueprint("dashboard", __name__, url_prefix="/api")


@bp.get("/dashboard")
@require_auth
def dashboard():
    conn = get_user_db(g.current_user["user_id"])
    return {"data": get_budget_summary(conn), "error": None}
