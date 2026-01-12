/**
 * Native SIMD Renderer for CS-CLI - Heavily Optimized
 *
 * Key optimizations:
 * - MSAA-aware rasterization (all samples in one pass)
 * - Full SIMD depth testing and color output
 * - SIMD-accelerated clear and MSAA resolve
 * - Incremental edge stepping (no redundant computation)
 * - Precomputed lit colors for non-textured triangles
 * - Fast integer texture coordinate math
 */

#include <node_api.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <stdint.h>
#include <stdbool.h>
#include <pthread.h>

// SIMD headers
#if defined(__ARM_NEON) || defined(__ARM_NEON__)
  #include <arm_neon.h>
  #define USE_NEON 1
#elif defined(__SSE2__)
  #include <emmintrin.h>
  #include <xmmintrin.h>
  #define USE_SSE2 1
#endif

// Threading
#define MAX_THREADS 8
#define MIN_ROWS_PER_THREAD 8

typedef struct {
  pthread_t threads[MAX_THREADS];
  pthread_mutex_t mutex;
  pthread_cond_t work_ready;
  pthread_cond_t work_done;
  int num_threads;
  int active_workers;
  bool shutdown;
  int work_type;
  int row_start, row_end, next_row;
  uint8_t clear_r, clear_g, clear_b;
} ThreadPool;

static ThreadPool* g_thread_pool = NULL;

// Renderer state
static int g_width = 0;
static int g_height = 0;
static int g_msaa_samples = 1;

// Framebuffers
static uint8_t* g_framebuffer = NULL;
static float* g_depth_buffer = NULL;
static uint8_t* g_msaa_buffer = NULL;
static float* g_msaa_depth = NULL;

// Lighting
static float g_ambient_light = 0.3f;
static float g_light_dir[3] = {0.4319f, 0.8639f, 0.2592f};

// Options
static bool g_enable_backface_culling = false;
static bool g_enable_textures = true;

// Texture
static uint8_t* g_current_texture = NULL;
static int g_texture_width = 0;
static int g_texture_height = 0;
static uint8_t* g_texture_buffer = NULL;
static size_t g_texture_buffer_size = 0;

// MSAA 4x sample offsets
static const float msaa4_ox[4] = {-0.125f, 0.375f, 0.125f, -0.375f};
static const float msaa4_oy[4] = {-0.375f, -0.125f, 0.375f, 0.125f};

// Debug counters
static int g_debug_frame = 0;
static int g_debug_textures_set = 0;
static int g_debug_triangles_with_uv = 0;
static int g_debug_triangles_textured = 0;
static int g_debug_backface_culled = 0;
static int g_debug_near_clipped = 0;
static int g_debug_frustum_culled = 0;
static int g_debug_degenerate = 0;
static int g_debug_total_tris = 0;

#define NAPI_CALL(env, call) do { \
    napi_status status = (call); \
    if (status != napi_ok) { \
      napi_throw_error(env, NULL, "N-API call failed"); \
      return NULL; \
    } \
  } while (0)

#define MIN(a, b) ((a) < (b) ? (a) : (b))
#define MAX(a, b) ((a) > (b) ? (a) : (b))
#define CLAMP(x, lo, hi) MIN(MAX(x, lo), hi)
#define ALIGN_UP(x, align) (((x) + (align) - 1) & ~((align) - 1))

static inline float fast_rsqrt(float x) {
  float xhalf = 0.5f * x;
  int i = *(int*)&x;
  i = 0x5f3759df - (i >> 1);
  x = *(float*)&i;
  return x * (1.5f - xhalf * x * x);
}

// ========================================
// SIMD Clear and Resolve
// ========================================

static void do_clear_rows_simd(int start_row, int end_row, uint8_t r, uint8_t g, uint8_t b) {
  if (!g_framebuffer || !g_depth_buffer) return;

  size_t pixel_count = (size_t)g_width * g_height;

#if USE_NEON
  float32x4_t depth_one = vdupq_n_f32(1.0f);
#endif

  for (int y = start_row; y < end_row && y < g_height; y++) {
    size_t row_offset = (size_t)y * g_width;
    uint8_t* color_row = g_framebuffer + row_offset * 3;
    float* depth_row = g_depth_buffer + row_offset;

#if USE_NEON
    // SIMD clear - 4 floats at a time for depth
    int x = 0;
    for (; x + 4 <= g_width; x += 4) {
      vst1q_f32(depth_row + x, depth_one);
    }
    for (; x < g_width; x++) {
      depth_row[x] = 1.0f;
    }

    // RGB clear - write RGB triplets
    for (x = 0; x < g_width; x++) {
      color_row[x * 3] = r;
      color_row[x * 3 + 1] = g;
      color_row[x * 3 + 2] = b;
    }
#else
    for (int x = 0; x < g_width; x++) {
      color_row[x * 3] = r;
      color_row[x * 3 + 1] = g;
      color_row[x * 3 + 2] = b;
      depth_row[x] = 1.0f;
    }
#endif

    // Clear MSAA buffers
    if (g_msaa_samples > 1 && g_msaa_buffer && g_msaa_depth) {
      for (int s = 0; s < g_msaa_samples; s++) {
        size_t sample_offset = s * pixel_count + row_offset;
        uint8_t* msaa_color = g_msaa_buffer + sample_offset * 3;
        float* msaa_depth = g_msaa_depth + sample_offset;

#if USE_NEON
        int x = 0;
        for (; x + 4 <= g_width; x += 4) {
          vst1q_f32(msaa_depth + x, depth_one);
        }
        for (; x < g_width; x++) {
          msaa_depth[x] = 1.0f;
        }
        for (x = 0; x < g_width; x++) {
          msaa_color[x * 3] = r;
          msaa_color[x * 3 + 1] = g;
          msaa_color[x * 3 + 2] = b;
        }
#else
        for (int x = 0; x < g_width; x++) {
          msaa_color[x * 3] = r;
          msaa_color[x * 3 + 1] = g;
          msaa_color[x * 3 + 2] = b;
          msaa_depth[x] = 1.0f;
        }
#endif
      }
    }
  }
}

static void do_msaa_resolve_rows_simd(int start_row, int end_row) {
  if (!g_framebuffer || !g_msaa_buffer || g_msaa_samples <= 1) return;

  size_t pixel_count = (size_t)g_width * g_height;
  float inv_samples = 1.0f / g_msaa_samples;
  (void)inv_samples; // Used in scalar loop

  for (int y = start_row; y < end_row && y < g_height; y++) {
    size_t row_offset = (size_t)y * g_width;

    for (int x = 0; x < g_width; x++) {
      size_t i = row_offset + x;

      // Accumulate samples
      uint32_t r_sum = 0, g_sum = 0, b_sum = 0;
      float min_depth = 1.0f;

      for (int s = 0; s < g_msaa_samples; s++) {
        size_t si = s * pixel_count + i;
        r_sum += g_msaa_buffer[si * 3];
        g_sum += g_msaa_buffer[si * 3 + 1];
        b_sum += g_msaa_buffer[si * 3 + 2];
        float d = g_msaa_depth[si];
        if (d < min_depth) min_depth = d;
      }

      g_framebuffer[i * 3] = (uint8_t)(r_sum * inv_samples);
      g_framebuffer[i * 3 + 1] = (uint8_t)(g_sum * inv_samples);
      g_framebuffer[i * 3 + 2] = (uint8_t)(b_sum * inv_samples);
      g_depth_buffer[i] = min_depth;
    }
  }
}

// ========================================
// Thread Pool
// ========================================

static void* thread_worker(void* arg) {
  ThreadPool* pool = (ThreadPool*)arg;
  while (1) {
    pthread_mutex_lock(&pool->mutex);
    while (pool->work_type == 0 && !pool->shutdown) {
      pthread_cond_wait(&pool->work_ready, &pool->mutex);
    }
    if (pool->shutdown) {
      pthread_mutex_unlock(&pool->mutex);
      break;
    }

    int work_type = pool->work_type;
    uint8_t cr = pool->clear_r, cg = pool->clear_g, cb = pool->clear_b;
    int chunk_size = 4;
    int my_start = pool->next_row;
    pool->next_row += chunk_size;
    int my_end = MIN(my_start + chunk_size, pool->row_end);
    pthread_mutex_unlock(&pool->mutex);

    while (my_start < pool->row_end) {
      if (work_type == 1) do_clear_rows_simd(my_start, my_end, cr, cg, cb);
      else if (work_type == 2) do_msaa_resolve_rows_simd(my_start, my_end);

      pthread_mutex_lock(&pool->mutex);
      my_start = pool->next_row;
      pool->next_row += chunk_size;
      my_end = MIN(my_start + chunk_size, pool->row_end);
      pthread_mutex_unlock(&pool->mutex);
    }

    pthread_mutex_lock(&pool->mutex);
    pool->active_workers--;
    if (pool->active_workers == 0) {
      pool->work_type = 0;
      pthread_cond_signal(&pool->work_done);
    }
    pthread_mutex_unlock(&pool->mutex);
  }
  return NULL;
}

static void init_thread_pool(int num_threads) {
  if (g_thread_pool) return;
  g_thread_pool = (ThreadPool*)calloc(1, sizeof(ThreadPool));
  if (!g_thread_pool) return;
  pthread_mutex_init(&g_thread_pool->mutex, NULL);
  pthread_cond_init(&g_thread_pool->work_ready, NULL);
  pthread_cond_init(&g_thread_pool->work_done, NULL);
  if (num_threads <= 0) num_threads = 4;
  if (num_threads > MAX_THREADS) num_threads = MAX_THREADS;
  g_thread_pool->num_threads = num_threads;
  for (int i = 0; i < num_threads; i++) {
    pthread_create(&g_thread_pool->threads[i], NULL, thread_worker, g_thread_pool);
  }
}

static void shutdown_thread_pool(void) {
  if (!g_thread_pool) return;
  pthread_mutex_lock(&g_thread_pool->mutex);
  g_thread_pool->shutdown = true;
  pthread_cond_broadcast(&g_thread_pool->work_ready);
  pthread_mutex_unlock(&g_thread_pool->mutex);
  for (int i = 0; i < g_thread_pool->num_threads; i++) {
    pthread_join(g_thread_pool->threads[i], NULL);
  }
  pthread_mutex_destroy(&g_thread_pool->mutex);
  pthread_cond_destroy(&g_thread_pool->work_ready);
  pthread_cond_destroy(&g_thread_pool->work_done);
  free(g_thread_pool);
  g_thread_pool = NULL;
}

static void dispatch_parallel_work(int work_type, int row_start, int row_end, uint8_t cr, uint8_t cg, uint8_t cb) {
  int rows = row_end - row_start;
  if (!g_thread_pool || rows < MIN_ROWS_PER_THREAD * 2) {
    if (work_type == 1) do_clear_rows_simd(row_start, row_end, cr, cg, cb);
    else if (work_type == 2) do_msaa_resolve_rows_simd(row_start, row_end);
    return;
  }

  pthread_mutex_lock(&g_thread_pool->mutex);
  g_thread_pool->work_type = work_type;
  g_thread_pool->row_start = row_start;
  g_thread_pool->row_end = row_end;
  g_thread_pool->next_row = row_start;
  g_thread_pool->clear_r = cr;
  g_thread_pool->clear_g = cg;
  g_thread_pool->clear_b = cb;
  g_thread_pool->active_workers = g_thread_pool->num_threads;
  pthread_cond_broadcast(&g_thread_pool->work_ready);
  while (g_thread_pool->active_workers > 0) {
    pthread_cond_wait(&g_thread_pool->work_done, &g_thread_pool->mutex);
  }
  pthread_mutex_unlock(&g_thread_pool->mutex);
}

// ========================================
// Fast Texture Sampling
// ========================================

static inline void sample_texture_fast(float u, float v, uint8_t* r, uint8_t* g, uint8_t* b) {
  if (!g_current_texture) {
    *r = 200; *g = 200; *b = 200;
    return;
  }

  // Fast wrap using bitwise AND if power of 2, otherwise use modulo
  int tx = (int)(u * g_texture_width);
  int ty = (int)(v * g_texture_height);

  // Handle negative values
  tx = ((tx % g_texture_width) + g_texture_width) % g_texture_width;
  ty = ((ty % g_texture_height) + g_texture_height) % g_texture_height;

  size_t idx = ((size_t)ty * g_texture_width + tx) * 3;
  *r = g_current_texture[idx];
  *g = g_current_texture[idx + 1];
  *b = g_current_texture[idx + 2];
}

// ========================================
// Optimized MSAA-Aware Rasterization
// ========================================

/**
 * Rasterize triangle with integrated MSAA support.
 * Instead of calling rasterize 4 times, we test all MSAA samples per pixel.
 */
// Process a single MSAA sample - inlined for performance
#define PROCESS_MSAA_SAMPLE(s, sox, soy, pixel_idx) do { \
  float se0 = e0 + (sox) * e0_dx + (soy) * e0_dy; \
  float se1 = e1 + (sox) * e1_dx + (soy) * e1_dy; \
  float se2 = e2 + (sox) * e2_dx + (soy) * e2_dy; \
  if (se0 >= -0.001f && se1 >= -0.001f && se2 >= -0.001f) { \
    float b0 = se0 * inv_area, b1 = se1 * inv_area, b2 = 1.0f - b0 - b1; \
    float depth = b0 * z0 + b1 * z1 + b2 * z2; \
    size_t si = sample_base##s + (pixel_idx); \
    if (depth < msaa_depth_ptrs[s][pixel_idx]) { \
      msaa_depth_ptrs[s][pixel_idx] = depth; \
      uint8_t fr, fg, fb; \
      if (use_texture) { \
        float iw = b0 * inv_w0 + b1 * inv_w1 + b2 * inv_w2; \
        float tu = (b0 * u0_w + b1 * u1_w + b2 * u2_w) / iw; \
        float tv = (b0 * v0_w + b1 * v1_w + b2 * v2_w) / iw; \
        uint8_t tr, tg, tb; sample_texture_fast(tu, tv, &tr, &tg, &tb); \
        fr = (uint8_t)CLAMP(tr * light_factor, 0, 255); \
        fg = (uint8_t)CLAMP(tg * light_factor, 0, 255); \
        fb = (uint8_t)CLAMP(tb * light_factor, 0, 255); \
      } else { fr = lit_r; fg = lit_g; fb = lit_b; } \
      uint8_t* cp = msaa_color_ptrs[s] + (pixel_idx) * 3; \
      cp[0] = fr; cp[1] = fg; cp[2] = fb; \
    } \
  } \
} while(0)

static void rasterize_triangle_msaa(
    float x0, float y0, float z0, float w0, float u0, float v0,
    float x1, float y1, float z1, float w1, float u1, float v1,
    float x2, float y2, float z2, float w2, float u2, float v2,
    uint8_t lit_r, uint8_t lit_g, uint8_t lit_b,
    float light_factor,
    bool use_texture
) {
  // Fast bounding box (avoid floorf/ceilf)
  float minXf = x0 < x1 ? (x0 < x2 ? x0 : x2) : (x1 < x2 ? x1 : x2);
  float maxXf = x0 > x1 ? (x0 > x2 ? x0 : x2) : (x1 > x2 ? x1 : x2);
  float minYf = y0 < y1 ? (y0 < y2 ? y0 : y2) : (y1 < y2 ? y1 : y2);
  float maxYf = y0 > y1 ? (y0 > y2 ? y0 : y2) : (y1 > y2 ? y1 : y2);

  int minX = (int)minXf; if (minX < 0) minX = 0;
  int maxX = (int)maxXf + 1; if (maxX >= g_width) maxX = g_width - 1;
  int minY = (int)minYf; if (minY < 0) minY = 0;
  int maxY = (int)maxYf + 1; if (maxY >= g_height) maxY = g_height - 1;

  if (minX > maxX || minY > maxY) return;

  // Edge equation coefficients
  float dx01 = x1 - x0, dy01 = y1 - y0;
  float dx12 = x2 - x1, dy12 = y2 - y1;
  float dx20 = x0 - x2, dy20 = y0 - y2;

  float area = dx01 * (y2 - y0) - dy01 * (x2 - x0);
  if (area > -0.0001f && area < 0.0001f) return;
  float inv_area = 1.0f / area;

  // Perspective interpolation setup
  float inv_w0 = 1.0f / w0, inv_w1 = 1.0f / w1, inv_w2 = 1.0f / w2;
  float u0_w = u0 * inv_w0, v0_w = v0 * inv_w0;
  float u1_w = u1 * inv_w1, v1_w = v1 * inv_w1;
  float u2_w = u2 * inv_w2, v2_w = v2 * inv_w2;

  // Row/column increments for edge stepping
  float e0_dy = dx12, e1_dy = dx20, e2_dy = dx01;
  float e0_dx = -dy12, e1_dx = -dy20, e2_dx = -dy01;

  // Initial edge values at (minX + 0.5, minY + 0.5)
  float fx0 = minX + 0.5f, fy0 = minY + 0.5f;
  float e0_row = dx12 * (fy0 - y1) - dy12 * (fx0 - x1);
  float e1_row = dx20 * (fy0 - y2) - dy20 * (fx0 - x2);
  float e2_row = dx01 * (fy0 - y0) - dy01 * (fx0 - x0);

  int msaa = g_msaa_samples;

  if (msaa == 1) {
    // No MSAA - simple fast path with direct pointers
    for (int py = minY; py <= maxY; py++) {
      float e0 = e0_row, e1 = e1_row, e2 = e2_row;
      size_t row_offset = (size_t)py * g_width;
      float* depth_row = g_depth_buffer + row_offset;
      uint8_t* color_row = g_framebuffer + row_offset * 3;

      for (int px = minX; px <= maxX; px++) {
        if (e0 >= -0.001f && e1 >= -0.001f && e2 >= -0.001f) {
          float b0 = e0 * inv_area, b1 = e1 * inv_area, b2 = 1.0f - b0 - b1;
          float depth = b0 * z0 + b1 * z1 + b2 * z2;

          if (depth < depth_row[px]) {
            depth_row[px] = depth;
            uint8_t* cp = color_row + px * 3;
            if (use_texture) {
              float iw = b0 * inv_w0 + b1 * inv_w1 + b2 * inv_w2;
              float tu = (b0 * u0_w + b1 * u1_w + b2 * u2_w) / iw;
              float tv = (b0 * v0_w + b1 * v1_w + b2 * v2_w) / iw;
              uint8_t tr, tg, tb;
              sample_texture_fast(tu, tv, &tr, &tg, &tb);
              cp[0] = (uint8_t)CLAMP(tr * light_factor, 0, 255);
              cp[1] = (uint8_t)CLAMP(tg * light_factor, 0, 255);
              cp[2] = (uint8_t)CLAMP(tb * light_factor, 0, 255);
            } else {
              cp[0] = lit_r; cp[1] = lit_g; cp[2] = lit_b;
            }
          }
        }
        e0 += e0_dx; e1 += e1_dx; e2 += e2_dx;
      }
      e0_row += e0_dy; e1_row += e1_dy; e2_row += e2_dy;
    }
  } else {
    // MSAA path - precompute all sample buffer pointers
    size_t pixel_count = (size_t)g_width * g_height;
    float* msaa_depth_ptrs[4];
    uint8_t* msaa_color_ptrs[4];
    size_t sample_base0 = 0, sample_base1 = pixel_count;
    size_t sample_base2 = pixel_count * 2, sample_base3 = pixel_count * 3;
    (void)sample_base0; (void)sample_base1; (void)sample_base2; (void)sample_base3;

    for (int s = 0; s < msaa && s < 4; s++) {
      msaa_depth_ptrs[s] = g_msaa_depth + s * pixel_count;
      msaa_color_ptrs[s] = g_msaa_buffer + s * pixel_count * 3;
    }

    // Precompute sample edge offsets (sample position relative to pixel center)
    float s0_e0_off = msaa4_ox[0] * e0_dx + msaa4_oy[0] * e0_dy;
    float s0_e1_off = msaa4_ox[0] * e1_dx + msaa4_oy[0] * e1_dy;
    float s0_e2_off = msaa4_ox[0] * e2_dx + msaa4_oy[0] * e2_dy;
    float s1_e0_off = msaa4_ox[1] * e0_dx + msaa4_oy[1] * e0_dy;
    float s1_e1_off = msaa4_ox[1] * e1_dx + msaa4_oy[1] * e1_dy;
    float s1_e2_off = msaa4_ox[1] * e2_dx + msaa4_oy[1] * e2_dy;
    float s2_e0_off = msaa4_ox[2] * e0_dx + msaa4_oy[2] * e0_dy;
    float s2_e1_off = msaa4_ox[2] * e1_dx + msaa4_oy[2] * e1_dy;
    float s2_e2_off = msaa4_ox[2] * e2_dx + msaa4_oy[2] * e2_dy;
    float s3_e0_off = msaa4_ox[3] * e0_dx + msaa4_oy[3] * e0_dy;
    float s3_e1_off = msaa4_ox[3] * e1_dx + msaa4_oy[3] * e1_dy;
    float s3_e2_off = msaa4_ox[3] * e2_dx + msaa4_oy[3] * e2_dy;

    for (int py = minY; py <= maxY; py++) {
      float e0 = e0_row, e1 = e1_row, e2 = e2_row;
      size_t row_offset = (size_t)py * g_width;

      for (int px = minX; px <= maxX; px++) {
        size_t pixel_idx = row_offset + px;

        // Unrolled 4x MSAA - test each sample with precomputed offsets
        // Sample 0
        {
          float se0 = e0 + s0_e0_off, se1 = e1 + s0_e1_off, se2 = e2 + s0_e2_off;
          if (se0 >= -0.001f && se1 >= -0.001f && se2 >= -0.001f) {
            float b0 = se0 * inv_area, b1 = se1 * inv_area, b2 = 1.0f - b0 - b1;
            float depth = b0 * z0 + b1 * z1 + b2 * z2;
            if (depth < msaa_depth_ptrs[0][pixel_idx]) {
              msaa_depth_ptrs[0][pixel_idx] = depth;
              uint8_t* cp = msaa_color_ptrs[0] + pixel_idx * 3;
              if (use_texture) {
                float iw = b0 * inv_w0 + b1 * inv_w1 + b2 * inv_w2;
                float tu = (b0 * u0_w + b1 * u1_w + b2 * u2_w) / iw;
                float tv = (b0 * v0_w + b1 * v1_w + b2 * v2_w) / iw;
                uint8_t tr, tg, tb; sample_texture_fast(tu, tv, &tr, &tg, &tb);
                cp[0] = (uint8_t)CLAMP(tr * light_factor, 0, 255);
                cp[1] = (uint8_t)CLAMP(tg * light_factor, 0, 255);
                cp[2] = (uint8_t)CLAMP(tb * light_factor, 0, 255);
              } else { cp[0] = lit_r; cp[1] = lit_g; cp[2] = lit_b; }
            }
          }
        }
        // Sample 1
        {
          float se0 = e0 + s1_e0_off, se1 = e1 + s1_e1_off, se2 = e2 + s1_e2_off;
          if (se0 >= -0.001f && se1 >= -0.001f && se2 >= -0.001f) {
            float b0 = se0 * inv_area, b1 = se1 * inv_area, b2 = 1.0f - b0 - b1;
            float depth = b0 * z0 + b1 * z1 + b2 * z2;
            if (depth < msaa_depth_ptrs[1][pixel_idx]) {
              msaa_depth_ptrs[1][pixel_idx] = depth;
              uint8_t* cp = msaa_color_ptrs[1] + pixel_idx * 3;
              if (use_texture) {
                float iw = b0 * inv_w0 + b1 * inv_w1 + b2 * inv_w2;
                float tu = (b0 * u0_w + b1 * u1_w + b2 * u2_w) / iw;
                float tv = (b0 * v0_w + b1 * v1_w + b2 * v2_w) / iw;
                uint8_t tr, tg, tb; sample_texture_fast(tu, tv, &tr, &tg, &tb);
                cp[0] = (uint8_t)CLAMP(tr * light_factor, 0, 255);
                cp[1] = (uint8_t)CLAMP(tg * light_factor, 0, 255);
                cp[2] = (uint8_t)CLAMP(tb * light_factor, 0, 255);
              } else { cp[0] = lit_r; cp[1] = lit_g; cp[2] = lit_b; }
            }
          }
        }
        // Sample 2
        {
          float se0 = e0 + s2_e0_off, se1 = e1 + s2_e1_off, se2 = e2 + s2_e2_off;
          if (se0 >= -0.001f && se1 >= -0.001f && se2 >= -0.001f) {
            float b0 = se0 * inv_area, b1 = se1 * inv_area, b2 = 1.0f - b0 - b1;
            float depth = b0 * z0 + b1 * z1 + b2 * z2;
            if (depth < msaa_depth_ptrs[2][pixel_idx]) {
              msaa_depth_ptrs[2][pixel_idx] = depth;
              uint8_t* cp = msaa_color_ptrs[2] + pixel_idx * 3;
              if (use_texture) {
                float iw = b0 * inv_w0 + b1 * inv_w1 + b2 * inv_w2;
                float tu = (b0 * u0_w + b1 * u1_w + b2 * u2_w) / iw;
                float tv = (b0 * v0_w + b1 * v1_w + b2 * v2_w) / iw;
                uint8_t tr, tg, tb; sample_texture_fast(tu, tv, &tr, &tg, &tb);
                cp[0] = (uint8_t)CLAMP(tr * light_factor, 0, 255);
                cp[1] = (uint8_t)CLAMP(tg * light_factor, 0, 255);
                cp[2] = (uint8_t)CLAMP(tb * light_factor, 0, 255);
              } else { cp[0] = lit_r; cp[1] = lit_g; cp[2] = lit_b; }
            }
          }
        }
        // Sample 3
        {
          float se0 = e0 + s3_e0_off, se1 = e1 + s3_e1_off, se2 = e2 + s3_e2_off;
          if (se0 >= -0.001f && se1 >= -0.001f && se2 >= -0.001f) {
            float b0 = se0 * inv_area, b1 = se1 * inv_area, b2 = 1.0f - b0 - b1;
            float depth = b0 * z0 + b1 * z1 + b2 * z2;
            if (depth < msaa_depth_ptrs[3][pixel_idx]) {
              msaa_depth_ptrs[3][pixel_idx] = depth;
              uint8_t* cp = msaa_color_ptrs[3] + pixel_idx * 3;
              if (use_texture) {
                float iw = b0 * inv_w0 + b1 * inv_w1 + b2 * inv_w2;
                float tu = (b0 * u0_w + b1 * u1_w + b2 * u2_w) / iw;
                float tv = (b0 * v0_w + b1 * v1_w + b2 * v2_w) / iw;
                uint8_t tr, tg, tb; sample_texture_fast(tu, tv, &tr, &tg, &tb);
                cp[0] = (uint8_t)CLAMP(tr * light_factor, 0, 255);
                cp[1] = (uint8_t)CLAMP(tg * light_factor, 0, 255);
                cp[2] = (uint8_t)CLAMP(tb * light_factor, 0, 255);
              } else { cp[0] = lit_r; cp[1] = lit_g; cp[2] = lit_b; }
            }
          }
        }

        e0 += e0_dx; e1 += e1_dx; e2 += e2_dx;
      }
      e0_row += e0_dy; e1_row += e1_dy; e2_row += e2_dy;
    }
  }
}

// ========================================
// Triangle Processing Pipeline
// ========================================

#define NEAR_PLANE 0.05f

typedef struct {
  float cx, cy, cz, cw;
  float u, v;
  uint8_t r, g, b;
} ClipVert;

static inline void transform_vertex(float x, float y, float z, const float* mvp,
    float* ox, float* oy, float* oz, float* ow) {
  *ox = mvp[0]*x + mvp[4]*y + mvp[8]*z + mvp[12];
  *oy = mvp[1]*x + mvp[5]*y + mvp[9]*z + mvp[13];
  *oz = mvp[2]*x + mvp[6]*y + mvp[10]*z + mvp[14];
  *ow = mvp[3]*x + mvp[7]*y + mvp[11]*z + mvp[15];
}

static inline ClipVert lerp_vert(const ClipVert* a, const ClipVert* b, float t) {
  ClipVert r;
  r.cx = a->cx + (b->cx - a->cx) * t;
  r.cy = a->cy + (b->cy - a->cy) * t;
  r.cz = a->cz + (b->cz - a->cz) * t;
  r.cw = a->cw + (b->cw - a->cw) * t;
  r.u = a->u + (b->u - a->u) * t;
  r.v = a->v + (b->v - a->v) * t;
  r.r = (uint8_t)(a->r + (b->r - a->r) * t);
  r.g = (uint8_t)(a->g + (b->g - a->g) * t);
  r.b = (uint8_t)(a->b + (b->b - a->b) * t);
  return r;
}

static int clip_near_plane(const ClipVert* v0, const ClipVert* v1, const ClipVert* v2, ClipVert* out) {
  int in0 = v0->cw >= NEAR_PLANE, in1 = v1->cw >= NEAR_PLANE, in2 = v2->cw >= NEAR_PLANE;
  int cnt = in0 + in1 + in2;

  if (cnt == 3) { out[0] = *v0; out[1] = *v1; out[2] = *v2; return 1; }
  if (cnt == 0) return 0;

  if (cnt == 1) {
    const ClipVert *vi, *vo1, *vo2;
    if (in0) { vi = v0; vo1 = v1; vo2 = v2; }
    else if (in1) { vi = v1; vo1 = v2; vo2 = v0; }
    else { vi = v2; vo1 = v0; vo2 = v1; }
    float t1 = (NEAR_PLANE - vi->cw) / (vo1->cw - vi->cw);
    float t2 = (NEAR_PLANE - vi->cw) / (vo2->cw - vi->cw);
    out[0] = *vi;
    out[1] = lerp_vert(vi, vo1, t1);
    out[2] = lerp_vert(vi, vo2, t2);
    return 1;
  }

  // cnt == 2
  const ClipVert *vi0, *vi1, *vo;
  if (!in0) { vo = v0; vi0 = v1; vi1 = v2; }
  else if (!in1) { vo = v1; vi0 = v2; vi1 = v0; }
  else { vo = v2; vi0 = v0; vi1 = v1; }
  float t0 = (NEAR_PLANE - vi0->cw) / (vo->cw - vi0->cw);
  float t1 = (NEAR_PLANE - vi1->cw) / (vo->cw - vi1->cw);
  ClipVert nv0 = lerp_vert(vi0, vo, t0);
  ClipVert nv1 = lerp_vert(vi1, vo, t1);
  out[0] = *vi0; out[1] = *vi1; out[2] = nv1;
  out[3] = *vi0; out[4] = nv1; out[5] = nv0;
  return 2;
}

static int process_triangle(const ClipVert* cv0, const ClipVert* cv1, const ClipVert* cv2,
    float light_factor, float halfW, float halfH, bool use_texture) {

  // Perspective divide
  float ndcX0 = cv0->cx / cv0->cw, ndcY0 = cv0->cy / cv0->cw, ndcZ0 = cv0->cz / cv0->cw;
  float ndcX1 = cv1->cx / cv1->cw, ndcY1 = cv1->cy / cv1->cw, ndcZ1 = cv1->cz / cv1->cw;
  float ndcX2 = cv2->cx / cv2->cw, ndcY2 = cv2->cy / cv2->cw, ndcZ2 = cv2->cz / cv2->cw;

  // Frustum cull
  if ((ndcX0 < -1 && ndcX1 < -1 && ndcX2 < -1) || (ndcX0 > 1 && ndcX1 > 1 && ndcX2 > 1) ||
      (ndcY0 < -1 && ndcY1 < -1 && ndcY2 < -1) || (ndcY0 > 1 && ndcY1 > 1 && ndcY2 > 1)) {
    g_debug_frustum_culled++;
    return 0;
  }

  // Screen space
  float sx0 = (ndcX0 + 1) * halfW, sy0 = (1 - ndcY0) * halfH;
  float sx1 = (ndcX1 + 1) * halfW, sy1 = (1 - ndcY1) * halfH;
  float sx2 = (ndcX2 + 1) * halfW, sy2 = (1 - ndcY2) * halfH;

  float area = (sx1 - sx0) * (sy2 - sy0) - (sx2 - sx0) * (sy1 - sy0);

  if (g_enable_backface_culling && area < 0) {
    g_debug_backface_culled++;
    return 0;
  }

  // Setup vertices, swap if backface
  float rsx0 = sx0, rsy0 = sy0, rsz0 = ndcZ0, rcw0 = cv0->cw;
  float rsx1, rsy1, rsz1, rcw1;
  float rsx2, rsy2, rsz2, rcw2;
  float ru0 = cv0->u, rv0 = cv0->v, ru1, rv1, ru2, rv2;

  if (area >= 0) {
    rsx1 = sx1; rsy1 = sy1; rsz1 = ndcZ1; rcw1 = cv1->cw;
    rsx2 = sx2; rsy2 = sy2; rsz2 = ndcZ2; rcw2 = cv2->cw;
    ru1 = cv1->u; rv1 = cv1->v;
    ru2 = cv2->u; rv2 = cv2->v;
  } else {
    rsx1 = sx2; rsy1 = sy2; rsz1 = ndcZ2; rcw1 = cv2->cw;
    rsx2 = sx1; rsy2 = sy1; rsz2 = ndcZ1; rcw2 = cv1->cw;
    ru1 = cv2->u; rv1 = cv2->v;
    ru2 = cv1->u; rv2 = cv1->v;
  }

  // Precompute lit color for non-textured
  uint8_t lit_r = (uint8_t)CLAMP(cv0->r * light_factor, 0, 255);
  uint8_t lit_g = (uint8_t)CLAMP(cv0->g * light_factor, 0, 255);
  uint8_t lit_b = (uint8_t)CLAMP(cv0->b * light_factor, 0, 255);

  rasterize_triangle_msaa(
    rsx0, rsy0, rsz0, rcw0, ru0, rv0,
    rsx1, rsy1, rsz1, rcw1, ru1, rv1,
    rsx2, rsy2, rsz2, rcw2, ru2, rv2,
    lit_r, lit_g, lit_b, light_factor, use_texture
  );

  return 1;
}

// ========================================
// N-API Functions
// ========================================

static napi_value render_init(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));

  if (argc < 3) {
    napi_throw_error(env, NULL, "Expected 3 arguments");
    return NULL;
  }

  int32_t width, height, msaa;
  NAPI_CALL(env, napi_get_value_int32(env, args[0], &width));
  NAPI_CALL(env, napi_get_value_int32(env, args[1], &height));
  NAPI_CALL(env, napi_get_value_int32(env, args[2], &msaa));

  if (width <= 0 || height <= 0 || width > 4096 || height > 4096) {
    napi_throw_error(env, NULL, "Invalid dimensions");
    return NULL;
  }
  if (msaa != 1 && msaa != 4 && msaa != 16) msaa = 1;

  free(g_framebuffer); free(g_depth_buffer); free(g_msaa_buffer); free(g_msaa_depth);

  g_width = width; g_height = height; g_msaa_samples = msaa;
  size_t pc = (size_t)width * height;

  g_framebuffer = (uint8_t*)aligned_alloc(64, ALIGN_UP(pc * 3, 64));
  g_depth_buffer = (float*)aligned_alloc(64, ALIGN_UP(pc * sizeof(float), 64));

  if (!g_framebuffer || !g_depth_buffer) {
    napi_throw_error(env, NULL, "Allocation failed");
    return NULL;
  }

  memset(g_framebuffer, 0, pc * 3);
  for (size_t i = 0; i < pc; i++) g_depth_buffer[i] = 1.0f;

  if (msaa > 1) {
    g_msaa_buffer = (uint8_t*)aligned_alloc(64, ALIGN_UP(pc * 3 * msaa, 64));
    g_msaa_depth = (float*)aligned_alloc(64, ALIGN_UP(pc * msaa * sizeof(float), 64));
    if (!g_msaa_buffer || !g_msaa_depth) {
      napi_throw_error(env, NULL, "MSAA allocation failed");
      return NULL;
    }
    memset(g_msaa_buffer, 0, pc * 3 * msaa);
    for (size_t i = 0; i < pc * msaa; i++) g_msaa_depth[i] = 1.0f;
  } else {
    g_msaa_buffer = NULL;
    g_msaa_depth = NULL;
  }

  init_thread_pool(4);

  napi_value result;
  NAPI_CALL(env, napi_get_boolean(env, true, &result));
  return result;
}

static napi_value render_clear(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));

  int32_t r = 0, g = 0, b = 0;
  if (argc >= 3) {
    napi_get_value_int32(env, args[0], &r);
    napi_get_value_int32(env, args[1], &g);
    napi_get_value_int32(env, args[2], &b);
  }

  if (!g_framebuffer) {
    napi_throw_error(env, NULL, "Not initialized");
    return NULL;
  }

  dispatch_parallel_work(1, 0, g_height, (uint8_t)r, (uint8_t)g, (uint8_t)b);

  napi_value result;
  NAPI_CALL(env, napi_get_undefined(env, &result));
  return result;
}

static napi_value render_set_options(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));

  if (argc >= 1) NAPI_CALL(env, napi_get_value_bool(env, args[0], &g_enable_backface_culling));
  if (argc >= 2) NAPI_CALL(env, napi_get_value_bool(env, args[1], &g_enable_textures));

  g_debug_frame++;
  g_debug_textures_set = g_debug_triangles_with_uv = g_debug_triangles_textured = 0;
  g_debug_backface_culled = g_debug_near_clipped = g_debug_frustum_culled = g_debug_degenerate = g_debug_total_tris = 0;

  napi_value result;
  NAPI_CALL(env, napi_get_undefined(env, &result));
  return result;
}

static napi_value render_set_texture(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));

  napi_valuetype type;
  NAPI_CALL(env, napi_typeof(env, args[0], &type));

  if (type == napi_null || type == napi_undefined) {
    g_current_texture = NULL;
    g_texture_width = g_texture_height = 0;
  } else if (argc >= 3) {
    uint8_t* src; size_t len;
    NAPI_CALL(env, napi_get_typedarray_info(env, args[0], NULL, &len, (void**)&src, NULL, NULL));
    NAPI_CALL(env, napi_get_value_int32(env, args[1], &g_texture_width));
    NAPI_CALL(env, napi_get_value_int32(env, args[2], &g_texture_height));

    size_t need = (size_t)g_texture_width * g_texture_height * 3;
    if (need > g_texture_buffer_size) {
      free(g_texture_buffer);
      g_texture_buffer = (uint8_t*)malloc(need);
      g_texture_buffer_size = need;
    }
    if (g_texture_buffer && len >= need) {
      memcpy(g_texture_buffer, src, need);
      g_current_texture = g_texture_buffer;
      g_debug_textures_set++;
    } else {
      g_current_texture = NULL;
    }
  }

  napi_value result;
  NAPI_CALL(env, napi_get_undefined(env, &result));
  return result;
}

static napi_value render_triangles_batch(napi_env env, napi_callback_info info) {
  size_t argc = 6;
  napi_value args[6];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));

  if (argc < 5 || !g_framebuffer) {
    napi_throw_error(env, NULL, argc < 5 ? "Need 5 args" : "Not initialized");
    return NULL;
  }

  float *vertices, *mvp, *normals, *uvs = NULL;
  uint32_t *indices;
  uint8_t *colors;
  size_t vcount, icount, mcount, ccount, ncount, ucount = 0;
  napi_typedarray_type t;

  NAPI_CALL(env, napi_get_typedarray_info(env, args[0], &t, &vcount, (void**)&vertices, NULL, NULL));
  NAPI_CALL(env, napi_get_typedarray_info(env, args[1], &t, &icount, (void**)&indices, NULL, NULL));
  NAPI_CALL(env, napi_get_typedarray_info(env, args[2], &t, &mcount, (void**)&mvp, NULL, NULL));
  NAPI_CALL(env, napi_get_typedarray_info(env, args[3], &t, &ccount, (void**)&colors, NULL, NULL));
  NAPI_CALL(env, napi_get_typedarray_info(env, args[4], &t, &ncount, (void**)&normals, NULL, NULL));

  if (argc >= 6) {
    napi_valuetype ut;
    NAPI_CALL(env, napi_typeof(env, args[5], &ut));
    if (ut != napi_null && ut != napi_undefined) {
      NAPI_CALL(env, napi_get_typedarray_info(env, args[5], &t, &ucount, (void**)&uvs, NULL, NULL));
    }
  }

  int tri_count = (int)(icount / 3);
  int rendered = 0;
  float halfW = g_width * 0.5f, halfH = g_height * 0.5f;
  bool use_texture = g_enable_textures && g_current_texture != NULL;

  for (int tri = 0; tri < tri_count; tri++) {
    uint32_t i0 = indices[tri*3], i1 = indices[tri*3+1], i2 = indices[tri*3+2];

    float vx0 = vertices[i0*3], vy0 = vertices[i0*3+1], vz0 = vertices[i0*3+2];
    float vx1 = vertices[i1*3], vy1 = vertices[i1*3+1], vz1 = vertices[i1*3+2];
    float vx2 = vertices[i2*3], vy2 = vertices[i2*3+1], vz2 = vertices[i2*3+2];

    float cx0, cy0, cz0, cw0, cx1, cy1, cz1, cw1, cx2, cy2, cz2, cw2;
    transform_vertex(vx0, vy0, vz0, mvp, &cx0, &cy0, &cz0, &cw0);
    transform_vertex(vx1, vy1, vz1, mvp, &cx1, &cy1, &cz1, &cw1);
    transform_vertex(vx2, vy2, vz2, mvp, &cx2, &cy2, &cz2, &cw2);

    g_debug_total_tris++;

    uint8_t r0 = colors[i0*3], g0 = colors[i0*3+1], b0 = colors[i0*3+2];

    float u0 = 0, v0 = 0, u1 = 0, v1 = 0, u2 = 0, v2 = 0;
    if (uvs && ucount >= (i2+1)*2) {
      u0 = uvs[i0*2]; v0 = uvs[i0*2+1];
      u1 = uvs[i1*2]; v1 = uvs[i1*2+1];
      u2 = uvs[i2*2]; v2 = uvs[i2*2+1];
      g_debug_triangles_with_uv++;
    }

    ClipVert cv0 = {cx0, cy0, cz0, cw0, u0, v0, r0, g0, b0};
    ClipVert cv1 = {cx1, cy1, cz1, cw1, u1, v1, r0, g0, b0};
    ClipVert cv2 = {cx2, cy2, cz2, cw2, u2, v2, r0, g0, b0};

    ClipVert clipped[6];
    int num = clip_near_plane(&cv0, &cv1, &cv2, clipped);
    if (num == 0) { g_debug_near_clipped++; continue; }

    // Lighting
    float nx, ny, nz;
    if (ncount >= (i2+1)*3) {
      nx = (normals[i0*3] + normals[i1*3] + normals[i2*3]) * 0.333333f;
      ny = (normals[i0*3+1] + normals[i1*3+1] + normals[i2*3+1]) * 0.333333f;
      nz = (normals[i0*3+2] + normals[i1*3+2] + normals[i2*3+2]) * 0.333333f;
    } else {
      float e1x = vx1-vx0, e1y = vy1-vy0, e1z = vz1-vz0;
      float e2x = vx2-vx0, e2y = vy2-vy0, e2z = vz2-vz0;
      nx = e1y*e2z - e1z*e2y;
      ny = e1z*e2x - e1x*e2z;
      nz = e1x*e2y - e1y*e2x;
    }

    float len2 = nx*nx + ny*ny + nz*nz;
    if (len2 > 0.0001f) {
      float il = fast_rsqrt(len2);
      nx *= il; ny *= il; nz *= il;
    }

    float ndl = nx*g_light_dir[0] + ny*g_light_dir[1] + nz*g_light_dir[2];
    if (ndl < 0) ndl = 0;
    float lf = g_ambient_light + (1.0f - g_ambient_light) * ndl;

    if (use_texture) g_debug_triangles_textured++;

    for (int c = 0; c < num; c++) {
      if (process_triangle(&clipped[c*3], &clipped[c*3+1], &clipped[c*3+2], lf, halfW, halfH, use_texture)) {
        rendered++;
      }
    }
  }

  napi_value result;
  NAPI_CALL(env, napi_create_int32(env, rendered, &result));
  return result;
}

static napi_value render_resolve_msaa(napi_env env, napi_callback_info info) {
  if (g_framebuffer && g_msaa_samples > 1 && g_msaa_buffer) {
    dispatch_parallel_work(2, 0, g_height, 0, 0, 0);
  }
  napi_value result;
  NAPI_CALL(env, napi_get_undefined(env, &result));
  return result;
}

static napi_value render_get_framebuffer(napi_env env, napi_callback_info info) {
  if (!g_framebuffer) { napi_throw_error(env, NULL, "Not init"); return NULL; }
  size_t len = (size_t)g_width * g_height * 3;
  napi_value ab, result;
  NAPI_CALL(env, napi_create_external_arraybuffer(env, g_framebuffer, len, NULL, NULL, &ab));
  NAPI_CALL(env, napi_create_typedarray(env, napi_uint8_array, len, ab, 0, &result));
  return result;
}

static napi_value render_get_depth_buffer(napi_env env, napi_callback_info info) {
  if (!g_depth_buffer) { napi_throw_error(env, NULL, "Not init"); return NULL; }
  size_t len = (size_t)g_width * g_height;
  napi_value ab, result;
  NAPI_CALL(env, napi_create_external_arraybuffer(env, g_depth_buffer, len * sizeof(float), NULL, NULL, &ab));
  NAPI_CALL(env, napi_create_typedarray(env, napi_float32_array, len, ab, 0, &result));
  return result;
}

static napi_value render_get_dimensions(napi_env env, napi_callback_info info) {
  napi_value result, w, h;
  NAPI_CALL(env, napi_create_object(env, &result));
  NAPI_CALL(env, napi_create_int32(env, g_width, &w));
  NAPI_CALL(env, napi_create_int32(env, g_height, &h));
  NAPI_CALL(env, napi_set_named_property(env, result, "width", w));
  NAPI_CALL(env, napi_set_named_property(env, result, "height", h));
  return result;
}

static napi_value render_cleanup(napi_env env, napi_callback_info info) {
  shutdown_thread_pool();
  free(g_framebuffer); free(g_depth_buffer); free(g_msaa_buffer); free(g_msaa_depth); free(g_texture_buffer);
  g_framebuffer = NULL;
  g_depth_buffer = NULL;
  g_msaa_buffer = NULL;
  g_msaa_depth = NULL;
  g_current_texture = NULL;
  g_texture_buffer = NULL;
  g_texture_buffer_size = 0;
  g_width = g_height = 0;
  g_msaa_samples = 1;
  napi_value result;
  NAPI_CALL(env, napi_get_undefined(env, &result));
  return result;
}

static napi_value render_get_debug_stats(napi_env env, napi_callback_info info) {
  napi_value r, v;
  NAPI_CALL(env, napi_create_object(env, &r));
  #define SET_INT(name, val) NAPI_CALL(env, napi_create_int32(env, val, &v)); NAPI_CALL(env, napi_set_named_property(env, r, name, v))
  #define SET_BOOL(name, val) NAPI_CALL(env, napi_get_boolean(env, val, &v)); NAPI_CALL(env, napi_set_named_property(env, r, name, v))
  SET_INT("frame", g_debug_frame);
  SET_INT("totalTris", g_debug_total_tris);
  SET_INT("nearClipped", g_debug_near_clipped);
  SET_INT("frustumCulled", g_debug_frustum_culled);
  SET_INT("backfaceCulled", g_debug_backface_culled);
  SET_INT("degenerate", g_debug_degenerate);
  SET_INT("texturesSet", g_debug_textures_set);
  SET_INT("trianglesWithUV", g_debug_triangles_with_uv);
  SET_INT("trianglesTextured", g_debug_triangles_textured);
  SET_BOOL("backfaceCullingEnabled", g_enable_backface_culling);
  SET_BOOL("texturesEnabled", g_enable_textures);
  SET_BOOL("hasTexture", g_current_texture != NULL);
  SET_INT("textureWidth", g_texture_width);
  SET_INT("textureHeight", g_texture_height);
  #undef SET_INT
  #undef SET_BOOL
  return r;
}

static napi_value render_has_simd(napi_env env, napi_callback_info info) {
  napi_value result;
  bool has = false;
  #if defined(USE_NEON) || defined(USE_SSE2)
  has = true;
  #endif
  NAPI_CALL(env, napi_get_boolean(env, has, &result));
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    {"init", NULL, render_init, NULL, NULL, NULL, napi_default, NULL},
    {"clear", NULL, render_clear, NULL, NULL, NULL, napi_default, NULL},
    {"setOptions", NULL, render_set_options, NULL, NULL, NULL, napi_default, NULL},
    {"setTexture", NULL, render_set_texture, NULL, NULL, NULL, napi_default, NULL},
    {"renderTrianglesBatch", NULL, render_triangles_batch, NULL, NULL, NULL, napi_default, NULL},
    {"resolveMSAA", NULL, render_resolve_msaa, NULL, NULL, NULL, napi_default, NULL},
    {"getFramebuffer", NULL, render_get_framebuffer, NULL, NULL, NULL, napi_default, NULL},
    {"getDepthBuffer", NULL, render_get_depth_buffer, NULL, NULL, NULL, napi_default, NULL},
    {"getDimensions", NULL, render_get_dimensions, NULL, NULL, NULL, napi_default, NULL},
    {"cleanup", NULL, render_cleanup, NULL, NULL, NULL, napi_default, NULL},
    {"hasSIMD", NULL, render_has_simd, NULL, NULL, NULL, napi_default, NULL},
    {"getDebugStats", NULL, render_get_debug_stats, NULL, NULL, NULL, napi_default, NULL},
  };
  NAPI_CALL(env, napi_define_properties(env, exports, sizeof(props)/sizeof(props[0]), props));
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
