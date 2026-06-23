"""
Quality filtering and deduplication for SFT data.

Input:  list of message-lists  [ [{"role":..,"content":..}, ...], ... ]
Output: filtered, deduplicated list in the same format
"""

import re
import unicodedata
import hashlib
from config import (
    MIN_USER_LEN, MIN_ASST_LEN,
    MAX_USER_LEN, MAX_ASST_LEN,
    REFUSE_PATTERNS,
    DEDUP_THRESH,
)


# ── Text normalisation ─────────────────────────────────────────────────────────

def _normalise(text):
    text = unicodedata.normalize("NFKC", text)
    text = re.sub(r"\s+", " ", text).strip().lower()
    return text


# ── Per-example quality checks ─────────────────────────────────────────────────

def _is_good(msgs):
    # Must be at least one user + one assistant turn
    if len(msgs) < 2:
        return False
    if msgs[0]["role"] != "user":
        return False
    if not any(m["role"] == "assistant" for m in msgs):
        return False

    user_text = " ".join(m["content"] for m in msgs if m["role"] == "user")
    asst_text = " ".join(m["content"] for m in msgs if m["role"] == "assistant")

    if len(user_text) < MIN_USER_LEN or len(user_text) > MAX_USER_LEN:
        return False
    if len(asst_text) < MIN_ASST_LEN or len(asst_text) > MAX_ASST_LEN:
        return False

    # Refuse AI-boilerplate assistants
    norm = _normalise(asst_text)
    for pat in REFUSE_PATTERNS:
        if pat in norm:
            return False

    return True


# ── Deduplication via hashing ──────────────────────────────────────────────────
# Full exact-match dedup on normalised text.
# Near-dedup (MinHash) requires datasketch; we do a fast shingling fallback.

def _shingle_hash(text, k=6):
    """Return a set of k-char shingle hashes."""
    norm = _normalise(text)
    return {hashlib.md5(norm[i:i+k].encode()).hexdigest()
            for i in range(max(1, len(norm) - k + 1))}


def _jaccard(s1, s2):
    if not s1 or not s2:
        return 0.0
    inter = len(s1 & s2)
    return inter / (len(s1) + len(s2) - inter)


def filter_and_dedup(examples, verbose=True):
    """
    Filter out low-quality examples, then deduplicate.
    Returns cleaned list.
    """
    # Step 1: quality filter
    good = [e for e in examples if _is_good(e)]
    if verbose:
        print(f"  [clean] quality filter: {len(examples)} → {len(good)}")

    # Step 2: exact dedup on (user, assistant) fingerprint
    seen_exact = set()
    unique = []
    for msgs in good:
        key = hashlib.md5(
            _normalise("".join(m["content"] for m in msgs)).encode()
        ).hexdigest()
        if key not in seen_exact:
            seen_exact.add(key)
            unique.append(msgs)

    if verbose:
        print(f"  [clean] exact dedup:    {len(good)} → {len(unique)}")

    # Step 3: near-dedup using 6-char shingling + Jaccard threshold
    # Only runs when the dataset is small enough to be practical (<50k)
    if len(unique) <= 50_000:
        shingles  = []
        keep_mask = []
        for msgs in unique:
            text = " ".join(m["content"] for m in msgs)
            sh   = _shingle_hash(text)
            dup  = any(_jaccard(sh, prev) > DEDUP_THRESH for prev in shingles)
            keep_mask.append(not dup)
            if not dup:
                shingles.append(sh)

        deduped = [e for e, keep in zip(unique, keep_mask) if keep]
        if verbose:
            print(f"  [clean] near-dedup:     {len(unique)} → {len(deduped)}")
    else:
        deduped = unique
        if verbose:
            print(f"  [clean] near-dedup:     skipped (>{50_000} examples)")

    return deduped
