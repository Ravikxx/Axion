#pragma once
#include <cstddef>

// SIMD (Single Instruction, Multiple Data) lets a CPU do math on multiple
// numbers at once. AVX2 on the Ryzen 5825U can process 8 float32 values
// per instruction instead of 1. This is the header declaring those operations.

namespace axon {

// Prefetch hints: tell the CPU "I'll need this memory soon, load it into cache now"
// so we don't stall waiting for RAM during computation.
void prefetch_l1(const void* addr, size_t size_bytes);  // hottest data
void prefetch_l2(const void* addr, size_t size_bytes);  // slightly cooler

// AVX2 dot product: sum(a[i] * b[i]) for i in 0..n
// Processes 8 float32 values per loop iteration instead of 1.
// Falls back to plain C++ if AVX2 is not available at compile time.
float dot_f32(const float* a, const float* b, size_t n);

// AVX2 element-wise add: out[i] = a[i] + b[i]
void vadd_f32(float* out, const float* a, const float* b, size_t n);

// AVX2 scale: out[i] = alpha * a[i]
void vscale_f32(float* out, const float* a, float alpha, size_t n);

// AVX2 fused multiply-add: out[i] = a[i] * b[i] + c[i]
// Used in linear layer forward pass: y = W*x + b
void vfmadd_f32(float* out, const float* a, const float* b, const float* c, size_t n);

} // namespace axon
