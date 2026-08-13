/*
 * Copyright (c) 2026 nat-chan
 *
 * SPDX-License-Identifier: MIT
 *
 * Custom Studio RPC subsystem for runtime-accel: ListInstances / GetCurve /
 * SetCurve (see DESIGN.md section 5 and proto/nat-chan/runtime-accel/).
 */

#include <errno.h>

#include <pb_decode.h>
#include <pb_encode.h>
#include <zephyr/sys/util.h>
#include <zmk/studio/custom.h>
#include <nat-chan/runtime-accel/runtime_accel.pb.h>

#include <nat-chan/runtime-accel/runtime_accel.h>

#if IS_ENABLED(CONFIG_ZMK_RUNTIME_ACCEL_SETTINGS)
#include <cormoran/zmk/custom_settings.h>
#endif

#include <zephyr/logging/log.h>
LOG_MODULE_DECLARE(zmk, CONFIG_ZMK_LOG_LEVEL);

/*
 * Buffer budget (see DESIGN.md section 5): the largest response (CurveResponse,
 * 16-char id + 16 int32 points) and the largest request (SetCurveRequest)
 * must fit the RPC buffers with framing margin. nanopb emits the *_size
 * upper bounds because every string/repeated field is bounded in
 * runtime_accel.options.
 */
BUILD_ASSERT(CONFIG_ZMK_STUDIO_RPC_TX_BUF_SIZE >= nat_chan_runtime_accel_Response_size + 64,
             "CONFIG_ZMK_STUDIO_RPC_TX_BUF_SIZE too small for runtime-accel responses "
             "(set it to at least 192)");
BUILD_ASSERT(CONFIG_ZMK_STUDIO_RPC_RX_BUF_SIZE >= nat_chan_runtime_accel_Request_size + 32,
             "CONFIG_ZMK_STUDIO_RPC_RX_BUF_SIZE too small for runtime-accel requests "
             "(set it to at least 192)");
BUILD_ASSERT(CONFIG_ZMK_STUDIO_RPC_CUSTOM_SUBSYSTEM_REQUEST_PAYLOAD_MAX_BYTES >=
                 nat_chan_runtime_accel_Request_size,
             "CONFIG_ZMK_STUDIO_RPC_CUSTOM_SUBSYSTEM_REQUEST_PAYLOAD_MAX_BYTES too small for "
             "runtime-accel requests (set it to at least 128)");

static struct zmk_rpc_custom_subsystem_meta runtime_accel_subsystem_meta = {
    ZMK_RPC_CUSTOM_SUBSYSTEM_UI_URLS("https://nat-chan.github.io/zmk-module-runtime-accel/"),
    /* Curves are not sensitive data (DESIGN.md: all requests unsecured). */
    .security = ZMK_STUDIO_RPC_HANDLER_UNSECURED,
};

ZMK_RPC_CUSTOM_SUBSYSTEM(nat_chan__runtime_accel, &runtime_accel_subsystem_meta,
                         runtime_accel_rpc_handle_request);

ZMK_RPC_CUSTOM_SUBSYSTEM_RESPONSE_BUFFER(nat_chan__runtime_accel, nat_chan_runtime_accel_Response);

static void fill_error(nat_chan_runtime_accel_Response *resp, const char *message) {
    resp->which_response_type = nat_chan_runtime_accel_Response_error_tag;
    snprintf(resp->response_type.error.message, sizeof(resp->response_type.error.message), "%s",
             message);
}

static int handle_list_instances(nat_chan_runtime_accel_Response *resp) {
    nat_chan_runtime_accel_ListInstancesResponse *instances = &resp->response_type.instances;
    size_t count = zmk_runtime_accel_instance_count();

    if (count > ARRAY_SIZE(instances->ids)) {
        LOG_WRN("More runtime-accel instances (%u) than the RPC can list (%u)", (unsigned)count,
                (unsigned)ARRAY_SIZE(instances->ids));
        count = ARRAY_SIZE(instances->ids);
    }
    instances->ids_count = count;
    for (size_t i = 0; i < count; i++) {
        snprintf(instances->ids[i], sizeof(instances->ids[i]), "%s",
                 zmk_runtime_accel_instance_id(i));
    }
    resp->which_response_type = nat_chan_runtime_accel_Response_instances_tag;
    return 0;
}

static int handle_get_curve(const nat_chan_runtime_accel_GetCurveRequest *req,
                            nat_chan_runtime_accel_Response *resp) {
    nat_chan_runtime_accel_CurveResponse *curve = &resp->response_type.curve;

    size_t count = ARRAY_SIZE(curve->points);
    int ret = zmk_runtime_accel_get_curve(req->instance_id, curve->points, &count);
    if (ret < 0) {
        fill_error(resp, "Unknown instance id");
        return 0;
    }
    curve->points_count = count;
    snprintf(curve->instance_id, sizeof(curve->instance_id), "%s", req->instance_id);
    resp->which_response_type = nat_chan_runtime_accel_Response_curve_tag;
    return 0;
}

#if IS_ENABLED(CONFIG_ZMK_RUNTIME_ACCEL_SETTINGS)
/*
 * Write the curve into the instance's INT32-array custom setting
 * ("<instance-id>_curve"). Element writes raise zmk_custom_setting_changed,
 * whose listener in src/input_processor_runtime_accel.c applies the curve to
 * the processor RAM - the single apply path for RPC, generic settings UI and
 * boot. Returns -ENOENT when no setting is registered for this instance id.
 */
static int set_curve_via_settings(const char *instance_id, const int32_t *pts, size_t count,
                                  bool persist) {
    char key[32];
    snprintf(key, sizeof(key), "%s_curve", instance_id);

    const struct zmk_custom_setting *setting =
        zmk_custom_setting_find_array("nat_chan__runtime_accel", key);
    if (setting == NULL) {
        return -ENOENT;
    }

    enum zmk_custom_setting_write_mode mode =
        persist ? ZMK_CUSTOM_SETTING_WRITE_MODE_PERSIST : ZMK_CUSTOM_SETTING_WRITE_MODE_MEMORY;
    for (size_t i = 0; i < count; i++) {
        const struct zmk_custom_setting *element =
            zmk_custom_setting_find_array_element("nat_chan__runtime_accel", key, i);
        if (element == NULL) {
            return -EINVAL;
        }
        struct zmk_custom_setting_value value = ZMK_CUSTOM_SETTING_VALUE_INT32(pts[i]);
        int ret = zmk_custom_setting_write_array_element(element, &value, count, mode);
        if (ret < 0) {
            return ret;
        }
    }
    return 0;
}
#endif

static int handle_set_curve(const nat_chan_runtime_accel_SetCurveRequest *req,
                            nat_chan_runtime_accel_Response *resp) {
    /* Sanitize once up front (also validates the instance id): what the
     * settings store receives is already the effective curve. */
    int ret = zmk_runtime_accel_apply_curve(req->instance_id, req->points, req->points_count);
    if (ret == -ENODEV) {
        fill_error(resp, "Unknown instance id");
        return 0;
    }
    if (ret < 0) {
        fill_error(resp, "Invalid curve (need 2..16 interleaved values)");
        return 0;
    }

    int32_t sanitized[ZMK_RUNTIME_ACCEL_MAX_CURVE_ELEMS];
    size_t count = ARRAY_SIZE(sanitized);
    ret = zmk_runtime_accel_get_curve(req->instance_id, sanitized, &count);
    if (ret < 0) {
        fill_error(resp, "Failed to read back curve");
        return 0;
    }

#if IS_ENABLED(CONFIG_ZMK_RUNTIME_ACCEL_SETTINGS)
    ret = set_curve_via_settings(req->instance_id, sanitized, count, req->persist);
    if (ret == -ENOENT) {
        LOG_WRN("No curve setting for instance '%s': change is RAM-only", req->instance_id);
    } else if (ret < 0) {
        fill_error(resp, "Failed to store curve");
        return 0;
    }
#else
    if (req->persist) {
        LOG_WRN("Custom settings disabled: curve for '%s' is RAM-only", req->instance_id);
    }
#endif

    resp->which_response_type = nat_chan_runtime_accel_Response_ack_tag;
    resp->response_type.ack = (nat_chan_runtime_accel_AckResponse){0};
    return 0;
}

static bool runtime_accel_rpc_handle_request(const zmk_custom_CallRequest *raw_request,
                                             pb_callback_t *encode_response) {
    nat_chan_runtime_accel_Response *resp =
        ZMK_RPC_CUSTOM_SUBSYSTEM_RESPONSE_BUFFER_ALLOCATE(nat_chan__runtime_accel, encode_response);

    nat_chan_runtime_accel_Request req = nat_chan_runtime_accel_Request_init_zero;

    pb_istream_t req_stream =
        pb_istream_from_buffer(raw_request->payload.bytes, raw_request->payload.size);
    if (!pb_decode(&req_stream, nat_chan_runtime_accel_Request_fields, &req)) {
        LOG_WRN("Failed to decode runtime_accel request: %s", PB_GET_ERROR(&req_stream));
        fill_error(resp, "Failed to decode request");
        return true;
    }

    int rc = 0;
    switch (req.which_request_type) {
    case nat_chan_runtime_accel_Request_list_instances_tag:
        rc = handle_list_instances(resp);
        break;
    case nat_chan_runtime_accel_Request_get_curve_tag:
        rc = handle_get_curve(&req.request_type.get_curve, resp);
        break;
    case nat_chan_runtime_accel_Request_set_curve_tag:
        rc = handle_set_curve(&req.request_type.set_curve, resp);
        break;
    default:
        LOG_WRN("Unsupported runtime_accel request type: %d", req.which_request_type);
        rc = -1;
    }

    if (rc != 0) {
        fill_error(resp, "Failed to process request");
    }
    return true;
}
