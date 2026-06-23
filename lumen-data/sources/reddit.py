"""
Scrape Reddit subreddits for high-quality Q&A pairs.

Uses Reddit's public JSON API (no API key needed).
Converts: post title + body → top comment(s) as assistant turn.
"""

import time
import json
import re
import urllib.request
import urllib.error

HEADERS = {"User-Agent": "lumen-data-pipeline/1.0 (training dataset collector)"}

_BOILERPLATE = re.compile(
    r"(^i am a bot|this action was performed automatically|"
    r"please contact the moderators|rule \d|removed by moderator)",
    re.I,
)


def _fetch_json(url, retries=3):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=15) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            if e.code == 403:
                raise RuntimeError(
                    "Reddit API returned 403. Reddit requires OAuth since 2023.\n"
                    "  Option A: Set REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET env vars\n"
                    "            and run:  pip install praw\n"
                    "  Option B: Skip Reddit with --skip-reddit (HF datasets cover this)"
                ) from e
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)
        except Exception as e:
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)


def _top_comments(thread_data, n=3):
    """Extract top n non-bot comments from a thread JSON response."""
    try:
        comments_listing = thread_data[1]["data"]["children"]
    except (IndexError, KeyError):
        return []

    results = []
    for c in comments_listing:
        d = c.get("data", {})
        body = (d.get("body") or "").strip()
        score = d.get("score", 0)
        if not body or body in ("[deleted]", "[removed]"):
            continue
        if _BOILERPLATE.search(body):
            continue
        if score < 5:
            continue
        results.append((score, body))

    results.sort(reverse=True)
    return [body for _, body in results[:n]]


def scrape_sub(sub, sort="top", time_filter="year", limit=100,
               min_score=20, min_comments=3, verbose=True):
    """
    Scrape one subreddit.  Returns list of message-lists.
    """
    url = (f"https://www.reddit.com/r/{sub}/{sort}.json"
           f"?t={time_filter}&limit={limit}")

    if verbose:
        print(f"  [reddit] r/{sub} …", end=" ", flush=True)

    try:
        data = _fetch_json(url)
    except Exception as e:
        print(f"SKIP ({e})")
        return []

    posts = data.get("data", {}).get("children", [])
    results = []

    for post in posts:
        pd = post.get("data", {})
        score    = pd.get("score", 0)
        n_comms  = pd.get("num_comments", 0)
        title    = (pd.get("title") or "").strip()
        selftext = (pd.get("selftext") or "").strip()
        permalink = pd.get("permalink", "")
        is_self  = pd.get("is_self", False)

        if score < min_score or n_comms < min_comments:
            continue
        if not is_self:        # skip link posts — we want Q&A text
            continue
        if selftext in ("[deleted]", "[removed]", ""):
            # title-only questions are fine if title is descriptive
            if len(title) < 40:
                continue

        # Build user turn
        user_content = title
        if selftext:
            user_content = f"{title}\n\n{selftext}"

        # Fetch thread to get comments
        try:
            thread_url = f"https://www.reddit.com{permalink}.json?limit=20"
            thread_data = _fetch_json(thread_url)
            time.sleep(0.6)   # be polite
        except Exception:
            continue

        top = _top_comments(thread_data)
        if not top:
            continue

        # One example per top comment (the best 1-3)
        for comment in top[:2]:
            results.append([
                {"role": "user",      "content": user_content},
                {"role": "assistant", "content": comment},
            ])

    if verbose:
        print(f"{len(posts)} posts → {len(results)} examples")
    return results


def scrape_all(subs, sort, time_filter, limit, min_score, min_comments, verbose=True):
    all_results = []
    for sub in subs:
        try:
            all_results.extend(
                scrape_sub(sub, sort, time_filter, limit, min_score, min_comments, verbose)
            )
        except Exception as e:
            if verbose:
                print(f"  [reddit] r/{sub} failed: {e}")
    return all_results
