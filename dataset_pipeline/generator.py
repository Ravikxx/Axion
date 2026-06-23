"""Q&A pair generator: reads raw .txt files, sends to LLM, saves .json output."""

import asyncio
import json
import re
from pathlib import Path

from tqdm.asyncio import tqdm

from config import (
    BENCHMARK_MIN_ANSWER_SCORE,
    BENCHMARK_MIN_SIGNAL_SCORE,
    BENCHMARK_TASK_TYPES,
    CODE_SIGNAL_KEYWORDS,
    GEN_DIR,
    RAW_DIR,
    SCRAPE_CONCURRENCY,
)
from llm_client import LLMClient, LLMError
from utils import count_words


STANDARD_QA_PROMPT = """You are a dataset generation assistant. Given the following text, generate 3-7 high-quality question and answer pairs suitable for training a language model.

Rules:
- Questions should be diverse: factual, conceptual, how-to, and reasoning types
- Answers should be complete, accurate, and self-contained
- For code-related content, include at least one code snippet in the answer where appropriate
- Output ONLY a JSON array. No preamble, no markdown fences, no explanation.

Format:
[
  {{"question": "...", "answer": "..."}},
  ...
]

Text:
{content}"""


BENCHMARK_QA_PROMPT = """You are creating training examples for software engineering benchmarks like SWE-bench.

Given the source text, generate 2-4 realistic coding tasks that look like bug reports, failing tests, regression fixes, or repository maintenance requests.

Rules:
- Prefer tasks that require changing code, adjusting tests, or fixing a concrete failure
- The question should sound like a maintainer report, issue, or user bug report
- The answer should be actionable and specific, and may include code snippets, commands, file names, or patch guidance
- Avoid generic explanations, trivia, or open-ended advice
- If the source text is not code-heavy enough, keep the examples tightly grounded in the text and do not invent unrelated behavior
- Output ONLY a JSON array. No preamble, no markdown fences, no explanation

Each item may include:
  {{"question": "...", "answer": "...", "task_type": "bugfix|debugging|test|patch|refactor|implementation"}}

Text:
{content}"""


_CODE_FENCE_RE = re.compile(r"```")
_FILE_REF_RE = re.compile(r"\b[\w./-]+\.(py|js|ts|tsx|jsx|go|rs|java|cpp|c|h|md|toml|json|yaml|yml|sh|rb|php)\b")
_TEST_RE = re.compile(r"\b(test|pytest|unittest|cargo test|npm test|failing test|regression|bug|error|exception|traceback|stack trace|reproduce|crash)\b", re.I)
_DIFF_RE = re.compile(r"(^\+|^-)", re.M)


def _parse_qa(raw: str) -> list[dict]:
    """Extract a JSON array of Q&A pairs from potentially messy LLM output."""
    raw = re.sub(r"```(?:json)?\s*", "", raw).strip()

    try:
        data = json.loads(raw)
        if isinstance(data, list):
            return [_normalize_pair(d) for d in data if _is_pairish(d)]
    except json.JSONDecodeError:
        pass

    m = re.search(r"\[.*\]", raw, re.DOTALL)
    if m:
        try:
            data = json.loads(m.group(0))
            if isinstance(data, list):
                return [_normalize_pair(d) for d in data if _is_pairish(d)]
        except json.JSONDecodeError:
            pass

    return []


def _is_pairish(item: object) -> bool:
    return isinstance(item, dict) and item.get("question") and item.get("answer")


def _normalize_pair(item: dict) -> dict:
    pair = dict(item)
    pair["question"] = str(pair.get("question", "")).strip()
    pair["answer"] = str(pair.get("answer", "")).strip()
    if "task_type" in pair and pair["task_type"] is not None:
        pair["task_type"] = str(pair["task_type"]).strip().lower()
    return pair


def _signal_score(text: str) -> int:
    lower = text.lower()
    score = 0
    if _CODE_FENCE_RE.search(text):
        score += 2
    if _FILE_REF_RE.search(text):
        score += 2
    if _TEST_RE.search(text):
        score += 2
    if _DIFF_RE.search(text):
        score += 1
    for kw in CODE_SIGNAL_KEYWORDS:
        if kw in lower:
            score += 1
    return score


def _task_type_allowed(task_type: str | None) -> bool:
    if not task_type:
        return True
    return task_type.lower() in BENCHMARK_TASK_TYPES


def _is_valid_pair(qa: dict, benchmark_mode: bool = False) -> bool:
    q, a = qa.get("question", ""), qa.get("answer", "")
    if not q or not a:
        return False
    if len(q) < 15 or len(a) < 40:
        return False
    if len(q) > 2000 or len(a) > 8000:
        return False
    if re.match(r"^I (can't|cannot|won't|will not) (help|answer)", a, re.I) and len(a) < 200:
        return False

    if not benchmark_mode:
        return True

    if not _task_type_allowed(qa.get("task_type")):
        return False

    combined_score = _signal_score(q + "\n" + a)
    if combined_score < BENCHMARK_MIN_SIGNAL_SCORE:
        return False

    if _signal_score(a) < BENCHMARK_MIN_ANSWER_SCORE:
        return False

    return True


def _content_is_code_heavy(content: str) -> bool:
    return _signal_score(content) >= 4


class QAGenerator:
    def __init__(
        self,
        resume: bool = False,
        dry_run: bool = False,
        concurrency: int = SCRAPE_CONCURRENCY,
        benchmark_mode: bool = False,
    ):
        self.resume = resume
        self.dry_run = dry_run
        self.concurrency = concurrency
        self.benchmark_mode = benchmark_mode
        self.llm = LLMClient()
        self.sem = asyncio.Semaphore(concurrency)
        self.generated = 0
        self.skipped = 0
        self.failed = 0

    def _build_prompt(self, content: str, meta: dict) -> str:
        source_hint = meta.get("category") or "scraped"
        url = meta.get("url", "")
        header = f"Source category: {source_hint}\nSource url: {url}\n\n"
        template = BENCHMARK_QA_PROMPT if self.benchmark_mode else STANDARD_QA_PROMPT
        return template.replace("{content}", header + content)

    async def _process_file(self, txt_path: Path) -> int:
        uhash = txt_path.stem
        out_path = GEN_DIR / f"{uhash}.json"

        if self.resume and out_path.exists():
            self.skipped += 1
            return 0

        content = txt_path.read_text(encoding="utf-8", errors="replace")
        if count_words(content) < 100:
            self.skipped += 1
            return 0
        if self.benchmark_mode and not _content_is_code_heavy(content):
            self.skipped += 1
            return 0

        if self.dry_run:
            self.skipped += 1
            return 0

        meta_path = txt_path.with_suffix(".meta.json")
        meta = {}
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text())
            except Exception:
                pass

        prompt = self._build_prompt(content, meta)

        try:
            async with self.sem:
                raw = await self.llm.generate(prompt)
        except LLMError:
            self.failed += 1
            return 0

        pairs = _parse_qa(raw)
        valid = [p for p in pairs if _is_valid_pair(p, benchmark_mode=self.benchmark_mode)]

        if not valid:
            self.failed += 1
            return 0

        result = {
            "source_url": meta.get("url", ""),
            "category": meta.get("category", "scraped"),
            "pairs": valid,
        }
        out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        self.generated += len(valid)
        return len(valid)

    async def run(self) -> int:
        txt_files = sorted(RAW_DIR.glob("*.txt"))
        if not txt_files:
            print("  No raw files found. Run scraper first.")
            return 0

        tasks = [self._process_file(f) for f in txt_files]
        with tqdm(total=len(tasks), desc="Generating Q&A", unit="doc") as pbar:
            for coro in asyncio.as_completed(tasks):
                await coro
                pbar.update(1)
                pbar.set_postfix(qa=self.generated, skip=self.skipped, fail=self.failed)

        await self.llm.close()
        return self.generated

    def print_stats(self):
        print(f"\n  Q&A pairs generated: {self.generated}")
        print(f"  Documents skipped:   {self.skipped}")
        print(f"  Documents failed:    {self.failed}")
        self.llm.print_stats()


async def run_generator(
    resume: bool = False,
    dry_run: bool = False,
    benchmark_mode: bool = False,
) -> int:
    gen = QAGenerator(resume=resume, dry_run=dry_run, benchmark_mode=benchmark_mode)
    total = await gen.run()
    gen.print_stats()
    return total
