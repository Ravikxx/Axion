# Lumen training pipeline

Generates Axion-native SFT data for Lumen by running a teacher model (default:
`big-pickle`, free) through Axion's **real** `Agent` class on scripted tasks in
throwaway workspaces. Every sample is the exact OpenAI-format request Lumen
will see at inference: Axion's system prompt, the full tool schema, multi-turn
tool calls, and real tool results. Only trajectories whose outcome is
**programmatically verified** become training data.

## Generate trajectories

```
node training/gen-trajectories.mjs --n 200 --concurrency 3
```

| Flag | Default | Meaning |
|---|---|---|
| `--n` | 20 | number of samples to attempt |
| `--model` | big-pickle | teacher model alias (any Axion model alias) |
| `--concurrency` | 2 | parallel agents (each gets its own workspace + cwd label) |
| `--timeout` | 240 | seconds before a sample is cancelled |
| `--seed` | 0 | base seed — different seeds → different task variants; reuse a seed to reproduce a batch |

Output (appended, so batches accumulate):

- `training/data/trajectories.jsonl` — verified successes (the training data)
- `training/data/failures.jsonl` — failures, for inspection only

Each line: `{ id, task, model, success, tokens, messages, tools }` where
`messages` is `[system, user, assistant(+tool_calls), tool, ...]`.

## Hygiene guarantees (don't break these)

- **Sandboxed home**: the generator overrides `USERPROFILE`/`HOME` before
  importing Axion, so personal memories, learned preferences, and session
  notes never enter the system prompt. API keys are carried over explicitly.
- **Per-cwd project context**: the system prompt's project context is built
  from the workspace, not the axion repo (fixed in agent.js — was baked in at
  import time).
- **Path normalization**: workspace paths (which contain the local username)
  are rewritten to `C:\projects\app` at both JSON escape depths.
- **Verification is strict**: `verify()` checks real outcomes (tests pass,
  files moved, git log contains the commit) — not the model's claims.

## Adding tasks

Add a template to `tasks.mjs`: `{ id, gen(rng) => { prompt, setup(dir),
verify(dir, { finalText }) } }`. Use the `rng` for variety (names, values,
phrasings) so repeated samples differ. Keep `verify` strict and side-effect
free. Templates are cycled round-robin by sample index.

## Caveats / known biases

- All trajectories are generated on **Windows** — shell commands in
  `run_command` calls are PowerShell/cmd flavored. Mix in Linux-generated
  batches (e.g. run the generator on Kaggle/Colab) before training if Lumen
  should serve Linux users.
- The teacher reveals itself as `deepseek-v4-flash`; its `reasoning_content`
  is NOT captured into `messages` (Axion surfaces it as a UI-only thinking
  message). If you want reasoning traces in training data, that's a separate
  serialization decision.
- This data teaches **tool-use discipline in Axion's format**, not deep repo
  reasoning. For SWE-bench-style ability, mix with SWE-Gym / SWE-smith
  trajectories reformatted into this same schema (see plan in project notes):
  ~45% agentic SWE, ~20% code instruct, ~25% general (Tulu/SmolTalk), ~10%
  tool calling, with this Axion-native data folded into the agentic slice.

## Next steps (not yet built)

1. Reformatter: SWE-Gym/SWE-smith + Tulu → this JSONL schema.
2. Qwen chat-template packer + Unsloth QLoRA notebook (Kaggle T4, 4-bit,
   r=32, lr 2e-4, loss on assistant tokens only).
3. Eval harness: base-vs-tuned on held-out task templates through this same
   generator with `--model lumen`.
