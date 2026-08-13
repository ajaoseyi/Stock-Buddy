/**
 * =============================================================================
 * tests/nodes/capabilities/technical-analysis/technical-analysis-scan.test.ts
 * =============================================================================
 *
 * `technicalAnalysisScanNode` is the ONE graph node this capability registers
 * — it resolves targets, then drives the (already independently tested)
 * compute functions per target. This file mocks at the FETCH boundary
 * (`fetchConstituentOhlcv`/`fetchSectorEtfHistory`), letting the real compute
 * pipeline run on synthetic bars, so it verifies the node's own job:
 * cap/skip behaviour, sector->ETF resolution, and per-target error isolation
 * — not the compute functions' own logic (covered by their dedicated test
 * files).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState } from "../../../../src/state.js";
import type { ChartResponse, PriceBar } from "../../../../src/tools/yahoo-finance.js";

const mocks = vi.hoisted(() => ({
  fetchConstituentOhlcv: vi.fn(),
  fetchSectorEtfHistory: vi.fn(),
}));

vi.mock("../../../../src/tools/yahoo-finance.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/tools/yahoo-finance.js")>();
  return {
    ...actual,
    fetchConstituentOhlcv: mocks.fetchConstituentOhlcv,
    fetchSectorEtfHistory: mocks.fetchSectorEtfHistory,
  };
});

const { technicalAnalysisScanNode } = await import(
  "../../../../src/nodes/capabilities/technical-analysis/technical-analysis-scan.js"
);
const { TECHNICAL_ANALYSIS_TICKER_CAP } = await import(
  "../../../../src/nodes/capabilities/technical-analysis/constants.js"
);

const NOW = new Date("2026-08-01T00:00:00Z");

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    messages: [],
    tickers: ["NVDA"],
    sectors: [],
    intent: "technical_analysis",
    timeWindow: "3mo",
    activeCapabilities: ["technical_analysis"],
    sectorRankings: null,
    sectorLeaders: null,
    trendDataErrors: [],
    partialHoldingsSectors: [],
    revenueGrowth: null,
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

/** A long, well-behaved daily bar series — enough history for every indicator to resolve. */
function buildHealthyBars(count: number): PriceBar[] {
  const bars: PriceBar[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    price += 0.15 + Math.sin(i / 7) * 0.3;
    bars.push({
      date: new Date(2024, 0, i + 1),
      open: price,
      high: price + 0.5,
      low: price - 0.5,
      close: price,
      adjclose: price,
      volume: 1_000_000,
    });
  }
  return bars;
}

function chart(bars: PriceBar[]): ChartResponse {
  return { meta: { symbol: "TEST" }, quotes: bars };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchConstituentOhlcv.mockResolvedValue(chart(buildHealthyBars(300)));
  mocks.fetchSectorEtfHistory.mockResolvedValue(chart(buildHealthyBars(300)));
});

describe("technicalAnalysisScanNode", () => {
  it("produces one well-formed result for a single ticker, via fetchConstituentOhlcv", async () => {
    const result = await technicalAnalysisScanNode(makeState({ tickers: ["NVDA"] }), NOW);
    expect(result.technicalAnalysis).toHaveLength(1);
    const entry = result.technicalAnalysis![0]!;
    expect(entry.symbol).toBe("NVDA");
    expect(entry.requestedAs).toBe("ticker");
    expect(entry.sectorName).toBeNull();
    expect(["bullish_setup", "bearish_setup", "neutral_no_setup"]).toContain(entry.stance);
    expect(mocks.fetchConstituentOhlcv).toHaveBeenCalledWith("NVDA", "2y", NOW);
    expect(mocks.fetchSectorEtfHistory).not.toHaveBeenCalled();
  });

  it("resolves a sector-only request to its ETF, via fetchSectorEtfHistory", async () => {
    const result = await technicalAnalysisScanNode(
      makeState({ tickers: [], sectors: ["Information Technology"] }),
      NOW,
    );
    expect(result.technicalAnalysis).toHaveLength(1);
    const entry = result.technicalAnalysis![0]!;
    expect(entry.symbol).toBe("XLK");
    expect(entry.requestedAs).toBe("sector_etf");
    expect(entry.sectorName).toBe("Information Technology");
    expect(mocks.fetchSectorEtfHistory).toHaveBeenCalledWith("XLK", "2y", NOW);
  });

  it("analyses multiple tickers and caps at the ticker limit with a skip note", async () => {
    const tickers = Array.from({ length: TECHNICAL_ANALYSIS_TICKER_CAP + 2 }, (_, i) => `T${i}`);
    const result = await technicalAnalysisScanNode(makeState({ tickers }), NOW);
    expect(result.technicalAnalysis).toHaveLength(TECHNICAL_ANALYSIS_TICKER_CAP);
    expect(result.technicalAnalysisErrors!.some((e) => e.includes("skipped"))).toBe(true);
  });

  it("degrades a single ticker's fetch failure without losing the others", async () => {
    mocks.fetchConstituentOhlcv.mockImplementation(async (ticker: string) => {
      if (ticker === "BAD") throw new Error("network exploded");
      return chart(buildHealthyBars(300));
    });

    const result = await technicalAnalysisScanNode(makeState({ tickers: ["NVDA", "BAD"] }), NOW);
    expect(result.technicalAnalysis).toHaveLength(2);
    const bad = result.technicalAnalysis!.find((r) => r.symbol === "BAD")!;
    expect(bad.stance).toBe("insufficient_data");
    expect(bad.atrLevels.entry).toBeNull();
    expect(result.technicalAnalysisErrors!.some((e) => e.includes("BAD"))).toBe(true);

    const good = result.technicalAnalysis!.find((r) => r.symbol === "NVDA")!;
    expect(good.stance).not.toBe("insufficient_data");
  });

  it("a ticker with too little price history -> insufficient_data, not a crash", async () => {
    mocks.fetchConstituentOhlcv.mockResolvedValue(chart(buildHealthyBars(5)));
    const result = await technicalAnalysisScanNode(makeState({ tickers: ["IPO"] }), NOW);
    const entry = result.technicalAnalysis![0]!;
    expect(entry.stance).toBe("insufficient_data");
    expect(entry.trendDirection).toBe("insufficient_data");
    expect(result.technicalAnalysisErrors!.some((e) => e.includes("IPO"))).toBe(true);
  });

  it("no ticker and no sector named -> honest empty result, no fetch attempted", async () => {
    const result = await technicalAnalysisScanNode(makeState({ tickers: [], sectors: [] }), NOW);
    expect(result.technicalAnalysis).toEqual([]);
    expect(result.technicalAnalysisErrors!.length).toBeGreaterThan(0);
    expect(mocks.fetchConstituentOhlcv).not.toHaveBeenCalled();
    expect(mocks.fetchSectorEtfHistory).not.toHaveBeenCalled();
  });

  it("never touches any field outside technicalAnalysis/technicalAnalysisErrors", async () => {
    const result = await technicalAnalysisScanNode(makeState(), NOW);
    expect(Object.keys(result).sort()).toEqual(["technicalAnalysis", "technicalAnalysisErrors"]);
  });
});
