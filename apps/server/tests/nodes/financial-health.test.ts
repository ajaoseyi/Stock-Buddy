/**
 * =============================================================================
 * tests/nodes/financial-health.test.ts
 * =============================================================================
 *
 * `computeFinancialHealth` (§13.6): 6 metrics vs. sector peers. Same shape as
 * `valuation-metrics.test.ts`, covering the `fcf_margin` guard and the mixed
 * `higherIsBetter` directions (debt_to_equity is the one metric where LOWER
 * is favourable; the other five are the opposite of valuation's convention).
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

const { computeFinancialHealth } = await import(
  "../../src/nodes/capabilities/company-snapshot/financial-health.js"
);

function snapshot(overrides: Partial<CompanyFundamentalsSnapshot> = {}): CompanyFundamentalsSnapshot {
  return {
    assetProfile: {},
    summaryDetail: {},
    defaultKeyStatistics: {},
    financialData: {
      debtToEquity: 0.5,
      currentRatio: 1.5,
      returnOnEquity: 0.15,
      returnOnAssets: 0.08,
      profitMargins: 0.2,
      freeCashflow: 50,
      totalRevenue: 500,
    },
    ...overrides,
  };
}

beforeEach(() => {
  mocks.fetchCompanyFundamentalsSnapshot.mockReset();
});

describe("computeFinancialHealth", () => {
  it("marks debt_to_equity as higherIsBetter: false and everything else true", async () => {
    mocks.fetchCompanyFundamentalsSnapshot.mockImplementation(async () => snapshot());

    const { result } = await computeFinancialHealth("TGT", "Health Care", ["P1", "P2", "P3"], new Date());

    const byMetric = Object.fromEntries(result!.metrics.map((m) => [m.metric, m]));
    expect(byMetric["debt_to_equity"]!.higherIsBetter).toBe(false);
    expect(byMetric["current_ratio"]!.higherIsBetter).toBe(true);
    expect(byMetric["return_on_equity"]!.higherIsBetter).toBe(true);
    expect(byMetric["return_on_assets"]!.higherIsBetter).toBe(true);
    expect(byMetric["profit_margin"]!.higherIsBetter).toBe(true);
    expect(byMetric["fcf_margin"]!.higherIsBetter).toBe(true);
  });

  it("computes fcf_margin as freeCashflow / totalRevenue", async () => {
    mocks.fetchCompanyFundamentalsSnapshot.mockImplementation(async (ticker: string) => {
      if (ticker === "TGT") {
        return snapshot({ financialData: { freeCashflow: 25, totalRevenue: 100 } });
      }
      return snapshot();
    });

    const { result } = await computeFinancialHealth("TGT", "Health Care", ["P1", "P2", "P3"], new Date());

    const fcfMargin = result!.metrics.find((m) => m.metric === "fcf_margin")!;
    expect(fcfMargin.value).toBeCloseTo(0.25);
  });

  it("guards fcf_margin against a missing or non-positive totalRevenue", async () => {
    mocks.fetchCompanyFundamentalsSnapshot.mockImplementation(async (ticker: string) => {
      if (ticker === "TGT") {
        return snapshot({ financialData: { freeCashflow: 25, totalRevenue: 0 } });
      }
      return snapshot();
    });

    const { result } = await computeFinancialHealth("TGT", "Health Care", ["P1", "P2", "P3"], new Date());

    const fcfMargin = result!.metrics.find((m) => m.metric === "fcf_margin")!;
    expect(fcfMargin.value).toBeNull();
    expect(fcfMargin.flag).toBe("not_computable");
  });

  it("a lower debt/equity than peers flags favorable_vs_peers (leverage is the exception to 'higher is better')", async () => {
    mocks.fetchCompanyFundamentalsSnapshot.mockImplementation(async (ticker: string) => {
      if (ticker === "TGT") return snapshot({ financialData: { ...snapshot().financialData, debtToEquity: 0.1 } });
      return snapshot({ financialData: { ...snapshot().financialData, debtToEquity: 1.5 } });
    });

    const { result } = await computeFinancialHealth("TGT", "Health Care", ["P1", "P2", "P3", "P4"], new Date());

    const debtToEquity = result!.metrics.find((m) => m.metric === "debt_to_equity")!;
    expect(debtToEquity.value).toBe(0.1);
    expect(debtToEquity.flag).toBe("favorable_vs_peers");
  });

  it("returns a null result when the target's own fetch fails, without throwing", async () => {
    mocks.fetchCompanyFundamentalsSnapshot.mockImplementation(async (ticker: string) => {
      if (ticker === "TGT") throw new Error("boom");
      return snapshot();
    });

    const { result, errors } = await computeFinancialHealth("TGT", "Health Care", ["P1"], new Date());

    expect(result).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
  });
});
