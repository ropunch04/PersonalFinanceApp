"""Shared helpers for the owner-run CLI scripts in this directory."""

import os
import sys
from getpass import getpass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

MIN_PASSWORD_LENGTH = 12


def bootstrap() -> None:
    """Make project imports and relative paths (.env, data/) work from anywhere.

    Must be called before importing any project module: config.py loads .env via
    a relative path and db_context.py writes user DBs under data/.
    """
    os.chdir(REPO_ROOT)
    if str(REPO_ROOT) not in sys.path:
        sys.path.insert(0, str(REPO_ROOT))


def prompt_password() -> str:
    """Prompt twice via getpass and enforce the minimum length policy."""
    password = getpass("Password: ")
    if len(password) < MIN_PASSWORD_LENGTH:
        sys.exit(f"Error: password must be at least {MIN_PASSWORD_LENGTH} characters.")
    confirm = getpass("Confirm password: ")
    if password != confirm:
        sys.exit("Error: passwords do not match.")
    return password
