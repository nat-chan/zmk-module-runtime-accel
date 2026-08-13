/*
 * Copyright (c) 2026 nat-chan
 *
 * SPDX-License-Identifier: MIT
 *
 * Public firmware API of the runtime-accel input processor: the per-instance
 * registry and RAM-curve accessors used by the Studio RPC handler
 * (src/studio/runtime_accel_handler.c), the custom-settings apply path and
 * the native_sim tests.
 */

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Interleaved [s0, f0, s1, f1, ...]: max 8 points = 16 int32 elements. */
#define ZMK_RUNTIME_ACCEL_MAX_CURVE_ELEMS 16
/* Factor clamp range, permille (1000 = 1.0x). */
#define ZMK_RUNTIME_ACCEL_FACTOR_MIN 100
#define ZMK_RUNTIME_ACCEL_FACTOR_MAX 20000
/* Max instance-id string length (excluding NUL), matching the proto bound. */
#define ZMK_RUNTIME_ACCEL_INSTANCE_ID_MAX_LEN 15

/* Number of runtime-accel processor instances in the devicetree (0 when the
 * feature is enabled without any node - the RPC handler must handle that). */
size_t zmk_runtime_accel_instance_count(void);

/* Devicetree `instance-id` of instance `idx`, or NULL when out of range. */
const char *zmk_runtime_accel_instance_id(size_t idx);

/*
 * Copy the currently active (RAM) curve of the given instance into `pts`.
 * `*count` is in/out: capacity in elements on input, number of copied
 * elements on output. Returns 0, -ENODEV for an
 * unknown instance id, or -EMSGSIZE when the capacity is too small.
 */
int zmk_runtime_accel_get_curve(const char *instance_id, int32_t *pts, size_t *count);

/*
 * Sanitize `pts` in place (truncate to an even count of 2..16 elements, clamp
 * factors to 100..20000, clamp speeds to >= 0, sort points by speed) and make
 * it the active RAM curve of the instance. Returns 0, -ENODEV for an unknown
 * instance id, or -EINVAL when fewer than 2 elements remain.
 *
 * This is the single apply path: the custom-settings changed/boot listeners
 * and the RPC handler both funnel through it.
 */
int zmk_runtime_accel_apply_curve(const char *instance_id, const int32_t *pts, size_t count);

/*
 * Compute the acceleration factor (permille) the instance's current curve
 * yields for `speed_cps`. Exposed for tests.
 */
int zmk_runtime_accel_factor_for_speed(const char *instance_id, int32_t speed_cps);
