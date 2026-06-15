"""
Hardware detection with two paths:
  1. Fast path: calls the C++ axon_core module (accurate CPUID data)
  2. Fallback: pure Python via psutil + /proc (works without building C++)

The fallback lets people use Axon's Python API immediately without having
to compile the C++ extension first.
"""

from __future__ import annotations
import os
import platform
from dataclasses import dataclass, field
from typing import Optional

# Try to import the compiled C++ extension
try:
    import axon_core as _core
    _CPP_AVAILABLE = True
except ImportError:
    _CPP_AVAILABLE = False


@dataclass
class HardwareProfile:
    cpu_name:        str   = "Unknown"
    physical_cores:  int   = 1
    logical_cores:   int   = 1
    total_ram_gb:    float = 0.0
    avail_ram_gb:    float = 0.0
    l1d_kb:          int   = 0
    l2_kb:           int   = 0
    l3_kb:           int   = 0
    has_avx2:        bool  = False
    has_avx512:      bool  = False
    has_fma:         bool  = False
    has_discrete_gpu: bool = False
    gpu_vram_gb:     float = 0.0
    gpu_name:        str   = ""
    source:          str   = "unknown"  # "cpp" or "python_fallback"

    def summary(self) -> str:
        lines = [
            "=== Axon Hardware Profile ===",
            f"CPU:     {self.cpu_name}",
            f"Cores:   {self.physical_cores} physical / {self.logical_cores} logical",
            f"RAM:     {self.total_ram_gb:.1f} GB total, {self.avail_ram_gb:.1f} GB available",
            f"Cache:   L1d={self.l1d_kb}KB  L2={self.l2_kb}KB  L3={self.l3_kb}KB",
            f"SIMD:    AVX2={self.has_avx2}  FMA={self.has_fma}  AVX-512={self.has_avx512}",
            f"GPU:     {'Discrete GPU - ' + self.gpu_name if self.has_discrete_gpu else 'No discrete GPU (CPU-only mode)'}",
        ]
        return "\n".join(lines)


def _detect_via_cpp() -> HardwareProfile:
    p = _core.detect_hardware()
    GB = 1 << 30
    return HardwareProfile(
        cpu_name        = p.cpu_name,
        physical_cores  = p.physical_cores,
        logical_cores   = p.logical_cores,
        total_ram_gb    = p.total_ram_bytes / GB,
        avail_ram_gb    = p.avail_ram_bytes / GB,
        l1d_kb          = p.cache.l1d_kb,
        l2_kb           = p.cache.l2_kb,
        l3_kb           = p.cache.l3_kb,
        has_avx2        = p.features.avx2,
        has_avx512      = p.features.avx512f,
        has_fma         = p.features.fma,
        has_discrete_gpu = p.has_discrete_gpu,
        gpu_vram_gb     = p.gpu_vram_bytes / GB,
        source          = "cpp",
    )


def _detect_via_python() -> HardwareProfile:
    """Pure-Python fallback using psutil and /proc."""
    import psutil

    # RAM
    mem = psutil.virtual_memory()
    total_gb = mem.total    / (1 << 30)
    avail_gb = mem.available / (1 << 30)

    # Cores
    logical  = psutil.cpu_count(logical=True)  or 1
    physical = psutil.cpu_count(logical=False) or max(1, logical // 2)

    # CPU name
    cpu_name = "Unknown"
    try:
        with open("/proc/cpuinfo") as f:
            for line in f:
                if line.startswith("model name"):
                    cpu_name = line.split(":", 1)[1].strip()
                    break
    except OSError:
        cpu_name = platform.processor() or "Unknown"

    # SIMD flags from /proc/cpuinfo
    has_avx2 = has_avx512 = has_fma = False
    try:
        with open("/proc/cpuinfo") as f:
            for line in f:
                if line.startswith("flags"):
                    flags = line.split(":", 1)[1].split()
                    has_avx2   = "avx2"    in flags
                    has_avx512 = "avx512f" in flags
                    has_fma    = "fma"     in flags
                    break
    except OSError:
        pass

    # Cache info
    l1d_kb = l2_kb = l3_kb = 0
    try:
        base = "/sys/devices/system/cpu/cpu0/cache"
        for idx in range(8):
            p = f"{base}/index{idx}"
            try:
                level = open(f"{p}/level").read().strip()
                ctype = open(f"{p}/type").read().strip()
                size_str = open(f"{p}/size").read().strip()
                size_kb = int(size_str.rstrip("K")) if size_str.endswith("K") else int(size_str) // 1024
                if level == "1" and ctype == "Data": l1d_kb = size_kb
                if level == "2":                      l2_kb  = size_kb
                if level == "3":                      l3_kb  = size_kb
            except (OSError, ValueError):
                break
    except OSError:
        pass

    # Discrete GPU detection (basic)
    has_discrete_gpu = False
    gpu_name = ""
    gpu_vram_gb = 0.0
    try:
        import torch
        if torch.cuda.is_available():
            has_discrete_gpu = True
            idx = torch.cuda.current_device()
            gpu_name    = torch.cuda.get_device_name(idx)
            gpu_vram_gb = torch.cuda.get_device_properties(idx).total_memory / (1 << 30)
    except (ImportError, Exception):
        pass

    return HardwareProfile(
        cpu_name         = cpu_name,
        physical_cores   = physical,
        logical_cores    = logical,
        total_ram_gb     = total_gb,
        avail_ram_gb     = avail_gb,
        l1d_kb           = l1d_kb,
        l2_kb            = l2_kb,
        l3_kb            = l3_kb,
        has_avx2         = has_avx2,
        has_avx512       = has_avx512,
        has_fma          = has_fma,
        has_discrete_gpu = has_discrete_gpu,
        gpu_vram_gb      = gpu_vram_gb,
        gpu_name         = gpu_name,
        source           = "python_fallback",
    )


_cached_profile: Optional[HardwareProfile] = None


def detect_hardware(force_refresh: bool = False) -> HardwareProfile:
    """Detect hardware. Result is cached after the first call."""
    global _cached_profile
    if _cached_profile is None or force_refresh:
        _cached_profile = _detect_via_cpp() if _CPP_AVAILABLE else _detect_via_python()
    return _cached_profile


def is_cpp_available() -> bool:
    return _CPP_AVAILABLE
