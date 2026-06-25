"""
Documentation scraper - extracts content from Python, MDN, React, Node docs.

Output: JSONL lines with {"messages": [{"role":"user","content":...}, ...]}
Each doc page becomes one or more Q&A pairs (explain-X -> content).
"""
import json, os, sys, re, time
from urllib.request import Request, urlopen
from html.parser import HTMLParser

sys.path.insert(0, os.path.dirname(__file__))
import config

CACHE_FILE = os.path.join(config.CACHE_DIR, "docs.jsonl")


class TextExtractor(HTMLParser):
    """Strips HTML tags, keeps text."""
    def __init__(self):
        super().__init__()
        self.text_parts = []
        self.skip_tags = {"script", "style", "nav", "footer", "header"}
        self._skip_depth = 0
        self._in_pre = False

    def handle_starttag(self, tag, attrs):
        if tag in self.skip_tags:
            self._skip_depth += 1
        if tag == "pre":
            self._in_pre = True
            self.text_parts.append("\n```")

    def handle_endtag(self, tag):
        if tag in self.skip_tags:
            self._skip_depth -= 1
        if tag == "pre":
            self._in_pre = False
            self.text_parts.append("```\n")
        if tag in {"p", "li", "h1", "h2", "h3", "h4", "tr", "div"} and self._skip_depth == 0:
            self.text_parts.append("\n")

    def handle_data(self, data):
        if self._skip_depth == 0:
            self.text_parts.append(data)

    def get_text(self):
        text = "".join(self.text_parts)
        text = re.sub(r'\n{3,}', '\n\n', text)
        text = re.sub(r' +', ' ', text)
        text = re.sub(r'```\n+```', '```', text)
        return text.strip()


def _fetch_url(url):
    try:
        req = Request(url, headers={"User-Agent": "Axion-Lumen-1.3/1.0"})
        with urlopen(req, timeout=15, encoding="utf-8") as resp:
            return resp.read().decode("utf-8", errors="replace")
    except Exception as e:
        print(f"  [docs] fetch failed: {url} - {e}", flush=True)
        return None


def _extract_content(html, content_sel, title_sel):
    """Naive content extraction by looking for certain HTML patterns.
    
    Since we can't use BeautifulSoup without an external dep, we do
    string-based extraction of the <body> content, then use TextExtractor.
    """
    # Try to find the main content area by looking for common selectors
    # This is a rough heuristic - works for Python docs and similar
    extractor = TextExtractor()
    
    # For Python docs: content is in <div class="body">
    if content_sel == "div.body":
        m = re.search(r'<div\s+class=["\']body["\']>(.*?)</div>\s*</div>', html, re.DOTALL)
        if m:
            extractor.feed(m.group(1))
            return extractor.get_text()
    
    # For MDN: content is in <article class="main-page-content">
    if content_sel == "article.main-page-content":
        m = re.search(r'<article[^>]*class=["\'][^"\']*main-page-content[^"\']*["\'][^>]*>(.*?)</article>', html, re.DOTALL)
        if m:
            extractor.feed(m.group(1))
            return extractor.get_text()
    
    # For React: content in <article>
    if content_sel == "article":
        m = re.search(r'<article[^>]*>(.*?)</article>', html, re.DOTALL)
        if m:
            extractor.feed(m.group(1))
            return extractor.get_text()
    
    # For Node: content in <main>
    if content_sel == "main":
        m = re.search(r'<main[^>]*>(.*?)</main>', html, re.DOTALL)
        if m:
            extractor.feed(m.group(1))
            return extractor.get_text()
    
    # Fallback: extract body
    m = re.search(r'<body[^>]*>(.*?)</body>', html, re.DOTALL)
    if m:
        extractor.feed(m.group(1))
        return extractor.get_text()
    
    # Last resort
    extractor.feed(html)
    return extractor.get_text()


def _extract_title(html, title_sel="h1"):
    m = re.search(rf'<{title_sel}[^>]*>(.*?)</{title_sel}>', html, re.DOTALL)
    if m:
        return re.sub(r'<[^>]+>', '', m.group(1)).strip()
    m = re.search(r'<title[^>]*>(.*?)</title>', html, re.DOTALL)
    if m:
        return m.group(1).strip()
    return ""


def _extract_links(html, base_url):
    """Extract all href links from a page."""
    links = set()
    for m in re.finditer(r'href=["\']([^"\']+)["\']', html):
        link = m.group(1)
        if link.startswith("/"):
            # Relative to base
            from urllib.parse import urlparse, urljoin
            link = urljoin(base_url, link)
        elif link.startswith("#"):
            continue
        elif not link.startswith("http"):
            from urllib.parse import urljoin
            link = urljoin(base_url, link)
        # Only links from the same site
        if base_url.rstrip("/") in link:
            # Remove fragment
            link = link.split("#")[0]
            links.add(link)
    return sorted(links)


def _page_to_pairs(title, content, site_name, url):
    """Turn a doc page into Q&A pairs."""
    if len(content) < 100:
        return []

    # Split into sections by h2/h3
    sections = re.split(r'\n(?=[A-Z][a-z]+[\s\n])', content)
    
    pairs = []
    # Main pair: "Explain {title}"
    pairs.append({
        "messages": [
            {"role": "user", "content": f"Explain {title} from the {site_name} documentation."},
            {"role": "assistant", "content": content[:config.MAX_ASST_LEN]},
        ],
        "meta": {"source": f"docs_{site_name}", "url": url}
    })

    # Section-level pairs
    for section in sections[:5]:
        section = section.strip()
        if len(section) < 80:
            continue
        # Extract section title from first line
        section_title = section.split("\n")[0][:80]
        pairs.append({
            "messages": [
                {"role": "user", "content": f"Tell me about {section_title} ({site_name} docs)."},
                {"role": "assistant", "content": section[:config.MAX_ASST_LEN]},
            ],
            "meta": {"source": f"docs_{site_name}", "url": url}
        })

    return pairs


def scrape_all(force=False):
    """Scrape documentation sites and return message-lists."""
    if os.path.exists(CACHE_FILE) and not force:
        with open(CACHE_FILE, encoding="utf-8") as f:
            examples = [json.loads(l) for l in f if l.strip()]
        print(f"  [docs] loaded {len(examples)} from cache", flush=True)
        return [e["messages"] for e in examples]

    all_examples = []
    visited = set()

    for site in config.DOC_SITES:
        print(f"\n  [docs] scraping {site['name']}...", flush=True)
        index_html = _fetch_url(site["index"])
        if not index_html:
            print(f"  [docs] failed to fetch index for {site['name']}", flush=True)
            continue

        links = _extract_links(index_html, site["base"])
        # Filter to same-site internal links
        links = [l for l in links if site["base"].rstrip("/") in l]
        links = links[:site["max_pages"]]

        print(f"  [docs] found {len(links)} pages for {site['name']}", flush=True)

        for i, url in enumerate(links):
            if url in visited:
                continue
            visited.add(url)

            html = _fetch_url(url)
            if not html:
                continue

            title = _extract_title(html, site["title_sel"])
            content = _extract_content(html, site["content_sel"], site["title_sel"])
            pairs = _page_to_pairs(title, content, site["name"], url)
            all_examples.extend(pairs)

            if (i + 1) % 20 == 0:
                print(f"  [docs] {site['name']}: {i+1}/{len(links)} pages, {len(all_examples)} examples so far", flush=True)

            # Be nice to servers
            time.sleep(0.5)

    # Cache
    with open(CACHE_FILE, "w", encoding="utf-8") as f:
        for ex in all_examples:
            f.write(json.dumps(ex, ensure_ascii=False) + "\n")

    msgs_only = [ex["messages"] for ex in all_examples]
    print(f"  [docs] total examples: {len(msgs_only)}", flush=True)
    return msgs_only


if __name__ == "__main__":
    examples = scrape_all()
    print(f"\nDocs scrape done - {len(examples)} examples")
