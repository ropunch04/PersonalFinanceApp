"""Merchant-history-based category inference.

When a new transaction arrives (CSV import, Gmail sync, or manual entry
without a category), infer its category from how the user categorized the
same merchant before. Matching is exact first, then by prefix: a match
counts when one merchant string is a prefix of the other, since bank
strings append store/order numbers ("AMAZON MKTPL*2K41XY" vs "AMAZON").
Venmo person-to-person rows are excluded from learning — paying the same
person again says nothing about the purpose.
"""

_MIN_PREFIX_LEN = 5  # a non-exact match must overlap at least this much
# (5 keeps bare processor prefixes like "SQ *" or "TST*" from matching everything)


def infer_category_id(conn, merchant_raw: str) -> int | None:
    if not merchant_raw:
        return None
    target = merchant_raw.strip().upper()
    if not target:
        return None

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
        else:
            continue
        # Longest overlap wins; ties break by how often, then how recently,
        # the user filed this merchant under that category.
        rank = (common, row["n"], row["last_at"] or "")
        if best_rank is None or rank > best_rank:
            best_rank = rank
            best_category = row["category_id"]
    return best_category


def resolve_category_id(conn, merchant_raw: str) -> int | None:
    """History-based inference first, then the legacy merchant==category-name match."""
    if conn is None or not merchant_raw:
        return None
    inferred = infer_category_id(conn, merchant_raw)
    if inferred is not None:
        return inferred
    row = conn.execute(
        "SELECT id FROM categories WHERE LOWER(name) = LOWER(?)", (merchant_raw,)
    ).fetchone()
    return row["id"] if row else None
