"""
Dataset pipeline entry point.
Usage: python main.py [--resume] [--limit N] [--dry-run] [--skip-scrape] [--skip-generate]
"""

import argparse
import asyncio
import sys
import time
from pathlib import Path


def parse_args():
    p = argparse.ArgumentParser(
        description="Axion dataset pipeline: scrape → generate Q&A → merge",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Steps:
  1. Scraper  — crawls configured sources, saves raw .txt + .meta.json files
  2. Generator — sends each .txt to LLM, produces Q&A .json files
  3. Merger   — loads scraped + HuggingFace datasets, deduplicates, shuffles, writes JSONL

Examples:
  python main.py                     # full pipeline
  python main.py --resume            # skip already-done files
  python main.py --skip-scrape       # generate + merge only
  python main.py --dry-run           # validate config, no LLM calls
  python main.py --limit 500         # cap scraper page count
        """,
    )
    p.add_argument("--resume",        action="store_true", help="Skip already-processed files")
    p.add_argument("--limit",         type=int, default=None, help="Max pages to scrape per source")
    p.add_argument("--dry-run",       action="store_true", help="Scrape + parse but skip LLM calls")
    p.add_argument("--skip-scrape",   action="store_true", help="Skip Step 1 (scraper)")
    p.add_argument("--skip-generate", action="store_true", help="Skip Step 2 (Q&A generator)")
    p.add_argument("--skip-merge",    action="store_true", help="Skip Step 3+4 (merger)")
    p.add_argument("--skip-filter",   action="store_true", help="Skip Step 5 (quality filter)")
    return p.parse_args()


def print_header():
    print("=" * 60)
    print("  Axion Dataset Pipeline")
    print("=" * 60)


def print_step(n: int, title: str):
    print(f"\n{'─' * 60}")
    print(f"  Step {n}: {title}")
    print(f"{'─' * 60}")


def fmt_duration(seconds: float) -> str:
    if seconds < 60:
        return f"{seconds:.1f}s"
    m, s = divmod(int(seconds), 60)
    if m < 60:
        return f"{m}m {s}s"
    h, m = divmod(m, 60)
    return f"{h}h {m}m {s}s"


async def main():
    args = parse_args()
    print_header()

    # Validate config early
    try:
        from config import (
            RAW_DIR, GEN_DIR, FINAL_FILE, DATA_DIR,
            LLM_PROVIDERS, SCRAPE_TARGETS,
        )
    except ImportError as e:
        print(f"\n[ERROR] Could not import config: {e}")
        sys.exit(1)

    # Ensure directories exist
    for d in (DATA_DIR, RAW_DIR, GEN_DIR):
        d.mkdir(parents=True, exist_ok=True)

    print(f"\n  Data directory : {DATA_DIR}")
    print(f"  Raw texts      : {RAW_DIR}")
    print(f"  Generated Q&A  : {GEN_DIR}")
    print(f"  Final output   : {FINAL_FILE}")
    print(f"\n  LLM providers  : {', '.join(p['name'] for p in LLM_PROVIDERS)}")
    print(f"  Scrape targets : {len(SCRAPE_TARGETS)} sources")

    if args.dry_run:
        print("\n  [DRY RUN] No LLM calls will be made.")

    t_start = time.time()
    results = {}

    # ── Step 1: Scraper ───────────────────────────────────────────────────────
    if not args.skip_scrape:
        print_step(1, "Web Scraper")
        t0 = time.time()
        try:
            from scraper import run_scraper
            scraped = await run_scraper(
                resume=args.resume,
                limit=args.limit,
            )
            results["scraped_pages"] = scraped
            print(f"\n  Scraper done in {fmt_duration(time.time() - t0)}")
            print(f"  Pages saved: {scraped:,}")
        except Exception as e:
            print(f"\n[ERROR] Scraper failed: {e}")
            if not args.resume:
                sys.exit(1)
    else:
        print("\n  [Skipped] Step 1: Scraper")
        raw_count = len(list(RAW_DIR.glob("*.txt")))
        print(f"  Found {raw_count:,} existing raw files")
        results["scraped_pages"] = raw_count

    # ── Step 2: Q&A Generator ────────────────────────────────────────────────
    if not args.skip_generate:
        print_step(2, "Q&A Generator")
        t0 = time.time()
        try:
            from generator import run_generator
            qa_count = await run_generator(
                resume=args.resume,
                dry_run=args.dry_run,
            )
            results["qa_pairs"] = qa_count
            print(f"\n  Generator done in {fmt_duration(time.time() - t0)}")
        except Exception as e:
            print(f"\n[ERROR] Generator failed: {e}")
            if not args.resume:
                sys.exit(1)
    else:
        print("\n  [Skipped] Step 2: Q&A Generator")
        gen_count = len(list(GEN_DIR.glob("*.json")))
        print(f"  Found {gen_count:,} existing generation files")

    # ── Steps 3+4: Merge & Save ───────────────────────────────────────────────
    if not args.skip_merge:
        print_step(3, "Merge, Dedup & Save")
        t0 = time.time()
        try:
            from merger import merge_and_save
            stats = merge_and_save()
            results["final_examples"] = stats["total"]
            results["estimated_tokens"] = stats["estimated_tokens"]
            results["by_source"] = stats["by_source"]
            print(f"\n  Merge done in {fmt_duration(time.time() - t0)}")
        except Exception as e:
            print(f"\n[ERROR] Merger failed: {e}")
            sys.exit(1)
    else:
        print("\n  [Skipped] Steps 3+4: Merge & Save")

    # ── Step 5: Quality Filter ────────────────────────────────────────────────
    if not args.skip_filter and not args.skip_merge:
        print_step(5, "Quality Filter")
        t0 = time.time()
        try:
            from filter import filter_dataset
            fstats = filter_dataset()
            results["filtered_examples"] = fstats["output"]
            results["removed_examples"]  = fstats["removed"]
            print(f"\n  Filter done in {fmt_duration(time.time() - t0)}")
        except Exception as e:
            print(f"\n[WARNING] Filter step failed: {e} — skipping")
    else:
        print("\n  [Skipped] Step 5: Quality Filter")

    # ── Final Summary ─────────────────────────────────────────────────────────
    total_time = time.time() - t_start
    print(f"\n{'=' * 60}")
    print(f"  Pipeline Complete — {fmt_duration(total_time)}")
    print(f"{'=' * 60}")

    if "scraped_pages" in results:
        print(f"  Pages scraped    : {results['scraped_pages']:,}")
    if "qa_pairs" in results:
        print(f"  Q&A pairs gen'd  : {results['qa_pairs']:,}")
    if "final_examples" in results:
        out_count = results.get("filtered_examples", results["final_examples"])
        print(f"  Final examples   : {out_count:,}")
        if "removed_examples" in results:
            print(f"  Removed by filter: {results['removed_examples']:,}")
        print(f"  Est. tokens      : {results['estimated_tokens']:,}")
        print(f"  Output           : {FINAL_FILE}")

    if "by_source" in results:
        print(f"\n  Breakdown by source:")
        for src, cnt in sorted(results["by_source"].items(), key=lambda x: -x[1]):
            bar = "█" * min(30, cnt // max(1, results["final_examples"] // 30))
            print(f"    {src:<28} {cnt:>8,}  {bar}")

    print()


if __name__ == "__main__":
    asyncio.run(main())
