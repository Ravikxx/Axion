"""Tests for AxonConfig — no model loading required."""
import pytest
from axon.config import AxonConfig


class TestAxonConfigDefaults:
    def test_default_quantization(self):
        c = AxonConfig(model_name_or_path="test")
        assert c.load_in_4bit is True
        assert c.bnb_4bit_quant_type == "nf4"

    def test_default_lora(self):
        c = AxonConfig(model_name_or_path="test")
        assert c.lora_r == 16
        assert c.lora_alpha == 32  # alpha = 2 × r by convention

    def test_default_training(self):
        c = AxonConfig(model_name_or_path="test")
        assert c.per_device_train_batch_size == 1
        assert c.gradient_checkpointing is True

    def test_cpu_defaults(self):
        c = AxonConfig(model_name_or_path="test")
        assert c.fp16 is False, "fp16 not recommended on CPU"
        assert c.bf16 is True,  "bf16 is native on Zen 3"
        assert c.dataloader_num_workers == 0


class TestAxonConfigAuto:
    def test_auto_8b_16gb(self):
        c = AxonConfig.auto("test/model", params_b=8.0, available_ram_gb=16.0)
        assert c.load_in_4bit is True
        assert c.lora_r >= 4
        assert c.max_seq_length >= 256

    def test_auto_12b_16gb(self):
        c = AxonConfig.auto("test/model", params_b=12.0, available_ram_gb=16.0)
        assert c.load_in_4bit is True
        # Tight fit — planner may reduce rank or seq_len
        assert c.lora_r >= 4

    def test_auto_more_ram_higher_rank(self):
        c_16 = AxonConfig.auto("test/model", params_b=8.0, available_ram_gb=16.0)
        c_64 = AxonConfig.auto("test/model", params_b=8.0, available_ram_gb=64.0)
        assert c_64.lora_r >= c_16.lora_r

    def test_auto_more_ram_longer_seq(self):
        c_12 = AxonConfig.auto("test/model", params_b=8.0, available_ram_gb=12.0)
        c_64 = AxonConfig.auto("test/model", params_b=8.0, available_ram_gb=64.0)
        assert c_64.max_seq_length >= c_12.max_seq_length

    def test_auto_respects_overrides(self):
        c = AxonConfig.auto(
            "test/model",
            params_b=8.0,
            available_ram_gb=16.0,
            num_train_epochs=10,
            learning_rate=1e-3,
        )
        assert c.num_train_epochs == 10
        assert abs(c.learning_rate - 1e-3) < 1e-10

    def test_auto_raises_on_unknown_field(self):
        with pytest.raises(ValueError, match="Unknown AxonConfig field"):
            AxonConfig.auto("test/model", available_ram_gb=16.0,
                            definitely_not_a_real_field=42)

    def test_auto_model_name_set(self):
        c = AxonConfig.auto("meta-llama/Llama-3.2-8B", available_ram_gb=16.0)
        assert c.model_name_or_path == "meta-llama/Llama-3.2-8B"


class TestAxonConfigMemoryReport:
    def test_report_returns_string(self):
        c = AxonConfig.auto("test/model", params_b=8.0, available_ram_gb=16.0)
        report = c.memory_report(params_b=8.0)
        assert isinstance(report, str)
        assert len(report) > 50

    def test_report_contains_gb(self):
        c = AxonConfig.auto("test/model", params_b=8.0, available_ram_gb=16.0)
        report = c.memory_report(params_b=8.0)
        assert "GB" in report
