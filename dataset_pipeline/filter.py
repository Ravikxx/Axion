"""Post-merge quality filter."""

import hashlib
import json
import re
from pathlib import Path

from tqdm import tqdm

from config import FINAL_FILE, BENCHMARK_MIN_ANSWER_SCORE, BENCHMARK_MIN_SIGNAL_SCORE, BENCHMARK_TASK_TYPES


_REFUSAL_RE = re.compile(
    r"^(I('m| am) (sorry|afraid|unable)|I can'?t|I cannot|I will not|"
    r"As an AI|As a language model|I don'?t (have|feel)|"
    r"I apologize|Unfortunately,? I)",
    re.I,
)

_TRUNCATED_RE = re.compile(r"\[truncated\]\s*$", re.I)
_CODE_FENCE_RE = re.compile(r"```")
_FILE_REF_RE = re.compile(r"\b[\w./-]+\.(py|js|ts|tsx|jsx|go|rs|java|cpp|c|h|md|toml|json|yaml|yml|sh|rb|php|cs|swift|kt)\b")
_TEST_RE = re.compile(r"\b(test|pytest|unittest|cargo test|npm test|failing test|regression|bug|error|exception|traceback|stack trace|reproduce|crash|fix)\b", re.I)
_DIFF_RE = re.compile(r"(^\+|^-)", re.M)
_CODE_TOKEN_RE = re.compile(r"\b(def|class|import|return|assert|try|except|throw|function|const|let|var|public|private|fn|impl|package)\b")
_MATH_RE = re.compile(
    r"(\b(solve|equation|algebra|geometry|probability|fraction|ratio|decimal|percent|integer|factor|prime|mean|median|derivative|integral|sum|product|count)\b|[0-9]\s*[\+\-\*/=]\s*[0-9]|\\boxed|sqrt)",
    re.I,
)

_CODE_SOURCE_RE = re.compile(r"(codealpaca|humaneval|mbpp|github|stackoverflow|mdn|arxiv|devto)", re.I)
_MATH_SOURCE_RE = re.compile(r"(gsm8k|mathworld|pauls_math|math)", re.I)


def _content_hash(q: str, a: str) -> str:
    return hashlib.sha256(f"{q.lower().strip()}|||{a.lower().strip()}".encode()).hexdigest()[:24]


def _q_hash(q: str) -> str:
    return hashlib.sha256(q.lower().strip().encode()).hexdigest()[:24]


def _signal_score(text: str) -> int:
    score = 0
    if _CODE_FENCE_RE.search(text):
        score += 2
    if _FILE_REF_RE.search(text):
        score += 2
    if _TEST_RE.search(text):
        score += 2
    if _DIFF_RE.search(text):
        score += 1
    if _CODE_TOKEN_RE.search(text):
        score += 1
    return score


def _is_benchmark_task(row: dict) -> bool:
    task_type = str(row.get("task_type", "")).strip().lower()
    if task_type and task_type not in BENCHMARK_TASK_TYPES:
        return False

    source = str(row.get("source", "")).strip().lower()
    q = row.get("question", "").strip()
    a = row.get("answer", "").strip()
    combined = f"{q}\n{a}"

    if _MATH_SOURCE_RE.search(source) or _MATH_RE.search(combined):
        if _MATH_RE.search(combined) or source:
            return True

    if _CODE_SOURCE_RE.search(source):
        if _signal_score(q) + _signal_score(a) < BENCHMARK_MIN_SIGNAL_SCORE:
            return False
        if _signal_score(a) < BENCHMARK_MIN_ANSWER_SCORE:
            return False
        if not _TEST_RE.search(combined) and not re.search(r"\b(bug|fix|patch|debug|regression|crash)\b", combined, re.I):
            return False
        return True

    return False


def _passes(row: dict, benchmark_mode: bool = False) -> tuple[bool, str]:
    q = row.get("question", "").strip()
    a = row.get("answer", "").strip()

    if len(q) < 15:
        return False, "question_too_short"
    if len(a) < 40:
        return False, "answer_too_short"
    if len(q) > 4000:
        return False, "question_too_long"
    if len(a) > 16000:
        return False, "answer_too_long"
    if _REFUSAL_RE.match(a) and len(a) < 300:
        return False, "refusal"
    if _TRUNCATED_RE.search(a):
        return False, "truncated_marker"
    if not re.search(r"[a-zA-Z]{3,}", a):
        return False, "no_words_in_answer"
    if re.match(r"^\[.*\]$", a.strip()):
        return False, "placeholder_answer"

    q_stripped = q.rstrip("?!. \t")
    if len(q_stripped) < 10:
        return False, "question_trivial"

    if benchmark_mode and not _is_benchmark_task(row):
        return False, "not_benchmark_code_task"

    return True, "ok"


def filter_dataset(path: Path = FINAL_FILE, benchmark_mode: bool = False) -> dict:
    """Read FINAL_FILE, apply quality filters + exact-content dedup, overwrite in place."""
    if not path.exists():
        raise FileNotFoundError(f"Dataset not found: {path}")

    print(f"\n  Loading {path} for filtering...")
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
        ok, reason = _passes(row, benchmark_mode=benchmark_mode)
        if not ok:
            rejection_counts[reason] = rejection_counts.get(reason, 0) + 1
            continue

        ch = _content_hash(row["question"], row["answer"])
        if ch in seen_content:
            rejection_counts["exact_duplicate"] = rejection_counts.get("exact_duplicate", 0) + 1
            continue
        seen_content.add(ch)

        qh = _q_hash(row["question"])
        if qh in seen_questions:
            rejection_counts["duplicate_question"] = rejection_counts.get("duplicate_question", 0) + 1
            continue
        seen_questions.add(qh)

        kept.append(row)

    print(f"  Writing {len(kept):,} filtered examples...")
    with open(path, "w", encoding="utf-8") as f:
        for row in tqdm(kept, desc="Writing", unit="ex"):
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    removed = total_in - len(kept)
    print("\n  Filter summary:")
    print(f"    Input  : {total_in:,}")
    print(f"    Output : {len(kept):,}  (removed {removed:,})")
    if rejection_counts:
        print("\n  Removed by reason:")
        for reason, count in sorted(rejection_counts.items(), key=lambda x: -x[1]):
            print(f"    {reason:<28} {count:>8,}")

    return {
        "input": total_in,
        "output": len(kept),
        "removed": removed,
        "by_reason": rejection_counts,
    }
