/**
 * =============================================================================
 * tests/nodes/sector-benchmark.test.ts
 * =============================================================================
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState } from "../../src/state.js";

const mocks = vi.hoisted(() => ({
  fetchCompanySector: vi.fn(),
  fetchSectorEtfHistory: vi.fn(),
  fetchConstituentOhlcv: vi.fn(),
  fetchEtfHoldings: vi.fn(),
}));

vi.mock("../../src/tools/yahoo-finance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/yahoo-finance.js")>();
  return {
    ...actual,
    fetchCompanySector: mocks.fetchCompanySector,
    fetchSectorEtfHistory: mocks.fetchSectorEtfHistory,
    fetchConstituentOhlcv: mocks.fetchConstituentOhlcv,
  };
});

vi.mock("../../src/tools/etf-holdings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/etf-holdings.js")>();
  return { ...actual, fetchEtfHoldings: mocks.fetchEtfHoldings };
});

const { sectorBenchmarkNode, mapYahooSectorToGics } =
  await import("../../src/nodes/capabilities/growth-authenticity/sector-benchmark.js");

const NOW = new Date("2026-08-01T00:00:00Z");

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    messages: [],
    tickers: ["APA"],
    sectors: [],
    intent: "single_report",
    timeWindow: "1y",
    activeCapabilities: ["growth_authenticity"],
    sectorRankings: null,
    sectorLeaders: null,
    trendDataErrors: [],
    partialHoldingsSectors: [],
    revenueGrowth: null,
    priceRevenueDiscrepancy: {
      priceChangePct: 38,
      priceToRevenueGrowthRatio: null,
      ratioZScore: null,
      baselineQuarterCount: 0,
      discrepancyFlag: "not_computable",
    },
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

function chart(from: number, to: number) {
  return {
    meta: { symbol: "X" },
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
  mocks.fetchCompanySector.mockReset();
  mocks.fetchSectorEtfHistory.mockReset();
  mocks.fetchConstituentOhlcv.mockReset();
  mocks.fetchEtfHoldings
    .mockReset()
    .mockResolvedValue({ holdings: [], source: "market_cap", warnings: [], isPartial: true });
});

describe("mapYahooSectorToGics", () => {
  it("maps a known Yahoo sector to its GICS name", () => {
    expect(mapYahooSectorToGics("Energy")).toBe("Energy");
    expect(mapYahooSectorToGics("Consumer Cyclical")).toBe("Consumer Discretionary");
  });

  it("returns null for an unmapped or missing sector", () => {
    expect(mapYahooSectorToGics("Some New Taxonomy")).toBeNull();
    expect(mapYahooSectorToGics(undefined)).toBeNull();
  });
});

describe("sectorBenchmarkNode", () => {
  it("not_computable when priceChangePct isn't available yet", async () => {
    const result = await sectorBenchmarkNode(makeState({ priceRevenueDiscrepancy: null }), NOW);
    expect(result.sectorBenchmark?.macroBetaFlag).toBe("not_computable");
  });

  it("not_computable with a note when the sector can't be mapped to GICS", async () => {
    mocks.fetchCompanySector.mockResolvedValue({ sector: "Some New Taxonomy" });
    const result = await sectorBenchmarkNode(makeState(), NOW);
    expect(result.sectorBenchmark?.macroBetaFlag).toBe("not_computable");
    expect(result.growthCheckErrors?.some((e) => e.includes("could not be mapped"))).toBe(true);
  });

  it("computes sectorBenchmarkPct and spread when the sector resolves", async () => {
    mocks.fetchCompanySector.mockResolvedValue({ sector: "Energy" });
    mocks.fetchSectorEtfHistory.mockResolvedValue(chart(100, 138)); // XLE +38%, matching APA's own +38%
    const result = await sectorBenchmarkNode(makeState(), NOW);

    expect(result.sectorBenchmark?.sector).toBe("Energy");
    expect(result.sectorBenchmark?.sectorBenchmarkPct).toBeCloseTo(38, 5);
    expect(result.sectorBenchmark?.stockVsSectorSpreadPct).toBeCloseTo(0, 5);
  });

  it("defaults to stock_specific_move (the cautious direction) when the peer sample is unavailable", async () => {
    mocks.fetchCompanySector.mockResolvedValue({ sector: "Energy" });
    mocks.fetchSectorEtfHistory.mockResolvedValue(chart(100, 138));
    mocks.fetchEtfHoldings.mockRejectedValue(new Error("holdings unavailable"));

    const result = await sectorBenchmarkNode(makeState(), NOW);
    expect(result.sectorBenchmark?.macroBetaFlag).toBe("stock_specific_move");
    expect(result.growthCheckErrors?.some((e) => e.includes("peer sample"))).toBe(true);
  });

  it("never touches any field outside sectorBenchmark/growthCheckErrors", async () => {
    mocks.fetchCompanySector.mockResolvedValue({ sector: "Energy" });
    mocks.fetchSectorEtfHistory.mockResolvedValue(chart(100, 138));
    const result = await sectorBenchmarkNode(makeState(), NOW);
    expect(Object.keys(result).sort()).toEqual(["growthCheckErrors", "sectorBenchmark"]);
  });
});
