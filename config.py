import os
from dotenv import load_dotenv

load_dotenv()

SECRET_KEY = os.environ.get("SECRET_KEY", "")
if not SECRET_KEY or len(SECRET_KEY) < 32:
    raise ValueError(
        "SECRET_KEY must be set in the environment and at least 32 characters long."
    )

DEBUG = os.environ.get("DEBUG", "false").lower() in ("1", "true", "yes")

DB_PATH = os.environ.get("DB_PATH", "data/finance.db")

ENCRYPTION_KEY = os.environ.get("ENCRYPTION_KEY", "")
if not ENCRYPTION_KEY:
    raise ValueError("ENCRYPTION_KEY must be set in the environment.")

LOG_FILE = os.environ.get("LOG_FILE", "logs/app.log")
