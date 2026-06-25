"""Pull and normalise HuggingFace datasets into chat-message format."""

import random
from datasets import load_dataset

# ── Formatters ─────────────────────────────────────────────────────────────────

def _alpaca(row):
    """instruction + optional input -> output"""
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
    if not msgs or msgs[0]["role"] != "user":
        return None
    return msgs


def _sharegpt(row):
    return _openhermes(row)


def _swebench(row):
    """SWE-bench instance -> coding SFT example."""
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
    """ELI5 / AskReddit"""
    question = (row.get("title") or "").strip()
    answers  = row.get("answers", {})
    texts    = answers.get("text", []) if isinstance(answers, dict) else []
    scores   = answers.get("score", []) if isinstance(answers, dict) else []
    if not question or not texts:
        return None
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


def _commitpack(row):
    """bigcode/commitpackft: commit message + diff as instruction-response."""
    msg  = (row.get("message") or "").strip()
    diff = (row.get("diff") or "").strip()
    if not msg or not diff or len(diff) < 30:
        return None
    lang = (row.get("lang") or "unknown").strip()
    return [
        {"role": "user",      "content": f"In {lang}, {msg}\n\nShow the code changes (diff) that implement this."},
        {"role": "assistant", "content": diff},
    ]


def _magicoder(row):
    """Magicoder-OSS-Instruct: problem -> solution."""
    problem  = (row.get("problem") or "").strip()
    solution = (row.get("solution") or "").strip()
    if not problem or not solution:
        return None
    return [
        {"role": "user",      "content": problem},
        {"role": "assistant", "content": solution},
    ]


def _metamath(row):
    """MetaMathQA: query + response."""
    query    = (row.get("query") or row.get("question") or "").strip()
    response = (row.get("response") or row.get("answer") or "").strip()
    if not query or not response:
        return None
    return [
        {"role": "user",      "content": query},
        {"role": "assistant", "content": response},
    ]


_FORMATTERS = {
    "alpaca":     _alpaca,
    "openhermes": _openhermes,
    "sharegpt":   _sharegpt,
    "swebench":   _swebench,
    "eli5":       _eli5,
    "commitpack": _commitpack,
    "metamath":   _metamath,
    "magicoder":  _magicoder,
}


def pull(hf_path, split, sample_n, fmt, verbose=True):
    if verbose:
        print(f"  [hf] loading {hf_path} ({split}) ...", end=" ", flush=True)
    try:
        ds = load_dataset(hf_path, split=split, trust_remote_code=True)
    except Exception as e:
        print(f"SKIP ({e})", flush=True)
        return []

    if verbose:
        print(f"{len(ds)} rows", flush=True)

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
        print(f"         -> {len(results)} examples after formatting", flush=True)
    return results
