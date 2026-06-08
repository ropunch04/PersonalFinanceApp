from dotenv import load_dotenv
from flask import Flask, g
from models.user import init_master_db
from routes.auth_routes import bp as auth_bp
from routes.categories import bp as categories_bp
from routes.transactions import bp as transactions_bp

load_dotenv()

app = Flask(__name__)
app.register_blueprint(auth_bp)
app.register_blueprint(categories_bp)
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


if __name__ == "__main__":
    import config
    app.run(host="0.0.0.0", port=5100, debug=config.DEBUG)
