/**
 * =============================================================================
 * tests/nodes/capabilities/company-snapshot/company-snapshot-scan.test.ts — §13
 * =============================================================================
 *
 * `companySnapshotScanNode` is the ONE graph node this capability registers
 * (§13.7) — it loops over up to `COMPANY_SNAPSHOT_TICKER_CAP` tickers and
 * drives three plain compute functions per ticker. This file mocks at the
 * compute-function boundary (mirroring `portfolio-growth-scan.test.ts`'s own
 * approach for the analogous orchestrator), so it verifies the node's own
 * job: cap/skip behaviour and per-ticker error isolation, not the compute
 * functions' own logic (covered by their dedicated test files).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState } from "../../../../src/state.js";

const mocks = vi.hoisted(() => ({
  computeCompanyProfile: vi.fn(),
  computeValuationMetrics: vi.fn(),
  computeFinancialHealth: vi.fn(),
  resolvePeerSample: vi.fn(),
}));

vi.mock("../../../../src/nodes/capabilities/company-snapshot/company-profile.js", () => ({
  computeCompanyProfile: mocks.computeCompanyProfile,
}));
vi.mock("../../../../src/nodes/capabilities/company-snapshot/valuation-metrics.js", () => ({
  computeValuationMetrics: mocks.computeValuationMetrics,
}));
vi.mock("../../../../src/nodes/capabilities/company-snapshot/financial-health.js", () => ({
  computeFinancialHealth: mocks.computeFinancialHealth,
}));
vi.mock("../../../../src/nodes/capabilities/company-snapshot/peer-sample.js", () => ({
  resolvePeerSample: mocks.resolvePeerSample,
}));

const { companySnapshotScanNode, COMPANY_SNAPSHOT_TICKER_CAP } = await import(
  "../../../../src/nodes/capabilities/company-snapshot/company-snapshot-scan.js"
);

const NOW = new Date("2026-08-01T00:00:00Z");

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    messages: [],
    tickers: ["AAPL", "MSFT"],
    sectors: [],
    intent: "company_snapshot",
    timeWindow: "1y",
    activeCapabilities: ["company_snapshot"],
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

function wireDefaults() {
  mocks.resolvePeerSample.mockImplementation(async () => ({
    sector: "Information Technology",
    peers: ["PEER1", "PEER2", "PEER3"],
    errors: [],
  }));
  mocks.computeCompanyProfile.mockImplementation(async () => ({
    result: { sector: "Information Technology", industry: null, marketCap: null, fullTimeEmployees: null, beta: null, dividendYieldPct: null, fiftyTwoWeekLow: null, fiftyTwoWeekHigh: null, trailingEps: null, forwardEps: null, analystTargetMeanPrice: null, analystRecommendationKey: null, reportedRevenueGrowthPct: null },
    errors: [],
  }));
  mocks.computeValuationMetrics.mockImplementation(async () => ({
    result: { sector: "Information Technology", peerCount: 3, metrics: [] },
    errors: [],
  }));
  mocks.computeFinancialHealth.mockImplementation(async () => ({
    result: { sector: "Information Technology", peerCount: 3, metrics: [] },
    errors: [],
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  wireDefaults();
});

describe("companySnapshotScanNode", () => {
  it("analyses every named ticker and assembles one CompanySnapshotResult each", async () => {
    const result = await companySnapshotScanNode(makeState(), NOW);

    expect(result.companySnapshots).toHaveLength(2);
    expect(result.companySnapshots!.map((s) => s.ticker)).toEqual(["AAPL", "MSFT"]);
    expect(result.companySnapshots![0]!.timeWindow).toBe("1y");
  });

  it("resolves the peer sample once per ticker and passes it to both compute functions", async () => {
    await companySnapshotScanNode(makeState({ tickers: ["AAPL"] }), NOW);

    expect(mocks.resolvePeerSample).toHaveBeenCalledTimes(1);
    expect(mocks.computeValuationMetrics).toHaveBeenCalledWith(
      "AAPL",
      "Information Technology",
      ["PEER1", "PEER2", "PEER3"],
      NOW,
    );
    expect(mocks.computeFinancialHealth).toHaveBeenCalledWith(
      "AAPL",
      "Information Technology",
      ["PEER1", "PEER2", "PEER3"],
      NOW,
    );
  });

  it("caps analysis at COMPANY_SNAPSHOT_TICKER_CAP and notes the skipped tickers", async () => {
    const tickers = Array.from({ length: COMPANY_SNAPSHOT_TICKER_CAP + 2 }, (_, i) => `T${i}`);
    const result = await companySnapshotScanNode(makeState({ tickers }), NOW);

    expect(result.companySnapshots).toHaveLength(COMPANY_SNAPSHOT_TICKER_CAP);
    expect(
      result.companySnapshotErrors!.some(
        (e) => e.includes("skipped") && e.includes(`T${COMPANY_SNAPSHOT_TICKER_CAP}`),
      ),
    ).toBe(true);
  });

  it("isolates a single ticker's compute failure — the other tickers still get a real entry", async () => {
    mocks.computeCompanyProfile.mockImplementation(async (ticker: string) => {
      if (ticker === "AAPL") return { result: null, errors: ["AAPL: profile fetch failed"] };
      return {
        result: { sector: null, industry: null, marketCap: null, fullTimeEmployees: null, beta: null, dividendYieldPct: null, fiftyTwoWeekLow: null, fiftyTwoWeekHigh: null, trailingEps: null, forwardEps: null, analystTargetMeanPrice: null, analystRecommendationKey: null, reportedRevenueGrowthPct: null },
        errors: [],
      };
    });

    const result = await companySnapshotScanNode(makeState({ tickers: ["AAPL", "MSFT"] }), NOW);

    expect(result.companySnapshots).toHaveLength(2);
    expect(result.companySnapshots![0]!.profile).toBeNull(); // AAPL degraded honestly
    expect(result.companySnapshots![1]!.profile).not.toBeNull(); // MSFT unaffected
    expect(result.companySnapshotErrors).toContain("AAPL: profile fetch failed");
  });

  it("returns an honest empty result with no LLM-relevant data when no tickers were named", async () => {
    const result = await companySnapshotScanNode(makeState({ tickers: [] }), NOW);

    expect(result.companySnapshots).toEqual([]);
    expect(result.companySnapshotErrors!.length).toBeGreaterThan(0);
    expect(mocks.resolvePeerSample).not.toHaveBeenCalled();
  });

  it("never touches fields outside companySnapshots/companySnapshotErrors", async () => {
    const result = await companySnapshotScanNode(makeState(), NOW);
    expect(Object.keys(result).sort()).toEqual(["companySnapshotErrors", "companySnapshots"]);
  });
});
