/**
 * =============================================================================
 * tests/nodes/price-revenue-discrepancy.test.ts
 * =============================================================================
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState } from "../../src/state.js";

const mocks = vi.hoisted(() => ({
  fetchConstituentOhlcv: vi.fn(),
  fetchQuarterlyFinancials: vi.fn(),
}));

vi.mock("../../src/tools/yahoo-finance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/yahoo-finance.js")>();
  return {
    ...actual,
    fetchConstituentOhlcv: mocks.fetchConstituentOhlcv,
    fetchQuarterlyFinancials: mocks.fetchQuarterlyFinancials,
  };
});

const { priceRevenueDiscrepancyNode, computePctChangeFromBars, computeHistoricalRatios } =
  await import("../../src/nodes/capabilities/growth-authenticity/price-revenue-discrepancy.js");

const NOW = new Date("2026-08-01T00:00:00Z");

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    messages: [],
    tickers: ["NVDA"],
    sectors: [],
    intent: "single_report",
    timeWindow: "1y",
    activeCapabilities: ["growth_authenticity"],
    sectorRankings: null,
    sectorLeaders: null,
    trendDataErrors: [],
    partialHoldingsSectors: [],
    revenueGrowth: {
      ticker: "NVDA",
      latestQuarterEnd: "2026-06-30",
      revenueGrowthPct: 20,
      basis: "yoy_quarterly",
    },
    priceRevenueDiscrepancy: null,
    inorganicSignal: null,
    sectorBenchmark: null,
    growthAuthenticity: null,
    growthCheckErrors: [],
    portfolioGrowthResults: null,
    tickerComparison: null,
    portfolioScanErrors: [],
    companySnapshots: null,
    companySnapshotErrors: [],
    technicalAnalysis: null,
    technicalAnalysisErrors: [],
    dataErrors: [],
    draftReport: null,
    validationPassed: false,
    validationNotes: [],
    finalReport: null,
    retryCount: 0,
    ...overrides,
  };
}

function chart(from: number, to: number, firstTradeDate?: Date) {
  return {
    meta: { symbol: "NVDA", ...(firstTradeDate ? { firstTradeDate } : {}) },
    quotes: [
      {
        date: new Date("2025-08-01"),
        open: from,
        high: from,
        low: from,
        close: from,
        volume: 1000,
      },
      { date: new Date("2026-08-01"), open: to, high: to, low: to, close: to, volume: 1000 },
    ],
  };
}

beforeEach(() => {
  mocks.fetchConstituentOhlcv.mockReset();
  mocks.fetchQuarterlyFinancials.mockReset();
});

describe("computePctChangeFromBars", () => {
  it("computes % change from first to last usable bar", () => {
    expect(computePctChangeFromBars(chart(100, 140).quotes)).toBeCloseTo(40, 5);
  });

  it("returns null with fewer than 2 usable bars", () => {
    expect(computePctChangeFromBars([chart(100, 140).quotes[0]!])).toBeNull();
  });
});

describe("computeHistoricalRatios", () => {
  it("builds a ratio series from paired historical revenue growth + trailing price return", () => {
    // Quarters spaced ~1yr apart at indices [0,4,8...] would need many rows;
    // use a simple 2-year history: quarter 4 (index 4) has revenue vs quarter 0.
    const start = new Date("2023-01-31");
    const financialRows = Array.from({ length: 8 }, (_, i) => ({
      date: new Date(start.getTime() + i * 91 * 24 * 60 * 60 * 1000),
      totalRevenue: 100 + i * 5, // steady growth each quarter
    }));

    // Price roughly doubles every year (aligned with the financial row dates).
    const priceBars = Array.from({ length: 25 }, (_, i) => ({
      date: new Date(start.getTime() + i * 30 * 24 * 60 * 60 * 1000),
      open: 10 + i,
      high: 10 + i,
      low: 10 + i,
      close: 10 + i,
      volume: 1000,
    }));

    const ratios = computeHistoricalRatios(financialRows, priceBars);
    // Excludes the latest quarter (index 7) — only earlier quarters with a
    // valid YoY comparator (indices 4,5,6) can contribute a ratio.
    expect(ratios.length).toBeGreaterThan(0);
  });

  it("excludes quarters with flat/declining revenue growth from the ratio series", () => {
    const start = new Date("2023-01-31");
    const financialRows = Array.from({ length: 8 }, (_, i) => ({
      date: new Date(start.getTime() + i * 91 * 24 * 60 * 60 * 1000),
      totalRevenue: 100, // flat forever — YoY growth is always 0
    }));
    const priceBars = Array.from({ length: 25 }, (_, i) => ({
      date: new Date(start.getTime() + i * 30 * 24 * 60 * 60 * 1000),
      open: 10,
      high: 10,
      low: 10,
      close: 10,
      volume: 1000,
    }));
    expect(computeHistoricalRatios(financialRows, priceBars)).toEqual([]);
  });
});

describe("priceRevenueDiscrepancyNode — case matrix", () => {
  it("not_computable when revenueGrowth never ran", async () => {
    const result = await priceRevenueDiscrepancyNode(makeState({ revenueGrowth: null }), NOW);
    expect(result.priceRevenueDiscrepancy?.discrepancyFlag).toBe("not_computable");
  });

  it("not_computable when price history fetch fails", async () => {
    mocks.fetchConstituentOhlcv.mockRejectedValue(new Error("network down"));
    const result = await priceRevenueDiscrepancyNode(makeState(), NOW);
    expect(result.priceRevenueDiscrepancy?.discrepancyFlag).toBe("not_computable");
    expect(result.growthCheckErrors?.some((e) => e.includes("network down"))).toBe(true);
  });

  it("not_computable for a recent IPO (listed after the window opened)", async () => {
    mocks.fetchConstituentOhlcv.mockResolvedValue(chart(100, 140, new Date("2026-06-01")));
    const result = await priceRevenueDiscrepancyNode(makeState(), NOW);
    expect(result.priceRevenueDiscrepancy?.discrepancyFlag).toBe("not_computable");
    expect(result.growthCheckErrors?.some((e) => e.includes("listed"))).toBe(true);
  });

  it("revenue flat/declining + price rising → price_outpacing_revenue, ratio stays null", async () => {
    mocks.fetchConstituentOhlcv.mockResolvedValue(chart(100, 140));
    const result = await priceRevenueDiscrepancyNode(
      makeState({
        revenueGrowth: {
          ticker: "NVDA",
          latestQuarterEnd: "2026-06-30",
          revenueGrowthPct: -3,
          basis: "yoy_quarterly",
        },
      }),
      NOW,
    );
    expect(result.priceRevenueDiscrepancy?.discrepancyFlag).toBe("price_outpacing_revenue");
    expect(result.priceRevenueDiscrepancy?.priceToRevenueGrowthRatio).toBeNull();
  });

  it("revenue flat/declining + price also flat/declining → aligned", async () => {
    mocks.fetchConstituentOhlcv.mockResolvedValue(chart(100, 90));
    const result = await priceRevenueDiscrepancyNode(
      makeState({
        revenueGrowth: {
          ticker: "NVDA",
          latestQuarterEnd: "2026-06-30",
          revenueGrowthPct: -3,
          basis: "yoy_quarterly",
        },
      }),
      NOW,
    );
    expect(result.priceRevenueDiscrepancy?.discrepancyFlag).toBe("aligned");
  });

  it(
    "positive revenue growth but no baseline history → insufficient_history, NOT aligned " +
      "(a missing baseline must not read as a confident 'no discrepancy' claim)",
    async () => {
      mocks.fetchConstituentOhlcv.mockResolvedValue(chart(100, 140));
      mocks.fetchQuarterlyFinancials.mockResolvedValue([]); // no history at all
      const result = await priceRevenueDiscrepancyNode(makeState(), NOW);

      expect(result.priceRevenueDiscrepancy?.discrepancyFlag).toBe("insufficient_history");
      expect(result.priceRevenueDiscrepancy?.ratioZScore).toBeNull();
      expect(result.priceRevenueDiscrepancy?.priceToRevenueGrowthRatio).not.toBeNull();
      expect(
        result.growthCheckErrors?.some(
          (e) => e.includes("historical quarter") && e.includes("baseline"),
        ),
      ).toBe(true);
    },
  );

  it("never throws even when the baseline fetch fails outright", async () => {
    mocks.fetchConstituentOhlcv.mockResolvedValue(chart(100, 140));
    mocks.fetchQuarterlyFinancials.mockRejectedValue(new Error("boom"));
    await expect(priceRevenueDiscrepancyNode(makeState(), NOW)).resolves.toBeDefined();
  });
});
