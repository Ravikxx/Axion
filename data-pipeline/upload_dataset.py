"""
Upload lumen13_sft.jsonl to HuggingFace Datasets.
Usage: set HF_TOKEN env var, then:
  python upload_dataset.py
"""
import os, json
from huggingface_hub import HfApi, create_repo

HF_TOKEN = os.environ.get("HF_TOKEN", "")
if not HF_TOKEN:
    print("ERROR: Set HF_TOKEN environment variable")
    print("  $env:HF_TOKEN = 'hf_...'")
    sys.exit(1)

JSONL_PATH = os.path.join(os.path.dirname(__file__), "data", "lumen13_sft.jsonl")
REPO_ID = "AxionLabsAI/lumen13-sft"

api = HfApi(token=HF_TOKEN)
create_repo(REPO_ID, repo_type="dataset", exist_ok=True, token=HF_TOKEN)
print(f"Repo {REPO_ID} ready")

api.upload_file(
    path_or_fileobj=JSONL_PATH,
    path_in_repo="lumen13_sft.jsonl",
    repo_id=REPO_ID,
    repo_type="dataset",
    token=HF_TOKEN,
)
print(f"Uploaded {JSONL_PATH} to https://huggingface.co/datasets/{REPO_ID}")
