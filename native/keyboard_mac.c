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

// Mouse state tracking
static double mouse_delta_x = 0.0;
static double mouse_delta_y = 0.0;
static bool mouse_button_states[8] = {false};  // Up to 8 mouse buttons
static bool mouse_button_just_pressed[8] = {false};
static bool mouse_button_just_released[8] = {false};
static bool cursor_captured = false;  // Whether cursor is captured
static CGFloat lock_x = 0;  // Screen position to lock cursor to
static CGFloat lock_y = 0;
static int warp_skip_count = 0;  // Number of events to skip after warp (warp can generate 1-2 events)

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

// Callback for keyboard and mouse events
static CGEventRef event_callback(
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

    // Handle mouse movement
    if (type == kCGEventMouseMoved || type == kCGEventLeftMouseDragged ||
        type == kCGEventRightMouseDragged || type == kCGEventOtherMouseDragged) {

        pthread_mutex_lock(&state_mutex);

        // If this is movement from our warp, skip it
        if (warp_skip_count > 0) {
            warp_skip_count--;
            pthread_mutex_unlock(&state_mutex);
            return event;
        }

        // Get delta values (raw mouse movement, not screen position)
        double dx = CGEventGetDoubleValueField(event, kCGMouseEventDeltaX);
        double dy = CGEventGetDoubleValueField(event, kCGMouseEventDeltaY);

        mouse_delta_x += dx;
        mouse_delta_y += dy;

        // If captured, warp cursor back to lock position
        if (cursor_captured && (dx != 0 || dy != 0)) {
            warp_skip_count = 2;  // Skip next 1-2 events from warp
            pthread_mutex_unlock(&state_mutex);
            // Warp cursor back to lock position (outside mutex to avoid deadlock)
            CGWarpMouseCursorPosition(CGPointMake(lock_x, lock_y));
            return event;
        }

        pthread_mutex_unlock(&state_mutex);
        return event;
    }

    // Handle mouse buttons
    if (type == kCGEventLeftMouseDown || type == kCGEventLeftMouseUp) {
        pthread_mutex_lock(&state_mutex);
        if (type == kCGEventLeftMouseDown) {
            if (!mouse_button_states[0]) {
                mouse_button_just_pressed[0] = true;
            }
            mouse_button_states[0] = true;
        } else {
            mouse_button_states[0] = false;
            mouse_button_just_released[0] = true;
        }
        pthread_mutex_unlock(&state_mutex);
        return event;
    }

    if (type == kCGEventRightMouseDown || type == kCGEventRightMouseUp) {
        pthread_mutex_lock(&state_mutex);
        if (type == kCGEventRightMouseDown) {
            if (!mouse_button_states[1]) {
                mouse_button_just_pressed[1] = true;
            }
            mouse_button_states[1] = true;
        } else {
            mouse_button_states[1] = false;
            mouse_button_just_released[1] = true;
        }
        pthread_mutex_unlock(&state_mutex);
        return event;
    }

    if (type == kCGEventOtherMouseDown || type == kCGEventOtherMouseUp) {
        int64_t button = CGEventGetIntegerValueField(event, kCGMouseEventButtonNumber);
        if (button >= 0 && button < 8) {
            pthread_mutex_lock(&state_mutex);
            if (type == kCGEventOtherMouseDown) {
                if (!mouse_button_states[button]) {
                    mouse_button_just_pressed[button] = true;
                }
                mouse_button_states[button] = true;
            } else {
                mouse_button_states[button] = false;
                mouse_button_just_released[button] = true;
            }
            pthread_mutex_unlock(&state_mutex);
        }
        return event;
    }

    // Handle keyboard events
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

    // Create event tap for keyboard and mouse events
    CGEventMask mask = CGEventMaskBit(kCGEventKeyDown) |
                       CGEventMaskBit(kCGEventKeyUp) |
                       CGEventMaskBit(kCGEventFlagsChanged) |
                       CGEventMaskBit(kCGEventMouseMoved) |
                       CGEventMaskBit(kCGEventLeftMouseDragged) |
                       CGEventMaskBit(kCGEventRightMouseDragged) |
                       CGEventMaskBit(kCGEventOtherMouseDragged) |
                       CGEventMaskBit(kCGEventLeftMouseDown) |
                       CGEventMaskBit(kCGEventLeftMouseUp) |
                       CGEventMaskBit(kCGEventRightMouseDown) |
                       CGEventMaskBit(kCGEventRightMouseUp) |
                       CGEventMaskBit(kCGEventOtherMouseDown) |
                       CGEventMaskBit(kCGEventOtherMouseUp);

    event_tap = CGEventTapCreate(
        kCGHIDEventTap,               // Tap at HID level (hardware)
        kCGHeadInsertEventTap,        // Insert at head
        kCGEventTapOptionDefault,     // Can observe and optionally modify
        mask,
        event_callback,
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

    // Release cursor if captured
    if (cursor_captured) {
        CGDisplayShowCursor(kCGDirectMainDisplay);
        cursor_captured = false;
        warp_skip_count = 0;
    }

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
    mouse_delta_x = 0.0;
    mouse_delta_y = 0.0;
    for (int i = 0; i < 8; i++) {
        mouse_button_states[i] = false;
        mouse_button_just_pressed[i] = false;
        mouse_button_just_released[i] = false;
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
    // Clear mouse delta (accumulated since last update)
    mouse_delta_x = 0.0;
    mouse_delta_y = 0.0;
    for (int i = 0; i < 8; i++) {
        mouse_button_just_pressed[i] = false;
        mouse_button_just_released[i] = false;
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

// ============ Mouse functions ============

// Get mouse delta and reset it (returns {x, y} object)
static napi_value get_mouse_delta(napi_env env, napi_callback_info info) {
    napi_value result;
    napi_create_object(env, &result);

    pthread_mutex_lock(&state_mutex);
    double dx = mouse_delta_x;
    double dy = mouse_delta_y;
    pthread_mutex_unlock(&state_mutex);

    napi_value x_val, y_val;
    napi_create_double(env, dx, &x_val);
    napi_create_double(env, dy, &y_val);

    napi_set_named_property(env, result, "x", x_val);
    napi_set_named_property(env, result, "y", y_val);

    return result;
}

// Check if mouse button is down
static napi_value is_mouse_button_down(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    int32_t button;
    napi_get_value_int32(env, args[0], &button);

    napi_value result;
    if (button >= 0 && button < 8) {
        pthread_mutex_lock(&state_mutex);
        napi_get_boolean(env, mouse_button_states[button], &result);
        pthread_mutex_unlock(&state_mutex);
    } else {
        napi_get_boolean(env, false, &result);
    }

    return result;
}

// Check if mouse button was just pressed
static napi_value was_mouse_button_just_pressed(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    int32_t button;
    napi_get_value_int32(env, args[0], &button);

    napi_value result;
    if (button >= 0 && button < 8) {
        pthread_mutex_lock(&state_mutex);
        napi_get_boolean(env, mouse_button_just_pressed[button], &result);
        pthread_mutex_unlock(&state_mutex);
    } else {
        napi_get_boolean(env, false, &result);
    }

    return result;
}

// Check if mouse button was just released
static napi_value was_mouse_button_just_released(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    int32_t button;
    napi_get_value_int32(env, args[0], &button);

    napi_value result;
    if (button >= 0 && button < 8) {
        pthread_mutex_lock(&state_mutex);
        napi_get_boolean(env, mouse_button_just_released[button], &result);
        pthread_mutex_unlock(&state_mutex);
    } else {
        napi_get_boolean(env, false, &result);
    }

    return result;
}

// ============ Cursor capture functions ============

// Capture/release cursor - warps cursor back to lock position on each move
// When captured, cursor stays in place but we still get delta events
static napi_value set_cursor_captured(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    bool capture;
    napi_get_value_bool(env, args[0], &capture);

    pthread_mutex_lock(&state_mutex);

    if (capture && !cursor_captured) {
        // Get current cursor position as lock point
        CGEventRef event = CGEventCreate(NULL);
        CGPoint cursor = CGEventGetLocation(event);
        CFRelease(event);

        lock_x = cursor.x;
        lock_y = cursor.y;
        warp_skip_count = 0;
        cursor_captured = true;

        // Hide cursor while captured
        CGDisplayHideCursor(kCGDirectMainDisplay);
    } else if (!capture && cursor_captured) {
        // Release: show cursor
        CGDisplayShowCursor(kCGDirectMainDisplay);
        cursor_captured = false;
        warp_skip_count = 0;
    }

    pthread_mutex_unlock(&state_mutex);

    napi_value result;
    napi_get_boolean(env, true, &result);
    return result;
}

// Check if cursor is captured
static napi_value is_cursor_captured(napi_env env, napi_callback_info info) {
    napi_value result;
    napi_get_boolean(env, cursor_captured, &result);
    return result;
}

// Module initialization
static napi_value init(napi_env env, napi_value exports) {
    napi_property_descriptor props[] = {
        // Keyboard
        {"start", NULL, start, NULL, NULL, NULL, napi_default, NULL},
        {"stop", NULL, stop, NULL, NULL, NULL, napi_default, NULL},
        {"isKeyDown", NULL, is_key_down, NULL, NULL, NULL, napi_default, NULL},
        {"wasKeyJustPressed", NULL, was_key_just_pressed, NULL, NULL, NULL, napi_default, NULL},
        {"wasKeyJustReleased", NULL, was_key_just_released, NULL, NULL, NULL, napi_default, NULL},
        {"update", NULL, update, NULL, NULL, NULL, napi_default, NULL},
        {"isRunning", NULL, is_running, NULL, NULL, NULL, napi_default, NULL},
        // Mouse
        {"getMouseDelta", NULL, get_mouse_delta, NULL, NULL, NULL, napi_default, NULL},
        {"isMouseButtonDown", NULL, is_mouse_button_down, NULL, NULL, NULL, napi_default, NULL},
        {"wasMouseButtonJustPressed", NULL, was_mouse_button_just_pressed, NULL, NULL, NULL, napi_default, NULL},
        {"wasMouseButtonJustReleased", NULL, was_mouse_button_just_released, NULL, NULL, NULL, napi_default, NULL},
        // Cursor capture
        {"setCursorCaptured", NULL, set_cursor_captured, NULL, NULL, NULL, napi_default, NULL},
        {"isCursorCaptured", NULL, is_cursor_captured, NULL, NULL, NULL, napi_default, NULL},
        // Debug
        {"getEventCount", NULL, get_event_count, NULL, NULL, NULL, napi_default, NULL},
        {"getLastKeycode", NULL, get_last_keycode, NULL, NULL, NULL, napi_default, NULL},
        {"getLastEventType", NULL, get_last_event_type, NULL, NULL, NULL, napi_default, NULL},
    };

    napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);

    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
