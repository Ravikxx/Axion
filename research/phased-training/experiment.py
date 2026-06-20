"""
Phased layer-wise training experiment — proof of concept.

Tests one idea in isolation: instead of training all parameters every step,
train a subset (a contiguous group of transformer layers) at a time and switch
groups automatically when the loss curve plateaus.

Three arms, compared on a FLOPs axis (NOT step count — phased arms do less
compute per step, so comparing by step would be dishonest):

  full          — train everything every step (baseline)
  phased_bottomup — train bottom group, then middle, then top (curriculum order)
  phased_topdown  — train top group, then middle, then bottom (compute-cheap order)

Fairness controls:
  - identical random init across arms (saved once, reloaded per arm)
  - identical batch order across arms (seeded per-arm generator)
  - same total FLOP budget per arm (equal-compute comparison)

Everything is from scratch (~3M param char-level GPT on tinyshakespeare) because
the curriculum hypothesis only makes sense from scratch — a pretrained model's
lower layers already learned the basics.

Pure PyTorch, CPU-friendly. No transformers/datasets needed.
"""

import os
import sys
import csv
import math
import json
import time
import copy
import urllib.request
from dataclasses import dataclass, asdict

import torch
import torch.nn as nn
from torch.nn import functional as F

# ── Repro / threading ────────────────────────────────────────────────────────
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass
SEED = 1337
torch.manual_seed(SEED)
torch.set_num_threads(os.cpu_count() or 4)
DEVICE = "cpu"
HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")
OUT_DIR = os.path.join(HERE, "runs")
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(OUT_DIR, exist_ok=True)

DATA_URL = "https://raw.githubusercontent.com/karpathy/char-rnn/master/data/tinyshakespeare/input.txt"


# ── Config ───────────────────────────────────────────────────────────────────
@dataclass
class GPTConfig:
    vocab_size: int = 65
    block_size: int = 128
    n_layer: int = 6
    n_head: int = 6
    n_embd: int = 192
    dropout: float = 0.0


def _envi(name, default):
    return int(os.environ.get(name, default))


@dataclass
class TrainConfig:
    batch_size: int = _envi("PT_BATCH", 8)
    lr: float = 3e-4
    weight_decay: float = 0.1
    eval_interval: int = _envi("PT_EVAL_INTERVAL", 50)   # steps between val evaluations
    eval_iters: int = _envi("PT_EVAL_ITERS", 20)         # batches averaged per evaluation
    # plateau scheduler
    patience: int = _envi("PT_PATIENCE", 3)              # evals w/o improvement before switching
    min_delta: float = 0.02                              # min val-loss drop/window to count as "still improving"
    min_phase_steps: int = _envi("PT_MIN_PHASE", 150)    # floor so noise can't trip an early switch
    # equal-compute budget set later relative to the full-arm step cost
    target_full_steps: int = _envi("PT_STEPS", 1000)    # full arm runs ~this many steps; budget derived


# ── Data ─────────────────────────────────────────────────────────────────────
def load_data():
    path = os.path.join(DATA_DIR, "input.txt")
    if not os.path.exists(path):
        print(f"downloading tinyshakespeare → {path}")
        try:
            urllib.request.urlretrieve(DATA_URL, path)
        except Exception as e:
            raise SystemExit(
                f"could not download dataset ({e}).\n"
                f"manually save the text from {DATA_URL} to {path}"
            )
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    chars = sorted(set(text))
    stoi = {c: i for i, c in enumerate(chars)}
    data = torch.tensor([stoi[c] for c in text], dtype=torch.long)
    n = int(0.9 * len(data))
    return data[:n], data[n:], len(chars)


# ── Model (nanoGPT-style) ────────────────────────────────────────────────────
class Block(nn.Module):
    def __init__(self, cfg):
        super().__init__()
        self.ln1 = nn.LayerNorm(cfg.n_embd)
        self.attn = nn.MultiheadAttention(cfg.n_embd, cfg.n_head, dropout=cfg.dropout, batch_first=True)
        self.ln2 = nn.LayerNorm(cfg.n_embd)
        self.mlp = nn.Sequential(
            nn.Linear(cfg.n_embd, 4 * cfg.n_embd),
            nn.GELU(),
            nn.Linear(4 * cfg.n_embd, cfg.n_embd),
            nn.Dropout(cfg.dropout),
        )
        mask = torch.triu(torch.ones(cfg.block_size, cfg.block_size), diagonal=1).bool()
        self.register_buffer("attn_mask", mask)

    def forward(self, x):
        T = x.size(1)
        h = self.ln1(x)
        m = self.attn_mask[:T, :T]
        a, _ = self.attn(h, h, h, attn_mask=m, need_weights=False)
        x = x + a
        x = x + self.mlp(self.ln2(x))
        return x


class GPT(nn.Module):
    def __init__(self, cfg: GPTConfig):
        super().__init__()
        self.cfg = cfg
        self.tok_emb = nn.Embedding(cfg.vocab_size, cfg.n_embd)
        self.pos_emb = nn.Embedding(cfg.block_size, cfg.n_embd)
        self.blocks = nn.ModuleList([Block(cfg) for _ in range(cfg.n_layer)])
        self.ln_f = nn.LayerNorm(cfg.n_embd)
        self.lm_head = nn.Linear(cfg.n_embd, cfg.vocab_size, bias=False)
        self.apply(self._init)

    def _init(self, m):
        if isinstance(m, (nn.Linear, nn.Embedding)):
            nn.init.normal_(m.weight, mean=0.0, std=0.02)
            if isinstance(m, nn.Linear) and m.bias is not None:
                nn.init.zeros_(m.bias)

    def forward(self, idx, targets=None):
        B, T = idx.shape
        pos = torch.arange(T, device=idx.device)
        x = self.tok_emb(idx) + self.pos_emb(pos)[None, :, :]
        for blk in self.blocks:
            x = blk(x)
        x = self.ln_f(x)
        logits = self.lm_head(x)
        loss = None
        if targets is not None:
            loss = F.cross_entropy(logits.view(-1, logits.size(-1)), targets.view(-1))
        return logits, loss


# ── Parameter grouping by depth (bottom → top) ───────────────────────────────
# group 0 = embeddings + lowest third of blocks  (deepest in backward path)
# group 1 = middle third
# group 2 = top third + final norm + lm_head      (shallowest in backward path)
def build_groups(model: GPT):
    L = model.cfg.n_layer
    third = L // 3
    bounds = [(0, third), (third, 2 * third), (2 * third, L)]
    groups = [[], [], []]
    # embeddings ride with the bottom group
    groups[0] += [model.tok_emb.weight, model.pos_emb.weight]
    for gi, (lo, hi) in enumerate(bounds):
        for li in range(lo, hi):
            groups[gi] += list(model.blocks[li].parameters())
    # final norm + head ride with the top group
    groups[2] += list(model.ln_f.parameters()) + list(model.lm_head.parameters())
    return groups


def group_param_counts(groups):
    return [sum(p.numel() for p in g) for g in groups]


def set_trainable(groups, active_indices):
    """Freeze everything, then unfreeze the groups in active_indices."""
    active = set(active_indices)
    for gi, g in enumerate(groups):
        for p in g:
            p.requires_grad_(gi in active)


# ── FLOP accounting ──────────────────────────────────────────────────────────
# forward  ≈ 2 * P_total       * tokens
# backward ≈ 4 * P_backwardpath * tokens
# backward path = all params from the loss DOWN TO the deepest trainable group.
# (To train a low group you must backprop through everything above it; to train
#  only the top group you can stop early — that's where compute is actually saved.)
def step_flops(group_counts, active_indices, tokens):
    p_total = sum(group_counts)
    deepest = min(active_indices)                 # smallest index = deepest in net
    p_bwd = sum(group_counts[gi] for gi in range(deepest, len(group_counts)))
    fwd = 2 * p_total * tokens
    bwd = 4 * p_bwd * tokens
    return fwd + bwd


# ── Phase scheduler (auto plateau detection) ─────────────────────────────────
class PhaseScheduler:
    """Holds an ordered list of phases; each phase = which group indices train.
    Advances to the next phase when val loss stops improving."""

    def __init__(self, phases, tcfg: TrainConfig):
        self.phases = phases
        self.tcfg = tcfg
        self.idx = 0
        self.best = math.inf
        self.stale = 0
        self.steps_in_phase = 0

    @property
    def active(self):
        return self.phases[self.idx]

    @property
    def is_last(self):
        return self.idx >= len(self.phases) - 1

    def on_step(self):
        self.steps_in_phase += 1

    def on_eval(self, val_loss, flop_frac):
        """Advance the phase if (a) val loss plateaued, or (b) this phase has used
        its even share of the FLOP budget. Returns the trigger reason or None.

        flop_frac = cumulative FLOPs / total budget, in [0, 1]."""
        improved = val_loss < self.best - self.tcfg.min_delta
        if improved:
            self.best = val_loss
            self.stale = 0
        else:
            self.stale += 1

        n = len(self.phases)
        plateaued = (self.steps_in_phase >= self.tcfg.min_phase_steps
                     and self.stale >= self.tcfg.patience)
        # backstop: each phase gets at most 1/n of the budget
        budget_boundary = (self.idx + 1) / n
        over_budget = flop_frac >= budget_boundary

        if (plateaued or over_budget) and not self.is_last:
            self.idx += 1
            self.best = math.inf
            self.stale = 0
            self.steps_in_phase = 0
            return "plateau" if plateaued else "budget"
        return None


# ── Train / eval ─────────────────────────────────────────────────────────────
def make_batcher(data, cfg: GPTConfig, tcfg: TrainConfig, seed):
    g = torch.Generator().manual_seed(seed)

    def get_batch():
        ix = torch.randint(len(data) - cfg.block_size - 1, (tcfg.batch_size,), generator=g)
        x = torch.stack([data[i:i + cfg.block_size] for i in ix])
        y = torch.stack([data[i + 1:i + 1 + cfg.block_size] for i in ix])
        return x, y

    return get_batch


@torch.no_grad()
def evaluate(model, get_val_batch, iters):
    model.eval()
    losses = torch.zeros(iters)
    for k in range(iters):
        x, y = get_val_batch()
        _, loss = model(x, y)
        losses[k] = loss.item()
    model.train()
    return losses.mean().item()


def run_arm(name, phases, init_state, train_data, val_data, gcfg, tcfg, flop_budget):
    print(f"\n=== arm: {name} ===")
    model = GPT(gcfg)
    model.load_state_dict(copy.deepcopy(init_state))   # identical init across arms
    model.to(DEVICE).train()

    groups = build_groups(model)
    gcounts = group_param_counts(groups)

    sched = PhaseScheduler(phases, tcfg)
    set_trainable(groups, sched.active)

    # one optimizer over all params; frozen params get no grad so are skipped
    opt = torch.optim.AdamW(model.parameters(), lr=tcfg.lr, weight_decay=tcfg.weight_decay)

    get_train = make_batcher(train_data, gcfg, tcfg, seed=SEED + 1)  # same seed → same batches every arm
    get_val = make_batcher(val_data, gcfg, tcfg, seed=SEED + 99)

    tokens = tcfg.batch_size * gcfg.block_size
    cum_flops = 0.0
    step = 0
    t0 = time.time()
    log = []

    while cum_flops < flop_budget:
        x, y = get_train()
        _, loss = model(x, y)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()

        cum_flops += step_flops(gcounts, sched.active, tokens)
        sched.on_step()
        step += 1

        if step % tcfg.eval_interval == 0:
            val = evaluate(model, get_val, tcfg.eval_iters)
            trainable = sum(gcounts[gi] for gi in sched.active)
            frac = cum_flops / flop_budget
            reason = sched.on_eval(val, frac)
            if reason:
                set_trainable(groups, sched.active)
                # rebuild optimizer so moment buffers don't linger on now-frozen params
                opt = torch.optim.AdamW(model.parameters(), lr=tcfg.lr, weight_decay=tcfg.weight_decay)
            log.append({
                "step": step,
                "cum_flops": cum_flops,
                "train_loss": round(loss.item(), 4),
                "val_loss": round(val, 4),
                "phase_idx": sched.idx,
                "active_groups": "".join(str(i) for i in sched.active),
                "trainable_params": trainable,
            })
            print(f"  step {step:5d} | flops {cum_flops:.2e} ({frac:5.1%}) | "
                  f"train {loss.item():.3f} | val {val:.3f} | "
                  f"phase {sched.idx} groups[{''.join(str(i) for i in sched.active)}] | "
                  f"{('SWITCH:' + reason) if reason else ''}")

    dt = time.time() - t0
    final_val = evaluate(model, get_val, tcfg.eval_iters * 2)
    print(f"  done: {step} steps, {dt:.0f}s, final val {final_val:.4f}")

    # write per-arm CSV
    csv_path = os.path.join(OUT_DIR, f"{name}.csv")
    with open(csv_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(log[0].keys()))
        w.writeheader()
        w.writerows(log)

    return {"name": name, "final_val": final_val, "steps": step,
            "seconds": round(dt, 1), "log": log, "group_counts": gcounts}


def val_at_flops(log, frac, budget):
    """Val loss at the last eval before `frac` of the FLOP budget — for equal-compute comparison."""
    target = frac * budget
    best = None
    for row in log:
        if row["cum_flops"] <= target:
            best = row["val_loss"]
    return best


def main():
    gcfg = GPTConfig()
    tcfg = TrainConfig()
    train_data, val_data, vocab = load_data()
    gcfg.vocab_size = vocab
    print(f"data: {len(train_data)} train / {len(val_data)} val chars, vocab {vocab}")

    # build init once, share across arms
    torch.manual_seed(SEED)
    base = GPT(gcfg)
    init_state = copy.deepcopy(base.state_dict())
    gcounts = group_param_counts(build_groups(base))
    total_params = sum(gcounts)
    print(f"model: {total_params/1e6:.2f}M params, groups (bottom→top) = {gcounts}")

    # derive an equal-compute budget from the full-arm step cost
    tokens = tcfg.batch_size * gcfg.block_size
    full_step = step_flops(gcounts, [0, 1, 2], tokens)
    flop_budget = full_step * tcfg.target_full_steps
    print(f"flop budget: {flop_budget:.2e}  (~{tcfg.target_full_steps} full-arm steps)")

    arms = {
        "full":              [[0, 1, 2]],
        # exclusive: only one group trains at a time (loses — freezing the head bottlenecks loss)
        "excl_topdown":      [[2], [1], [0]],
        # cumulative gradual unfreezing (ULMFiT): keep prior groups on, add more.
        # top-down keeps the head (group 2) trainable the entire run.
        "cumul_topdown":     [[2], [1, 2], [0, 1, 2]],
        "cumul_bottomup":    [[0], [0, 1], [0, 1, 2]],
    }

    results = []
    for name, phases in arms.items():
        results.append(run_arm(name, phases, init_state, train_data, val_data,
                               gcfg, tcfg, flop_budget))

    # ── comparison table (equal FLOPs) ───────────────────────────────────────
    print("\n" + "=" * 64)
    print("val loss at equal compute (lower is better)")
    print("=" * 64)
    header = f"{'arm':<18}" + "".join(f"{int(f*100):>3d}%  " for f in (0.25, 0.5, 0.75, 1.0)) + f"{'steps':>8}{'sec':>7}"
    print(header)
    for r in results:
        row = f"{r['name']:<18}"
        for frac in (0.25, 0.5, 0.75, 1.0):
            v = val_at_flops(r["log"], frac, flop_budget)
            row += f"{v if v is not None else 0:>5.3f} "
        row += f"{r['steps']:>8}{r['seconds']:>7.0f}"
        print(row)

    best = min(results, key=lambda r: r["final_val"])
    print(f"\nbest final val: {best['name']} ({best['final_val']:.4f})")

    summary = {
        "model_params": total_params,
        "group_counts": gcounts,
        "flop_budget": flop_budget,
        "arms": [{k: r[k] for k in ("name", "final_val", "steps", "seconds")} for r in results],
    }
    with open(os.path.join(OUT_DIR, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2)
    print(f"\nwrote runs/summary.json and per-arm CSVs to {OUT_DIR}")


if __name__ == "__main__":
    main()
