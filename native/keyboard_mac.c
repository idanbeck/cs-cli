// Native macOS keyboard input using CGEventTap
// Captures global keyboard events for responsive FPS-style input

#include <node_api.h>
#include <CoreGraphics/CoreGraphics.h>
#include <CoreFoundation/CoreFoundation.h>
#include <ApplicationServices/ApplicationServices.h>
#include <pthread.h>
#include <stdbool.h>

// Key state tracking (256 possible key codes)
static bool key_states[256] = {false};
static bool key_just_pressed[256] = {false};
static bool key_just_released[256] = {false};
static pthread_mutex_t state_mutex = PTHREAD_MUTEX_INITIALIZER;

// Event tap and run loop
static CFMachPortRef event_tap = NULL;
static CFRunLoopSourceRef run_loop_source = NULL;
static CFRunLoopRef tap_run_loop = NULL;
static pthread_t tap_thread;
static bool running = false;

// Debug counters
static int event_count = 0;
static int last_keycode = -1;
static int last_event_type = -1;

// Callback for keyboard events
static CGEventRef keyboard_callback(
    CGEventTapProxy proxy,
    CGEventType type,
    CGEventRef event,
    void *user_info
) {
    event_count++;

    // Handle tap disabled (system can disable if too slow)
    if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
        CGEventTapEnable(event_tap, true);
        return event;
    }

    if (type != kCGEventKeyDown && type != kCGEventKeyUp && type != kCGEventFlagsChanged) {
        return event;
    }

    CGKeyCode keycode = (CGKeyCode)CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
    last_keycode = (int)keycode;
    last_event_type = (int)type;

    if (keycode < 256) {
        pthread_mutex_lock(&state_mutex);

        if (type == kCGEventKeyDown) {
            if (!key_states[keycode]) {
                key_just_pressed[keycode] = true;
            }
            key_states[keycode] = true;
        } else if (type == kCGEventKeyUp) {
            key_states[keycode] = false;
            key_just_released[keycode] = true;
        } else if (type == kCGEventFlagsChanged) {
            // Handle modifier keys (shift, ctrl, etc.)
            CGEventFlags flags = CGEventGetFlags(event);
            bool is_pressed = false;

            switch (keycode) {
                case 56: // Left Shift
                case 60: // Right Shift
                    is_pressed = (flags & kCGEventFlagMaskShift) != 0;
                    break;
                case 59: // Left Control
                case 62: // Right Control
                    is_pressed = (flags & kCGEventFlagMaskControl) != 0;
                    break;
                case 58: // Left Option/Alt
                case 61: // Right Option/Alt
                    is_pressed = (flags & kCGEventFlagMaskAlternate) != 0;
                    break;
                case 55: // Left Command
                case 54: // Right Command
                    is_pressed = (flags & kCGEventFlagMaskCommand) != 0;
                    break;
                default:
                    is_pressed = key_states[keycode];
            }

            if (is_pressed && !key_states[keycode]) {
                key_just_pressed[keycode] = true;
            } else if (!is_pressed && key_states[keycode]) {
                key_just_released[keycode] = true;
            }
            key_states[keycode] = is_pressed;
        }

        pthread_mutex_unlock(&state_mutex);
    }

    // Return event unchanged (we're just observing, not blocking)
    return event;
}

// Thread function to run the event tap
static void* tap_thread_func(void* arg) {
    tap_run_loop = CFRunLoopGetCurrent();
    CFRunLoopAddSource(tap_run_loop, run_loop_source, kCFRunLoopCommonModes);
    CGEventTapEnable(event_tap, true);
    CFRunLoopRun();
    return NULL;
}

// Check if we have accessibility permissions
static bool check_accessibility() {
    // Try to check if accessibility is enabled
    // On modern macOS, we need to use the Accessibility API
    CFStringRef keys[] = { kAXTrustedCheckOptionPrompt };
    CFTypeRef values[] = { kCFBooleanFalse };  // Don't prompt, just check
    CFDictionaryRef options = CFDictionaryCreate(
        kCFAllocatorDefault,
        (const void **)keys,
        (const void **)values,
        1,
        &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks
    );
    bool trusted = AXIsProcessTrustedWithOptions(options);
    CFRelease(options);
    return trusted;
}

// Start the keyboard hook
static napi_value start(napi_env env, napi_callback_info info) {
    napi_value result;

    if (running) {
        napi_get_boolean(env, true, &result);
        return result;
    }

    // Check accessibility first
    if (!check_accessibility()) {
        // Prompt user for accessibility
        CFStringRef keys[] = { kAXTrustedCheckOptionPrompt };
        CFTypeRef values[] = { kCFBooleanTrue };  // Prompt user
        CFDictionaryRef options = CFDictionaryCreate(
            kCFAllocatorDefault,
            (const void **)keys,
            (const void **)values,
            1,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks
        );
        AXIsProcessTrustedWithOptions(options);
        CFRelease(options);

        napi_get_boolean(env, false, &result);
        return result;
    }

    // Create event tap for keyboard events
    CGEventMask mask = CGEventMaskBit(kCGEventKeyDown) |
                       CGEventMaskBit(kCGEventKeyUp) |
                       CGEventMaskBit(kCGEventFlagsChanged);

    event_tap = CGEventTapCreate(
        kCGHIDEventTap,               // Tap at HID level (hardware)
        kCGHeadInsertEventTap,        // Insert at head
        kCGEventTapOptionDefault,     // Can observe and optionally modify
        mask,
        keyboard_callback,
        NULL
    );

    if (!event_tap) {
        // Failed - likely need accessibility permissions
        napi_get_boolean(env, false, &result);
        return result;
    }

    run_loop_source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, event_tap, 0);

    if (!run_loop_source) {
        CFRelease(event_tap);
        event_tap = NULL;
        napi_get_boolean(env, false, &result);
        return result;
    }

    running = true;
    pthread_create(&tap_thread, NULL, tap_thread_func, NULL);

    napi_get_boolean(env, true, &result);
    return result;
}

// Stop the keyboard hook
static napi_value stop(napi_env env, napi_callback_info info) {
    napi_value result;

    if (!running) {
        napi_get_boolean(env, true, &result);
        return result;
    }

    running = false;

    if (tap_run_loop) {
        CFRunLoopStop(tap_run_loop);
    }

    pthread_join(tap_thread, NULL);

    if (run_loop_source) {
        CFRelease(run_loop_source);
        run_loop_source = NULL;
    }

    if (event_tap) {
        CFRelease(event_tap);
        event_tap = NULL;
    }

    tap_run_loop = NULL;

    // Clear all states
    pthread_mutex_lock(&state_mutex);
    for (int i = 0; i < 256; i++) {
        key_states[i] = false;
        key_just_pressed[i] = false;
        key_just_released[i] = false;
    }
    pthread_mutex_unlock(&state_mutex);

    napi_get_boolean(env, true, &result);
    return result;
}

// Check if a key is currently held down
static napi_value is_key_down(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    int32_t keycode;
    napi_get_value_int32(env, args[0], &keycode);

    napi_value result;
    if (keycode >= 0 && keycode < 256) {
        pthread_mutex_lock(&state_mutex);
        napi_get_boolean(env, key_states[keycode], &result);
        pthread_mutex_unlock(&state_mutex);
    } else {
        napi_get_boolean(env, false, &result);
    }

    return result;
}

// Check if a key was just pressed this frame
static napi_value was_key_just_pressed(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    int32_t keycode;
    napi_get_value_int32(env, args[0], &keycode);

    napi_value result;
    if (keycode >= 0 && keycode < 256) {
        pthread_mutex_lock(&state_mutex);
        napi_get_boolean(env, key_just_pressed[keycode], &result);
        pthread_mutex_unlock(&state_mutex);
    } else {
        napi_get_boolean(env, false, &result);
    }

    return result;
}

// Check if a key was just released this frame
static napi_value was_key_just_released(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    int32_t keycode;
    napi_get_value_int32(env, args[0], &keycode);

    napi_value result;
    if (keycode >= 0 && keycode < 256) {
        pthread_mutex_lock(&state_mutex);
        napi_get_boolean(env, key_just_released[keycode], &result);
        pthread_mutex_unlock(&state_mutex);
    } else {
        napi_get_boolean(env, false, &result);
    }

    return result;
}

// Clear the "just pressed/released" flags (call once per frame)
static napi_value update(napi_env env, napi_callback_info info) {
    pthread_mutex_lock(&state_mutex);
    for (int i = 0; i < 256; i++) {
        key_just_pressed[i] = false;
        key_just_released[i] = false;
    }
    pthread_mutex_unlock(&state_mutex);

    napi_value result;
    napi_get_undefined(env, &result);
    return result;
}

// Check if running
static napi_value is_running(napi_env env, napi_callback_info info) {
    napi_value result;
    napi_get_boolean(env, running, &result);
    return result;
}

// Get event count (for debugging)
static napi_value get_event_count(napi_env env, napi_callback_info info) {
    napi_value result;
    napi_create_int32(env, event_count, &result);
    return result;
}

// Get last keycode (for debugging)
static napi_value get_last_keycode(napi_env env, napi_callback_info info) {
    napi_value result;
    napi_create_int32(env, last_keycode, &result);
    return result;
}

// Get last event type (for debugging)
static napi_value get_last_event_type(napi_env env, napi_callback_info info) {
    napi_value result;
    napi_create_int32(env, last_event_type, &result);
    return result;
}

// Module initialization
static napi_value init(napi_env env, napi_value exports) {
    napi_property_descriptor props[] = {
        {"start", NULL, start, NULL, NULL, NULL, napi_default, NULL},
        {"stop", NULL, stop, NULL, NULL, NULL, napi_default, NULL},
        {"isKeyDown", NULL, is_key_down, NULL, NULL, NULL, napi_default, NULL},
        {"wasKeyJustPressed", NULL, was_key_just_pressed, NULL, NULL, NULL, napi_default, NULL},
        {"wasKeyJustReleased", NULL, was_key_just_released, NULL, NULL, NULL, napi_default, NULL},
        {"update", NULL, update, NULL, NULL, NULL, napi_default, NULL},
        {"isRunning", NULL, is_running, NULL, NULL, NULL, napi_default, NULL},
        {"getEventCount", NULL, get_event_count, NULL, NULL, NULL, napi_default, NULL},
        {"getLastKeycode", NULL, get_last_keycode, NULL, NULL, NULL, napi_default, NULL},
        {"getLastEventType", NULL, get_last_event_type, NULL, NULL, NULL, napi_default, NULL},
    };

    napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);

    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
