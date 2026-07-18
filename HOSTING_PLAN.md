# Hosting Plan — budget.kotero.dev for PersonalFinanceApp

**Prepared:** 2026-07-18. Companion to `SECURITY_AUDIT.md` and `SECURITY_REVIEW_AND_HOSTING.md`
(this document takes their findings as given). Pi-side tunnel setup and code fixes are tracked
separately in `CLOUDFLARE_SETUP_TODO.md`; this document covers domain/DNS feasibility, the option
trade-offs, and the go-live sequence.

**Question answered:** *"kotero.dev is hosted on GitHub Pages — can I host this app at
budget.kotero.dev separately?"*

---

## 1. Direct answer: YES

`budget.kotero.dev` can point anywhere you want while `kotero.dev` (and `www.kotero.dev`) stay on
GitHub Pages, untouched. **DNS records are per-hostname, not per-domain.** GitHub Pages "owns"
only the records you created for it — the four apex A records
(`185.199.108.153 / .109.153 / .110.153 / .111.153`, verified live today) and `www`. A new
`budget` record in the same zone is completely independent: GitHub never sees it, and nothing
about the Pages site changes. `budget.kotero.dev` currently returns NXDOMAIN (verified), so the
name is free to claim.

Two constraints shape *how* to do it:

1. **Where the zone lives matters per option.** kotero.dev's nameservers are
   `dns1/dns2.registrar-servers.com` (Namecheap BasicDNS). Cloudflare Tunnel + Access requires the
   zone to be **on Cloudflare's nameservers** (free plan; the CNAME/partial setup that avoids an NS
   move is Business-plan only). ngrok, by contrast, works with a single CNAME added at Namecheap.
2. **`.dev` is an HSTS-preloaded TLD.** Every browser forces HTTPS for `*.kotero.dev` — plain
   HTTP will never load. All options below terminate TLS properly (Cloudflare edge cert, ngrok
   auto-provisioned Let's Encrypt cert), so this is handled; it just rules out any "quick test over
   http://" shortcut on this domain.

---

## 2. Option A — Move kotero.dev DNS to Cloudflare (free), Tunnel + Access for budget

This is the security review's #1 option (its "Option B"), and the repo already ships
`deploy/cloudflared.service` for it.

### What changes
Only the **nameservers**. The registrar stays Namecheap; the zone's records move to Cloudflare's
free plan. GitHub Pages hosting itself is untouched — it keeps serving the same content from the
same IPs; only the server answering DNS queries changes.

### Records to re-create in Cloudflare (before switching NS)
Copy the zone exactly. From Namecheap → Advanced DNS, export/screenshot everything, then create
in Cloudflare:

| Type | Name | Content | Proxy status |
|---|---|---|---|
| A | `@` | `185.199.108.153` | **DNS only (gray cloud)** |
| A | `@` | `185.199.109.153` | DNS only |
| A | `@` | `185.199.110.153` | DNS only |
| A | `@` | `185.199.111.153` | DNS only |
| AAAA | `@` | `2606:50c0:8000::153`, `8001::153`, `8002::153`, `8003::153` (optional but recommended, GitHub's IPv6) | DNS only |
| CNAME | `www` | `<your-github-username>.github.io` (or replicate whatever Namecheap has today — `www` currently resolves to the GH Pages IPs) | DNS only |
| TXT | `_github-pages-challenge-<username>` | copy the existing value **if present** in Namecheap (GitHub "verified domain" record — keep it or Pages custom-domain verification breaks) | n/a |
| TXT / MX / everything else | any SPF, mail, or verification records currently in Namecheap | copy verbatim | n/a |
| CNAME | `budget` | `<TUNNEL-ID>.cfargotunnel.com` (created automatically by `cloudflared tunnel route dns`, or add manually) | **Proxied (orange cloud) — required for Tunnel** |

### Orange-cloud vs gray-cloud for the GitHub Pages records
Keep the apex + `www` **DNS only (gray cloud)**. When those records are proxied, DNS resolves to
Cloudflare IPs instead of GitHub's, and GitHub cannot provision or **renew** its Let's Encrypt
certificate for the custom domain — a well-documented failure mode ("domain not properly
configured to support HTTPS", and silent cert-renewal failures months later). Gray cloud costs you
nothing here: the Pages site already has HTTPS from GitHub, and Cloudflare's CDN adds little for a
static site GitHub already CDNs. Only `budget` needs (and must have) the orange cloud, because
that's how Tunnel traffic reaches Cloudflare's edge.

### Then: budget.kotero.dev via Tunnel + Access
- **Tunnel:** `cloudflared tunnel create finance-app`, ingress `budget.kotero.dev →
  http://127.0.0.1:5100`, run via the shipped `deploy/cloudflared.service` (fix `User=rohitpras`
  first — Pi-side work, in `CLOUDFLARE_SETUP_TODO.md`). Outbound-only: zero inbound ports opened
  on the home router.
- **Access:** Zero Trust → Access → add a self-hosted application for `budget.kotero.dev`, policy =
  allow-list of the 1–3 specific email addresses (Google login or one-time email PIN — no client
  software). **Free for up to 50 users** (verified current as of July 2026; free tier is permanent,
  24h log retention, community support). Unauthenticated internet traffic is rejected at
  Cloudflare's edge and never reaches the Pi.

### NS-migration risks and how to get zero downtime
- **The risk is record mismatch, not the switch itself.** During propagation (minutes to ~24–48 h)
  some resolvers ask Namecheap, some ask Cloudflare. If both zones contain identical records,
  users see no difference — zero downtime. The only way to break the Pages site is to forget a
  record in Cloudflare before flipping NS.
- Cloudflare's setup wizard auto-scans and imports records, but it **misses records regularly**
  (especially TXT and less-common names). Manually diff its import against the Namecheap zone
  before switching.
- Do **not** enable proxying on the GH Pages records during or after migration (see above).
- Namecheap side: Domain → Nameservers → "Custom DNS" → enter the two assigned
  `*.ns.cloudflare.com` names. Namecheap stops serving the zone from its own DNS at that point,
  but cached answers keep resolving until TTL expiry — harmless because the data is identical.
- Rollback is trivial: switch nameservers back to Namecheap BasicDNS (the old zone data remains
  stored at Namecheap).
- Mail: no MX records were observed on kotero.dev; if any exist in the Namecheap panel, copy them
  or mail breaks — this is the classic NS-migration casualty.

**Cost:** $0. **GH Pages:** unaffected if the table above is followed.

---

## 3. Option B — Keep Namecheap DNS, CNAME budget → paid ngrok edge

GitHub Pages and the kotero.dev zone are **completely untouched** — you add exactly one record.

### DNS (Namecheap Advanced DNS)
- Add: `CNAME` | host `budget` | value = the `…ngrok-cname.com` target ngrok's dashboard shows
  after you add `budget.kotero.dev` as a custom domain. Namecheap supports subdomain CNAMEs
  without restriction (only the apex can't be a CNAME, which doesn't apply here).
- ngrok then auto-provisions a Let's Encrypt certificate for `budget.kotero.dev` (minutes after
  the CNAME resolves; a temporary wildcard-cert browser warning during provisioning is normal and
  self-resolves).

### Plan-tier caveat — verify before committing
Custom (bring-your-own) domains are a **paid** ngrok feature, and on ngrok's *current* plan
lineup they are only on **Pay-as-you-go** ($0.01/hr ≈ $7–8/mo per domain on top of the base);
the cheaper **Hobbyist/Personal** tiers include only *ngrok-branded* reserved domains
(`something.ngrok.app`), not your own domain. Legacy Pro/Business subscriptions include custom
domains. **Action item: check the ngrok dashboard → Domains → "New Domain" and see whether it
accepts `budget.kotero.dev` on the current subscription.** If the plan doesn't include it, this
option either costs extra or degrades to a `*.ngrok.app` hostname (functional, but abandons the
budget.kotero.dev goal). The OAuth piece is *not* the gate — ngrok's OAuth action is available
even on free plans (up to 5 monthly active users, which covers 1–3 users).

### Edge auth (mandatory — an unprotected ngrok URL is raw public exposure)
Attach a Traffic Policy to the endpoint:

```yaml
on_http_request:
  - actions:
      - type: oauth
        config:
          provider: google
  - expressions:
      - "!(actions.ngrok.oauth.identity.email in ['kkyleotero@gmail.com', 'friend@example.com'])"
    actions:
      - type: deny
```

Optionally add `ip-restriction` and/or `basic-auth` actions. This is the same "identity at the
edge, outbound-only agent, no inbound ports" model as Cloudflare Access.

### Honest security comparison vs Option A
- **Equivalent in the property that matters most:** both gate at the provider's edge before any
  packet reaches Flask; both are outbound-only tunnels; both terminate TLS at a third party that
  therefore sees plaintext HTTP to your origin. Neither is meaningfully "safer" than the other at
  this threat model's level.
- **Differences:** Access gives a point-and-click email allow-list, session management, and edge
  HSTS in a product built for persistent private apps; ngrok's gate is a YAML/CEL policy you must
  write correctly yourself (a typo in the expression fails open or closed — test it). Cloudflare's
  free Access covers 50 seats free forever; ngrok's OAuth is capped at 5 MAU on lower tiers (fine
  here) and the custom domain is the billable item. ngrok is dev-tunnel-oriented; a 24/7 home
  server tunnel works but is not its center of gravity. Rate-limit keying differs only in header
  (`X-Forwarded-For` vs `CF-Connecting-IP`) — the Pi-side ProxyFix fix covers both.

**Cost:** $0 marginal *if* the existing plan includes custom domains; otherwise ~$7–8+/mo extra.
**GH Pages:** zero risk — nothing about the zone changes except one new record.

---

## 4. Option C — Tailscale overlay (no public DNS at all)

- Install Tailscale on the Pi and on each user's phone/laptop; invite the 1–3 users to the
  tailnet (free tier: 3 users / 100 devices). The app is reachable **only** inside the WireGuard
  mesh — no public hostname exists, nothing to scan, no third party terminates your TLS.
  `tailscale serve` can front `127.0.0.1:5100` with a valid cert on the `…ts.net` MagicDNS name.
- `budget.kotero.dev` is simply **not used** in this option. You *could* point tailnet split-DNS
  at it, but because `.dev` is HSTS-preloaded you'd then have to mint a real
  `budget.kotero.dev` certificate yourself (DNS-01 via the Namecheap API in Caddy/certbot) —
  needless complexity. Use the `ts.net` name.
- **Strongest isolation** of all options (the security review's assessment stands), and most of
  the audit's internet-facing findings become moot. The cost is the client-install requirement:
  every user must run Tailscale, and there is no access from a borrowed/incognito device. For
  financial data, that friction is arguably a feature.

**Cost:** $0. **GH Pages:** untouched.

---

## 5. Comparison

| | A — Cloudflare Tunnel + Access | B — ngrok paid edge | C — Tailscale |
|---|---|---|---|
| Security | Edge identity gate, no inbound ports; CF sees plaintext | Equivalent edge gate; CEL policy is DIY and must be tested; ngrok sees plaintext | Strongest — no public endpoint at all, end-to-end WireGuard |
| Setup effort | Medium: NS migration + record replication + tunnel + Access app (~1–2 h incl. propagation) | Low: 1 CNAME + dashboard domain + traffic policy (~30 min) — *if* plan includes custom domains | Low: install + invite users (~20 min) |
| Cost | $0 | $0 only if current plan has custom domains; else ~$7–8+/mo | $0 |
| kotero.dev / GH Pages affected? | NS move — zero downtime if records copied correctly; keep GH records gray-cloud | Not touched at all | Not touched at all |
| budget.kotero.dev used? | Yes | Yes (plan permitting) | No (uses `….ts.net`) |
| Phone "access anywhere" UX | Open URL → Google/email-PIN once per session → app. Works on any device | Open URL → Google OAuth → app. Works on any device | Install Tailscale app, toggle VPN on → open `ts.net` URL. Own devices only |

---

## 6. Recommendation

**Option A — move kotero.dev's DNS to Cloudflare (free) and serve budget.kotero.dev via
Cloudflare Tunnel + Access.** This agrees with `SECURITY_REVIEW_AND_HOSTING.md`'s #1 ranking, and
the case is *stronger* now than when that review hedged toward ngrok as "already paid for":

1. **The ngrok subscription may not actually cover the stated goal.** Custom domains are gated to
   Pay-as-you-go (or legacy Pro+) — there's a real chance `budget.kotero.dev` on ngrok costs
   *more* money, at which point ngrok's one advantage (sunk cost) evaporates. Cloudflare's path is
   $0 with no seat/bandwidth anxiety (50 free Access seats, no transfer cap relevant here, vs
   ngrok's metered GB).
2. **The repo and the concurrent work already point this way** — `deploy/cloudflared.service`
   ships in-tree and the Pi-side Cloudflare setup is being done right now. Choosing ngrok would
   discard that work for no security gain.
3. **Security is a wash between A and B** (both edge-gated, both third-party TLS termination), so
   the tiebreakers are cost-certainty, the productized allow-list UI, and always-on posture — all
   favor Cloudflare.
4. The NS migration is the only real cost of Option A, and done per §2 it is zero-downtime and
   reversible.

**Keep the ngrok subscription as the tested fallback** (it can be stood up in 30 minutes if
Cloudflare ever misbehaves), or cancel it once Option A is verified — it has no role in the
steady state. **Option C (Tailscale) remains the right choice if** the users decide they don't
want *any* public hostname and everyone accepts installing the client; it can also be layered on
later purely as the admin path.

The app must NOT go live behind any of these until the mandatory Pi-side items from
`SECURITY_REVIEW_AND_HOSTING.md` §"Minimal pre-launch checklist" are done (key rotation, file
perms, `DEBUG=false`, `REGISTRATION_ENABLED=false`, admin bootstrap, ProxyFix/limiter keying,
`ALLOWED_ORIGIN=https://budget.kotero.dev`).

---

## 7. Go-live sequence (Option A)

Steps marked **[DNS]** are this plan's scope (do them yourself in the two dashboards); steps
marked **[Pi]** overlap with the concurrently-written `CLOUDFLARE_SETUP_TODO.md` and are listed
only for ordering.

1. **[DNS]** Export/screenshot the full Namecheap Advanced DNS zone for kotero.dev (every record,
   including any `_github-pages-challenge-*` TXT).
2. **[DNS]** Add kotero.dev to a free Cloudflare account; let it import, then manually diff and
   fix the record set per the table in §2. Set apex A (and AAAA) + `www` to **DNS only**.
3. **[DNS]** At Namecheap: Nameservers → Custom DNS → the two assigned `*.ns.cloudflare.com`
   hosts. Wait for Cloudflare to report the zone "Active".
4. **[DNS] Verify no regression:** `https://kotero.dev` and `https://www.kotero.dev` load with a
   valid GitHub certificate; GitHub repo → Settings → Pages still shows the custom domain healthy
   ("HTTPS enforced" intact).
5. **[Pi]** Complete the pre-launch checklist items (keys, perms, env, admin bootstrap, ProxyFix,
   `ALLOWED_ORIGIN=https://budget.kotero.dev`) and install/start the fixed `cloudflared.service`
   with the tunnel created and ingress mapped to `http://127.0.0.1:5100`.
6. **[DNS/Pi]** Route the hostname: `cloudflared tunnel route dns finance-app budget.kotero.dev`
   (creates the proxied `budget → <TUNNEL-ID>.cfargotunnel.com` CNAME). This can only happen after
   step 3 — the tunnel-hostname mapping requires the zone to be Active on Cloudflare, so the
   Pi-side work in `CLOUDFLARE_SETUP_TODO.md` blocks on the NS migration at exactly this step.
7. **[DNS]** Zero Trust dashboard → Access → self-hosted application for `budget.kotero.dev`;
   policy: Allow, Include = Emails: the 1–3 addresses. Enable edge HSTS
   (SSL/TLS → Edge Certificates) and set SSL mode Full for the zone.
8. **[DNS+Pi] Verify the gate:** from a logged-out browser/phone on mobile data,
   `https://budget.kotero.dev` must show the **Cloudflare Access** login — never the app's own
   login. Confirm an email *not* on the list is refused. Confirm `http://<pi-lan-ip>:5100` is
   refused from another LAN device.
9. Only after step 8 passes, share the URL with the other users. Then do the leisure hardening
   (checklist items 9–10) and set up encrypted `data/` + `ENCRYPTION_KEY` backups.

---

## Sources

- Cloudflare Zero Trust plans (50 free seats): https://www.cloudflare.com/plans/zero-trust-services/ ; https://community.cloudflare.com/t/50-user-limit-on-free-plan/546057
- ngrok pricing/limits (custom domains = Pay-as-you-go; Hobbyist = ngrok-branded only): https://ngrok.com/docs/pricing-limits ; https://ngrok.com/pricing
- ngrok custom domains (CNAME target, auto Let's Encrypt, no apex): https://ngrok.com/docs/universal-gateway/custom-domains/
- ngrok OAuth action + CEL email allow-list (free up to 5 MAU): https://ngrok.com/docs/traffic-policy/actions/oauth ; https://ngrok.com/docs/traffic-policy/examples/oauth-protection
- GitHub Pages + Cloudflare proxy cert-provisioning conflict (keep gray cloud): https://github.com/orgs/community/discussions/23632 ; https://github.com/orgs/community/discussions/22790
- Verified live 2026-07-18: kotero.dev NS = dns1/dns2.registrar-servers.com; apex + www → 185.199.108–111.153; budget.kotero.dev = NXDOMAIN.
