/**
 * =============================================================================
 * tests/nodes/valuation-metrics.test.ts
 * =============================================================================
 *
 * `computeValuationMetrics` (§13.5): 4 valuation multiples, each robust
 * z-scored against a peer sample, ALL `higherIsBetter: false` (cheaper is
 * favourable). Covers the z-score/flag direction, the ev_to_ebitda guard, and
 * the too-few-peers degradation to `not_computable`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanyFundamentalsSnapshot } from "../../src/tools/yahoo-finance.js";

const mocks = vi.hoisted(() => ({
  fetchCompanyFundamentalsSnapshot: vi.fn(),
}));

vi.mock("../../src/tools/yahoo-finance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/yahoo-finance.js")>();
  return { ...actual, fetchCompanyFundamentalsSnapshot: mocks.fetchCompanyFundamentalsSnapshot };
});

const { computeValuationMetrics, flagFromZScore } = await import(
  "../../src/nodes/capabilities/company-snapshot/valuation-metrics.js"
);

function snapshot(overrides: Partial<CompanyFundamentalsSnapshot> = {}): CompanyFundamentalsSnapshot {
  return {
    assetProfile: {},
    summaryDetail: { trailingPE: 20, forwardPE: 18 },
    defaultKeyStatistics: { enterpriseValue: 1000, priceToBook: 3 },
    financialData: { ebitda: 100 },
    ...overrides,
  };
}

beforeEach(() => {
  mocks.fetchCompanyFundamentalsSnapshot.mockReset();
});

describe("flagFromZScore", () => {
  it("returns not_computable for a null z-score", () => {
    expect(flagFromZScore(null, false)).toBe("not_computable");
  });

  it("returns in_line_with_peers within the threshold", () => {
    expect(flagFromZScore(1, false)).toBe("in_line_with_peers");
  });

  it("a low value (negative z) is favourable when higherIsBetter is false", () => {
    expect(flagFromZScore(-3, false)).toBe("favorable_vs_peers");
    expect(flagFromZScore(3, false)).toBe("unfavorable_vs_peers");
  });

  it("a high value (positive z) is favourable when higherIsBetter is true", () => {
    expect(flagFromZScore(3, true)).toBe("favorable_vs_peers");
    expect(flagFromZScore(-3, true)).toBe("unfavorable_vs_peers");
  });
});

describe("computeValuationMetrics", () => {
  it("z-scores the target's trailing P/E against the peer sample and flags a cheap valuation as favorable", async () => {
    // Target is cheap (P/E 10) against a tight peer cluster around 25.
    mocks.fetchCompanyFundamentalsSnapshot.mockImplementation(async (ticker: string) => {
      if (ticker === "TGT") return snapshot({ summaryDetail: { trailingPE: 10, forwardPE: 9 } });
      return snapshot({ summaryDetail: { trailingPE: 25, forwardPE: 23 } });
    });

    const { result, errors } = await computeValuationMetrics(
      "TGT",
      "Information Technology",
      ["P1", "P2", "P3", "P4"],
      new Date(),
    );

    expect(errors).toEqual([]);
    expect(result).not.toBeNull();
    const trailingPe = result!.metrics.find((m) => m.metric === "trailing_pe")!;
    expect(trailingPe.value).toBe(10);
    expect(trailingPe.higherIsBetter).toBe(false);
    expect(trailingPe.flag).toBe("favorable_vs_peers");
    expect(result!.peerCount).toBe(4);
  });

  it("computes ev_to_ebitda and guards against a missing/non-positive ebitda", async () => {
    mocks.fetchCompanyFundamentalsSnapshot.mockImplementation(async (ticker: string) => {
      if (ticker === "TGT") {
        return snapshot({
          defaultKeyStatistics: { enterpriseValue: 500 },
          financialData: { ebitda: 0 }, // non-positive -> not_computable, never a nonsensical multiple
        });
      }
      return snapshot();
    });

    const { result } = await computeValuationMetrics("TGT", "Energy", ["P1", "P2", "P3"], new Date());

    const evToEbitda = result!.metrics.find((m) => m.metric === "ev_to_ebitda")!;
    expect(evToEbitda.value).toBeNull();
    expect(evToEbitda.flag).toBe("not_computable");
  });

  it("computes a real ev_to_ebitda value when both inputs are present and positive", async () => {
    mocks.fetchCompanyFundamentalsSnapshot.mockImplementation(async () =>
      snapshot({ defaultKeyStatistics: { enterpriseValue: 500 }, financialData: { ebitda: 100 } }),
    );

    const { result } = await computeValuationMetrics("TGT", "Energy", ["P1", "P2", "P3"], new Date());

    const evToEbitda = result!.metrics.find((m) => m.metric === "ev_to_ebitda")!;
    expect(evToEbitda.value).toBe(5);
  });

  it("degrades to not_computable when fewer than the minimum peer sample resolved", async () => {
    mocks.fetchCompanyFundamentalsSnapshot.mockImplementation(async () => snapshot());

    // Only 2 peers -> below MIN_BASELINE_QUARTERS (3) -> robustZScore returns null.
    const { result } = await computeValuationMetrics("TGT", "Energy", ["P1", "P2"], new Date());

    for (const metric of result!.metrics) {
      expect(metric.zScore).toBeNull();
      expect(metric.flag).toBe("not_computable");
    }
  });

  it("reports an error and no peer comparison when no peers were resolved", async () => {
    mocks.fetchCompanyFundamentalsSnapshot.mockImplementation(async () => snapshot());

    const { result, errors } = await computeValuationMetrics("TGT", "Energy", [], new Date());

    expect(errors.length).toBeGreaterThan(0);
    expect(result!.peerCount).toBe(0);
  });

  it("returns a null result when the target's own fetch fails", async () => {
    mocks.fetchCompanyFundamentalsSnapshot.mockImplementation(async (ticker: string) => {
      if (ticker === "TGT") throw new Error("boom");
      return snapshot();
    });

    const { result, errors } = await computeValuationMetrics("TGT", "Energy", ["P1", "P2", "P3"], new Date());

    expect(result).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
  });

  it("isolates a single failing peer without failing the whole computation", async () => {
    mocks.fetchCompanyFundamentalsSnapshot.mockImplementation(async (ticker: string) => {
      if (ticker === "BADPEER") throw new Error("peer fetch failed");
      return snapshot();
    });

    const { result, errors } = await computeValuationMetrics(
      "TGT",
      "Energy",
      ["P1", "P2", "BADPEER", "P3"],
      new Date(),
    );

    expect(result).not.toBeNull();
    expect(result!.peerCount).toBe(3);
    expect(errors.some((e) => e.includes("degraded"))).toBe(true);
  });
});
