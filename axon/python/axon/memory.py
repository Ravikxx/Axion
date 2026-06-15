"""
Memory planner: given hardware + model size, compute the settings that
will actually fit in RAM without OOMing.

The logic here is what makes Axon "intelligent" — instead of you having
to manually fiddle with batch sizes, LoRA ranks, and quantization levels,
this module computes the right values automatically.
"""

from __future__ import annotations
from dataclasses import dataclass
from typing import Optional
import math


@dataclass
class MemoryPlan:
    """The result of planning — what settings to use."""
    quantization_bits: int         # 4, 8, or 16
    lora_rank:         int         # 4, 8, 16, or 32
    lora_alpha:        int         # usually 2x rank
    max_seq_length:    int         # tokens per sample
    batch_size:        int         # per-device batch size
    grad_accum:        int         # gradient accumulation steps
    gradient_checkpointing: bool   # trade compute for memory

    # Estimated memory breakdown (GB)
    est_model_gb:      float
    est_lora_gb:       float
    est_optimizer_gb:  float
    est_activations_gb: float
    est_total_gb:      float
    available_gb:      float

    will_fit: bool

    def describe(self) -> str:
        if not self.will_fit:
            return (
                f"WARNING: Model may NOT fit in {self.available_gb:.1f} GB RAM.\n"
                f"Estimated requirement: {self.est_total_gb:.1f} GB.\n"
                "Try a smaller model or reduce max_seq_length."
            )
        lines = [
            "Memory plan:",
            f"  Quantization : {self.quantization_bits}-bit",
            f"  LoRA rank    : {self.lora_rank}  (alpha={self.lora_alpha})",
            f"  Sequence len : {self.max_seq_length} tokens",
            f"  Batch size   : {self.batch_size} (× {self.grad_accum} grad accum = {self.batch_size * self.grad_accum} effective)",
            f"  Grad ckpt    : {self.gradient_checkpointing}",
            "",
            f"  Est. model weights : {self.est_model_gb:.1f} GB",
            f"  Est. LoRA adapters : {self.est_lora_gb:.2f} GB",
            f"  Est. optimizer     : {self.est_optimizer_gb:.2f} GB",
            f"  Est. activations   : {self.est_activations_gb:.1f} GB",
            f"  Est. total         : {self.est_total_gb:.1f} GB / {self.available_gb:.1f} GB available",
            f"  Headroom           : {self.available_gb - self.est_total_gb:.1f} GB",
        ]
        return "\n".join(lines)


# ----- Memory estimation formulas -----
# These are rough but good-enough approximations.

def _model_gb(params_b: float, bits: int) -> float:
    """Weight memory. params_b = number of parameters in billions."""
    bytes_per_param = bits / 8
    return params_b * 1e9 * bytes_per_param / (1 << 30)


def _lora_gb(params_b: float, rank: int, bits: int = 32) -> float:
    """LoRA adapter memory. Typically ~1% of model params per target module pair.
    We target q_proj + v_proj by default = ~0.5% each = 1% total.
    Adapters are stored in fp32 (bits=32) even when base model is quantized."""
    lora_param_fraction = 0.01  # ~1% of total params
    lora_params = params_b * 1e9 * lora_param_fraction * (rank / 16)
    return lora_params * (bits / 8) / (1 << 30)


def _optimizer_gb(lora_gb: float) -> float:
    """AdamW stores m (momentum) and v (variance) vectors = 2× params in fp32."""
    return lora_gb * 2.0


def _activation_gb(seq_len: int, batch_size: int,
                   params_b: float, grad_checkpointing: bool) -> float:
    """Rough activation memory estimate.
    Without gradient checkpointing: proportional to depth × seq_len × hidden_dim.
    With gradient checkpointing: roughly sqrt of that (recomputes on backward pass).
    """
    # Approximate: 4 bytes/activation × seq × batch × hidden (hidden ≈ sqrt(params/6) heuristic)
    hidden = int(math.sqrt(params_b * 1e9 / 6))
    raw_bytes = seq_len * batch_size * hidden * 4 * 2  # ×2 for residual streams
    if grad_checkpointing:
        raw_bytes = int(math.sqrt(raw_bytes) * 1000)  # very rough sqrt approximation
    return raw_bytes / (1 << 30)


OS_OVERHEAD_GB = 2.5   # OS + Python interpreter + HF model structures


def plan(
    params_b:      float,
    available_gb:  float,
    *,
    safety_margin: float = 0.88,  # use at most 88% of available RAM
) -> MemoryPlan:
    """
    Find the best (quantization, LoRA rank, seq_len, batch) combo
    that fits within available_gb × safety_margin.

    Tries combinations from cheapest (4-bit, small rank) to most expensive,
    and returns the first plan that fits. This gives the most headroom.
    We then try to upgrade quality within the headroom.
    """
    budget = available_gb * safety_margin - OS_OVERHEAD_GB

    # Ordered from most memory-conservative to least
    quant_opts   = [4, 8, 16]
    rank_opts    = [4, 8, 16, 32]
    seq_opts     = [256, 512, 1024, 2048]
    batch        = 1   # always 1 on CPU to minimize activation memory
    grad_accum   = 8   # compensate for small batch with accumulation
    grad_ckpt    = True

    best: Optional[MemoryPlan] = None

    for bits in quant_opts:
        model_gb = _model_gb(params_b, bits)
        if model_gb > budget:
            continue

        for rank in rank_opts:
            lora_gb     = _lora_gb(params_b, rank)
            opt_gb      = _optimizer_gb(lora_gb)
            base_used   = model_gb + lora_gb + opt_gb

            for seq in seq_opts:
                act_gb = _activation_gb(seq, batch, params_b, grad_ckpt)
                total  = base_used + act_gb

                if total <= budget:
                    plan = MemoryPlan(
                        quantization_bits     = bits,
                        lora_rank             = rank,
                        lora_alpha            = rank * 2,
                        max_seq_length        = seq,
                        batch_size            = batch,
                        grad_accum            = grad_accum,
                        gradient_checkpointing= grad_ckpt,
                        est_model_gb          = model_gb,
                        est_lora_gb           = lora_gb,
                        est_optimizer_gb      = opt_gb,
                        est_activations_gb    = act_gb,
                        est_total_gb          = total + OS_OVERHEAD_GB,
                        available_gb          = available_gb,
                        will_fit              = True,
                    )
                    # Keep trying better options (higher rank / longer seq)
                    # within the same bit width
                    best = plan

        if best is not None:
            # Found a fitting plan at this quantization level; stop here
            # (lower quantization = smaller model = better)
            break

    if best is None:
        # Nothing fits — return a plan anyway with will_fit=False
        model_gb = _model_gb(params_b, 4)
        lora_gb  = _lora_gb(params_b, 4)
        opt_gb   = _optimizer_gb(lora_gb)
        act_gb   = _activation_gb(256, 1, params_b, True)
        best = MemoryPlan(
            quantization_bits     = 4,
            lora_rank             = 4,
            lora_alpha            = 8,
            max_seq_length        = 256,
            batch_size            = 1,
            grad_accum            = 16,
            gradient_checkpointing= True,
            est_model_gb          = model_gb,
            est_lora_gb           = lora_gb,
            est_optimizer_gb      = opt_gb,
            est_activations_gb    = act_gb,
            est_total_gb          = model_gb + lora_gb + opt_gb + act_gb + OS_OVERHEAD_GB,
            available_gb          = available_gb,
            will_fit              = False,
        )

    return best
