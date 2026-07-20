"""Merchant identity and history-based category inference.

This module owns the single definition of "same merchant" used everywhere:

- `merchant_prefix()` normalizes a raw bank string to its merchant group by
  stripping trailing store/order numbers ("TRADER JOES #552" -> "TRADER JOES").
  The bulk-classify endpoints group and apply by this key.
- `resolve_category_id()` infers a category for a new transaction from how the
  user categorized that merchant before. Matching tiers, best first: exact
  string, one string is a prefix of the other, same merchant_prefix() group.
  Venmo person-to-person rows are excluded from learning — paying the same
  person again says nothing about the purpose.
"""

import re

_MIN_PREFIX_LEN = 5  # a non-exact match must overlap at least this much
# (5 keeps bare processor prefixes like "SQ *" or "TST*" from matching everything)


def merchant_prefix(name: str) -> str:
    cleaned = re.sub(r"\s+[#*]?\d{3,}.*$", "", name.strip()).strip()
    return cleaned if cleaned else name.strip()


def resolve_category_id(conn, merchant_raw: str) -> int | None:
    if conn is None or not merchant_raw:
        return None
    target = merchant_raw.strip().upper()
    if not target:
        return None
    target_group = merchant_prefix(merchant_raw).upper()

    rows = conn.execute(
        """
        SELECT merchant_raw, category_id, COUNT(*) AS n, MAX(transaction_at) AS last_at
        FROM transactions
        WHERE category_id IS NOT NULL
          AND merchant_raw IS NOT NULL
          AND (notes IS NULL OR notes NOT LIKE 'venmo:%')
        GROUP BY merchant_raw, category_id
        """
    ).fetchall()

    best_rank = None
    best_category = None
    for row in rows:
        known = (row["merchant_raw"] or "").strip().upper()
        if not known:
            continue
        if known == target:
            common = len(target)
        elif known.startswith(target) or target.startswith(known):
            common = min(len(known), len(target))
            if common < _MIN_PREFIX_LEN:
                continue
        elif target_group and merchant_prefix(row["merchant_raw"]).upper() == target_group:
            # Same store, different location/order number — group them.
            common = len(target_group)
            if common < _MIN_PREFIX_LEN:
                continue
        else:
            continue
        # Longest overlap wins; ties break by how often, then how recently,
        # the user filed this merchant under that category.
        rank = (common, row["n"], row["last_at"] or "")
        if best_rank is None or rank > best_rank:
            best_rank = rank
            best_category = row["category_id"]
    return best_category
