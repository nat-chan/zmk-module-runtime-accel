import { useMemo, useRef, useState } from "react";
import {
  type CurvePoint,
  FACTOR_MIN,
  FACTOR_MAX,
  SPEED_MAX,
  MAX_POINTS,
  ticks,
  niceCeil,
  minorSubdivision,
  curveFactorAt,
  insertIndexBySpeed,
  formatSpeedTick,
  formatFactorX,
  formatReadout,
} from "./curve";

/**
 * SVG editor for a piecewise-linear acceleration curve: one circle per
 * control point, draggable (with pointer capture and a frozen axis domain
 * while dragging); click the line to insert a point; double-click or press
 * Delete to remove one; arrow keys nudge a focused point.
 */

const VIEW_W = 400;
const VIEW_H = 220;
const MARGIN = { left: 44, right: 12, top: 12, bottom: 26 };
const PLOT_W = VIEW_W - MARGIN.left - MARGIN.right;
const PLOT_H = VIEW_H - MARGIN.top - MARGIN.bottom;
/** Target tick densities (human-readable, not per-pixel). */
const X_MAJOR_TARGET = Math.max(2, Math.round(PLOT_W / 80));
const Y_MAJOR_TARGET = Math.max(2, Math.round(PLOT_H / 35));

/** Grid/label opacities on currentColor: hierarchy stays recessive,
 * below the data in visual weight. */
const OPACITY = {
  minor: 0.07,
  major: 0.2,
  baseline: 0.38,
  axis: 0.45,
  label: 0.65,
};

interface Domain {
  speedMax: number;
  factorMax: number;
}

interface DragState {
  index: number;
  pointerId: number | null;
  /** Neighbor speeds: the dragged point may not cross them. */
  minSpeed: number;
  maxSpeed: number;
  /** Fine-drag accumulator (unrounded working value). */
  value: { speed: number; factor: number };
  lastRaw: { speed: number; factor: number } | null;
}

function fitDomain(pairs: CurvePoint[]): Domain {
  const maxSpeed = Math.max(0, ...pairs.map((p) => p.speed));
  const maxFactor = Math.max(0, ...pairs.map((p) => p.factor));
  // Fit to the data with nice (1-2-5) ceilings — never to the firmware's
  // 1e6 cap, which squashed typical 0..6000 curves into the left edge.
  return {
    speedMax: Math.min(SPEED_MAX, Math.max(6000, niceCeil(maxSpeed))),
    factorMax: Math.min(FACTOR_MAX, Math.max(2000, niceCeil(maxFactor))),
  };
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

export function CurveSvg({
  pairs,
  onChange,
  ghostPairs,
}: {
  pairs: CurvePoint[];
  onChange: (pairs: CurvePoint[]) => void;
  /** Last applied/loaded curve, rendered dimmed+dashed behind the edit. */
  ghostPairs?: CurvePoint[] | null;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  // Axis domain frozen on pointer-down, released on pointer-up: the axes
  // never rescale mid-drag (the old 15%/frame autoscale feedback loop).
  const [frozenDomain, setFrozenDomain] = useState<Domain | null>(null);

  const fitted = useMemo(() => fitDomain(pairs), [pairs]);
  const domain = frozenDomain ?? fitted;
  const { speedMax, factorMax } = domain;

  const toX = (speed: number) =>
    MARGIN.left + clamp(speed / speedMax, 0, 1) * PLOT_W;
  const toY = (factor: number) =>
    MARGIN.top + PLOT_H - clamp(factor / factorMax, 0, 1) * PLOT_H;

  /** Client coords -> curve values in the current (possibly frozen) domain.
   * Clamped to the firmware's bounds, not the plot: dragging past the plot
   * edge keeps growing the value linearly, and the domain refits on
   * release. */
  const fromClient = (clientX: number, clientY: number): CurvePoint | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = ((clientX - rect.left) / rect.width) * VIEW_W;
    const y = ((clientY - rect.top) / rect.height) * VIEW_H;
    const speed = ((x - MARGIN.left) / PLOT_W) * speedMax;
    const factor = ((MARGIN.top + PLOT_H - y) / PLOT_H) * factorMax;
    return {
      speed: clamp(speed, 0, SPEED_MAX),
      factor: clamp(factor, FACTOR_MIN, FACTOR_MAX),
    };
  };

  /** Speeds of the sorted neighbors of `index` — the drag bounds. */
  const neighborBounds = (list: CurvePoint[], index: number) => {
    const order = list
      .map((_, i) => i)
      .sort((a, b) => list[a].speed - list[b].speed);
    const rank = order.indexOf(index);
    return {
      minSpeed: rank > 0 ? list[order[rank - 1]].speed : 0,
      maxSpeed:
        rank < order.length - 1 ? list[order[rank + 1]].speed : SPEED_MAX,
    };
  };

  const capturePointer = (pointerId: number) => {
    try {
      svgRef.current?.setPointerCapture(pointerId);
    } catch {
      // jsdom / older browsers: dragging still works while over the SVG.
    }
  };

  const startDrag = (
    index: number,
    e: React.PointerEvent,
    list: CurvePoint[]
  ) => {
    const { minSpeed, maxSpeed } = neighborBounds(list, index);
    dragRef.current = {
      index,
      pointerId: e.pointerId ?? null,
      minSpeed,
      maxSpeed,
      value: { ...list[index] },
      // Deltas are measured from the grab position, so grabbing a point
      // off-center (inside the fat hit circle) does not make it jump.
      lastRaw: fromClient(e.clientX, e.clientY),
    };
    setDragIndex(index);
    setFrozenDomain(fitDomain(list));
    if (e.pointerId !== undefined && e.pointerId !== null) {
      capturePointer(e.pointerId);
    }
  };

  const moveDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const raw = fromClient(e.clientX, e.clientY);
    if (!raw) return;
    const prev = d.lastRaw ?? raw;
    // Shift = fine adjustment: apply pointer deltas at 1/10 scale.
    const scale = e.shiftKey ? 0.1 : 1;
    d.value = {
      speed: clamp(
        d.value.speed + (raw.speed - prev.speed) * scale,
        d.minSpeed,
        d.maxSpeed
      ),
      factor: clamp(
        d.value.factor + (raw.factor - prev.factor) * scale,
        FACTOR_MIN,
        FACTOR_MAX
      ),
    };
    d.lastRaw = raw;
    const next = pairs.slice();
    next[d.index] = {
      speed: Math.round(d.value.speed),
      factor: Math.round(d.value.factor),
    };
    onChange(next);
  };

  const endDrag = () => {
    const d = dragRef.current;
    if (!d) return;
    if (d.pointerId !== null) {
      try {
        svgRef.current?.releasePointerCapture(d.pointerId);
      } catch {
        // ignore (see capturePointer)
      }
    }
    dragRef.current = null;
    setDragIndex(null);
    setFrozenDomain(null);
  };

  /** Click on the line inserts a point there (snapped onto the curve) and
   * immediately starts dragging it. */
  const addPointOnLine = (e: React.PointerEvent) => {
    if (pairs.length >= MAX_POINTS) return;
    const raw = fromClient(e.clientX, e.clientY);
    if (!raw) return;
    const speed = Math.round(clamp(raw.speed, 0, speedMax));
    const factor = Math.round(
      clamp(curveFactorAt(pairs, speed), FACTOR_MIN, FACTOR_MAX)
    );
    const index = insertIndexBySpeed(pairs, speed);
    const next = [
      ...pairs.slice(0, index),
      { speed, factor },
      ...pairs.slice(index),
    ];
    onChange(next);
    startDrag(index, e, next);
  };

  const removePoint = (index: number) => {
    if (pairs.length > 1) onChange(pairs.filter((_, i) => i !== index));
  };

  const nudgePoint = (index: number, e: React.KeyboardEvent) => {
    const stepX = Math.max(1, Math.round(speedMax * 0.01));
    const stepY = 10;
    const mult = e.shiftKey ? 10 : 1;
    let dSpeed = 0;
    let dFactor = 0;
    switch (e.key) {
      case "ArrowLeft":
        dSpeed = -stepX * mult;
        break;
      case "ArrowRight":
        dSpeed = stepX * mult;
        break;
      case "ArrowUp":
        dFactor = stepY * mult;
        break;
      case "ArrowDown":
        dFactor = -stepY * mult;
        break;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        removePoint(index);
        return;
      default:
        return;
    }
    e.preventDefault();
    const { minSpeed, maxSpeed } = neighborBounds(pairs, index);
    const p = pairs[index];
    const next = pairs.slice();
    next[index] = {
      speed: Math.round(clamp(p.speed + dSpeed, minSpeed, maxSpeed)),
      factor: Math.round(clamp(p.factor + dFactor, FACTOR_MIN, FACTOR_MAX)),
    };
    onChange(next);
  };

  /* ---- Gridlines (1-2-5 ticks; solid hairlines only) ---- */
  const xMajors = ticks(0, speedMax, X_MAJOR_TARGET);
  const yMajors = ticks(0, factorMax, Y_MAJOR_TARGET);
  const xInc = xMajors.length > 1 ? xMajors[1] - xMajors[0] : speedMax;
  const yInc = yMajors.length > 1 ? yMajors[1] - yMajors[0] : factorMax;
  const xSub = minorSubdivision((xInc / speedMax) * PLOT_W);
  const ySub = minorSubdivision((yInc / factorMax) * PLOT_H);
  const xMinors: number[] = [];
  if (xSub > 1) {
    for (let i = 1; (i * xInc) / xSub <= speedMax; i++) {
      if (i % xSub !== 0) xMinors.push((i * xInc) / xSub);
    }
  }
  const yMinors: number[] = [];
  if (ySub > 1) {
    for (let i = 1; (i * yInc) / ySub <= factorMax; i++) {
      if (i % ySub !== 0) yMinors.push((i * yInc) / ySub);
    }
  }

  /* ---- Curve paths ---- */
  // Order of model indices sorted by speed; the model itself stays in the
  // caller's order (kept sorted by the editor's own interactions).
  const order = pairs
    .map((_, i) => i)
    .sort((a, b) => pairs[a].speed - pairs[b].speed);
  const sorted = order.map((i) => pairs[i]);
  const authoredPoints = sorted
    .map((p) => `${toX(p.speed)},${toY(p.factor)}`)
    .join(" ");
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  // Fat invisible twin polyline (authored + tails) for click-to-add.
  const hitPoints =
    sorted.length > 0
      ? [
          `${MARGIN.left},${toY(first.factor)}`,
          authoredPoints,
          `${MARGIN.left + PLOT_W},${toY(last.factor)}`,
        ].join(" ")
      : "";
  const ghostSorted = (ghostPairs ?? [])
    .slice()
    .sort((a, b) => a.speed - b.speed);
  const ghostPoints =
    ghostSorted.length > 0
      ? [
          `${MARGIN.left},${toY(ghostSorted[0].factor)}`,
          ...ghostSorted.map((p) => `${toX(p.speed)},${toY(p.factor)}`),
          `${MARGIN.left + PLOT_W},${toY(ghostSorted[ghostSorted.length - 1].factor)}`,
        ].join(" ")
      : "";

  const activeIndex = dragIndex ?? hoverIndex;
  const readout =
    activeIndex !== null && pairs[activeIndex]
      ? formatReadout(pairs[activeIndex])
      : null;

  return (
    <svg
      ref={svgRef}
      className="curve-svg"
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      role="img"
      aria-label="Acceleration curve"
      data-testid="curve-svg"
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {/* Minor gridlines (dimmest, solid hairlines) */}
      {xMinors.map((v) => (
        <line
          key={`xm${v}`}
          x1={toX(v)}
          y1={MARGIN.top}
          x2={toX(v)}
          y2={MARGIN.top + PLOT_H}
          stroke="currentColor"
          strokeOpacity={OPACITY.minor}
          strokeWidth={1}
        />
      ))}
      {yMinors.map((v) => (
        <line
          key={`ym${v}`}
          x1={MARGIN.left}
          y1={toY(v)}
          x2={MARGIN.left + PLOT_W}
          y2={toY(v)}
          stroke="currentColor"
          strokeOpacity={OPACITY.minor}
          strokeWidth={1}
        />
      ))}
      {/* Major gridlines */}
      {xMajors.map((v) => (
        <line
          key={`xM${v}`}
          x1={toX(v)}
          y1={MARGIN.top}
          x2={toX(v)}
          y2={MARGIN.top + PLOT_H}
          stroke="currentColor"
          strokeOpacity={OPACITY.major}
          strokeWidth={1}
        />
      ))}
      {yMajors.map((v) => (
        <line
          key={`yM${v}`}
          x1={MARGIN.left}
          y1={toY(v)}
          x2={MARGIN.left + PLOT_W}
          y2={toY(v)}
          stroke="currentColor"
          strokeOpacity={OPACITY.major}
          strokeWidth={1}
        />
      ))}
      {/* Emphasized y = 1.0x baseline (solid, full width) */}
      {factorMax >= 1000 && (
        <line
          x1={MARGIN.left}
          y1={toY(1000)}
          x2={MARGIN.left + PLOT_W}
          y2={toY(1000)}
          stroke="currentColor"
          strokeOpacity={OPACITY.baseline}
          strokeWidth={1}
        />
      )}
      {/* Axes */}
      <line
        x1={MARGIN.left}
        y1={MARGIN.top}
        x2={MARGIN.left}
        y2={MARGIN.top + PLOT_H}
        stroke="currentColor"
        strokeOpacity={OPACITY.axis}
        strokeWidth={1}
      />
      <line
        x1={MARGIN.left}
        y1={MARGIN.top + PLOT_H}
        x2={MARGIN.left + PLOT_W}
        y2={MARGIN.top + PLOT_H}
        stroke="currentColor"
        strokeOpacity={OPACITY.axis}
        strokeWidth={1}
      />
      {/* Tick labels: majors only, abbreviated, tabular numerals */}
      {xMajors.map((v) => (
        <text
          key={`xl${v}`}
          x={toX(v)}
          y={MARGIN.top + PLOT_H + 12}
          textAnchor="middle"
          fontSize={9}
          fill="currentColor"
          fillOpacity={OPACITY.label}
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {formatSpeedTick(v)}
        </text>
      ))}
      {yMajors
        .filter((v) => v > 0)
        .map((v) => (
          <text
            key={`yl${v}`}
            x={MARGIN.left - 5}
            y={toY(v) + 3}
            textAnchor="end"
            fontSize={9}
            fill="currentColor"
            fillOpacity={OPACITY.label}
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {formatFactorX(v)}
          </text>
        ))}
      {/* Axis units, stated once */}
      <text
        x={VIEW_W - MARGIN.right}
        y={VIEW_H - 3}
        textAnchor="end"
        fontSize={8}
        fill="currentColor"
        fillOpacity={0.5}
      >
        counts/s
      </text>
      <text
        x={MARGIN.left - 5}
        y={MARGIN.top + 3}
        textAnchor="end"
        fontSize={8}
        fill="currentColor"
        fillOpacity={0.5}
      >
        gain
      </text>
      {/* Ghost: last applied/loaded curve while the edit is dirty */}
      {ghostPoints && (
        <polyline
          points={ghostPoints}
          className="curve-ghost"
          data-testid="curve-ghost"
        />
      )}
      {/* Dashed extrapolation tails (firmware's flat extension) */}
      {sorted.length > 0 && (
        <>
          <polyline
            points={`${MARGIN.left},${toY(first.factor)} ${toX(first.speed)},${toY(first.factor)}`}
            className="curve-tail"
          />
          <polyline
            points={`${toX(last.speed)},${toY(last.factor)} ${MARGIN.left + PLOT_W},${toY(last.factor)}`}
            className="curve-tail"
          />
        </>
      )}
      {/* Authored curve */}
      {authoredPoints && (
        <polyline points={authoredPoints} className="curve-line" />
      )}
      {/* Fat invisible twin for click-to-add (under the point handles) */}
      {hitPoints && (
        <polyline
          points={hitPoints}
          className="curve-line-hit"
          data-testid="curve-line-hit"
          onPointerDown={(e) => {
            e.preventDefault();
            addPointOnLine(e);
          }}
        />
      )}
      {/* Control points: visible dot + invisible hit circle, focusable */}
      {order.map((index) => {
        const p = pairs[index];
        const active = index === activeIndex;
        const cx = toX(p.speed);
        const cy = toY(p.factor);
        return (
          <g
            key={index}
            role="button"
            tabIndex={0}
            aria-label={`point ${index + 1}: ${p.speed} counts/s, ${formatFactorX(p.factor)}`}
            data-testid={`curve-point-${index}`}
            className="curve-point-group"
            onPointerDown={(e) => {
              e.preventDefault();
              startDrag(index, e, pairs);
            }}
            onPointerEnter={() => setHoverIndex(index)}
            onPointerLeave={() =>
              setHoverIndex((cur) => (cur === index ? null : cur))
            }
            onFocus={() => setHoverIndex(index)}
            onBlur={() => setHoverIndex((cur) => (cur === index ? null : cur))}
            onDoubleClick={() => removePoint(index)}
            onKeyDown={(e) => nudgePoint(index, e)}
          >
            <circle cx={cx} cy={cy} r={13} fill="transparent" />
            <circle
              cx={cx}
              cy={cy}
              r={active ? 7 : 5.5}
              className="curve-point"
              strokeWidth={active ? 3 : 2}
            />
          </g>
        );
      })}
      {/* Live readout for the hovered/dragged point */}
      {readout && (
        <text
          x={MARGIN.left + PLOT_W - 4}
          y={MARGIN.top + 12}
          textAnchor="end"
          fontSize={11}
          fill="currentColor"
          fillOpacity={0.85}
          style={{ fontVariantNumeric: "tabular-nums" }}
          data-testid="curve-readout"
        >
          {readout}
        </text>
      )}
    </svg>
  );
}
