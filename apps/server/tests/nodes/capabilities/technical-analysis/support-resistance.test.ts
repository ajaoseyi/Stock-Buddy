/**
 * =============================================================================
 * tests/nodes/capabilities/technical-analysis/support-resistance.test.ts
 * =============================================================================
 *
 * Builds a 15-bar series with one deliberate high spike (index 7) and one
 * deliberate low spike (index 8), each far enough from its neighbours to be
 * an unambiguous fractal extreme under the default SWING_LOOKBACK_BARS=5 —
 * the rest of the series is a gentle monotonic ramp so no other index can
 * qualify as a swing point.
 */

import { describe, expect, it } from "vitest";
import type { PriceBar } from "../../../../src/tools/yahoo-finance.js";
import { computeSupportResistance } from "../../../../src/nodes/capabilities/technical-analysis/support-resistance.js";

function buildBars(): PriceBar[] {
  const bars: PriceBar[] = [];
  for (let i = 0; i < 15; i++) {
    let high = 100 + i;
    let low = 90 + i;
    if (i === 7) high = 200; // unambiguous swing high
    if (i === 8) low = 10; // unambiguous swing low
    bars.push({
      date: new Date(2026, 0, i + 1),
      open: null,
      high,
      low,
      // `usableBars` (indicator-snapshot.ts) drops any bar missing high/low/
      // close, so close must be non-null even though this test only cares
      // about high/low.
      close: (high + low) / 2,
      adjclose: null,
      volume: null,
    });
  }
  return bars;
}

describe("computeSupportResistance", () => {
  it("detects the spike as resistance (above current price) and the dip as support (below)", () => {
    const { swingPoints, supportLevels, resistanceLevels } = computeSupportResistance(
      buildBars(),
      50,
    );

    expect(swingPoints.map((p) => ({ index: p.index, kind: p.kind, price: p.price }))).toEqual([
      { index: 7, kind: "swing_high", price: 200 },
      { index: 8, kind: "swing_low", price: 10 },
    ]);

    expect(supportLevels).toEqual([{ price: 10, kind: "support", touches: 1 }]);
    expect(resistanceLevels).toEqual([{ price: 200, kind: "resistance", touches: 1 }]);
  });

  it("returns empty results when currentPrice is unavailable", () => {
    const result = computeSupportResistance(buildBars(), null);
    expect(result.supportLevels).toEqual([]);
    expect(result.resistanceLevels).toEqual([]);
  });

  it("returns empty results when there are no usable bars", () => {
    const result = computeSupportResistance([], 50);
    expect(result.swingPoints).toEqual([]);
    expect(result.supportLevels).toEqual([]);
    expect(result.resistanceLevels).toEqual([]);
  });
});
