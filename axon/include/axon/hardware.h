#pragma once
#include <string>
#include <cstdint>

// C++ "header files" (.h) declare what functions and data structures exist.
// The actual implementation lives in src/hardware.cpp.
// This lets other files use these types without knowing the implementation details.

namespace axon {

struct CpuFeatures {
    bool avx      = false;  // AVX  (2011+, almost universal)
    bool avx2     = false;  // AVX2 (2013+, Ryzen 5825U has this)
    bool avx512f  = false;  // AVX-512 (Zen 4 / recent Intel — 5825U does NOT have this)
    bool fma      = false;  // Fused Multiply-Add (faster a*b+c — 5825U has this)
    bool bmi2     = false;  // Bit manipulation instructions
};

struct CacheInfo {
    uint32_t l1d_kb = 0;   // L1 data cache per core (KB)
    uint32_t l2_kb  = 0;   // L2 cache per core (KB)
    uint32_t l3_kb  = 0;   // L3 cache shared across all cores (KB)
};

// Full picture of what hardware is available
struct HardwareProfile {
    std::string  cpu_name;
    int          physical_cores   = 0;   // actual CPU cores (not hyperthreads)
    int          logical_cores    = 0;   // hyperthreads included
    uint64_t     total_ram_bytes  = 0;
    uint64_t     avail_ram_bytes  = 0;
    CpuFeatures  features;
    CacheInfo    cache;

    // GPU — empty/false on Ryzen iGPU (shared memory, no separate VRAM pool)
    bool         has_discrete_gpu = false;
    uint64_t     gpu_vram_bytes   = 0;
    std::string  gpu_name;
};

HardwareProfile detect_hardware();

// Returns a human-readable summary string, e.g. for printing at startup
std::string hardware_summary(const HardwareProfile& p);

} // namespace axon
