#!/usr/bin/env python3
"""
Lumen 1.3 SFT Data Pipeline
============================
Pulls data from HuggingFace datasets, Reddit, and documentation sites,
cleans and deduplicates, and writes a final JSONL ready for SFT training.

Usage:
    python main.py                   # full run
    python main.py --skip-hf         # skip HuggingFace (use cached)
    python main.py --skip-reddit     # skip Reddit
    python main.py --skip-docs       # skip doc scraping
    python main.py --only-clean      # re-clean existing parts, no fetching
    python main.py --preview         # print stats and first 3 examples, no write
"""

import argparse
import json
import os
import random
import sys
import time

# Paths are relative to this file
sys.path.insert(0, os.path.dirname(__file__))

import config
from clean import filter_and_dedup

CACHE_DIR = os.path.join(os.path.dirname(__file__), config.OUTPUT_DIR, "cache")
OUT_PATH  = os.path.join(os.path.dirname(__file__), config.OUTPUT_DIR, config.OUTPUT_FILE)

os.makedirs(CACHE_DIR, exist_ok=True)
os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)


# ── Cache helpers ──────────────────────────────────────────────────────────────

def _cache_path(name):
    return os.path.join(CACHE_DIR, f"{name}.jsonl")


def _save_cache(name, examples):
    path = _cache_path(name)
    with open(path, "w") as f:
        for ex in examples:
            f.write(json.dumps({"messages": ex}) + "\n")
    print(f"  [cache] saved {len(examples)} → {path}")


def _load_cache(name):
    path = _cache_path(name)
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return [json.loads(l)["messages"] for l in f if l.strip()]


# ── Source runners ─────────────────────────────────────────────────────────────

def run_hf(force=False):
    cached = _load_cache("hf")
    if cached is not None and not force:
        print(f"  [hf]    loaded {len(cached)} from cache")
        return cached

    from sources.hf import pull
    all_examples = []
    for hf_path, split, sample_n, fmt in config.HF_DATASETS:
        name = hf_path.split("/")[-1]
        print(f"\n── {name} ({'all' if sample_n is None else sample_n}) ──")
        examples = pull(hf_path, split, sample_n, fmt)
        all_examples.extend(examples)

    _save_cache("hf", all_examples)
    return all_examples


def run_reddit(force=False):
    cached = _load_cache("reddit")
    if cached is not None and not force:
        print(f"  [reddit] loaded {len(cached)} from cache")
        return cached

    from sources.reddit import scrape_all
    examples = scrape_all(
        subs        = config.REDDIT_SUBS,
        sort        = config.REDDIT_SORT,
        time_filter = config.REDDIT_TIME,
        limit       = config.REDDIT_LIMIT,
        min_score   = config.REDDIT_MIN_SCORE,
        min_comments= config.REDDIT_MIN_COMMENTS,
    )
    _save_cache("reddit", examples)
    return examples


def run_docs(force=False):
    cached = _load_cache("docs")
    if cached is not None and not force:
        print(f"  [docs]   loaded {len(cached)} from cache")
        return cached

    from sources.docs import scrape_all
    examples = scrape_all(config.DOC_SITES)
    _save_cache("docs", examples)
    return examples


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-hf",      action="store_true")
    ap.add_argument("--skip-reddit",  action="store_true")
    ap.add_argument("--skip-docs",    action="store_true")
    ap.add_argument("--only-clean",   action="store_true", help="Re-clean cached data only")
    ap.add_argument("--force",        action="store_true", help="Ignore cache and re-fetch everything")
    ap.add_argument("--preview",      action="store_true", help="Print stats and samples, no write")
    args = ap.parse_args()

    t0 = time.time()
    all_raw = []

    print("\n═══════════════════════════════════")
    print("  Lumen 1.3 SFT Data Pipeline")
    print("═══════════════════════════════════\n")

    # ── Fetch ──────────────────────────────────────────────────────────────────
    if not args.skip_hf:
        print("── HuggingFace datasets ──────────────")
        hf_examples = run_hf(force=args.force)
        print(f"  total: {len(hf_examples)}")
        all_raw.extend(hf_examples)

    if not args.skip_reddit:
        print("\n── Reddit ────────────────────────────")
        reddit_examples = run_reddit(force=args.force)
        print(f"  total: {len(reddit_examples)}")
        all_raw.extend(reddit_examples)

    if not args.skip_docs:
        print("\n── Documentation ─────────────────────")
        doc_examples = run_docs(force=args.force)
        print(f"  total: {len(doc_examples)}")
        all_raw.extend(doc_examples)

    if not all_raw:
        # Try loading all caches
        for name in ("hf", "reddit", "docs"):
            c = _load_cache(name)
            if c:
                all_raw.extend(c)

    print(f"\n── Raw total: {len(all_raw)} examples ──────")

    # ── Clean ──────────────────────────────────────────────────────────────────
    print("\n── Cleaning & deduplication ──────────")
    clean = filter_and_dedup(all_raw)

    # Shuffle
    random.seed(42)
    random.shuffle(clean)

    # ── Stats ──────────────────────────────────────────────────────────────────
    print(f"\n══════════════════════════════════")
    print(f"  Final dataset: {len(clean):,} examples")
    elapsed = time.time() - t0
    print(f"  Time: {elapsed/60:.1f} min")

    if args.preview:
        print("\n── Sample examples ───────────────")
        for i, msgs in enumerate(clean[:3]):
            print(f"\n[{i}]")
            for m in msgs:
                preview = m["content"][:200].replace("\n", " ")
                print(f"  {m['role']:>10}: {preview}")
        return

    # ── Write ──────────────────────────────────────────────────────────────────
    print(f"\n── Writing → {OUT_PATH}")
    with open(OUT_PATH, "w") as f:
        for msgs in clean:
            f.write(json.dumps({"messages": msgs}, ensure_ascii=False) + "\n")

    size_mb = os.path.getsize(OUT_PATH) / 1024 / 1024
    print(f"  Done. {len(clean):,} examples · {size_mb:.1f} MB")
    print(f"\n  Next step: upload to HuggingFace or run SFT fine-tune.")


if __name__ == "__main__":
    main()
