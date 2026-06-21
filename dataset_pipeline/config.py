"""Central configuration for the dataset pipeline."""

import os
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass

# ── Paths ─────────────────────────────────────────────────────────────────────

BASE_DIR   = Path(__file__).parent
DATA_DIR   = BASE_DIR / "data"
RAW_DIR    = DATA_DIR / "raw"
GEN_DIR    = DATA_DIR / "generated"
FINAL_FILE = DATA_DIR / "final_dataset.jsonl"
SCRAPE_LOG = DATA_DIR / "scrape_log.jsonl"
LLM_LOG    = DATA_DIR / "llm_log.jsonl"
SEEN_URLS  = DATA_DIR / "seen_urls.json"
SEEN_HASHES= DATA_DIR / "seen_hashes.json"

for d in (RAW_DIR, GEN_DIR):
    d.mkdir(parents=True, exist_ok=True)

# ── API Keys ──────────────────────────────────────────────────────────────────

API_KEYS = {
    "zai":     os.getenv("ZAI_API_KEY", ""),
    "groq":    os.getenv("GROQ_API_KEY", ""),
    "mistral": os.getenv("MISTRAL_API_KEY", ""),
    "github":  os.getenv("GITHUB_TOKEN", ""),
}

# ── LLM config ────────────────────────────────────────────────────────────────

LLM_PROVIDERS = [
    {
        "name":    "zai",
        "base_url":"https://api.z.ai/v1",
        "key":     API_KEYS["zai"],
        "model":   "glm-4-flash",
    },
    {
        "name":    "groq",
        "base_url":"https://api.groq.com/openai/v1",
        "key":     API_KEYS["groq"],
        "model":   "llama3-8b-8192",
    },
    {
        "name":    "mistral",
        "base_url":"https://api.mistral.ai/v1",
        "key":     API_KEYS["mistral"],
        "model":   "mistral-small-latest",
    },
]

LLM_MAX_RETRIES    = 2
LLM_BACKOFF_BASE   = 2   # seconds (doubled each retry)
LLM_TIMEOUT        = 60  # seconds per request
LLM_MAX_TOKENS     = 2048

# ── Scraper config ────────────────────────────────────────────────────────────

SCRAPE_CONCURRENCY  = 10
SCRAPE_DELAY_MIN    = 0.5   # seconds
SCRAPE_DELAY_MAX    = 2.5   # seconds
SCRAPE_TIMEOUT      = 20    # seconds
MIN_WORD_COUNT      = 200
MAX_CONTENT_CHARS   = 8000  # trim before sending to LLM

USER_AGENT = (
    "Mozilla/5.0 (compatible; LumenDataBot/1.0; "
    "+https://axion.amplifiedsmp.org/bot)"
)

# ── Scrape targets ────────────────────────────────────────────────────────────

# Each entry: (category, type, value)
# type = "api_wikipedia" | "api_stackoverflow" | "api_github" |
#        "api_devto" | "api_arxiv" | "url_list" | "crawl"
SCRAPE_TARGETS = [
    # ── Wikipedia (via API — random articles) ─────────────────────────────────
    ("wikipedia",        "api_wikipedia",     {"lang": "en",     "count": 3000}),
    ("wikipedia_simple", "api_wikipedia",     {"lang": "simple", "count": 500}),

    # ── Stack Overflow (via API) ───────────────────────────────────────────────
    ("stackoverflow",    "api_stackoverflow", {"count": 2000, "tags": ["python","javascript","typescript","rust","go","algorithms","system-design"]}),

    # ── GitHub READMEs (via API) ──────────────────────────────────────────────
    ("github",           "api_github",        {"count": 800}),

    # ── Dev.to (via API) ──────────────────────────────────────────────────────
    ("devto",            "api_devto",         {"count": 400}),

    # ── arXiv abstracts (via API) ─────────────────────────────────────────────
    ("arxiv",            "api_arxiv",         {"count": 400, "categories": ["cs.AI","cs.LG","cs.PL","cs.SE","math.CO"]}),

    # ── MDN Web Docs ──────────────────────────────────────────────────────────
    ("mdn",              "crawl", {
        "seeds": [
            "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide",
            "https://developer.mozilla.org/en-US/docs/Web/API",
            "https://developer.mozilla.org/en-US/docs/Web/CSS",
            "https://developer.mozilla.org/en-US/docs/Learn",
        ],
        "count": 300,
        "domain": "developer.mozilla.org",
    }),

    # ── GeeksforGeeks ────────────────────────────────────────────────────────
    ("geeksforgeeks",    "url_list", {
        "urls": [
            "https://www.geeksforgeeks.org/python-programming-language/",
            "https://www.geeksforgeeks.org/data-structures/",
            "https://www.geeksforgeeks.org/fundamentals-of-algorithms/",
            "https://www.geeksforgeeks.org/system-design-tutorial/",
            "https://www.geeksforgeeks.org/javascript/",
        ],
        "count": 400,
    }),

    # ── WikiHow ───────────────────────────────────────────────────────────────
    ("wikihow",          "crawl", {
        "seeds": ["https://www.wikihow.com/Special:Randomizer"],
        "count": 400,
        "domain": "www.wikihow.com",
    }),

    # ── HowStuffWorks ────────────────────────────────────────────────────────
    ("howstuffworks",    "crawl", {
        "seeds": [
            "https://computer.howstuffworks.com/",
            "https://science.howstuffworks.com/",
        ],
        "count": 200,
        "domain": "howstuffworks.com",
    }),

    # ── Paul's Online Math Notes ──────────────────────────────────────────────
    ("pauls_math",       "crawl", {
        "seeds": ["https://tutorial.math.lamar.edu/"],
        "count": 200,
        "domain": "tutorial.math.lamar.edu",
    }),

    # ── Wolfram MathWorld ─────────────────────────────────────────────────────
    ("mathworld",        "crawl", {
        "seeds": ["https://mathworld.wolfram.com/"],
        "count": 200,
        "domain": "mathworld.wolfram.com",
    }),
]

# Target total pages (CLI --limit overrides)
SCRAPE_TARGET_TOTAL = 10_000

# ── External HuggingFace datasets ────────────────────────────────────────────

HF_DATASETS = [
    {
        "id":     "teknium/OpenHermes-2.5",
        "split":  "train",
        "source": "openhermes",
        "q_field":"conversations",  # special handling
        "limit":  50_000,
    },
    {
        "id":     "yahma/alpaca-cleaned",
        "split":  "train",
        "source": "alpaca",
        "q_field":"instruction",
        "a_field":"output",
        "limit":  50_000,
    },
    {
        "id":     "sahil2801/CodeAlpaca-20k",
        "split":  "train",
        "source": "codealpaca",
        "q_field":"instruction",
        "a_field":"output",
        "limit":  20_000,
    },
]

# ── Dedup config ──────────────────────────────────────────────────────────────

FUZZY_THRESHOLD  = 90   # rapidfuzz similarity threshold (0-100)
SHUFFLE_SEED     = 42
