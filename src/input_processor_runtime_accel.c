/*
 * Copyright (c) 2026 nat-chan
 *
 * SPDX-License-Identifier: MIT
 *
 * Runtime-adjustable pointer/scroll acceleration input processor.
 *
 * Scales INPUT_EV_REL REL_X/REL_Y by a piecewise-linear speed -> factor
 * curve held in RAM per instance. The curve is editable at runtime through
 * the custom Studio RPC (src/studio/runtime_accel_handler.c) and persisted
 * per instance with zmk-feature-custom-settings (key "<instance-id>_curve").
 *
 * The per-event speed estimation (counts/sec from the k_uptime delta clamped
 * to 100 ms), per-axis remainder accumulation and direction-flip suppression
 * are adapted from the MIT-licensed zmk-input-processor-acceleration sample
 * (input_processor_accel.c); the parametric exponent curve there is replaced
 * by this module's control-point curve (see DESIGN.md section 2).
 */

#define DT_DRV_COMPAT zmk_input_processor_runtime_accel

#include <errno.h>
#include <stdlib.h>
#include <string.h>

#include <zephyr/device.h>
#include <zephyr/dt-bindings/input/input-event-codes.h>
#include <zephyr/kernel.h>
#include <zephyr/spinlock.h>
#include <zephyr/sys/util.h>

#include <drivers/input_processor.h>

#include <nat-chan/runtime-accel/runtime_accel.h>

#if IS_ENABLED(CONFIG_ZMK_RUNTIME_ACCEL_SETTINGS)
#include <cormoran/zmk/custom_settings.h>
#include <zmk/event_manager.h>
#endif

#include <zephyr/logging/log.h>
LOG_MODULE_DECLARE(zmk, CONFIG_ZMK_LOG_LEVEL);

#ifndef CONFIG_ZMK_INPUT_PROCESSOR_INIT_PRIORITY
#define CONFIG_ZMK_INPUT_PROCESSOR_INIT_PRIORITY 50
#endif

#define ACCEL_NUM_AXES 2 /* REL_X, REL_Y */
#define SCALE 1000
/* Speed estimation dt clamp (ms): pauses longer than this count as 100 ms. */
#define ACCEL_DT_CLAMP_MS 100
/* Sanity clamp for control-point speeds (counts/sec). */
#define ACCEL_SPEED_MAX 1000000

struct accel_curve {
    uint8_t count; /* even, 2..16 */
    int32_t pts[ZMK_RUNTIME_ACCEL_MAX_CURVE_ELEMS];
};

struct accel_config {
    const char *instance_id;
    uint8_t input_type;
    const int32_t *default_curve;
    size_t default_curve_len;
};

struct accel_data {
    struct accel_curve curve;
    struct k_spinlock lock;
    int64_t last_time_ms[ACCEL_NUM_AXES];
    int32_t last_raw[ACCEL_NUM_AXES];
    int16_t remainders[ACCEL_NUM_AXES];
};

/* ------------------------------------------------------------------ */
/* Curve sanitization and evaluation                                   */
/* ------------------------------------------------------------------ */

static int32_t clamp_i32(int32_t v, int32_t lo, int32_t hi) { return CLAMP(v, lo, hi); }

/*
 * Sanitize an interleaved [s0,f0,s1,f1,...] list into `out`: truncate to an
 * even count of at most 16 elements, clamp speeds to 0..ACCEL_SPEED_MAX and
 * factors to 100..20000, and sort the points by speed (stable insertion sort
 * over at most 8 pairs). Returns false when fewer than 2 elements remain -
 * broken input never crashes, the caller keeps the previous curve.
 */
static bool sanitize_curve(const int32_t *pts, size_t count, struct accel_curve *out) {
    if (pts == NULL) {
        return false;
    }
    count &= ~(size_t)1; /* even */
    if (count < 2) {
        return false;
    }
    if (count > ZMK_RUNTIME_ACCEL_MAX_CURVE_ELEMS) {
        count = ZMK_RUNTIME_ACCEL_MAX_CURVE_ELEMS;
    }

    size_t n_points = count / 2;
    int32_t s[ZMK_RUNTIME_ACCEL_MAX_CURVE_ELEMS / 2];
    int32_t f[ZMK_RUNTIME_ACCEL_MAX_CURVE_ELEMS / 2];
    for (size_t i = 0; i < n_points; i++) {
        s[i] = clamp_i32(pts[2 * i], 0, ACCEL_SPEED_MAX);
        f[i] =
            clamp_i32(pts[2 * i + 1], ZMK_RUNTIME_ACCEL_FACTOR_MIN, ZMK_RUNTIME_ACCEL_FACTOR_MAX);
    }
    /* Insertion sort by speed, stable. */
    for (size_t i = 1; i < n_points; i++) {
        int32_t ks = s[i], kf = f[i];
        size_t j = i;
        while (j > 0 && s[j - 1] > ks) {
            s[j] = s[j - 1];
            f[j] = f[j - 1];
            j--;
        }
        s[j] = ks;
        f[j] = kf;
    }

    out->count = (uint8_t)count;
    for (size_t i = 0; i < n_points; i++) {
        out->pts[2 * i] = s[i];
        out->pts[2 * i + 1] = f[i];
    }
    return true;
}

/* Piecewise-linear interpolation: below the first point -> first factor,
 * above the last point -> last factor. */
static int32_t curve_factor(const struct accel_curve *curve, int32_t speed_cps) {
    size_t n_points = curve->count / 2;

    if (n_points == 0) {
        return SCALE;
    }
    if (speed_cps <= curve->pts[0]) {
        return curve->pts[1];
    }
    for (size_t i = 1; i < n_points; i++) {
        int32_t s1 = curve->pts[2 * i];
        if (speed_cps <= s1) {
            int32_t s0 = curve->pts[2 * (i - 1)];
            int32_t f0 = curve->pts[2 * (i - 1) + 1];
            int32_t f1 = curve->pts[2 * i + 1];
            if (s1 == s0) {
                return f1;
            }
            return f0 + (int32_t)((int64_t)(f1 - f0) * (speed_cps - s0) / (s1 - s0));
        }
    }
    return curve->pts[2 * (n_points - 1) + 1];
}

/* ------------------------------------------------------------------ */
/* Event handling                                                      */
/* ------------------------------------------------------------------ */

static int accel_handle_event(const struct device *dev, struct input_event *event, uint32_t param1,
                              uint32_t param2, struct zmk_input_processor_state *state) {
    ARG_UNUSED(param1);
    ARG_UNUSED(param2);
    ARG_UNUSED(state);

    const struct accel_config *cfg = dev->config;
    struct accel_data *data = dev->data;

    if (event->type != cfg->input_type) {
        return ZMK_INPUT_PROC_CONTINUE;
    }

    uint32_t idx;
    switch (event->code) {
    case INPUT_REL_X:
        idx = 0;
        break;
    case INPUT_REL_Y:
        idx = 1;
        break;
    default:
        return ZMK_INPUT_PROC_CONTINUE;
    }

    const int32_t raw = event->value;
    const int64_t now = k_uptime_get();

    if (raw == 0) {
        data->last_time_ms[idx] = now;
        return ZMK_INPUT_PROC_CONTINUE;
    }

    /* Per-event speed estimation: counts/sec from the uptime delta, clamped
     * to ACCEL_DT_CLAMP_MS so a pause does not read as ultra-slow motion. */
    uint32_t dt_ms = 1;
    if (data->last_time_ms[idx] > 0 && now > data->last_time_ms[idx]) {
        int64_t diff = now - data->last_time_ms[idx];
        if (diff > ACCEL_DT_CLAMP_MS) {
            diff = ACCEL_DT_CLAMP_MS;
        }
        dt_ms = (uint32_t)diff;
    }
    int32_t cps = (int32_t)(((int64_t)abs(raw) * 1000) / dt_ms);

    int32_t factor;
    K_SPINLOCK(&data->lock) { factor = curve_factor(&data->curve, cps); }

    /* Direction-flip suppression: no boost on the first event after the axis
     * reverses, so small corrections do not overshoot. */
    if ((int64_t)data->last_raw[idx] * (int64_t)raw < 0 && factor > SCALE) {
        factor = SCALE;
    }

    /* Scale with per-axis remainder accumulation (always on). */
    int64_t total = (int64_t)raw * factor + data->remainders[idx];
    int32_t out = (int32_t)(total / SCALE);
    int32_t rem = (int32_t)(total - (int64_t)out * SCALE); /* [-999..999] */
    event->value = CLAMP(out, INT16_MIN, INT16_MAX);
    data->remainders[idx] = (int16_t)rem;

    data->last_raw[idx] = raw;
    data->last_time_ms[idx] = now;
    return ZMK_INPUT_PROC_CONTINUE;
}

/* __unused: a build with zero devicetree instances (the native_sim RPC stub
 * case) still compiles this file and does not reference the api struct. */
static const struct zmk_input_processor_driver_api accel_api __unused = {
    .handle_event = accel_handle_event,
};

/* ------------------------------------------------------------------ */
/* Instance registry                                                   */
/* ------------------------------------------------------------------ */

#define ACCEL_INST_INIT(inst)                                                                      \
    BUILD_ASSERT(sizeof(DT_INST_PROP(inst, instance_id)) - 1 <=                                    \
                     ZMK_RUNTIME_ACCEL_INSTANCE_ID_MAX_LEN,                                        \
                 "instance-id is too long (max 15 chars)");                                        \
    BUILD_ASSERT(DT_INST_PROP_LEN(inst, default_curve) >= 2 &&                                     \
                     DT_INST_PROP_LEN(inst, default_curve) <= ZMK_RUNTIME_ACCEL_MAX_CURVE_ELEMS && \
                     DT_INST_PROP_LEN(inst, default_curve) % 2 == 0,                               \
                 "default-curve must have an even number of 2..16 elements");                      \
    static const int32_t accel_default_curve_##inst[] = DT_INST_PROP(inst, default_curve);         \
    static const struct accel_config accel_config_##inst = {                                       \
        .instance_id = DT_INST_PROP(inst, instance_id),                                            \
        .input_type = DT_INST_PROP(inst, input_type),                                              \
        .default_curve = accel_default_curve_##inst,                                               \
        .default_curve_len = ARRAY_SIZE(accel_default_curve_##inst),                               \
    };                                                                                             \
    static struct accel_data accel_data_##inst = {0};                                              \
    static int accel_init_##inst(const struct device *dev) {                                       \
        struct accel_data *data = dev->data;                                                       \
        const struct accel_config *cfg = dev->config;                                              \
        if (!sanitize_curve(cfg->default_curve, cfg->default_curve_len, &data->curve)) {           \
            LOG_WRN("runtime-accel '%s': invalid default-curve", cfg->instance_id);                \
        }                                                                                          \
        return 0;                                                                                  \
    }                                                                                              \
    DEVICE_DT_INST_DEFINE(inst, accel_init_##inst, NULL, &accel_data_##inst, &accel_config_##inst, \
                          POST_KERNEL, CONFIG_ZMK_INPUT_PROCESSOR_INIT_PRIORITY, &accel_api);

DT_INST_FOREACH_STATUS_OKAY(ACCEL_INST_INIT)

#define ACCEL_DEVICE_REF(inst) DEVICE_DT_INST_GET(inst),

static const struct device *const accel_devices[] = {DT_INST_FOREACH_STATUS_OKAY(ACCEL_DEVICE_REF)};

size_t zmk_runtime_accel_instance_count(void) { return ARRAY_SIZE(accel_devices); }

const char *zmk_runtime_accel_instance_id(size_t idx) {
    if (idx >= ARRAY_SIZE(accel_devices)) {
        return NULL;
    }
    const struct accel_config *cfg = accel_devices[idx]->config;
    return cfg->instance_id;
}

static const struct device *find_instance(const char *instance_id) {
    if (instance_id == NULL) {
        return NULL;
    }
    for (size_t i = 0; i < ARRAY_SIZE(accel_devices); i++) {
        const struct accel_config *cfg = accel_devices[i]->config;
        if (strcmp(cfg->instance_id, instance_id) == 0) {
            return accel_devices[i];
        }
    }
    return NULL;
}

int zmk_runtime_accel_get_curve(const char *instance_id, int32_t *pts, size_t *count) {
    const struct device *dev = find_instance(instance_id);
    if (dev == NULL) {
        return -ENODEV;
    }
    struct accel_data *data = dev->data;
    int ret = 0;
    K_SPINLOCK(&data->lock) {
        if (*count < data->curve.count) {
            ret = -EMSGSIZE;
            K_SPINLOCK_BREAK;
        }
        *count = data->curve.count;
        memcpy(pts, data->curve.pts, data->curve.count * sizeof(int32_t));
    }
    return ret;
}

int zmk_runtime_accel_apply_curve(const char *instance_id, const int32_t *pts, size_t count) {
    const struct device *dev = find_instance(instance_id);
    if (dev == NULL) {
        return -ENODEV;
    }
    struct accel_curve sanitized;
    if (!sanitize_curve(pts, count, &sanitized)) {
        return -EINVAL;
    }
    struct accel_data *data = dev->data;
    K_SPINLOCK(&data->lock) { data->curve = sanitized; }
    LOG_DBG("runtime-accel '%s': applied curve with %u elements", instance_id, sanitized.count);
    return 0;
}

int zmk_runtime_accel_factor_for_speed(const char *instance_id, int32_t speed_cps) {
    const struct device *dev = find_instance(instance_id);
    if (dev == NULL) {
        return -ENODEV;
    }
    struct accel_data *data = dev->data;
    int32_t factor;
    K_SPINLOCK(&data->lock) { factor = curve_factor(&data->curve, speed_cps); }
    return factor;
}

/* ------------------------------------------------------------------ */
/* Custom-settings persistence (instance ids "pointer" and "scroll")   */
/* ------------------------------------------------------------------ */

#if IS_ENABLED(CONFIG_ZMK_RUNTIME_ACCEL_SETTINGS)

#define ACCEL_SUBSYSTEM_ID "nat_chan__runtime_accel"

/*
 * zmk-feature-custom-settings only supports statically registered array
 * settings (ZMK_CUSTOM_SETTING_ARRAY_DEFINE), so one INT32-array entry is
 * defined per known instance id. Instances whose id is neither "pointer"
 * nor "scroll" still work, but their curves are RAM-only (see README).
 *
 * default_size is 0: an empty array means "unset" and the devicetree
 * default-curve stays active.
 */
ZMK_CUSTOM_SETTING_ARRAY_DEFAULT_INT32_DEFINE(accel_curve_defaults, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                                              0, 0, 0, 0, 0);

#define ACCEL_CURVE_SETTING_DEFINE(_name, _key)                                                    \
    ZMK_CUSTOM_SETTING_ARRAY_DEFINE(                                                               \
        _name, ACCEL_SUBSYSTEM_ID, _key, ZMK_CUSTOM_SETTING_VALUE_TYPE_INT32,                      \
        ZMK_RUNTIME_ACCEL_MAX_CURVE_ELEMS, 0, accel_curve_defaults,                                \
        ZMK_CUSTOM_SETTING_CONFIDENTIALITY_RPC_PUBLIC, ZMK_CUSTOM_SETTING_PERMISSION_UNSECURE,     \
        ZMK_CUSTOM_SETTING_PERMISSION_UNSECURE, ZMK_CUSTOM_SETTING_NO_CONSTRAINT)

ACCEL_CURVE_SETTING_DEFINE(accel_curve_pointer, "pointer_curve");
ACCEL_CURVE_SETTING_DEFINE(accel_curve_scroll, "scroll_curve");

/* "<instance-id>_curve" -> instance id ("pointer_curve" -> "pointer").
 * Returns false when the key does not follow that shape or is too long. */
static bool key_to_instance_id(const char *key, char *out, size_t out_size) {
    const char *suffix = "_curve";
    size_t key_len = strlen(key);
    size_t suffix_len = strlen(suffix);
    if (key_len <= suffix_len || strcmp(key + key_len - suffix_len, suffix) != 0) {
        return false;
    }
    size_t id_len = key_len - suffix_len;
    if (id_len >= out_size) {
        return false;
    }
    memcpy(out, key, id_len);
    out[id_len] = '\0';
    return true;
}

/* Read the whole array setting and apply it to the matching instance. An
 * empty/short array re-applies the devicetree default-curve instead. */
static void apply_setting_curve(const struct zmk_custom_setting *setting) {
    char instance_id[ZMK_RUNTIME_ACCEL_INSTANCE_ID_MAX_LEN + 1];
    if (!key_to_instance_id(zmk_custom_setting_public_key(setting), instance_id,
                            sizeof(instance_id))) {
        return;
    }
    const struct device *dev = find_instance(instance_id);
    if (dev == NULL) {
        return;
    }

    int32_t pts[ZMK_RUNTIME_ACCEL_MAX_CURVE_ELEMS];
    uint32_t size = zmk_custom_setting_array_size(setting);
    if (size > ZMK_RUNTIME_ACCEL_MAX_CURVE_ELEMS) {
        size = ZMK_RUNTIME_ACCEL_MAX_CURVE_ELEMS;
    }
    for (uint32_t i = 0; i < size; i++) {
        struct zmk_custom_setting_value value;
        if (zmk_custom_setting_read_array_by_key(
                ACCEL_SUBSYSTEM_ID, zmk_custom_setting_public_key(setting), i, &value) < 0 ||
            value.type != ZMK_CUSTOM_SETTING_VALUE_TYPE_INT32) {
            size = i;
            break;
        }
        pts[i] = value.int32_value;
    }

    if (size < 2) {
        /* Unset/cleared: fall back to the devicetree default. */
        const struct accel_config *cfg = dev->config;
        zmk_runtime_accel_apply_curve(instance_id, cfg->default_curve, cfg->default_curve_len);
        return;
    }
    zmk_runtime_accel_apply_curve(instance_id, pts, size);
}

static const struct zmk_custom_setting *const accel_curve_settings[] = {
    &accel_curve_pointer,
    &accel_curve_scroll,
};

/*
 * Boot apply: settings_load() does NOT raise zmk_custom_setting_changed for
 * values loaded at boot, so apply persisted curves once
 * zmk_custom_settings_initialized fires (raised exactly once, after the boot
 * settings load completes). Until then the devicetree default-curve set at
 * device init is active. In a build without CONFIG_SETTINGS the event never
 * fires - and there are no persisted curves to apply either.
 */
static int accel_on_settings_initialized(const zmk_event_t *eh) {
    if (as_zmk_custom_settings_initialized(eh) == NULL) {
        return ZMK_EV_EVENT_BUBBLE;
    }
    for (size_t i = 0; i < ARRAY_SIZE(accel_curve_settings); i++) {
        apply_setting_curve(accel_curve_settings[i]);
    }
    return ZMK_EV_EVENT_BUBBLE;
}

ZMK_LISTENER(runtime_accel_settings_init, accel_on_settings_initialized);
ZMK_SUBSCRIPTION(runtime_accel_settings_init, zmk_custom_settings_initialized);

/* Post-boot apply: covers this module's SetCurve RPC (which writes the
 * setting) and writes made through the generic custom-settings web UI. */
static int accel_on_setting_changed(const zmk_event_t *eh) {
    const struct zmk_custom_setting_changed *ev = as_zmk_custom_setting_changed(eh);
    if (ev == NULL || ev->setting == NULL) {
        return ZMK_EV_EVENT_BUBBLE;
    }
    if (strcmp(ev->setting->custom_subsystem_id, ACCEL_SUBSYSTEM_ID) != 0) {
        return ZMK_EV_EVENT_BUBBLE;
    }
    apply_setting_curve(ev->setting);
    return ZMK_EV_EVENT_BUBBLE;
}

ZMK_LISTENER(runtime_accel_setting_changed, accel_on_setting_changed);
ZMK_SUBSCRIPTION(runtime_accel_setting_changed, zmk_custom_setting_changed);

#endif /* CONFIG_ZMK_RUNTIME_ACCEL_SETTINGS */
