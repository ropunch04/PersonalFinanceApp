import hashlib
import imaplib
import logging
import re
from datetime import datetime, timezone
from email import message_from_bytes
from email.message import Message
from email.utils import parsedate_to_datetime

from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

_IMAP_HOST = "imap.gmail.com"
_IMAP_PORT = 993

_CAP1_AMOUNT = re.compile(r"\$\s*([\d,]+\.\d{2})")
_CAP1_MERCHANT_SPECIFIC = re.compile(
    r"\bat\s+([^,\n\r]{2,80}?),\s+a\s+(?:pending|purchase)\b",
    re.IGNORECASE,
)
_CAP1_MERCHANT = re.compile(
    r"\b(?:at|from|purchase at|used at|charged at)\s+([A-Z0-9][^\n\r.,]{2,50}?)(?=\s+on\s|\s+for\s|\.|,|$)",
    re.IGNORECASE,
)
_CAP1_DATE = re.compile(
    r"(\w+ \d{1,2},\s*\d{4})"
    r"|(\d{4}-\d{2}-\d{2})"
    r"|(\d{1,2}/\d{1,2}/\d{4})"
    r"|(\w+\.\s*\d{1,2},?\s*\d{4})"
)

_CREDIT_PHRASES = ("credit has posted", "credited your account for", "is in your account now")
_CREDIT_AMOUNT_SPECIFIC = re.compile(r"credited your account for \$([0-9,]+\.\d{2})", re.IGNORECASE)
_CREDIT_AMOUNT_FALLBACK = re.compile(r"\+\$([0-9,]+\.\d{2})")
_CREDIT_MERCHANT = re.compile(r"([A-Z][A-Z\s\*\-0-9]+)\n.*Card\.\.\.", re.IGNORECASE)
_CREDIT_DATE = re.compile(r"(\w+\.\s*\d{1,2},?\s*\d{4})")

_ZELLE_AMOUNT       = re.compile(r"Amount:\s*\$\s*([\d,]+\.\d{2})", re.IGNORECASE)
_ZELLE_MEMO         = re.compile(r"Memo:\s*(.+?)\s+to:(.+?)(?:\r?\n|$)", re.IGNORECASE)
_ZELLE_IN_AMOUNT    = re.compile(r"in the amount of \$\s*([\d,]+\.\d{2})", re.IGNORECASE)
_ZELLE_IN_SENDER    = re.compile(r"^(.+?) has just sent you money", re.IGNORECASE | re.MULTILINE)

_VENMO_PAID = re.compile(r"paid you \$\s*([\d,]+\.\d{2})", re.IGNORECASE)
_VENMO_YOU_PAID = re.compile(r"you paid (?:.+?) \$\s*([\d,]+\.\d{2})", re.IGNORECASE)
_VENMO_CHARGED_YOU = re.compile(r"charged you \$\s*([\d,]+\.\d{2})", re.IGNORECASE)

_VENMO_SUBJ_FROM = re.compile(r"^(.+?) paid you", re.IGNORECASE)
_VENMO_SUBJ_TO = re.compile(r"you paid (.+?) \$", re.IGNORECASE)
_VENMO_SUBJ_CHARGER = re.compile(r"^(.+?) charged you", re.IGNORECASE)

_VENMO_FROM = re.compile(r"^(.+?) paid you", re.IGNORECASE | re.MULTILINE)
_VENMO_TO = re.compile(r"you paid (.+?) \$", re.IGNORECASE)
_VENMO_CHARGER = re.compile(r"^(.+?) charged you", re.IGNORECASE | re.MULTILINE)

_AMEX_TXN = re.compile(
    r"^([A-Z][A-Z0-9&'.\-]*(?:\s[A-Z0-9&'.\-]+)*)\s*\n\s*\n\s*"
    r"\$\s*([\d,]+\.\d{2})\*?\s*\n\s*\n\s*"
    r"(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*,?\s*\w+\.?\s*\d{1,2},?\s*\d{4}",
    re.MULTILINE,
)


def _source_hash(provider: str, message_id: str) -> str:
    raw = f"{provider}|{message_id}"
    return hashlib.sha256(raw.encode()).hexdigest()


def _get_text(msg: Message) -> str:
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


def _get_venmo_memo(msg: Message) -> str | None:
    for part in msg.walk():
        if part.get_content_type() != "text/html":
            continue
        if part.get_content_disposition() == "attachment":
            continue
        payload = part.get_payload(decode=True)
        if not payload:
            continue
        charset = part.get_content_charset() or "utf-8"
        html = payload.decode(charset, errors="replace")
        soup = BeautifulSoup(html, "html.parser")
        note = soup.find(class_="transaction-note")
        if note:
            return note.get_text(strip=True) or None
    return None


def _parse_cap1_date(text: str) -> str:
    m = _CAP1_DATE.search(text)
    if m:
        raw = next(g for g in m.groups() if g).strip()
        cleaned = raw.replace(".", "").replace(",", "")
        for fmt in ("%B %d %Y", "%b %d %Y", "%Y-%m-%d", "%m/%d/%Y", "%B %d, %Y", "%b %d, %Y"):
            try:
                return datetime.strptime(cleaned, fmt).strftime("%Y-%m-%dT00:00:00")
            except ValueError:
                continue
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00")


def _parse_charge_email(msg: Message, message_id: str, conn) -> dict | None:
    subject = msg.get("Subject", "")
    if not re.search(r"transaction|purchase|charge|alert", subject, re.IGNORECASE):
        return None

    text = _get_text(msg)

    amount_m = _CAP1_AMOUNT.search(text)
    if not amount_m:
        return None
    amount = float(amount_m.group(1).replace(",", ""))

    merchant_m = _CAP1_MERCHANT_SPECIFIC.search(text) or _CAP1_MERCHANT.search(text)
    merchant_raw = merchant_m.group(1).strip() if merchant_m else "Unknown Merchant"

    return {
        "amount": amount,
        "direction": "outflow",
        "merchant_raw": merchant_raw,
        "category_id": _get_category_id(conn, merchant_raw) if conn else None,
        "transaction_at": _parse_cap1_date(text),
        "source_hash": _source_hash("capitalone_charge", message_id),
        "notes": None,
    }


def _parse_credit_email(msg: Message, message_id: str, conn) -> dict | None:
    text = _get_text(msg)

    if not any(phrase in text.lower() for phrase in _CREDIT_PHRASES):
        return None

    amount_m = _CREDIT_AMOUNT_SPECIFIC.search(text) or _CREDIT_AMOUNT_FALLBACK.search(text)
    if not amount_m:
        return None
    amount = float(amount_m.group(1).replace(",", ""))

    merchant_m = _CREDIT_MERCHANT.search(text)
    merchant_raw = merchant_m.group(1).strip() if merchant_m else msg.get("Subject", "Refund")

    date_m = _CREDIT_DATE.search(text)
    if date_m:
        raw = date_m.group(1).strip().replace(".", "").replace(",", "")
        try:
            transaction_at = datetime.strptime(raw, "%b %d %Y").strftime("%Y-%m-%dT00:00:00")
        except ValueError:
            transaction_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00")
    else:
        transaction_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00")

    return {
        "amount": amount,
        "direction": "inflow",
        "merchant_raw": merchant_raw,
        "category_id": _get_category_id(conn, merchant_raw) if conn else None,
        "transaction_at": transaction_at,
        "source_hash": _source_hash("capitalone_credit", message_id),
        "notes": "Refund",
    }


def _parse_venmo_email(msg: Message, message_id: str, conn) -> dict | None:
    subject = msg.get("Subject", "")
    if not re.search(r"paid|charged|payment", subject, re.IGNORECASE):
        return None

    text = _get_text(msg)

    paid_m = _VENMO_PAID.search(text)
    you_paid_m = _VENMO_YOU_PAID.search(text)
    charged_you_m = _VENMO_CHARGED_YOU.search(text)

    if paid_m:
        amount = float(paid_m.group(1).replace(",", ""))
        direction = "inflow"
        txn_type = "payment"
        subj_m = _VENMO_SUBJ_FROM.search(subject)
        if subj_m:
            merchant_raw = subj_m.group(1).strip()
        else:
            body_m = _VENMO_FROM.search(text)
            merchant_raw = body_m.group(1).strip() if body_m else "Venmo"
    elif you_paid_m:
        amount = float(you_paid_m.group(1).replace(",", ""))
        direction = "outflow"
        txn_type = "payment"
        subj_m = _VENMO_SUBJ_TO.search(subject)
        if subj_m:
            merchant_raw = subj_m.group(1).strip()
        else:
            body_m = _VENMO_TO.search(text)
            merchant_raw = body_m.group(1).strip() if body_m else "Venmo"
    elif charged_you_m:
        amount = float(charged_you_m.group(1).replace(",", ""))
        direction = "outflow"
        txn_type = "charge"
        subj_m = _VENMO_SUBJ_CHARGER.search(subject)
        if subj_m:
            merchant_raw = subj_m.group(1).strip()
        else:
            body_m = _VENMO_CHARGER.search(text)
            merchant_raw = body_m.group(1).strip() if body_m else "Venmo"
    else:
        return None

    person = merchant_raw
    memo = _get_venmo_memo(msg) or "Venmo"
    notes = f"venmo:{txn_type}:{person}" if person else "venmo"
    return {
        "amount": amount,
        "direction": direction,
        "merchant_raw": memo,
        "category_id": _get_category_id(conn, memo) if conn else None,
        "transaction_at": _parse_cap1_date(text),
        "source_hash": _source_hash("venmo_email", message_id),
        "notes": notes,
    }


def _parse_amex_email(msg: Message, message_id: str, conn) -> dict | None:
    subject = msg.get("Subject", "")
    if not re.search(r"large purchase", subject, re.IGNORECASE):
        return None

    text = _get_text(msg)

    txn_m = _AMEX_TXN.search(text)
    if not txn_m:
        return None
    merchant_raw = txn_m.group(1).strip()
    amount = float(txn_m.group(2).replace(",", ""))

    return {
        "amount": amount,
        "direction": "outflow",
        "merchant_raw": merchant_raw,
        "category_id": _get_category_id(conn, merchant_raw) if conn else None,
        "transaction_at": _parse_cap1_date(text),
        "source_hash": _source_hash("amex_purchase", message_id),
        "notes": None,
    }


def _parse_zelle_email(msg: Message, message_id: str, conn) -> dict | None:
    subject = msg.get("Subject", "")
    if not re.search(r"zelle", subject, re.IGNORECASE):
        return None

    text = _get_text(msg)

    try:
        transaction_at = parsedate_to_datetime(msg.get("Date", "")).strftime("%Y-%m-%dT00:00:00")
    except Exception:
        transaction_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00")

    if re.search(r"someone sent you money", subject, re.IGNORECASE):
        amount_m = _ZELLE_IN_AMOUNT.search(text)
        if not amount_m:
            return None
        amount = float(amount_m.group(1).replace(",", ""))
        sender_m = _ZELLE_IN_SENDER.search(text)
        person = sender_m.group(1).strip() if sender_m else "Zelle"
        return {
            "amount": amount,
            "direction": "inflow",
            "merchant_raw": person,
            "category_id": _get_category_id(conn, person) if conn else None,
            "transaction_at": transaction_at,
            "source_hash": _source_hash("zelle_received", message_id),
            "notes": f"zelle:received:{person}",
        }

    # Outgoing: "You sent money with Zelle"
    amount_m = _ZELLE_AMOUNT.search(text)
    if not amount_m:
        return None
    amount = float(amount_m.group(1).replace(",", ""))
    memo_m = _ZELLE_MEMO.search(text)
    recipient = memo_m.group(2).strip() if memo_m else "Zelle"
    return {
        "amount": amount,
        "direction": "outflow",
        "merchant_raw": recipient,
        "category_id": _get_category_id(conn, recipient) if conn else None,
        "transaction_at": transaction_at,
        "source_hash": _source_hash("zelle_sent", message_id),
        "notes": f"zelle:sent:{recipient}",
    }


def _get_category_id(conn, merchant_raw: str) -> int | None:
    row = conn.execute(
        "SELECT id FROM categories WHERE LOWER(name) = LOWER(?)", (merchant_raw,)
    ).fetchone()
    return row["id"] if row else None


def fetch_emails(gmail_address: str, app_password: str, conn=None) -> tuple[list[dict], list[dict]]:
    transactions, errors = [], []

    mail = imaplib.IMAP4_SSL(_IMAP_HOST, _IMAP_PORT)
    try:
        mail.login(gmail_address, app_password)
        mail.select("INBOX")

        searches = [
            (b'FROM "capitalone.com" SUBJECT "transaction"', None),
            (b'FROM "capitalone.com" SUBJECT "credit"', None),
            (b'FROM "capitalone.com" SUBJECT "Zelle"', _parse_zelle_email),
            (b'FROM "venmo@venmo.com"', _parse_venmo_email),
            (b'FROM "americanexpress.com" SUBJECT "Large Purchase Approved"', _parse_amex_email),
        ]

        for criteria, fixed_parser in searches:
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

                    if fixed_parser:
                        parse_fn = fixed_parser
                    else:
                        text = _get_text(msg)
                        if any(phrase in text.lower() for phrase in _CREDIT_PHRASES):
                            parse_fn = _parse_credit_email
                        else:
                            parse_fn = _parse_charge_email

                    result = parse_fn(msg, message_id, conn)
                    if result:
                        transactions.append(result)
                        mail.store(num, "+FLAGS", "\\Seen")
                    else:
                        errors.append(
                            {
                                "message_id": message_id,
                                "reason": "No parseable transaction found in email",
                                "subject": msg.get("Subject", ""),
                            }
                        )
                except Exception as exc:
                    errors.append({"message_id": num.decode(), "reason": str(exc)})
    finally:
        try:
            mail.logout()
        except Exception:
            pass

    return transactions, errors
