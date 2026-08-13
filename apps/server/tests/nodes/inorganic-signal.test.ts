/**
 * =============================================================================
 * tests/nodes/inorganic-signal.test.ts
 * =============================================================================
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState, Trend } from "../../src/state.js";

const mocks = vi.hoisted(() => ({
  fetchQuarterlyBalanceSheet: vi.fn(),
}));

vi.mock("../../src/tools/yahoo-finance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/yahoo-finance.js")>();
  return { ...actual, fetchQuarterlyBalanceSheet: mocks.fetchQuarterlyBalanceSheet };
});

const { inorganicSignalNode, computeTrend, classifyInorganicSignal, extractField } =
  await import("../../src/nodes/capabilities/growth-authenticity/inorganic-signal.js");

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

/** Quarterly balance-sheet rows spaced 91 days apart, oldest first. */
function quarterlyRows(
  values: (number | undefined)[],
  field: "goodwill" | "netPPE" | "cashAndCashEquivalents",
  startDate = "2024-01-31",
) {
  const start = new Date(startDate);
  return values.map((value, i) => ({
    date: new Date(start.getTime() + i * 91 * 24 * 60 * 60 * 1000),
    ...(value !== undefined ? { [field]: value } : {}),
  }));
}

beforeEach(() => {
  mocks.fetchQuarterlyBalanceSheet.mockReset();
});

describe("extractField", () => {
  it("pulls one field, drops rows missing it, sorts ascending", () => {
    const rows = [
      { date: new Date("2026-01-01"), goodwill: 500 },
      { date: new Date("2025-01-01") },
      { date: new Date("2025-06-01"), goodwill: 300 },
    ];
    expect(extractField(rows as never, "goodwill")).toEqual([
      { date: new Date("2025-06-01"), value: 300 },
      { date: new Date("2026-01-01"), value: 500 },
    ]);
  });
});

describe("computeTrend", () => {
  it("is insufficient_data with fewer than 2 usable quarters", () => {
    const trend = computeTrend(extractField(quarterlyRows([100], "goodwill") as never, "goodwill"));
    expect(trend.direction).toBe("insufficient_data");
  });

  it("detects a steady/flat trend as 'flat', not 'increasing' — avoids labelling noise", () => {
    const rows = quarterlyRows([100, 100.5, 101, 100.8, 101.2, 100.9], "goodwill");
    const trend: Trend = computeTrend(extractField(rows as never, "goodwill"));
    expect(trend.direction).toBe("flat");
  });

  it("detects a genuine jump as 'increasing' with a high z-score against its own history", () => {
    // Eight normal ~1% QoQ quarters (giving 6+ historical deltas to baseline
    // against, per MIN_BASELINE_QUARTERS), then a sudden acquisition-sized jump.
    const rows = quarterlyRows([100, 101, 102, 101, 103, 102, 104, 103, 250], "goodwill");
    const trend = computeTrend(extractField(rows as never, "goodwill"));
    expect(trend.direction).toBe("increasing");
    expect(trend.zScore).not.toBeNull();
    expect(trend.zScore!).toBeGreaterThan(2);
  });
});

describe("classifyInorganicSignal — goodwill primary, PP&E only corroborating", () => {
  const insufficient: Trend = {
    deltaPct: null,
    zScore: null,
    baselineQuarterCount: 0,
    direction: "insufficient_data",
  };

  it("is insufficient_data when both goodwill and PP&E are insufficient_data", () => {
    expect(classifyInorganicSignal(insufficient, insufficient, insufficient)).toBe(
      "insufficient_data",
    );
  });

  it("goodwill jump alone (no PP&E/cash corroboration) is enough — the primary signal", () => {
    const goodwillJump: Trend = {
      deltaPct: 40,
      zScore: 3,
      baselineQuarterCount: 6,
      direction: "increasing",
    };
    const flatPpe: Trend = { deltaPct: 1, zScore: 0.1, baselineQuarterCount: 6, direction: "flat" };
    const flatCash: Trend = {
      deltaPct: 0.5,
      zScore: 0.1,
      baselineQuarterCount: 6,
      direction: "flat",
    };
    expect(classifyInorganicSignal(goodwillJump, flatPpe, flatCash)).toBe("likely_ma_driven");
  });

  it("PP&E jump WITHOUT a cash decrease is NOT enough on its own (ordinary organic capex)", () => {
    const flatGoodwill: Trend = {
      deltaPct: 0,
      zScore: 0,
      baselineQuarterCount: 6,
      direction: "flat",
    };
    const ppeJump: Trend = {
      deltaPct: 35,
      zScore: 3,
      baselineQuarterCount: 6,
      direction: "increasing",
    };
    const increasingCash: Trend = {
      deltaPct: 5,
      zScore: 0.5,
      baselineQuarterCount: 6,
      direction: "increasing",
    };
    expect(classifyInorganicSignal(flatGoodwill, ppeJump, increasingCash)).toBe("no_signal");
  });

  it("PP&E jump WITH a simultaneous cash decrease is the corroborating M&A pattern", () => {
    const flatGoodwill: Trend = {
      deltaPct: 0,
      zScore: 0,
      baselineQuarterCount: 6,
      direction: "flat",
    };
    const ppeJump: Trend = {
      deltaPct: 35,
      zScore: 3,
      baselineQuarterCount: 6,
      direction: "increasing",
    };
    const decreasingCash: Trend = {
      deltaPct: -20,
      zScore: -2,
      baselineQuarterCount: 6,
      direction: "decreasing",
    };
    expect(classifyInorganicSignal(flatGoodwill, ppeJump, decreasingCash)).toBe("likely_ma_driven");
  });

  it("no jump anywhere → no_signal", () => {
    const flat: Trend = { deltaPct: 1, zScore: 0.2, baselineQuarterCount: 6, direction: "flat" };
    expect(classifyInorganicSignal(flat, flat, flat)).toBe("no_signal");
  });
});

describe("inorganicSignalNode", () => {
  it("writes inorganicSignal and never touches unrelated fields", async () => {
    mocks.fetchQuarterlyBalanceSheet.mockResolvedValue([
      ...quarterlyRows([100, 101, 102, 101, 103, 102, 250], "goodwill"),
    ]);
    const result = await inorganicSignalNode(makeState(), NOW);
    expect(result.inorganicSignal).not.toBeNull();
    expect(Object.keys(result).sort()).toEqual(["growthCheckErrors", "inorganicSignal"]);
  });

  it("returns null when there is no ticker", async () => {
    const result = await inorganicSignalNode(makeState({ tickers: [] }), NOW);
    expect(result.inorganicSignal).toBeNull();
  });

  it("degrades to insufficient_data with a note when the fetch throws", async () => {
    mocks.fetchQuarterlyBalanceSheet.mockRejectedValue(new Error("no coverage"));
    const result = await inorganicSignalNode(makeState(), NOW);
    expect(result.inorganicSignal?.inorganicSignal).toBe("insufficient_data");
    expect(result.growthCheckErrors?.some((e) => e.includes("no coverage"))).toBe(true);
  });
});
