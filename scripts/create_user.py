"""Create an app account from the shell.

There is intentionally no public registration endpoint; the owner runs this
manually on the host. --admin creates the account with is_admin=1 (this is the
admin bootstrap path).

Usage:
    ./venv/bin/python scripts/create_user.py <username> <email> [--admin]
"""

import argparse
import sys

from _common import bootstrap, prompt_password

bootstrap()

from auth.auth_db import AuthError, register_user  # noqa: E402
from db_context import init_user_db  # noqa: E402
from models.user import get_user_by_email, get_user_by_username, init_master_db  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Create a user account (owner-run, on the host).")
    parser.add_argument("username")
    parser.add_argument("email")
    parser.add_argument("--admin", action="store_true", help="grant admin privileges (is_admin=1)")
    args = parser.parse_args()

    username = args.username.strip()
    email = args.email.strip()
    if not username or not email:
        sys.exit("Error: username and email must be non-empty.")

    init_master_db()

    if get_user_by_username(username):
        sys.exit(f"Error: username '{username}' is already taken.")
    if get_user_by_email(email):
        sys.exit(f"Error: email '{email}' is already registered.")

    password = prompt_password()

    try:
        user_id = register_user(username, email, password, is_admin=args.admin)
    except AuthError as exc:
        sys.exit(f"Error: {exc}")

    init_user_db(user_id)

    role = "admin" if args.admin else "user"
    print(f"Created {role} '{username}' (id={user_id}); per-user finance DB initialized.")


if __name__ == "__main__":
    main()
