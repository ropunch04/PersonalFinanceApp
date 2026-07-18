#!/usr/bin/env bash
# One-stop setup + management script for Kyle's PersonalFinanceApp fork.
#
# Usage: ./scripts/manage.sh <command> [args]
#
# Run `./scripts/manage.sh help` for the full command list.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

VENV_DIR="$REPO_ROOT/venv"
PY="$VENV_DIR/bin/python"
PIP="$VENV_DIR/bin/pip"
SERVICE=finance-app
TUNNEL_SERVICE=cloudflared

is_linux_systemd() {
  [[ "$(uname -s)" == "Linux" ]] && command -v systemctl >/dev/null 2>&1
}

log()  { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$1"; }
die()  { printf '\033[1;31mError:\033[0m %s\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------------------
# setup — first-time install: venv, backend deps, frontend deps+build, .env
# ---------------------------------------------------------------------------
cmd_setup() {
  log "Creating Python virtualenv (venv/)"
  [[ -d "$VENV_DIR" ]] || python3 -m venv "$VENV_DIR"

  log "Installing backend dependencies"
  "$PIP" install --upgrade pip >/dev/null
  "$PIP" install -r requirements.txt

  log "Installing frontend dependencies"
  (cd frontend && npm install)

  if [[ ! -f .env ]]; then
    if is_linux_systemd; then
      log "Linux host detected — creating production .env from deploy/env.production"
      cp deploy/env.production .env
      local secret_key enc_key
      secret_key="$("$PY" -c 'import secrets; print(secrets.token_hex(32))')"
      enc_key="$("$PY" -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())')"
      sed -i "s|REPLACE_WITH_64_CHAR_HEX|$secret_key|" .env
      sed -i "s|REPLACE_WITH_FERNET_KEY|$enc_key|" .env
      warn "Edit .env now to set ALLOWED_ORIGIN to your real domain (currently a placeholder)."
    else
      log "Creating a local dev .env"
      local secret_key enc_key
      secret_key="$("$PY" -c 'import secrets; print(secrets.token_hex(32))')"
      enc_key="$("$PY" -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())')"
      cat > .env <<EOF
SECRET_KEY=$secret_key
ENCRYPTION_KEY=$enc_key
DEBUG=true
DB_PATH=data/finance.db
ALLOWED_ORIGIN=http://localhost:5173
RUN_SCHEDULER=false
EOF
    fi
  else
    log ".env already exists — leaving it alone"
  fi

  mkdir -p data logs
  log "Building frontend (frontend/dist/)"
  (cd frontend && npm run build)

  echo
  log "Setup complete."
  if is_linux_systemd; then
    echo "Next steps:"
    echo "  1. Review .env (especially ALLOWED_ORIGIN)"
    echo "  2. Create your account:  ./scripts/manage.sh create-user <username> <email> --admin"
    echo "  3. Install the systemd services:  sudo ./scripts/manage.sh install-service"
    echo "  4. Start it:  ./scripts/manage.sh start"
  else
    echo "Next steps:"
    echo "  1. Create your account:  ./scripts/manage.sh create-user <username> <email> --admin"
    echo "  2. Run the dev servers:  ./scripts/manage.sh dev"
  fi
}

# ---------------------------------------------------------------------------
# install-service — install/enable the systemd units (Linux prod host only)
# ---------------------------------------------------------------------------
cmd_install_service() {
  is_linux_systemd || die "install-service requires a Linux host with systemd."
  [[ $EUID -eq 0 ]] || die "install-service must be run with sudo."

  log "Installing systemd unit: $SERVICE"
  cp "$REPO_ROOT/deploy/finance-app.service" /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable "$SERVICE"

  if [[ -f "$REPO_ROOT/deploy/cloudflared.service" ]] && command -v cloudflared >/dev/null 2>&1; then
    log "Installing systemd unit: $TUNNEL_SERVICE"
    cp "$REPO_ROOT/deploy/cloudflared.service" /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable "$TUNNEL_SERVICE"
    warn "Make sure ~/.cloudflared/config.yml exists (see deploy/cloudflared-config.yml) before starting $TUNNEL_SERVICE."
  else
    warn "cloudflared not found — skipping tunnel service install."
  fi

  log "Services installed and enabled. Start them with: ./scripts/manage.sh start"
}

# ---------------------------------------------------------------------------
# start / stop / restart / status / logs — service control
# ---------------------------------------------------------------------------
require_systemd_or_hint() {
  is_linux_systemd || die "No systemd here. For local dev use: ./scripts/manage.sh dev"
}

cmd_start()   { require_systemd_or_hint; sudo systemctl start "$SERVICE";   log "$SERVICE started";   }
cmd_stop()    { require_systemd_or_hint; sudo systemctl stop "$SERVICE";    log "$SERVICE stopped";   }
cmd_restart() { require_systemd_or_hint; sudo systemctl restart "$SERVICE"; log "$SERVICE restarted"; }
cmd_status()  {
  require_systemd_or_hint
  systemctl status "$SERVICE" --no-pager || true
  if systemctl list-unit-files "$TUNNEL_SERVICE.service" >/dev/null 2>&1; then
    echo
    systemctl status "$TUNNEL_SERVICE" --no-pager || true
  fi
}
cmd_logs() {
  if is_linux_systemd; then
    sudo journalctl -u "$SERVICE" -f
  else
    tail -f logs/app.log
  fi
}

cmd_tunnel() {
  is_linux_systemd || die "tunnel commands require a Linux host with systemd + cloudflared."
  case "${1:-status}" in
    start)   sudo systemctl start "$TUNNEL_SERVICE";   log "$TUNNEL_SERVICE started" ;;
    stop)    sudo systemctl stop "$TUNNEL_SERVICE";    log "$TUNNEL_SERVICE stopped" ;;
    restart) sudo systemctl restart "$TUNNEL_SERVICE"; log "$TUNNEL_SERVICE restarted" ;;
    logs)    sudo journalctl -u "$TUNNEL_SERVICE" -f ;;
    status)  systemctl status "$TUNNEL_SERVICE" --no-pager ;;
    *) die "Usage: manage.sh tunnel {start|stop|restart|status|logs}" ;;
  esac
}

# ---------------------------------------------------------------------------
# dev — run the Flask + Vite dev servers locally (no systemd required)
# ---------------------------------------------------------------------------
cmd_dev() {
  [[ -f .env ]] || die "No .env found. Run ./scripts/manage.sh setup first."
  trap 'kill 0' EXIT
  log "Starting Flask (http://localhost:5100) and Vite (http://localhost:5173)"
  "$PY" app.py &
  (cd frontend && npm run dev) &
  wait
}

# ---------------------------------------------------------------------------
# update — pull latest code, reinstall deps if needed, rebuild, restart
# ---------------------------------------------------------------------------
cmd_update() {
  log "Pulling latest code"
  git pull --ff-only

  log "Syncing backend dependencies"
  "$PIP" install -r requirements.txt

  log "Rebuilding frontend"
  (cd frontend && npm install && npm run build)

  if is_linux_systemd; then
    cmd_restart
  else
    warn "No systemd here — restart your dev server manually (./scripts/manage.sh dev)."
  fi
  log "Update complete."
}

# ---------------------------------------------------------------------------
# backup — snapshot every SQLite DB in data/ to backups/<timestamp>/
# ---------------------------------------------------------------------------
cmd_backup() {
  local dest="$REPO_ROOT/data/backups/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$dest"
  local found=0
  for db in data/*.db; do
    [[ -e "$db" ]] || continue
    found=1
    sqlite3 "$db" ".backup '$dest/$(basename "$db")'"
  done
  [[ $found -eq 1 ]] || die "No databases found in data/."
  log "Backed up databases to $dest"
}

# ---------------------------------------------------------------------------
# create-user / set-password — thin wrappers around scripts/*.py
# ---------------------------------------------------------------------------
cmd_create_user()  { "$PY" scripts/create_user.py "$@"; }
cmd_set_password() { "$PY" scripts/set_password.py "$@"; }

# ---------------------------------------------------------------------------
usage() {
  cat <<'EOF'
Usage: ./scripts/manage.sh <command> [args]

Setup
  setup                     Create venv, install deps, build frontend, write .env
  install-service           (sudo, Linux) Install/enable the systemd units

Run
  dev                       Run Flask + Vite dev servers locally
  start / stop / restart    Control the finance-app systemd service
  status                    Show finance-app (and cloudflared, if installed) status
  logs                      Follow app logs (journalctl in prod, logs/app.log in dev)
  tunnel {start|stop|restart|status|logs}
                             Control the cloudflared systemd service

Maintain
  update                    git pull, reinstall deps, rebuild frontend, restart
  backup                    Snapshot all data/*.db files to data/backups/<timestamp>/
  create-user <user> <email> [--admin]
                             Create an account (owner-only, no public registration)
  set-password <user>       Reset a user's password
EOF
}

main() {
  local cmd="${1:-help}"
  [[ $# -gt 0 ]] && shift || true
  case "$cmd" in
    setup)            cmd_setup ;;
    install-service)  cmd_install_service ;;
    dev)              cmd_dev ;;
    start)            cmd_start ;;
    stop)             cmd_stop ;;
    restart)          cmd_restart ;;
    status)           cmd_status ;;
    logs)             cmd_logs ;;
    tunnel)           cmd_tunnel "$@" ;;
    update)           cmd_update ;;
    backup)           cmd_backup ;;
    create-user)      cmd_create_user "$@" ;;
    set-password)     cmd_set_password "$@" ;;
    help|-h|--help)   usage ;;
    *) usage; die "Unknown command: $cmd" ;;
  esac
}

main "$@"
