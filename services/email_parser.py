import hashlib
import imaplib
import re
from datetime import datetime, timezone
from email import message_from_bytes
from email.message import Message

from bs4 import BeautifulSoup

_IMAP_HOST = "imap.gmail.com"
_IMAP_PORT = 993

_PROVIDERS = [
    (b'FROM "info@capitalone.com"',  "_parse_capitalone"),
    (b'FROM "venmo@venmo.com"',      "_parse_venmo_email"),
]

_CAP1_AMOUNT  = re.compile(r"\$\s*([\d,]+\.\d{2})")
_CAP1_MERCHANT = re.compile(
    r"(?:at|from|purchase at|used at|charged at)\s+([A-Z0-9][^\n\r.,]{2,50}?)(?=\s+on\s|\s+for\s|\.|,|$)",
    re.IGNORECASE,
)
_CAP1_DATE = re.compile(
    r"(\w+ \d{1,2},\s*\d{4})"          # e.g. "May 12, 2026"
    r"|(\d{4}-\d{2}-\d{2})"            # e.g. "2026-05-12"
    r"|(\d{1,2}/\d{1,2}/\d{4})"        # e.g. "05/12/2026"
)

_VENMO_PAID   = re.compile(r"paid you \$\s*([\d,]+\.\d{2})", re.IGNORECASE)
_VENMO_CHARGE = re.compile(r"you paid (?:.+?) \$\s*([\d,]+\.\d{2})", re.IGNORECASE)
_VENMO_FROM   = re.compile(r"^(.+?) paid you", re.IGNORECASE | re.MULTILINE)
_VENMO_TO     = re.compile(r"you paid (.+?) \$", re.IGNORECASE)


def _source_hash(provider: str, message_id: str) -> str:
    raw = f"{provider}|{message_id}"
    return hashlib.sha256(raw.encode()).hexdigest()


def _get_text(msg: Message) -> str:
    """Walk a (possibly multipart) email and return the best text body."""
    plain, html = None, None
    for part in msg.walk():
        ct = part.get_content_type()
        if part.get_content_disposition() == "attachment":
            continue
        payload = part.get_payload(decode=True)
        if payload is None:
            continue
        charset = part.get_content_charset() or "utf-8"
        decoded = payload.decode(charset, errors="replace")
        if ct == "text/plain" and plain is None:
            plain = decoded
        elif ct == "text/html" and html is None:
            html = decoded

    if plain:
        return plain
    if html:
        return BeautifulSoup(html, "html.parser").get_text(separator=" ")
    return ""


def _parse_date(text: str) -> str:
    """Try several date formats; fall back to current UTC time."""
    m = _CAP1_DATE.search(text)
    if m:
        raw = next(g for g in m.groups() if g)
        for fmt in ("%B %d, %Y", "%B %d,%Y", "%Y-%m-%d", "%m/%d/%Y"):
            try:
                return datetime.strptime(raw.strip(), fmt).strftime("%Y-%m-%dT00:00:00")
            except ValueError:
                continue
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00")


def _parse_capitalone(msg: Message, message_id: str, conn) -> dict | None:
    subject = msg.get("Subject", "")
    if not re.search(r"transaction|purchase|charge|alert", subject, re.IGNORECASE):
        return None

    text = _get_text(msg)

    amount_m = _CAP1_AMOUNT.search(text)
    if not amount_m:
        return None
    amount = float(amount_m.group(1).replace(",", ""))

    merchant_m = _CAP1_MERCHANT.search(text)
    merchant_raw = merchant_m.group(1).strip() if merchant_m else subject

    direction = "inflow" if re.search(r"credit|refund|return", subject, re.IGNORECASE) else "outflow"

    transaction_at = _parse_date(text)
    category_id = _get_category_id(conn, merchant_raw) if conn else None

    return {
        "amount":         amount,
        "direction":      direction,
        "merchant_raw":   merchant_raw,
        "category_id":    category_id,
        "transaction_at": transaction_at,
        "source_hash":    _source_hash("capitalone_email", message_id),
    }


def _parse_venmo_email(msg: Message, message_id: str, conn) -> dict | None:
    subject = msg.get("Subject", "")
    if not re.search(r"paid|charged|payment", subject, re.IGNORECASE):
        return None

    text = _get_text(msg)

    paid_m = _VENMO_PAID.search(text)
    charge_m = _VENMO_CHARGE.search(text)

    if paid_m:
        amount = float(paid_m.group(1).replace(",", ""))
        direction = "inflow"
        from_m = _VENMO_FROM.search(text)
        merchant_raw = from_m.group(1).strip() if from_m else "Venmo"
    elif charge_m:
        amount = float(charge_m.group(1).replace(",", ""))
        direction = "outflow"
        to_m = _VENMO_TO.search(text)
        merchant_raw = to_m.group(1).strip() if to_m else "Venmo"
    else:
        return None

    transaction_at = _parse_date(text)
    category_id = _get_category_id(conn, merchant_raw) if conn else None

    return {
        "amount":         amount,
        "direction":      direction,
        "merchant_raw":   merchant_raw,
        "category_id":    category_id,
        "transaction_at": transaction_at,
        "source_hash":    _source_hash("venmo_email", message_id),
    }


def _get_category_id(conn, merchant_raw: str) -> int | None:
    row = conn.execute(
        "SELECT id FROM categories WHERE LOWER(name) = LOWER(?)", (merchant_raw,)
    ).fetchone()
    if row:
        return row["id"]
    other = conn.execute("SELECT id FROM categories WHERE LOWER(name) = 'other'").fetchone()
    return other["id"] if other else None


_PARSER_FNS = {
    "_parse_capitalone":  _parse_capitalone,
    "_parse_venmo_email": _parse_venmo_email,
}


def fetch_emails(gmail_address: str, app_password: str, conn=None) -> tuple[list[dict], list[dict]]:
    transactions, errors = [], []

    mail = imaplib.IMAP4_SSL(_IMAP_HOST, _IMAP_PORT)
    try:
        mail.login(gmail_address, app_password)
        mail.select("INBOX")

        for criteria, parser_name in _PROVIDERS:
            parse_fn = _PARSER_FNS[parser_name]
            _, msg_nums = mail.search(None, b"UNSEEN", criteria)
            ids = msg_nums[0].split()
            if not ids:
                continue

            for num in ids:
                try:
                    _, data = mail.fetch(num, "(RFC822)")
                    raw = data[0][1]
                    msg = message_from_bytes(raw)
                    message_id = msg.get("Message-ID", num.decode())

                    result = parse_fn(msg, message_id, conn)
                    if result:
                        transactions.append(result)
                        mail.store(num, "+FLAGS", "\\Seen")
                    else:
                        errors.append({
                            "message_id": message_id,
                            "reason": "No parseable transaction found in email",
                            "subject": msg.get("Subject", ""),
                        })
                except Exception as exc:
                    errors.append({
                        "message_id": num.decode(),
                        "reason": str(exc),
                    })
    finally:
        try:
            mail.logout()
        except Exception:
            pass

    return transactions, errors
