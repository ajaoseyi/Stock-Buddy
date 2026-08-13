/**
 * =============================================================================
 * tests/lib/stats.test.ts
 * =============================================================================
 *
 * `robustZScore` is the load-bearing statistic behind growth-authenticity's
 * thresholds AND company-snapshot's peer-relative valuation/health metrics
 * (CLAUDE.md §13.5/§13.6) — this module was promoted from growth-
 * authenticity's own former `stats.ts` once company-snapshot became its
 * third consumer. The MAD-outlier-resistance test below is the concrete
 * regression test for the risk called out in the design: a single genuine
 * past event (an actual prior acquisition or earnings collapse, or an
 * unusually priced peer) should not blow out the baseline and mask a NEW
 * one — which is exactly what a naive mean/stdDev z-score would do.
 */

import { describe, expect, it } from "vitest";
import { MIN_BASELINE_QUARTERS, medianAbsoluteDeviation, median, robustZScore } from "../../src/lib/stats.js";

describe("median", () => {
  it("returns the middle value for an odd-length array", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it("averages the two middle values for an even-length array", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("returns 0 for an empty array", () => {
    expect(median([])).toBe(0);
  });
});

describe("medianAbsoluteDeviation", () => {
  it("is 0 for a constant series", () => {
    expect(medianAbsoluteDeviation([5, 5, 5, 5])).toBe(0);
  });

  it("computes the median of absolute deviations from the median", () => {
    // median = 3; deviations = [2, 1, 0, 1, 2]; median of those = 1
    expect(medianAbsoluteDeviation([1, 2, 3, 4, 5])).toBe(1);
  });
});

describe("robustZScore", () => {
  it("returns null when history is shorter than the minimum sample size", () => {
    const shortHistory = Array.from({ length: MIN_BASELINE_QUARTERS - 1 }, (_, i) => i);
    expect(robustZScore(shortHistory, 100)).toBeNull();
  });

  it("returns a z-score once history meets the minimum sample size", () => {
    // A tight, normal-ish cluster around 5 with one clear outlier being tested.
    const history = [4.8, 5.1, 4.9, 5.0, 5.2, 4.95, 5.05];
    expect(robustZScore(history, 5.0)).not.toBeNull();
    expect(robustZScore(history, 50)).toBeGreaterThan(2);
  });

  it("clamps to a bounded value rather than Infinity when MAD is 0", () => {
    const identicalHistory = [10, 10, 10, 10, 10, 10];
    const z = robustZScore(identicalHistory, 25);
    expect(z).not.toBeNull();
    expect(Number.isFinite(z)).toBe(true);
    expect(z).toBeGreaterThan(0);
  });

  it("returns exactly 0 when MAD is 0 and the tested value equals the constant history", () => {
    const identicalHistory = [10, 10, 10, 10, 10, 10];
    expect(robustZScore(identicalHistory, 10)).toBe(0);
  });

  it(
    "REGRESSION: a single past outlier quarter (e.g. a real prior acquisition) must not " +
      "mask a genuine NEW outlier — MAD stays small where mean/stdDev would have inflated it",
    () => {
      // Seven quarters of normal ~5% QoQ moves, ONE of which (a real past
      // acquisition) spiked to 80%. A mean/stdDev baseline would have a huge
      // stdDev here, making almost anything look "normal" by comparison —
      // exactly the failure mode this design avoids.
      const historyWithOnePastSpike = [4, 5, 6, 5, 80, 4, 5];
      const newSuspiciousValue = 45;

      const z = robustZScore(historyWithOnePastSpike, newSuspiciousValue);
      expect(z).not.toBeNull();
      // Despite one historical 80% spike sitting in the same array, MAD is
      // still small enough that a new 45% move reads as a clear outlier.
      expect(Math.abs(z!)).toBeGreaterThanOrEqual(2);
    },
  );

  it("a value close to the historical median scores near zero", () => {
    const history = [10, 12, 9, 11, 10, 13, 9.5];
    const z = robustZScore(history, 10.5);
    expect(Math.abs(z!)).toBeLessThan(1);
  });
});
