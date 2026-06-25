"""
GitHub scraper - issues + READMEs from top Python/JS/TS repos.

Output: JSONL lines with {"messages": [{"role":"user","content":...}, ...]}
"""
import json, os, sys, base64
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError

sys.path.insert(0, os.path.dirname(__file__))
import config

CACHE_FILE = os.path.join(config.CACHE_DIR, "github.jsonl")


def _api_get(path, accept="application/vnd.github.v3+json", raw=False, retries=3):
    url = f"https://api.github.com{path}"
    headers = {
        "Accept": accept,
        "User-Agent": "Axion-Lumen-1.3/1.0",
    }
    if config.GITHUB_TOKEN:
        headers["Authorization"] = f"Bearer {config.GITHUB_TOKEN}"

    for attempt in range(retries):
        try:
            req = Request(url, headers=headers)
            resp = urlopen(req, timeout=30)
            remaining = resp.headers.get("X-RateLimit-Remaining", "?")
            reset_at  = resp.headers.get("X-RateLimit-Reset", "0")
            data = resp.read()
            if raw:
                return data, int(remaining), int(reset_at)
            try:
                return json.loads(data), int(remaining), int(reset_at)
            except json.JSONDecodeError:
                return {}, int(remaining), int(reset_at)
        except (HTTPError, OSError, Exception) as e:
            if attempt < retries - 1:
                print(f"  [github] retry {path[:60]}... ({attempt+1}/{retries})", flush=True)
                time.sleep(2 ** attempt)
            else:
                raise e


def _rate_limit_wait(remaining, reset_at):
    if remaining < 2:
        wait = max(0, reset_at - time.time() + 5)
        if wait > 0:
            print(f"  [github] rate limited - waiting {wait:.0f}s...", flush=True)
            time.sleep(wait)


def _fetch_page(path, accept="application/vnd.github.v3+json"):
    data, remaining, reset_at = _api_get(path, accept)
    _rate_limit_wait(remaining, reset_at)
    return data


def _get_text_content(item):
    """Extract meaningful text from a GitHub issue/comment."""
    body = (item.get("body") or "").strip()
    # Remove markdown code fences for cleaner text while keeping code
    return body


def _is_good_issue(issue):
    if issue.get("pull_request"):
        return False
    if issue.get("state") != "closed":
        return False
    body = (issue.get("body") or "").strip()
    if len(body) < 30:
        return False
    return True


def _comments_to_pairs(issue, comments):
    """Convert an issue + its top comments into training pairs."""
    title   = issue.get("title", "")
    body    = issue.get("body", "") or ""
    pairs   = []
    user_q  = f"{title}\n\n{body}" if title else body
    # Truncate very long questions
    if len(user_q) > config.MAX_USER_LEN:
        user_q = user_q[:config.MAX_USER_LEN]

    if len(comments) > config.GITHUB_COMMENTS_TO_TAKE:
        comments = comments[:config.GITHUB_COMMENTS_TO_TAKE]

    for comment in comments:
        cbody = (comment.get("body") or "").strip()
        if len(cbody) < config.MIN_ASST_LEN:
            continue
        if len(cbody) > config.MAX_ASST_LEN:
            cbody = cbody[:config.MAX_ASST_LEN]
        pairs.append({
            "messages": [
                {"role": "user", "content": user_q},
                {"role": "assistant", "content": cbody},
            ],
            "meta": {
                "source": "github_issue",
                "repo": issue.get("repository_url", "").split("/repos/")[-1],
                "issue_url": issue.get("html_url", ""),
            }
        })
    return pairs


def _readme_to_pairs(readme, repo_full_name):
    """Split a README into chunks and make Q&A pairs about the tech."""
    content_b64 = readme.get("content", "")
    try:
        text = base64.b64decode(content_b64).decode("utf-8")
    except Exception:
        return []

    lines = text.split("\n")
    if len(lines) < 5:
        return []

    # Take first 200 lines max
    text = "\n".join(lines[:200])

    pairs = []
    # Make a "teach me about this project" pair
    pairs.append({
        "messages": [
            {"role": "user", "content": f"What does the {repo_full_name} project do? Explain its key features and how to use it."},
            {"role": "assistant", "content": text[:config.MAX_ASST_LEN]},
        ],
        "meta": {"source": "github_readme", "repo": repo_full_name}
    })

    # Find code blocks and make code-specific pairs
    in_code = False
    code_blocks = []
    current = []
    for line in lines[:300]:
        if line.startswith("```"):
            if in_code:
                code_blocks.append("\n".join(current))
                current = []
            in_code = not in_code
        elif in_code:
            current.append(line)

    for cb in code_blocks[:3]:
        if len(cb) < 20:
            continue
        lang = ""
        pairs.append({
            "messages": [
                {"role": "user", "content": f"Show me an example of {repo_full_name} usage with explanation."},
                {"role": "assistant", "content": f"Here's an example:\n```{lang}\n{cb[:3000]}\n```"},
            ],
            "meta": {"source": "github_readme_code", "repo": repo_full_name}
        })
    return pairs


def _search_repos(language, min_stars=10000, max_results=50):
    """Search for top-starred repos in a language."""
    q = f"language:{language}+stars:>{min_stars}"
    all_repos = []
    for page in range(1, 6):
        path = f"/search/repositories?q={q}&sort=stars&order=desc&per_page=100&page={page}"
        try:
            data = _fetch_page(path)
            repos = data.get("items", [])
            all_repos.extend(repos)
            if len(repos) < 100:
                break
        except HTTPError as e:
            print(f"  [github] search error: {e}", flush=True)
            break
    return all_repos[:max_results]


def _get_comments(repo_full, issue_num):
    """Get comments for an issue."""
    path = f"/repos/{repo_full}/issues/{issue_num}/comments?per_page=100&sort=created&direction=desc"
    try:
        return _fetch_page(path)
    except HTTPError:
        return []


def scrape_all(force=False):
    """Main entry - scrape GitHub and return list of message-lists."""
    if os.path.exists(CACHE_FILE) and not force:
        with open(CACHE_FILE, encoding="utf-8") as f:
            examples = [json.loads(l) for l in f if l.strip()]
        print(f"  [github] loaded {len(examples)} from cache", flush=True)
        return [e["messages"] for e in examples]

    all_examples = []

    for lang in config.GITHUB_LANGUAGES:
        print(f"\n  [github] searching top {lang} repos...", flush=True)
        repos = _search_repos(lang, config.GITHUB_MIN_STARS, config.GITHUB_MAX_REPOS)
        print(f"  [github] found {len(repos)} repos for {lang}", flush=True)

        for repo in repos:
            full_name = repo["full_name"]
            print(f"    -> {full_name}", flush=True)

            # Get README (as JSON with base64 content - _readme_to_pairs handles decoding)
            try:
                readme, _, _ = _api_get(f"/repos/{full_name}/readme")
                all_examples.extend(_readme_to_pairs(readme, full_name))
            except (HTTPError, json.JSONDecodeError):
                pass

            # Get issues
            path = f"/repos/{full_name}/issues?state=closed&sort=comments&direction=desc&per_page=100"
            try:
                issues = _fetch_page(path)
            except HTTPError:
                continue

            count = 0
            for issue in issues:
                if not _is_good_issue(issue):
                    continue
                comments = _get_comments(full_name, issue["number"])
                good_comments = [c for c in comments if len((c.get("body") or "").strip()) > config.MIN_ASST_LEN]
                if len(good_comments) < config.GITHUB_ISSUE_MIN_COMMENTS:
                    continue
                pairs = _comments_to_pairs(issue, good_comments)
                all_examples.extend(pairs)
                count += 1
                if count >= config.GITHUB_MAX_ISSUES_PER_REPO:
                    break

    # Dedup by issue URL
    seen_urls = set()
    unique = []
    for ex in all_examples:
        url = ex.get("meta", {}).get("issue_url", "")
        if url and url in seen_urls:
            continue
        if url:
            seen_urls.add(url)
        unique.append(ex)

    # Cache
    with open(CACHE_FILE, "w", encoding="utf-8") as f:
        for ex in unique:
            f.write(json.dumps(ex, ensure_ascii=False) + "\n")

    msgs_only = [ex["messages"] for ex in unique]
    print(f"  [github] total examples: {len(msgs_only)}", flush=True)
    return msgs_only


if __name__ == "__main__":
    examples = scrape_all()
    print(f"\nGitHub scrape done - {len(examples)} examples")
