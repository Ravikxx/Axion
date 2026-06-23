"""Pull and normalise HuggingFace datasets into chat-message format."""

import random
from datasets import load_dataset

# ── Normalise each format to List[{"role":..., "content":...}] ────────────────

def _alpaca(row):
    """instruction + optional input → output  (also handles prompt/completion)"""
    # Some datasets use prompt/completion instead of instruction/output
    if "prompt" in row and "completion" in row:
        return [
            {"role": "user",      "content": row["prompt"].strip()},
            {"role": "assistant", "content": row["completion"].strip()},
        ]
    inp  = (row.get("input") or "").strip()
    user = (row.get("instruction") or "").strip()
    if not user:
        return None
    if inp:
        user = f"{user}\n\n{inp}"
    return [
        {"role": "user",      "content": user},
        {"role": "assistant", "content": (row.get("output") or "").strip()},
    ]


def _openhermes(row):
    """conversations list with 'from'/'value' keys"""
    convs = row.get("conversations", [])
    msgs = []
    for c in convs:
        role = "user" if c["from"] in ("human", "user") else "assistant"
        msgs.append({"role": role, "content": c["value"].strip()})
    # drop if it doesn't start with user
    if not msgs or msgs[0]["role"] != "user":
        return None
    return msgs


def _sharegpt(row):
    """conversations list with 'from'/'value' keys (same shape as openhermes)"""
    return _openhermes(row)


def _swebench(row):
    """
    Convert a SWE-bench instance to a coding SFT example.
    User:      repo + problem statement (GitHub issue)
    Assistant: the gold patch (unified diff)
    """
    patch = (row.get("patch") or "").strip()
    if not patch:
        return None
    problem = (row.get("problem_statement") or "").strip()
    repo    = (row.get("repo") or "unknown/repo").strip()
    hint    = (row.get("hints_text") or "").strip()

    user_parts = [
        f"Repository: {repo}",
        "",
        "Issue:",
        problem,
    ]
    if hint:
        user_parts += ["", "Hints:", hint]
    user_parts += ["", "Write a unified diff patch that fixes this issue:"]

    return [
        {"role": "user",      "content": "\n".join(user_parts)},
        {"role": "assistant", "content": patch},
    ]


def _eli5(row):
    """ELI5 / AskReddit / AskScience — title + top answer"""
    question = (row.get("title") or "").strip()
    answers  = row.get("answers", {})
    texts    = answers.get("text", []) if isinstance(answers, dict) else []
    scores   = answers.get("score", []) if isinstance(answers, dict) else []
    if not question or not texts:
        return None
    # Pick highest-scored answer
    if scores:
        best_idx = max(range(len(scores)), key=lambda i: scores[i])
        answer = texts[best_idx].strip()
    else:
        answer = texts[0].strip()
    if len(answer) < 40:
        return None
    return [
        {"role": "user",      "content": question},
        {"role": "assistant", "content": answer},
    ]


_FORMATTERS = {
    "alpaca":     _alpaca,
    "openhermes": _openhermes,
    "sharegpt":   _sharegpt,
    "swebench":   _swebench,
    "eli5":       _eli5,
}


def pull(hf_path, split, sample_n, fmt, verbose=True):
    """
    Download dataset, apply formatter, return list of message-lists.
    Returns [] on failure.
    """
    if verbose:
        print(f"  [hf] loading {hf_path} ({split}) …", end=" ", flush=True)
    try:
        ds = load_dataset(hf_path, split=split, trust_remote_code=True)
    except Exception as e:
        print(f"SKIP ({e})")
        return []

    if verbose:
        print(f"{len(ds)} rows", flush=True)

    # Optional sampling
    if sample_n and len(ds) > sample_n:
        indices = random.sample(range(len(ds)), sample_n)
        ds = ds.select(indices)

    formatter = _FORMATTERS[fmt]
    results = []
    for row in ds:
        try:
            msgs = formatter(row)
            if msgs:
                results.append(msgs)
        except Exception:
            pass

    if verbose:
        print(f"         → {len(results)} examples after formatting")
    return results
