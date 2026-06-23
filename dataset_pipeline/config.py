"""Central configuration for the dataset pipeline."""

import os
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass


# Paths

BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
RAW_DIR = DATA_DIR / "raw"
GEN_DIR = DATA_DIR / "generated"
FINAL_FILE = DATA_DIR / "final_dataset.jsonl"
SCRAPE_LOG = DATA_DIR / "scrape_log.jsonl"
LLM_LOG = DATA_DIR / "llm_log.jsonl"
SEEN_URLS = DATA_DIR / "seen_urls.json"
SEEN_HASHES = DATA_DIR / "seen_hashes.json"

for d in (RAW_DIR, GEN_DIR):
    d.mkdir(parents=True, exist_ok=True)


# Runtime mode

PIPELINE_MODE = os.getenv("AXION_DATASET_MODE", "standard").strip().lower()
BENCHMARK_MODE = PIPELINE_MODE in {"benchmark", "code", "swe", "swebench"}


# API keys

API_KEYS = {
    "zai": os.getenv("ZAI_API_KEY", ""),
    "groq": os.getenv("GROQ_API_KEY", ""),
    "mistral": os.getenv("MISTRAL_API_KEY", ""),
    "github": os.getenv("GITHUB_TOKEN", ""),
}


# LLM config

LLM_PROVIDERS = [
    {
        "name": "zai",
        "base_url": "https://api.z.ai/api/paas/v4",
        "key": API_KEYS["zai"],
        "model": "glm-4-flash",
    },
    {
        "name": "groq",
        "base_url": "https://api.groq.com/openai/v1",
        "key": API_KEYS["groq"],
        "model": "llama-3.1-8b-instant",
    },
    {
        "name": "mistral",
        "base_url": "https://api.mistral.ai/v1",
        "key": API_KEYS["mistral"],
        "model": "mistral-small-latest",
    },
]

LLM_MAX_RETRIES = 2
LLM_BACKOFF_BASE = 2
LLM_TIMEOUT = 60
LLM_MAX_TOKENS = 2048


# Scraper config

SCRAPE_CONCURRENCY = 10
SCRAPE_DELAY_MIN = 0.5
SCRAPE_DELAY_MAX = 2.5
SCRAPE_TIMEOUT = 20
MIN_WORD_COUNT = 200
MAX_CONTENT_CHARS = 8000

USER_AGENT = (
    "Mozilla/5.0 (compatible; LumenDataBot/1.0; "
    "+https://axion.amplifiedsmp.org/bot)"
)


# Scrape targets

# Each entry: (category, type, value)
# type = "api_wikipedia" | "api_stackoverflow" | "api_github" |
#        "api_github_issues" | "api_devto" | "api_arxiv" | "url_list" | "crawl"
SCRAPE_TARGETS = [
    ("wikipedia", "api_wikipedia", {"lang": "en", "count": 3000}),
    ("wikipedia_simple", "api_wikipedia", {"lang": "simple", "count": 500}),
    (
        "stackoverflow",
        "api_stackoverflow",
        {
            "count": 2000,
            "tags": ["python", "javascript", "typescript", "rust", "go", "algorithms", "system-design"],
        },
    ),
    ("github", "api_github", {"count": 800}),
    ("devto", "api_devto", {"count": 400}),
    (
        "arxiv",
        "api_arxiv",
        {"count": 400, "categories": ["cs.AI", "cs.LG", "cs.PL", "cs.SE", "math.CO"]},
    ),
    (
        "mdn",
        "crawl",
        {
            "seeds": [
                "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide",
                "https://developer.mozilla.org/en-US/docs/Web/API",
                "https://developer.mozilla.org/en-US/docs/Web/CSS",
                "https://developer.mozilla.org/en-US/docs/Learn",
            ],
            "count": 300,
            "domain": "developer.mozilla.org",
        },
    ),
    (
        "geeksforgeeks",
        "url_list",
        {
            "urls": [
                "https://www.geeksforgeeks.org/python-programming-language/",
                "https://www.geeksforgeeks.org/data-structures/",
                "https://www.geeksforgeeks.org/fundamentals-of-algorithms/",
                "https://www.geeksforgeeks.org/system-design-tutorial/",
                "https://www.geeksforgeeks.org/javascript/",
            ],
            "count": 400,
        },
    ),
    (
        "wikihow",
        "crawl",
        {
            "seeds": ["https://www.wikihow.com/Special:Randomizer"],
            "count": 400,
            "domain": "www.wikihow.com",
        },
    ),
    (
        "howstuffworks",
        "crawl",
        {
            "seeds": [
                "https://computer.howstuffworks.com/",
                "https://science.howstuffworks.com/",
            ],
            "count": 200,
            "domain": "howstuffworks.com",
        },
    ),
    (
        "pauls_math",
        "crawl",
        {
            "seeds": ["https://tutorial.math.lamar.edu/"],
            "count": 200,
            "domain": "tutorial.math.lamar.edu",
        },
    ),
    (
        "mathworld",
        "crawl",
        {
            "seeds": ["https://mathworld.wolfram.com/"],
            "count": 200,
            "domain": "mathworld.wolfram.com",
        },
    ),
]

BENCHMARK_SCRAPE_TARGETS = [
    (
        "github_issues",
        "api_github_issues",
        {
            "count": 1500,
            "queries": [
                "is:issue is:open bug error exception traceback repo:python/cpython",
                "is:issue is:open bug regression test repo:django/django",
                "is:issue is:open bug fix repo:pallets/flask",
                "is:issue is:open bug failing test repo:psf/requests",
                "is:issue is:open bug crash repo:microsoft/vscode",
                "is:issue is:open bug repo:tiangolo/fastapi",
            ],
        },
    ),
    ("github", "api_github", {"count": 800}),
    (
        "stackoverflow",
        "api_stackoverflow",
        {
            "count": 2000,
            "tags": ["python", "javascript", "typescript", "rust", "go", "algorithms", "system-design"],
        },
    ),
    (
        "mdn",
        "crawl",
        {
            "seeds": [
                "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide",
                "https://developer.mozilla.org/en-US/docs/Web/API",
                "https://developer.mozilla.org/en-US/docs/Web/CSS",
                "https://developer.mozilla.org/en-US/docs/Learn",
            ],
            "count": 150,
            "domain": "developer.mozilla.org",
        },
    ),
    (
        "geeksforgeeks",
        "url_list",
        {
            "urls": [
                "https://www.geeksforgeeks.org/python-programming-language/",
                "https://www.geeksforgeeks.org/data-structures/",
                "https://www.geeksforgeeks.org/fundamentals-of-algorithms/",
                "https://www.geeksforgeeks.org/javascript/",
            ],
            "count": 150,
        },
    ),
    (
        "arxiv",
        "api_arxiv",
        {"count": 200, "categories": ["cs.SE", "cs.PL", "cs.AI"]},
    ),
    (
        "pauls_math",
        "crawl",
        {
            "seeds": ["https://tutorial.math.lamar.edu/"],
            "count": 300,
            "domain": "tutorial.math.lamar.edu",
        },
    ),
    (
        "mathworld",
        "crawl",
        {
            "seeds": ["https://mathworld.wolfram.com/"],
            "count": 300,
            "domain": "mathworld.wolfram.com",
        },
    ),
]

# Target total pages (CLI --limit overrides)
SCRAPE_TARGET_TOTAL = 10000


# External HuggingFace datasets

HF_DATASETS = [
    {
        "id": "teknium/OpenHermes-2.5",
        "split": "train",
        "source": "openhermes",
        "q_field": "conversations",
        "limit": 50000,
    },
    {
        "id": "yahma/alpaca-cleaned",
        "split": "train",
        "source": "alpaca",
        "q_field": "instruction",
        "a_field": "output",
        "limit": 50000,
    },
    {
        "id": "sahil2801/CodeAlpaca-20k",
        "split": "train",
        "source": "codealpaca",
        "q_field": "instruction",
        "a_field": "output",
        "limit": 20000,
    },
]

HF_DATASETS_BENCHMARK = [
    {
        "id": "openai/openai_humaneval",
        "split": "test",
        "source": "humaneval",
        "limit": 164,
    },
    {
        "id": "Muennighoff/mbpp",
        "config_name": "sanitized",
        "split": "test",
        "source": "mbpp",
        "q_field": "prompt",
        "a_field": "code",
        "limit": 427,
    },
    {
        "id": "openai/gsm8k",
        "split": "train",
        "source": "gsm8k",
        "q_field": "question",
        "a_field": "answer",
        "limit": 8000,
    },
    {
        "id": "EleutherAI/hendrycks_math",
        "split": "train",
        "source": "math",
        "q_field": "problem",
        "a_field": "solution",
        "limit": 8000,
    },
    {
        "id": "sahil2801/CodeAlpaca-20k",
        "split": "train",
        "source": "codealpaca",
        "q_field": "instruction",
        "a_field": "output",
        "limit": 15000,
    },
]


# Dedup config

FUZZY_THRESHOLD = 90
SHUFFLE_SEED = 42


# Benchmark quality signals

CODE_SIGNAL_KEYWORDS = [
    "bug",
    "fix",
    "patch",
    "test",
    "failing test",
    "regression",
    "error",
    "exception",
    "traceback",
    "stack trace",
    "crash",
    "reproduce",
    "refactor",
    "function",
    "class",
    "module",
    "file",
    "import",
    "package",
    "dependency",
    "build",
    "lint",
    "ci",
    "debug",
    "issue",
    "pull request",
]

BENCHMARK_TASK_TYPES = {"bugfix", "debugging", "test", "patch", "refactor", "implementation"}
BENCHMARK_MIN_SIGNAL_SCORE = 4
BENCHMARK_MIN_ANSWER_SCORE = 3


def get_scrape_targets(benchmark_mode: bool = False):
    return BENCHMARK_SCRAPE_TARGETS if benchmark_mode else SCRAPE_TARGETS


def get_hf_datasets(benchmark_mode: bool = False):
    return HF_DATASETS_BENCHMARK if benchmark_mode else HF_DATASETS
