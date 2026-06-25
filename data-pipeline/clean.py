"""
Quality filtering and deduplication for SFT data.

Input:  list of message-lists [ [{"role":..., "content":...}, ...], ... ]
Output: filtered, deduplicated list in same format (shuffled deterministically)
"""
import json, os, sys, re, hashlib, unicodedata, random

sys.path.insert(0, os.path.dirname(__file__))
import config


# -- Text normalisation ---------------------------------------------------------

def _normalise(text):
    text = unicodedata.normalize("NFKC", text)
    text = re.sub(r"\s+", " ", text).strip().lower()
    return text


# -- Per-example quality checks -------------------------------------------------

def _is_good(msgs):
    if len(msgs) < 2:
        return False
    if msgs[0]["role"] != "user":
        return False
    if not any(m["role"] == "assistant" for m in msgs):
        return False

    user_text = " ".join(m["content"] for m in msgs if m["role"] == "user")
    asst_text = " ".join(m["content"] for m in msgs if m["role"] == "assistant")

    if len(user_text) < config.MIN_USER_LEN or len(user_text) > config.MAX_USER_LEN:
        return False
    if len(asst_text) < config.MIN_ASST_LEN or len(asst_text) > config.MAX_ASST_LEN:
        return False

    norm = _normalise(asst_text)
    for pat in config.REFUSE_PATTERNS:
        if pat in norm:
            return False

    return True


# -- Deduplication via hashing --------------------------------------------------

def _shingle_hash(text, k=6):
    norm = _normalise(text)
    return {hashlib.md5(norm[i:i+k].encode()).hexdigest()
            for i in range(max(1, len(norm) - k + 1))}


def _jaccard(s1, s2):
    if not s1 or not s2:
        return 0.0
    inter = len(s1 & s2)
    return inter / (len(s1) + len(s2) - inter)


def filter_and_dedup(examples, verbose=True):
    good = [e for e in examples if _is_good(e)]
    if verbose:
        print(f"  [clean] quality filter: {len(examples)} -> {len(good)}", flush=True)

    # Exact dedup
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
        print(f"  [clean] exact dedup: {len(good)} -> {len(unique)}", flush=True)

    # Near-dedup -- skip for large datasets (O(n^2), too slow above 10K)
    if len(unique) <= 10_000:
        shingles  = []
        keep_mask = []
        for msgs in unique:
            text = " ".join(m["content"] for m in msgs)
            sh   = _shingle_hash(text)
            dup  = any(_jaccard(sh, prev) > config.DEDUP_THRESH for prev in shingles)
            keep_mask.append(not dup)
            if not dup:
                shingles.append(sh)

        deduped = [e for e, keep in zip(unique, keep_mask) if keep]
        if verbose:
            s = "  [clean] near-dedup: %d -> %d" % (len(unique), len(deduped))
            print(s, flush=True)
    else:
        deduped = unique
        if verbose:
            print("  [clean] near-dedup: skipped (%d > 10K)" % len(unique), flush=True)

    # Shuffle deterministically
    random.seed(42)
    random.shuffle(deduped)

    return deduped
