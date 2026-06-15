#include "axon/memory_ops.h"
#include <cstring>
#include <immintrin.h>  // AVX/AVX2/FMA intrinsics

// --- What are intrinsics? ---
// They're C++ functions that map 1:1 to a specific CPU instruction.
// E.g., _mm256_fmadd_ps(a, b, c) compiles to a single VFMADD231PS instruction
// that does: result[i] = a[i] * b[i] + c[i] for 8 floats simultaneously.
// No loops needed at the assembly level — that's the power of SIMD.

namespace axon {

// ---------- Prefetch ----------
// __builtin_prefetch(addr, rw, locality)
//   rw: 0=read, 1=write
//   locality: 0=no temporal reuse (stream), 3=stay in L1

void prefetch_l1(const void* addr, size_t size_bytes) {
    const char* p = static_cast<const char*>(addr);
    for (size_t i = 0; i < size_bytes; i += 64)  // 64-byte cache lines
        __builtin_prefetch(p + i, 0, 3);
}

void prefetch_l2(const void* addr, size_t size_bytes) {
    const char* p = static_cast<const char*>(addr);
    for (size_t i = 0; i < size_bytes; i += 64)
        __builtin_prefetch(p + i, 0, 2);
}

// ---------- Scalar fallback (always available) ----------

static float dot_scalar(const float* a, const float* b, size_t n) {
    float sum = 0.0f;
    for (size_t i = 0; i < n; ++i) sum += a[i] * b[i];
    return sum;
}

static void vadd_scalar(float* out, const float* a, const float* b, size_t n) {
    for (size_t i = 0; i < n; ++i) out[i] = a[i] + b[i];
}

static void vscale_scalar(float* out, const float* a, float alpha, size_t n) {
    for (size_t i = 0; i < n; ++i) out[i] = a[i] * alpha;
}

static void vfmadd_scalar(float* out, const float* a, const float* b, const float* c, size_t n) {
    for (size_t i = 0; i < n; ++i) out[i] = a[i] * b[i] + c[i];
}

// ---------- AVX2 + FMA implementations ----------
// Each __m256 holds 8 float32 values. _mm256_loadu_ps loads 8 floats from
// an unaligned address. _mm256_fmadd_ps does fused multiply-add.
// The "u" in loadu means "unaligned" — we don't require the array to start
// on a 32-byte boundary, which simplifies usage.

#ifdef __AVX2__

static float dot_avx2(const float* a, const float* b, size_t n) {
    __m256 acc = _mm256_setzero_ps();  // 8 zeros
    size_t i = 0;

    for (; i + 8 <= n; i += 8) {
        __m256 va = _mm256_loadu_ps(a + i);
        __m256 vb = _mm256_loadu_ps(b + i);
        acc = _mm256_fmadd_ps(va, vb, acc);  // acc += va * vb (FMA)
    }

    // Horizontal reduction: add all 8 lanes together
    // Step 1: add upper 4 lanes to lower 4 lanes
    __m128 lo  = _mm256_castps256_ps128(acc);
    __m128 hi  = _mm256_extractf128_ps(acc, 1);
    __m128 sum = _mm_add_ps(lo, hi);
    // Step 2: pairwise adds within 4 lanes
    sum = _mm_hadd_ps(sum, sum);
    sum = _mm_hadd_ps(sum, sum);
    float result = _mm_cvtss_f32(sum);

    // Handle remainder (when n is not a multiple of 8)
    for (; i < n; ++i) result += a[i] * b[i];
    return result;
}

static void vadd_avx2(float* out, const float* a, const float* b, size_t n) {
    size_t i = 0;
    for (; i + 8 <= n; i += 8)
        _mm256_storeu_ps(out + i,
            _mm256_add_ps(_mm256_loadu_ps(a + i), _mm256_loadu_ps(b + i)));
    for (; i < n; ++i) out[i] = a[i] + b[i];
}

static void vscale_avx2(float* out, const float* a, float alpha, size_t n) {
    __m256 valpha = _mm256_set1_ps(alpha);  // broadcast alpha to 8 lanes
    size_t i = 0;
    for (; i + 8 <= n; i += 8)
        _mm256_storeu_ps(out + i,
            _mm256_mul_ps(_mm256_loadu_ps(a + i), valpha));
    for (; i < n; ++i) out[i] = a[i] * alpha;
}

static void vfmadd_avx2(float* out, const float* a, const float* b, const float* c, size_t n) {
    size_t i = 0;
    for (; i + 8 <= n; i += 8)
        _mm256_storeu_ps(out + i,
            _mm256_fmadd_ps(
                _mm256_loadu_ps(a + i),
                _mm256_loadu_ps(b + i),
                _mm256_loadu_ps(c + i)));
    for (; i < n; ++i) out[i] = a[i] * b[i] + c[i];
}

#endif // __AVX2__

// ---------- Dispatch: pick best implementation at runtime ----------
// The preprocessor macro __AVX2__ is set when we compile with -mavx2.
// We use it to select the fast path at compile time.

float dot_f32(const float* a, const float* b, size_t n) {
#ifdef __AVX2__
    return dot_avx2(a, b, n);
#else
    return dot_scalar(a, b, n);
#endif
}

void vadd_f32(float* out, const float* a, const float* b, size_t n) {
#ifdef __AVX2__
    vadd_avx2(out, a, b, n);
#else
    vadd_scalar(out, a, b, n);
#endif
}

void vscale_f32(float* out, const float* a, float alpha, size_t n) {
#ifdef __AVX2__
    vscale_avx2(out, a, alpha, n);
#else
    vscale_scalar(out, a, alpha, n);
#endif
}

void vfmadd_f32(float* out, const float* a, const float* b, const float* c, size_t n) {
#ifdef __AVX2__
    vfmadd_avx2(out, a, b, c, n);
#else
    vfmadd_scalar(out, a, b, c, n);
#endif
}

} // namespace axon
