"""
Dataset merger: combines scraped Q&A output + HuggingFace datasets,
deduplicates by fuzzy question match, shuffles, writes final JSONL.
"""

import json
import random
from pathlib import Path

from rapidfuzz import fuzz
from tqdm import tqdm

from config import (
    FINAL_FILE, GEN_DIR, HF_DATASETS, FUZZY_THRESHOLD, SHUFFLE_SEED,
)
from utils import estimate_tokens


# ── Normalize to shared schema ────────────────────────────────────────────────

def _norm(question: str, answer: str, source: str) -> dict:
    return {
        "question": question.strip(),
        "answer":   answer.strip(),
        "source":   source,
    }


# ── Load scraped Q&A ──────────────────────────────────────────────────────────

def load_scraped() -> list[dict]:
    rows = []
    files = sorted(GEN_DIR.glob("*.json"))
    for f in tqdm(files, desc="Loading scraped Q&A", unit="file"):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        category = data.get("category", "scraped")
        source   = f"scraped_{category}"
        for pair in data.get("pairs", []):
            q = pair.get("question", "")
            a = pair.get("answer", "")
            if q and a:
                rows.append(_norm(q, a, source))
    return rows


# ── Load HuggingFace datasets ─────────────────────────────────────────────────

def _load_openhermes(ds, limit: int) -> list[dict]:
    """OpenHermes uses a 'conversations' field with role/value pairs."""
    rows = []
    for item in tqdm(ds, desc="OpenHermes", total=min(limit, len(ds)), unit="ex"):
        if len(rows) >= limit:
            break
        convs = item.get("conversations", [])
        # Find human→gpt pairs
        for i, turn in enumerate(convs):
            if turn.get("from") == "human" and i + 1 < len(convs):
                nxt = convs[i + 1]
                if nxt.get("from") in ("gpt", "assistant"):
                    q = turn.get("value", "")
                    a = nxt.get("value", "")
                    if q and a:
                        rows.append(_norm(q, a, "openhermes"))
    return rows


def _load_generic(ds, cfg: dict, limit: int) -> list[dict]:
    """Generic field mapping for alpaca-style datasets."""
    rows = []
    qf = cfg.get("q_field", "instruction")
    af = cfg.get("a_field", "output")
    inp_f = cfg.get("input_field", "input")
    source = cfg["source"]
    for item in tqdm(ds, desc=source, total=min(limit, len(ds)), unit="ex"):
        if len(rows) >= limit:
            break
        q = str(item.get(qf, "") or "").strip()
        inp = str(item.get(inp_f, "") or "").strip()
        a = str(item.get(af, "") or "").strip()
        if inp:
            q = f"{q}\n\n{inp}".strip()
        if q and a and len(a) > 20:
            rows.append(_norm(q, a, source))
    return rows


def load_hf_datasets() -> list[dict]:
    try:
        from datasets import load_dataset
    except ImportError:
        print("  datasets not installed — skipping HuggingFace datasets.")
        return []

    rows = []
    for cfg in HF_DATASETS:
        print(f"\n  Downloading {cfg['id']}…")
        try:
            ds = load_dataset(cfg["id"], split=cfg["split"])
        except Exception as e:
            print(f"  Failed to load {cfg['id']}: {e}")
            continue

        limit = cfg.get("limit", 50_000)
        if cfg["source"] == "openhermes":
            rows.extend(_load_openhermes(ds, limit))
        else:
            rows.extend(_load_generic(ds, cfg, limit))

    return rows


# ── Fuzzy dedup ───────────────────────────────────────────────────────────────

def fuzzy_dedup(rows: list[dict], threshold: int = FUZZY_THRESHOLD) -> list[dict]:
    """
    Remove duplicate questions. Does exact dedup (case-insensitive) plus
    a bucket-based fuzzy pass: groups by 4-char prefix and checks similarity
    within each bucket, which scales to 100k+ examples.
    """
    print(f"\n  Deduplicating {len(rows):,} examples (threshold={threshold}%)…")

    # Pass 1: exact dedup (normalised lowercase)
    seen_exact: set[str] = set()
    after_exact = []
    for row in rows:
        key = row["question"].lower().strip()
        if key not in seen_exact:
            seen_exact.add(key)
            after_exact.append(row)

    exact_removed = len(rows) - len(after_exact)

    # Pass 2: bucket-based fuzzy dedup
    # Group by lowercased 4-char prefix so we only compare within plausible clusters.
    buckets: dict[str, list[str]] = {}
    for row in after_exact:
        prefix = row["question"].lower()[:4]
        buckets.setdefault(prefix, []).append(row["question"])

    # Build set of questions to drop
    drop: set[str] = set()
    for bucket_qs in tqdm(buckets.values(), desc="Fuzzy dedup", unit="bucket"):
        if len(bucket_qs) < 2:
            continue
        for i in range(len(bucket_qs)):
            if bucket_qs[i] in drop:
                continue
            for j in range(i + 1, len(bucket_qs)):
                if bucket_qs[j] in drop:
                    continue
                if fuzz.QRatio(bucket_qs[i], bucket_qs[j]) >= threshold:
                    drop.add(bucket_qs[j])

    deduped = [r for r in after_exact if r["question"] not in drop]
    total_removed = len(rows) - len(deduped)
    print(f"  Removed {exact_removed:,} exact + {len(drop):,} fuzzy duplicates → {len(deduped):,} remain")
    return deduped


# ── Final assembly ────────────────────────────────────────────────────────────

def merge_and_save() -> dict:
    print("\n── Step 3: Loading scraped Q&A ──")
    scraped = load_scraped()
    print(f"  Scraped examples: {len(scraped):,}")

    print("\n── Step 3: Loading HuggingFace datasets ──")
    hf = load_hf_datasets()
    print(f"  HF examples: {len(hf):,}")

    all_rows = scraped + hf
    print(f"\n  Total before dedup: {len(all_rows):,}")

    # Dedup
    deduped = fuzzy_dedup(all_rows)

    # Shuffle
    rng = random.Random(SHUFFLE_SEED)
    rng.shuffle(deduped)

    # Write JSONL
    print(f"\n── Step 4: Writing {FINAL_FILE} ──")
    with open(FINAL_FILE, "w", encoding="utf-8") as f:
        for row in tqdm(deduped, desc="Writing JSONL", unit="ex"):
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    # Summary stats
    by_source: dict[str, int] = {}
    total_chars = 0
    for row in deduped:
        src = row.get("source", "unknown")
        by_source[src] = by_source.get(src, 0) + 1
        total_chars += len(row["question"]) + len(row["answer"])

    stats = {
        "total": len(deduped),
        "by_source": by_source,
        "estimated_tokens": estimate_tokens(" " * total_chars),
        "output": str(FINAL_FILE),
    }

    print(f"\n── Final Dataset Summary ──")
    print(f"  Output file: {FINAL_FILE}")
    print(f"  Total examples: {stats['total']:,}")
    print(f"  Estimated tokens: {stats['estimated_tokens']:,}")
    print(f"\n  By source:")
    for src, cnt in sorted(by_source.items(), key=lambda x: -x[1]):
        print(f"    {src:<30} {cnt:>8,}")

    return stats
