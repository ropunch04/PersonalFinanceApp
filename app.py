import atexit
import os

from apscheduler.schedulers.background import BackgroundScheduler
from dotenv import load_dotenv
from flask import Flask, g

import config
from models.user import init_master_db
from routes.auth_routes import bp as auth_bp
from routes.categories import bp as categories_bp
from routes.dashboard import bp as dashboard_bp
from routes.import_route import bp as import_bp
from routes.profile import bp as profile_bp
from routes.sync_routes import bp as sync_bp
from routes.transactions import bp as transactions_bp
from services.sync_service import scheduled_sync_all

load_dotenv()

app = Flask(__name__)
app.register_blueprint(auth_bp)
app.register_blueprint(categories_bp)
app.register_blueprint(dashboard_bp)
app.register_blueprint(import_bp)
app.register_blueprint(profile_bp)
app.register_blueprint(sync_bp)
app.register_blueprint(transactions_bp)

init_master_db()


@app.teardown_appcontext
def close_user_db(_):
    db = g.pop("user_db", None)
    if db is not None:
        db.close()


@app.get("/")
def index():
    return {"status": "ok"}


if os.environ.get("RUN_SCHEDULER", "false").lower() == "true":
    _scheduler = BackgroundScheduler(daemon=False)
    _scheduler.add_job(scheduled_sync_all, trigger="cron", hour=3, minute=0)
    _scheduler.start()
    atexit.register(lambda: _scheduler.running and _scheduler.shutdown(wait=False))


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5100, debug=config.DEBUG)
