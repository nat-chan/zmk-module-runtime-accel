# zmk-module-runtime-accel

![ZMK Version](https://img.shields.io/badge/ZMK-master-blue)
[![Test](https://github.com/nat-chan/zmk-module-runtime-accel/actions/workflows/zmk-module.yml/badge.svg?branch=main)](https://github.com/nat-chan/zmk-module-runtime-accel/actions/workflows/zmk-module.yml) [![Devcontainer](https://github.com/nat-chan/zmk-module-runtime-accel/actions/workflows/devcontainer.yml/badge.svg?branch=main)](https://github.com/nat-chan/zmk-module-runtime-accel/actions/workflows/devcontainer.yml)

A ZMK input processor for pointer/scroll **acceleration with a runtime-editable
curve**: instead of recompiling firmware to tune acceleration, you drag control
points on a speed→factor curve in a web browser and the change takes effect
immediately (and can be saved to flash). Built for
[torabo-tsuki-lp](https://github.com/sekigon-gonnoc/zmk-keyboard-torabo-tsuki-lp)
but works with any ZMK pointing device.

- **Curve model**: up to 8 control points `(speed counts/sec, factor permille)`,
  linear interpolation between points, flat extension outside. `1000` = 1.0x,
  factors clamped to `100..20000`. Fractional output accumulates in per-axis
  remainders; acceleration is suppressed for one event on direction flips.
- **Editing**: a custom ZMK Studio RPC subsystem (`nat_chan__runtime_accel`)
  with three requests — `ListInstances` / `GetCurve` / `SetCurve` — and a
  minimal web curve editor in [`web/`](./web) (published at
  <https://nat-chan.github.io/zmk-module-runtime-accel/>).
- **Persistence**: one INT32-array entry per instance (key
  `"<instance-id>_curve"`) via
  [zmk-feature-custom-settings](https://github.com/cormoran/zmk-feature-custom-settings);
  `SetCurve(persist=true)` saves to flash, `persist=false` stages in RAM only.
  Curves also appear in the generic custom-settings web UI.

This module uses the **unofficial** custom Studio RPC protocol, so it requires
a patched ZMK (see the west manifest below).

## Module User Guide

### 1. west.yml

Add the module and the patched ZMK to your `config/west.yml`:

```yml
manifest:
  remotes:
    - name: nat-chan
      url-base: https://github.com/nat-chan
  projects:
    - name: zmk-module-runtime-accel
      remote: nat-chan
      revision: main
      import: true # pulls in zmk-feature-custom-settings
    # Required: patched ZMK with custom Studio RPC support
    - name: zmk
      remote: nat-chan
      revision: v0.3+custom-studio-protocol
      import:
        file: app/west.yml
  self:
    path: config
```

### 2. Kconfig

In your `config/<shield>.conf` (the split **central** side — the half that
runs Studio and owns the pointing device):

```conf
CONFIG_ZMK_RUNTIME_ACCEL=y

# Curve editing over ZMK Studio RPC
CONFIG_ZMK_STUDIO=y
CONFIG_ZMK_RUNTIME_ACCEL_STUDIO_RPC=y

# Persist curves to flash (recommended)
CONFIG_ZMK_CUSTOM_SETTINGS=y
CONFIG_ZMK_CUSTOM_SETTINGS_STUDIO_RPC=y

# Buffer budget: the largest curve message needs bigger RPC buffers than
# ZMK's defaults. The firmware BUILD_ASSERTs on these, so a too-small value
# fails at compile time instead of corrupting responses at runtime.
CONFIG_ZMK_STUDIO_RPC_RX_BUF_SIZE=192
CONFIG_ZMK_STUDIO_RPC_TX_BUF_SIZE=192
CONFIG_ZMK_STUDIO_RPC_CUSTOM_SUBSYSTEM_REQUEST_PAYLOAD_MAX_BYTES=128
CONFIG_ZMK_LOW_PRIORITY_THREAD_STACK_SIZE=2048
```

### 3. Devicetree overlay

Define one processor instance per stream and put it in the input-processor
chain. Example for torabo-tsuki-lp (`config/torabo_tsuki_lp_left.overlay`),
replacing a compile-time `&pointer_accel`-style processor with two runtime
instances — one for pointing, one for a scroll layer:

```dts
#include <input/processors.dtsi>

/ {
    pointer_accel: pointer_accel {
        compatible = "zmk,input-processor-runtime-accel";
        #input-processor-cells = <0>;
        instance-id = "pointer";
        /* [speed factor ...]: 1.0x up to 1000 counts/s, 3.5x at 3000+ */
        default-curve = <0 1000 1000 1000 3000 3500>;
    };

    scroll_accel: scroll_accel {
        compatible = "zmk,input-processor-runtime-accel";
        #input-processor-cells = <0>;
        instance-id = "scroll";
        default-curve = <0 1000 3000 2000>;
    };
};

/* Trackball on the central: plain pointing uses the "pointer" curve. */
&pointing_listener {
    input-processors = <&pointer_accel>;
};

/* On a scroll layer, run the "scroll" curve BEFORE the xy-to-scroll mapper
 * so acceleration applies to the raw movement, e.g.:
 *   input-processors = <&scroll_accel &zip_xy_to_scroll_mapper>;
 */
```

Notes:

- `instance-id` namespaces the RPC and the settings key
  (`pointer` → `pointer_curve`). **Persistence is provided for the ids
  `pointer` and `scroll`** (the custom-settings registry only supports
  statically defined array settings, see `CONFIG_ZMK_RUNTIME_ACCEL_SETTINGS`);
  other ids work but their curve changes are RAM-only.
- `default-curve` is used until a saved curve is loaded from flash or a curve
  is set over RPC. It must have an even number of 2..16 values.

### 4. 使い方 (editing curves)

1. キーボードを USB か BLE で PC につなぎ、
   <https://nat-chan.github.io/zmk-module-runtime-accel/> を Chromium 系
   ブラウザで開いて Connect します(Studio ロックがある場合は
   `&studio_unlock` キーで解除)。
2. インスタンス(`pointer` / `scroll`)を選ぶと現在のカーブが表示されます。
   制御点をドラッグ(またはダブルクリックで削除、"Add Point" で追加)して
   カーブを編集します。横軸 = ポインタ速度 (counts/sec)、縦軸 = 倍率
   (permille、1000 = 1.0x)。
3. **Apply (RAM)** は試し当て(電源を切ると消える)、**Save** はフラッシュに
   保存します。壊れた値を送っても firmware 側で偶数個への切り詰め・
   100..20000 へのクランプ・速度順ソートが行われるので安全です。

The same three RPCs are available to any Studio client; the curve is an
interleaved `sint32` list `[s0, f0, s1, f1, ...]` (see
[`proto/nat-chan/runtime-accel/runtime_accel.proto`](./proto/nat-chan/runtime-accel/runtime_accel.proto)).

### Web UI

See [web/README.md](./web/README.md) for web UI development instructions.

### Publishing Web UI

**GitHub Pages**: Merge a pull request into `main` to deploy to `https://<account>.github.io/<repo>/`.

**Cloudflare Workers (PR previews)**: Configure `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets. Previews are optional — when the secrets are absent, the workflow stays green and simply comments on the PR explaining how to enable them instead of deploying.

## Module Development Guide

### Setup for running test

#### Option0: Dev container (recommended)

Open this repository in VS Code with the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers). The container automatically initializes the west workspace using the isolated layout.

#### Option1: west workspace directory layout

Set west topdir as parent of repository root and download dependencies under `../`.
This layout is useful to reduce disk usage by sharing dependencies with other zephyr modules.
The build result is located in `../build`.

```bash
mkdir west-workspace
cd west-workspace # this directory becomes west workspace root (topdir)
git clone <this repository>
# rm -r .west # if exists to reset workspace
west init -l . --mf west/west-test-workspace.yml
west update --narrow
west zephyr-export
```

#### Option2: isolated directory layout

Set west topdir as repository root and download dependencies under `./dependencies`.
This layout is useful if you don't want to share dependencies to other zephyr modules.
Dev container and github actions uses this layout.
The build result is located in `./build`.

```bash
git clone <this repository>
cd <cloned directory>
# Idempotent helper shared with the devcontainer and CI: runs
# `west init -l west --mf west-test-isolated.yml`, `west update --narrow`,
# and `west zephyr-export`.
bash scripts/setup_workspace.sh
```

### Pre-commit

Every commit need to pass pre-commit verification. The verification contains formatting code and running tests.

```
pip install pre-commit
pre-commit install

# Run pre-commit manually
pre-commit run --all-files
# Run for git staged files
pre-commit run
```

### Running Test

```bash
# Run unit test + build test and verify the results
python3 -m unittest
# Run build test directly
west zmk-build tests/zmk-config
# Run unit test directly (tests/studio: RPC subsystem boots with 0 devices;
# tests/accel: curve sanitize/eval/settings-apply on native_sim)
west zmk-test tests -m .
# Run web tests
cd web && npm test
```

### Hardware-free Renode testing

CI boots the firmware in the [Renode](https://renode.io/) emulator (a `Build`
job step) and runs `tests/renode/` -- `renode_test.py` exercises this module's
ListInstances/GetCurve/SetCurve RPC (including sanitize-on-apply and the
custom-settings write path) over the central's emulated **USB CDC**. It uses
`west zmk-renode-test`'s **`wired-split`** mode: a wired split pair whose central
answers Studio RPC over USB while the wired split link forwards key events. The
ELFs are the `usb_wired_central` / `usb_wired_peripheral` artifacts in
`tests/zmk-config/build.yaml`. Locally:

```bash
west zmk-build tests/zmk-config -af usb_wired_central
west zmk-build tests/zmk-config -af usb_wired_peripheral
west zmk-renode-test tests/renode --mode wired-split \
    --elf build/usb_wired_central/zephyr/zmk.elf \
    --peripheral-elf build/usb_wired_peripheral/zephyr/zmk.elf
```

Details (the mode + `ZMK_RENODE_*` env contract): see
[zmk-west-commands' README, `west zmk-renode-test`](https://github.com/cormoran/zmk-west-commands#west-zmk-renode-test)
and [docs/renode-testing.md](https://github.com/cormoran/zmk-west-commands/blob/main/docs/renode-testing.md).

### Web UI end-to-end testing

`web/e2e/` runs the **web UI itself**, in a headless browser, against this
module's **real firmware** in Renode -- no hardware (CI's `Web UI E2E Test`
workflow). `west zmk-web-e2e` boots the DUT, serves its Studio RPC (over the
emulated USB CDC) to the browser and hands the test a `navigator.serial` shim,
so the app, its transport, the RPC framing and the firmware are all real -- only
the browser's serial driver is faked. `rpc.spec.ts` connects through the app's
own button and drives the curve editor end to end. Locally:

```bash
west zmk-build tests/zmk-config -af web_e2e
west zmk-web-e2e --elf build/web_e2e/zephyr/zmk.elf -- npm --prefix web run e2e
```

The DUT (the `web_e2e` artifact) is the real `studio-rpc-usb-uart` image with
Studio locking off -- an emulator has no key to press `&studio_unlock` with.
Details (the shim's permission model, the `ZMK_WEB_E2E_*` env contract,
debugging): see
[zmk-west-commands' docs/zmk-web-e2e.md](https://github.com/cormoran/zmk-west-commands/blob/main/docs/zmk-web-e2e.md).

### Running BLE (BabbleSim) tests

`tests/ble/` runs real `nrf52_bsim` firmware on a simulated radio (x86 Linux
only; CI's `ble-test` job). The one case, `studio/custom-rpc-split`, checks --
in a split central+peripheral topology -- that the curve RPC answers over the
BLE GATT transport while the split link is active (listCustomSubsystems +
GetCurve, asserted byte-exact against a snapshot). The Studio host side is one
declarative `studio_requests.json` -- no host C code in this module. Locally:

```bash
west zmk-ble-test tests/ble -m .   # --auto-accept regenerates snapshots
```

Details (case-file conventions, JSON DSL, `{prefix}`/`{studio_host}`,
BabbleSim setup): see
[zmk-west-commands' README, `west zmk-ble-test`](https://github.com/cormoran/zmk-west-commands#west-zmk-ble-test).

### Sync changes from template

Run `Actions > Sync Changes in Template > Run workflow` to get the latest template changes as a pull request.

If the template contains changes in `.github/workflows/*`, register a GitHub personal access token as `GH_TOKEN` repository secret (`repo` + `workflow` scopes).

### Coding agent on actions

Actions for github copilot and claude are available.

- Mention `@copilot`
- Setup `ANTHROPIC_API_KEY` secret and mention `@claude`
  - Or fix [claude.yml](./github/workflows/claude.yml) to use `CLAUDE_CODE_OAUTH_TOKEN`

## Credits

- Built from [cormoran/zmk-module-template](https://github.com/cormoran/zmk-module-template) by [@cormoran](https://github.com/cormoran). <!-- zmk-module-template:keep -->
- The per-event speed estimation, remainder accumulation and direction-flip
  suppression in the processor are adapted from the MIT-licensed
  zmk-input-processor-acceleration sample.
