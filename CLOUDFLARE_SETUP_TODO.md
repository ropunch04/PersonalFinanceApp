# Cloudflare Tunnel + Access — Manual Setup TODO (budget.kotero.dev)

Everything automatable is already done on this Pi:

- `cloudflared` 2026.7.2 installed at `~/.local/bin/cloudflared`
- ProxyFix + `CF-Connecting-IP` rate-limit keying applied in code
- `.env.production` created with fresh keys (`chmod 600`)
- `deploy/finance-app.service`, `deploy/cloudflared.service`, and
  `deploy/cloudflared-config.yml` rewritten for this Pi
- File permissions locked down (`.env` 600, `data/` 700, DBs 600)

The steps below are the ones only **you** can do (they need browser logins,
Namecheap access, or sudo). Do them **in order**.

---

## 1. Create a free Cloudflare account and add the kotero.dev zone

1. Sign up / log in at <https://dash.cloudflare.com> (Free plan is fine).
2. **Add a domain** → enter `kotero.dev` → choose the **Free** plan.
3. Cloudflare will scan and import existing DNS records. **Do not switch
   nameservers yet** — first verify the records in step 2 exist, or
   kotero.dev (your GitHub Pages site) will break.

## 2. Re-create the GitHub Pages DNS records in Cloudflare FIRST

In the Cloudflare dashboard → kotero.dev → **DNS → Records**, make sure these
exist (add any the import missed). These are what currently serves kotero.dev:

| Type  | Name  | Content              | Proxy status |
|-------|-------|----------------------|--------------|
| A     | `@`   | `185.199.108.153`    | DNS only (grey cloud) |
| A     | `@`   | `185.199.109.153`    | DNS only |
| A     | `@`   | `185.199.110.153`    | DNS only |
| A     | `@`   | `185.199.111.153`    | DNS only |
| CNAME | `www` | `kyleotero.github.io` | DNS only |

Notes:

- `www.kotero.dev` currently resolves to GitHub Pages (IPv4 + IPv6). Check
  your Namecheap DNS panel before switching: if `www` is a CNAME to
  `<something>.github.io`, copy it exactly; if it's A records, copy those.
  Also copy any TXT records you see at Namecheap (e.g.
  `_github-pages-challenge-...`) — they're needed to keep the GH Pages custom
  domain verified.
- **Start with "DNS only" (grey cloud)** on these records. GitHub Pages
  provisions/renews its HTTPS cert by seeing the real GH IPs; proxying
  (orange cloud) can break GH's cert issuance and cause redirect loops if
  GitHub's "Enforce HTTPS" and Cloudflare SSL mode disagree. You can flip to
  proxied later if you want — if you do, set Cloudflare **SSL/TLS mode to
  "Full (strict)"** first.

## 3. Switch nameservers at Namecheap

1. Cloudflare shows you **two assigned nameservers** (something like
   `xxx.ns.cloudflare.com` and `yyy.ns.cloudflare.com`) on the zone Overview
   page.
2. Namecheap → Domain List → `kotero.dev` → **Nameservers** → change from
   `dns1.registrar-servers.com` / `dns2.registrar-servers.com` to **Custom
   DNS** and paste the two Cloudflare nameservers.
3. Wait for Cloudflare to email/show "kotero.dev is active" (minutes to a few
   hours). Verify the Pages site still loads: <https://kotero.dev>.

## 4. Authenticate cloudflared and create the tunnel (on the Pi)

```bash
export PATH="$HOME/.local/bin:$PATH"   # if ~/.local/bin isn't already on PATH

cloudflared tunnel login          # opens a browser URL — pick the kotero.dev zone
cloudflared tunnel create budget  # prints a Tunnel ID (UUID) and writes
                                  # ~/.cloudflared/<TUNNEL_ID>.json (credentials — keep private)

# Route the hostname to the tunnel (creates the budget.kotero.dev CNAME in Cloudflare DNS):
cloudflared tunnel route dns budget budget.kotero.dev
```

Then install the config:

```bash
cp ~/projects/PersonalFinanceApp/deploy/cloudflared-config.yml ~/.cloudflared/config.yml
nano ~/.cloudflared/config.yml    # replace <TUNNEL_ID> (both places) with the UUID from `tunnel create`
chmod 600 ~/.cloudflared/config.yml ~/.cloudflared/*.json
```

## 5. Create the Cloudflare Access application (do BEFORE starting the tunnel)

This is the identity gate that keeps the app off the raw internet. In the
Cloudflare dashboard:

1. Go to **Zero Trust** (left sidebar / <https://one.dash.cloudflare.com>).
   First visit asks you to pick a team name (anything, e.g. `kotero`) —
   choose the **Free** plan.
2. **Access → Applications → Add an application → Self-hosted**.
3. Application configuration:
   - Application name: `Budget`
   - Session duration: `24 hours` (or shorter)
   - Public hostname: subdomain `budget`, domain `kotero.dev`, path empty.
4. **Add a policy**:
   - Policy name: `owner-allowlist`, Action: **Allow**
   - Include → Selector **Emails** → value: `kkyleotero@gmail.com`
     (add any other trusted emails, one per line — nothing else).
5. Leave the default identity provider (**One-time PIN**) enabled — allowed
   emails get a login code by mail. (Optionally add Google as a login method
   under Settings → Authentication.)
6. Save. From now on Cloudflare requires an allow-listed email login before
   *any* request reaches the Pi.

## 6. Switch the production env into place

```bash
cd ~/projects/PersonalFinanceApp
cp .env .env.dev-backup           # keep the dev config
cp .env.production .env           # fresh prod keys, DEBUG=false, registration off
chmod 600 .env .env.dev-backup
```

Notes:

- The production `ENCRYPTION_KEY` is new, so any Gmail app password saved
  under the dev key must be re-entered in the app after go-live.
- The dev server currently running on :5100 still uses the old config until
  it's replaced by the systemd service in step 7.
- Create your user/admin account before closing registration — see
  `scripts/create_user.py` (or register locally, then
  `sqlite3 data/master.db "UPDATE users SET is_admin=1 WHERE username='<you>';"`).

## 7. Install and start the systemd services (needs sudo)

```bash
# Stop the ad-hoc dev server first (whatever terminal/process runs :5100)

sudo cp ~/projects/PersonalFinanceApp/deploy/finance-app.service /etc/systemd/system/
sudo cp ~/projects/PersonalFinanceApp/deploy/cloudflared.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now finance-app
sudo systemctl enable --now cloudflared

systemctl status finance-app cloudflared   # both should be active (running)
journalctl -u cloudflared -f               # watch the tunnel connect
```

## 8. Final verification (do all of these)

1. **Access gate works:** from a browser with no Cloudflare session (private
   window or another device on mobile data), open
   <https://budget.kotero.dev> — you must see the **Cloudflare Access login**
   page, NOT the app. Log in with your allow-listed email; the app appears.
   Try a non-allow-listed email — it must be denied.
2. **LAN port is closed:** from *another* machine on your home network:
   `curl -m 5 http://<pi-lan-ip>:5100/` must fail/refuse (gunicorn binds
   127.0.0.1 only — if this succeeds, something else is listening; stop it).
3. **GitHub Pages still works:** <https://kotero.dev> (and
   <https://www.kotero.dev> if you use it) still load with valid HTTPS.
4. **App works end-to-end:** log in through budget.kotero.dev, add a
   transaction, confirm no CORS errors in devtools (ALLOWED_ORIGIN is set to
   `https://budget.kotero.dev`).
5. **Registration is closed:** `POST https://budget.kotero.dev/api/auth/register`
   returns registration-disabled (after your account exists).

## 9. Afterwards (recommended, not blocking)

- Cloudflare → SSL/TLS: set mode **Full**; enable **Always Use HTTPS** and
  edge **HSTS**.
- Set up a periodic encrypted backup of `data/` and a safe offline copy of
  the production `ENCRYPTION_KEY` (losing it makes stored Gmail passwords
  unrecoverable).
- `sudo apt install unattended-upgrades` for automatic OS security patches.
- Rate-limit caveat: limiter storage is in-memory per gunicorn worker (2
  workers → effective limits up to 2x, reset on restart). Acceptable behind
  Access; switch to a shared backend if you ever open the app wider.
