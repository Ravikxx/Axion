#include "axon/hardware.h"

#include <fstream>
#include <sstream>
#include <string>
#include <set>
#include <unistd.h>      // sysconf
#include <sys/sysinfo.h> // sysinfo for RAM

// On x86/x86-64, CPUID is a special instruction that asks the CPU
// to report its capabilities. cpuid.h gives us a safe wrapper for it.
#if defined(__x86_64__) || defined(__i386__)
#  include <cpuid.h>
#  define AXON_X86 1
#endif

namespace axon {

// ---------- CPUID feature detection ----------

static CpuFeatures detect_cpu_features() {
    CpuFeatures f;
#ifdef AXON_X86
    unsigned int eax, ebx, ecx, edx;

    // Leaf 1: basic features (AVX, FMA)
    if (__get_cpuid(1, &eax, &ebx, &ecx, &edx)) {
        f.avx = (ecx >> 28) & 1;  // bit 28 of ECX
        f.fma = (ecx >> 12) & 1;  // bit 12 of ECX
    }

    // Leaf 7, subleaf 0: extended features (AVX2, AVX-512, BMI2)
    // __get_cpuid_count is the version that supports subleaves.
    if (__get_cpuid_count(7, 0, &eax, &ebx, &ecx, &edx)) {
        f.avx2    = (ebx >> 5)  & 1;  // bit 5  of EBX
        f.avx512f = (ebx >> 16) & 1;  // bit 16 of EBX
        f.bmi2    = (ebx >> 8)  & 1;  // bit 8  of EBX
    }
#endif
    return f;
}

// ---------- CPU name from /proc/cpuinfo ----------

static std::string read_cpu_name() {
    std::ifstream f("/proc/cpuinfo");
    std::string line;
    while (std::getline(f, line)) {
        if (line.rfind("model name", 0) == 0) {
            auto pos = line.find(':');
            if (pos != std::string::npos) {
                auto name = line.substr(pos + 2);
                // Trim leading/trailing whitespace
                while (!name.empty() && (name.front() == ' ' || name.front() == '\t'))
                    name.erase(name.begin());
                return name;
            }
        }
    }
    return "Unknown CPU";
}

// ---------- Physical core count ----------
// /proc/cpuinfo lists every logical CPU. "core id" tells which physical core
// it belongs to. We count unique (physical id, core id) pairs.

static int count_physical_cores() {
    std::ifstream f("/proc/cpuinfo");
    std::string line;
    std::set<std::pair<int,int>> seen;
    int phys_id = 0, core_id = 0;

    auto parse_int = [](const std::string& s) -> int {
        auto pos = s.find(':');
        if (pos == std::string::npos) return 0;
        return std::stoi(s.substr(pos + 1));
    };

    while (std::getline(f, line)) {
        if (line.rfind("physical id", 0) == 0) phys_id = parse_int(line);
        if (line.rfind("core id",     0) == 0) core_id = parse_int(line);
        if (line.empty())  // blank line = end of one CPU block
            seen.insert({phys_id, core_id});
    }
    return seen.empty() ? 1 : static_cast<int>(seen.size());
}

// ---------- Cache info from /sys ----------
// Each CPU's cache hierarchy is exposed under:
//   /sys/devices/system/cpu/cpu0/cache/index<N>/
// Fields: level (1/2/3), type (Data/Instruction/Unified), size ("32K", "512K", "16384K")

static uint32_t parse_cache_size_kb(const std::string& path) {
    std::ifstream f(path);
    std::string s;
    if (!std::getline(f, s) || s.empty()) return 0;
    uint32_t val = std::stoul(s);
    if (s.back() == 'K') return val;
    if (s.back() == 'M') return val * 1024;
    return val / 1024;  // assume bytes
}

static std::string read_file_line(const std::string& path) {
    std::ifstream f(path);
    std::string s;
    std::getline(f, s);
    return s;
}

static CacheInfo detect_cache_info() {
    CacheInfo c;
    for (int idx = 0; idx < 8; ++idx) {
        std::string base = "/sys/devices/system/cpu/cpu0/cache/index"
                         + std::to_string(idx) + "/";
        std::string level_str = read_file_line(base + "level");
        std::string type_str  = read_file_line(base + "type");
        if (level_str.empty()) break;

        int level = std::stoi(level_str);
        uint32_t size_kb = parse_cache_size_kb(base + "size");

        if (level == 1 && type_str == "Data") c.l1d_kb = size_kb;
        if (level == 2)                       c.l2_kb  = size_kb;
        if (level == 3)                       c.l3_kb  = size_kb;
    }
    return c;
}

// ---------- RAM from sysinfo ----------

static void detect_ram(uint64_t& total, uint64_t& avail) {
    struct sysinfo si{};
    if (sysinfo(&si) == 0) {
        total = static_cast<uint64_t>(si.totalram)  * si.mem_unit;
        avail = static_cast<uint64_t>(si.freeram
                                    + si.bufferram) * si.mem_unit;
    }
    // Also read MemAvailable from /proc/meminfo (more accurate than freeram)
    std::ifstream f("/proc/meminfo");
    std::string line;
    while (std::getline(f, line)) {
        if (line.rfind("MemAvailable:", 0) == 0) {
            std::istringstream ss(line.substr(13));
            uint64_t kb; ss >> kb;
            avail = kb * 1024;
            break;
        }
    }
}

// ---------- Public API ----------

HardwareProfile detect_hardware() {
    HardwareProfile p;
    p.cpu_name      = read_cpu_name();
    p.features      = detect_cpu_features();
    p.cache         = detect_cache_info();
    p.physical_cores = count_physical_cores();
    p.logical_cores  = static_cast<int>(sysconf(_SC_NPROCESSORS_ONLN));
    detect_ram(p.total_ram_bytes, p.avail_ram_bytes);

    // Discrete GPU detection: check if any DRM device is NOT an integrated one.
    // For the Ryzen 5825U (iGPU only), this will correctly return false.
    // We look for a CUDA device via /proc/driver/nvidia/gpus or ROCm via /sys/class/kfd.
    {
        std::ifstream nvidia("/proc/driver/nvidia/gpus");
        if (nvidia.good()) {
            // nvidia driver present — there's a discrete GPU
            p.has_discrete_gpu = true;
            // Try to read VRAM from /proc/driver/nvidia/gpus/<id>/information
            // (simplified — a full implementation would enumerate all GPUs)
        }
    }
    {
        std::ifstream rocm("/sys/class/kfd/kfd/topology/nodes/1/gpu_id");
        if (rocm.good() && !p.has_discrete_gpu) {
            // ROCm KFD present. Integrated AMD GPUs also show up here,
            // so we check if it has dedicated VRAM via /vram_size.
            std::ifstream vram("/sys/class/kfd/kfd/topology/nodes/1/mem_banks/0/size_in_bytes");
            uint64_t vram_bytes = 0;
            vram >> vram_bytes;
            // Integrated GPUs have 0 or very small dedicated VRAM
            if (vram_bytes > 512ULL * 1024 * 1024) {
                p.has_discrete_gpu = true;
                p.gpu_vram_bytes   = vram_bytes;
            }
        }
    }

    return p;
}

std::string hardware_summary(const HardwareProfile& p) {
    auto bytes_to_gb = [](uint64_t b) -> double {
        return static_cast<double>(b) / (1024.0 * 1024.0 * 1024.0);
    };

    std::ostringstream ss;
    ss << "=== Axon Hardware Profile ===\n"
       << "CPU:     " << p.cpu_name << "\n"
       << "Cores:   " << p.physical_cores << " physical / "
                      << p.logical_cores  << " logical\n"
       << "RAM:     " << bytes_to_gb(p.total_ram_bytes) << " GB total, "
                      << bytes_to_gb(p.avail_ram_bytes) << " GB available\n"
       << "Cache:   L1d=" << p.cache.l1d_kb << "KB  "
                          << "L2="  << p.cache.l2_kb  << "KB  "
                          << "L3="  << p.cache.l3_kb  << "KB\n"
       << "SIMD:    AVX="  << p.features.avx
               << " AVX2=" << p.features.avx2
               << " FMA="  << p.features.fma
               << " AVX512=" << p.features.avx512f << "\n"
       << "GPU:     " << (p.has_discrete_gpu
                          ? "Discrete GPU detected"
                          : "No discrete GPU (CPU-only mode)") << "\n";
    return ss.str();
}

} // namespace axon
