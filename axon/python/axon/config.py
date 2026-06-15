"""
AxonConfig: all knobs for a training run in one place.

Most users should use AxonConfig.auto() and let the framework figure out
the right settings. The individual fields are documented for power users
who want to override specific values.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class AxonConfig:
    # ---- Required ----
    model_name_or_path: str = ""
    output_dir: str = "./axon_output"

    # ---- Quantization ----
    # NF4 (NormalFloat 4) is the quantization format from the QLoRA paper.
    # It represents weights more accurately than plain int4 by using a
    # non-uniform distribution that matches the typical weight distribution.
    load_in_4bit:              bool  = True
    bnb_4bit_quant_type:       str   = "nf4"
    bnb_4bit_compute_dtype:    str   = "bfloat16"  # bf16 math on 4-bit weights
    bnb_4bit_use_double_quant: bool  = True         # saves ~0.4 bits/param extra

    # ---- LoRA ----
    # LoRA (Low-Rank Adaptation) freezes the original model weights and adds
    # tiny trainable "adapter" matrices alongside each weight matrix.
    # Only the adapters are trained — ~1% of total parameters.
    #
    # r (rank): higher = more expressive adapters = more memory.
    # alpha: learning rate scale; alpha/r is the effective multiplier.
    # target_modules: which weight matrices to apply LoRA to.
    lora_r:              int            = 16
    lora_alpha:          int            = 32
    lora_dropout:        float          = 0.05
    lora_target_modules: Optional[List[str]] = None  # None = auto-detect
    lora_bias:           str            = "none"

    # ---- Training hyperparameters ----
    num_train_epochs:            int   = 3
    per_device_train_batch_size: int   = 1
    gradient_accumulation_steps: int   = 8
    learning_rate:               float = 2e-4
    weight_decay:                float = 0.001
    warmup_ratio:                float = 0.03
    lr_scheduler_type:           str   = "cosine"
    max_seq_length:              int   = 512

    # ---- CPU optimizations ----
    # gradient_checkpointing: recompute activations on backward pass instead of
    # storing them. Halves activation memory at the cost of ~30% slower training.
    gradient_checkpointing:   bool         = True
    num_cpu_threads:          Optional[int] = None  # None = auto (physical cores)
    dataloader_num_workers:   int           = 0     # 0 = main process; avoids multiprocessing overhead
    packing:                  bool          = False  # pack multiple short samples into one sequence
    use_torch_compile:        bool          = False  # PyTorch 2.0 compile (experimental on CPU)

    # ---- Precision ----
    # bf16 (bfloat16) is native on Zen 3 CPUs and gives ~2× memory savings
    # over float32 with minimal accuracy loss for training.
    bf16: bool = True
    fp16: bool = False  # fp16 is NOT recommended on CPU (no hardware support)

    # ---- Optimizer ----
    # adamw_torch is the standard Adam with weight decay.
    # For memory-critical situations, "paged_adamw_8bit" from bitsandbytes
    # offloads optimizer states to CPU pinned memory (use if OOMing).
    optim: str = "adamw_torch"

    # ---- Logging and saving ----
    logging_steps: int = 10
    save_steps:    int = 100
    save_total_limit: int = 2  # keep only last 2 checkpoints
    eval_steps:    Optional[int] = None

    @classmethod
    def auto(
        cls,
        model_name_or_path: str,
        params_b: float = 8.0,
        available_ram_gb: Optional[float] = None,
        **overrides,
    ) -> "AxonConfig":
        """
        Auto-configure based on model size and available RAM.

        params_b: model size in billions of parameters (e.g. 8.0 for an 8B model).
        available_ram_gb: if None, auto-detected from the system.
        **overrides: any AxonConfig field to override after auto-config.
        """
        if available_ram_gb is None:
            from .hardware import detect_hardware
            hw = detect_hardware()
            available_ram_gb = hw.avail_ram_gb

        from .memory import plan
        mem_plan = plan(params_b, available_ram_gb)

        if not mem_plan.will_fit:
            print(f"WARNING: {params_b}B model may not fit in {available_ram_gb:.1f} GB RAM.")
            print(mem_plan.describe())

        config = cls(
            model_name_or_path         = model_name_or_path,
            load_in_4bit               = (mem_plan.quantization_bits == 4),
            lora_r                     = mem_plan.lora_rank,
            lora_alpha                 = mem_plan.lora_alpha,
            max_seq_length             = mem_plan.max_seq_length,
            per_device_train_batch_size= mem_plan.batch_size,
            gradient_accumulation_steps= mem_plan.grad_accum,
            gradient_checkpointing     = mem_plan.gradient_checkpointing,
        )

        # Apply user overrides
        for k, v in overrides.items():
            if not hasattr(config, k):
                raise ValueError(f"Unknown AxonConfig field: '{k}'")
            setattr(config, k, v)

        return config

    def memory_report(self, params_b: float = 8.0) -> str:
        """Print estimated memory usage for this configuration."""
        from .memory import plan
        from .hardware import detect_hardware
        hw = detect_hardware()
        p = plan(params_b, hw.avail_ram_gb)
        return p.describe()
