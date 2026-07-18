from flask import request
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address


def _client_ip() -> str:
    """Key rate limits on the real client IP.

    Behind Cloudflare Tunnel every request reaches Flask from the local
    cloudflared daemon, so remote_addr alone would collapse all clients into
    one bucket. Cloudflare supplies the true client address in
    CF-Connecting-IP; fall back to remote_addr (ProxyFix-adjusted) otherwise.
    """
    return request.headers.get("CF-Connecting-IP") or get_remote_address()


# NOTE: memory:// storage is per-gunicorn-worker (2 workers => effective limits
# are up to 2x the configured values, and counters reset on restart). This is
# an accepted trade-off for a single-owner deployment behind Cloudflare Access;
# point storage_uri at a shared backend (e.g. redis://) if strict global
# limits are ever required.
limiter = Limiter(_client_ip, default_limits=[], storage_uri="memory://")
