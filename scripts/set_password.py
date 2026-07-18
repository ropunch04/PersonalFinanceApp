"""Reset an existing user's password from the shell.

Usage:
    ./venv/bin/python scripts/set_password.py <username>
"""

import argparse
import sys

from _common import bootstrap, prompt_password

bootstrap()

import bcrypt  # noqa: E402

from models.user import get_user_by_username, update_password  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Set a new password for an existing user.")
    parser.add_argument("username")
    args = parser.parse_args()

    row = get_user_by_username(args.username)
    if not row:
        sys.exit(f"Error: no user named '{args.username}'.")

    password = prompt_password()
    new_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()
    update_password(row["id"], new_hash)
    print(f"Password updated for '{args.username}' (id={row['id']}).")


if __name__ == "__main__":
    main()
