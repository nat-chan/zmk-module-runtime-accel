#!/usr/bin/env python3
"""Hardware-free functional test: boot this module's firmware as a wired split
pair in Renode and exercise its own custom Studio RPC over the central's
emulated USB CDC. The generic checks (both halves booting, the wired split
link, a core GetDeviceInfo round trip over USB) already ran in the action's
smoke step; this file covers the runtime-accel RPC surface:
ListInstances -> GetCurve (devicetree default) -> SetCurve -> GetCurve
(sanitized round trip).

Run by `west zmk-renode-test tests/renode --mode wired-split --elf <CENTRAL>
--peripheral-elf <PERIPHERAL>`, which sets the `ZMK_RENODE_*` env contract (see
zmk-west-commands' docs/renode-testing.md, "Module-test env contract"):
  ZMK_RENODE_MODE           = wired-split
  ZMK_RENODE_ELF            = the split CENTRAL ELF
  ZMK_RENODE_PERIPHERAL_ELF = the split PERIPHERAL ELF
  ZMK_RENODE_STORAGE_ADDR / _SIZE = the central's NVS storage_partition overrides
and puts `renode_harness` (zmk-west-commands' scripts/lib/renode) on PYTHONPATH.

(Named `renode_test.py`, not `test_renode.py`, so it stays out of
`python3 -m unittest`'s `test*.py` auto-discovery -- it needs real ELFs.)
"""

from __future__ import annotations

import os
import sys
import time
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

# renode_harness comes from the zmk-west-commands checkout the command puts on
# PYTHONPATH. Support running this file directly too by falling back to
# conventional relative locations: first the zmk-west-commands west dependency
# this repo has (west/west-dependency/west-test-dependency.yml -- nicer than
# requiring a sibling checkout, since `west update` already fetches it), then a
# sibling `zmk-west-commands` checkout next to this repo.
try:
    import renode_harness
except ImportError:  # pragma: no cover - convenience fallback for local dev
    fallback_candidates = [
        REPO_ROOT / "dependencies" / "zmk-west-commands" / "scripts" / "lib" / "renode",
        REPO_ROOT.parent / "zmk-west-commands" / "scripts" / "lib" / "renode",
    ]
    for fallback in fallback_candidates:
        if fallback.is_dir():
            sys.path.insert(0, str(fallback))
            import renode_harness

            break
    else:
        raise


SUBSYSTEM_IDENTIFIER = "nat_chan__runtime_accel"
# This module registers exactly one custom subsystem. The central build also
# enables zmk-feature-custom-settings' subsystem, so resolve the index from
# listCustomSubsystems instead of hard-coding it.
INVALID_SUBSYSTEM_INDEX = 99

# The two instances the runtime-accel-instances snippet
# (tests/zmk-config/snippets/runtime-accel-instances/) adds to the central.
EXPECTED_INSTANCES = ["pointer", "scroll"]
POINTER_DEFAULT_CURVE = [0, 1000, 1000, 1000, 3000, 3500]

# attach_dual_cdc_bridge's default bridge name -> monitor object prefix.
BRIDGE_NAME = "bridge"


def _mon_is_true(mon, command: str) -> bool:
    return "True" in mon.execute(command, settle=0.3)


class RenodeWiredSplitModuleTests(unittest.TestCase):
    """Boots the module's own wired-split pair once for the whole class (boot is
    the slow part) and exercises the runtime-accel subsystem over the central's
    USB CDC."""

    renode_path: str
    studio_pb2 = None
    accel_pb2 = None

    @classmethod
    def setUpClass(cls):
        cls.renode_path = renode_harness.find_or_install_renode()
        if cls.renode_path is None:
            raise unittest.SkipTest(
                "Renode is not installed and could not be auto-installed"
            )

        # Env contract (see docs/renode-testing.md "Module-test env contract").
        mode = os.environ.get("ZMK_RENODE_MODE", "wired-split")
        if mode != "wired-split":
            raise unittest.SkipTest(
                f"ZMK_RENODE_MODE={mode!r}: this module's Renode test targets "
                "wired-split mode -- run `west zmk-renode-test tests/renode "
                "--mode wired-split --elf build/usb_wired_central/zephyr/zmk.elf "
                "--peripheral-elf build/usb_wired_peripheral/zephyr/zmk.elf`"
            )

        central_env = os.environ.get("ZMK_RENODE_ELF")
        peripheral_env = os.environ.get("ZMK_RENODE_PERIPHERAL_ELF")
        if not central_env or not peripheral_env:
            raise unittest.SkipTest(
                "ZMK_RENODE_ELF / ZMK_RENODE_PERIPHERAL_ELF not set -- build the "
                "wired-split pair first (see README.md)"
            )
        cls.central_elf = Path(central_env)
        cls.peripheral_elf = Path(peripheral_env)
        for elf in (cls.central_elf, cls.peripheral_elf):
            if not elf.is_file():
                raise unittest.SkipTest(f"ELF does not exist: {elf}")

        storage_addr = int(
            os.environ.get("ZMK_RENODE_STORAGE_ADDR")
            or hex(renode_harness.STORAGE_ADDR_DEFAULT),
            0,
        )
        storage_size = int(
            os.environ.get("ZMK_RENODE_STORAGE_SIZE")
            or hex(renode_harness.STORAGE_SIZE_DEFAULT),
            0,
        )

        # Core zmk.studio.* messages (Request/Response envelope, core.proto,
        # custom.proto for the generic custom-subsystem envelope).
        studio_proto_dir = renode_harness.find_studio_proto_dir(REPO_ROOT)
        cls.studio_pb2 = renode_harness.load_studio_pb2(studio_proto_dir)

        # This module's own proto (package nat_chan.runtime_accel) -- protoc
        # normalizes the hyphenated module path to the snake_case package.
        out_dir = renode_harness.compile_protos(
            [
                REPO_ROOT
                / "proto"
                / "nat-chan"
                / "runtime-accel"
                / "runtime_accel.proto"
            ],
            include_dirs=[REPO_ROOT / "proto"],
        )
        sys.path.insert(0, str(out_dir))
        import nat_chan.runtime_accel.runtime_accel_pb2 as accel_pb2  # type: ignore

        cls.accel_pb2 = accel_pb2

        # Boot the pair and attach the DualCdcAcmBridge USB host to reach the
        # central's Studio CDC (the same steps run_usb_wired_smoke uses).
        import random

        cls.port_base = random.randint(26000, 40000)
        (
            cls.session,
            cls.central_console,
            cls.peripheral_console,
        ) = renode_harness.boot_usb_wired_split(
            cls.renode_path,
            central_elf=cls.central_elf,
            peripheral_elf=cls.peripheral_elf,
            storage_addr=storage_addr,
            storage_size=storage_size,
            port_base=cls.port_base,
        )
        cls.addClassCleanup(cls.session.stop)
        cls.addClassCleanup(cls.central_console.close)
        cls.addClassCleanup(cls.peripheral_console.close)

        banner = renode_harness.wait_for_text(
            cls.central_console._sock, "Welcome to ZMK", timeout=20
        )
        if "Welcome to ZMK" not in banner:
            raise AssertionError(
                f"central never saw the ZMK boot banner on uart0; got:\n{banner}"
            )

        # Let the guest finish USB bring-up before the host attaches (a SETUP
        # fired before the guest's INTEN is set is silently lost).
        settle_deadline = time.monotonic() + 8.0
        while time.monotonic() < settle_deadline:
            renode_harness.drain_text(cls.central_console._sock, timeout=0.5)

        cdc0, cdc1 = renode_harness.attach_dual_cdc_bridge(
            cls.session, cls.port_base + 4, cls.port_base + 5
        )
        cls.addClassCleanup(cdc0.close)
        cls.addClassCleanup(cdc1.close)

        mon = cls.session.mon
        wiring_deadline = time.monotonic() + 30.0
        while time.monotonic() < wiring_deadline:
            if _mon_is_true(mon, f"sysbus.{BRIDGE_NAME}_cdc0 IsWired"):
                break
        else:
            raise AssertionError(
                f"USB enumeration never wired the first CDC channel "
                f"(no sysbus.{BRIDGE_NAME}_cdc0 IsWired within 30s)"
            )
        # Console stays on uart0 here, so USB is normally a single Studio CDC;
        # auto-detect anyway (a build that also put console on USB would
        # enumerate console first, Studio second).
        dual_cdc = _mon_is_true(mon, f"sysbus.{BRIDGE_NAME}_cdc1 IsWired")
        time.sleep(2.0)
        cls.studio = cdc1 if dual_cdc else cdc0

        cls.subsystem_index = cls._find_subsystem_index()

    # -- Studio RPC plumbing --------------------------------------------------

    _request_id = 0

    @classmethod
    def _next_request_id(cls) -> int:
        cls._request_id += 1
        return cls._request_id

    @classmethod
    def _find_subsystem_index(cls) -> int:
        req = cls.studio_pb2.Request()
        request_id = cls._next_request_id()
        req.request_id = request_id
        req.custom.list_custom_subsystems.SetInParent()
        cls.studio.send(req.SerializeToString())
        resp_bytes = cls.studio.read_frame(timeout=10.0)
        assert resp_bytes is not None, "no listCustomSubsystems response"
        resp = cls.studio_pb2.Response()
        resp.ParseFromString(resp_bytes)
        subsystems = resp.request_response.custom.list_custom_subsystems.subsystems
        for subsystem in subsystems:
            if subsystem.identifier == SUBSYSTEM_IDENTIFIER:
                return subsystem.index
        raise AssertionError(
            f"{SUBSYSTEM_IDENTIFIER} not in registered subsystems: "
            f"{[s.identifier for s in subsystems]}"
        )

    def _send_call(self, subsystem_index: int, payload: bytes, request_id: int):
        req = self.studio_pb2.Request()
        req.request_id = request_id
        req.custom.call.subsystem_index = subsystem_index
        req.custom.call.payload = payload
        self.studio.send(req.SerializeToString())

    def _read_response(self, timeout: float = 10.0):
        """Read the next request_response frame, skipping firmware-initiated
        notification frames: a SetCurve's custom-settings write raises
        zmk_custom_setting_changed, which the custom-settings subsystem
        (CONFIG_ZMK_CUSTOM_SETTINGS_STUDIO_RPC) broadcasts as a Studio
        notification that can arrive before the RPC response."""
        deadline = time.monotonic() + timeout
        while True:
            remaining = max(0.1, deadline - time.monotonic())
            resp_bytes = self.studio.read_frame(timeout=remaining)
            self.assertIsNotNone(resp_bytes, "no Studio RPC response frame (timeout)")
            resp = self.studio_pb2.Response()
            resp.ParseFromString(resp_bytes)
            if resp.WhichOneof("type") == "notification":
                continue
            return resp

    def _call_accel(self, inner_request):
        """Round-trip one nat_chan.runtime_accel.Request and return the decoded
        nat_chan.runtime_accel.Response."""
        request_id = self._next_request_id()
        self._send_call(
            self.subsystem_index, inner_request.SerializeToString(), request_id
        )
        resp = self._read_response()
        self.assertEqual(resp.WhichOneof("type"), "request_response")
        self.assertEqual(resp.request_response.request_id, request_id)
        self.assertEqual(resp.request_response.WhichOneof("subsystem"), "custom")
        custom_resp = resp.request_response.custom
        self.assertEqual(custom_resp.WhichOneof("response_type"), "call")
        self.assertEqual(custom_resp.call.subsystem_index, self.subsystem_index)
        inner_resp = self.accel_pb2.Response()
        inner_resp.ParseFromString(custom_resp.call.payload)
        return inner_resp

    # -- Affirmative proof the custom-subsystem envelope works ---------------

    def test_custom_rpc_invalid_index_dispatch(self):
        """`custom.call` to a subsystem index that doesn't exist proves the
        whole custom-subsystem envelope round-trips correctly end to end
        (Request.custom oneof selection, CallRequest field encoding,
        subsystem-count/index validation, meta.simple_error response) -- the
        fast, callback-free path."""
        request_id = self._next_request_id()
        self._send_call(INVALID_SUBSYSTEM_INDEX, b"", request_id)
        resp = self._read_response()
        self.assertEqual(resp.WhichOneof("type"), "request_response")
        self.assertEqual(resp.request_response.request_id, request_id)
        self.assertEqual(resp.request_response.WhichOneof("subsystem"), "meta")
        self.assertEqual(
            resp.request_response.meta.WhichOneof("response_type"), "simple_error"
        )
        # zmk.meta.ErrorConditions.RPC_NOT_FOUND == 2
        self.assertEqual(resp.request_response.meta.simple_error, 2)

    # -- The real thing: this module's own custom RPC, over USB --------------

    def test_list_instances(self):
        """ListInstances reports the two devicetree instances the
        runtime-accel-instances snippet adds to the central."""
        req = self.accel_pb2.Request()
        req.list_instances.SetInParent()
        resp = self._call_accel(req)
        self.assertEqual(resp.WhichOneof("response_type"), "instances")
        self.assertEqual(list(resp.instances.ids), EXPECTED_INSTANCES)

    def test_get_curve_returns_devicetree_default(self):
        """With nothing persisted, GetCurve returns the devicetree
        default-curve of the instance."""
        req = self.accel_pb2.Request()
        req.get_curve.instance_id = "pointer"
        resp = self._call_accel(req)
        self.assertEqual(resp.WhichOneof("response_type"), "curve")
        self.assertEqual(resp.curve.instance_id, "pointer")
        self.assertEqual(list(resp.curve.points), POINTER_DEFAULT_CURVE)

    def test_get_curve_unknown_instance(self):
        req = self.accel_pb2.Request()
        req.get_curve.instance_id = "nope"
        resp = self._call_accel(req)
        self.assertEqual(resp.WhichOneof("response_type"), "error")
        self.assertIn("Unknown instance id", resp.error.message)

    def test_set_curve_round_trip_with_sanitization(self):
        """SetCurve (persist=False -> custom-settings MEMORY write -> changed
        event -> RAM apply) followed by GetCurve returns the sanitized curve:
        unsorted input sorted by speed, factors clamped to 100..20000."""
        req = self.accel_pb2.Request()
        req.set_curve.instance_id = "scroll"
        # Unsorted + out-of-range factor: expect (0,100) (500,20000) (1500,1200).
        req.set_curve.points.extend([1500, 1200, 0, 5, 500, 999999])
        req.set_curve.persist = False
        resp = self._call_accel(req)
        self.assertEqual(resp.WhichOneof("response_type"), "ack")

        req = self.accel_pb2.Request()
        req.get_curve.instance_id = "scroll"
        resp = self._call_accel(req)
        self.assertEqual(resp.WhichOneof("response_type"), "curve")
        self.assertEqual(list(resp.curve.points), [0, 100, 500, 20000, 1500, 1200])

    def test_set_curve_invalid_rejected(self):
        """Fewer than one full control point is rejected with an error and
        leaves the previous curve in place."""
        req = self.accel_pb2.Request()
        req.set_curve.instance_id = "pointer"
        req.set_curve.points.extend([42])
        resp = self._call_accel(req)
        self.assertEqual(resp.WhichOneof("response_type"), "error")

        req = self.accel_pb2.Request()
        req.get_curve.instance_id = "pointer"
        resp = self._call_accel(req)
        self.assertEqual(list(resp.curve.points), POINTER_DEFAULT_CURVE)


if __name__ == "__main__":
    unittest.main()
