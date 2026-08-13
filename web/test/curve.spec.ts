import {
  FACTOR_MAX,
  FACTOR_MIN,
  MAX_POINTS,
  SPEED_MAX,
  clampPoint,
  curveFactorAt,
  formatFactorX,
  formatReadout,
  formatSpeedTick,
  insertIndexBySpeed,
  largestGapPoint,
  minorSubdivision,
  niceCeil,
  tickIncrement,
  ticks,
  toInterleaved,
  toPairs,
} from "../src/curve";

describe("accelCurve", () => {
  describe("toPairs", () => {
    it("should decode an interleaved list into speed/factor pairs", () => {
      expect(toPairs([0, 1000, 1000, 3000])).toEqual([
        { speed: 0, factor: 1000 },
        { speed: 1000, factor: 3000 },
      ]);
    });

    it("should return an empty list for an empty input", () => {
      expect(toPairs([])).toEqual([]);
    });

    it("should ignore a trailing odd element", () => {
      expect(toPairs([0, 1000, 500])).toEqual([{ speed: 0, factor: 1000 }]);
    });
  });

  describe("toInterleaved", () => {
    it("should encode pairs back into the interleaved wire format", () => {
      expect(
        toInterleaved([
          { speed: 0, factor: 1000 },
          { speed: 2000, factor: 3500 },
        ])
      ).toEqual([0, 1000, 2000, 3500]);
    });

    it("should round-trip with toPairs", () => {
      const points = [0, 1000, 500, 1500, 3000, 20000];
      expect(toInterleaved(toPairs(points))).toEqual(points);
    });
  });

  describe("constants", () => {
    it("should match the firmware's limits", () => {
      expect(FACTOR_MIN).toBe(100);
      expect(FACTOR_MAX).toBe(20000);
      expect(MAX_POINTS).toBe(8);
    });
  });
});

describe("clampPoint / encode clamping (int32 overflow regression)", () => {
  it("clamps runaway speed values to SPEED_MAX before encoding", () => {
    // Regression: axis auto-scale let dragged speeds grow past int32
    // (e.g. 8711941592973) and the protobuf encoder threw "invalid int32".
    const points = toInterleaved([{ speed: 8711941592973, factor: 1000 }]);
    expect(points).toEqual([SPEED_MAX, 1000]);
  });

  it("clamps factors into the firmware range", () => {
    expect(clampPoint({ speed: -5, factor: 999999 })).toEqual({
      speed: 0,
      factor: FACTOR_MAX,
    });
    expect(clampPoint({ speed: 100.7, factor: 1 })).toEqual({
      speed: 101,
      factor: FACTOR_MIN,
    });
  });
});

describe("ticks (1-2-5 nice tick algorithm)", () => {
  it("produces round 1-2-5 values covering the range", () => {
    expect(ticks(0, 6000, 4)).toEqual([0, 2000, 4000, 6000]);
    expect(ticks(0, 2000, 5)).toEqual([0, 500, 1000, 1500, 2000]);
    expect(ticks(0, 10000, 5)).toEqual([0, 2000, 4000, 6000, 8000, 10000]);
    expect(ticks(0, 1000000, 4)).toEqual([
      0, 200000, 400000, 600000, 800000, 1000000,
    ]);
  });

  it("keeps fractional steps exact via the integer-reciprocal branch", () => {
    expect(ticks(0, 1, 5)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(ticks(0, 0.5, 5)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5]);
  });

  it("returns [] for empty or inverted ranges", () => {
    expect(ticks(0, 0, 5)).toEqual([]);
    expect(ticks(5, 0, 5)).toEqual([]);
    expect(ticks(0, 10, 0)).toEqual([]);
  });

  it("tickIncrement picks the 1-2-5 mantissa by the d3 thresholds", () => {
    expect(tickIncrement(0, 1000, 10)).toBe(100); // err 1 -> factor 1
    expect(tickIncrement(0, 6000, 4)).toBe(2000); // err 1.5 >= sqrt(2)
    expect(tickIncrement(0, 2000, 5)).toBe(500); // err 4 >= sqrt(10)
    expect(tickIncrement(0, 8000, 1)).toBe(10000); // err 8 >= sqrt(50)
    expect(tickIncrement(0, 1, 5)).toBe(-5); // step 0.2 -> 1/5
  });
});

describe("niceCeil (Heckbert nice number ceiling)", () => {
  it("rounds up to the nearest 1/2/5 x 10^n", () => {
    expect(niceCeil(1)).toBe(1);
    expect(niceCeil(1.2)).toBe(2);
    expect(niceCeil(3000)).toBe(5000);
    expect(niceCeil(5000)).toBe(5000);
    expect(niceCeil(5001)).toBe(10000);
    expect(niceCeil(6500)).toBe(10000);
    expect(niceCeil(0.3)).toBeCloseTo(0.5);
  });

  it("returns 0 for non-positive input", () => {
    expect(niceCeil(0)).toBe(0);
    expect(niceCeil(-3)).toBe(0);
  });
});

describe("minorSubdivision", () => {
  it("subdivides into 5, then 2, only while spacing stays above 12px", () => {
    expect(minorSubdivision(100)).toBe(5); // 20px per minor
    expect(minorSubdivision(45)).toBe(2); // 22.5px per minor (5 would be 9px)
    expect(minorSubdivision(20)).toBe(1); // even halves would be 10px
  });
});

describe("curveFactorAt", () => {
  const pairs = [
    { speed: 1000, factor: 1000 },
    { speed: 3000, factor: 3000 },
  ];

  it("interpolates linearly between control points", () => {
    expect(curveFactorAt(pairs, 2000)).toBe(2000);
    expect(curveFactorAt(pairs, 1500)).toBe(1500);
  });

  it("extends flat beyond the first and last point (firmware behavior)", () => {
    expect(curveFactorAt(pairs, 0)).toBe(1000);
    expect(curveFactorAt(pairs, 999999)).toBe(3000);
  });

  it("handles unsorted input and duplicate speeds", () => {
    expect(curveFactorAt([pairs[1], pairs[0]], 2000)).toBe(2000);
    expect(
      curveFactorAt(
        [
          { speed: 100, factor: 500 },
          { speed: 100, factor: 900 },
        ],
        100
      )
    ).toBe(500);
  });
});

describe("insertIndexBySpeed", () => {
  const pairs = [
    { speed: 0, factor: 1000 },
    { speed: 2000, factor: 1500 },
  ];

  it("keeps the list sorted by speed", () => {
    expect(insertIndexBySpeed(pairs, 1000)).toBe(1);
    expect(insertIndexBySpeed(pairs, 3000)).toBe(2);
    expect(insertIndexBySpeed(pairs, 0)).toBe(1); // after equal speeds
    expect(insertIndexBySpeed([], 500)).toBe(0);
  });
});

describe("largestGapPoint", () => {
  it("returns the midpoint of the largest speed gap, on the curve", () => {
    expect(
      largestGapPoint([
        { speed: 0, factor: 1000 },
        { speed: 1000, factor: 2000 },
        { speed: 5000, factor: 4000 },
      ])
    ).toEqual({ speed: 3000, factor: 3000 });
  });

  it("returns null when there is no usable gap", () => {
    expect(largestGapPoint([{ speed: 0, factor: 1000 }])).toBeNull();
    expect(
      largestGapPoint([
        { speed: 100, factor: 1000 },
        { speed: 100, factor: 2000 },
      ])
    ).toBeNull();
  });
});

describe("tick/readout formatting", () => {
  it("abbreviates speed ticks", () => {
    expect(formatSpeedTick(0)).toBe("0");
    expect(formatSpeedTick(500)).toBe("500");
    expect(formatSpeedTick(1500)).toBe("1.5k");
    expect(formatSpeedTick(6000)).toBe("6k");
    expect(formatSpeedTick(1000000)).toBe("1000k");
  });

  it("formats factors in x units, not permille", () => {
    expect(formatFactorX(1000)).toBe("1x");
    expect(formatFactorX(1500)).toBe("1.5x");
    expect(formatFactorX(1850)).toBe("1.85x");
    expect(formatFactorX(500)).toBe("0.5x");
  });

  it("formats the live readout", () => {
    expect(formatReadout({ speed: 3200, factor: 1850 })).toBe(
      "3,200 counts/s → 1.85x"
    );
  });
});
