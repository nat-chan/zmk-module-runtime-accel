/**
 * Curve model helpers shared by the editor UI and its tests.
 *
 * The firmware exchanges curves as an interleaved control-point list
 * [s0, f0, s1, f1, ...] (speed in counts/sec, factor in permille;
 * 1000 = 1.0x) - see proto/nat-chan/runtime-accel/runtime_accel.proto.
 */

export interface CurvePoint {
  speed: number;
  factor: number;
}

export const FACTOR_MIN = 100;
export const FACTOR_MAX = 20000;
/** Firmware clamps speeds to ACCEL_SPEED_MAX; also keeps wire values inside sint32. */
export const SPEED_MAX = 1000000;
export const MAX_POINTS = 8;

/** Clamp a control point to the firmware's accepted domain. */
export function clampPoint(p: CurvePoint): CurvePoint {
  return {
    speed: Math.min(SPEED_MAX, Math.max(0, Math.round(p.speed) || 0)),
    factor: Math.min(
      FACTOR_MAX,
      Math.max(FACTOR_MIN, Math.round(p.factor) || FACTOR_MIN)
    ),
  };
}

export function toPairs(points: number[]): CurvePoint[] {
  const pairs: CurvePoint[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) {
    pairs.push({ speed: points[i], factor: points[i + 1] });
  }
  return pairs;
}

export function toInterleaved(pairs: CurvePoint[]): number[] {
  return pairs.flatMap((p) => {
    const cl = clampPoint(p);
    return [cl.speed, cl.factor];
  });
}

/* ------------------------------------------------------------------ */
/* Axis tick helpers (1-2-5 "nice numbers", d3-array variant)          */
/* ------------------------------------------------------------------ */

const e10 = Math.sqrt(50);
const e5 = Math.sqrt(10);
const e2 = Math.sqrt(2);

/**
 * d3-array's tickIncrement: the nice (1-2-5 mantissa) step for about
 * `count` ticks over [start, stop]. Returns a positive increment when the
 * step is >= 1, or a negative integer -inv meaning "step of 1/inv" so
 * fractional ticks stay exact (compute tick i as i / inv).
 */
export function tickIncrement(
  start: number,
  stop: number,
  count: number
): number {
  const step = (stop - start) / Math.max(1, count);
  const power = Math.floor(Math.log10(step));
  const error = step / Math.pow(10, power);
  const factor = error >= e10 ? 10 : error >= e5 ? 5 : error >= e2 ? 2 : 1;
  return power >= 0
    ? factor * Math.pow(10, power)
    : -Math.pow(10, -power) / factor;
}

/**
 * d3-array's ticks: ~`count` human-readable round values inside
 * [start, stop] (start < stop), stepping by a 1-2-5 nice increment.
 */
export function ticks(start: number, stop: number, count: number): number[] {
  if (!(stop > start) || !(count > 0)) return [];
  const inc = tickIncrement(start, stop, count);
  const out: number[] = [];
  if (inc > 0) {
    const i1 = Math.ceil(start / inc);
    const i2 = Math.floor(stop / inc);
    for (let i = i1; i <= i2; i++) out.push(i * inc);
  } else {
    const inv = -inc;
    const i1 = Math.ceil(start * inv);
    const i2 = Math.floor(stop * inv);
    for (let i = i1; i <= i2; i++) out.push(i / inv);
  }
  return out;
}

/** Heckbert's "nice number" ceiling: the smallest 1/2/5 x 10^n >= x. */
export function niceCeil(x: number): number {
  if (!(x > 0)) return 0;
  const power = Math.floor(Math.log10(x));
  const f = x / Math.pow(10, power);
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * Math.pow(10, power);
}

/**
 * How many minor subdivisions fit inside one major tick interval of
 * `majorSpacingPx` pixels while keeping minor lines at least `minPx`
 * apart: 5, else 2, else 1 (no minors).
 */
export function minorSubdivision(majorSpacingPx: number, minPx = 12): number {
  if (majorSpacingPx / 5 > minPx) return 5;
  if (majorSpacingPx / 2 > minPx) return 2;
  return 1;
}

/* ------------------------------------------------------------------ */
/* Curve geometry helpers                                              */
/* ------------------------------------------------------------------ */

/**
 * Factor at `speed` on the piecewise-linear curve, mirroring the
 * firmware's interpolation: flat extension below the first and above the
 * last control point.
 */
export function curveFactorAt(pairs: CurvePoint[], speed: number): number {
  if (pairs.length === 0) return 1000;
  const sorted = pairs.slice().sort((a, b) => a.speed - b.speed);
  if (speed <= sorted[0].speed) return sorted[0].factor;
  const last = sorted[sorted.length - 1];
  if (speed >= last.speed) return last.factor;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (speed <= b.speed) {
      if (b.speed === a.speed) return b.factor;
      const t = (speed - a.speed) / (b.speed - a.speed);
      return a.factor + t * (b.factor - a.factor);
    }
  }
  return last.factor;
}

/** Index at which a point with `speed` should be inserted to keep the
 * list sorted by speed (after existing points with the same speed). */
export function insertIndexBySpeed(pairs: CurvePoint[], speed: number): number {
  let i = 0;
  while (i < pairs.length && pairs[i].speed <= speed) i++;
  return i;
}

/**
 * A new control point at the midpoint of the largest speed gap between
 * consecutive points, with the factor sampled on the existing curve (so
 * adding it does not change the curve's shape). Null when there are
 * fewer than two points or no usable gap.
 */
export function largestGapPoint(pairs: CurvePoint[]): CurvePoint | null {
  if (pairs.length < 2) return null;
  const sorted = pairs.slice().sort((a, b) => a.speed - b.speed);
  let bestGap = 0;
  let bestMid = 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].speed - sorted[i - 1].speed;
    if (gap > bestGap) {
      bestGap = gap;
      bestMid = (sorted[i].speed + sorted[i - 1].speed) / 2;
    }
  }
  if (bestGap < 2) return null;
  const speed = Math.round(bestMid);
  return { speed, factor: Math.round(curveFactorAt(pairs, speed)) };
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

/** Abbreviated speed tick label: 6000 -> "6k", 1500 -> "1.5k", 500 -> "500". */
export function formatSpeedTick(speed: number): string {
  if (Math.abs(speed) >= 1000) {
    return `${Number((speed / 1000).toFixed(2))}k`;
  }
  return `${speed}`;
}

/** Factor tick/readout label in "x" units: 1000‰ -> "1x", 1850 -> "1.85x". */
export function formatFactorX(factor: number): string {
  return `${Number((factor / 1000).toFixed(2))}x`;
}

/** Live readout for a control point: "3,200 counts/s → 1.85x". */
export function formatReadout(p: CurvePoint): string {
  return `${p.speed.toLocaleString("en-US")} counts/s → ${formatFactorX(p.factor)}`;
}
