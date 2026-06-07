from dotenv import load_dotenv
from flask import Flask
from models.user import init_master_db
from routes.auth_routes import bp as auth_bp

load_dotenv()

app = Flask(__name__)
app.register_blueprint(auth_bp)

init_master_db()

@app.get("/")
def index():
    return {"status": "ok"}


if __name__ == "__main__":
    import config
    app.run(host="0.0.0.0", port=5100, debug=config.DEBUG)
