"""Tests for the memory planner — no model loading required."""
import pytest
from axon.memory import plan, _model_gb, _lora_gb, _optimizer_gb


class TestModelGb:
    def test_8b_4bit(self):
        # 8B params × 0.5 bytes = 4GB, plus quantization overhead
        gb = _model_gb(8.0, bits=4)
        assert 3.5 < gb < 6.0, f"Expected ~4-5GB, got {gb:.2f}GB"

    def test_8b_16bit(self):
        # 8B × 2 bytes = 16GB
        gb = _model_gb(8.0, bits=16)
        assert 14.0 < gb < 18.0

    def test_bits_scale(self):
        # 8-bit should be 2x larger than 4-bit
        gb4  = _model_gb(8.0, bits=4)
        gb8  = _model_gb(8.0, bits=8)
        gb16 = _model_gb(8.0, bits=16)
        assert abs(gb8 / gb4 - 2.0) < 0.1
        assert abs(gb16 / gb8 - 2.0) < 0.1


class TestLoraGb:
    def test_rank_scales_linearly(self):
        gb8  = _lora_gb(8.0, rank=8)
        gb16 = _lora_gb(8.0, rank=16)
        gb32 = _lora_gb(8.0, rank=32)
        assert abs(gb16 / gb8  - 2.0) < 0.2
        assert abs(gb32 / gb16 - 2.0) < 0.2

    def test_lora_much_smaller_than_model(self):
        model_gb = _model_gb(8.0, bits=4)
        lora_gb  = _lora_gb(8.0, rank=16)
        assert lora_gb < model_gb / 10, "LoRA should be < 10% of model size"

    def test_optimizer_is_2x_lora(self):
        lora = _lora_gb(8.0, rank=16)
        opt  = _optimizer_gb(lora)
        assert abs(opt / lora - 2.0) < 0.01


class TestPlan:
    def test_8b_fits_16gb(self):
        p = plan(params_b=8.0, available_gb=16.0)
        assert p.will_fit, f"8B model should fit in 16GB. Got: {p.est_total_gb:.1f}GB estimated"
        assert p.est_total_gb < 16.0

    def test_8b_fits_uses_4bit(self):
        p = plan(params_b=8.0, available_gb=16.0)
        assert p.quantization_bits == 4

    def test_12b_fits_16gb(self):
        p = plan(params_b=12.0, available_gb=16.0)
        assert p.will_fit, f"12B model should fit in 16GB with tight settings"

    def test_70b_does_not_fit_16gb(self):
        p = plan(params_b=70.0, available_gb=16.0)
        assert not p.will_fit

    def test_more_ram_allows_higher_rank(self):
        small = plan(params_b=8.0, available_gb=12.0)
        large = plan(params_b=8.0, available_gb=64.0)
        # More RAM → planner can afford higher LoRA rank
        assert large.lora_rank >= small.lora_rank

    def test_more_ram_allows_longer_seq(self):
        tight  = plan(params_b=8.0, available_gb=10.0)
        roomy  = plan(params_b=8.0, available_gb=64.0)
        assert roomy.max_seq_length >= tight.max_seq_length

    def test_total_includes_all_components(self):
        p = plan(params_b=8.0, available_gb=16.0)
        component_sum = (
            p.est_model_gb
            + p.est_lora_gb
            + p.est_optimizer_gb
            + p.est_activations_gb
        )
        # est_total_gb includes OS overhead on top of components
        assert p.est_total_gb > component_sum

    def test_safety_margin_respected(self):
        p = plan(params_b=8.0, available_gb=16.0, safety_margin=0.88)
        assert p.est_total_gb <= 16.0 * 0.88 + 3.0  # +3 for OS overhead

    def test_will_fit_false_has_useful_plan(self):
        p = plan(params_b=70.0, available_gb=16.0)
        assert not p.will_fit
        # Even when it won't fit, we return the best attempt
        assert p.quantization_bits == 4
        assert p.lora_rank >= 1

    def test_describe_contains_key_info(self):
        p = plan(params_b=8.0, available_gb=16.0)
        desc = p.describe()
        assert "4-bit" in desc or str(p.quantization_bits) in desc
        assert str(p.lora_rank) in desc
        assert str(p.max_seq_length) in desc

    @pytest.mark.parametrize("params_b", [3.0, 7.0, 8.0, 12.0, 13.0])
    def test_plan_never_crashes(self, params_b):
        p = plan(params_b=params_b, available_gb=16.0)
        assert p is not None
        assert p.est_total_gb > 0
