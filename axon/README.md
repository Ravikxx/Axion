# Axon

**CPU-optimized fine-tuning for 7B–12B language models.**  
*Built by [Axion Labs](https://github.com/ravikxx/axion)*

Most fine-tuning frameworks require expensive GPUs. Axon is designed to make fine-tuning small-to-medium language models practical on consumer hardware — laptops, workstations, and machines with no GPU at all.

---

## How it works

Axon detects your hardware and automatically configures:

| What | How |
|------|-----|
| **Memory** | 4-bit NF4 quantization (QLoRA) so an 8B model fits in ~5GB instead of 16GB |
| **Training** | LoRA adapters — only trains ~1% of parameters, rest stay frozen |
| **CPU** | Sets thread count to physical cores, not hyperthreads (hyperthreading hurts matmul) |
| **Progress** | Human-readable ETA based on rolling average (CPU steps take seconds, not ms) |
| **Safety** | RAM monitor warns before you hit the swap boundary |

The C++ core provides: AVX2-accelerated SIMD operations, an efficient thread pool, and hardware detection via CPUID.

---

## Requirements

- Python 3.9+
- 16GB+ RAM recommended (8GB minimum with small models)
- No GPU required

---

## Installation

```bash
# Install Python dependencies
cd axon
pip install -e .
```

The C++ extension builds automatically. If it fails (missing cmake or pybind11), Axon falls back to pure Python — everything still works, just without the C++ hardware detection.

---

## Usage

```python
from datasets import load_dataset
import axon

# Load your dataset
dataset = load_dataset("json", data_files="my_data.jsonl", split="train")

# Create trainer — hardware is auto-detected
trainer = axon.AxonTrainer(
    model="meta-llama/Llama-3.2-8B",
    train_dataset=dataset,
    formatting_func=lambda ex: (
        f"### Instruction: {ex['instruction']}\n"
        f"### Response: {ex['response']}"
    ),
    params_b=8.0,   # 8 billion parameters
)

trainer.train()
trainer.save_model("./my_finetuned_model")
```

**On startup, Axon prints:**
```
=== Axon Hardware Profile ===
CPU:     AMD Ryzen 7 5825U with Radeon Graphics
Cores:   8 physical / 16 logical
RAM:     15.3 GB total, 12.1 GB available
Cache:   L1d=32KB  L2=512KB  L3=16384KB
SIMD:    AVX2=True  FMA=True  AVX-512=False
GPU:     No discrete GPU (CPU-only mode)

Memory plan:
  Quantization : 4-bit
  LoRA rank    : 16  (alpha=32)
  Sequence len : 512 tokens
  Batch size   : 1 (× 8 grad accum = 8 effective)
  Grad ckpt    : True

  Est. model weights : 4.7 GB
  Est. LoRA adapters : 0.15 GB
  Est. optimizer     : 0.30 GB
  Est. activations   : 1.2 GB
  Est. total         : 8.9 GB / 12.1 GB available
  Headroom           : 3.2 GB
```

---

## Manual configuration

```python
config = axon.AxonConfig(
    model_name_or_path    = "meta-llama/Llama-3.2-8B",
    lora_r                = 32,
    lora_alpha            = 64,
    max_seq_length        = 1024,
    num_train_epochs      = 5,
    learning_rate         = 1e-4,
    gradient_accumulation_steps = 16,
)

trainer = axon.AxonTrainer(
    model="meta-llama/Llama-3.2-8B",
    train_dataset=dataset,
    config=config,
    formatting_func=my_format_fn,
)
```

---

## Expected training speed

On a Ryzen 7 5825U with 16GB RAM:

| Model | Seq len | Step time | Tokens/sec |
|-------|---------|-----------|-----------|
| 8B (4-bit LoRA) | 512 | ~45-90s | ~6-11 |
| 12B (4-bit LoRA) | 512 | ~70-140s | ~4-7 |

These are slow by GPU standards, but real fine-tuning on real hardware with no GPU.
A 1,000-step run takes roughly 12-24 hours.

---

## Architecture

```
axon/
├── include/axon/
│   ├── hardware.h       # CPUID detection declarations
│   ├── memory_ops.h     # AVX2 SIMD op declarations
│   └── thread_pool.h    # Thread pool declaration
├── src/
│   ├── hardware.cpp     # CPUID + /proc/cpuinfo + /proc/meminfo
│   ├── memory_ops.cpp   # AVX2 dot product, vadd, vscale, vfmadd
│   └── thread_pool.cpp  # Worker threads + task queue
├── bindings/
│   └── bindings.cpp     # pybind11 Python↔C++ bridge
└── python/axon/
    ├── __init__.py      # Public API
    ├── config.py        # AxonConfig dataclass
    ├── hardware.py      # Python hardware detection (C++ or fallback)
    ├── memory.py        # Memory planner (fits model into available RAM)
    ├── trainer.py       # AxonTrainer (HF Trainer wrapper)
    └── callbacks.py     # CPU progress + RAM monitor callbacks
```

---

## License

Apache 2.0 — Copyright © 2024 Max (Ravikxx) / Axion Labs
