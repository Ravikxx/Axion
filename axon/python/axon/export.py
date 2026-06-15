"""
Model export: merge LoRA adapters back into the base model, then save
in safetensors format (universal) or GGUF format (for llama.cpp / Ollama).

Why two formats?
  - safetensors: standard HuggingFace format, works everywhere
  - GGUF: the format used by llama.cpp and Ollama for efficient CPU inference.
    After fine-tuning with Axon, you can convert to GGUF and run inference
    with llama.cpp at much better speed than PyTorch on CPU.

The GGUF conversion delegates to llama.cpp's official converter script
(convert_hf_to_gguf.py) since rolling our own would duplicate that work.
"""

from __future__ import annotations
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional


def export_model(
    model_dir: str,
    fmt:       str            = "safetensors",
    output:    Optional[str]  = None,
    quantize:  Optional[str]  = None,
) -> int:
    """
    Export a trained model directory.

    Args:
        model_dir: Directory containing HF model (with LoRA adapters or already merged).
        fmt:       "safetensors" or "gguf".
        output:    Output path. For safetensors: a directory. For GGUF: a .gguf file path.
        quantize:  GGUF quantization level. One of: q4_k_m, q5_k_m, q8_0.
                   Only used when fmt="gguf". Defaults to q4_k_m.

    Returns:
        0 on success, 1 on error.
    """
    model_dir = Path(model_dir).resolve()
    if not model_dir.exists():
        print(f"Error: model directory not found: {model_dir}")
        return 1

    if fmt == "safetensors":
        return _export_safetensors(model_dir, output)
    elif fmt == "gguf":
        return _export_gguf(model_dir, output, quantize or "q4_k_m")
    else:
        print(f"Error: unknown format '{fmt}'")
        return 1


# ── safetensors export ────────────────────────────────────────────────────────

def _export_safetensors(model_dir: Path, output: Optional[str]) -> int:
    """
    Merge LoRA adapters and save as safetensors in fp16.
    If the model directory already has merged weights (no adapter_config.json),
    just resaves in safetensors format.
    """
    output_dir = Path(output) if output else model_dir.parent / (model_dir.name + "_merged")
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Loading model from {model_dir} ...")

    is_lora = (model_dir / "adapter_config.json").exists()

    if is_lora:
        print("LoRA adapters detected — merging into base model ...")
        merged = _merge_lora(model_dir)
        if merged is None:
            return 1
        model, tokenizer = merged
    else:
        from transformers import AutoModelForCausalLM, AutoTokenizer
        import torch
        print("No adapter_config.json found — loading as full model ...")
        model = AutoModelForCausalLM.from_pretrained(
            str(model_dir),
            torch_dtype=torch.float16,
            low_cpu_mem_usage=True,
        )
        tokenizer = AutoTokenizer.from_pretrained(str(model_dir))

    print(f"Saving safetensors to {output_dir} ...")
    model.save_pretrained(str(output_dir), safe_serialization=True)
    tokenizer.save_pretrained(str(output_dir))
    print(f"Done. Saved to: {output_dir}")
    return 0


def _merge_lora(model_dir: Path):
    """Load a PEFT model and merge LoRA adapters. Returns (model, tokenizer) or None."""
    try:
        import torch
        from peft import PeftModel
        from transformers import AutoModelForCausalLM, AutoTokenizer
    except ImportError as e:
        print(f"Error: missing dependency — {e}")
        return None

    # Read the base model name from adapter_config.json
    import json
    with open(model_dir / "adapter_config.json") as f:
        adapter_cfg = json.load(f)
    base_model_name = adapter_cfg.get("base_model_name_or_path", "")

    if not base_model_name:
        print("Error: adapter_config.json does not contain base_model_name_or_path")
        return None

    print(f"Base model: {base_model_name}")

    try:
        tokenizer = AutoTokenizer.from_pretrained(base_model_name, trust_remote_code=True)
        base = AutoModelForCausalLM.from_pretrained(
            base_model_name,
            torch_dtype=torch.float16,
            low_cpu_mem_usage=True,
            trust_remote_code=True,
        )
        model = PeftModel.from_pretrained(base, str(model_dir))
        model = model.merge_and_unload()
        return model, tokenizer
    except Exception as e:
        print(f"Error merging LoRA: {e}")
        return None


# ── GGUF export ───────────────────────────────────────────────────────────────

def _export_gguf(model_dir: Path, output: Optional[str], quantize: str) -> int:
    """
    Convert a HuggingFace model directory to GGUF format.

    Strategy:
      1. If the directory contains LoRA adapters, merge them first.
      2. Save merged weights as fp16 safetensors to a temp dir.
      3. Find llama.cpp's convert_hf_to_gguf.py and call it.
      4. If quantize is set, run llama.cpp's quantize binary.
    """
    import tempfile

    # Determine output path
    model_name = model_dir.name
    default_out = model_dir.parent / f"{model_name}.gguf"
    out_path = Path(output) if output else default_out

    with tempfile.TemporaryDirectory(prefix="axon_export_") as tmp:
        tmp_path = Path(tmp)

        # Step 1: ensure we have a merged fp16 model
        if (model_dir / "adapter_config.json").exists():
            print("Merging LoRA adapters before GGUF conversion ...")
            merged = _merge_lora(model_dir)
            if merged is None:
                return 1
            model, tokenizer = merged
            merged_dir = tmp_path / "merged"
            merged_dir.mkdir()
            model.save_pretrained(str(merged_dir), safe_serialization=True)
            tokenizer.save_pretrained(str(merged_dir))
            source_dir = merged_dir
        else:
            source_dir = model_dir

        # Step 2: find convert_hf_to_gguf.py
        converter = _find_gguf_converter()
        if converter is None:
            print(
                "\nCould not find llama.cpp's convert_hf_to_gguf.py.\n"
                "To convert to GGUF manually:\n"
                "  1. git clone https://github.com/ggerganov/llama.cpp\n"
                "  2. pip install -r llama.cpp/requirements.txt\n"
                f"  3. python llama.cpp/convert_hf_to_gguf.py {source_dir} "
                f"--outfile {out_path} --outtype f16\n"
                f"  4. (optional) ./llama.cpp/quantize {out_path} {out_path} {quantize.upper()}\n"
            )
            # Save the merged model so the user can run conversion manually
            if source_dir != model_dir:
                final_merged = model_dir.parent / (model_dir.name + "_merged_fp16")
                shutil.copytree(str(source_dir), str(final_merged))
                print(f"Merged fp16 model saved to: {final_merged}")
            return 1

        # Step 3: run converter
        unquantized = tmp_path / f"{model_name}_f16.gguf"
        print(f"Converting to GGUF (f16) ...")
        result = subprocess.run(
            [sys.executable, str(converter), str(source_dir),
             "--outfile", str(unquantized), "--outtype", "f16"],
            capture_output=False,
        )
        if result.returncode != 0:
            print("GGUF conversion failed.")
            return 1

        # Step 4: quantize if requested
        if quantize and quantize != "f16":
            quantize_bin = _find_llama_quantize()
            if quantize_bin:
                print(f"Quantizing to {quantize.upper()} ...")
                result = subprocess.run(
                    [str(quantize_bin), str(unquantized), str(out_path), quantize.upper()],
                    capture_output=False,
                )
                if result.returncode != 0:
                    print("Quantization failed. Saving f16 GGUF instead.")
                    shutil.copy(str(unquantized), str(out_path))
            else:
                print(
                    f"llama.cpp 'quantize' binary not found. Saving f16 GGUF.\n"
                    f"To quantize manually: ./llama.cpp/quantize {unquantized} {out_path} {quantize.upper()}"
                )
                shutil.copy(str(unquantized), str(out_path))
        else:
            shutil.copy(str(unquantized), str(out_path))

    print(f"\nDone. GGUF model saved to: {out_path}")
    _print_llama_cpp_usage(out_path)
    return 0


def _find_gguf_converter() -> Optional[Path]:
    """Look for llama.cpp's convert_hf_to_gguf.py in common locations."""
    candidates = [
        Path("llama.cpp/convert_hf_to_gguf.py"),
        Path("../llama.cpp/convert_hf_to_gguf.py"),
        Path.home() / "llama.cpp/convert_hf_to_gguf.py",
    ]
    # Also check if it's on PATH via which
    which = shutil.which("convert_hf_to_gguf.py")
    if which:
        candidates.insert(0, Path(which))

    for p in candidates:
        if p.exists():
            return p
    return None


def _find_llama_quantize() -> Optional[Path]:
    """Look for llama.cpp's quantize binary."""
    candidates = [
        Path("llama.cpp/quantize"),
        Path("../llama.cpp/quantize"),
        Path.home() / "llama.cpp/quantize",
    ]
    which = shutil.which("llama-quantize")
    if which:
        candidates.insert(0, Path(which))

    for p in candidates:
        if p.exists():
            return p
    return None


def _print_llama_cpp_usage(gguf_path: Path):
    print(
        f"\nRun inference with llama.cpp:\n"
        f"  ./llama.cpp/main -m {gguf_path} -p \"Your prompt here\" -n 200\n"
        f"\nOr load in Ollama:\n"
        f"  ollama create my-model -f Modelfile  (with FROM {gguf_path})\n"
    )
