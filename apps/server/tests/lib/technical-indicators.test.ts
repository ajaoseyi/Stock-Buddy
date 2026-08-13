/**
 * =============================================================================
 * tests/lib/technical-indicators.test.ts
 * =============================================================================
 *
 * Hand-computed fixtures for every indicator, chosen with round numbers so
 * the expected values can be verified by hand rather than trusted from the
 * implementation itself — the same discipline `tests/lib/stats.test.ts`
 * already applies to `robustZScore`.
 */

import { describe, expect, it } from "vitest";
import {
  atr,
  bollingerBands,
  clusterLevels,
  detectSwingPoints,
  ema,
  macd,
  rsi,
  rsiFromAverages,
  sma,
  type SwingPoint,
} from "../../src/lib/technical-indicators.js";

describe("sma", () => {
  it("is null before the period is satisfied, then the trailing average", () => {
    const result = sma([1, 2, 3, 4, 5], 3);
    expect(result).toEqual([null, null, 2, 3, 4]);
  });
});

describe("ema", () => {
  it("seeds with the simple average, then applies the smoothing multiplier", () => {
    // period=3 -> multiplier = 2/4 = 0.5. Seed = mean(1,2,3) = 2.
    // Next: 4*0.5 + 2*0.5 = 3. Then: 5*0.5 + 3*0.5 = 4.
    const result = ema([1, 2, 3, 4, 5], 3);
    expect(result[0]).toBeNull();
    expect(result[1]).toBeNull();
    expect(result[2]).toBe(2);
    expect(result[3]).toBe(3);
    expect(result[4]).toBe(4);
  });
});

describe("rsiFromAverages", () => {
  it("is 100 when there is no loss at all", () => {
    expect(rsiFromAverages(1, 0)).toBe(100);
  });

  it("is 50 when there is neither gain nor loss", () => {
    expect(rsiFromAverages(0, 0)).toBe(50);
  });

  it("is 0 when there is no gain at all", () => {
    expect(rsiFromAverages(0, 1)).toBe(0);
  });
});

describe("rsi", () => {
  it("is 100 throughout once a period is satisfied for an all-gains series", () => {
    const result = rsi([1, 2, 3, 4, 5, 6], 3);
    expect(result[3]).toBe(100);
    expect(result[4]).toBe(100);
    expect(result[5]).toBe(100);
  });

  it("is 0 throughout once a period is satisfied for an all-losses series", () => {
    const result = rsi([6, 5, 4, 3, 2, 1], 3);
    expect(result[3]).toBe(0);
    expect(result[4]).toBe(0);
    expect(result[5]).toBe(0);
  });

  it("hand-computed mixed gain/loss case (period=2)", () => {
    // changes: +2, -1, +2
    // seed (i=1,2): avgGain=(2+0)/2=1, avgLoss=(0+1)/2=0.5 -> rs=2 -> rsi=100-100/3=66.667
    // i=3: avgGain=(1*1+2)/2=1.5, avgLoss=(0.5*1+0)/2=0.25 -> rs=6 -> rsi=100-100/7=85.714
    const result = rsi([10, 12, 11, 13], 2);
    expect(result[2]).toBeCloseTo(66.667, 2);
    expect(result[3]).toBeCloseTo(85.714, 2);
  });

  it("is null before the seeding window is satisfied", () => {
    const result = rsi([1, 2], 3);
    expect(result).toEqual([null, null]);
  });
});

describe("macd", () => {
  it("macdLine equals fastEma - slowEma at every index, elementwise", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const fastEma = ema(values, 3);
    const slowEma = ema(values, 5);
    const { macdLine } = macd(values, 3, 5, 2);

    for (let i = 0; i < values.length; i++) {
      if (fastEma[i] === null || slowEma[i] === null) {
        expect(macdLine[i]).toBeNull();
      } else {
        expect(macdLine[i]).toBeCloseTo(fastEma[i]! - slowEma[i]!, 10);
      }
    }
  });

  it("signal line and histogram start only once macdLine has enough points to seed its own EMA", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const { macdLine, signalLine, histogram } = macd(values, 3, 5, 2);

    // macdLine first valid at slowPeriod-1 = 4. signalLine needs signalPeriod=2
    // more points of macdLine, so first valid at index 4 + (2-1) = 5.
    const firstMacd = macdLine.findIndex((v) => v !== null);
    const firstSignal = signalLine.findIndex((v) => v !== null);
    expect(firstMacd).toBe(4);
    expect(firstSignal).toBe(5);
    expect(histogram[firstSignal]).toBeCloseTo(macdLine[firstSignal]! - signalLine[firstSignal]!, 10);
    expect(histogram[firstSignal - 1]).toBeNull();
  });
});

describe("atr", () => {
  it("hand-computed 4-bar Wilder ATR (period=3)", () => {
    const bars = [
      { high: 10, low: 8, close: 9 }, // TR0 = 10-8 = 2
      { high: 11, low: 9, close: 10 }, // TR1 = max(2, |11-9|=2, |9-9|=0) = 2
      { high: 12, low: 10, close: 11 }, // TR2 = max(2, |12-10|=2, |10-10|=0) = 2
      { high: 9, low: 7, close: 8 }, // TR3 = max(2, |9-11|=2, |7-11|=4) = 4
    ];
    const result = atr(bars, 3);
    // seed = mean(2,2,2) = 2
    expect(result[2]).toBe(2);
    // Wilder smoothing: (2*2 + 4) / 3 = 8/3
    expect(result[3]).toBeCloseTo(8 / 3, 10);
  });

  it("is null before the period is satisfied", () => {
    const bars = [{ high: 10, low: 8, close: 9 }];
    expect(atr(bars, 3)).toEqual([null]);
  });
});

describe("bollingerBands", () => {
  it("hand-computed 3-value window", () => {
    // mean = 2; variance = ((1-2)^2+(2-2)^2+(3-2)^2)/3 = 2/3; sd = sqrt(2/3) ≈ 0.8165
    const { middle, upper, lower } = bollingerBands([1, 2, 3], 3, 2);
    expect(middle[2]).toBe(2);
    expect(upper[2]).toBeCloseTo(2 + 2 * Math.sqrt(2 / 3), 10);
    expect(lower[2]).toBeCloseTo(2 - 2 * Math.sqrt(2 / 3), 10);
  });
});

describe("detectSwingPoints", () => {
  it("finds a fractal zigzag with lookback=1", () => {
    const bars = [
      { date: new Date("2026-01-01"), high: 10, low: 9 },
      { date: new Date("2026-01-02"), high: 12, low: 11 }, // swing high
      { date: new Date("2026-01-03"), high: 9, low: 8 }, // swing low
      { date: new Date("2026-01-04"), high: 13, low: 12 }, // swing high
      { date: new Date("2026-01-05"), high: 8, low: 7 },
    ];

    const points = detectSwingPoints(bars, 1);
    expect(points).toEqual([
      { index: 1, price: 12, date: bars[1]!.date, kind: "swing_high" },
      { index: 2, price: 8, date: bars[2]!.date, kind: "swing_low" },
      { index: 3, price: 13, date: bars[3]!.date, kind: "swing_high" },
    ]);
  });

  it("produces no points when there is no room for a lookback window on either side", () => {
    const bars = [
      { date: new Date(), high: 10, low: 9 },
      { date: new Date(), high: 11, low: 10 },
    ];
    expect(detectSwingPoints(bars, 2)).toEqual([]);
  });
});

describe("clusterLevels", () => {
  it("merges points within tolerance, keeps distant ones separate", () => {
    const points: SwingPoint[] = [
      { index: 0, price: 100, date: new Date(), kind: "swing_low" },
      { index: 1, price: 101, date: new Date(), kind: "swing_low" },
      { index: 2, price: 150, date: new Date(), kind: "swing_high" },
    ];

    const levels = clusterLevels(points, 2);
    expect(levels).toEqual([
      { price: 100.5, touches: 2 },
      { price: 150, touches: 1 },
    ]);
  });

  it("returns an empty array for no input points", () => {
    expect(clusterLevels([], 1)).toEqual([]);
  });
});
