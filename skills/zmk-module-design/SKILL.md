---
name: zmk-module-design
description: Architecture reference and design checklist for designing a ZMK module on this template (custom Studio RPC + web UI). Read when designing a new module or planning a major feature and writing DESIGN.md — it condenses the RPC, custom-settings, and web API surfaces plus the constraints that shape protocol design, so a design can be produced without reading the dependency sources.
---

# Design a module on this template

This file contains everything a design needs from the dependencies. Do not
read `dependencies/zmk/app/include/zmk/studio/custom.h` or
`zmk-feature-custom-settings` headers for design work — the relevant surface
is summarized below. For implementation-time pitfalls, read
`skills/zmk-module-dev/SKILL.md` instead.

## Stack overview

- **Firmware**: a Zephyr/ZMK module. Feature code plus an optional custom
  Studio RPC subsystem handler (`src/studio/<mod>_handler.c`) compiled under
  `CONFIG_ZMK_<MOD>_STUDIO_RPC`. Messages in `proto/<ns>/<mod>/*.proto` are
  compiled by nanopb for firmware and by ts-proto for web.
- **Transport**: ZMK Studio RPC (USB serial / BLE GATT) on the patched ZMK
  branch `main+custom-studio-protocol`, which adds a custom-subsystem
  multiplexer. Each module registers an identifier string; the web client
  discovers subsystems at connect time and exchanges opaque protobuf payloads
  (request/response), plus firmware-initiated notifications.
- **Web**: React + TypeScript (vite) using `@cormoran/zmk-studio-react-hook`.
- **Persistence**: `zmk-feature-custom-settings` (west dependency) provides a
  typed settings registry exposed through its own subsystem
  (`cormoran_custom_settings`) with a generic settings web UI — modules
  usually do not need bespoke settings RPCs.

## Firmware RPC API surface

- `ZMK_RPC_CUSTOM_SUBSYSTEM(identifier, &meta, handler)` — registers the
  subsystem. `identifier` is a C token (convention `<ns>__<mod>`), length
  bounded by `CONFIG_ZMK_STUDIO_RPC_CUSTOM_SUBSYSTEM_IDENTIFIER_MAX_LEN`.
- meta: `ZMK_RPC_CUSTOM_SUBSYSTEM_UI_URLS("https://...")` plus
  `.security = ZMK_STUDIO_RPC_HANDLER_UNSECURED` (default choice; `SECURED`
  requires the user to unlock, avoid unless the data warrants it).
- handler: `bool handler(const zmk_custom_CallRequest *req, pb_callback_t
  *encode_response)`. Decode `req->payload.bytes` with your nanopb Request
  type; allocate the response via
  `ZMK_RPC_CUSTOM_SUBSYSTEM_RESPONSE_BUFFER(id, ResponseType)` +
  `..._ALLOCATE`. That buffer is a **single shared static** instance;
  encoding runs **after the handler returns** and possibly multiple times.
  RPCs are serialized — the next request is processed only after the
  response is sent, so one global data buffer per subsystem is safe.
- Notifications (firmware → web, no request):
  `raise_zmk_studio_custom_notification(...)` with the subsystem index and a
  `pb_callback_t encode_payload`. Unlike responses, encoding runs *inside*
  `raise...()`, so stack-local data is allowed there.

## Web API surface

- `useZMKApp()` / `ZMKAppContext`: `state.connection`,
  `findSubsystem("<identifier>")` → `{ index }`, `isConnected`.
- `new ZMKCustomSubsystem(connection, subsystem.index).callRPC(bytes)` →
  `bytes`; encode/decode with the ts-proto generated `Request`/`Response`.
- `zmkApp.onNotification({ ..., callback })` → returns unsubscribe; decode
  the payload with the generated types. Notifications can arrive out of
  order relative to UI state — design handlers to tolerate stale ones.
- Tests: `createConnectedMockZMKApp({ subsystems: ["<identifier>"] })` +
  `ZMKAppProvider` from `@cormoran/zmk-studio-react-hook/testing`.

## Custom settings surface

- One registry entry per setting:
  `ZMK_CUSTOM_SETTING_DEFINE(c_name, "<subsystem_id>", "key", value_type,
  default, confidentiality, read_perm, write_perm, constraint)`.
  - types: `BOOL` / `INT32` / `STRING` / `BYTES` (value size ≤
    `CONFIG_ZMK_CUSTOM_SETTINGS_VALUE_MAX_SIZE`); arrays supported.
  - confidentiality: `DEVICE_PRIVATE` / `RPC_PERSONAL` / `RPC_PUBLIC`;
    permissions: `UNSECURE` / `SECURE` per read/write.
  - constraints: `RANGE` / `OPTIONS` / `HID_USAGE` / `LAYER_ID` /
    `BEHAVIOR_ID` (RANGE has a compile pitfall — see zmk-module-dev).
- C accessors: `zmk_custom_setting_{find,read,write}[_by_key]` (+ array
  variants); write modes `MEMORY` / `PERSIST` / `TEMPORARY`.
- Change event `zmk_custom_setting_changed`
  (`UPDATED`/`SAVED`/`DISCARDED`/`RESET`). It is **not** raised for values
  loaded at boot — plan a boot-time apply path in the design.
- Settings automatically appear in the generic settings web UI. Design
  decision per module: rely on that UI, or build custom controls that call
  the same registry.

## Constraints that shape protocol design

- One `Request`/`Response` oneof pair per subsystem; all response variants
  share one static buffer sized by the **largest** member — keep every
  message small and similar in size.
- Encoded responses must fit `CONFIG_ZMK_STUDIO_RPC_TX_BUF_SIZE` (default
  64 B!) and requests `..._RX_BUF_SIZE` (default 30 B; 128 needed with
  custom settings). Raising buffers costs RAM permanently. For bulk data use
  the proven patterns instead: paged chunk requests
  (`Get<X>Chunk{id, offset}` → ≤128 B bytes field, `.options`-bounded) or
  notification streaming (one notification per chunk).
- nanopb: no 64-bit field types; every string/bytes field needs a `.options`
  `max_size`; oneof/sub-message handling has pitfalls (zmk-module-dev).
- RPCs are serialized and block the RPC thread: long operations should
  return immediately (kick a work item) and deliver results via
  notifications or polling.
- native_sim testability is a design requirement: RPC/settings must build
  and run with **zero hardware devices** (API stub returning 0 devices), so
  CI covers the protocol without hardware.

## Design checklist (answer these in DESIGN.md)

1. **Scope**: driver (DT bindings, `boards/`/`dts/`) or feature
   (listeners/behaviors)? What is explicitly out of scope?
2. **Config surface**: what is compile-time (Kconfig), devicetree, or
   runtime (custom settings)? For each setting: key, type, default,
   constraint, confidentiality, permissions.
3. **RPC API table**: request → response fields and sizes, error cases;
   which calls need chunking or notifications; RX/TX buffer budget with a
   `BUILD_ASSERT` plan.
4. **State & persistence**: persisted vs runtime-only state; boot apply path
   (no changed-event at boot); RAM cost of buffers.
5. **Web UI**: screens, which RPC each uses, generic settings UI vs custom
   controls.
6. **Testing**: native_sim coverage (zero-device stub, test-only init hooks),
   build-test matrix (`tests/zmk-config/build.yaml` artifacts × configs,
   asserted in `test.py`), hardware validation steps.
7. **Phase plan** (proven decomposition — keep DESIGN.md the source of
   truth): A template init + core import, B settings + APIs + RPC
   (proto → firmware), C web UI (+ streaming), D hardware validation.

## File map

| Purpose | Location |
|---------|----------|
| Feature flags, sources | `Kconfig`, `CMakeLists.txt` (proto auto-globbed from `proto/`) |
| Protocol | `proto/<ns>/<mod>/*.proto` + `.options` |
| RPC handler | `src/studio/<mod>_handler.c` |
| Feature code / public API | `src/`, `include/<ns>/<mod>/` |
| Bindings, shields (drivers) | `dts/`, `boards/` |
| native_sim tests / build tests | `tests/<case>/`, `tests/zmk-config/` (+ `snippets/`), `test.py` |
| Web UI / tests / codegen | `web/src/`, `web/test/`, `web/buf.gen.yaml` |
