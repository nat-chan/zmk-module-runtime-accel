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
