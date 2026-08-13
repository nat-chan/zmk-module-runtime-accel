/*
 * Copyright (c) 2026 nat-chan
 *
 * SPDX-License-Identifier: MIT
 *
 * In-firmware native_sim test for the runtime-accel processor (tests/accel/):
 * exercises the instance registry, the DT default-curve boot apply, curve
 * sanitization, piecewise-linear factor evaluation, the input-event scaling
 * path (remainders + direction-flip suppression) and - when custom settings
 * are enabled - the settings write -> changed event -> RAM apply path plus
 * the reset -> DT-default fallback.
 *
 * Runs from SYS_INIT at APPLICATION level and logs one deterministic
 * "rta_test:" line per assertion; tests/accel/events.patterns extracts those
 * lines and diffs them against tests/accel/keycode_events.snapshot.
 * A test failure shows up as a snapshot mismatch - boot is never failed.
 */

#include <zephyr/device.h>
#include <zephyr/dt-bindings/input/input-event-codes.h>
#include <zephyr/init.h>
#include <zephyr/kernel.h>
#include <zephyr/settings/settings.h>

#include <drivers/input_processor.h>
#include <nat-chan/runtime-accel/runtime_accel.h>

#if IS_ENABLED(CONFIG_ZMK_RUNTIME_ACCEL_SETTINGS)
#include <cormoran/zmk/custom_settings.h>
#endif

#include <zephyr/logging/log.h>
LOG_MODULE_DECLARE(zmk, CONFIG_ZMK_LOG_LEVEL);

static void log_curve(const char *label, const char *instance_id) {
    int32_t pts[ZMK_RUNTIME_ACCEL_MAX_CURVE_ELEMS];
    size_t count = ARRAY_SIZE(pts);
    int ret = zmk_runtime_accel_get_curve(instance_id, pts, &count);
    if (ret < 0) {
        LOG_INF("rta_test: %s %s ERR %d", label, instance_id, ret);
        return;
    }
    /* Log as pairs to keep lines short and stable. */
    char buf[128];
    size_t off = 0;
    for (size_t i = 0; i + 1 < count && off < sizeof(buf) - 24; i += 2) {
        off += snprintf(buf + off, sizeof(buf) - off, " (%d,%d)", pts[i], pts[i + 1]);
    }
    LOG_INF("rta_test: %s %s%s", label, instance_id, buf);
}

static void test_registry(void) {
    LOG_INF("rta_test: instances %u '%s' '%s'", (unsigned)zmk_runtime_accel_instance_count(),
            zmk_runtime_accel_instance_id(0), zmk_runtime_accel_instance_id(1));
    LOG_INF("rta_test: unknown lookup %d", zmk_runtime_accel_get_curve("nope", NULL, NULL) == 0);
}

static void test_default_curves(void) {
    /* The DT default-curve was applied at device init. */
    log_curve("default", "pointer");
    log_curve("default", "scroll");
}

static void test_sanitize(void) {
    /* Odd count (7 -> 6), unsorted speeds, factors out of range: expect
     * (0,100) (500,20000) (1000,1500) after sanitize. */
    const int32_t garbage[] = {1000, 1500, 0, 5, 500, 999999, 777};
    int ret = zmk_runtime_accel_apply_curve("pointer", garbage, ARRAY_SIZE(garbage));
    LOG_INF("rta_test: sanitize apply ret %d", ret);
    log_curve("sanitized", "pointer");

    /* Too short after truncation -> rejected, curve unchanged. */
    const int32_t too_short[] = {42};
    ret = zmk_runtime_accel_apply_curve("pointer", too_short, ARRAY_SIZE(too_short));
    LOG_INF("rta_test: short apply ret %d", ret);
    log_curve("unchanged", "pointer");
}

static void test_factor(void) {
    /* Piecewise-linear on the sanitized pointer curve
     * (0,100) (500,20000) (1000,1500):
     *  - below/at first point -> first factor
     *  - midpoint of segment 1 -> (100+20000)/2 = 10050
     *  - midpoint of segment 2 -> (20000+1500)/2 = 10750
     *  - above last point -> last factor */
    LOG_INF("rta_test: factor %d %d %d %d %d", zmk_runtime_accel_factor_for_speed("pointer", 0),
            zmk_runtime_accel_factor_for_speed("pointer", 250),
            zmk_runtime_accel_factor_for_speed("pointer", 750),
            zmk_runtime_accel_factor_for_speed("pointer", 5000),
            zmk_runtime_accel_factor_for_speed("nope", 0));
}

static void test_event_path(void) {
    /* The scroll instance's DT default-curve is the single point (0,500):
     * factor 0.5x regardless of speed, so timing does not matter. */
    const struct device *dev = DEVICE_DT_GET(DT_NODELABEL(rta_scroll));
    struct input_event ev = {.type = INPUT_EV_REL, .code = INPUT_REL_X, .value = 3};

    /* 3 * 0.5 = 1.5 -> out 1, remainder 500. */
    int ret = zmk_input_processor_handle_event(dev, &ev, 0, 0, NULL);
    int32_t first = ev.value;
    /* 3 * 0.5 + 0.5 = 2.0 -> out 2, remainder 0. */
    ev.value = 3;
    zmk_input_processor_handle_event(dev, &ev, 0, 0, NULL);
    LOG_INF("rta_test: event scale ret %d out %d then %d", ret, first, ev.value);

    /* Direction flip with factor > 1000 is suppressed to 1000: set a 2.0x
     * curve, move +3 (=6), then -3 (flip -> factor 1.0 -> -3). */
    const int32_t double_curve[] = {0, 2000};
    zmk_runtime_accel_apply_curve("scroll", double_curve, ARRAY_SIZE(double_curve));
    ev.value = 3;
    zmk_input_processor_handle_event(dev, &ev, 0, 0, NULL);
    first = ev.value;
    ev.value = -3;
    zmk_input_processor_handle_event(dev, &ev, 0, 0, NULL);
    LOG_INF("rta_test: event flip out %d then %d", first, ev.value);

    /* Other event types/codes pass through untouched. */
    ev.type = INPUT_EV_KEY;
    ev.value = 7;
    zmk_input_processor_handle_event(dev, &ev, 0, 0, NULL);
    LOG_INF("rta_test: event passthrough %d", ev.value);
}

#if IS_ENABLED(CONFIG_ZMK_RUNTIME_ACCEL_SETTINGS)

/* --- Minimal fake in-RAM settings backend (mirrors the pattern in
 * cormoran/zmk-module-runtime-input-processor's rip_settings_test.c): ZMK
 * main() only calls settings_subsys_init()/settings_load() after SYS_INIT,
 * so this registers an in-RAM store to exercise persist writes. */
#define TEST_SETTINGS_STORAGE_CAPACITY 8

struct test_settings_record {
    bool present;
    char name[SETTINGS_MAX_NAME_LEN];
    uint8_t data[CONFIG_ZMK_CUSTOM_SETTINGS_VALUE_MAX_SIZE];
    size_t len;
};

static struct test_settings_record test_settings_storage[TEST_SETTINGS_STORAGE_CAPACITY];

static struct test_settings_record *test_settings_find_record(const char *name) {
    for (size_t i = 0; i < ARRAY_SIZE(test_settings_storage); i++) {
        if (test_settings_storage[i].present &&
            strncmp(test_settings_storage[i].name, name, sizeof(test_settings_storage[i].name)) ==
                0) {
            return &test_settings_storage[i];
        }
    }
    return NULL;
}

static ssize_t test_settings_read_cb(void *cb_arg, void *data, size_t len) {
    const struct test_settings_record *record = cb_arg;
    size_t read_len = MIN(record->len, len);
    memcpy(data, record->data, read_len);
    return read_len;
}

static int test_settings_load(struct settings_store *cs, const struct settings_load_arg *arg) {
    ARG_UNUSED(cs);
    int first_error = 0;
    for (size_t i = 0; i < ARRAY_SIZE(test_settings_storage); i++) {
        struct test_settings_record *record = &test_settings_storage[i];
        if (!record->present) {
            continue;
        }
        int ret = settings_call_set_handler(record->name, record->len, test_settings_read_cb,
                                            record, arg);
        if (ret < 0 && first_error == 0) {
            first_error = ret;
        }
    }
    return first_error;
}

static int test_settings_save(struct settings_store *cs, const char *name, const char *value,
                              size_t val_len) {
    ARG_UNUSED(cs);
    struct test_settings_record *record = test_settings_find_record(name);
    if (value == NULL) {
        if (record) {
            record->present = false;
        }
        return 0;
    }
    if (val_len > sizeof(record->data)) {
        return -EMSGSIZE;
    }
    if (strlen(name) >= SETTINGS_MAX_NAME_LEN) {
        return -ENAMETOOLONG;
    }
    if (!record) {
        for (size_t i = 0; i < ARRAY_SIZE(test_settings_storage); i++) {
            if (!test_settings_storage[i].present) {
                record = &test_settings_storage[i];
                break;
            }
        }
    }
    if (!record) {
        return -ENOMEM;
    }
    record->present = true;
    strcpy(record->name, name);
    memcpy(record->data, value, val_len);
    record->len = val_len;
    return 0;
}

static const struct settings_store_itf test_settings_itf = {
    .csi_load = test_settings_load,
    .csi_save = test_settings_save,
};

static struct settings_store test_settings_store = {.cs_itf = &test_settings_itf};

static void test_settings_apply_path(void) {
    int ret = settings_subsys_init();
    if (ret == 0) {
        settings_src_register(&test_settings_store);
        settings_dst_register(&test_settings_store);
    }
    LOG_INF("rta_test: settings backend %d", ret);

    /* Writing the "pointer_curve" INT32-array setting must reach the
     * processor RAM through the zmk_custom_setting_changed listener. */
    const struct zmk_custom_setting *setting =
        zmk_custom_setting_find_array("nat_chan__runtime_accel", "pointer_curve");
    LOG_INF("rta_test: setting found %d", setting != NULL);

    const int32_t stored[] = {0, 1000, 2000, 4000};
    for (size_t i = 0; i < ARRAY_SIZE(stored); i++) {
        const struct zmk_custom_setting *element =
            zmk_custom_setting_find_array_element("nat_chan__runtime_accel", "pointer_curve", i);
        struct zmk_custom_setting_value value = ZMK_CUSTOM_SETTING_VALUE_INT32(stored[i]);
        ret = zmk_custom_setting_write_array_element(element, &value, ARRAY_SIZE(stored),
                                                     ZMK_CUSTOM_SETTING_WRITE_MODE_PERSIST);
        if (ret < 0) {
            LOG_INF("rta_test: settings write %u failed %d", (unsigned)i, ret);
        }
    }
    log_curve("via-settings", "pointer");

    /* Resetting the setting (empty array again) must fall back to the
     * devicetree default-curve. */
    ret = zmk_custom_setting_reset(setting);
    LOG_INF("rta_test: settings reset %d", ret);
    log_curve("after-reset", "pointer");
}

#endif /* CONFIG_ZMK_RUNTIME_ACCEL_SETTINGS */

static int runtime_accel_test_init(void) {
    test_registry();
    test_default_curves();
    test_sanitize();
    test_factor();
    test_event_path();
#if IS_ENABLED(CONFIG_ZMK_RUNTIME_ACCEL_SETTINGS)
    test_settings_apply_path();
#endif
    LOG_INF("rta_test: done");
    return 0;
}
SYS_INIT(runtime_accel_test_init, APPLICATION, 99);
