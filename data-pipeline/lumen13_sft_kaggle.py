"""
Lumen 1.3 - SFT fine-tune of Qwen3-8B on Kaggle P100 (16GB VRAM)
==================================================================
Copy-paste cells into a Kaggle notebook with GPU P100.

Steps:
1. Upload lumen13_sft.jsonl as a Kaggle Dataset or use direct HF load
2. Run cell-by-cell
3. GGUF will be uploaded to AxionLabsAI/Lumen/Lumen1-3.gguf
"""

# -------------------------------------------------------------------------------
# CELL 1: Install dependencies
# -------------------------------------------------------------------------------

# %% [code]
import subprocess, sys, os

def install(pkg):
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", pkg])

install("unsloth")
install("unsloth[colab-new] @ git+https://github.com/unslothai/unsloth.git")
install("xformers trl peft accelerate bitsandbytes")
install("huggingface_hub[hf-transfer]")
install("datasets")

# For GGUF conversion - install llama.cpp from source
# Commented out by default; run if you need to build llama.cpp
# !git clone https://github.com/ggerganov/llama.cpp /tmp/llama.cpp
# !cd /tmp/llama.cpp && make -j4
# install("sentencepiece protobuf")


# -------------------------------------------------------------------------------
# CELL 2: Imports
# -------------------------------------------------------------------------------

# %% [code]
import torch
import json
import os
import gc
from datasets import Dataset
from unsloth import FastLanguageModel, is_bfloat16_supported
from unsloth import UnslothTrainer, UnslothTrainingArguments
from transformers import TrainingArguments
from huggingface_hub import notebook_login

# Kaggle secrets / env vars
HF_TOKEN = os.environ.get("HF_TOKEN", "")  # Set in Kaggle Secrets
HF_USER = "AxionLabsAI"
MODEL_NAME = "Qwen/Qwen3-8B"

# Data loading: try Kaggle dataset first, then HF dataset, then direct URL
KAGGLE_PATH = "/kaggle/input/lumen13-sft/lumen13_sft.jsonl"
HF_DATASET  = "AxionLabsAI/lumen13-sft"  # Upload lumen13_sft.jsonl here
DIRECT_URL  = "https://huggingface.co/datasets/AxionLabsAI/lumen13-sft/resolve/main/lumen13_sft.jsonl"

OUTPUT_DIR = "/kaggle/working/lumen13_sft"


# -------------------------------------------------------------------------------
# CELL 3: Load model with QLoRA
# -------------------------------------------------------------------------------

# %% [code]
max_seq_length = 2048
dtype = None  # Auto-detect
load_in_4bit = True

model, tokenizer = FastLanguageModel.from_pretrained(
    model_name=MODEL_NAME,
    max_seq_length=max_seq_length,
    dtype=dtype,
    load_in_4bit=load_in_4bit,
    token=HF_TOKEN if HF_TOKEN else None,
)

# LoRA configuration
model = FastLanguageModel.get_peft_model(
    model,
    r=32,                     # LoRA rank
    lora_alpha=32,            # Scaling
    target_modules=[
        "q_proj", "k_proj", "v_proj", "o_proj",
        "gate_proj", "up_proj", "down_proj",
    ],
    lora_dropout=0,           # 0 is optimal for LoRA
    bias="none",
    use_gradient_checkpointing="unsloth",
    random_state=42,
    use_rslora=False,
    loftq_config=None,
)

print(f"Trainable params: {model.num_parameters(only_trainable=True):,}")


# -------------------------------------------------------------------------------
# CELL 4: Load dataset
# -------------------------------------------------------------------------------

# %% [code]
def load_jsonl(path, max_samples=None):
    messages = []
    with open(path, "r", encoding="utf-8") as f:
        for i, line in enumerate(f):
            if max_samples and i >= max_samples:
                break
            if line.strip():
                messages.append(json.loads(line))
    return messages

# Try data sources in order: Kaggle input > HF dataset > direct URL
if os.path.exists(KAGGLE_PATH):
    raw = load_jsonl(KAGGLE_PATH)
    print(f"Loaded {len(raw):,} examples from Kaggle input ({KAGGLE_PATH})")
else:
    print(f"Kaggle input not found at {KAGGLE_PATH}, trying HuggingFace dataset...")
    try:
        ds = load_dataset(HF_DATASET, split="train", trust_remote_code=True)
        raw = [row for row in ds]
        print(f"Loaded {len(raw):,} examples from HF dataset ({HF_DATASET})")
    except Exception as e:
        print(f"HF dataset load failed ({e}), trying direct URL...")
        import requests
        resp = requests.get(DIRECT_URL)
        resp.raise_for_status()
        raw = [json.loads(line) for line in resp.iter_lines(decode_unicode=True) if line]
        print(f"Loaded {len(raw):,} examples from URL ({DIRECT_URL})")

dataset = Dataset.from_list(raw)

# Split into train/eval
split = dataset.train_test_split(test_size=0.01, seed=42)
train_dataset = split["train"]
eval_dataset  = split["test"]

print(f"Train: {len(train_dataset):,}  |  Eval: {len(eval_dataset):,}")


# -------------------------------------------------------------------------------
# CELL 5: Training
# -------------------------------------------------------------------------------

# %% [code]
train_args = UnslothTrainingArguments(
    output_dir=OUTPUT_DIR,
    per_device_train_batch_size=4,
    per_device_eval_batch_size=4,
    gradient_accumulation_steps=4,
    num_train_epochs=1,
    learning_rate=2e-4,
    lr_scheduler_type="cosine",
    warmup_ratio=0.03,
    logging_steps=10,
    eval_steps=200,
    save_steps=500,
    save_total_limit=2,
    eval_strategy="steps",
    optim="adamw_8bit",
    weight_decay=0.01,
    max_grad_norm=0.3,
    fp16=not is_bfloat16_supported(),
    bf16=is_bfloat16_supported(),
    max_seq_length=max_seq_length,
    packing=False,              # Use for higher throughput, but may degrade quality
    report_to="none",
    push_to_hub=False,
    remove_unused_columns=False,
    dataloader_num_workers=2,
)

trainer = UnslothTrainer(
    model=model,
    args=train_args,
    train_dataset=train_dataset,
    eval_dataset=eval_dataset,
    tokenizer=tokenizer,
    dataset_text_field="messages",  # Unsloth handles chat template auto-formatting
    max_seq_length=max_seq_length,
)

print("Starting training...")
trainer.train()
print("Training complete!")


# -------------------------------------------------------------------------------
# CELL 6: Save LoRA adapter
# -------------------------------------------------------------------------------

# %% [code]
adapter_path = os.path.join(OUTPUT_DIR, "lora_adapter")
model.save_pretrained(adapter_path)
tokenizer.save_pretrained(adapter_path)
print(f"LoRA adapter saved to {adapter_path}")


# -------------------------------------------------------------------------------
# CELL 7: Merge + save full model (for GGUF conversion)
# -------------------------------------------------------------------------------

# %% [code]
merge_path = os.path.join(OUTPUT_DIR, "merged_model")
model.save_pretrained_merged(
    merge_path,
    tokenizer,
    save_method="merged_16bit",  # Save as float16 for GGUF conversion
)
print(f"Merged model saved to {merge_path}")


# -------------------------------------------------------------------------------
# CELL 8: Convert to GGUF Q4_K_M using llama.cpp
# -------------------------------------------------------------------------------

# %% [code]
# Prerequisite: llama.cpp needs to be built (see CELL 1)
# This cell runs the convert_hf_to_gguf.py + quantize steps

gguf_dir = "/kaggle/working/gguf"
os.makedirs(gguf_dir, exist_ok=True)
gguf_fp16_path = os.path.join(gguf_dir, "lumen13-fp16.gguf")
gguf_q4km_path = os.path.join(gguf_dir, "lumen13-q4_k_m.gguf")
gguf_q4km_final = "Lumen1-3.gguf"

# Step A: Convert HuggingFace format -> FP16 GGUF
subprocess.check_call([
    sys.executable, "/tmp/llama.cpp/convert_hf_to_gguf.py",
    merge_path,
    "--outfile", gguf_fp16_path,
    "--outtype", "f16",
])

# Step B: Quantize FP16 -> Q4_K_M
subprocess.check_call([
    "/tmp/llama.cpp/quantize",
    gguf_fp16_path,
    gguf_q4km_path,
    "Q4_K_M",
])

print(f"GGUF Q4_K_M created: {gguf_q4km_path}")
file_size_gb = os.path.getsize(gguf_q4km_path) / 1024**3
print(f"Size: {file_size_gb:.2f} GB")


# -------------------------------------------------------------------------------
# CELL 9: Upload to HuggingFace
# -------------------------------------------------------------------------------

# %% [code]
from huggingface_hub import HfApi, create_repo

if HF_TOKEN:
    api = HfApi(token=HF_TOKEN)

    # Create repo if needed
    repo_id = f"{HF_USER}/Lumen"
    try:
        create_repo(repo_id, repo_type="model", exist_ok=True, token=HF_TOKEN)
        print(f"Repo {repo_id} ready")
    except Exception as e:
        print(f"Repo create warning: {e}")

    # Upload GGUF - note the `Lumen1-3.gguf` filename in the repo
    api.upload_file(
        path_or_fileobj=gguf_q4km_path,
        path_in_repo=gguf_q4km_final,
        repo_id=repo_id,
        token=HF_TOKEN,
    )
    print(f"Uploaded to https://huggingface.co/{repo_id}/blob/main/{gguf_q4km_final}")

    # Also upload the merged model as a backup (24GB+)
    print("Uploading merged model (this may take a while)...")
    api.upload_folder(
        folder_path=merge_path,
        repo_id=repo_id,
        token=HF_TOKEN,
    )
    print(f"Merged model uploaded to {repo_id}")
else:
    print("No HF_TOKEN set. Skipping upload.")
    print(f"GGUF is available at {gguf_q4km_path}")


# -------------------------------------------------------------------------------
# CELL 10: Cleanup
# -------------------------------------------------------------------------------

# %% [code]
# Free VRAM
del model, trainer
gc.collect()
torch.cuda.empty_cache()

print("\nOK Lumen 1.3 SFT complete!")

# Show final stats
import os
merge_size = sum(os.path.getsize(os.path.join(dp, f)) for dp, dn, fn in os.walk(merge_path) for f in fn) / 1024**3
gguf_size  = os.path.getsize(gguf_q4km_path) / 1024**3
print(f"  Merged model:    {merge_size:.1f} GB")
print(f"  GGUF Q4_K_M:     {gguf_size:.2f} GB")
print(f"  Output:          https://huggingface.co/{HF_USER}/Lumen")
