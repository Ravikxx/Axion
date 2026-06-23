"""
Async web scraper with robots.txt compliance, per-domain rate limiting,
and dedicated handlers for Wikipedia, Stack Overflow, GitHub, Dev.to, arXiv.
"""

import asyncio
import json
import random
import re
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urljoin, urlparse
from urllib.robotparser import RobotFileParser

import httpx
from bs4 import BeautifulSoup
from tqdm.asyncio import tqdm

from config import (
    API_KEYS, DATA_DIR, RAW_DIR, SCRAPE_LOG, SCRAPE_CONCURRENCY,
    SCRAPE_DELAY_MIN, SCRAPE_DELAY_MAX, SCRAPE_TIMEOUT, get_scrape_targets,
    SCRAPE_TARGET_TOTAL, MIN_WORD_COUNT, MAX_CONTENT_CHARS, USER_AGENT,
    SEEN_HASHES, SEEN_URLS,
)
from utils import (
    DeduplicatorJSON, JsonlLogger, clean_text, count_words,
    extract_text, get_domain, hash_content, hash_url,
    normalize_url, truncate,
)


# ── Robots cache ──────────────────────────────────────────────────────────────

class RobotsCache:
    def __init__(self):
        self._cache: dict[str, RobotFileParser] = {}
        self._lock = asyncio.Lock()

    async def allowed(self, client: httpx.AsyncClient, url: str) -> bool:
        domain = get_domain(url)
        async with self._lock:
            if domain not in self._cache:
                rp = RobotFileParser()
                robots_url = f"{urlparse(url).scheme}://{domain}/robots.txt"
                try:
                    r = await client.get(robots_url, timeout=10)
                    rp.parse(r.text.splitlines())
                except Exception:
                    rp.allow_all = True
                self._cache[domain] = rp
            return self._cache[domain].can_fetch(USER_AGENT, url)


# ── Per-domain delay ──────────────────────────────────────────────────────────

class DomainThrottle:
    def __init__(self):
        self._last: dict[str, float] = {}
        self._lock = asyncio.Lock()

    async def wait(self, url: str):
        domain = get_domain(url)
        delay = random.uniform(SCRAPE_DELAY_MIN, SCRAPE_DELAY_MAX)
        async with self._lock:
            since = time.monotonic() - self._last.get(domain, 0)
            if since < delay:
                await asyncio.sleep(delay - since)
            self._last[domain] = time.monotonic()


# ── Scraper class ─────────────────────────────────────────────────────────────

class Scraper:
    def __init__(self, limit: int | None = None, resume: bool = False, benchmark_mode: bool = False):
        self.limit = limit or SCRAPE_TARGET_TOTAL
        self.resume = resume
        self.benchmark_mode = benchmark_mode
        self.targets = get_scrape_targets(benchmark_mode)
        self.sem = asyncio.Semaphore(SCRAPE_CONCURRENCY)
        self.robots = RobotsCache()
        self.throttle = DomainThrottle()
        self.url_dedup = DeduplicatorJSON(SEEN_URLS)
        self.hash_dedup = DeduplicatorJSON(SEEN_HASHES)
        self.logger = JsonlLogger(SCRAPE_LOG)
        self.saved = len(list(RAW_DIR.glob("*.txt"))) if resume else 0
        self.failed = 0
        self._pbar = None

    async def _headers(self, extra: dict = {}) -> dict:
        h = {"User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9"}
        h.update(extra)
        return h

    # ── Save a document ───────────────────────────────────────────────────────

    def _save(self, url: str, text: str, category: str) -> bool:
        uhash = hash_url(url)
        chash = hash_content(text)

        if self.resume and (RAW_DIR / f"{uhash}.txt").exists():
            return False
        if self.url_dedup.seen(uhash):
            return False
        if self.hash_dedup.seen(chash):
            return False

        path = RAW_DIR / f"{uhash}.txt"
        path.write_text(text, encoding="utf-8")
        meta_path = RAW_DIR / f"{uhash}.meta.json"
        meta_path.write_text(json.dumps({"url": url, "category": category, "hash": uhash}))

        self.url_dedup.add(uhash)
        self.hash_dedup.add(chash)
        self.saved += 1
        if self._pbar is not None:
            self._pbar.update(1)
        self.logger.log(event="saved", url=url, category=category, words=count_words(text))
        return True

    # ── Generic HTTP fetch + extract ──────────────────────────────────────────

    async def _fetch_page(self, client: httpx.AsyncClient, url: str, category: str) -> bool:
        url = normalize_url(url)
        if self.url_dedup.seen(hash_url(url)):
            return False
        if not await self.robots.allowed(client, url):
            return False
        await self.throttle.wait(url)
        try:
            async with self.sem:
                r = await client.get(url, timeout=SCRAPE_TIMEOUT,
                                     headers=await self._headers(),
                                     follow_redirects=True)
            if r.status_code != 200:
                self.failed += 1
                return False
            ct = r.headers.get("content-type", "")
            if "html" not in ct:
                return False
            text = extract_text(r.text, url)
            if count_words(text) < MIN_WORD_COUNT:
                return False
            text = truncate(text, MAX_CONTENT_CHARS)
            return self._save(url, text, category)
        except Exception as e:
            self.failed += 1
            self.logger.log(event="error", url=url, error=str(e))
            return False

    # ── Wikipedia API ─────────────────────────────────────────────────────────

    async def _scrape_wikipedia(self, client: httpx.AsyncClient, lang: str, count: int, category: str):
        api = f"https://{lang}.wikipedia.org/w/api.php"
        fetched = 0
        while fetched < count and self.saved < self.limit:
            try:
                async with self.sem:
                    r = await client.get(api, params={
                        "action": "query", "list": "random",
                        "rnnamespace": "0", "rnlimit": "50", "format": "json",
                    }, timeout=SCRAPE_TIMEOUT)
                pages = r.json().get("query", {}).get("random", [])
                titles = [p["title"] for p in pages]

                # Batch-fetch content
                async with self.sem:
                    r2 = await client.get(api, params={
                        "action": "query", "prop": "extracts",
                        "exintro": "0", "explaintext": "1",
                        "titles": "|".join(titles), "format": "json",
                    }, timeout=SCRAPE_TIMEOUT)
                pages_data = r2.json().get("query", {}).get("pages", {}).values()

                for page in pages_data:
                    if self.saved >= self.limit:
                        break
                    extract = page.get("extract", "")
                    if not extract or count_words(extract) < MIN_WORD_COUNT:
                        continue
                    title = page.get("title", "")
                    url = f"https://{lang}.wikipedia.org/wiki/{title.replace(' ', '_')}"
                    text = clean_text(extract)
                    text = truncate(text, MAX_CONTENT_CHARS)
                    if self._save(url, text, category):
                        fetched += 1

                await asyncio.sleep(random.uniform(0.5, 1.5))
            except Exception as e:
                self.logger.log(event="error", source="wikipedia", error=str(e))
                await asyncio.sleep(2)

    # ── Stack Overflow API ────────────────────────────────────────────────────

    async def _scrape_stackoverflow(self, client: httpx.AsyncClient, count: int, tags: list[str], category: str):
        api = "https://api.stackexchange.com/2.3/questions"
        page = 1
        fetched = 0
        while fetched < count and self.saved < self.limit:
            try:
                async with self.sem:
                    r = await client.get(api, params={
                        "order": "desc", "sort": "votes", "site": "stackoverflow",
                        "tagged": ";".join(tags[:3]),
                        "filter": "withbody", "pagesize": "100",
                        "page": page,
                    }, timeout=SCRAPE_TIMEOUT)
                data = r.json()
                items = data.get("items", [])
                if not items:
                    break

                for item in items:
                    if self.saved >= self.limit:
                        break
                    q = clean_text(BeautifulSoup(item.get("body", ""), "html.parser").get_text())
                    title = item.get("title", "")
                    url = item.get("link", "")
                    if not url or not q or count_words(q) < 50:
                        continue
                    text = f"{title}\n\n{q}"
                    text = truncate(text, MAX_CONTENT_CHARS)
                    if self._save(url, text, category):
                        fetched += 1

                page += 1
                await asyncio.sleep(random.uniform(1.0, 2.0))
            except Exception as e:
                self.logger.log(event="error", source="stackoverflow", error=str(e))
                await asyncio.sleep(3)

    # ── GitHub READMEs via API ────────────────────────────────────────────────

    async def _scrape_github(self, client: httpx.AsyncClient, count: int, category: str):
        topics = ["python", "javascript", "typescript", "rust", "go", "algorithms",
                  "machine-learning", "web-development", "data-structures", "cli-tool"]
        fetched = 0
        headers = {"Accept": "application/vnd.github+json"}
        if API_KEYS["github"]:
            headers["Authorization"] = f"Bearer {API_KEYS['github']}"

        for topic in topics:
            if fetched >= count or self.saved >= self.limit:
                break
            try:
                async with self.sem:
                    r = await client.get(
                        f"https://api.github.com/search/repositories",
                        params={"q": f"topic:{topic} stars:>200", "sort": "stars", "per_page": "50"},
                        headers={**await self._headers(), **headers},
                        timeout=SCRAPE_TIMEOUT,
                    )
                repos = r.json().get("items", [])
                for repo in repos:
                    if fetched >= count or self.saved >= self.limit:
                        break
                    full_name = repo.get("full_name", "")
                    if not full_name:
                        continue
                    try:
                        async with self.sem:
                            rr = await client.get(
                                f"https://api.github.com/repos/{full_name}/readme",
                                headers={**await self._headers(), **headers,
                                         "Accept": "application/vnd.github.raw"},
                                timeout=SCRAPE_TIMEOUT,
                            )
                        if rr.status_code != 200:
                            continue
                        # Strip markdown images/badges
                        text = re.sub(r"!\[.*?\]\(.*?\)", "", rr.text)
                        text = re.sub(r"\[.*?\]\(.*?\)", lambda m: m.group(0).split("]")[0].strip("[ "), text)
                        text = clean_text(text)
                        if count_words(text) < MIN_WORD_COUNT:
                            continue
                        url = f"https://github.com/{full_name}"
                        text = f"# {repo.get('name','')}\n{repo.get('description','')}\n\n{text}"
                        text = truncate(text, MAX_CONTENT_CHARS)
                        if self._save(url, text, category):
                            fetched += 1
                    except Exception:
                        pass
                    await asyncio.sleep(random.uniform(0.3, 0.8))
                await asyncio.sleep(1.0)
            except Exception as e:
                self.logger.log(event="error", source="github", error=str(e))
                await asyncio.sleep(3)

    # -- GitHub issues / bug reports --

    async def _scrape_github_issues(
        self,
        client: httpx.AsyncClient,
        count: int,
        queries: list[str],
        category: str,
    ):
        api = "https://api.github.com/search/issues"
        fetched = 0
        headers = {"Accept": "application/vnd.github+json"}
        if API_KEYS["github"]:
            headers["Authorization"] = f"Bearer {API_KEYS['github']}"

        for query in queries:
            if fetched >= count or self.saved >= self.limit:
                break
            page = 1
            while fetched < count and self.saved < self.limit and page <= 10:
                try:
                    async with self.sem:
                        r = await client.get(
                            api,
                            params={
                                "q": query,
                                "sort": "updated",
                                "order": "desc",
                                "per_page": "50",
                                "page": str(page),
                            },
                            headers={**await self._headers(), **headers},
                            timeout=SCRAPE_TIMEOUT,
                        )
                    data = r.json()
                    items = data.get("items", [])
                    if not items:
                        break

                    for item in items:
                        if fetched >= count or self.saved >= self.limit:
                            break
                        if item.get("pull_request"):
                            continue

                        title = item.get("title", "")
                        body = item.get("body", "")
                        url = item.get("html_url", "")
                        if not title or not body or not url:
                            continue

                        text = clean_text(f"{title}\n\n{BeautifulSoup(body, 'html.parser').get_text()}")
                        if count_words(text) < 80:
                            continue

                        text = truncate(text, MAX_CONTENT_CHARS)
                        if self._save(url, text, category):
                            fetched += 1

                    page += 1
                    await asyncio.sleep(random.uniform(0.8, 1.6))
                except Exception as e:
                    self.logger.log(event="error", source="github_issues", error=str(e))
                    await asyncio.sleep(3)

    # ── Dev.to API ────────────────────────────────────────────────────────────

    async def _scrape_devto(self, client: httpx.AsyncClient, count: int, category: str):
        fetched = 0
        page = 1
        while fetched < count and self.saved < self.limit:
            try:
                async with self.sem:
                    r = await client.get(
                        "https://dev.to/api/articles",
                        params={"per_page": "30", "page": str(page), "top": "365"},
                        timeout=SCRAPE_TIMEOUT,
                    )
                articles = r.json() if isinstance(r.json(), list) else []
                if not articles:
                    break
                for art in articles:
                    if fetched >= count or self.saved >= self.limit:
                        break
                    slug = art.get("slug", "")
                    username = art.get("user", {}).get("username", "")
                    if not slug or not username:
                        continue
                    try:
                        async with self.sem:
                            rr = await client.get(
                                f"https://dev.to/api/articles/{art['id']}",
                                timeout=SCRAPE_TIMEOUT,
                            )
                        body = rr.json().get("body_markdown", "")
                        text = clean_text(body)
                        if count_words(text) < MIN_WORD_COUNT:
                            continue
                        url = art.get("url", f"https://dev.to/{username}/{slug}")
                        text = truncate(text, MAX_CONTENT_CHARS)
                        if self._save(url, text, category):
                            fetched += 1
                    except Exception:
                        pass
                    await asyncio.sleep(random.uniform(0.2, 0.6))
                page += 1
                await asyncio.sleep(1.0)
            except Exception as e:
                self.logger.log(event="error", source="devto", error=str(e))
                await asyncio.sleep(3)

    # ── arXiv abstracts ───────────────────────────────────────────────────────

    async def _scrape_arxiv(self, client: httpx.AsyncClient, count: int, categories: list[str], category: str):
        fetched = 0
        start = 0
        cat_query = "+OR+".join(f"cat:{c}" for c in categories)
        while fetched < count and self.saved < self.limit:
            try:
                async with self.sem:
                    r = await client.get(
                        "http://export.arxiv.org/api/query",
                        params={
                            "search_query": cat_query,
                            "start": start,
                            "max_results": 100,
                            "sortBy": "submittedDate",
                            "sortOrder": "descending",
                        },
                        timeout=SCRAPE_TIMEOUT,
                    )
                ns = {"atom": "http://www.w3.org/2005/Atom"}
                root = ET.fromstring(r.text)
                entries = root.findall("atom:entry", ns)
                if not entries:
                    break
                for entry in entries:
                    if fetched >= count or self.saved >= self.limit:
                        break
                    title   = (entry.findtext("atom:title", "", ns) or "").strip()
                    summary = (entry.findtext("atom:summary", "", ns) or "").strip()
                    url     = (entry.findtext("atom:id", "", ns) or "").strip()
                    if not title or not summary or not url:
                        continue
                    text = f"{title}\n\n{summary}"
                    text = clean_text(text)
                    if count_words(text) < 80:
                        continue
                    if self._save(url, text, category):
                        fetched += 1
                start += 100
                await asyncio.sleep(3.0)  # arXiv asks for 3s between requests
            except Exception as e:
                self.logger.log(event="error", source="arxiv", error=str(e))
                await asyncio.sleep(5)

    # ── Generic crawl ─────────────────────────────────────────────────────────

    async def _crawl(self, client: httpx.AsyncClient, seeds: list[str], count: int,
                     domain: str, category: str):
        queue = list(seeds)
        visited: set[str] = set()
        fetched = 0

        while queue and fetched < count and self.saved < self.limit:
            url = queue.pop(0)
            url = normalize_url(url)
            if url in visited or hash_url(url) in self.url_dedup._data:
                continue
            visited.add(url)

            # Stay on same domain
            if domain and domain not in get_domain(url):
                continue

            try:
                async with self.sem:
                    await asyncio.sleep(random.uniform(SCRAPE_DELAY_MIN, SCRAPE_DELAY_MAX))
                    r = await client.get(url, timeout=SCRAPE_TIMEOUT,
                                         headers=await self._headers(),
                                         follow_redirects=True)
                if r.status_code != 200:
                    continue
                if "html" not in r.headers.get("content-type", ""):
                    continue

                # Extract and save
                text = extract_text(r.text, url)
                if count_words(text) >= MIN_WORD_COUNT:
                    text = truncate(text, MAX_CONTENT_CHARS)
                    if self._save(url, text, category):
                        fetched += 1

                # Collect links
                soup = BeautifulSoup(r.text, "html.parser")
                for a in soup.find_all("a", href=True):
                    href = urljoin(url, a["href"])
                    href = normalize_url(href)
                    if domain and domain not in get_domain(href):
                        continue
                    if href not in visited:
                        queue.append(href)
            except Exception as e:
                self.failed += 1
                self.logger.log(event="error", url=url, error=str(e))

    # ── URL list ──────────────────────────────────────────────────────────────

    async def _scrape_url_list(self, client: httpx.AsyncClient, urls: list[str],
                                count: int, category: str):
        fetched = 0
        for url in urls:
            if fetched >= count or self.saved >= self.limit:
                break
            if await self._fetch_page(client, url, category):
                fetched += 1
            # Also try to find sub-pages by crawling one level
            try:
                r = await client.get(url, timeout=SCRAPE_TIMEOUT,
                                     headers=await self._headers(),
                                     follow_redirects=True)
                soup = BeautifulSoup(r.text, "html.parser")
                domain = get_domain(url)
                links = []
                for a in soup.find_all("a", href=True):
                    href = normalize_url(urljoin(url, a["href"]))
                    if domain in get_domain(href) and href not in links:
                        links.append(href)
                for link in links[:50]:
                    if fetched >= count or self.saved >= self.limit:
                        break
                    if await self._fetch_page(client, link, category):
                        fetched += 1
            except Exception:
                pass

    # ── Main entry ────────────────────────────────────────────────────────────

    async def run(self, pbar: tqdm):
        self._pbar = pbar
        async with httpx.AsyncClient(
            headers={"User-Agent": USER_AGENT},
            http2=True,
            follow_redirects=True,
        ) as client:
            for (category, stype, opts) in self.targets:
                if self.saved >= self.limit:
                    break

                if stype == "api_wikipedia":
                    await self._scrape_wikipedia(
                        client, opts["lang"], opts["count"], category)

                elif stype == "api_stackoverflow":
                    await self._scrape_stackoverflow(
                        client, opts["count"], opts.get("tags", []), category)

                elif stype == "api_github":
                    await self._scrape_github(client, opts["count"], category)

                elif stype == "api_github_issues":
                    await self._scrape_github_issues(
                        client, opts["count"], opts.get("queries", []), category)

                elif stype == "api_devto":
                    await self._scrape_devto(client, opts["count"], category)

                elif stype == "api_arxiv":
                    await self._scrape_arxiv(
                        client, opts["count"], opts.get("categories", []), category)

                elif stype == "crawl":
                    await self._crawl(
                        client, opts["seeds"], opts["count"],
                        opts.get("domain", ""), category)

                elif stype == "url_list":
                    await self._scrape_url_list(
                        client, opts["urls"], opts["count"], category)

        self.url_dedup.save()
        self.hash_dedup.save()
        self.logger.close()


async def run_scraper(
    limit: int | None = None,
    resume: bool = False,
    benchmark_mode: bool = False,
) -> int:
    scraper = Scraper(limit=limit, resume=resume, benchmark_mode=benchmark_mode)
    with tqdm(total=scraper.limit, desc="Scraping", unit="page", initial=scraper.saved) as pbar:
        await scraper.run(pbar)
    print(f"\n  Saved: {scraper.saved}  |  Failed: {scraper.failed}")
    return scraper.saved
