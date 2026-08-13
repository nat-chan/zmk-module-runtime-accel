import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createConnectedMockZMKApp,
  ZMKAppProvider,
} from "@cormoran/zmk-studio-react-hook/testing";
import { CurveEditorSection, SUBSYSTEM_IDENTIFIER } from "../src/App";
import { toPairs, toInterleaved } from "../src/curve";
import {
  Request,
  Response,
} from "../src/proto/nat-chan/runtime-accel/runtime_accel";
import { LockState } from "@zmkfirmware/zmk-studio-ts-client/core";

// Mock the ZMK client so we can control call_rpc responses directly: both
// useStudioLockState's initial getLockState query and useCustomSubsystem's
// callRPC go through this module.
jest.mock("@zmkfirmware/zmk-studio-ts-client", () => ({
  create_rpc_connection: jest.fn(),
  call_rpc: jest.fn(),
  MetaError: class MetaError extends Error {
    condition: number;
    constructor(condition: number) {
      super(`meta error: ${condition}`);
      this.condition = condition;
      Object.setPrototypeOf(this, MetaError.prototype);
    }
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const zmkClient = require("@zmkfirmware/zmk-studio-ts-client");

/**
 * Fake firmware: keeps one curve per instance, answers
 * listInstances/getCurve/setCurve like src/studio/runtime_accel_handler.c
 * (including the sanitize-on-apply behavior the UI relies on when it
 * reloads after Apply/Save).
 */
function mockFirmware(initial: Record<string, number[]>) {
  const curves = new Map(Object.entries(initial));
  const setCurveRequests: {
    instanceId: string;
    points: number[];
    persist: boolean;
  }[] = [];

  const sanitize = (points: number[]): number[] => {
    const pairs = toPairs(points)
      .slice(0, 8)
      .map((p) => ({
        speed: Math.max(0, p.speed),
        factor: Math.min(20000, Math.max(100, p.factor)),
      }))
      .sort((a, b) => a.speed - b.speed);
    return toInterleaved(pairs);
  };

  zmkClient.call_rpc.mockImplementation(
    (
      _connection: unknown,
      req: {
        core?: { getLockState?: boolean };
        custom?: { call?: { payload: Uint8Array } };
      }
    ) => {
      if (req.core?.getLockState) {
        return Promise.resolve({
          core: {
            getLockState: LockState.ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED,
          },
        });
      }
      if (req.custom?.call) {
        const inner = Request.decode(req.custom.call.payload);
        let resp: Response;
        if (inner.listInstances) {
          resp = Response.create({
            instances: { ids: Array.from(curves.keys()) },
          });
        } else if (inner.getCurve) {
          const points = curves.get(inner.getCurve.instanceId);
          resp = points
            ? Response.create({
                curve: { instanceId: inner.getCurve.instanceId, points },
              })
            : Response.create({
                error: { message: "Unknown instance id" },
              });
        } else if (inner.setCurve) {
          const { instanceId, points, persist } = inner.setCurve;
          if (!curves.has(instanceId)) {
            resp = Response.create({
              error: { message: "Unknown instance id" },
            });
          } else {
            setCurveRequests.push({ instanceId, points, persist });
            curves.set(instanceId, sanitize(points));
            resp = Response.create({ ack: {} });
          }
        } else {
          resp = Response.create({ error: { message: "Unsupported" } });
        }
        const payload = Response.encode(resp).finish();
        return Promise.resolve({ custom: { call: { payload } } });
      }
      return Promise.reject(new Error("unexpected call_rpc request"));
    }
  );

  return { curves, setCurveRequests };
}

function renderSection() {
  const mockZMKApp = createConnectedMockZMKApp({
    deviceName: "Test Device",
    subsystems: [SUBSYSTEM_IDENTIFIER],
  });
  return render(
    <ZMKAppProvider value={mockZMKApp}>
      <CurveEditorSection />
    </ZMKAppProvider>
  );
}

describe("CurveEditorSection", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("lists the firmware's instances and loads the first curve", async () => {
    mockFirmware({
      pointer: [0, 1000, 1000, 3000],
      scroll: [0, 1000, 3000, 2000],
    });
    renderSection();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "pointer" })
      ).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "scroll" })).toBeInTheDocument();

    // The pointer curve (2 points) is loaded into the editor.
    expect(screen.getByLabelText("point 0 speed")).toHaveValue(0);
    expect(screen.getByLabelText("point 0 factor")).toHaveValue(1000);
    expect(screen.getByLabelText("point 1 speed")).toHaveValue(1000);
    expect(screen.getByLabelText("point 1 factor")).toHaveValue(3000);
    // And drawn as an SVG polyline with one draggable circle per point.
    expect(screen.getByTestId("curve-svg")).toBeInTheDocument();
    expect(screen.getByTestId("curve-point-0")).toBeInTheDocument();
    expect(screen.getByTestId("curve-point-1")).toBeInTheDocument();
  });

  it("switches curves when another instance is selected", async () => {
    mockFirmware({
      pointer: [0, 1000, 1000, 3000],
      scroll: [0, 1000, 3000, 2000],
    });
    renderSection();

    const user = userEvent.setup();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "scroll" })
      ).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "scroll" }));

    await waitFor(() => {
      expect(screen.getByLabelText("point 1 speed")).toHaveValue(3000);
    });
    expect(screen.getByLabelText("point 1 factor")).toHaveValue(2000);
  });

  it("shows a warning when the firmware has no instances", async () => {
    mockFirmware({});
    renderSection();

    await waitFor(() => {
      expect(
        screen.getByText(/No runtime-accel instances in this firmware/i)
      ).toBeInTheDocument();
    });
  });

  it("Apply sends setCurve with persist=false and reloads the sanitized curve", async () => {
    const firmware = mockFirmware({ pointer: [0, 1000] });
    renderSection();

    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByLabelText("point 0 factor")).toHaveValue(1000);
    });

    // Type an out-of-range factor; the fake firmware clamps it to 20000 on
    // apply, and the UI reloads the sanitized value.
    const factorInput = screen.getByLabelText("point 0 factor");
    await user.clear(factorInput);
    await user.type(factorInput, "99999");
    await user.click(screen.getByRole("button", { name: /Apply \(RAM\)/ }));

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent(
        "Applied (RAM only)"
      );
    });
    expect(firmware.setCurveRequests).toEqual([
      { instanceId: "pointer", points: [0, 20000], persist: false },
    ]);
    await waitFor(() => {
      expect(screen.getByLabelText("point 0 factor")).toHaveValue(20000);
    });
  });

  it("Save sends setCurve with persist=true (enabled once dirty)", async () => {
    const firmware = mockFirmware({ pointer: [0, 1000] });
    renderSection();

    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByLabelText("point 0 factor")).toHaveValue(1000);
    });
    // Apply/Save are disabled while the edit matches the loaded curve.
    expect(screen.getByRole("button", { name: /Save/ })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Apply \(RAM\)/ })
    ).toBeDisabled();

    const factorInput = screen.getByLabelText("point 0 factor");
    await user.clear(factorInput);
    await user.type(factorInput, "1500");
    await user.click(screen.getByRole("button", { name: /Save/ }));

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("Saved to flash");
    });
    expect(firmware.setCurveRequests.at(-1)).toEqual({
      instanceId: "pointer",
      points: [0, 1500],
      persist: true,
    });
  });

  it("shows the ghost curve when dirty and Revert restores the loaded curve", async () => {
    mockFirmware({ pointer: [0, 1000, 1000, 3000] });
    renderSection();

    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByLabelText("point 1 factor")).toHaveValue(3000);
    });
    expect(screen.queryByTestId("curve-ghost")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Revert/ })).toBeDisabled();

    const factorInput = screen.getByLabelText("point 1 factor");
    await user.clear(factorInput);
    await user.type(factorInput, "3500");
    expect(screen.getByTestId("curve-ghost")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Revert/ }));
    expect(screen.getByLabelText("point 1 factor")).toHaveValue(3000);
    expect(screen.queryByTestId("curve-ghost")).not.toBeInTheDocument();
  });

  it("adds and removes control points", async () => {
    mockFirmware({ pointer: [0, 1000] });
    renderSection();

    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByLabelText("point 0 speed")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Add Point/ }));
    expect(screen.getByLabelText("point 1 speed")).toHaveValue(500);
    expect(screen.getByLabelText("point 1 factor")).toHaveValue(1000);

    await user.click(screen.getByRole("button", { name: "remove point 1" }));
    expect(screen.queryByLabelText("point 1 speed")).not.toBeInTheDocument();

    // The last remaining point cannot be removed.
    expect(
      screen.getByRole("button", { name: "remove point 0" })
    ).toBeDisabled();
  });

  it("surfaces firmware errors", async () => {
    mockFirmware({ pointer: [0, 1000] });
    renderSection();

    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByLabelText("point 0 speed")).toBeInTheDocument();
    });

    // Dirty the curve so Apply is enabled.
    const factorInput = screen.getByLabelText("point 0 factor");
    await user.clear(factorInput);
    await user.type(factorInput, "1200");

    // Make every further call fail with an error response.
    zmkClient.call_rpc.mockImplementation(
      (_connection: unknown, req: { core?: { getLockState?: boolean } }) => {
        if (req.core?.getLockState) {
          return Promise.resolve({
            core: {
              getLockState: LockState.ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED,
            },
          });
        }
        const payload = Response.encode(
          Response.create({ error: { message: "Unknown instance id" } })
        ).finish();
        return Promise.resolve({ custom: { call: { payload } } });
      }
    );

    await user.click(screen.getByRole("button", { name: /Apply \(RAM\)/ }));
    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent(
        "Error: Unknown instance id"
      );
    });
  });

  it("does not render without ZMKAppContext", () => {
    const { container } = render(<CurveEditorSection />);
    expect(container.firstChild).toBeNull();
  });

  it("shows a warning when the subsystem is missing", () => {
    const mockZMKApp = createConnectedMockZMKApp({
      deviceName: "Test Device",
      subsystems: [],
    });
    render(
      <ZMKAppProvider value={mockZMKApp}>
        <CurveEditorSection />
      </ZMKAppProvider>
    );

    expect(
      screen.getByText(/Subsystem "nat_chan__runtime_accel" not found/i)
    ).toBeInTheDocument();
  });
});
