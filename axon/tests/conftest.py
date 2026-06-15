"""
Shared pytest fixtures.
No GPU, no model downloads — all tests run offline with minimal dependencies.
"""
import pytest


@pytest.fixture
def ryzen_5825u_profile():
    """Simulated hardware profile for Ryzen 7 5825U with 16GB RAM."""
    from axon.hardware import HardwareProfile
    return HardwareProfile(
        cpu_name        = "AMD Ryzen 7 5825U with Radeon Graphics",
        physical_cores  = 8,
        logical_cores   = 16,
        total_ram_gb    = 15.3,
        avail_ram_gb    = 12.0,
        l1d_kb          = 32,
        l2_kb           = 512,
        l3_kb           = 16384,
        has_avx2        = True,
        has_avx512      = False,
        has_fma         = True,
        has_discrete_gpu = False,
        gpu_vram_gb     = 0.0,
        source          = "fixture",
    )


@pytest.fixture
def workstation_profile():
    """High-RAM workstation: 128GB, discrete GPU."""
    from axon.hardware import HardwareProfile
    return HardwareProfile(
        cpu_name        = "Intel Core i9-13900K",
        physical_cores  = 24,
        logical_cores   = 32,
        total_ram_gb    = 128.0,
        avail_ram_gb    = 110.0,
        l1d_kb          = 48,
        l2_kb           = 2048,
        l3_kb           = 36864,
        has_avx2        = True,
        has_avx512      = True,
        has_fma         = True,
        has_discrete_gpu = True,
        gpu_vram_gb     = 24.0,
        gpu_name        = "NVIDIA RTX 4090",
        source          = "fixture",
    )
