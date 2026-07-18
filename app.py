import atexit
import logging
import os
from logging.handlers import RotatingFileHandler

from apscheduler.schedulers.background import BackgroundScheduler
from dotenv import load_dotenv
from flask import Flask, g, request, send_from_directory
from werkzeug.middleware.proxy_fix import ProxyFix

import config
from limiter import limiter
from models.user import init_master_db
from routes.admin_routes import admin_bp
from routes.auth_routes import bp as auth_bp
from routes.categories import bp as categories_bp
from routes.dashboard import bp as dashboard_bp
from routes.import_route import bp as import_bp
from routes.profile import bp as profile_bp
from routes.recurring_income import bp as recurring_income_bp
from routes.sync_routes import bp as sync_bp
from routes.transactions import bp as transactions_bp
from services.sync_service import scheduled_sync_all

load_dotenv()

DIST_DIR = os.path.join(os.path.dirname(__file__), "frontend", "dist")

app = Flask(__name__)

# Trust exactly one proxy hop (the local cloudflared tunnel daemon) so
# remote_addr/scheme/host reflect the forwarded client. Safe only while the
# app is reached exclusively through a single trusted proxy (gunicorn binds
# 127.0.0.1 and the tunnel is the sole peer).
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

# 10 MB max upload size
app.config["MAX_CONTENT_LENGTH"] = 10 * 1024 * 1024

limiter.init_app(app)

app.register_blueprint(admin_bp)
app.register_blueprint(auth_bp)
app.register_blueprint(categories_bp)
app.register_blueprint(dashboard_bp)
app.register_blueprint(import_bp)
app.register_blueprint(profile_bp)
app.register_blueprint(recurring_income_bp)
app.register_blueprint(sync_bp)
app.register_blueprint(transactions_bp)

init_master_db()

os.makedirs("logs", exist_ok=True)
_file_handler = RotatingFileHandler(config.LOG_FILE, maxBytes=1_000_000, backupCount=5)
_file_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
logging.getLogger().addHandler(_file_handler)
logging.getLogger().setLevel(logging.INFO)
app.logger.info("Flask app started")


@app.teardown_appcontext
def close_user_db(_):
    db = g.pop("user_db", None)
    if db is not None:
        db.close()


@app.after_request
def apply_headers(response):
    origin = request.headers.get("Origin", "")
    if origin == config.ALLOWED_ORIGIN:
        response.headers["Access-Control-Allow-Origin"] = config.ALLOWED_ORIGIN
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
        response.headers["Vary"] = "Origin"

    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://static.cloudflareinsights.com; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' data:; "
        "connect-src 'self' https://cloudflareinsights.com;"
    )
    return response


@app.route("/api/", methods=["OPTIONS"])
@app.route("/api/<path:path>", methods=["OPTIONS"])
def options_handler(path=""):
    response = app.make_default_options_response()
    response.headers["Access-Control-Allow-Origin"] = config.ALLOWED_ORIGIN
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    return response


@app.get("/", defaults={"path": ""})
@app.get("/<path:path>")
def spa(path):
    full = os.path.join(DIST_DIR, path)
    if path and os.path.isfile(full):
        return send_from_directory(DIST_DIR, path)
    return send_from_directory(DIST_DIR, "index.html")


if os.environ.get("RUN_SCHEDULER", "false").lower() == "true":
    _scheduler = BackgroundScheduler(daemon=False)
    _scheduler.add_job(scheduled_sync_all, trigger="cron", hour=3, minute=0)
    _scheduler.start()
    atexit.register(lambda: _scheduler.running and _scheduler.shutdown(wait=False))


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5100, debug=config.DEBUG)
