"""
Axon command-line interface.

Commands:
  axon detect              Show detected hardware profile
  axon plan  [--model 8b] Show memory plan for a given model size
  axon train config.yaml  Run training from a YAML config file
  axon export <dir>       Export a trained model to safetensors or GGUF
"""

from __future__ import annotations
import argparse
import sys


# ── Entry point ──────────────────────────────────────────────────────────────

def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="axon",
        description="Axon — CPU-optimized fine-tuning for language models",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", metavar="command")

    # axon detect
    p_detect = sub.add_parser("detect", help="Show hardware profile")
    p_detect.add_argument("--json", action="store_true",
                          help="Output as JSON instead of human-readable text")

    # axon plan
    p_plan = sub.add_parser("plan", help="Show memory plan for a model size")
    p_plan.add_argument("size", nargs="?", default="8b",
                        help="Model size: 3b, 7b, 8b, 12b, 13b, 70b  [default: 8b]")
    p_plan.add_argument("--ram", type=float, default=None,
                        help="Override available RAM in GB (default: auto-detect)")

    # axon train
    p_train = sub.add_parser("train", help="Fine-tune a model from a YAML config")
    p_train.add_argument("config", help="Path to YAML config file")
    p_train.add_argument("--dry-run", action="store_true",
                         help="Show what would run without actually training")

    # axon export
    p_export = sub.add_parser("export", help="Export model to safetensors or GGUF")
    p_export.add_argument("model_dir", help="Directory containing trained LoRA adapters")
    p_export.add_argument("--format", choices=["safetensors", "gguf"], default="safetensors",
                          help="Output format  [default: safetensors]")
    p_export.add_argument("--output", "-o", default=None,
                          help="Output path (file for GGUF, directory for safetensors)")
    p_export.add_argument("--quantize", default=None,
                          choices=["q4_k_m", "q5_k_m", "q8_0"],
                          help="GGUF quantization level (only used with --format gguf)")

    args = parser.parse_args(argv)

    if args.command is None:
        parser.print_help()
        return 0

    dispatch = {
        "detect": cmd_detect,
        "plan":   cmd_plan,
        "train":  cmd_train,
        "export": cmd_export,
    }
    return dispatch[args.command](args)


# ── Commands ──────────────────────────────────────────────────────────────────

def cmd_detect(args):
    from axon.hardware import detect_hardware, is_cpp_available

    hw = detect_hardware()

    if args.json:
        import json
        import dataclasses
        print(json.dumps(dataclasses.asdict(hw), indent=2))
        return 0

    print(hw.summary())
    print()
    if is_cpp_available():
        print("C++ extension: loaded (CPUID-accurate detection)")
    else:
        print("C++ extension: not built (using Python fallback — run 'pip install -e .' to build)")
    return 0


def cmd_plan(args):
    from axon.memory import plan
    from axon.hardware import detect_hardware

    params_b = _parse_size(args.size)
    if params_b is None:
        print(f"Error: unrecognised size '{args.size}'. Try: 3b, 7b, 8b, 12b, 13b, 70b")
        return 1

    if args.ram is not None:
        available_gb = args.ram
    else:
        hw = detect_hardware()
        available_gb = hw.avail_ram_gb

    p = plan(params_b=params_b, available_gb=available_gb)
    print(f"Model: {args.size.upper()}  |  Available RAM: {available_gb:.1f} GB\n")
    print(p.describe())
    return 0 if p.will_fit else 1


def cmd_train(args):
    import os
    config_path = args.config

    if not os.path.exists(config_path):
        print(f"Error: config file not found: {config_path}")
        return 1

    cfg = _load_yaml_config(config_path)
    if cfg is None:
        return 1

    axon_config, trainer_kwargs = _build_config_from_yaml(cfg)

    if args.dry_run:
        print("Dry run — would train with:\n")
        print(f"  Model      : {axon_config.model_name_or_path}")
        print(f"  Output dir : {axon_config.output_dir}")
        print(f"  LoRA rank  : {axon_config.lora_r}")
        print(f"  Seq length : {axon_config.max_seq_length}")
        print(f"  Epochs     : {axon_config.num_train_epochs}")
        print(f"  Batch size : {axon_config.per_device_train_batch_size} "
              f"× {axon_config.gradient_accumulation_steps} grad accum")
        return 0

    from axon.trainer import AxonTrainer
    trainer = AxonTrainer(
        model=axon_config.model_name_or_path,
        config=axon_config,
        **trainer_kwargs,
    )
    trainer.train()
    trainer.save_model()
    return 0


def cmd_export(args):
    from axon.export import export_model
    return export_model(
        model_dir  = args.model_dir,
        fmt        = args.format,
        output     = args.output,
        quantize   = args.quantize,
    )


# ── YAML config loader ────────────────────────────────────────────────────────

def _load_yaml_config(path: str) -> dict | None:
    try:
        import yaml
    except ImportError:
        print("Error: PyYAML is not installed. Run: pip install pyyaml")
        return None

    try:
        with open(path) as f:
            return yaml.safe_load(f)
    except Exception as e:
        print(f"Error reading config: {e}")
        return None


def _build_config_from_yaml(cfg: dict):
    """
    Convert a YAML config dict into (AxonConfig, trainer_kwargs).

    YAML structure:
        model: meta-llama/Llama-3.2-8B
        params_b: 8.0
        output_dir: ./output
        dataset:
          path: my_data.jsonl       # local file or HF dataset name
          format: jsonl             # jsonl | hf | csv
          text_field: text          # for pre-formatted text
          instruction_field: instruction
          response_field: response
        training:
          epochs: 3
          learning_rate: 2e-4
          max_seq_length: 512
          batch_size: 1
          gradient_accumulation_steps: 8
        lora:
          rank: 16
          alpha: 32
          dropout: 0.05
          target_modules: [q_proj, v_proj]
    """
    from axon.config import AxonConfig

    model_name = cfg.get("model", "")
    params_b   = float(cfg.get("params_b", 8.0))
    output_dir = cfg.get("output_dir", "./axon_output")

    training   = cfg.get("training", {})
    lora       = cfg.get("lora", {})

    overrides = dict(
        output_dir                  = output_dir,
        num_train_epochs            = int(training.get("epochs", 3)),
        learning_rate               = float(training.get("learning_rate", 2e-4)),
        max_seq_length              = int(training.get("max_seq_length", 512)),
        per_device_train_batch_size = int(training.get("batch_size", 1)),
        gradient_accumulation_steps = int(training.get("gradient_accumulation_steps", 8)),
        lora_r                      = int(lora.get("rank", 16)),
        lora_alpha                  = int(lora.get("alpha", 32)),
        lora_dropout                = float(lora.get("dropout", 0.05)),
    )
    if "target_modules" in lora:
        overrides["lora_target_modules"] = list(lora["target_modules"])

    axon_config = AxonConfig.auto(
        model_name_or_path=model_name,
        params_b=params_b,
        **overrides,
    )

    # Build dataset and formatting function
    dataset_cfg = cfg.get("dataset", {})
    train_dataset, formatting_func, text_field = _load_dataset_from_config(dataset_cfg)

    trainer_kwargs = dict(
        train_dataset   = train_dataset,
        formatting_func = formatting_func,
        dataset_text_field = text_field,
        params_b        = params_b,
    )
    return axon_config, trainer_kwargs


def _load_dataset_from_config(dataset_cfg: dict):
    """Load dataset from config. Returns (dataset, formatting_func, text_field)."""
    from datasets import load_dataset

    path        = dataset_cfg.get("path", "")
    fmt         = dataset_cfg.get("format", "jsonl").lower()
    text_field  = dataset_cfg.get("text_field", None)
    instr_field = dataset_cfg.get("instruction_field", None)
    resp_field  = dataset_cfg.get("response_field", None)

    if fmt in ("jsonl", "json"):
        dataset = load_dataset("json", data_files=path, split="train")
    elif fmt == "csv":
        dataset = load_dataset("csv",  data_files=path, split="train")
    elif fmt == "hf":
        dataset = load_dataset(path, split="train")
    else:
        raise ValueError(f"Unknown dataset format: {fmt!r}")

    formatting_func = None
    if instr_field and resp_field:
        # Build a formatting function that templates instruction + response
        def formatting_func(example):
            return (
                f"### Instruction:\n{example[instr_field]}\n\n"
                f"### Response:\n{example[resp_field]}"
            )
        text_field = None
    elif text_field is None:
        text_field = "text"  # default column name

    return dataset, formatting_func, text_field


def _parse_size(s: str) -> float | None:
    """Parse '8b', '12B', '70b' → float in billions. Returns None on failure."""
    s = s.lower().strip()
    if s.endswith("b"):
        try:
            return float(s[:-1])
        except ValueError:
            return None
    try:
        return float(s)
    except ValueError:
        return None


if __name__ == "__main__":
    sys.exit(main())
