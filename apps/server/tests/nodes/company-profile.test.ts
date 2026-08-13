/**
 * =============================================================================
 * tests/nodes/company-profile.test.ts
 * =============================================================================
 *
 * `computeCompanyProfile` (§13.3): general, unpeer-compared company facts,
 * extracted from the combined `quoteSummary` bundle. Covers field extraction,
 * per-field null degradation for sparse coverage, and the fraction->percent
 * conversion for dividend yield / Yahoo's own revenue-growth figure.
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

const { computeCompanyProfile } = await import(
  "../../src/nodes/capabilities/company-snapshot/company-profile.js"
);

beforeEach(() => {
  mocks.fetchCompanyFundamentalsSnapshot.mockReset();
});

describe("computeCompanyProfile", () => {
  it("extracts and maps every field from a fully-populated snapshot", async () => {
    const full: CompanyFundamentalsSnapshot = {
      assetProfile: { sector: "Technology", industry: "Semiconductors", fullTimeEmployees: 29600 },
      summaryDetail: {
        marketCap: 3_000_000_000_000,
        beta: 1.7,
        dividendYield: 0.0004,
        fiftyTwoWeekLow: 80,
        fiftyTwoWeekHigh: 190,
      },
      defaultKeyStatistics: { trailingEps: 2.1, forwardEps: 2.9 },
      financialData: { targetMeanPrice: 175, recommendationKey: "buy", revenueGrowth: 0.62 },
    };
    mocks.fetchCompanyFundamentalsSnapshot.mockResolvedValue(full);

    const { result, errors } = await computeCompanyProfile("NVDA", new Date());

    expect(errors).toEqual([]);
    expect(result).toEqual({
      sector: "Information Technology", // mapped from Yahoo's "Technology"
      industry: "Semiconductors",
      marketCap: 3_000_000_000_000,
      fullTimeEmployees: 29600,
      beta: 1.7,
      dividendYieldPct: 0.04, // 0.0004 fraction -> 0.04%
      fiftyTwoWeekLow: 80,
      fiftyTwoWeekHigh: 190,
      trailingEps: 2.1,
      forwardEps: 2.9,
      analystTargetMeanPrice: 175,
      analystRecommendationKey: "buy",
      reportedRevenueGrowthPct: 62, // 0.62 fraction -> 62%
    });
  });

  it("degrades every missing field to null rather than throwing or omitting it", async () => {
    mocks.fetchCompanyFundamentalsSnapshot.mockResolvedValue({
      assetProfile: {},
      summaryDetail: {},
      defaultKeyStatistics: {},
      financialData: {},
    } satisfies CompanyFundamentalsSnapshot);

    const { result, errors } = await computeCompanyProfile("THIN", new Date());

    expect(errors).toEqual([]);
    expect(result).not.toBeNull();
    for (const value of Object.values(result!)) {
      expect(value).toBeNull();
    }
  });

  it("leaves sector null when Yahoo's taxonomy string doesn't map to a known GICS sector", async () => {
    mocks.fetchCompanyFundamentalsSnapshot.mockResolvedValue({
      assetProfile: { sector: "Some Unmapped Category" },
      summaryDetail: {},
      defaultKeyStatistics: {},
      financialData: {},
    } satisfies CompanyFundamentalsSnapshot);

    const { result } = await computeCompanyProfile("ODD", new Date());

    expect(result!.sector).toBeNull();
  });

  it("returns a null result (never throws) when the fetch itself fails", async () => {
    mocks.fetchCompanyFundamentalsSnapshot.mockRejectedValue(new Error("network down"));

    const { result, errors } = await computeCompanyProfile("BAD", new Date());

    expect(result).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("BAD");
  });
});
