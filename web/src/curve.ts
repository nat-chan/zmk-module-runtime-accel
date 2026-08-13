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
export const MAX_POINTS = 8;

export function toPairs(points: number[]): CurvePoint[] {
  const pairs: CurvePoint[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) {
    pairs.push({ speed: points[i], factor: points[i + 1] });
  }
  return pairs;
}

export function toInterleaved(pairs: CurvePoint[]): number[] {
  return pairs.flatMap((p) => [p.speed, p.factor]);
}
