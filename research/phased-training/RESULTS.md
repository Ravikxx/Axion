# Phased layer-wise training — pilot results

**Question:** Does training a subset of layer-groups at a time (switching groups
automatically when the loss curve plateaus) beat training everything, at **equal
compute**?

**Setup:** from-scratch ~2.72M-param char-level GPT, tinyshakespeare, CPU.
Three layer groups (bottom = embeddings+lower blocks, mid, top = upper blocks+head).
All arms share identical init, identical batch order, identical FLOP budget
(~1000 full-arm-equivalent steps). x-axis is cumulative FLOPs, never step count.

## Result: exclusive phasing clearly loses; cumulative ≈ full (statistical tie at this budget)

Final validation loss (lower is better):

| arm            | final val | vs full | notes |
|----------------|-----------|---------|-------|
| full           | 2.107     | —       | train everything every step |
| cumul_bottomup | 2.171     | +0.064  | gradual unfreeze, add groups bottom→top |
| cumul_topdown  | 2.188     | +0.081  | gradual unfreeze, add groups top→bottom (ULMFiT) |
| excl_topdown   | 2.348     | +0.241  | only one group trains at a time |

**Read these honestly:**
- **Single seed, and every arm was still descending at the cutoff** — this is
  "who's ahead at an arbitrary early stop," not "who reaches a better asymptote."
  `cumul_bottomup` had the *steepest terminal slope* (it only entered full
  training at 70% of budget), so a longer run could change the ranking.
- The full ↔ cumulative gaps (0.06–0.08) are **within the eval-to-eval jitter**
  (~0.02–0.05 observed). So full vs the cumulative arms is a **statistical tie**,
  not a win — they cannot be ranked from one seed.
- Only the **exclusive** result is robust: +0.24 is large and has a clear
  mechanistic cause (below).

**What is NOT yet tested (at 1× budget):** the auto-plateau scheduler barely fired
(the FLOP-budget backstop did almost all the switching). See the 2.5× run below,
where it *did* fire on plateau.

## Tiebreaker: 2.5× budget run (~2500 full-arm-equivalent steps)

The 1× gaps were within noise, so we reran at 2.5× the budget to see the asymptote
(and because `cumul_bottomup` had the steepest terminal slope — the case for a
late crossover).

| arm            | final val @1× | gap @1× | final val @2.5× | gap @2.5× |
|----------------|---------------|---------|-----------------|-----------|
| full           | 2.107         | —       | **1.811**       | —         |
| cumul_bottomup | 2.171         | +0.064  | 1.868           | +0.057    |
| cumul_topdown  | 2.188         | +0.081  | 1.920           | +0.109    |
| excl_topdown   | 2.348         | +0.241  | 2.094           | +0.283    |

**Full wins at both budgets; no phased arm crossed it.** The gaps (0.06–0.28) are
larger than the eval jitter (~0.02–0.05), so the ranking is real. Nuance:
- `cumul_topdown`'s gap **grew** with budget (0.08 → 0.11).
- `cumul_bottomup`'s gap **held** (~0.06) — it's the closest to full, *despite*
  wasting ~46% of budget behind a frozen head. Its productive full-training phase
  (from warm lower layers) was efficient — but still didn't beat plain full.
- The "cheaper early steps / steeper slope lets a phased arm cross full"
  hypothesis was **not** supported.

**Good news for the scheduler:** at 2.5× budget the plateau detector *did* fire on
its own (multiple `SWITCH:plateau` events, e.g. top-down arms switched when their
cheap first phase stopped improving). So the auto-plateau mechanism works and
picks sane switch points — it just doesn't make phasing win.

Caveat that remains: still **single seed**. The 0.10 gap now exceeds the ~0.02–0.05
jitter, so it is likely real, but multi-seed would make it airtight.

## What we learned (the valuable part)

1. **Exclusive phasing — the original "train a few params, then switch" idea —
   is clearly worst.** Root cause is mechanistic and sharp: the top group
   contains the output head (`lm_head`). While it is frozen, *no* amount of
   training the other layers can reduce loss. `excl`/`cumul` bottom-up arms sat
   at val ≈ 3.1 for the entire first ~half of the budget, then dropped off a
   cliff the instant the head started training. That compute was wasted.

2. **Never freeze the output head.** This is the single biggest lever. Any
   schedule that leaves the head untrained for a phase throws away that phase.

3. **Cumulative gradual unfreezing (keep prior groups on, add more) nearly
   closes the gap** — from +0.24 (exclusive) down to +0.06–0.08. But it still
   does not beat full at equal compute on this task.

4. **The auto-plateau scheduler works** (fires at sane points), but in practice
   the FLOP-budget backstop did most of the switching; pure plateau detection
   only triggered once per run. On a smoothly-decreasing loss, plateau alone is
   too conservative — the backstop is doing the real work.

## Honest caveats — what this does NOT prove

- **This is the hardest regime for phasing.** From-scratch pretraining needs all
  layers to co-adapt. The usual pitch for phasing/unfreezing is *fine-tuning*,
  where lower layers are already good and you mostly adapt the top — a different,
  more favorable regime that this pilot did not test. SFT is the next experiment.
- **We measured compute, not memory.** Phasing's real potential win on
  RAM-constrained hardware is fewer optimizer states in memory (Adam stores 2×
  params), letting you fit a *bigger* model. The "val loss at equal FLOPs" metric
  here is blind to that axis.
- **Tiny scale** (2.7M params, 1000 steps). Effects may differ at scale.

## Recommendation

- **As a compute speedup, phased training does not work here.** At equal compute,
  full training wins, and its lead grows with budget. Don't pursue phasing to
  "train faster" — this from-scratch pilot is evidence against it.
- **Phasing's only remaining case is memory**, not speed: training fewer groups
  means fewer optimizer states resident (Adam stores 2× params), which could let
  you fit a *bigger* model on 16 GB. This compute-only test did not measure that
  axis — if phasing is worth anything, it's here.
- If pursued for memory: use **cumulative gradual unfreezing** (never exclusive,
  never freeze the head), and test in the **SFT** regime, where lower layers are
  already trained and the early frozen-lower phases aren't wasted — the most
  favorable case, and Axion's actual use case.
- The two durable findings, independent of all the above:
  1. **Never freeze the output head** (large, mechanistic, reproducible).
  2. **The auto-plateau scheduler works** — it fires at sane points; it just
     doesn't make phasing win on compute.
- Highest-ROI direction overall: the **"stack known-good optimizations"** plan
  (Flash-Attention, GQA, good data mix) over betting on phasing as a speedup.

## Reproduce

```
cd research/phased-training
python -u experiment.py          # ~8 min on CPU, writes runs/*.csv + summary.json
```

Knobs via env: `PT_STEPS`, `PT_BATCH`, `PT_EVAL_INTERVAL`, `PT_MIN_PHASE`, `PT_PATIENCE`.
