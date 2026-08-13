/**
 * =============================================================================
 * tests/nodes/capabilities/technical-analysis/market-context.test.ts
 * =============================================================================
 */

import { describe, expect, it } from "vitest";
import type { IndicatorSnapshot } from "../../../../src/state.js";
import type { PriceBar } from "../../../../src/tools/yahoo-finance.js";
import {
  computeMomentumDirection,
  computeTrendDirection,
  computeVolatilityLevel,
} from "../../../../src/nodes/capabilities/technical-analysis/market-context.js";

function snapshot(overrides: Partial<IndicatorSnapshot> = {}): IndicatorSnapshot {
  return {
    sma20: null,
    sma50: null,
    sma200: null,
    ema12: null,
    ema26: null,
    rsi14: null,
    macd: { macdLine: null, signalLine: null, histogram: null },
    atr14: null,
    bollinger: { middle: null, upper: null, lower: null },
    latestClose: null,
    asOfDate: null,
    ...overrides,
  };
}

describe("computeTrendDirection", () => {
  it("close > sma50 > sma200 -> uptrend", () => {
    expect(computeTrendDirection(snapshot({ latestClose: 110, sma50: 105, sma200: 100 }))).toBe(
      "uptrend",
    );
  });

  it("close < sma50 < sma200 -> downtrend", () => {
    expect(computeTrendDirection(snapshot({ latestClose: 90, sma50: 95, sma200: 100 }))).toBe(
      "downtrend",
    );
  });

  it("a crossed/tangled ordering -> sideways", () => {
    expect(computeTrendDirection(snapshot({ latestClose: 100, sma50: 110, sma200: 90 }))).toBe(
      "sideways",
    );
  });

  it("any of the three missing -> insufficient_data", () => {
    expect(computeTrendDirection(snapshot({ latestClose: 100, sma50: 90 }))).toBe(
      "insufficient_data",
    );
    expect(computeTrendDirection(snapshot({ sma50: 90, sma200: 80 }))).toBe("insufficient_data");
  });
});

describe("computeMomentumDirection", () => {
  it("rsi14 at or above 70 -> overbought", () => {
    expect(computeMomentumDirection(snapshot({ rsi14: 70 }))).toBe("overbought");
    expect(computeMomentumDirection(snapshot({ rsi14: 85 }))).toBe("overbought");
  });

  it("rsi14 at or below 30 -> oversold", () => {
    expect(computeMomentumDirection(snapshot({ rsi14: 30 }))).toBe("oversold");
    expect(computeMomentumDirection(snapshot({ rsi14: 10 }))).toBe("oversold");
  });

  it("rsi14 strictly between the thresholds -> neutral", () => {
    expect(computeMomentumDirection(snapshot({ rsi14: 50 }))).toBe("neutral");
  });

  it("missing rsi14 -> insufficient_data", () => {
    expect(computeMomentumDirection(snapshot())).toBe("insufficient_data");
  });
});

/** Bars with a constant daily high-low range, except optionally the last bar. */
function buildBars(count: number, normalRange: number, lastRange?: number): PriceBar[] {
  const bars: PriceBar[] = [];
  for (let i = 0; i < count; i++) {
    const range = i === count - 1 && lastRange !== undefined ? lastRange : normalRange;
    bars.push({
      date: new Date(2026, 0, i + 1),
      open: 100,
      high: 100 + range / 2,
      low: 100 - range / 2,
      close: 100,
      adjclose: 100,
      volume: 1_000_000,
    });
  }
  return bars;
}

describe("computeVolatilityLevel", () => {
  it("a sudden range expansion against a flat baseline -> high", () => {
    // 40 bars: constant 2-point range, except the last bar's range is 10x that.
    // With a perfectly flat baseline, MAD=0, so the elevated day clamps to the
    // maximum z-score deterministically (see lib/stats.ts::robustZScore).
    const bars = buildBars(40, 2, 20);
    expect(computeVolatilityLevel(bars)).toBe("high");
  });

  it("a sudden range contraction against a flat baseline -> low", () => {
    const bars = buildBars(40, 10, 0.5);
    expect(computeVolatilityLevel(bars)).toBe("low");
  });

  it("a perfectly constant range -> normal (z is exactly 0)", () => {
    const bars = buildBars(40, 2);
    expect(computeVolatilityLevel(bars)).toBe("normal");
  });

  it("too few bars for even one ATR value -> insufficient_data", () => {
    const bars = buildBars(5, 2);
    expect(computeVolatilityLevel(bars)).toBe("insufficient_data");
  });

  it("enough bars for ATR but not enough for the volatility baseline -> insufficient_data", () => {
    // ATR(14) needs 14 bars to produce its first value; this leaves only ~1-2
    // atrPct points once the current point is set aside — short of the
    // VOLATILITY_MIN_BASELINE_POINTS=20 minimum.
    const bars = buildBars(16, 2);
    expect(computeVolatilityLevel(bars)).toBe("insufficient_data");
  });
});
