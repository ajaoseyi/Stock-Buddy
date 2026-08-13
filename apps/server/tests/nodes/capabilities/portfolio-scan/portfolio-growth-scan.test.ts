/**
 * =============================================================================
 * tests/nodes/capabilities/portfolio-scan/portfolio-growth-scan.test.ts — §12
 * =============================================================================
 *
 * `portfolioGrowthScanNode` is an ORCHESTRATION node, not a new algorithm
 * (§12.3) — it drives the five existing growth-authenticity node functions,
 * already covered by their own dedicated test files. So THIS file mocks at
 * the NODE-FUNCTION boundary (`../growth-authenticity/*.js`), not the tool
 * boundary — it verifies the orchestrator's own job: per-ticker threading and
 * isolation, the ticker cap, and error aggregation. No live network (§8).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState, GrowthAuthenticityResult } from "../../../../src/state.js";

const mocks = vi.hoisted(() => ({
  revenueGrowthNode: vi.fn(),
  priceRevenueDiscrepancyNode: vi.fn(),
  inorganicSignalNode: vi.fn(),
  sectorBenchmarkNode: vi.fn(),
  growthClassificationNode: vi.fn(),
}));

vi.mock("../../../../src/nodes/capabilities/growth-authenticity/revenue-growth.js", () => ({
  revenueGrowthNode: mocks.revenueGrowthNode,
}));
vi.mock("../../../../src/nodes/capabilities/growth-authenticity/price-revenue-discrepancy.js", () => ({
  priceRevenueDiscrepancyNode: mocks.priceRevenueDiscrepancyNode,
}));
vi.mock("../../../../src/nodes/capabilities/growth-authenticity/inorganic-signal.js", () => ({
  inorganicSignalNode: mocks.inorganicSignalNode,
}));
vi.mock("../../../../src/nodes/capabilities/growth-authenticity/sector-benchmark.js", () => ({
  sectorBenchmarkNode: mocks.sectorBenchmarkNode,
}));
vi.mock("../../../../src/nodes/capabilities/growth-authenticity/growth-classification.js", () => ({
  growthClassificationNode: mocks.growthClassificationNode,
}));

const { portfolioGrowthScanNode, PORTFOLIO_SCAN_TICKER_CAP } = await import(
  "../../../../src/nodes/capabilities/portfolio-scan/portfolio-growth-scan.js"
);

const NOW = new Date("2026-08-01T00:00:00Z");

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    messages: [],
    tickers: ["AAPL", "TSLA"],
    sectors: [],
    intent: "portfolio_scan",
    timeWindow: "1y",
    activeCapabilities: ["portfolio_scan"],
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

/** A minimal, schema-valid `GrowthAuthenticityResult` for one ticker. */
function growthResultFor(ticker: string): GrowthAuthenticityResult {
  return {
    ticker,
    timeWindow: "1y",
    revenueGrowth: { ticker, latestQuarterEnd: "2026-06-30", revenueGrowthPct: 10, basis: "yoy_quarterly" },
    discrepancy: {
      priceChangePct: 5,
      priceToRevenueGrowthRatio: 0.5,
      ratioZScore: 0.1,
      baselineQuarterCount: 4,
      discrepancyFlag: "aligned",
    },
    inorganic: {
      goodwillTrend: { deltaPct: null, zScore: null, baselineQuarterCount: 0, direction: "insufficient_data" },
      ppeTrend: { deltaPct: null, zScore: null, baselineQuarterCount: 0, direction: "insufficient_data" },
      cashTrend: { deltaPct: null, zScore: null, baselineQuarterCount: 0, direction: "insufficient_data" },
      inorganicSignal: "no_signal",
    },
    sectorBenchmark: {
      sector: "Information Technology",
      sectorBenchmarkPct: 4,
      stockVsSectorSpreadPct: 1,
      macroBetaFlag: "stock_specific_move",
    },
    classification: "organic_growth_supported",
    classificationReasonCodes: ["discrepancy:aligned"],
  };
}

/**
 * Wire the five mocked node functions to thread a per-ticker slice exactly
 * like the real chain does, so the orchestrator's own folding logic is
 * exercised end-to-end — only the FIVE NODES' internals are faked.
 */
function wireChain(overrides: { errorFor?: string } = {}) {
  mocks.revenueGrowthNode.mockImplementation(async (state: AgentState) => ({
    revenueGrowth: growthResultFor(state.tickers[0]!).revenueGrowth,
  }));
  mocks.priceRevenueDiscrepancyNode.mockImplementation(async (state: AgentState) => ({
    priceRevenueDiscrepancy: growthResultFor(state.tickers[0]!).discrepancy,
  }));
  mocks.inorganicSignalNode.mockImplementation(async (state: AgentState) => ({
    inorganicSignal: growthResultFor(state.tickers[0]!).inorganic,
  }));
  mocks.sectorBenchmarkNode.mockImplementation(async (state: AgentState) => ({
    sectorBenchmark: growthResultFor(state.tickers[0]!).sectorBenchmark,
  }));
  mocks.growthClassificationNode.mockImplementation(async (state: AgentState) => {
    const ticker = state.tickers[0]!;
    if (ticker === overrides.errorFor) {
      return { growthAuthenticity: null };
    }
    return { growthAuthenticity: growthResultFor(ticker) };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  wireChain();
});

describe("portfolioGrowthScanNode", () => {
  it("analyses every named ticker independently", async () => {
    const result = await portfolioGrowthScanNode(makeState(), NOW);

    expect(result.portfolioGrowthResults).toHaveLength(2);
    expect(result.portfolioGrowthResults!.map((r) => r.ticker)).toEqual(["AAPL", "TSLA"]);
  });

  it("threads a synthetic per-ticker slice — tickers[0] is always the ONE ticker being analysed", async () => {
    await portfolioGrowthScanNode(makeState(), NOW);

    // Every mocked node, for every call, must have seen a single-ticker slice
    // — never the full original tickers array.
    for (const fn of Object.values(mocks)) {
      for (const call of fn.mock.calls) {
        const state = call[0] as AgentState;
        expect(state.tickers).toHaveLength(1);
      }
    }
  });

  it("does not leak one ticker's intermediate data into the next ticker's classification", async () => {
    // If the slice weren't reset per ticker, growthClassificationNode would
    // see TSLA's request with AAPL's leftover revenueGrowth/etc. still
    // attached in a real (non-mocked) chain. Here we assert the ORCHESTRATOR
    // resets the four intermediate fields to null before each ticker's run.
    await portfolioGrowthScanNode(makeState(), NOW);

    const secondTickerCall = mocks.revenueGrowthNode.mock.calls[1]![0] as AgentState;
    expect(secondTickerCall.revenueGrowth).toBeNull();
    expect(secondTickerCall.priceRevenueDiscrepancy).toBeNull();
    expect(secondTickerCall.inorganicSignal).toBeNull();
    expect(secondTickerCall.sectorBenchmark).toBeNull();
  });

  it("runs sequentially, not in parallel — respects §11.2's rate limits", async () => {
    const order: string[] = [];
    mocks.revenueGrowthNode.mockImplementation(async (state: AgentState) => {
      order.push(`start:${state.tickers[0]}`);
      await new Promise((r) => setTimeout(r, 1));
      order.push(`end:${state.tickers[0]}`);
      return { revenueGrowth: growthResultFor(state.tickers[0]!).revenueGrowth };
    });

    await portfolioGrowthScanNode(makeState(), NOW);

    // A parallel run would interleave start:AAPL/start:TSLA before either end.
    expect(order).toEqual(["start:AAPL", "end:AAPL", "start:TSLA", "end:TSLA"]);
  });

  it("caps analysis at PORTFOLIO_SCAN_TICKER_CAP and notes the rest as skipped", async () => {
    const many = ["A", "B", "C", "D", "E", "F", "G"];
    const state = makeState({ tickers: many });

    const result = await portfolioGrowthScanNode(state, NOW);

    expect(result.portfolioGrowthResults).toHaveLength(PORTFOLIO_SCAN_TICKER_CAP);
    expect(
      result.portfolioScanErrors!.some((e) => e.includes("F") && e.includes("G")),
    ).toBe(true);
  });

  it("answers honestly with an empty result and no node calls when no tickers were named", async () => {
    const result = await portfolioGrowthScanNode(makeState({ tickers: [] }), NOW);

    expect(result.portfolioGrowthResults).toEqual([]);
    expect(result.portfolioScanErrors!.length).toBeGreaterThan(0);
    expect(mocks.revenueGrowthNode).not.toHaveBeenCalled();
  });

  it("a ticker that fails to classify does not block the others in the same batch", async () => {
    wireChain({ errorFor: "AAPL" });

    const result = await portfolioGrowthScanNode(makeState(), NOW);

    // AAPL degraded; TSLA still got a real result.
    expect(result.portfolioGrowthResults).toHaveLength(1);
    expect(result.portfolioGrowthResults![0]!.ticker).toBe("TSLA");
    expect(result.portfolioScanErrors!.some((e) => e.includes("AAPL"))).toBe(true);
  });

  it("collects growthCheckErrors from every ticker's chain into portfolioScanErrors", async () => {
    mocks.revenueGrowthNode.mockImplementation(async (state: AgentState) => {
      const ticker = state.tickers[0]!;
      return {
        revenueGrowth: growthResultFor(ticker).revenueGrowth,
        growthCheckErrors: [`${ticker}: insufficient quarterly revenue history`],
      };
    });

    const result = await portfolioGrowthScanNode(makeState(), NOW);

    expect(result.portfolioScanErrors).toContain("AAPL: insufficient quarterly revenue history");
    expect(result.portfolioScanErrors).toContain("TSLA: insufficient quarterly revenue history");
  });

  it("never touches the single-ticker growth-authenticity fields (§12's state contract)", async () => {
    const result = await portfolioGrowthScanNode(makeState(), NOW);

    expect(Object.keys(result).sort()).toEqual(["portfolioGrowthResults", "portfolioScanErrors"]);
  });
});
