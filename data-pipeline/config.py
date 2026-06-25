"""
Central config for Lumen 1.3 SFT data pipeline.

Sources: HuggingFace datasets only (SWE Bench heavy for coding).
"""
import os
import random

random.seed(42)

# ── HuggingFace datasets ───────────────────────────────────────────────────────
# Each entry: (hf_path, split, sample_n or None for all, format_hint)
HF_DATASETS = [
    # ── SWE Bench (heavy emphasis for better SWE Bench scores) ──
    ("princeton-nlp/SWE-bench_Lite",     "test",  None,   "swebench"),   # 300
    ("princeton-nlp/SWE-bench_Verified", "test",  None,   "swebench"),   # ~500
    ("princeton-nlp/SWE-bench",          "test",  3_000,  "swebench"),   # ~2300

    # ── General coding instruction ──
    ("teknium/OpenHermes-2.5",            "train", 25_000, "openhermes"),
    ("HuggingFaceH4/CodeAlpaca_20K",      "train", None,   "alpaca"),
    ("iamtarun/python_code_instructions_18k_alpaca", "train", None, "alpaca"),
    ("ise-uiuc/Magicoder-OSS-Instruct-75K", "train", 10_000, "magicoder"),

    # ── Math reasoning ──
    ("meta-math/MetaMathQA",              "train", 10_000, "metamath"),
    ("microsoft/orca-math-word-problems-200k", "train", 10_000, "metamath"),

    # ── General instruction following ──
    ("Aeala/ShareGPT_Vicuna_unfiltered",  "train", 10_000, "sharegpt"),
]

# ── Target totals ──────────────────────────────────────────────────────────────
TARGET_TOTAL = 80_000

# ── Quality filters ────────────────────────────────────────────────────────────
MIN_USER_LEN    = 15
MIN_ASST_LEN    = 30
MAX_USER_LEN    = 4000
MAX_ASST_LEN    = 8000
REFUSE_PATTERNS = [
    "as an ai language model",
    "i cannot assist with",
    "i'm just an ai",
    "i am not able to",
    "i'm sorry, but i",
    "i apologize, but i",
]
DEDUP_THRESH = 0.85

# ── Qwen 3 chat template ───────────────────────────────────────────────────────
QWEN_SYSTEM_PROMPT = "You are Lumen, an AI assistant made by Axion Labs. You're helpful, direct, and honest."

# ── Paths ──────────────────────────────────────────────────────────────────────
ROOT        = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR   = os.path.join(ROOT, "cache")
OUT_DIR     = os.path.join(ROOT, "data")
OUTPUT_FILE = os.path.join(OUT_DIR, "lumen13_sft.jsonl")

os.makedirs(CACHE_DIR, exist_ok=True)
os.makedirs(OUT_DIR, exist_ok=True)
