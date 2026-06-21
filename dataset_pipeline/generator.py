"""
Q&A pair generator: reads raw .txt files, sends to LLM, saves .json output.
Runs multiple workers in parallel for throughput.
"""

import asyncio
import json
import re
from pathlib import Path

from tqdm.asyncio import tqdm

from config import GEN_DIR, RAW_DIR, SCRAPE_CONCURRENCY
from llm_client import LLMClient, LLMError
from utils import count_words, estimate_tokens


QA_PROMPT = """You are a dataset generation assistant. Given the following text, generate 3–7 high-quality question and answer pairs suitable for training a language model.

Rules:
- Questions should be diverse: factual, conceptual, how-to, and reasoning types
- Answers should be complete, accurate, and self-contained (no references to "the text above")
- For code-related content, include at least one code snippet in the answer where appropriate
- Output ONLY a JSON array. No preamble, no markdown fences, no explanation.

Format:
[
  {{"question": "...", "answer": "..."}},
  ...
]

Text:
{content}"""


def _parse_qa(raw: str) -> list[dict]:
    """Extract a JSON array of Q&A pairs from potentially messy LLM output."""
    # Strip markdown fences
    raw = re.sub(r"```(?:json)?\s*", "", raw).strip()

    # Try direct parse
    try:
        data = json.loads(raw)
        if isinstance(data, list):
            return [
                {"question": str(d.get("question", "")),
                 "answer":   str(d.get("answer", ""))}
                for d in data
                if d.get("question") and d.get("answer")
            ]
    except json.JSONDecodeError:
        pass

    # Try to find the array portion
    m = re.search(r"\[.*\]", raw, re.DOTALL)
    if m:
        try:
            data = json.loads(m.group(0))
            if isinstance(data, list):
                return [
                    {"question": str(d.get("question", "")),
                     "answer":   str(d.get("answer", ""))}
                    for d in data
                    if d.get("question") and d.get("answer")
                ]
        except json.JSONDecodeError:
            pass

    return []


def _is_valid_pair(qa: dict) -> bool:
    q, a = qa.get("question", ""), qa.get("answer", "")
    if not q or not a:
        return False
    if len(q) < 15 or len(a) < 40:
        return False
    if len(q) > 2000 or len(a) > 8000:
        return False
    # Skip refusals
    if re.match(r"^I (can't|cannot|won't|will not) (help|answer)", a, re.I) and len(a) < 200:
        return False
    return True


class QAGenerator:
    def __init__(self, resume: bool = False, dry_run: bool = False,
                 concurrency: int = SCRAPE_CONCURRENCY):
        self.resume      = resume
        self.dry_run     = dry_run
        self.concurrency = concurrency
        self.llm         = LLMClient()
        self.sem         = asyncio.Semaphore(concurrency)
        self.generated   = 0
        self.skipped     = 0
        self.failed      = 0

    async def _process_file(self, txt_path: Path) -> int:
        uhash   = txt_path.stem
        out_path = GEN_DIR / f"{uhash}.json"

        if self.resume and out_path.exists():
            self.skipped += 1
            return 0

        content = txt_path.read_text(encoding="utf-8", errors="replace")
        if count_words(content) < 100:
            self.skipped += 1
            return 0

        if self.dry_run:
            self.skipped += 1
            return 0

        # Load metadata for source info
        meta_path = txt_path.with_suffix(".meta.json")
        meta = {}
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text())
            except Exception:
                pass

        prompt = QA_PROMPT.format(content=content)

        try:
            async with self.sem:
                raw = await self.llm.generate(prompt)
        except LLMError:
            self.failed += 1
            return 0

        pairs = _parse_qa(raw)
        valid = [p for p in pairs if _is_valid_pair(p)]

        if not valid:
            self.failed += 1
            return 0

        result = {
            "source_url":  meta.get("url", ""),
            "category":    meta.get("category", "scraped"),
            "pairs":       valid,
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


async def run_generator(resume: bool = False, dry_run: bool = False) -> int:
    gen = QAGenerator(resume=resume, dry_run=dry_run)
    total = await gen.run()
    gen.print_stats()
    return total
