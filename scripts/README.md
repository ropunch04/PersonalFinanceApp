# Owner CLI scripts

Public registration is removed from the API and the frontend. Accounts are created and
password-reset only from the shell on the host, using these scripts with the project venv.
They read the same `.env`/`DB_PATH` as the app and can be run from any directory.

## Create a user

```bash
./venv/bin/python scripts/create_user.py <username> <email>
```

Prompts for the password twice (hidden input, never on argv), enforces a minimum of
12 characters, bcrypt-hashes it (cost 12, same as login expects), inserts the user into
`master.db`, and initializes the per-user finance DB. Errors clearly on duplicate
username or email.

## Create the first admin (admin bootstrap)

```bash
./venv/bin/python scripts/create_user.py <username> <email> --admin
```

`--admin` sets `is_admin=1`. Further admins can then be managed via the admin API.

## Reset a password

```bash
./venv/bin/python scripts/set_password.py <username>
```

Same password prompt and 12-character minimum. Note: existing JWTs remain valid until
they expire (see SECURITY_AUDIT.md H3).
