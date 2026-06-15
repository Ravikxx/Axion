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
    """
    Pure-Python fallback. Works on Windows, Linux, and macOS without
    needing the compiled C++ extension.
    Uses psutil for RAM/cores, and platform-specific paths for CPU name and SIMD.
    """
    import psutil

    _is_windows = platform.system() == "Windows"
    _is_linux   = platform.system() == "Linux"

    # ── RAM ──────────────────────────────────────────────────────────────────
    mem      = psutil.virtual_memory()
    total_gb = mem.total     / (1 << 30)
    avail_gb = mem.available / (1 << 30)

    # ── Core counts ──────────────────────────────────────────────────────────
    logical  = psutil.cpu_count(logical=True)  or 1
    physical = psutil.cpu_count(logical=False) or max(1, logical // 2)

    # ── CPU name ─────────────────────────────────────────────────────────────
    cpu_name = "Unknown"
    if _is_windows:
        # Windows Registry holds the CPU brand string
        try:
            import winreg
            key = winreg.OpenKey(
                winreg.HKEY_LOCAL_MACHINE,
                r"HARDWARE\DESCRIPTION\System\CentralProcessor\0",
            )
            cpu_name = winreg.QueryValueEx(key, "ProcessorNameString")[0].strip()
            winreg.CloseKey(key)
        except Exception:
            cpu_name = platform.processor() or "Unknown"
    elif _is_linux:
        try:
            with open("/proc/cpuinfo") as f:
                for line in f:
                    if line.startswith("model name"):
                        cpu_name = line.split(":", 1)[1].strip()
                        break
        except OSError:
            cpu_name = platform.processor() or "Unknown"
    else:
        cpu_name = platform.processor() or "Unknown"

    # ── SIMD flag detection ───────────────────────────────────────────────────
    has_avx2 = has_avx512 = has_fma = False

    # Try py-cpuinfo first — works on Windows, Linux, macOS
    try:
        import cpuinfo as _cpuinfo
        info  = _cpuinfo.get_cpu_info()
        flags = info.get("flags", [])
        has_avx2   = "avx2"    in flags
        has_avx512 = "avx512f" in flags
        has_fma    = "fma"     in flags
    except ImportError:
        # Fallback: Linux-only /proc/cpuinfo
        if _is_linux:
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
        # On Windows without py-cpuinfo we can't easily read SIMD flags.
        # The C++ extension (axon_core) does this accurately; prompt the user.

    # ── Cache info ────────────────────────────────────────────────────────────
    l1d_kb = l2_kb = l3_kb = 0

    if _is_windows:
        # Read from Windows Registry performance counters (best-effort)
        try:
            import winreg
            key = winreg.OpenKey(
                winreg.HKEY_LOCAL_MACHINE,
                r"HARDWARE\DESCRIPTION\System\CentralProcessor\0",
            )
            # Some OEMs populate these; many don't. Fall back to 0 if missing.
            def _qv(k, name):
                try: return winreg.QueryValueEx(k, name)[0]
                except: return 0
            # These aren't standard registry values; just leave at 0.
            # The C++ extension reads them accurately via GetLogicalProcessorInformation.
            winreg.CloseKey(key)
        except Exception:
            pass
    elif _is_linux:
        try:
            base = "/sys/devices/system/cpu/cpu0/cache"
            for idx in range(8):
                cp = f"{base}/index{idx}"
                try:
                    level    = open(f"{cp}/level").read().strip()
                    ctype    = open(f"{cp}/type").read().strip()
                    size_str = open(f"{cp}/size").read().strip()
                    size_kb  = (int(size_str[:-1]) if size_str.endswith("K")
                                else int(size_str) // 1024)
                    if level == "1" and ctype == "Data": l1d_kb = size_kb
                    if level == "2":                      l2_kb  = size_kb
                    if level == "3":                      l3_kb  = size_kb
                except (OSError, ValueError):
                    break
        except OSError:
            pass

    # ── GPU detection ─────────────────────────────────────────────────────────
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
