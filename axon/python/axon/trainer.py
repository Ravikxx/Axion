"""
AxonTrainer: drop-in replacement for HuggingFace Trainer, optimized for CPU.

Minimal usage:
    trainer = AxonTrainer(
        model="meta-llama/Llama-3.2-8B",
        train_dataset=my_dataset,
        formatting_func=lambda ex: f"### Input: {ex['input']}\n### Output: {ex['output']}",
    )
    trainer.train()

The trainer automatically:
  - Detects your hardware
  - Chooses quantization level, LoRA rank, and sequence length that fit in your RAM
  - Applies QLoRA (4-bit weights + float32 LoRA adapters)
  - Sets PyTorch to use all physical CPU cores
  - Adds progress callbacks tuned for slow CPU steps
"""

from __future__ import annotations
import os
from typing import Callable, Optional, Union

# These are imported lazily (inside methods) to keep startup fast
# and to avoid hard errors when optional packages aren't installed.


class AxonTrainer:
    def __init__(
        self,
        model: str,
        train_dataset,
        *,
        config=None,                          # AxonConfig; auto-created if None
        eval_dataset=None,
        tokenizer=None,
        formatting_func: Optional[Callable]  = None,
        dataset_text_field: Optional[str]    = None,  # e.g. "text" for pre-formatted datasets
        params_b: float                      = 8.0,   # model size in billions (for memory planning)
    ):
        """
        Args:
            model: HuggingFace model ID or local path.
            train_dataset: A datasets.Dataset or iterable of dicts.
            config: AxonConfig. If None, auto-configured from hardware.
            eval_dataset: Optional validation dataset.
            tokenizer: Pre-loaded tokenizer. If None, loaded from model.
            formatting_func: Function that takes a dataset row and returns a string.
                             E.g.: lambda ex: f"Q: {ex['q']}\nA: {ex['a']}"
            dataset_text_field: If your dataset already has a pre-formatted text column,
                                specify its name here instead of formatting_func.
            params_b: Approximate parameter count in billions. Used for memory planning
                      when config=None. Default 8.0 works for 7B-8B models.
        """
        self.model_name = model
        self.train_dataset = train_dataset
        self.eval_dataset = eval_dataset
        self._tokenizer_input = tokenizer
        self.formatting_func = formatting_func
        self.dataset_text_field = dataset_text_field
        self.params_b = params_b

        if config is None:
            from .config import AxonConfig
            from .hardware import detect_hardware
            hw = detect_hardware()
            config = AxonConfig.auto(
                model_name_or_path=model,
                params_b=params_b,
                available_ram_gb=hw.avail_ram_gb,
            )
        self.config = config

        # Set after train() completes
        self._model     = None
        self._tokenizer = None
        self._hf_trainer = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def train(self):
        """
        Run the full training loop. Steps:
          1. Print hardware summary
          2. Configure CPU threads
          3. Load model (quantized) + tokenizer
          4. Apply LoRA
          5. Build HuggingFace TrainingArguments
          6. Create SFTTrainer (supervised fine-tuning)
          7. Add Axon callbacks
          8. Train
        """
        self._print_startup_summary()
        self._configure_cpu_threads()

        print("\n[1/3] Loading model and tokenizer...")
        model, tokenizer = self._load_model_and_tokenizer()

        print("[2/3] Applying QLoRA adapters...")
        model = self._apply_lora(model)
        model.print_trainable_parameters()

        print("[3/3] Starting training...\n")
        result = self._run_training(model, tokenizer)

        self._model     = model
        self._tokenizer = tokenizer
        return result

    def save_model(self, output_dir: Optional[str] = None):
        """Save LoRA adapters (not the full model — base model is unchanged)."""
        out = output_dir or self.config.output_dir
        if self._hf_trainer:
            self._hf_trainer.save_model(out)
        elif self._model:
            self._model.save_pretrained(out)
            if self._tokenizer:
                self._tokenizer.save_pretrained(out)
        print(f"Model saved to {out}")

    def merge_and_save(self, output_dir: Optional[str] = None):
        """
        Merge LoRA weights back into the base model and save the full model.
        The merged model can be used like any normal HuggingFace model.
        NOTE: merging requires enough RAM to hold the full model in fp16/fp32.
        """
        from peft import PeftModel
        out = output_dir or os.path.join(self.config.output_dir, "merged")
        if self._model is None:
            raise RuntimeError("Call train() before merge_and_save()")
        merged = self._model.merge_and_unload()
        merged.save_pretrained(out)
        if self._tokenizer:
            self._tokenizer.save_pretrained(out)
        print(f"Merged model saved to {out}")

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _print_startup_summary(self):
        from .hardware import detect_hardware
        hw = detect_hardware()
        print(hw.summary())
        print()
        print(self.config.memory_report(self.params_b))
        print()

    def _configure_cpu_threads(self):
        """
        Tell PyTorch (and the underlying BLAS library) how many threads to use.

        We set it to physical core count, NOT logical cores.
        Hyperthreading (logical cores) shares the floating-point units —
        using them for matmul often actually *hurts* performance.
        """
        import torch
        from .hardware import detect_hardware
        hw = detect_hardware()

        num_threads = self.config.num_cpu_threads or hw.physical_cores
        torch.set_num_threads(num_threads)
        torch.set_num_interop_threads(max(1, num_threads // 4))

        # Set BLAS threads via environment variables.
        # PyTorch may use MKL, OpenBLAS, or another BLAS under the hood.
        for var in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS",
                    "BLIS_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
            os.environ[var] = str(num_threads)

        print(f"CPU threads: {num_threads} physical cores "
              f"(of {hw.logical_cores} logical)")

    def _load_model_and_tokenizer(self):
        import torch
        from transformers import (
            AutoTokenizer,
            AutoModelForCausalLM,
            BitsAndBytesConfig,
        )

        # Load tokenizer
        tokenizer = self._tokenizer_input or AutoTokenizer.from_pretrained(
            self.model_name,
            trust_remote_code=True,
        )
        # Many models don't set pad_token; we use eos_token as padding
        if tokenizer.pad_token is None:
            tokenizer.pad_token = tokenizer.eos_token
        tokenizer.padding_side = "right"  # required for attention mask correctness

        # Quantization config
        bnb_config = None
        if self.config.load_in_4bit:
            compute_dtype = getattr(torch, self.config.bnb_4bit_compute_dtype)
            bnb_config = BitsAndBytesConfig(
                load_in_4bit               = True,
                bnb_4bit_quant_type        = self.config.bnb_4bit_quant_type,
                bnb_4bit_compute_dtype     = compute_dtype,
                bnb_4bit_use_double_quant  = self.config.bnb_4bit_use_double_quant,
            )

        # Load model
        # device_map="cpu" forces all layers onto CPU RAM.
        # low_cpu_mem_usage=True loads weights shard-by-shard instead of
        # all at once, halving peak RAM usage during loading.
        model = AutoModelForCausalLM.from_pretrained(
            self.model_name,
            quantization_config  = bnb_config,
            device_map           = "cpu",
            low_cpu_mem_usage    = True,
            trust_remote_code    = True,
        )
        model.config.use_cache = False  # must disable when using gradient checkpointing

        return model, tokenizer

    def _apply_lora(self, model):
        from peft import (
            LoraConfig,
            get_peft_model,
            TaskType,
            prepare_model_for_kbit_training,
        )

        if self.config.load_in_4bit:
            # Prepares the quantized model for training:
            # - Casts layer norms to float32 (needed for gradient flow)
            # - Enables gradient checkpointing if configured
            model = prepare_model_for_kbit_training(
                model,
                use_gradient_checkpointing=self.config.gradient_checkpointing,
            )

        # Auto-detect LoRA target modules if not specified.
        # For most transformer models: q_proj, v_proj are the attention
        # query and value weight matrices — standard LoRA targets.
        target_modules = self.config.lora_target_modules or self._auto_detect_lora_targets(model)

        lora_cfg = LoraConfig(
            r              = self.config.lora_r,
            lora_alpha     = self.config.lora_alpha,
            target_modules = target_modules,
            lora_dropout   = self.config.lora_dropout,
            bias           = self.config.lora_bias,
            task_type      = TaskType.CAUSAL_LM,
        )

        return get_peft_model(model, lora_cfg)

    def _auto_detect_lora_targets(self, model) -> list[str]:
        """
        Try to find the right LoRA target module names for this model architecture.
        Different model families name their attention layers differently.
        """
        # Collect all linear layer names
        linear_names = set()
        for name, module in model.named_modules():
            class_name = type(module).__name__
            if "Linear" in class_name or "Linear4bit" in class_name:
                # Take just the last component of the name (e.g. "q_proj" from "model.layers.0.self_attn.q_proj")
                linear_names.add(name.split(".")[-1])

        # Common patterns across model families
        priority = [
            ["q_proj", "v_proj"],                         # LLaMA, Mistral, Qwen
            ["query_key_value"],                           # Falcon
            ["c_attn"],                                    # GPT-2/NeoX
            ["query", "value"],                            # BERT-family
            ["q", "v"],                                    # some custom models
        ]

        for candidate in priority:
            if all(m in linear_names for m in candidate):
                return candidate

        # Fallback: use all linear layers (more memory, more expressive)
        return list(linear_names)

    def _run_training(self, model, tokenizer):
        import torch
        from transformers import TrainingArguments

        training_args = TrainingArguments(
            output_dir                  = self.config.output_dir,
            num_train_epochs            = self.config.num_train_epochs,
            per_device_train_batch_size = self.config.per_device_train_batch_size,
            gradient_accumulation_steps = self.config.gradient_accumulation_steps,
            learning_rate               = self.config.learning_rate,
            weight_decay                = self.config.weight_decay,
            warmup_ratio                = self.config.warmup_ratio,
            lr_scheduler_type           = self.config.lr_scheduler_type,
            optim                       = self.config.optim,
            bf16                        = self.config.bf16,
            fp16                        = self.config.fp16,
            gradient_checkpointing      = self.config.gradient_checkpointing,
            logging_steps               = self.config.logging_steps,
            save_steps                  = self.config.save_steps,
            save_total_limit            = self.config.save_total_limit,
            dataloader_num_workers      = self.config.dataloader_num_workers,
            no_cuda                     = True,   # force CPU even if CUDA is available
            report_to                   = "none", # don't log to wandb/tensorboard by default
            disable_tqdm                = True,   # we use our own progress callback
        )

        # Try to use TRL's SFTTrainer (best for fine-tuning)
        # Fall back to HF Trainer if TRL is not installed
        try:
            from trl import SFTTrainer

            trainer = SFTTrainer(
                model           = model,
                tokenizer       = tokenizer,
                args            = training_args,
                train_dataset   = self.train_dataset,
                eval_dataset    = self.eval_dataset,
                formatting_func = self.formatting_func,
                dataset_text_field = self.dataset_text_field or "text",
                max_seq_length  = self.config.max_seq_length,
                packing         = self.config.packing,
            )

        except ImportError:
            # TRL not installed — use plain HF Trainer
            # In this case the dataset must already be tokenized
            from transformers import Trainer, DataCollatorForLanguageModeling

            print("Note: 'trl' not installed. Using base HF Trainer.")
            print("      Dataset must be pre-tokenized.")

            data_collator = DataCollatorForLanguageModeling(
                tokenizer=tokenizer, mlm=False
            )
            trainer = Trainer(
                model         = model,
                tokenizer     = tokenizer,
                args          = training_args,
                train_dataset = self.train_dataset,
                eval_dataset  = self.eval_dataset,
                data_collator = data_collator,
            )

        # Add Axon's CPU-specific callbacks
        from .callbacks import CpuProgressCallback, MemoryMonitorCallback
        trainer.add_callback(CpuProgressCallback())
        trainer.add_callback(MemoryMonitorCallback())

        if self.config.use_torch_compile:
            try:
                model = torch.compile(model, backend="inductor")
                print("torch.compile enabled (this may take 1-2 min on first step)")
            except Exception as e:
                print(f"torch.compile failed ({e}), training without it")

        result = trainer.train()
        self._hf_trainer = trainer
        return result
