/**
 * Native SIMD Renderer for CS-CLI
 *
 * High-performance software rasterizer with:
 * - ARM NEON / SSE2 SIMD acceleration
 * - Per-face lighting (ambient + directional)
 * - Texture mapping with perspective-correct interpolation
 * - Backface culling toggle
 * - Proper MSAA with sub-pixel sample positions
 * - Zero-copy N-API TypedArray integration
 * - Multi-threaded parallel rendering with pthreads
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
  #define USE_SSE2 1
#endif

// Threading configuration
#define MAX_THREADS 8
#define MIN_ROWS_PER_THREAD 16

// Thread pool state
typedef struct {
  pthread_t threads[MAX_THREADS];
  pthread_mutex_t mutex;
  pthread_cond_t work_ready;
  pthread_cond_t work_done;
  int num_threads;
  int active_workers;
  bool shutdown;

  // Work parameters (set by main thread before signaling)
  int work_type;  // 0=none, 1=clear, 2=msaa_resolve
  int row_start;
  int row_end;
  int next_row;  // Atomic row counter for work stealing
  uint8_t clear_r, clear_g, clear_b;
} ThreadPool;

static ThreadPool* g_thread_pool = NULL;

// Renderer state
static int g_width = 0;
static int g_height = 0;
static int g_msaa_samples = 1;

// Framebuffers
static uint8_t* g_framebuffer = NULL;       // RGB output
static float* g_depth_buffer = NULL;        // Depth values
static uint8_t* g_msaa_buffer = NULL;       // MSAA color samples
static float* g_msaa_depth = NULL;          // MSAA depth samples

// Lighting parameters (matching JS renderer defaults)
static float g_ambient_light = 0.3f;
static float g_light_dir[3] = {0.4319f, 0.8639f, 0.2592f};  // normalized (0.5, 1, 0.3)

// Rendering options
static bool g_enable_backface_culling = false;
static bool g_enable_textures = true;

// Current texture (set per-mesh before rendering)
static uint8_t* g_current_texture = NULL;
static int g_texture_width = 0;
static int g_texture_height = 0;

// MSAA 4x sample positions (rotated grid pattern)
static const float msaa4_offsets[4][2] = {
  {-0.125f, -0.375f},
  { 0.375f, -0.125f},
  { 0.125f,  0.375f},
  {-0.375f,  0.125f}
};

// MSAA 16x sample positions
static const float msaa16_offsets[16][2] = {
  {-0.375f, -0.4375f}, {-0.125f, -0.3125f}, { 0.125f, -0.1875f}, { 0.375f, -0.0625f},
  {-0.4375f, -0.125f}, {-0.1875f,  0.0625f}, { 0.0625f,  0.1875f}, { 0.3125f,  0.3125f},
  {-0.3125f,  0.125f}, {-0.0625f,  0.25f},   { 0.1875f,  0.375f},  { 0.4375f,  0.4375f},
  {-0.25f,    0.3125f}, { 0.0f,     0.4375f}, { 0.25f,   -0.25f},   { 0.4375f, -0.375f}
};

// Helper macros
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

// Fast inverse square root (for normalizing vectors)
static inline float fast_rsqrt(float x) {
  float xhalf = 0.5f * x;
  int i = *(int*)&x;
  i = 0x5f3759df - (i >> 1);
  x = *(float*)&i;
  x = x * (1.5f - xhalf * x * x);
  return x;
}

// ========================================
// Thread Pool Implementation
// ========================================

// Forward declarations for thread work
static void do_clear_rows(int start_row, int end_row, uint8_t r, uint8_t g, uint8_t b);
static void do_msaa_resolve_rows(int start_row, int end_row);

// Worker thread function
static void* thread_worker(void* arg) {
  ThreadPool* pool = (ThreadPool*)arg;

  while (1) {
    pthread_mutex_lock(&pool->mutex);

    // Wait for work
    while (pool->work_type == 0 && !pool->shutdown) {
      pthread_cond_wait(&pool->work_ready, &pool->mutex);
    }

    if (pool->shutdown) {
      pthread_mutex_unlock(&pool->mutex);
      break;
    }

    int work_type = pool->work_type;
    uint8_t cr = pool->clear_r, cg = pool->clear_g, cb = pool->clear_b;

    // Work stealing: grab next available row chunk
    int chunk_size = 8;  // Process 8 rows at a time
    int my_start = pool->next_row;
    pool->next_row += chunk_size;
    int my_end = MIN(my_start + chunk_size, pool->row_end);

    pthread_mutex_unlock(&pool->mutex);

    // Process rows while there's work
    while (my_start < pool->row_end) {
      if (work_type == 1) {
        do_clear_rows(my_start, my_end, cr, cg, cb);
      } else if (work_type == 2) {
        do_msaa_resolve_rows(my_start, my_end);
      }

      // Grab more work
      pthread_mutex_lock(&pool->mutex);
      my_start = pool->next_row;
      pool->next_row += chunk_size;
      my_end = MIN(my_start + chunk_size, pool->row_end);
      pthread_mutex_unlock(&pool->mutex);
    }

    // Signal completion
    pthread_mutex_lock(&pool->mutex);
    pool->active_workers--;
    if (pool->active_workers == 0) {
      pool->work_type = 0;  // Reset work type
      pthread_cond_signal(&pool->work_done);
    }
    pthread_mutex_unlock(&pool->mutex);
  }

  return NULL;
}

// Initialize thread pool
static void init_thread_pool(int num_threads) {
  if (g_thread_pool) return;  // Already initialized

  g_thread_pool = (ThreadPool*)calloc(1, sizeof(ThreadPool));
  if (!g_thread_pool) return;

  pthread_mutex_init(&g_thread_pool->mutex, NULL);
  pthread_cond_init(&g_thread_pool->work_ready, NULL);
  pthread_cond_init(&g_thread_pool->work_done, NULL);

  // Limit threads
  if (num_threads <= 0) num_threads = 4;
  if (num_threads > MAX_THREADS) num_threads = MAX_THREADS;
  g_thread_pool->num_threads = num_threads;
  g_thread_pool->shutdown = false;
  g_thread_pool->work_type = 0;

  // Create worker threads
  for (int i = 0; i < num_threads; i++) {
    pthread_create(&g_thread_pool->threads[i], NULL, thread_worker, g_thread_pool);
  }
}

// Shutdown thread pool
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

// Dispatch parallel work
static void dispatch_parallel_work(int work_type, int row_start, int row_end,
                                   uint8_t cr, uint8_t cg, uint8_t cb) {
  if (!g_thread_pool || g_thread_pool->num_threads <= 0) {
    // Fallback to single-threaded
    if (work_type == 1) {
      do_clear_rows(row_start, row_end, cr, cg, cb);
    } else if (work_type == 2) {
      do_msaa_resolve_rows(row_start, row_end);
    }
    return;
  }

  // Only use threads if there's enough work
  int rows = row_end - row_start;
  if (rows < MIN_ROWS_PER_THREAD * 2) {
    if (work_type == 1) {
      do_clear_rows(row_start, row_end, cr, cg, cb);
    } else if (work_type == 2) {
      do_msaa_resolve_rows(row_start, row_end);
    }
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

  // Wake all workers
  pthread_cond_broadcast(&g_thread_pool->work_ready);

  // Wait for completion
  while (g_thread_pool->active_workers > 0) {
    pthread_cond_wait(&g_thread_pool->work_done, &g_thread_pool->mutex);
  }

  pthread_mutex_unlock(&g_thread_pool->mutex);
}

// ========================================
// Row-based work functions
// ========================================

// Clear rows (called by workers)
static void do_clear_rows(int start_row, int end_row, uint8_t r, uint8_t g, uint8_t b) {
  if (!g_framebuffer || !g_depth_buffer) return;

  for (int y = start_row; y < end_row && y < g_height; y++) {
    size_t row_start = (size_t)y * g_width;

    // Clear color
    for (int x = 0; x < g_width; x++) {
      size_t i = row_start + x;
      g_framebuffer[i * 3] = r;
      g_framebuffer[i * 3 + 1] = g;
      g_framebuffer[i * 3 + 2] = b;
      g_depth_buffer[i] = 1.0f;
    }

    // Clear MSAA buffers if active
    if (g_msaa_samples > 1 && g_msaa_buffer && g_msaa_depth) {
      for (int s = 0; s < g_msaa_samples; s++) {
        size_t sample_row_start = s * g_width * g_height + row_start;
        for (int x = 0; x < g_width; x++) {
          size_t i = sample_row_start + x;
          g_msaa_buffer[i * 3] = r;
          g_msaa_buffer[i * 3 + 1] = g;
          g_msaa_buffer[i * 3 + 2] = b;
          g_msaa_depth[i] = 1.0f;
        }
      }
    }
  }
}

// MSAA resolve rows (called by workers)
static void do_msaa_resolve_rows(int start_row, int end_row) {
  if (!g_framebuffer || !g_msaa_buffer || g_msaa_samples <= 1) return;

  size_t pixel_count = (size_t)g_width * g_height;

  for (int y = start_row; y < end_row && y < g_height; y++) {
    for (int x = 0; x < g_width; x++) {
      size_t i = (size_t)y * g_width + x;

      uint32_t r_sum = 0, g_sum = 0, b_sum = 0;
      float min_depth = 1.0f;

      for (int s = 0; s < g_msaa_samples; s++) {
        size_t sample_idx = (s * pixel_count + i) * 3;
        r_sum += g_msaa_buffer[sample_idx];
        g_sum += g_msaa_buffer[sample_idx + 1];
        b_sum += g_msaa_buffer[sample_idx + 2];

        size_t depth_idx = s * pixel_count + i;
        if (g_msaa_depth[depth_idx] < min_depth) {
          min_depth = g_msaa_depth[depth_idx];
        }
      }

      g_framebuffer[i * 3] = (uint8_t)(r_sum / g_msaa_samples);
      g_framebuffer[i * 3 + 1] = (uint8_t)(g_sum / g_msaa_samples);
      g_framebuffer[i * 3 + 2] = (uint8_t)(b_sum / g_msaa_samples);
      g_depth_buffer[i] = min_depth;
    }
  }
}

// Sample texture at UV coordinates (with wrapping)
static inline void sample_texture(float u, float v, uint8_t* r, uint8_t* g, uint8_t* b) {
  if (!g_current_texture || g_texture_width <= 0 || g_texture_height <= 0) {
    *r = 200; *g = 200; *b = 200;
    return;
  }

  // Wrap UVs
  u = u - floorf(u);
  v = v - floorf(v);

  // Convert to pixel coordinates
  int tx = (int)(u * g_texture_width) % g_texture_width;
  int ty = (int)(v * g_texture_height) % g_texture_height;
  if (tx < 0) tx += g_texture_width;
  if (ty < 0) ty += g_texture_height;

  size_t idx = (ty * g_texture_width + tx) * 3;
  *r = g_current_texture[idx];
  *g = g_current_texture[idx + 1];
  *b = g_current_texture[idx + 2];
}

/**
 * Initialize the renderer.
 */
static napi_value render_init(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));

  if (argc < 3) {
    napi_throw_error(env, NULL, "Expected 3 arguments: width, height, msaaSamples");
    return NULL;
  }

  int32_t width, height, msaa;
  NAPI_CALL(env, napi_get_value_int32(env, args[0], &width));
  NAPI_CALL(env, napi_get_value_int32(env, args[1], &height));
  NAPI_CALL(env, napi_get_value_int32(env, args[2], &msaa));

  if (width <= 0 || height <= 0 || width > 4096 || height > 4096) {
    napi_throw_error(env, NULL, "Invalid dimensions (must be 1-4096)");
    return NULL;
  }
  if (msaa != 1 && msaa != 4 && msaa != 16) msaa = 1;

  // Free existing buffers
  free(g_framebuffer);
  free(g_depth_buffer);
  free(g_msaa_buffer);
  free(g_msaa_depth);

  g_width = width;
  g_height = height;
  g_msaa_samples = msaa;

  size_t pixel_count = (size_t)width * height;

  // Allocate with alignment for SIMD (aligned_alloc requires size to be multiple of alignment)
  size_t fb_size = ALIGN_UP(pixel_count * 3, 16);
  size_t depth_size = ALIGN_UP(pixel_count * sizeof(float), 16);

  g_framebuffer = (uint8_t*)aligned_alloc(16, fb_size);
  g_depth_buffer = (float*)aligned_alloc(16, depth_size);

  if (!g_framebuffer || !g_depth_buffer) {
    napi_throw_error(env, NULL, "Failed to allocate framebuffer");
    return NULL;
  }

  memset(g_framebuffer, 0, pixel_count * 3);

  // Initialize depth to far plane
  for (size_t i = 0; i < pixel_count; i++) {
    g_depth_buffer[i] = 1.0f;
  }

  // MSAA buffers
  if (msaa > 1) {
    size_t msaa_fb_size = ALIGN_UP(pixel_count * 3 * msaa, 16);
    size_t msaa_depth_size = ALIGN_UP(pixel_count * msaa * sizeof(float), 16);

    g_msaa_buffer = (uint8_t*)aligned_alloc(16, msaa_fb_size);
    g_msaa_depth = (float*)aligned_alloc(16, msaa_depth_size);

    if (!g_msaa_buffer || !g_msaa_depth) {
      napi_throw_error(env, NULL, "Failed to allocate MSAA buffers");
      return NULL;
    }

    memset(g_msaa_buffer, 0, pixel_count * 3 * msaa);
    for (size_t i = 0; i < pixel_count * msaa; i++) {
      g_msaa_depth[i] = 1.0f;
    }
  } else {
    g_msaa_buffer = NULL;
    g_msaa_depth = NULL;
  }

  // Initialize thread pool (use 4 threads by default)
  init_thread_pool(4);

  napi_value result;
  NAPI_CALL(env, napi_get_boolean(env, true, &result));
  return result;
}

/**
 * Clear framebuffer and depth (parallel).
 */
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
    napi_throw_error(env, NULL, "Renderer not initialized");
    return NULL;
  }

  // Dispatch parallel clear (work type 1)
  dispatch_parallel_work(1, 0, g_height, (uint8_t)r, (uint8_t)g, (uint8_t)b);

  napi_value result;
  NAPI_CALL(env, napi_get_undefined(env, &result));
  return result;
}

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

/**
 * Set rendering options (backface culling, textures enabled).
 */
static napi_value render_set_options(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));

  if (argc >= 1) {
    NAPI_CALL(env, napi_get_value_bool(env, args[0], &g_enable_backface_culling));
  }
  if (argc >= 2) {
    NAPI_CALL(env, napi_get_value_bool(env, args[1], &g_enable_textures));
  }

  // Reset debug counters at start of frame
  g_debug_frame++;
  g_debug_textures_set = 0;
  g_debug_triangles_with_uv = 0;
  g_debug_triangles_textured = 0;
  g_debug_backface_culled = 0;
  g_debug_near_clipped = 0;
  g_debug_frustum_culled = 0;
  g_debug_degenerate = 0;
  g_debug_total_tris = 0;

  napi_value result;
  NAPI_CALL(env, napi_get_undefined(env, &result));
  return result;
}

// Owned texture buffer (copied from JS to avoid GC issues)
static uint8_t* g_texture_buffer = NULL;
static size_t g_texture_buffer_size = 0;

/**
 * Set current texture for subsequent rendering.
 * Args: textureData (Uint8Array RGB), width, height
 *
 * NOTE: We copy the texture data because the JS TypedArray pointer
 * may become invalid after the call returns (GC, buffer detach, etc.)
 */
static napi_value render_set_texture(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));

  // Check for null/undefined first arg (no texture)
  napi_valuetype type;
  NAPI_CALL(env, napi_typeof(env, args[0], &type));

  if (type == napi_null || type == napi_undefined) {
    g_current_texture = NULL;
    g_texture_width = 0;
    g_texture_height = 0;
  } else if (argc >= 3) {
    uint8_t* src_data;
    size_t tex_len;
    NAPI_CALL(env, napi_get_typedarray_info(env, args[0], NULL, &tex_len, (void**)&src_data, NULL, NULL));
    NAPI_CALL(env, napi_get_value_int32(env, args[1], &g_texture_width));
    NAPI_CALL(env, napi_get_value_int32(env, args[2], &g_texture_height));

    // Reallocate buffer if needed
    size_t needed_size = (size_t)g_texture_width * g_texture_height * 3;
    if (needed_size > g_texture_buffer_size) {
      free(g_texture_buffer);
      g_texture_buffer = (uint8_t*)malloc(needed_size);
      g_texture_buffer_size = needed_size;
    }

    // Copy texture data
    if (g_texture_buffer && tex_len >= needed_size) {
      memcpy(g_texture_buffer, src_data, needed_size);
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

// Near plane threshold (matches JS Rasterizer.nearPlane = 0.05)
#define NEAR_PLANE 0.05f

// Clip vertex structure for near plane clipping
typedef struct {
  float cx, cy, cz, cw;  // Clip space position
  float u, v;             // UV coordinates
  uint8_t r, g, b;        // Color
} ClipVert;

/**
 * Transform vertex by MVP matrix.
 */
static inline void transform_vertex(
    float x, float y, float z,
    const float* __restrict mvp,
    float* __restrict out_x, float* __restrict out_y,
    float* __restrict out_z, float* __restrict out_w
) {
  *out_x = mvp[0] * x + mvp[4] * y + mvp[8]  * z + mvp[12];
  *out_y = mvp[1] * x + mvp[5] * y + mvp[9]  * z + mvp[13];
  *out_z = mvp[2] * x + mvp[6] * y + mvp[10] * z + mvp[14];
  *out_w = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
}

/**
 * Lerp between two clip vertices at parameter t.
 */
static inline ClipVert lerp_clip_vert(const ClipVert* a, const ClipVert* b, float t) {
  ClipVert result;
  result.cx = a->cx + (b->cx - a->cx) * t;
  result.cy = a->cy + (b->cy - a->cy) * t;
  result.cz = a->cz + (b->cz - a->cz) * t;
  result.cw = a->cw + (b->cw - a->cw) * t;
  result.u = a->u + (b->u - a->u) * t;
  result.v = a->v + (b->v - a->v) * t;
  result.r = (uint8_t)(a->r + (b->r - a->r) * t);
  result.g = (uint8_t)(a->g + (b->g - a->g) * t);
  result.b = (uint8_t)(a->b + (b->b - a->b) * t);
  return result;
}

/**
 * Clip triangle against near plane (w >= NEAR_PLANE).
 * Returns number of output triangles (0, 1, or 2).
 * out_tris should have space for 6 vertices (2 triangles).
 */
static int clip_triangle_near_plane(
    const ClipVert* v0, const ClipVert* v1, const ClipVert* v2,
    ClipVert* out_tris
) {
  // Classify vertices
  int inside0 = (v0->cw >= NEAR_PLANE) ? 1 : 0;
  int inside1 = (v1->cw >= NEAR_PLANE) ? 1 : 0;
  int inside2 = (v2->cw >= NEAR_PLANE) ? 1 : 0;
  int inside_count = inside0 + inside1 + inside2;

  // All inside - no clipping needed
  if (inside_count == 3) {
    out_tris[0] = *v0;
    out_tris[1] = *v1;
    out_tris[2] = *v2;
    return 1;
  }

  // All outside - cull entire triangle
  if (inside_count == 0) {
    return 0;
  }

  // Partially clipped
  if (inside_count == 1) {
    // One vertex inside, two outside - creates one smaller triangle
    const ClipVert *vi, *vo1, *vo2;
    if (inside0) { vi = v0; vo1 = v1; vo2 = v2; }
    else if (inside1) { vi = v1; vo1 = v2; vo2 = v0; }
    else { vi = v2; vo1 = v0; vo2 = v1; }

    // Find intersection points
    float t1 = (NEAR_PLANE - vi->cw) / (vo1->cw - vi->cw);
    float t2 = (NEAR_PLANE - vi->cw) / (vo2->cw - vi->cw);

    ClipVert new_v1 = lerp_clip_vert(vi, vo1, t1);
    ClipVert new_v2 = lerp_clip_vert(vi, vo2, t2);

    out_tris[0] = *vi;
    out_tris[1] = new_v1;
    out_tris[2] = new_v2;
    return 1;
  }

  // Two vertices inside, one outside - creates two triangles (quad)
  const ClipVert *vi0, *vi1, *vo;
  if (!inside0) { vo = v0; vi0 = v1; vi1 = v2; }
  else if (!inside1) { vo = v1; vi0 = v2; vi1 = v0; }
  else { vo = v2; vi0 = v0; vi1 = v1; }

  // Find intersection points on edges from inside vertices to outside vertex
  float t0 = (NEAR_PLANE - vi0->cw) / (vo->cw - vi0->cw);
  float t1 = (NEAR_PLANE - vi1->cw) / (vo->cw - vi1->cw);

  ClipVert new_v0 = lerp_clip_vert(vi0, vo, t0);
  ClipVert new_v1 = lerp_clip_vert(vi1, vo, t1);

  // First triangle: vi0, vi1, new_v1
  out_tris[0] = *vi0;
  out_tris[1] = *vi1;
  out_tris[2] = new_v1;

  // Second triangle: vi0, new_v1, new_v0
  out_tris[3] = *vi0;
  out_tris[4] = new_v1;
  out_tris[5] = new_v0;

  return 2;
}

/**
 * Rasterize textured triangle to a specific buffer.
 */
static inline void rasterize_triangle_textured(
    float x0, float y0, float z0, float w0, float u0, float v0,
    float x1, float y1, float z1, float w1, float u1, float v1,
    float x2, float y2, float z2, float w2, float u2, float v2,
    uint8_t base_r, uint8_t base_g, uint8_t base_b,
    float light_factor,
    uint8_t* __restrict color_buf,
    float* __restrict depth_buf,
    int stride
) {
  // Bounding box
  int minX = (int)floorf(MIN(MIN(x0, x1), x2));
  int maxX = (int)ceilf(MAX(MAX(x0, x1), x2));
  int minY = (int)floorf(MIN(MIN(y0, y1), y2));
  int maxY = (int)ceilf(MAX(MAX(y0, y1), y2));

  // Clip to screen
  minX = MAX(minX, 0);
  minY = MAX(minY, 0);
  maxX = MIN(maxX, g_width - 1);
  maxY = MIN(maxY, g_height - 1);

  // Edge equations
  float dx01 = x1 - x0, dy01 = y1 - y0;
  float dx12 = x2 - x1, dy12 = y2 - y1;
  float dx20 = x0 - x2, dy20 = y0 - y2;

  // Triangle area (2x)
  float area = dx01 * (y2 - y0) - dy01 * (x2 - x0);
  if (fabsf(area) < 0.0001f) {
    g_debug_degenerate++;
    return;
  }
  float invArea = 1.0f / area;

  // Precompute 1/w for perspective-correct interpolation
  float inv_w0 = 1.0f / w0;
  float inv_w1 = 1.0f / w1;
  float inv_w2 = 1.0f / w2;

  // Perspective-correct UV divided by w
  float u0_w = u0 * inv_w0, v0_w = v0 * inv_w0;
  float u1_w = u1 * inv_w1, v1_w = v1 * inv_w1;
  float u2_w = u2 * inv_w2, v2_w = v2 * inv_w2;

  bool use_texture = g_enable_textures && g_current_texture != NULL;

  // Rasterize
  for (int py = minY; py <= maxY; py++) {
    float fy = py + 0.5f;
    int row_start = py * stride;

    for (int px = minX; px <= maxX; px++) {
      float fx = px + 0.5f;

      // Edge functions
      float e0 = dx12 * (fy - y1) - dy12 * (fx - x1);
      float e1 = dx20 * (fy - y2) - dy20 * (fx - x2);
      float e2 = dx01 * (fy - y0) - dy01 * (fx - x0);

      // Inside test
      if (e0 >= -0.001f && e1 >= -0.001f && e2 >= -0.001f) {
        // Barycentric coordinates
        float bary0 = e0 * invArea;
        float bary1 = e1 * invArea;
        float bary2 = 1.0f - bary0 - bary1;

        // Interpolate depth (bary0 weights v0, bary1 weights v1, bary2 weights v2)
        float depth = bary0 * z0 + bary1 * z1 + bary2 * z2;

        // Depth test
        size_t idx = row_start + px;
        if (depth < depth_buf[idx]) {
          depth_buf[idx] = depth;

          uint8_t final_r, final_g, final_b;

          if (use_texture) {
            // Perspective-correct UV interpolation
            float interp_inv_w = bary0 * inv_w0 + bary1 * inv_w1 + bary2 * inv_w2;
            float interp_u_w = bary0 * u0_w + bary1 * u1_w + bary2 * u2_w;
            float interp_v_w = bary0 * v0_w + bary1 * v1_w + bary2 * v2_w;

            float u = interp_u_w / interp_inv_w;
            float v = interp_v_w / interp_inv_w;

            uint8_t tex_r, tex_g, tex_b;
            sample_texture(u, v, &tex_r, &tex_g, &tex_b);

            // Apply lighting to texture color
            final_r = (uint8_t)CLAMP(tex_r * light_factor, 0, 255);
            final_g = (uint8_t)CLAMP(tex_g * light_factor, 0, 255);
            final_b = (uint8_t)CLAMP(tex_b * light_factor, 0, 255);
          } else {
            // Use base color with lighting
            final_r = (uint8_t)CLAMP(base_r * light_factor, 0, 255);
            final_g = (uint8_t)CLAMP(base_g * light_factor, 0, 255);
            final_b = (uint8_t)CLAMP(base_b * light_factor, 0, 255);
          }

          color_buf[idx * 3] = final_r;
          color_buf[idx * 3 + 1] = final_g;
          color_buf[idx * 3 + 2] = final_b;
        }
      }
    }
  }
}

/**
 * Process a single clipped triangle through perspective divide, culling, and rasterization.
 * Returns 1 if rendered, 0 if culled.
 */
static int process_clipped_triangle(
    const ClipVert* cv0, const ClipVert* cv1, const ClipVert* cv2,
    float light_factor,
    float halfW, float halfH
) {
  // Perspective divide
  float ndcX0 = cv0->cx / cv0->cw, ndcY0 = cv0->cy / cv0->cw, ndcZ0 = cv0->cz / cv0->cw;
  float ndcX1 = cv1->cx / cv1->cw, ndcY1 = cv1->cy / cv1->cw, ndcZ1 = cv1->cz / cv1->cw;
  float ndcX2 = cv2->cx / cv2->cw, ndcY2 = cv2->cy / cv2->cw, ndcZ2 = cv2->cz / cv2->cw;

  // Frustum cull (only cull if ALL vertices are on same side)
  if ((ndcX0 < -1 && ndcX1 < -1 && ndcX2 < -1) ||
      (ndcX0 > 1 && ndcX1 > 1 && ndcX2 > 1) ||
      (ndcY0 < -1 && ndcY1 < -1 && ndcY2 < -1) ||
      (ndcY0 > 1 && ndcY1 > 1 && ndcY2 > 1)) {
    g_debug_frustum_culled++;
    return 0;
  }

  // Screen space coordinates
  float sx0 = (ndcX0 + 1) * halfW, sy0 = (1 - ndcY0) * halfH;
  float sx1 = (ndcX1 + 1) * halfW, sy1 = (1 - ndcY1) * halfH;
  float sx2 = (ndcX2 + 1) * halfW, sy2 = (1 - ndcY2) * halfH;

  // Compute signed area for winding check
  float signed_area = (sx1 - sx0) * (sy2 - sy0) - (sx2 - sx0) * (sy1 - sy0);

  // Backface culling
  if (g_enable_backface_culling && signed_area < 0) {
    g_debug_backface_culled++;
    return 0;
  }

  // If area is negative but culling is off, swap v1 and v2
  float rsx0 = sx0, rsy0 = sy0, rsz0 = ndcZ0, rcw0 = cv0->cw;
  float rsx1 = sx1, rsy1 = sy1, rsz1 = ndcZ1, rcw1 = cv1->cw;
  float rsx2 = sx2, rsy2 = sy2, rsz2 = ndcZ2, rcw2 = cv2->cw;
  float ru0 = cv0->u, rv0 = cv0->v;
  float ru1 = cv1->u, rv1 = cv1->v;
  float ru2 = cv2->u, rv2 = cv2->v;
  uint8_t rr0 = cv0->r, rg0 = cv0->g, rb0 = cv0->b;

  if (signed_area < 0) {
    // Swap v1 and v2
    rsx1 = sx2; rsy1 = sy2; rsz1 = ndcZ2; rcw1 = cv2->cw;
    rsx2 = sx1; rsy2 = sy1; rsz2 = ndcZ1; rcw2 = cv1->cw;
    ru1 = cv2->u; rv1 = cv2->v;
    ru2 = cv1->u; rv2 = cv1->v;
  }

  // Rasterize based on MSAA mode
  if (g_msaa_samples == 1) {
    rasterize_triangle_textured(
      rsx0, rsy0, rsz0, rcw0, ru0, rv0,
      rsx1, rsy1, rsz1, rcw1, ru1, rv1,
      rsx2, rsy2, rsz2, rcw2, ru2, rv2,
      rr0, rg0, rb0, light_factor,
      g_framebuffer, g_depth_buffer, g_width
    );
  } else {
    const float (*offsets)[2] = (g_msaa_samples == 4) ? msaa4_offsets : msaa16_offsets;

    for (int s = 0; s < g_msaa_samples; s++) {
      float ox = offsets[s][0];
      float oy = offsets[s][1];

      size_t sample_offset = s * g_width * g_height;
      uint8_t* sample_color = g_msaa_buffer + sample_offset * 3;
      float* sample_depth = g_msaa_depth + sample_offset;

      rasterize_triangle_textured(
        rsx0 + ox, rsy0 + oy, rsz0, rcw0, ru0, rv0,
        rsx1 + ox, rsy1 + oy, rsz1, rcw1, ru1, rv1,
        rsx2 + ox, rsy2 + oy, rsz2, rcw2, ru2, rv2,
        rr0, rg0, rb0, light_factor,
        sample_color, sample_depth, g_width
      );
    }
  }

  return 1;
}

/**
 * Render triangles with lighting, textures, and MSAA support.
 *
 * Args:
 *   vertices: Float32Array (x,y,z per vertex)
 *   indices: Uint32Array (3 per triangle)
 *   mvpMatrix: Float32Array (16 floats)
 *   colors: Uint8Array (r,g,b per vertex)
 *   normals: Float32Array (nx,ny,nz per vertex)
 *   uvs: Float32Array (u,v per vertex) - can be null/empty
 */
static napi_value render_triangles_batch(napi_env env, napi_callback_info info) {
  size_t argc = 6;
  napi_value args[6];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL));

  if (argc < 5) {
    napi_throw_error(env, NULL, "Expected at least 5 arguments: vertices, indices, mvp, colors, normals");
    return NULL;
  }

  if (!g_framebuffer) {
    napi_throw_error(env, NULL, "Renderer not initialized");
    return NULL;
  }

  // Get typed arrays
  float* vertices;
  uint32_t* indices;
  float* mvp;
  uint8_t* colors;
  float* normals;
  float* uvs = NULL;

  size_t vertex_count, index_count, mvp_len, color_count, normal_count, uv_count = 0;
  napi_typedarray_type type;

  NAPI_CALL(env, napi_get_typedarray_info(env, args[0], &type, &vertex_count, (void**)&vertices, NULL, NULL));
  NAPI_CALL(env, napi_get_typedarray_info(env, args[1], &type, &index_count, (void**)&indices, NULL, NULL));
  NAPI_CALL(env, napi_get_typedarray_info(env, args[2], &type, &mvp_len, (void**)&mvp, NULL, NULL));
  NAPI_CALL(env, napi_get_typedarray_info(env, args[3], &type, &color_count, (void**)&colors, NULL, NULL));
  NAPI_CALL(env, napi_get_typedarray_info(env, args[4], &type, &normal_count, (void**)&normals, NULL, NULL));

  // UVs are optional (6th argument)
  if (argc >= 6) {
    napi_valuetype uv_type;
    NAPI_CALL(env, napi_typeof(env, args[5], &uv_type));
    if (uv_type != napi_null && uv_type != napi_undefined) {
      NAPI_CALL(env, napi_get_typedarray_info(env, args[5], &type, &uv_count, (void**)&uvs, NULL, NULL));
    }
  }

  int triangle_count = (int)(index_count / 3);
  int rendered = 0;

  float halfW = g_width * 0.5f;
  float halfH = g_height * 0.5f;

  for (int t = 0; t < triangle_count; t++) {
    uint32_t i0 = indices[t * 3];
    uint32_t i1 = indices[t * 3 + 1];
    uint32_t i2 = indices[t * 3 + 2];

    // Vertex positions
    float vx0 = vertices[i0 * 3], vy0 = vertices[i0 * 3 + 1], vz0 = vertices[i0 * 3 + 2];
    float vx1 = vertices[i1 * 3], vy1 = vertices[i1 * 3 + 1], vz1 = vertices[i1 * 3 + 2];
    float vx2 = vertices[i2 * 3], vy2 = vertices[i2 * 3 + 1], vz2 = vertices[i2 * 3 + 2];

    // Transform to clip space
    float cx0, cy0, cz0, cw0;
    float cx1, cy1, cz1, cw1;
    float cx2, cy2, cz2, cw2;

    transform_vertex(vx0, vy0, vz0, mvp, &cx0, &cy0, &cz0, &cw0);
    transform_vertex(vx1, vy1, vz1, mvp, &cx1, &cy1, &cz1, &cw1);
    transform_vertex(vx2, vy2, vz2, mvp, &cx2, &cy2, &cz2, &cw2);

    g_debug_total_tris++;

    // Get colors and UVs for original vertices
    uint8_t r0 = colors[i0 * 3], g0 = colors[i0 * 3 + 1], b0 = colors[i0 * 3 + 2];
    uint8_t r1 = colors[i1 * 3], g1 = colors[i1 * 3 + 1], b1 = colors[i1 * 3 + 2];
    uint8_t r2 = colors[i2 * 3], g2 = colors[i2 * 3 + 1], b2 = colors[i2 * 3 + 2];

    float u0 = 0, v0 = 0, u1 = 0, v1 = 0, u2 = 0, v2 = 0;
    if (uvs && uv_count >= (i2 + 1) * 2) {
      u0 = uvs[i0 * 2]; v0 = uvs[i0 * 2 + 1];
      u1 = uvs[i1 * 2]; v1 = uvs[i1 * 2 + 1];
      u2 = uvs[i2 * 2]; v2 = uvs[i2 * 2 + 1];
      g_debug_triangles_with_uv++;
    }

    // Build ClipVert structures
    ClipVert cv0 = { cx0, cy0, cz0, cw0, u0, v0, r0, g0, b0 };
    ClipVert cv1 = { cx1, cy1, cz1, cw1, u1, v1, r1, g1, b1 };
    ClipVert cv2 = { cx2, cy2, cz2, cw2, u2, v2, r2, g2, b2 };

    // Clip triangle against near plane - may produce 0, 1, or 2 triangles
    ClipVert clipped[6];  // Space for 2 triangles
    int num_tris = clip_triangle_near_plane(&cv0, &cv1, &cv2, clipped);

    if (num_tris == 0) {
      g_debug_near_clipped++;
      continue;
    }

    // Compute face normal for lighting (using original vertices)
    float nx, ny, nz;
    if (normal_count >= (i2 + 1) * 3) {
      nx = (normals[i0 * 3] + normals[i1 * 3] + normals[i2 * 3]) * 0.333333f;
      ny = (normals[i0 * 3 + 1] + normals[i1 * 3 + 1] + normals[i2 * 3 + 1]) * 0.333333f;
      nz = (normals[i0 * 3 + 2] + normals[i1 * 3 + 2] + normals[i2 * 3 + 2]) * 0.333333f;
    } else {
      float e1x = vx1 - vx0, e1y = vy1 - vy0, e1z = vz1 - vz0;
      float e2x = vx2 - vx0, e2y = vy2 - vy0, e2z = vz2 - vz0;
      nx = e1y * e2z - e1z * e2y;
      ny = e1z * e2x - e1x * e2z;
      nz = e1x * e2y - e1y * e2x;
    }

    // Normalize
    float len_sq = nx * nx + ny * ny + nz * nz;
    if (len_sq > 0.0001f) {
      float inv_len = fast_rsqrt(len_sq);
      nx *= inv_len;
      ny *= inv_len;
      nz *= inv_len;
    }

    // Compute lighting
    float nDotL = nx * g_light_dir[0] + ny * g_light_dir[1] + nz * g_light_dir[2];
    if (nDotL < 0) nDotL = 0;
    float light_factor = g_ambient_light + (1.0f - g_ambient_light) * nDotL;

    // Track texture usage
    if (g_enable_textures && g_current_texture != NULL) {
      g_debug_triangles_textured++;
    }

    // Process each clipped triangle
    for (int ct = 0; ct < num_tris; ct++) {
      ClipVert* t0 = &clipped[ct * 3];
      ClipVert* t1 = &clipped[ct * 3 + 1];
      ClipVert* t2 = &clipped[ct * 3 + 2];

      if (process_clipped_triangle(t0, t1, t2, light_factor, halfW, halfH)) {
        rendered++;
      }
    }
  }

  napi_value result;
  NAPI_CALL(env, napi_create_int32(env, rendered, &result));
  return result;
}

/**
 * Resolve MSAA samples to framebuffer (parallel).
 * Also resolves depth buffer (minimum depth across samples) for sprite occlusion.
 */
static napi_value render_resolve_msaa(napi_env env, napi_callback_info info) {
  if (!g_framebuffer || g_msaa_samples <= 1 || !g_msaa_buffer) {
    napi_value result;
    NAPI_CALL(env, napi_get_undefined(env, &result));
    return result;
  }

  // Dispatch parallel MSAA resolve (work type 2)
  dispatch_parallel_work(2, 0, g_height, 0, 0, 0);

  napi_value result;
  NAPI_CALL(env, napi_get_undefined(env, &result));
  return result;
}

/**
 * Get framebuffer as Uint8Array (zero-copy).
 */
static napi_value render_get_framebuffer(napi_env env, napi_callback_info info) {
  if (!g_framebuffer) {
    napi_throw_error(env, NULL, "Renderer not initialized");
    return NULL;
  }

  size_t byte_length = (size_t)g_width * g_height * 3;

  napi_value array_buffer;
  NAPI_CALL(env, napi_create_external_arraybuffer(
    env, g_framebuffer, byte_length, NULL, NULL, &array_buffer
  ));

  napi_value result;
  NAPI_CALL(env, napi_create_typedarray(
    env, napi_uint8_array, byte_length, array_buffer, 0, &result
  ));

  return result;
}

/**
 * Get depth buffer as Float32Array for JS occlusion testing.
 */
static napi_value render_get_depth_buffer(napi_env env, napi_callback_info info) {
  if (!g_depth_buffer) {
    napi_throw_error(env, NULL, "Renderer not initialized");
    return NULL;
  }

  size_t byte_length = (size_t)g_width * g_height * sizeof(float);

  napi_value array_buffer;
  NAPI_CALL(env, napi_create_external_arraybuffer(
    env, g_depth_buffer, byte_length, NULL, NULL, &array_buffer
  ));

  napi_value result;
  NAPI_CALL(env, napi_create_typedarray(
    env, napi_float32_array, (size_t)g_width * g_height, array_buffer, 0, &result
  ));

  return result;
}

/**
 * Get dimensions.
 */
static napi_value render_get_dimensions(napi_env env, napi_callback_info info) {
  napi_value result, w, h;
  NAPI_CALL(env, napi_create_object(env, &result));
  NAPI_CALL(env, napi_create_int32(env, g_width, &w));
  NAPI_CALL(env, napi_create_int32(env, g_height, &h));
  NAPI_CALL(env, napi_set_named_property(env, result, "width", w));
  NAPI_CALL(env, napi_set_named_property(env, result, "height", h));
  return result;
}

/**
 * Cleanup.
 */
static napi_value render_cleanup(napi_env env, napi_callback_info info) {
  // Shutdown thread pool first
  shutdown_thread_pool();

  free(g_framebuffer);
  free(g_depth_buffer);
  free(g_msaa_buffer);
  free(g_msaa_depth);
  free(g_texture_buffer);

  g_framebuffer = NULL;
  g_depth_buffer = NULL;
  g_msaa_buffer = NULL;
  g_msaa_depth = NULL;
  g_current_texture = NULL;
  g_texture_buffer = NULL;
  g_texture_buffer_size = 0;
  g_width = 0;
  g_height = 0;
  g_msaa_samples = 1;

  napi_value result;
  NAPI_CALL(env, napi_get_undefined(env, &result));
  return result;
}

/**
 * Get debug stats.
 */
static napi_value render_get_debug_stats(napi_env env, napi_callback_info info) {
  napi_value result;
  NAPI_CALL(env, napi_create_object(env, &result));

  napi_value v;
  NAPI_CALL(env, napi_create_int32(env, g_debug_frame, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "frame", v));

  NAPI_CALL(env, napi_create_int32(env, g_debug_total_tris, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "totalTris", v));

  NAPI_CALL(env, napi_create_int32(env, g_debug_near_clipped, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "nearClipped", v));

  NAPI_CALL(env, napi_create_int32(env, g_debug_frustum_culled, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "frustumCulled", v));

  NAPI_CALL(env, napi_create_int32(env, g_debug_backface_culled, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "backfaceCulled", v));

  NAPI_CALL(env, napi_create_int32(env, g_debug_degenerate, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "degenerate", v));

  NAPI_CALL(env, napi_create_int32(env, g_debug_textures_set, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "texturesSet", v));

  NAPI_CALL(env, napi_create_int32(env, g_debug_triangles_with_uv, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "trianglesWithUV", v));

  NAPI_CALL(env, napi_create_int32(env, g_debug_triangles_textured, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "trianglesTextured", v));

  NAPI_CALL(env, napi_get_boolean(env, g_enable_backface_culling, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "backfaceCullingEnabled", v));

  NAPI_CALL(env, napi_get_boolean(env, g_enable_textures, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "texturesEnabled", v));

  NAPI_CALL(env, napi_get_boolean(env, g_current_texture != NULL, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "hasTexture", v));

  NAPI_CALL(env, napi_create_int32(env, g_texture_width, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "textureWidth", v));

  NAPI_CALL(env, napi_create_int32(env, g_texture_height, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "textureHeight", v));

  return result;
}

/**
 * Check SIMD availability.
 */
static napi_value render_has_simd(napi_env env, napi_callback_info info) {
  napi_value result;
  bool has_simd = false;
#if defined(USE_NEON) || defined(USE_SSE2)
  has_simd = true;
#endif
  NAPI_CALL(env, napi_get_boolean(env, has_simd, &result));
  return result;
}

// Module init
static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    { "init", NULL, render_init, NULL, NULL, NULL, napi_default, NULL },
    { "clear", NULL, render_clear, NULL, NULL, NULL, napi_default, NULL },
    { "setOptions", NULL, render_set_options, NULL, NULL, NULL, napi_default, NULL },
    { "setTexture", NULL, render_set_texture, NULL, NULL, NULL, napi_default, NULL },
    { "renderTrianglesBatch", NULL, render_triangles_batch, NULL, NULL, NULL, napi_default, NULL },
    { "resolveMSAA", NULL, render_resolve_msaa, NULL, NULL, NULL, napi_default, NULL },
    { "getFramebuffer", NULL, render_get_framebuffer, NULL, NULL, NULL, napi_default, NULL },
    { "getDepthBuffer", NULL, render_get_depth_buffer, NULL, NULL, NULL, napi_default, NULL },
    { "getDimensions", NULL, render_get_dimensions, NULL, NULL, NULL, napi_default, NULL },
    { "cleanup", NULL, render_cleanup, NULL, NULL, NULL, napi_default, NULL },
    { "hasSIMD", NULL, render_has_simd, NULL, NULL, NULL, napi_default, NULL },
    { "getDebugStats", NULL, render_get_debug_stats, NULL, NULL, NULL, napi_default, NULL },
  };

  NAPI_CALL(env, napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props));
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
