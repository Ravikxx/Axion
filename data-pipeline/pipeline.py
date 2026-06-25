#!/usr/bin/env python3
"""
Lumen 1.3 SFT Data Pipeline — pull HF datasets, clean, format for Qwen 3.

Usage:
    python pipeline.py                         # full run
    python pipeline.py --preview               # stats only, no write
    python pipeline.py --only-clean            # re-clean cached data
"""
import argparse, json, os, sys, time

sys.path.insert(0, os.path.dirname(__file__))
import config
from clean import filter_and_dedup


def load_cache(name):
    path = os.path.join(config.CACHE_DIR, f"{name}.jsonl")
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        return [json.loads(l)["messages"] for l in f if l.strip()]


def save_cache(name, examples):
    path = os.path.join(config.CACHE_DIR, f"{name}.jsonl")
    with open(path, "w", encoding="utf-8") as f:
        for msgs in examples:
            f.write(json.dumps({"messages": msgs}, ensure_ascii=False) + "\n")
    print(f"  [cache] saved {len(examples)} -> {path}", flush=True)


def pull_hf(force=False):
    """Pull all HF datasets, return list of message-lists."""
    from sources.hf import pull
    all_raw = []
    for hf_path, split, sample_n, fmt in config.HF_DATASETS:
        name = hf_path.split("/")[-1]
        cached = load_cache(f"hf_{name}")
        if cached is not None and not force:
            print(f"  [hf]   {name}: {len(cached)} from cache ({split})")
            all_raw.extend(cached)
            continue
        examples = pull(hf_path, split, sample_n, fmt)
        save_cache(f"hf_{name}", examples)
        all_raw.extend(examples)
    return all_raw


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only-clean", action="store_true")
    ap.add_argument("--force",      action="store_true", help="Re-fetch all datasets")
    ap.add_argument("--preview",    action="store_true")
    args = ap.parse_args()

    t0 = time.time()
    all_raw = []

    print("\n===========================================")
    print("  Lumen 1.3 SFT Data Pipeline")
    print("  Qwen3-8B  |  HF datasets (SWE Bench heavy)")
    print("===========================================\n")

    if not args.only_clean:
        print("-- Pulling HF datasets -----------------")
        all_raw = pull_hf(force=args.force)
        print(f"\n  Raw total: {len(all_raw):,} examples\n")
    else:
        # Load all cached
        from sources.hf import _FORMATTERS
        loaded_total = 0
        for hf_path, split, sample_n, fmt in config.HF_DATASETS:
            name = hf_path.split("/")[-1]
            cached = load_cache(f"hf_{name}")
            if cached:
                all_raw.extend(cached)
                loaded_total += len(cached)
                print(f"  [pipeline] loaded {name}: {len(cached)} from cache")
        print(f"\n  Loaded total: {loaded_total:,} examples\n")

    print("-- Cleaning & deduplication --------------")
    clean = filter_and_dedup(all_raw)
    print()

    print("-- Formatting for Qwen 3 ----------------")
    from format_qwen import format_for_qwen, write_dataset
    formatted = format_for_qwen(clean)

    elapsed = time.time() - t0
    print(f"\n===========================================")
    print(f"  Final dataset:  {len(formatted):,} examples")
    print(f"  Time:           {elapsed/60:.1f} min")
    print(f"  Output:         {config.OUTPUT_FILE}")
    print(f"===========================================\n")

    if args.preview:
        print("-- Sample examples ---------------------")
        for i, entry in enumerate(formatted[:3]):
            print(f"\n[{i}]")
            for m in entry["messages"]:
                preview = m["content"][:150].replace("\n", " ")
                safe = preview.encode("ascii", errors="replace").decode("ascii")
                print(f"  {m['role']:>10}: {safe}")
        return

    write_dataset(formatted, config.OUTPUT_FILE)
    print(f"  Target:  {config.TARGET_TOTAL:,} examples")
    print(f"  Actual:  {len(formatted):,} examples")

    if len(formatted) > 0:
        print("\n  Next step: upload to HuggingFace or run Kaggle SFT notebook.\n")


if __name__ == "__main__":
    main()
