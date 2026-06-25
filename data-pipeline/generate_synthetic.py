"""
Synthetic SFT data generator using Mistral (primary) + z.ai + Groq (fallbacks).

Generates batches of instruction-response pairs, writes JSONL.
Usage:
    python generate_synthetic.py                           # full run
    python generate_synthetic.py --category code --count 5000
    python generate_synthetic.py --resume
"""
import json, os, sys, time, hashlib, argparse, random, threading, re

sys.path.insert(0, os.path.dirname(__file__))
import config

CACHE_DIR = os.path.join(config.CACHE_DIR, "synthetic")
os.makedirs(CACHE_DIR, exist_ok=True)

BATCH_SIZE = 10

# ── API clients ────────────────────────────────────────────────────────────────

def _make_client(api_key, base_url):
    try:
        from openai import OpenAI
    except ImportError:
        print("ERROR: openai package not installed. Run: pip install openai")
        sys.exit(1)
    return OpenAI(api_key=api_key, base_url=base_url)

_make_mistral_client = lambda: _make_client(config.MISTRAL_API_KEY, config.MISTRAL_BASE_URL)
_make_zai_client     = lambda: _make_client(config.ZAI_API_KEY, config.ZAI_BASE_URL)
_make_groq_client    = lambda: _make_client(config.GROQ_API_KEY, config.GROQ_BASE_URL)


# ── System prompt ──────────────────────────────────────────────────────────────

LUMEN_SYSTEM = """You are Lumen, an AI assistant made by Axion Labs. You're helpful, direct, and honest.

- Answer questions clearly and concisely. Don't over-explain.
- If you don't know something, say so - don't guess and present it as fact.
- You're an AI. Don't claim to be human or deny being an AI if asked.
- For code, use proper formatting and include brief explanations when helpful.
- Be direct. Skip filler phrases like "Certainly!" or "Great question!".
- Refuse requests that would harm people, violate privacy, or involve illegal activity."""


# ── Prompt templates (batch: 5 pairs per call) ─────────────────────────────────

PROMPTS = {
    "code": """Generate {n} realistic instruction-response pairs for training a coding assistant.

Topic: {topic}

Rules:
- Each instruction should be a specific, practical coding question or task.
- Each response should be detailed, correct, and include code examples.
- Vary difficulty (some easy practical, some advanced).
- Responses in Lumen's style: clear, direct, helpful. No "Certainly!" or "Great question!".
- Output ONLY a valid JSON array: [{{"instruction": "...", "response": "..."}}, ...]""",

    "math": """Generate {n} instruction-response pairs for training a math reasoning assistant.

Topic: {topic}

Rules:
- Each instruction should be a specific math problem or concept question.
- Each response should include step-by-step reasoning and the final answer.
- Vary difficulty - some basic, some advanced, some word problems.
- Responses in Lumen's style: clear, direct, educational. Show your work.
- Output ONLY a valid JSON array: [{{"instruction": "...", "response": "..."}}, ...]""",

    "general": """Generate {n} instruction-response pairs for training a helpful AI assistant.

Topic: {topic}

Rules:
- Each instruction should be a practical question a developer or student would ask.
- Each response should be accurate, well-structured, and informative.
- Avoid topics involving harm, privacy violations, or illegal activity.
- Responses in Lumen's style: clear, direct, no fluff.
- Output ONLY a valid JSON array: [{{"instruction": "...", "response": "..."}}, ...]""",
}


# ── Helpers ────────────────────────────────────────────────────────────────────

def _safe_print(msg):
    """Print with only ASCII-safe characters (no Windows cp1252 crashes)."""
    safe = msg.encode("ascii", errors="replace").decode("ascii")
    print(safe, flush=True)

def _make_example(instruction, response, category, topic, model_name):
    return {
        "messages": [
            {"role": "user", "content": instruction},
            {"role": "assistant", "content": response},
        ],
        "meta": {"category": category, "topic": topic, "model": model_name},
    }

def _is_good_pair(instruction, response):
    if len(instruction) < config.MIN_USER_LEN or len(response) < config.MIN_ASST_LEN:
        return False
    if len(response) > config.MAX_ASST_LEN * 1.5:
        return False
    return True

def _dedup_key(ex):
    text = "".join(m["content"] for m in ex["messages"]).lower().strip()
    return hashlib.md5(text.encode()).hexdigest()


# ── API call with retry ────────────────────────────────────────────────────────

def _call_with_retry(client, model_name, messages, max_retries=5):
    for attempt in range(max_retries):
        try:
            temperature = round(0.7 + random.random() * 0.3, 2)
            resp = client.chat.completions.create(
                model=model_name,
                messages=messages,
                max_tokens=2048,
                temperature=temperature,
            )
            return resp.choices[0].message.content.strip()
        except Exception as e:
            err_str = str(e)
            is_rate = "429" in err_str or "rate limit" in err_str.lower() or "1305" in err_str or "overloaded" in err_str.lower()
            if is_rate and attempt < max_retries - 1:
                wait = (2 ** attempt) + random.random()
                _safe_print(f"[synth] rate limited on {model_name}, retry {attempt+1}/{max_retries} in {wait:.0f}s")
                time.sleep(wait)
            else:
                _safe_print(f"[synth] API error ({model_name}): {err_str[:100]}")
                return None
    return None


# ── Parse response ─────────────────────────────────────────────────────────────

def _parse_json_response(text):
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1]
        text = text.rsplit("```", 1)[0]
    text = text.strip()
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            return [data]
        if isinstance(data, list):
            return data
        return []
    except json.JSONDecodeError:
        m = re.search(r'\[.*\]', text, re.DOTALL)
        if m:
            try:
                return json.loads(m.group(0))
            except json.JSONDecodeError:
                pass
        return []


# ── Batch generation ───────────────────────────────────────────────────────────

def generate_batch(clients, topics_pool, category):
    topic = random.choice(topics_pool)
    prompt = PROMPTS[category].format(n=BATCH_SIZE, topic=topic)
    messages = [
        {"role": "system", "content": LUMEN_SYSTEM},
        {"role": "user", "content": prompt},
    ]

    for client, model_name in clients:
        text = _call_with_retry(client, model_name, messages)
        if text is None:
            continue
        parsed = _parse_json_response(text)
        if not parsed:
            continue
        examples = []
        for pair in parsed:
            instruction = (pair.get("instruction") or "").strip()
            response    = (pair.get("response") or "").strip()
            if _is_good_pair(instruction, response):
                examples.append(_make_example(instruction, response, category, topic, model_name))
        if examples:
            return examples
    return []


# ── Generator ──────────────────────────────────────────────────────────────────

class SynthGenerator:
    def __init__(self, category, count, resume=False):
        self.category  = category
        self.target    = count
        self.generated = 0
        self.attempts  = 0
        self.good      = 0
        self.errors    = 0
        self.seen_hashes = set()
        self.start_time  = time.time()

        self.topics = {
            "code": config.SYNTH_CODE_TOPICS,
            "math": config.SYNTH_MATH_TOPICS,
            "general": config.SYNTH_GENERAL_TOPICS,
        }[category]

        self.out_file = os.path.join(CACHE_DIR, f"synthetic_{category}.jsonl")
        self.cp_file  = os.path.join(CACHE_DIR, f"checkpoint_{category}.json")

        if resume:
            self._load_checkpoint()

        self.out_fh = open(self.out_file, "a" if resume else "w", encoding="utf-8")

    def _load_checkpoint(self):
        if os.path.exists(self.cp_file):
            try:
                with open(self.cp_file, encoding="utf-8") as f:
                    cp = json.load(f)
                self.generated  = cp.get("generated", 0)
                self.seen_hashes = set(cp.get("hashes", []))
                _safe_print(f"[synth] resuming {self.category}: {self.generated} already done")
            except Exception:
                pass

    def _save_checkpoint(self):
        with open(self.cp_file, "w", encoding="utf-8") as f:
            json.dump({
                "generated": self.generated,
                "hashes": list(self.seen_hashes),
                "category": self.category,
                "saved_at": time.time(),
            }, f)

    def _progress(self):
        elapsed = time.time() - self.start_time
        rate = self.generated / elapsed * 60 if elapsed > 0 else 0
        pct = (self.generated / self.target) * 100 if self.target > 0 else 0
        bar_len = 25
        filled  = int(pct * bar_len / 100)
        bar     = "#" * filled + "-" * (bar_len - filled)
        dupes   = self.attempts - self.good - self.errors
        eta = ""
        if rate > 0:
            rem = (self.target - self.generated) / rate
            eta = f"ETA {int(rem//60)}m {int(rem%60)}s"
        sys.stdout.write(
            f"\r  [{bar}] {pct:5.1f}% "
            f"{self.generated}/{self.target} "
            f"| {rate:.1f}/min "
            f"| {eta} "
            f"| dup {max(0,dupes)} "
            f"| err {self.errors} "
            f"| {self.category}   "
        )
        sys.stdout.flush()

    def run(self):
        _safe_print(f"\n[synth] generating {self.category} - target {self.target}")

        clients = [
            (_make_mistral_client(), config.MISTRAL_MODEL),
            (_make_zai_client(), config.ZAI_MODEL),
            (_make_zai_client(), config.ZAI_FALLBACK_MODEL),
            (_make_groq_client(), config.GROQ_MODEL),
        ]

        lock = threading.Lock()
        stop = False

        def worker():
            nonlocal stop
            fails = 0
            while not stop:
                examples = generate_batch(clients, self.topics, self.category)
                with lock:
                    self.attempts += 1
                    if not examples:
                        self.errors += 1
                        fails += 1
                        self._progress()
                        time.sleep(min(10, 2 ** fails))  # backoff on failures
                        continue
                    fails = 0
                    self.good += 1
                    for ex in examples:
                        if self.generated >= self.target or stop:
                            break
                        key = _dedup_key(ex)
                        if key in self.seen_hashes:
                            continue
                        self.seen_hashes.add(key)
                        self.out_fh.write(json.dumps(ex, ensure_ascii=False) + "\n")
                        self.generated += 1
                    self._progress()
                    if self.generated % config.SYNTH_CHECKPOINT_EVERY == 0:
                        self.out_fh.flush()
                        self._save_checkpoint()
                    if self.generated >= self.target:
                        stop = True
                    time.sleep(1)  # minimum gap between batches

        threads = [threading.Thread(target=worker) for _ in range(config.SYNTH_MAX_WORKERS)]
        for t in threads:
            t.start()

        try:
            while self.generated < self.target:
                time.sleep(3)
                with lock:
                    if self.generated == 0 and self.errors >= config.SYNTH_MAX_WORKERS * 3:
                        _safe_print("\n[synth] all API keys failing - check your keys and network")
                        stop = True
                        break
                    self._progress()
        except KeyboardInterrupt:
            _safe_print("\n[synth] interrupted")
            stop = True

        stop = True
        for t in threads:
            t.join(timeout=3)

        self.out_fh.close()
        self._save_checkpoint()
        _safe_print(f"\n[synth] {self.category} done - {self.generated} examples\n")

        examples = self._load_examples()
        return [ex["messages"] for ex in examples]

    def _load_examples(self):
        if not os.path.exists(self.out_file):
            return []
        with open(self.out_file, encoding="utf-8") as f:
            return [json.loads(l) for l in f if l.strip()]


# ── Main ───────────────────────────────────────────────────────────────────────

def run_all(resume=False):
    categories = {"code": config.TARGET_CODE, "math": config.TARGET_MATH, "general": config.TARGET_GENERAL}
    all_examples = []
    for cat, target in categories.items():
        gen = SynthGenerator(cat, target, resume=resume)
        examples = gen.run()
        all_examples.extend(examples)
    return all_examples


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--category", choices=["code", "math", "general"])
    ap.add_argument("--count", type=int)
    ap.add_argument("--resume", action="store_true")
    args = ap.parse_args()

    if args.category and args.count:
        gen = SynthGenerator(args.category, args.count, resume=args.resume)
        examples = gen.run()
    else:
        examples = run_all(resume=args.resume)

    _safe_print(f"\nSynthetic generation done - {len(examples)} total examples")
