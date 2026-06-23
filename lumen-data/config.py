"""Central config for the Lumen 1.3 SFT data pipeline."""

# ── HuggingFace datasets ───────────────────────────────────────────────────────
# Each entry: (hf_path, split, sample_n or None for all, format_hint)
HF_DATASETS = [
    # Coding + general instruction following — very high quality
    ("teknium/OpenHermes-2.5",                    "train", 40_000, "openhermes"),
    # Python-focused code instructions
    ("iamtarun/python_code_instructions_18k_alpaca", "train", None, "alpaca"),
    # Code alpaca — general coding
    ("HuggingFaceH4/CodeAlpaca_20K",              "train", None, "alpaca"),
    # Multi-turn conversations
    ("Aeala/ShareGPT_Vicuna_unfiltered",          "train", 10_000, "sharegpt"),
    # SWE-bench: real GitHub issues → patches
    ("princeton-nlp/SWE-bench_Lite",              "test",  None,   "swebench"),
    ("princeton-nlp/SWE-bench",                   "test",  2_000,  "swebench"),
    # Reddit-derived (ELI5 — Explain Like I'm 5, long-form Q&A from Reddit)
    # Substitute for direct Reddit scraping (Reddit API requires OAuth since 2023)
    ("eli5",                                      "train_eli5", 15_000, "eli5"),
    ("eli5",                                      "train_asks", 10_000, "eli5"),
]

# ── Reddit subreddits ──────────────────────────────────────────────────────────
REDDIT_SUBS = [
    "learnprogramming",
    "learnpython",
    "javascript",
    "webdev",
    "cscareerquestions",
    "programming",
    "Python",
    "rust",
]
REDDIT_SORT     = "top"          # top posts = highest signal
REDDIT_TIME     = "year"         # last year
REDDIT_LIMIT    = 100            # posts per sub
REDDIT_MIN_SCORE = 20            # skip low-upvote posts
REDDIT_MIN_COMMENTS = 3          # need actual discussion

# ── Documentation sites ────────────────────────────────────────────────────────
DOC_SITES = [
    {
        "name": "python",
        "base": "https://docs.python.org/3/",
        "index": "https://docs.python.org/3/genindex-all.html",
        "max_pages": 200,
    },
    {
        "name": "mdn_js",
        "base": "https://developer.mozilla.org/en-US/docs/Web/JavaScript/",
        "index": "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference",
        "max_pages": 150,
    },
    {
        "name": "react",
        "base": "https://react.dev/",
        "index": "https://react.dev/reference/react",
        "max_pages": 80,
    },
    {
        "name": "nodejs",
        "base": "https://nodejs.org/en/docs/",
        "index": "https://nodejs.org/api/",
        "max_pages": 100,
    },
]

# ── Output ────────────────────────────────────────────────────────────────────
OUTPUT_DIR    = "data"
OUTPUT_FILE   = "lumen13_sft.jsonl"
DEDUP_THRESH  = 0.85    # MinHash Jaccard threshold for near-duplicate removal

# ── Quality filters ───────────────────────────────────────────────────────────
MIN_USER_LEN    = 15    # chars — skip trivially short prompts
MIN_ASST_LEN    = 30    # chars
MAX_USER_LEN    = 4000  # chars
MAX_ASST_LEN    = 8000  # chars
REFUSE_PATTERNS = [     # skip "I cannot / As an AI" boilerplate
    "as an ai language model",
    "i cannot assist with",
    "i'm just an ai",
    "i am not able to",
]
