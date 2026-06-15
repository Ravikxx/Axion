"""Tests for training callbacks — no training loop needed."""
import time
import pytest
from unittest.mock import MagicMock, patch


def make_state(global_step=10, max_steps=100, num_update_steps_per_epoch=50):
    state = MagicMock()
    state.global_step = global_step
    state.max_steps = max_steps
    state.num_update_steps_per_epoch = num_update_steps_per_epoch
    return state


def make_args():
    return MagicMock()


class TestFmtTime:
    def test_seconds(self):
        from axon.callbacks import _fmt_time
        assert _fmt_time(8) == "8s"

    def test_minutes(self):
        from axon.callbacks import _fmt_time
        assert _fmt_time(75)   == "1m15s"
        assert _fmt_time(3599) == "59m59s"

    def test_hours(self):
        from axon.callbacks import _fmt_time
        assert _fmt_time(3600) == "1h00m"
        assert _fmt_time(5400) == "1h30m"
        assert _fmt_time(7260) == "2h01m"

    def test_zero(self):
        from axon.callbacks import _fmt_time
        assert _fmt_time(0) == "0s"


class TestCpuProgressCallback:
    def test_on_train_begin_prints(self, capsys):
        from axon.callbacks import CpuProgressCallback
        cb = CpuProgressCallback()
        cb.on_train_begin(make_args(), make_state(), MagicMock())
        out = capsys.readouterr().out
        assert "Axon" in out
        assert "100" in out  # max_steps

    def test_on_log_prints_step_info(self, capsys):
        from axon.callbacks import CpuProgressCallback
        cb = CpuProgressCallback()
        cb.on_train_begin(make_args(), make_state(), MagicMock())

        # Simulate a few steps
        for _ in range(5):
            cb.on_step_begin(make_args(), make_state(), MagicMock())
            time.sleep(0.01)
            cb.on_step_end(make_args(), make_state(), MagicMock())

        cb.on_log(make_args(), make_state(global_step=5), MagicMock(),
                  logs={"loss": 2.345, "learning_rate": 2e-4})
        out = capsys.readouterr().out
        assert "5/100" in out
        assert "ETA" in out

    def test_on_log_no_crash_without_steps(self, capsys):
        from axon.callbacks import CpuProgressCallback
        cb = CpuProgressCallback()
        cb.on_train_begin(make_args(), make_state(), MagicMock())
        # Call on_log immediately without any steps recorded
        cb.on_log(make_args(), make_state(global_step=0), MagicMock(), logs={})
        # Should not raise

    def test_on_train_end_prints_total(self, capsys):
        from axon.callbacks import CpuProgressCallback
        cb = CpuProgressCallback()
        cb.on_train_begin(make_args(), make_state(), MagicMock())
        time.sleep(0.05)
        cb.on_train_end(make_args(), make_state(), MagicMock())
        out = capsys.readouterr().out
        assert "complete" in out.lower() or "training" in out.lower()


class TestMemoryMonitorCallback:
    def test_no_warning_at_low_usage(self, capsys):
        from axon.callbacks import MemoryMonitorCallback
        cb = MemoryMonitorCallback(warn_threshold_fraction=0.99)

        with patch("psutil.virtual_memory") as mock_mem:
            mock_mem.return_value = MagicMock(
                percent=50.0,
                used=8 * (1 << 30),
                total=16 * (1 << 30),
                available=8 * (1 << 30),
            )
            cb.on_step_end(make_args(), make_state(global_step=10), MagicMock())

        out = capsys.readouterr().out
        assert "WARNING" not in out

    def test_warning_at_high_usage(self, capsys):
        from axon.callbacks import MemoryMonitorCallback
        cb = MemoryMonitorCallback(warn_threshold_fraction=0.80)

        with patch("psutil.virtual_memory") as mock_mem:
            mock_mem.return_value = MagicMock(
                percent=95.0,
                used=15 * (1 << 30),
                total=16 * (1 << 30),
                available=1 * (1 << 30),
            )
            cb.on_step_end(make_args(), make_state(global_step=10), MagicMock())

        out = capsys.readouterr().out
        assert "WARNING" in out

    def test_warning_fires_only_once(self, capsys):
        from axon.callbacks import MemoryMonitorCallback
        cb = MemoryMonitorCallback(warn_threshold_fraction=0.80)

        with patch("psutil.virtual_memory") as mock_mem:
            mock_mem.return_value = MagicMock(
                percent=95.0,
                used=15 * (1 << 30),
                total=16 * (1 << 30),
                available=1 * (1 << 30),
            )
            for step in [10, 20, 30]:
                cb.on_step_end(make_args(), make_state(global_step=step), MagicMock())

        out = capsys.readouterr().out
        assert out.count("WARNING") == 1

    def test_skips_non_interval_steps(self, capsys):
        from axon.callbacks import MemoryMonitorCallback
        cb = MemoryMonitorCallback()

        with patch("psutil.virtual_memory") as mock_mem:
            mock_mem.return_value = MagicMock(percent=95.0,
                                               used=15*(1<<30),
                                               total=16*(1<<30),
                                               available=1*(1<<30))
            # Step 5 is not a multiple of check_interval (10)
            cb.on_step_end(make_args(), make_state(global_step=5), MagicMock())

        # mock should NOT have been called
        mock_mem.assert_not_called()
