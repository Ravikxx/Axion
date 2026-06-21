"""
Post-merge quality filter.
Runs on the final JSONL and removes low-quality / duplicate examples.
"""

import hashlib
import json
import re
from pathlib import Path

from tqdm import tqdm

from config import FINAL_FILE


# ── Heuristic checks ─────────────────────────────────────────────────────────

_REFUSAL_RE = re.compile(
    r"^(I('m| am) (sorry|afraid|unable)|I can'?t|I cannot|I will not|"
    r"As an AI|As a language model|I don'?t (have|feel)|"
    r"I apologize|Unfortunately,? I)",
    re.I,
)

_TRUNCATED_RE = re.compile(r"\[truncated\]\s*$", re.I)

_MOSTLY_CODE_RE = re.compile(r"```")


def _content_hash(q: str, a: str) -> str:
    return hashlib.sha256(f"{q.lower().strip()}|||{a.lower().strip()}".encode()).hexdigest()[:24]


def _q_hash(q: str) -> str:
    return hashlib.sha256(q.lower().strip().encode()).hexdigest()[:24]


def _passes(row: dict) -> tuple[bool, str]:
    q = row.get("question", "").strip()
    a = row.get("answer", "").strip()

    # Minimum lengths
    if len(q) < 15:
        return False, "question_too_short"
    if len(a) < 40:
        return False, "answer_too_short"

    # Maximum lengths
    if len(q) > 4000:
        return False, "question_too_long"
    if len(a) > 16000:
        return False, "answer_too_long"

    # Refusals
    if _REFUSAL_RE.match(a) and len(a) < 300:
        return False, "refusal"

    # Truncated content marker left in
    if _TRUNCATED_RE.search(a):
        return False, "truncated_marker"

    # Answer must contain at least one real word (not just symbols/numbers)
    if not re.search(r"[a-zA-Z]{3,}", a):
        return False, "no_words_in_answer"

    # Skip pure placeholder answers
    if re.match(r"^\[.*\]$", a.strip()):
        return False, "placeholder_answer"

    # Question should end with something meaningful (not just whitespace/symbols)
    q_stripped = q.rstrip("?!. \t")
    if len(q_stripped) < 10:
        return False, "question_trivial"

    return True, "ok"


# ── Main filter ───────────────────────────────────────────────────────────────

def filter_dataset(path: Path = FINAL_FILE) -> dict:
    """
    Read FINAL_FILE, apply quality filters + exact-content dedup, overwrite in place.
    Returns stats dict.
    """
    if not path.exists():
        raise FileNotFoundError(f"Dataset not found: {path}")

    print(f"\n  Loading {path} for filtering…")
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    pass

    total_in = len(rows)
    print(f"  Loaded {total_in:,} examples")

    kept = []
    seen_content = set()
    seen_questions = set()
    rejection_counts: dict[str, int] = {}

    for row in tqdm(rows, desc="Filtering", unit="ex"):
        ok, reason = _passes(row)
        if not ok:
            rejection_counts[reason] = rejection_counts.get(reason, 0) + 1
            continue

        # Exact content dedup
        ch = _content_hash(row["question"], row["answer"])
        if ch in seen_content:
            rejection_counts["exact_duplicate"] = rejection_counts.get("exact_duplicate", 0) + 1
            continue
        seen_content.add(ch)

        # Near-exact question dedup (same question, different answer — keep first)
        qh = _q_hash(row["question"])
        if qh in seen_questions:
            rejection_counts["duplicate_question"] = rejection_counts.get("duplicate_question", 0) + 1
            continue
        seen_questions.add(qh)

        kept.append(row)

    # Overwrite in place
    print(f"  Writing {len(kept):,} filtered examples…")
    with open(path, "w", encoding="utf-8") as f:
        for row in tqdm(kept, desc="Writing", unit="ex"):
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    removed = total_in - len(kept)
    print(f"\n  Filter summary:")
    print(f"    Input  : {total_in:,}")
    print(f"    Output : {len(kept):,}  (removed {removed:,})")
    if rejection_counts:
        print(f"\n  Removed by reason:")
        for reason, count in sorted(rejection_counts.items(), key=lambda x: -x[1]):
            print(f"    {reason:<28} {count:>8,}")

    return {
        "input": total_in,
        "output": len(kept),
        "removed": removed,
        "by_reason": rejection_counts,
    }
