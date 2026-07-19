# Deployment Guide — trackmyspend.xyz (Raspberry Pi)

Day-to-day commands for deploying and operating the app on the Pi. The app runs as
the `finance-app` systemd service (gunicorn on `127.0.0.1:5100`) behind a Cloudflare
Tunnel (`cloudflared` systemd service) that serves `trackmyspend.xyz`. Nothing is
port-forwarded; the Pi only makes outbound connections to Cloudflare.

Replace `<pi-ip>` with the Pi's LAN IP (or an SSH alias) throughout.

---

## 1. Redeploy (the common case)

Run from your Mac, in the repo root:

```bash
# Step 1 — sync code to the Pi (never touches data/, .env, or logs/)
rsync -avz \
  --exclude='.env' \
  --exclude='venv/' \
  --exclude='frontend/node_modules/' \
  --exclude='frontend/dist/' \
  --exclude='data/' \
  --exclude='logs/' \
  --exclude='__pycache__/' \
  --exclude='.git/' \
  ~/Documents/Projects/FinanceApps/PersonalFinanceApp/ rohitpras@<pi-ip>:~/PersonalFinanceApp/

# Step 2 — rebuild the frontend (only if frontend code changed)
ssh rohitpras@<pi-ip> "cd ~/PersonalFinanceApp/frontend && npm run build"

# Step 3 — restart the app
ssh rohitpras@<pi-ip> "sudo systemctl restart finance-app"
```

Cheat sheet:

| What changed | Steps |
|---|---|
| Backend only (`.py`) | 1, 3 |
| Frontend only (`.jsx`/`.css`) | 1, 2, 3 |
| Both | 1, 2, 3 |
| `requirements.txt` | 1, then `ssh rohitpras@<pi-ip> "cd ~/PersonalFinanceApp && venv/bin/pip install -r requirements.txt"`, then 3 |
| `frontend/package.json` | 1, then `ssh rohitpras@<pi-ip> "cd ~/PersonalFinanceApp/frontend && npm install"`, then 2, 3 |
| systemd unit files in `deploy/` | 1, then see §5 |

### Schema changes are automatic

`db_context._migrate()` runs on every DB connection: new columns are added via
guarded `ALTER TABLE` (a no-op once applied) and new tables via
`CREATE TABLE IF NOT EXISTS`. **No manual `ALTER TABLE` on the Pi is ever needed** —
a normal redeploy + restart migrates every user DB on its next request.
(Still take a backup first when a deploy includes schema changes — see §2.)

---

## 2. Backup (do this before risky deploys)

```bash
# On the Pi — snapshot every database into a timestamped folder
ssh rohitpras@<pi-ip> '
  cd ~/PersonalFinanceApp &&
  ts=$(date +%Y%m%d-%H%M%S) &&
  mkdir -p data/backups/$ts &&
  for db in data/*.db; do
    sqlite3 "$db" ".backup data/backups/$ts/$(basename $db)"
  done &&
  echo "Backed up to data/backups/$ts" && ls -la data/backups/$ts
'
```

`sqlite3 .backup` is safe against a running app (unlike `cp`, it takes a consistent
snapshot even mid-write). Periodically copy `data/backups/` off the Pi:

```bash
rsync -avz rohitpras@<pi-ip>:~/PersonalFinanceApp/data/backups/ ~/FinanceBackups/
```

---

## 3. Status & logs

```bash
# Is everything up?
ssh rohitpras@<pi-ip> "systemctl status finance-app cloudflared --no-pager"

# Follow app logs (journal)
ssh rohitpras@<pi-ip> "journalctl -u finance-app -f"

# Follow tunnel logs
ssh rohitpras@<pi-ip> "journalctl -u cloudflared -f"

# App/access log files directly
ssh rohitpras@<pi-ip> "tail -f ~/PersonalFinanceApp/logs/app.log"
ssh rohitpras@<pi-ip> "tail -f ~/PersonalFinanceApp/logs/access.log"
```

Quick health checks:

```bash
ssh rohitpras@<pi-ip> "curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5100/"   # app answering locally
curl -s -o /dev/null -w '%{http_code}\n' https://trackmyspend.xyz/                        # end-to-end through the tunnel
```

---

## 4. Service control

```bash
ssh rohitpras@<pi-ip> "sudo systemctl restart finance-app"    # restart app
ssh rohitpras@<pi-ip> "sudo systemctl restart cloudflared"    # restart tunnel
ssh rohitpras@<pi-ip> "sudo systemctl stop finance-app"       # stop app
ssh rohitpras@<pi-ip> "sudo systemctl start finance-app"      # start app
```

Both units are `enabled`, so they start automatically after a reboot or power loss.

---

## 5. Updating the systemd units or tunnel config

The unit files and tunnel ingress rules are versioned in `deploy/`. After changing
them (and rsyncing, §1 step 1):

```bash
# Reinstall the units
ssh rohitpras@<pi-ip> "
  sudo cp ~/PersonalFinanceApp/deploy/finance-app.service /etc/systemd/system/ &&
  sudo cp ~/PersonalFinanceApp/deploy/cloudflared.service /etc/systemd/system/ &&
  sudo systemctl daemon-reload &&
  sudo systemctl restart finance-app cloudflared
"
```

Tunnel config (`deploy/cloudflared-config.yml` → `~/.cloudflared/config.yml`):

```bash
# One-time: fill in the real tunnel UUID first (find it with: cloudflared tunnel list)
ssh rohitpras@<pi-ip> "
  cp ~/PersonalFinanceApp/deploy/cloudflared-config.yml ~/.cloudflared/config.yml &&
  sudo systemctl restart cloudflared
"
```

The config uses an explicit ingress list: `trackmyspend.xyz` (and `www`) →
`http://localhost:5100`, everything else → 404. The hardened `cloudflared.service`
expects this file at `/home/rohitpras/.cloudflared/config.yml`.

Note: the `finance-app` unit uses `ProtectSystem=full` + `ReadWritePaths` so the
process can only write inside `data/` and `logs/`. If you ever add a new writable
directory (e.g. an uploads folder), add another `ReadWritePaths=` line to the unit
and reinstall it.

---

## 6. File permissions (one-time lockdown)

```bash
ssh rohitpras@<pi-ip> "
  chmod 600 ~/PersonalFinanceApp/.env &&
  chmod 700 ~/PersonalFinanceApp/data &&
  chmod 600 ~/PersonalFinanceApp/data/*.db
"
```

---

## 7. Production `.env` checklist

The Pi's `.env` (never rsynced, never committed) should have:

```env
SECRET_KEY=<64 hex chars — python3 -c "import secrets; print(secrets.token_hex(32))">
ENCRYPTION_KEY=<fernet key — keep stable or stored Gmail creds become unreadable>
DEBUG=false
ALLOWED_ORIGIN=https://trackmyspend.xyz
RUN_SCHEDULER=false            # gunicorn's on_starting hook runs the scheduler
REGISTRATION_ENABLED=false     # set true only while an account needs to be created
```

`REGISTRATION_ENABLED` defaults to **open** when unset — on a public domain, keep it
explicitly `false` except during the brief window when someone needs to sign up.

Rate limiting note: the app now keys limits on Cloudflare's `CF-Connecting-IP`
header (real visitor IP) via ProxyFix. This is only correct while gunicorn stays
bound to `127.0.0.1` with the tunnel as its sole peer — don't change the bind
address in `gunicorn.conf.py`.

---

## 8. Troubleshooting

```bash
# App won't start — see why (config.py validates .env and refuses to boot on errors)
ssh rohitpras@<pi-ip> "journalctl -u finance-app -n 50 --no-pager"

# Site down but app fine locally — check the tunnel
ssh rohitpras@<pi-ip> "journalctl -u cloudflared -n 50 --no-pager"
ssh rohitpras@<pi-ip> "cloudflared tunnel list"

# Gmail sync issues — scheduler runs at 3:00 AM in the gunicorn master
ssh rohitpras@<pi-ip> "grep -i sync ~/PersonalFinanceApp/logs/app.log | tail -20"

# Disk space (SQLite WAL files + logs grow)
ssh rohitpras@<pi-ip> "df -h / && du -sh ~/PersonalFinanceApp/data ~/PersonalFinanceApp/logs"
```

Restore from a backup (app stopped first):

```bash
ssh rohitpras@<pi-ip> "
  sudo systemctl stop finance-app &&
  cp ~/PersonalFinanceApp/data/backups/<timestamp>/*.db ~/PersonalFinanceApp/data/ &&
  rm -f ~/PersonalFinanceApp/data/*.db-wal ~/PersonalFinanceApp/data/*.db-shm &&
  sudo systemctl start finance-app
"
```
