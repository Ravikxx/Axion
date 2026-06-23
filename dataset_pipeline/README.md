# Axion Dataset Pipeline

Scrapes the web, generates Q&A pairs via LLM, merges with HuggingFace datasets, deduplicates, and produces a clean JSONL training set for Lumen.

## Setup

```bash
cd dataset_pipeline
pip install -r requirements.txt
```

## Run

```bash
# Full pipeline
python main.py

# Resume after interruption
python main.py --resume

# Test config without making LLM calls
python main.py --dry-run

# Cap how many pages to scrape
python main.py --limit 1000

# Skip scraping, regenerate Q&A from existing raw files
python main.py --skip-scrape

# Skip scraping + generation, just re-merge and filter
python main.py --skip-scrape --skip-generate

# Run only the filter on an existing dataset
python main.py --skip-scrape --skip-generate --skip-merge

# Bias the pipeline toward SWE-bench-style coding tasks
python main.py --benchmark-mode
```

Benchmark mode starts from a clean slate unless you also pass `--resume`, so it will rebuild the dataset instead of appending to the previous one.

## Pipeline steps

| Step | Module | What it does |
|------|--------|--------------|
| 1 | `scraper.py` | Crawls Wikipedia, StackOverflow, GitHub, Dev.to, arXiv, MDN, GFG, WikiHow, and benchmark-focused GitHub issues |
| 2 | `generator.py` | Sends each raw `.txt` to the LLM fallback chain (Z.ai -> Groq -> Mistral), extracts Q&A pairs |
| 3+4 | `merger.py` | Loads scraped Q&A + HuggingFace datasets, fuzzy-deduplicates, shuffles, writes JSONL |
| 5 | `filter.py` | Quality filter: removes refusals, too-short pairs, truncated content, exact duplicates, and non-code tasks in benchmark mode |

## Output

`data/final_dataset.jsonl` - one JSON object per line:

```json
{"question": "...", "answer": "...", "source": "scraped_wikipedia"}
```

## LLM fallback chain

Z.ai (glm-4-flash) -> Groq (llama-3.1-8b-instant) -> Mistral (mistral-small-latest)

Each provider retries twice with exponential backoff before falling back to the next.

## Data directory layout

```text
data/
├── raw/              # .txt + .meta.json per scraped page
├── generated/        # .json per page (Q&A pairs from LLM)
├── final_dataset.jsonl
├── scrape_log.jsonl
└── llm_log.jsonl
```
