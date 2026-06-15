#include "axon/hardware.h"

#include <sstream>
#include <string>
#include <cstring>

// ── Platform-specific includes ───────────────────────────────────────────────
#ifdef _WIN32
#  include <windows.h>
#  include <intrin.h>   // __cpuid / __cpuidex (MSVC + MinGW)
#  include <vector>
#else
#  include <fstream>
#  include <set>
#  include <unistd.h>
#  include <sys/sysinfo.h>
#  if defined(__x86_64__) || defined(__i386__)
#    include <cpuid.h>
#    define AXON_X86 1
#  endif
#endif

namespace axon {

// ═══════════════════════════════════════════════════════════════════════════
// Windows implementation
// ═══════════════════════════════════════════════════════════════════════════
#ifdef _WIN32

static CpuFeatures detect_cpu_features() {
    CpuFeatures f;
    int info[4];

    // Leaf 1 → ECX: bit 28 = AVX, bit 12 = FMA
    __cpuid(info, 1);
    f.avx = (info[2] >> 28) & 1;
    f.fma = (info[2] >> 12) & 1;

    // Leaf 7, subleaf 0 → EBX: bit 5 = AVX2, bit 16 = AVX-512F, bit 8 = BMI2
    __cpuidex(info, 7, 0);
    f.avx2    = (info[1] >> 5)  & 1;
    f.avx512f = (info[1] >> 16) & 1;
    f.bmi2    = (info[1] >> 8)  & 1;

    return f;
}

static std::string read_cpu_name() {
    // CPUID leaves 0x80000002–0x80000004 contain the CPU brand string.
    int info[4];
    char brand[49] = {};
    __cpuid(info, 0x80000002); std::memcpy(brand,      info, 16);
    __cpuid(info, 0x80000003); std::memcpy(brand + 16, info, 16);
    __cpuid(info, 0x80000004); std::memcpy(brand + 32, info, 16);
    std::string name = brand;
    // Trim leading whitespace (some CPUs pad with spaces)
    while (!name.empty() && name.front() == ' ') name.erase(name.begin());
    return name.empty() ? "Unknown CPU" : name;
}

static int count_physical_cores() {
    // GetLogicalProcessorInformation returns one entry per physical core
    // (Relationship == RelationProcessorCore) and one per logical CPU.
    DWORD len = 0;
    GetLogicalProcessorInformation(nullptr, &len);
    std::vector<SYSTEM_LOGICAL_PROCESSOR_INFORMATION> buf(
        len / sizeof(SYSTEM_LOGICAL_PROCESSOR_INFORMATION));
    GetLogicalProcessorInformation(buf.data(), &len);

    int cores = 0;
    for (auto& item : buf)
        if (item.Relationship == RelationProcessorCore) ++cores;
    return cores > 0 ? cores : 1;
}

static CacheInfo detect_cache_info() {
    CacheInfo c;
    DWORD len = 0;
    GetLogicalProcessorInformation(nullptr, &len);
    std::vector<SYSTEM_LOGICAL_PROCESSOR_INFORMATION> buf(
        len / sizeof(SYSTEM_LOGICAL_PROCESSOR_INFORMATION));
    GetLogicalProcessorInformation(buf.data(), &len);

    for (auto& item : buf) {
        if (item.Relationship != RelationCache) continue;
        uint32_t kb = item.Cache.Size / 1024;
        if (item.Cache.Level == 1 && item.Cache.Type == CacheData) c.l1d_kb = kb;
        if (item.Cache.Level == 2) c.l2_kb = kb;
        if (item.Cache.Level == 3) c.l3_kb = kb;
    }
    return c;
}

static void detect_ram(uint64_t& total, uint64_t& avail) {
    MEMORYSTATUSEX ms;
    ms.dwLength = sizeof(ms);
    if (GlobalMemoryStatusEx(&ms)) {
        total = ms.ullTotalPhys;
        avail = ms.ullAvailPhys;
    }
}

static void detect_gpu(HardwareProfile& p) {
    // Basic NVIDIA detection via nvml.dll presence
    HMODULE nvml = LoadLibraryA("nvml.dll");
    if (nvml) {
        p.has_discrete_gpu = true;
        p.gpu_name = "NVIDIA GPU (nvml detected)";
        FreeLibrary(nvml);
    }
    // AMD: check for amdgpu via atiadlxx.dll (Radeon Software)
    if (!p.has_discrete_gpu) {
        HMODULE amd = LoadLibraryA("atiadlxx.dll");
        if (!amd) amd = LoadLibraryA("atiadlxy.dll");  // 32-bit fallback name
        if (amd) {
            p.has_discrete_gpu = true;
            p.gpu_name = "AMD GPU (ADL detected)";
            FreeLibrary(amd);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Linux implementation
// ═══════════════════════════════════════════════════════════════════════════
#else

static CpuFeatures detect_cpu_features() {
    CpuFeatures f;
#ifdef AXON_X86
    unsigned int eax, ebx, ecx, edx;
    if (__get_cpuid(1, &eax, &ebx, &ecx, &edx)) {
        f.avx = (ecx >> 28) & 1;
        f.fma = (ecx >> 12) & 1;
    }
    if (__get_cpuid_count(7, 0, &eax, &ebx, &ecx, &edx)) {
        f.avx2    = (ebx >> 5)  & 1;
        f.avx512f = (ebx >> 16) & 1;
        f.bmi2    = (ebx >> 8)  & 1;
    }
#endif
    return f;
}

static std::string read_cpu_name() {
    std::ifstream f("/proc/cpuinfo");
    std::string line;
    while (std::getline(f, line)) {
        if (line.rfind("model name", 0) == 0) {
            auto pos = line.find(':');
            if (pos != std::string::npos) {
                auto name = line.substr(pos + 2);
                while (!name.empty() && (name.front() == ' ' || name.front() == '\t'))
                    name.erase(name.begin());
                return name;
            }
        }
    }
    return "Unknown CPU";
}

static int count_physical_cores() {
    std::ifstream f("/proc/cpuinfo");
    std::set<std::pair<int,int>> seen;
    int phys = 0, core = 0;
    std::string line;
    auto parse_int = [](const std::string& s) {
        auto p = s.find(':');
        return p == std::string::npos ? 0 : std::stoi(s.substr(p + 1));
    };
    while (std::getline(f, line)) {
        if (line.rfind("physical id", 0) == 0) phys = parse_int(line);
        if (line.rfind("core id",     0) == 0) core = parse_int(line);
        if (line.empty()) seen.insert({phys, core});
    }
    return seen.empty() ? 1 : static_cast<int>(seen.size());
}

static uint32_t parse_cache_size_kb(const std::string& path) {
    std::ifstream f(path);
    std::string s;
    if (!std::getline(f, s) || s.empty()) return 0;
    uint32_t val = std::stoul(s);
    if (!s.empty() && s.back() == 'K') return val;
    if (!s.empty() && s.back() == 'M') return val * 1024;
    return val / 1024;
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
        std::string level = read_file_line(base + "level");
        std::string type  = read_file_line(base + "type");
        if (level.empty()) break;
        uint32_t kb = parse_cache_size_kb(base + "size");
        int lv = std::stoi(level);
        if (lv == 1 && type == "Data") c.l1d_kb = kb;
        if (lv == 2)                   c.l2_kb  = kb;
        if (lv == 3)                   c.l3_kb  = kb;
    }
    return c;
}

static void detect_ram(uint64_t& total, uint64_t& avail) {
    struct sysinfo si{};
    if (sysinfo(&si) == 0) {
        total = static_cast<uint64_t>(si.totalram)  * si.mem_unit;
        avail = static_cast<uint64_t>(si.freeram + si.bufferram) * si.mem_unit;
    }
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

static void detect_gpu(HardwareProfile& p) {
    std::ifstream nvidia("/proc/driver/nvidia/gpus");
    if (nvidia.good()) {
        p.has_discrete_gpu = true;
    }
    if (!p.has_discrete_gpu) {
        std::ifstream vram("/sys/class/kfd/kfd/topology/nodes/1/mem_banks/0/size_in_bytes");
        uint64_t vram_bytes = 0;
        vram >> vram_bytes;
        if (vram_bytes > 512ULL * 1024 * 1024) {
            p.has_discrete_gpu = true;
            p.gpu_vram_bytes   = vram_bytes;
        }
    }
}

#endif // _WIN32 / Linux

// ═══════════════════════════════════════════════════════════════════════════
// Shared public API
// ═══════════════════════════════════════════════════════════════════════════

HardwareProfile detect_hardware() {
    HardwareProfile p;
    p.cpu_name       = read_cpu_name();
    p.features       = detect_cpu_features();
    p.cache          = detect_cache_info();
    p.physical_cores = count_physical_cores();

#ifdef _WIN32
    {
        SYSTEM_INFO si{};
        GetSystemInfo(&si);
        p.logical_cores = static_cast<int>(si.dwNumberOfProcessors);
    }
#else
    p.logical_cores = static_cast<int>(sysconf(_SC_NPROCESSORS_ONLN));
#endif

    detect_ram(p.total_ram_bytes, p.avail_ram_bytes);
    detect_gpu(p);
    return p;
}

std::string hardware_summary(const HardwareProfile& p) {
    auto to_gb = [](uint64_t b) { return static_cast<double>(b) / (1024.0*1024.0*1024.0); };
    std::ostringstream ss;
    ss << "=== Axon Hardware Profile ===\n"
       << "CPU:     " << p.cpu_name << "\n"
       << "Cores:   " << p.physical_cores << " physical / " << p.logical_cores << " logical\n"
       << "RAM:     " << to_gb(p.total_ram_bytes) << " GB total, "
                      << to_gb(p.avail_ram_bytes)  << " GB available\n"
       << "Cache:   L1d=" << p.cache.l1d_kb << "KB  "
                          << "L2="  << p.cache.l2_kb  << "KB  "
                          << "L3="  << p.cache.l3_kb  << "KB\n"
       << "SIMD:    AVX="   << p.features.avx
               << " AVX2="  << p.features.avx2
               << " FMA="   << p.features.fma
               << " AVX512="<< p.features.avx512f << "\n"
       << "GPU:     " << (p.has_discrete_gpu ? "Discrete GPU detected" : "No discrete GPU (CPU-only mode)") << "\n";
    return ss.str();
}

} // namespace axon
