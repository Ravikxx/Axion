"""Shared helpers: hashing, text cleaning, dedup, logging."""

import hashlib
import json
import re
import time
from pathlib import Path
from urllib.parse import urlparse, urlunparse

from bs4 import BeautifulSoup


# ── Hashing ───────────────────────────────────────────────────────────────────

def hash_url(url: str) -> str:
    return hashlib.sha256(normalize_url(url).encode()).hexdigest()[:32]


def hash_content(text: str) -> str:
    return hashlib.sha256(text.strip().lower().encode()).hexdigest()[:32]


# ── URL normalization ─────────────────────────────────────────────────────────

def normalize_url(url: str) -> str:
    parsed = urlparse(url)
    # Drop fragment, lowercase scheme+host, strip trailing slash from path
    return urlunparse((
        parsed.scheme.lower(),
        parsed.netloc.lower(),
        parsed.path.rstrip("/") or "/",
        "",
        parsed.query,
        "",
    ))


def get_domain(url: str) -> str:
    return urlparse(url).netloc.lower()


# ── HTML content extraction ───────────────────────────────────────────────────

_NOISE_TAGS = {"script", "style", "nav", "header", "footer", "aside",
               "form", "button", "iframe", "noscript", "svg", "figure",
               "figcaption", "advertisement", "menu"}

_NOISE_CLASSES = re.compile(
    r"(nav|menu|sidebar|footer|header|ad[-_]?|advertisement|cookie|"
    r"popup|banner|social|share|comment|related|recommend|newsletter|"
    r"subscribe|breadcrumb)", re.I
)

_MAIN_SELECTORS = [
    "article", "main", '[role="main"]', ".post-content", ".article-body",
    ".entry-content", ".content", "#content", "#main", ".mw-parser-output",
    ".post-body", ".article-content", ".page-content", ".markdown-body",
]


def extract_text(html: str, url: str = "") -> str:
    """Extract main readable text from raw HTML."""
    soup = BeautifulSoup(html, "html.parser")

    # Remove noise tags
    for tag in soup.find_all(_NOISE_TAGS):
        tag.decompose()

    # Remove elements with noisy class/id names
    for tag in soup.find_all(True):
        cls = " ".join(tag.get("class", []))
        eid = tag.get("id", "")
        if _NOISE_CLASSES.search(cls) or _NOISE_CLASSES.search(eid):
            tag.decompose()

    # Try to find main content container
    content = None
    for sel in _MAIN_SELECTORS:
        content = soup.select_one(sel)
        if content:
            break
    if not content:
        content = soup.body or soup

    text = content.get_text(separator="\n", strip=True)
    return clean_text(text)


def clean_text(text: str) -> str:
    """Normalize whitespace and remove junk lines."""
    lines = []
    for line in text.splitlines():
        line = line.strip()
        # Skip very short or purely symbolic lines
        if len(line) < 4:
            continue
        if re.match(r"^[\W\d]+$", line):
            continue
        lines.append(line)
    # Collapse 3+ blank lines into 2
    result = re.sub(r"\n{3,}", "\n\n", "\n".join(lines))
    return result.strip()


def count_words(text: str) -> int:
    return len(text.split())


def truncate(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    # Try to cut at a paragraph boundary
    cut = text.rfind("\n\n", 0, max_chars)
    if cut < max_chars * 0.7:
        cut = max_chars
    return text[:cut].strip() + "\n\n[truncated]"


# ── Dedup state ───────────────────────────────────────────────────────────────

class DeduplicatorJSON:
    """Persist a set of strings to JSON for cross-run dedup."""

    def __init__(self, path: Path):
        self.path = path
        self._data: set[str] = set()
        if path.exists():
            try:
                self._data = set(json.loads(path.read_text()))
            except Exception:
                pass

    def seen(self, key: str) -> bool:
        return key in self._data

    def add(self, key: str):
        self._data.add(key)

    def save(self):
        self.path.write_text(json.dumps(sorted(self._data)))

    def __len__(self):
        return len(self._data)


# ── Structured logging ────────────────────────────────────────────────────────

class JsonlLogger:
    def __init__(self, path: Path):
        self.path = path
        self._fh = open(path, "a", encoding="utf-8")

    def log(self, **kwargs):
        kwargs.setdefault("ts", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
        self._fh.write(json.dumps(kwargs) + "\n")
        self._fh.flush()

    def close(self):
        self._fh.close()


# ── Misc ──────────────────────────────────────────────────────────────────────

def estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)
