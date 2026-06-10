import os

from dotenv import load_dotenv

load_dotenv()

SECRET_KEY = os.environ.get("SECRET_KEY", "")
if not SECRET_KEY or len(SECRET_KEY) < 32:
    raise ValueError("SECRET_KEY must be set in the environment and at least 32 characters long.")

DEBUG = os.environ.get("DEBUG", "false").lower() in ("1", "true", "yes")

DB_PATH = os.environ.get("DB_PATH", "data/finance.db")

ENCRYPTION_KEY = os.environ.get("ENCRYPTION_KEY", "")
if not ENCRYPTION_KEY:
    raise ValueError("ENCRYPTION_KEY must be set in the environment.")

LOG_FILE = os.environ.get("LOG_FILE", "logs/app.log")

ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "http://localhost:5173")

_is_localhost = ALLOWED_ORIGIN.startswith("http://localhost") or ALLOWED_ORIGIN.startswith("http://127.")
if DEBUG and not _is_localhost:
    raise ValueError(
        f"DEBUG=true but ALLOWED_ORIGIN={ALLOWED_ORIGIN!r} looks like a production URL. "
        "Set DEBUG=false in your production .env."
    )
if not DEBUG and _is_localhost:
    raise ValueError(
        f"DEBUG=false but ALLOWED_ORIGIN={ALLOWED_ORIGIN!r} looks like a localhost URL. "
        "Set ALLOWED_ORIGIN to your public domain in your production .env."
    )
