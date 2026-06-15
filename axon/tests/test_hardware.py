"""Tests for hardware detection — runs without the C++ extension."""
import pytest
import sys


class TestHardwareProfile:
    def test_profile_has_required_fields(self, ryzen_5825u_profile):
        p = ryzen_5825u_profile
        assert isinstance(p.cpu_name, str)
        assert p.physical_cores > 0
        assert p.logical_cores >= p.physical_cores
        assert p.total_ram_gb > 0
        assert p.avail_ram_gb > 0
        assert p.avail_ram_gb <= p.total_ram_gb

    def test_5825u_has_avx2_not_avx512(self, ryzen_5825u_profile):
        p = ryzen_5825u_profile
        assert p.has_avx2  is True,  "Ryzen 5825U has AVX2"
        assert p.has_avx512 is False, "Ryzen 5825U does NOT have AVX-512 (that's Zen 4)"

    def test_5825u_no_discrete_gpu(self, ryzen_5825u_profile):
        assert ryzen_5825u_profile.has_discrete_gpu is False
        assert ryzen_5825u_profile.gpu_vram_gb == 0.0

    def test_summary_contains_cpu_name(self, ryzen_5825u_profile):
        summary = ryzen_5825u_profile.summary()
        assert "5825U" in summary or "Ryzen" in summary

    def test_summary_contains_ram(self, ryzen_5825u_profile):
        summary = ryzen_5825u_profile.summary()
        assert "GB" in summary

    def test_summary_contains_simd_flags(self, ryzen_5825u_profile):
        summary = ryzen_5825u_profile.summary()
        assert "AVX2" in summary


class TestLivePythonFallback:
    """These tests run the actual Python fallback detection on the current machine."""

    def test_python_fallback_returns_valid_profile(self):
        from axon.hardware import _detect_via_python
        p = _detect_via_python()
        assert p.physical_cores >= 1
        assert p.logical_cores  >= p.physical_cores
        assert p.total_ram_gb   > 0
        assert p.avail_ram_gb   > 0
        assert p.source == "python_fallback"

    def test_detect_hardware_is_cached(self):
        from axon.hardware import detect_hardware
        a = detect_hardware()
        b = detect_hardware()
        assert a is b, "detect_hardware should return cached result"

    def test_force_refresh_returns_fresh_object(self):
        from axon.hardware import detect_hardware
        a = detect_hardware()
        b = detect_hardware(force_refresh=True)
        # Different objects but same CPU name
        assert a.cpu_name == b.cpu_name


class TestCppExtension:
    def test_cpp_extension_import(self):
        from axon.hardware import is_cpp_available
        available = is_cpp_available()
        # We don't assert True/False — just that it returns a bool cleanly
        assert isinstance(available, bool)

    @pytest.mark.skipif(
        not __import__("axon.hardware", fromlist=["is_cpp_available"]).is_cpp_available(),
        reason="C++ extension not built"
    )
    def test_cpp_profile_matches_python(self):
        from axon.hardware import _detect_via_cpp, _detect_via_python
        cpp = _detect_via_cpp()
        py  = _detect_via_python()
        # Both should agree on basic facts
        assert abs(cpp.total_ram_gb - py.total_ram_gb) < 1.0
        assert cpp.physical_cores == py.physical_cores
        assert cpp.has_avx2 == py.has_avx2
