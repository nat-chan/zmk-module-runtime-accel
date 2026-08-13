import { useMemo, useRef, useState } from "react";
import { type CurvePoint, FACTOR_MIN, FACTOR_MAX, SPEED_MAX } from "./curve";

/**
 * Minimal SVG editor for a piecewise-linear acceleration curve: one circle
 * per control point, draggable; double-click a point to remove it.
 */

const VIEW_W = 400;
const VIEW_H = 220;
const MARGIN = { left: 44, right: 12, top: 12, bottom: 26 };
const PLOT_W = VIEW_W - MARGIN.left - MARGIN.right;
const PLOT_H = VIEW_H - MARGIN.top - MARGIN.bottom;

export function CurveSvg({
  pairs,
  onChange,
}: {
  pairs: CurvePoint[];
  onChange: (pairs: CurvePoint[]) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const { speedMax, factorMax } = useMemo(() => {
    const maxSpeed = Math.max(1000, ...pairs.map((p) => p.speed));
    const maxFactor = Math.max(2000, ...pairs.map((p) => p.factor));
    // Cap auto-scale at the firmware ceiling; otherwise dragging a point to
    // the right edge grows the axis 15% per frame and the value explodes
    // past int32 (protobuf "invalid int32" on SetCurve).
    return {
      speedMax: Math.min(SPEED_MAX, maxSpeed * 1.15),
      factorMax: Math.min(FACTOR_MAX, maxFactor * 1.15),
    };
  }, [pairs]);

  const toX = (speed: number) => MARGIN.left + (speed / speedMax) * PLOT_W;
  const toY = (factor: number) =>
    MARGIN.top + PLOT_H - (factor / factorMax) * PLOT_H;

  const fromClient = (clientX: number, clientY: number): CurvePoint | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = ((clientX - rect.left) / rect.width) * VIEW_W;
    const y = ((clientY - rect.top) / rect.height) * VIEW_H;
    const speed = Math.round(((x - MARGIN.left) / PLOT_W) * speedMax);
    const factor = Math.round(((MARGIN.top + PLOT_H - y) / PLOT_H) * factorMax);
    return {
      speed: Math.min(SPEED_MAX, Math.max(0, speed)),
      factor: Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, factor)),
    };
  };

  const movePoint = (index: number, clientX: number, clientY: number) => {
    const p = fromClient(clientX, clientY);
    if (!p) return;
    const next = pairs.slice();
    next[index] = p;
    onChange(next);
  };

  // Flat extensions to the plot edges mirror the firmware's interpolation
  // (below the first point -> first factor, above the last -> last factor).
  const sorted = pairs.slice().sort((a, b) => a.speed - b.speed);
  const linePoints =
    sorted.length > 0
      ? [
          `${MARGIN.left},${toY(sorted[0].factor)}`,
          ...sorted.map((p) => `${toX(p.speed)},${toY(p.factor)}`),
          `${MARGIN.left + PLOT_W},${toY(sorted[sorted.length - 1].factor)}`,
        ].join(" ")
      : "";

  return (
    <svg
      ref={svgRef}
      className="curve-svg"
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      role="img"
      aria-label="Acceleration curve"
      data-testid="curve-svg"
      onPointerMove={(e) => {
        if (dragIndex !== null) movePoint(dragIndex, e.clientX, e.clientY);
      }}
      onPointerUp={() => setDragIndex(null)}
      onPointerLeave={() => setDragIndex(null)}
    >
      {/* Axes */}
      <line
        x1={MARGIN.left}
        y1={MARGIN.top}
        x2={MARGIN.left}
        y2={MARGIN.top + PLOT_H}
        className="curve-axis"
      />
      <line
        x1={MARGIN.left}
        y1={MARGIN.top + PLOT_H}
        x2={MARGIN.left + PLOT_W}
        y2={MARGIN.top + PLOT_H}
        className="curve-axis"
      />
      {/* 1.0x guide */}
      <line
        x1={MARGIN.left}
        y1={toY(1000)}
        x2={MARGIN.left + PLOT_W}
        y2={toY(1000)}
        className="curve-guide"
      />
      <text x={2} y={toY(1000) + 4} className="curve-label">
        1.0x
      </text>
      <text
        x={MARGIN.left + PLOT_W}
        y={VIEW_H - 8}
        textAnchor="end"
        className="curve-label"
      >
        {Math.round(speedMax)} counts/s
      </text>
      {linePoints && <polyline points={linePoints} className="curve-line" />}
      {sorted.map((p) => {
        // Map back to the index in the unsorted working list so dragging
        // moves the point the user grabbed.
        const index = pairs.indexOf(p);
        return (
          <circle
            key={`${index}`}
            cx={toX(p.speed)}
            cy={toY(p.factor)}
            r={7}
            className="curve-point"
            data-testid={`curve-point-${index}`}
            onPointerDown={(e) => {
              e.preventDefault();
              setDragIndex(index);
            }}
            onDoubleClick={() => {
              if (pairs.length > 1) {
                onChange(pairs.filter((_, i) => i !== index));
              }
            }}
          />
        );
      })}
    </svg>
  );
}
