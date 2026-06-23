"""
Scrape documentation sites and convert pages to Q&A pairs.

Strategy per page:
  - Extract the main content (strip nav/header/footer)
  - Use section headings + body text to generate synthetic Q&A
  - Each section becomes: Q = "Explain {heading} in {doc_name}", A = section text
  - Also generates "How do I …" style pairs from example code blocks
"""

import re
import time
import urllib.request
import urllib.error
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse


# ── Minimal HTML text extractor ───────────────────────────────────────────────

class _TextExtractor(HTMLParser):
    SKIP_TAGS = {"script", "style", "nav", "header", "footer", "aside",
                 "form", "button", "input", "select", "textarea"}

    def __init__(self):
        super().__init__()
        self._skip = 0
        self._buf  = []
        self.sections = []   # list of (heading, body_text)
        self._cur_h  = None
        self._cur_body = []

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP_TAGS:
            self._skip += 1
        if tag in ("h1", "h2", "h3") and self._skip == 0:
            self._flush()
            self._cur_h = tag

    def handle_endtag(self, tag):
        if tag in self.SKIP_TAGS:
            self._skip = max(0, self._skip - 1)
        if tag in ("h1", "h2", "h3"):
            self._cur_h = None

    def handle_data(self, data):
        if self._skip:
            return
        text = data.strip()
        if not text:
            return
        if self._cur_h:
            self._flush_heading(text)
        else:
            self._cur_body.append(text)

    def _flush_heading(self, heading_text):
        self._flush()
        self.sections.append((heading_text, []))

    def _flush(self):
        if self.sections and self._cur_body:
            self.sections[-1] = (self.sections[-1][0],
                                 self.sections[-1][1] + self._cur_body)
        self._cur_body = []

    def finish(self):
        self._flush()
        return self.sections


_HEADERS = {"User-Agent": "lumen-data-pipeline/1.0 (training dataset collector)"}


def _fetch(url, timeout=15):
    req = urllib.request.Request(url, headers=_HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode(errors="replace")


def _extract_links(html, base_url, allowed_prefix):
    """Return same-domain links under allowed_prefix."""
    links = set()
    for m in re.finditer(r'href=["\']([^"\'#?]+)["\']', html):
        href = m.group(1)
        full = urljoin(base_url, href)
        if full.startswith(allowed_prefix):
            links.add(full)
    return links


def _page_to_pairs(html, doc_name):
    """Convert one HTML page to a list of (user, assistant) text pairs."""
    parser = _TextExtractor()
    parser.feed(html)
    sections = parser.finish()

    pairs = []
    for heading, body_parts in sections:
        body = " ".join(body_parts).strip()
        body = re.sub(r"\s+", " ", body)
        if len(heading) < 4 or len(body) < 80:
            continue

        # Q: explain this heading
        q = f"Explain {heading} in {doc_name}."
        pairs.append((q, body[:2000]))

        # Q: how do I use this? (for headings that look like functions/methods)
        if re.search(r"[A-Z][a-z]|[a-z]\.[a-z]|\(\)", heading):
            q2 = f"How do I use {heading}? Give an example."
            pairs.append((q2, body[:2000]))

    return pairs


def scrape_site(site_cfg, verbose=True):
    """
    Scrape one doc site config dict.  Returns list of message-lists.
    """
    name       = site_cfg["name"]
    base       = site_cfg["base"]
    index_url  = site_cfg["index"]
    max_pages  = site_cfg["max_pages"]

    if verbose:
        print(f"  [docs] {name} …", end=" ", flush=True)

    # Discover links from index page
    try:
        index_html = _fetch(index_url)
    except Exception as e:
        print(f"SKIP ({e})")
        return []

    urls = _extract_links(index_html, index_url, base)
    urls = list(urls)[:max_pages]

    results = []
    for url in urls:
        try:
            html  = _fetch(url)
            pairs = _page_to_pairs(html, name)
            for q, a in pairs:
                results.append([
                    {"role": "user",      "content": q},
                    {"role": "assistant", "content": a},
                ])
            time.sleep(0.3)
        except Exception:
            pass

    if verbose:
        print(f"{len(urls)} pages → {len(results)} examples")
    return results


def scrape_all(sites, verbose=True):
    all_results = []
    for site in sites:
        try:
            all_results.extend(scrape_site(site, verbose))
        except Exception as e:
            if verbose:
                print(f"  [docs] {site['name']} failed: {e}")
    return all_results
