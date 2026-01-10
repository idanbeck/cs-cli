/*
 * Codec2 Native Node.js Addon
 *
 * Wraps the Codec2 speech codec library for use in Node.js.
 * Provides encode/decode functions for ultra-low bitrate voice compression.
 *
 * Codec2 modes:
 *   3200 bps - 20ms frames, 64 bits/frame, 160 samples @ 8kHz
 *   2400 bps - 20ms frames, 48 bits/frame, 160 samples @ 8kHz
 *   1600 bps - 40ms frames, 64 bits/frame, 320 samples @ 8kHz
 *   1400 bps - 40ms frames, 56 bits/frame, 320 samples @ 8kHz
 *   1300 bps - 40ms frames, 52 bits/frame, 320 samples @ 8kHz
 *   1200 bps - 40ms frames, 48 bits/frame, 320 samples @ 8kHz
 *   700C bps - 40ms frames, 28 bits/frame, 320 samples @ 8kHz
 */

#include <node_api.h>
#include <codec2/codec2.h>
#include <stdlib.h>
#include <string.h>

// Store codec instances per mode for reuse
static struct CODEC2* codec_instances[16] = {0};

// Get or create codec instance for a mode
static struct CODEC2* get_codec(int mode) {
    if (mode < 0 || mode >= 16) return NULL;

    if (codec_instances[mode] == NULL) {
        codec_instances[mode] = codec2_create(mode);
    }
    return codec_instances[mode];
}

// Convert mode name string to mode constant
static int mode_from_string(const char* mode_str) {
    if (strcmp(mode_str, "3200") == 0) return CODEC2_MODE_3200;
    if (strcmp(mode_str, "2400") == 0) return CODEC2_MODE_2400;
    if (strcmp(mode_str, "1600") == 0) return CODEC2_MODE_1600;
    if (strcmp(mode_str, "1400") == 0) return CODEC2_MODE_1400;
    if (strcmp(mode_str, "1300") == 0) return CODEC2_MODE_1300;
    if (strcmp(mode_str, "1200") == 0) return CODEC2_MODE_1200;
    if (strcmp(mode_str, "700C") == 0 || strcmp(mode_str, "700c") == 0) return CODEC2_MODE_700C;
    return -1;
}

// Get mode info: { samplesPerFrame, bytesPerFrame, bitsPerFrame }
static napi_value GetModeInfo(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    // Get mode string
    char mode_str[16];
    size_t mode_len;
    napi_get_value_string_utf8(env, args[0], mode_str, sizeof(mode_str), &mode_len);

    int mode = mode_from_string(mode_str);
    if (mode < 0) {
        napi_throw_error(env, NULL, "Invalid codec2 mode");
        return NULL;
    }

    struct CODEC2* codec = get_codec(mode);
    if (!codec) {
        napi_throw_error(env, NULL, "Failed to create codec2 instance");
        return NULL;
    }

    int samples_per_frame = codec2_samples_per_frame(codec);
    int bytes_per_frame = codec2_bytes_per_frame(codec);
    int bits_per_frame = codec2_bits_per_frame(codec);

    // Create result object
    napi_value result;
    napi_create_object(env, &result);

    napi_value val;
    napi_create_int32(env, samples_per_frame, &val);
    napi_set_named_property(env, result, "samplesPerFrame", val);

    napi_create_int32(env, bytes_per_frame, &val);
    napi_set_named_property(env, result, "bytesPerFrame", val);

    napi_create_int32(env, bits_per_frame, &val);
    napi_set_named_property(env, result, "bitsPerFrame", val);

    // Calculate bitrate: bits_per_frame / (samples_per_frame / 8000) = bits_per_frame * 8000 / samples_per_frame
    double bitrate = (double)bits_per_frame * 8000.0 / (double)samples_per_frame;
    napi_create_double(env, bitrate, &val);
    napi_set_named_property(env, result, "bitrate", val);

    // Frame duration in ms
    double frame_ms = (double)samples_per_frame / 8.0; // samples / (8000 samples/sec) * 1000ms/sec
    napi_create_double(env, frame_ms, &val);
    napi_set_named_property(env, result, "frameDurationMs", val);

    return result;
}

// Encode audio samples to compressed bytes
// encode(mode: string, samples: Int16Array) => Uint8Array
static napi_value Encode(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    // Get mode string
    char mode_str[16];
    size_t mode_len;
    napi_get_value_string_utf8(env, args[0], mode_str, sizeof(mode_str), &mode_len);

    int mode = mode_from_string(mode_str);
    if (mode < 0) {
        napi_throw_error(env, NULL, "Invalid codec2 mode");
        return NULL;
    }

    struct CODEC2* codec = get_codec(mode);
    if (!codec) {
        napi_throw_error(env, NULL, "Failed to create codec2 instance");
        return NULL;
    }

    // Get input typed array (Int16Array)
    bool is_typedarray;
    napi_is_typedarray(env, args[1], &is_typedarray);
    if (!is_typedarray) {
        napi_throw_type_error(env, NULL, "Expected Int16Array for samples");
        return NULL;
    }

    napi_typedarray_type type;
    size_t length;
    void* data;
    napi_value arraybuffer;
    size_t byte_offset;
    napi_get_typedarray_info(env, args[1], &type, &length, &data, &arraybuffer, &byte_offset);

    if (type != napi_int16_array) {
        napi_throw_type_error(env, NULL, "Expected Int16Array for samples");
        return NULL;
    }

    short* samples = (short*)data;
    int samples_per_frame = codec2_samples_per_frame(codec);
    int bytes_per_frame = codec2_bytes_per_frame(codec);

    // Calculate number of complete frames
    int num_frames = (int)length / samples_per_frame;
    if (num_frames == 0) {
        napi_throw_error(env, NULL, "Input too short for even one frame");
        return NULL;
    }

    // Allocate output buffer
    size_t output_size = num_frames * bytes_per_frame;
    unsigned char* output = malloc(output_size);
    if (!output) {
        napi_throw_error(env, NULL, "Failed to allocate output buffer");
        return NULL;
    }

    // Encode each frame
    for (int i = 0; i < num_frames; i++) {
        codec2_encode(codec, output + i * bytes_per_frame, samples + i * samples_per_frame);
    }

    // Create result Uint8Array
    napi_value result_buffer;
    void* result_data;
    napi_create_arraybuffer(env, output_size, &result_data, &result_buffer);
    memcpy(result_data, output, output_size);
    free(output);

    napi_value result;
    napi_create_typedarray(env, napi_uint8_array, output_size, result_buffer, 0, &result);

    return result;
}

// Decode compressed bytes to audio samples
// decode(mode: string, bytes: Uint8Array) => Int16Array
static napi_value Decode(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    // Get mode string
    char mode_str[16];
    size_t mode_len;
    napi_get_value_string_utf8(env, args[0], mode_str, sizeof(mode_str), &mode_len);

    int mode = mode_from_string(mode_str);
    if (mode < 0) {
        napi_throw_error(env, NULL, "Invalid codec2 mode");
        return NULL;
    }

    struct CODEC2* codec = get_codec(mode);
    if (!codec) {
        napi_throw_error(env, NULL, "Failed to create codec2 instance");
        return NULL;
    }

    // Get input typed array (Uint8Array)
    bool is_typedarray;
    napi_is_typedarray(env, args[1], &is_typedarray);
    if (!is_typedarray) {
        napi_throw_type_error(env, NULL, "Expected Uint8Array for bytes");
        return NULL;
    }

    napi_typedarray_type type;
    size_t length;
    void* data;
    napi_value arraybuffer;
    size_t byte_offset;
    napi_get_typedarray_info(env, args[1], &type, &length, &data, &arraybuffer, &byte_offset);

    if (type != napi_uint8_array) {
        napi_throw_type_error(env, NULL, "Expected Uint8Array for bytes");
        return NULL;
    }

    unsigned char* bytes = (unsigned char*)data;
    int samples_per_frame = codec2_samples_per_frame(codec);
    int bytes_per_frame = codec2_bytes_per_frame(codec);

    // Calculate number of complete frames
    int num_frames = (int)length / bytes_per_frame;
    if (num_frames == 0) {
        napi_throw_error(env, NULL, "Input too short for even one frame");
        return NULL;
    }

    // Allocate output buffer
    size_t output_samples = num_frames * samples_per_frame;
    short* output = malloc(output_samples * sizeof(short));
    if (!output) {
        napi_throw_error(env, NULL, "Failed to allocate output buffer");
        return NULL;
    }

    // Decode each frame
    for (int i = 0; i < num_frames; i++) {
        codec2_decode(codec, output + i * samples_per_frame, bytes + i * bytes_per_frame);
    }

    // Create result Int16Array
    napi_value result_buffer;
    void* result_data;
    napi_create_arraybuffer(env, output_samples * sizeof(short), &result_data, &result_buffer);
    memcpy(result_data, output, output_samples * sizeof(short));
    free(output);

    napi_value result;
    napi_create_typedarray(env, napi_int16_array, output_samples, result_buffer, 0, &result);

    return result;
}

// Encode a single frame
// encodeFrame(mode: string, samples: Int16Array) => Uint8Array
static napi_value EncodeFrame(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    // Get mode string
    char mode_str[16];
    size_t mode_len;
    napi_get_value_string_utf8(env, args[0], mode_str, sizeof(mode_str), &mode_len);

    int mode = mode_from_string(mode_str);
    if (mode < 0) {
        napi_throw_error(env, NULL, "Invalid codec2 mode");
        return NULL;
    }

    struct CODEC2* codec = get_codec(mode);
    if (!codec) {
        napi_throw_error(env, NULL, "Failed to create codec2 instance");
        return NULL;
    }

    // Get input typed array
    napi_typedarray_type type;
    size_t length;
    void* data;
    napi_value arraybuffer;
    size_t byte_offset;
    napi_get_typedarray_info(env, args[1], &type, &length, &data, &arraybuffer, &byte_offset);

    short* samples = (short*)data;
    int bytes_per_frame = codec2_bytes_per_frame(codec);

    // Create output buffer
    napi_value result_buffer;
    void* result_data;
    napi_create_arraybuffer(env, bytes_per_frame, &result_data, &result_buffer);

    // Encode
    codec2_encode(codec, (unsigned char*)result_data, samples);

    napi_value result;
    napi_create_typedarray(env, napi_uint8_array, bytes_per_frame, result_buffer, 0, &result);

    return result;
}

// Decode a single frame
// decodeFrame(mode: string, bytes: Uint8Array) => Int16Array
static napi_value DecodeFrame(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    // Get mode string
    char mode_str[16];
    size_t mode_len;
    napi_get_value_string_utf8(env, args[0], mode_str, sizeof(mode_str), &mode_len);

    int mode = mode_from_string(mode_str);
    if (mode < 0) {
        napi_throw_error(env, NULL, "Invalid codec2 mode");
        return NULL;
    }

    struct CODEC2* codec = get_codec(mode);
    if (!codec) {
        napi_throw_error(env, NULL, "Failed to create codec2 instance");
        return NULL;
    }

    // Get input typed array
    napi_typedarray_type type;
    size_t length;
    void* data;
    napi_value arraybuffer;
    size_t byte_offset;
    napi_get_typedarray_info(env, args[1], &type, &length, &data, &arraybuffer, &byte_offset);

    unsigned char* bytes = (unsigned char*)data;
    int samples_per_frame = codec2_samples_per_frame(codec);

    // Create output buffer
    napi_value result_buffer;
    void* result_data;
    napi_create_arraybuffer(env, samples_per_frame * sizeof(short), &result_data, &result_buffer);

    // Decode
    codec2_decode(codec, (short*)result_data, bytes);

    napi_value result;
    napi_create_typedarray(env, napi_int16_array, samples_per_frame, result_buffer, 0, &result);

    return result;
}

// Get available modes
static napi_value GetModes(napi_env env, napi_callback_info info) {
    napi_value result;
    napi_create_array_with_length(env, 7, &result);

    const char* modes[] = {"3200", "2400", "1600", "1400", "1300", "1200", "700C"};

    for (int i = 0; i < 7; i++) {
        napi_value str;
        napi_create_string_utf8(env, modes[i], NAPI_AUTO_LENGTH, &str);
        napi_set_element(env, result, i, str);
    }

    return result;
}

// Module initialization
static napi_value Init(napi_env env, napi_value exports) {
    napi_property_descriptor props[] = {
        {"getModeInfo", NULL, GetModeInfo, NULL, NULL, NULL, napi_default, NULL},
        {"encode", NULL, Encode, NULL, NULL, NULL, napi_default, NULL},
        {"decode", NULL, Decode, NULL, NULL, NULL, napi_default, NULL},
        {"encodeFrame", NULL, EncodeFrame, NULL, NULL, NULL, napi_default, NULL},
        {"decodeFrame", NULL, DecodeFrame, NULL, NULL, NULL, napi_default, NULL},
        {"getModes", NULL, GetModes, NULL, NULL, NULL, napi_default, NULL},
    };

    napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);

    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
