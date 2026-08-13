import { fireEvent, render, screen } from "@testing-library/react";
import { CurveSvg } from "../src/CurveEditor";
import type { CurvePoint } from "../src/curve";

// jsdom (pre-PointerEvent versions) fallback so testing-library can build
// pointer events with client coordinates.
if (typeof window.PointerEvent === "undefined") {
  class PointerEventShim extends MouseEvent {
    pointerId: number;
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
    }
  }
  window.PointerEvent = PointerEventShim as unknown as typeof PointerEvent;
}

// The SVG is laid out with viewBox 0 0 400 220; report the same client size
// so client coordinates map 1:1 onto view coordinates.
beforeEach(() => {
  jest
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, 0, 400, 220));
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** Mirrors the component's layout constants for coordinate math. */
const MARGIN = { left: 44, right: 12, top: 12, bottom: 26 };
const PLOT_W = 400 - MARGIN.left - MARGIN.right;
const PLOT_H = 220 - MARGIN.top - MARGIN.bottom;
const xOf = (speed: number, speedMax: number) =>
  MARGIN.left + (speed / speedMax) * PLOT_W;
const yOf = (factor: number, factorMax: number) =>
  MARGIN.top + PLOT_H - (factor / factorMax) * PLOT_H;

function renderEditor(
  pairs: CurvePoint[],
  extra?: { ghostPairs?: CurvePoint[] | null }
) {
  const onChange = jest.fn();
  render(<CurveSvg pairs={pairs} onChange={onChange} {...extra} />);
  return { onChange };
}

describe("CurveSvg", () => {
  it("renders round 1-2-5 tick labels with units stated once", () => {
    renderEditor([
      { speed: 0, factor: 1000 },
      { speed: 3000, factor: 2000 },
    ]);
    // x domain 6000 -> majors 0,2k,4k,6k; y domain 2000 -> 0.5x..2x.
    for (const label of ["2k", "4k", "6k", "0.5x", "1x", "1.5x", "2x"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText("counts/s")).toBeInTheDocument();
    expect(screen.getByText("gain")).toBeInTheDocument();
    // No permille tick labels.
    expect(screen.queryByText("1000")).not.toBeInTheDocument();
    expect(screen.queryByText("1500")).not.toBeInTheDocument();
  });

  it("adds a point on the curve when the line is clicked", () => {
    const { onChange } = renderEditor([
      { speed: 0, factor: 1000 },
      { speed: 4000, factor: 1000 },
    ]);
    // Domain: speedMax 6000, factorMax 2000. Click the flat line at 2000.
    fireEvent.pointerDown(screen.getByTestId("curve-line-hit"), {
      clientX: xOf(2000, 6000),
      clientY: yOf(1000, 2000),
      pointerId: 1,
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual([
      { speed: 0, factor: 1000 },
      { speed: 2000, factor: 1000 },
      { speed: 4000, factor: 1000 },
    ]);
  });

  it("clamps a dragged point between its neighbors (no crossing)", () => {
    const pairs = [
      { speed: 0, factor: 1000 },
      { speed: 2000, factor: 1500 },
      { speed: 4000, factor: 1000 },
    ];
    const { onChange } = renderEditor(pairs);
    fireEvent.pointerDown(screen.getByTestId("curve-point-1"), {
      clientX: xOf(2000, 6000),
      clientY: yOf(1500, 2000),
      pointerId: 1,
    });
    // Try to drag the middle point past its right neighbor (to 5000).
    fireEvent.pointerMove(screen.getByTestId("curve-svg"), {
      clientX: xOf(5000, 6000),
      clientY: yOf(1500, 2000),
      pointerId: 1,
    });
    const moved = onChange.mock.calls.at(-1)![0][1];
    expect(moved.speed).toBe(4000); // clamped at the neighbor, not 5000
    // And past the left neighbor.
    fireEvent.pointerMove(screen.getByTestId("curve-svg"), {
      clientX: xOf(-2000, 6000),
      clientY: yOf(1500, 2000),
      pointerId: 1,
    });
    expect(onChange.mock.calls.at(-1)![0][1].speed).toBe(0);
  });

  it("lets the last point drag past the plot edge linearly (frozen domain)", () => {
    const { onChange } = renderEditor([
      { speed: 0, factor: 1000 },
      { speed: 3000, factor: 2000 },
    ]);
    fireEvent.pointerDown(screen.getByTestId("curve-point-1"), {
      clientX: xOf(3000, 6000),
      clientY: yOf(2000, 2000),
      pointerId: 1,
    });
    // 100 view-units right of the plot edge: linear extrapolation of the
    // frozen 0..6000 domain, no per-frame autoscale feedback.
    fireEvent.pointerMove(screen.getByTestId("curve-svg"), {
      clientX: MARGIN.left + PLOT_W + 100,
      clientY: yOf(2000, 2000),
      pointerId: 1,
    });
    const moved = onChange.mock.calls.at(-1)![0][1];
    expect(moved.speed).toBe(Math.round(((PLOT_W + 100) / PLOT_W) * 6000));
  });

  it("keeps the axis domain frozen while dragging", () => {
    const pairs = [
      { speed: 0, factor: 1000 },
      { speed: 3000, factor: 2000 },
    ];
    const { rerender } = (() => {
      const onChange = jest.fn();
      const utils = render(<CurveSvg pairs={pairs} onChange={onChange} />);
      return utils;
    })();
    fireEvent.pointerDown(screen.getByTestId("curve-point-1"), {
      clientX: xOf(3000, 6000),
      clientY: yOf(2000, 2000),
      pointerId: 1,
    });
    // Parent applies a far-out drag position; the tick labels must not
    // rescale mid-drag (domain frozen at 0..6000).
    rerender(
      <CurveSvg
        pairs={[pairs[0], { speed: 8000, factor: 2000 }]}
        onChange={jest.fn()}
      />
    );
    expect(screen.getByText("6k")).toBeInTheDocument();
    expect(screen.queryByText("10k")).not.toBeInTheDocument();
    // After pointer-up the domain refits with a nice ceiling (0..10000).
    fireEvent.pointerUp(screen.getByTestId("curve-svg"), {
      pointerId: 1,
    });
    expect(screen.getByText("10k")).toBeInTheDocument();
  });

  it("nudges a focused point with arrow keys and removes it with Delete", () => {
    const pairs = [
      { speed: 0, factor: 1000 },
      { speed: 3000, factor: 2000 },
    ];
    const { onChange } = renderEditor(pairs);
    const point = screen.getByTestId("curve-point-1");
    expect(point).toHaveAttribute("role", "button");
    expect(point).toHaveAttribute("aria-label", "point 2: 3000 counts/s, 2x");

    // ArrowRight: +1% of the 6000 domain.
    fireEvent.keyDown(point, { key: "ArrowRight" });
    expect(onChange.mock.calls.at(-1)![0][1]).toEqual({
      speed: 3060,
      factor: 2000,
    });
    // Shift+ArrowDown: -100 permille.
    fireEvent.keyDown(point, { key: "ArrowDown", shiftKey: true });
    expect(onChange.mock.calls.at(-1)![0][1]).toEqual({
      speed: 3000,
      factor: 1900,
    });
    // Delete removes the point.
    fireEvent.keyDown(point, { key: "Delete" });
    expect(onChange.mock.calls.at(-1)![0]).toEqual([pairs[0]]);
  });

  it("does not remove the last remaining point", () => {
    const { onChange } = renderEditor([{ speed: 0, factor: 1000 }]);
    const point = screen.getByTestId("curve-point-0");
    fireEvent.keyDown(point, { key: "Delete" });
    fireEvent.doubleClick(point);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("removes a point on double-click", () => {
    const { onChange } = renderEditor([
      { speed: 0, factor: 1000 },
      { speed: 3000, factor: 2000 },
    ]);
    fireEvent.doubleClick(screen.getByTestId("curve-point-0"));
    expect(onChange).toHaveBeenCalledWith([{ speed: 3000, factor: 2000 }]);
  });

  it("shows a live readout for the focused/hovered point", () => {
    renderEditor([
      { speed: 0, factor: 1000 },
      { speed: 3200, factor: 1850 },
    ]);
    expect(screen.queryByTestId("curve-readout")).not.toBeInTheDocument();
    fireEvent.focus(screen.getByTestId("curve-point-1"));
    expect(screen.getByTestId("curve-readout")).toHaveTextContent(
      "3,200 counts/s → 1.85x"
    );
  });

  it("renders the ghost curve only when provided", () => {
    renderEditor([{ speed: 0, factor: 1000 }], {
      ghostPairs: [{ speed: 0, factor: 1200 }],
    });
    expect(screen.getByTestId("curve-ghost")).toBeInTheDocument();
  });

  it("renders no ghost curve without ghostPairs", () => {
    renderEditor([{ speed: 0, factor: 1000 }]);
    expect(screen.queryByTestId("curve-ghost")).not.toBeInTheDocument();
  });
});
