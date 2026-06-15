#include <pybind11/pybind11.h>
#include <pybind11/stl.h>      // automatic std::vector/std::string conversions
#include <pybind11/numpy.h>    // numpy array support

#include "axon/hardware.h"
#include "axon/memory_ops.h"
#include "axon/thread_pool.h"

// pybind11 generates the glue code that makes C++ types and functions
// accessible from Python. When Python does `import axon_core`, it loads
// this shared library and calls PYBIND11_MODULE to register everything.

namespace py = pybind11;

PYBIND11_MODULE(axon_core, m) {
    m.doc() = "Axon CPU training framework — C++ core";

    // ---- Hardware detection ----

    py::class_<axon::CpuFeatures>(m, "CpuFeatures")
        .def_readonly("avx",     &axon::CpuFeatures::avx)
        .def_readonly("avx2",    &axon::CpuFeatures::avx2)
        .def_readonly("avx512f", &axon::CpuFeatures::avx512f)
        .def_readonly("fma",     &axon::CpuFeatures::fma)
        .def_readonly("bmi2",    &axon::CpuFeatures::bmi2)
        .def("__repr__", [](const axon::CpuFeatures& f) {
            return "<CpuFeatures avx=" + std::to_string(f.avx)
                 + " avx2=" + std::to_string(f.avx2)
                 + " fma="  + std::to_string(f.fma) + ">";
        });

    py::class_<axon::CacheInfo>(m, "CacheInfo")
        .def_readonly("l1d_kb", &axon::CacheInfo::l1d_kb)
        .def_readonly("l2_kb",  &axon::CacheInfo::l2_kb)
        .def_readonly("l3_kb",  &axon::CacheInfo::l3_kb);

    py::class_<axon::HardwareProfile>(m, "HardwareProfile")
        .def_readonly("cpu_name",        &axon::HardwareProfile::cpu_name)
        .def_readonly("physical_cores",  &axon::HardwareProfile::physical_cores)
        .def_readonly("logical_cores",   &axon::HardwareProfile::logical_cores)
        .def_readonly("total_ram_bytes", &axon::HardwareProfile::total_ram_bytes)
        .def_readonly("avail_ram_bytes", &axon::HardwareProfile::avail_ram_bytes)
        .def_readonly("features",        &axon::HardwareProfile::features)
        .def_readonly("cache",           &axon::HardwareProfile::cache)
        .def_readonly("has_discrete_gpu",&axon::HardwareProfile::has_discrete_gpu)
        .def_readonly("gpu_vram_bytes",  &axon::HardwareProfile::gpu_vram_bytes)
        .def_readonly("gpu_name",        &axon::HardwareProfile::gpu_name)
        .def("total_ram_gb",  [](const axon::HardwareProfile& p) {
            return static_cast<double>(p.total_ram_bytes) / (1<<30);
        })
        .def("avail_ram_gb", [](const axon::HardwareProfile& p) {
            return static_cast<double>(p.avail_ram_bytes) / (1<<30);
        });

    m.def("detect_hardware", &axon::detect_hardware,
          "Detect CPU features, cache sizes, RAM, and GPU");

    m.def("hardware_summary", &axon::hardware_summary,
          "Return human-readable hardware summary string");

    // ---- SIMD operations ----
    // These accept numpy arrays so PyTorch tensors can be passed
    // via tensor.numpy() for ops not covered by PyTorch's own kernels.

    m.def("dot_f32",
        [](py::array_t<float> a, py::array_t<float> b) {
            auto ra = a.request(), rb = b.request();
            if (ra.size != rb.size)
                throw std::runtime_error("dot_f32: arrays must have equal size");
            return axon::dot_f32(
                static_cast<const float*>(ra.ptr),
                static_cast<const float*>(rb.ptr),
                static_cast<size_t>(ra.size));
        },
        "AVX2 dot product of two float32 arrays");

    m.def("vadd_f32",
        [](py::array_t<float> out, py::array_t<float> a, py::array_t<float> b) {
            auto ro = out.request(), ra = a.request(), rb = b.request();
            axon::vadd_f32(
                static_cast<float*>(ro.ptr),
                static_cast<const float*>(ra.ptr),
                static_cast<const float*>(rb.ptr),
                static_cast<size_t>(ra.size));
        },
        "AVX2 element-wise float32 addition (out = a + b)");

    m.def("vscale_f32",
        [](py::array_t<float> out, py::array_t<float> a, float alpha) {
            auto ro = out.request(), ra = a.request();
            axon::vscale_f32(
                static_cast<float*>(ro.ptr),
                static_cast<const float*>(ra.ptr),
                alpha,
                static_cast<size_t>(ra.size));
        },
        "AVX2 float32 scale (out = alpha * a)");

    // ---- Thread pool ----

    py::class_<axon::ThreadPool>(m, "ThreadPool")
        .def(py::init<int>(), py::arg("num_threads") = -1)
        .def("num_threads", &axon::ThreadPool::num_threads)
        .def("is_stopped",  &axon::ThreadPool::is_stopped);

    // ---- Version ----
    m.attr("__version__") = "0.1.0";
}
