/**
 * =============================================================================
 * tests/nodes/capabilities/technical-analysis/indicator-snapshot.test.ts
 * =============================================================================
 */

import { describe, expect, it } from "vitest";
import type { PriceBar } from "../../../../src/tools/yahoo-finance.js";
import { computeIndicatorSnapshot, usableBars } from "../../../../src/nodes/capabilities/technical-analysis/indicator-snapshot.js";
import { MIN_BARS_FOR_SMA200 } from "../../../../src/nodes/capabilities/technical-analysis/constants.js";

function buildBars(count: number): PriceBar[] {
  const bars: PriceBar[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    price += 0.1;
    bars.push({
      date: new Date(2024, 0, i + 1),
      open: price,
      high: price + 0.5,
      low: price - 0.5,
      close: price,
      adjclose: price,
      volume: 1_000,
    });
  }
  return bars;
}

describe("usableBars", () => {
  it("drops bars missing high, low, or close", () => {
    const bars: PriceBar[] = [
      { date: new Date(), open: 1, high: null, low: 1, close: 1, adjclose: 1, volume: 1 },
      { date: new Date(), open: 1, high: 2, low: null, close: 1, adjclose: 1, volume: 1 },
      { date: new Date(), open: 1, high: 2, low: 1, close: null, adjclose: 1, volume: 1 },
      { date: new Date(), open: 1, high: 2, low: 1, close: 1.5, adjclose: 1.5, volume: 1 },
    ];
    expect(usableBars(bars)).toHaveLength(1);
  });

  it("prefers adjclose over close", () => {
    const bars: PriceBar[] = [
      { date: new Date(), open: 1, high: 2, low: 1, close: 1.5, adjclose: 1.4, volume: 1 },
    ];
    expect(usableBars(bars)[0]!.close).toBe(1.4);
  });
});

describe("computeIndicatorSnapshot", () => {
  it("resolves every field with enough history for SMA200", () => {
    const snapshot = computeIndicatorSnapshot(buildBars(MIN_BARS_FOR_SMA200 + 10));

    expect(snapshot.sma20).not.toBeNull();
    expect(snapshot.sma50).not.toBeNull();
    expect(snapshot.sma200).not.toBeNull();
    expect(snapshot.ema12).not.toBeNull();
    expect(snapshot.ema26).not.toBeNull();
    expect(snapshot.rsi14).not.toBeNull();
    expect(snapshot.rsi14).toBeGreaterThanOrEqual(0);
    expect(snapshot.rsi14).toBeLessThanOrEqual(100);
    expect(snapshot.macd.macdLine).not.toBeNull();
    expect(snapshot.atr14).not.toBeNull();
    expect(snapshot.bollinger.middle).not.toBeNull();
    expect(snapshot.latestClose).not.toBeNull();
    expect(snapshot.asOfDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("degrades sma200 alone when there is enough history for shorter indicators but not SMA200", () => {
    const snapshot = computeIndicatorSnapshot(buildBars(MIN_BARS_FOR_SMA200 - 50));

    expect(snapshot.sma200).toBeNull();
    expect(snapshot.sma20).not.toBeNull();
    expect(snapshot.sma50).not.toBeNull();
    expect(snapshot.rsi14).not.toBeNull();
  });

  it("degrades every field to null with too little history for any indicator", () => {
    const snapshot = computeIndicatorSnapshot(buildBars(5));
    expect(snapshot.sma20).toBeNull();
    expect(snapshot.rsi14).toBeNull();
    expect(snapshot.atr14).toBeNull();
    // latestClose/asOfDate still resolve from whatever bars ARE present —
    // they need only one usable bar, not a lookback period.
    expect(snapshot.latestClose).not.toBeNull();
  });

  it("everything is null for an empty bar set", () => {
    const snapshot = computeIndicatorSnapshot([]);
    expect(snapshot.latestClose).toBeNull();
    expect(snapshot.asOfDate).toBeNull();
    expect(snapshot.sma20).toBeNull();
  });
});
