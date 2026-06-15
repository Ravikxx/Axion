"""
Training callbacks for CPU-specific feedback.

HuggingFace Trainer supports "callbacks" — functions called at specific
points during training (step start, step end, log, etc.). We use these to:
  1. Show meaningful ETA estimates (CPU steps take 10-300s each — feedback matters)
  2. Monitor RAM usage and warn before OOM
"""

from __future__ import annotations
import time
from collections import deque
from typing import Optional

try:
    from transformers import TrainerCallback, TrainerControl, TrainerState
    from transformers.training_args import TrainingArguments
except ImportError:
    # Stubs so the module can be imported without transformers installed.
    # The actual classes are used at runtime when transformers IS present.
    TrainerCallback = object  # type: ignore[assignment,misc]
    TrainerControl = object   # type: ignore[assignment,misc]
    TrainerState = object     # type: ignore[assignment,misc]
    TrainingArguments = object  # type: ignore[assignment,misc]


class CpuProgressCallback(TrainerCallback):
    """
    Replaces the default progress bar with CPU-friendly output.

    The default tqdm bar assumes GPU speeds (milliseconds/step).
    On CPU, steps take seconds to minutes, so we show:
      - time per step (rolling average of last 20 steps)
      - elapsed time
      - ETA in human-readable form (3h20m, not seconds)
    """

    def on_train_begin(
        self,
        args: TrainingArguments,
        state: TrainerState,
        control: TrainerControl,
        **kwargs,
    ):
        self._step_times: deque[float] = deque(maxlen=20)
        self._step_start: Optional[float] = None
        self._train_start = time.time()

        print("\n" + "─" * 60)
        print("  Axon CPU Training Started")
        print(f"  Total steps   : {state.max_steps}")
        print(f"  Steps/epoch   : {state.num_update_steps_per_epoch}")
        print("─" * 60)

    def on_step_begin(
        self,
        args: TrainingArguments,
        state: TrainerState,
        control: TrainerControl,
        **kwargs,
    ):
        self._step_start = time.time()

    def on_step_end(
        self,
        args: TrainingArguments,
        state: TrainerState,
        control: TrainerControl,
        **kwargs,
    ):
        if self._step_start is not None:
            self._step_times.append(time.time() - self._step_start)

    def on_log(
        self,
        args: TrainingArguments,
        state: TrainerState,
        control: TrainerControl,
        logs: Optional[dict] = None,
        **kwargs,
    ):
        if not self._step_times or state.global_step == 0:
            return

        avg_step = sum(self._step_times) / len(self._step_times)
        remaining = state.max_steps - state.global_step
        eta_s = avg_step * remaining
        elapsed_s = time.time() - self._train_start

        loss_str = f"  loss={logs.get('loss', '?'):.4f}" if logs and "loss" in logs else ""
        lr_str   = f"  lr={logs.get('learning_rate', '?'):.2e}" if logs and "learning_rate" in logs else ""

        print(
            f"  [{state.global_step:>5}/{state.max_steps}]"
            f"  {avg_step:5.1f}s/step"
            f"  elapsed={_fmt_time(elapsed_s)}"
            f"  ETA={_fmt_time(eta_s)}"
            f"{loss_str}{lr_str}"
        )

    def on_train_end(
        self,
        args: TrainingArguments,
        state: TrainerState,
        control: TrainerControl,
        **kwargs,
    ):
        elapsed = time.time() - self._train_start
        print("─" * 60)
        print(f"  Training complete. Total time: {_fmt_time(elapsed)}")
        print("─" * 60)


class MemoryMonitorCallback(TrainerCallback):
    """
    Watches system RAM and warns if we're approaching the limit.

    On CPU, there's no CUDA OOM exception — the system will start swapping
    to disk (making training 100× slower) or the process gets killed.
    This callback warns early enough to do something about it.
    """

    def __init__(self, warn_threshold_fraction: float = 0.90):
        """
        warn_threshold_fraction: warn when RAM usage exceeds this fraction of total.
        Default 0.90 = warn at 90% RAM usage.
        """
        self._threshold = warn_threshold_fraction
        self._warned = False
        self._check_interval = 10  # check every N steps

    def on_step_end(
        self,
        args: TrainingArguments,
        state: TrainerState,
        control: TrainerControl,
        **kwargs,
    ):
        if state.global_step % self._check_interval != 0:
            return

        try:
            import psutil
            mem = psutil.virtual_memory()
            used_fraction = mem.percent / 100.0
            used_gb  = mem.used    / (1 << 30)
            total_gb = mem.total   / (1 << 30)
            avail_gb = mem.available / (1 << 30)

            if used_fraction >= self._threshold and not self._warned:
                print(
                    f"\n  ⚠  RAM WARNING: {used_gb:.1f}/{total_gb:.1f} GB used "
                    f"({mem.percent:.0f}%). Only {avail_gb:.1f} GB available.\n"
                    "     If training slows drastically, it may be swapping to disk.\n"
                    "     Consider: reducing max_seq_length or gradient_accumulation_steps."
                )
                self._warned = True

            elif used_fraction < self._threshold * 0.95:
                self._warned = False  # reset warning if memory freed up

        except ImportError:
            pass  # psutil not available


def _fmt_time(seconds: float) -> str:
    """Format seconds into a human-readable string: 1h23m, 45m12s, 8s."""
    s = int(seconds)
    h, remainder = divmod(s, 3600)
    m, sec = divmod(remainder, 60)
    if h > 0:
        return f"{h}h{m:02d}m"
    if m > 0:
        return f"{m}m{sec:02d}s"
    return f"{sec}s"
