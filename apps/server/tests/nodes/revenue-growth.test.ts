/**
 * =============================================================================
 * tests/nodes/revenue-growth.test.ts
 * =============================================================================
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState } from "../../src/state.js";

const mocks = vi.hoisted(() => ({
  fetchQuarterlyFinancials: vi.fn(),
}));

vi.mock("../../src/tools/yahoo-finance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/yahoo-finance.js")>();
  return { ...actual, fetchQuarterlyFinancials: mocks.fetchQuarterlyFinancials };
});

const { revenueGrowthNode, computeRevenueGrowth, findYoyPriorRow, usableRevenueRows } =
  await import("../../src/nodes/capabilities/growth-authenticity/revenue-growth.js");

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
    revenueGrowth: null,
    priceRevenueDiscrepancy: null,
    inorganicSignal: null,
    sectorBenchmark: null,
    growthAuthenticity: null,
    growthCheckErrors: [],
    dataErrors: [],
    draftReport: null,
    validationPassed: false,
    validationNotes: [],
    finalReport: null,
    retryCount: 0,
    ...overrides,
  };
}

/** Quarterly rows spaced exactly one quarter (91 days) apart, oldest first. */
function quarterlyRows(
  revenues: number[],
  startDate = "2024-01-31",
): { date: Date; totalRevenue: number }[] {
  const start = new Date(startDate);
  return revenues.map((totalRevenue, i) => ({
    date: new Date(start.getTime() + i * 91 * 24 * 60 * 60 * 1000),
    totalRevenue,
  }));
}

beforeEach(() => {
  mocks.fetchQuarterlyFinancials.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("usableRevenueRows / findYoyPriorRow", () => {
  it("filters out rows with an undefined totalRevenue and sorts ascending", () => {
    const rows = usableRevenueRows([
      { date: new Date("2026-01-01"), totalRevenue: 200 },
      { date: new Date("2025-01-01") },
      { date: new Date("2025-06-01"), totalRevenue: 100 },
    ] as never);
    expect(rows.map((r) => r.totalRevenue)).toEqual([100, 200]);
  });

  it("finds the row ~365 days earlier within the tolerance band", () => {
    const rows = quarterlyRows([100, 105, 110, 115, 130]);
    const prior = findYoyPriorRow(rows, 4);
    expect(prior?.totalRevenue).toBe(100);
  });

  it("returns null when no row falls within the tolerance band (a missing quarter)", () => {
    const rows = [
      { date: new Date("2025-01-01"), totalRevenue: 100 },
      { date: new Date("2026-06-01"), totalRevenue: 150 }, // ~17 months later, not ~12
    ];
    expect(findYoyPriorRow(rows, 1)).toBeNull();
  });
});

describe("computeRevenueGrowth", () => {
  it("computes positive YoY growth from the latest quarter vs. ~1 year prior", () => {
    const rows = quarterlyRows([100, 102, 104, 106, 120]);
    const result = computeRevenueGrowth("NVDA", rows);
    expect(result.basis).toBe("yoy_quarterly");
    expect(result.revenueGrowthPct).toBeCloseTo(20, 5);
  });

  it("reports a genuine revenue DECLINE as a real result, not insufficient_data", () => {
    const rows = quarterlyRows([100, 95, 90, 85, 70]);
    const result = computeRevenueGrowth("NVDA", rows);
    expect(result.basis).toBe("yoy_quarterly");
    expect(result.revenueGrowthPct).toBeCloseTo(-30, 5);
  });

  it("is insufficient_data when there's no prior-year quarter to compare against", () => {
    const rows = quarterlyRows([100, 102]); // only ~3 months of history
    const result = computeRevenueGrowth("NVDA", rows);
    expect(result.basis).toBe("insufficient_data");
    expect(result.revenueGrowthPct).toBeNull();
  });

  it("is insufficient_data when there are no usable rows at all", () => {
    const result = computeRevenueGrowth("NVDA", []);
    expect(result.basis).toBe("insufficient_data");
    expect(result.latestQuarterEnd).toBeNull();
  });
});

describe("revenueGrowthNode", () => {
  it("writes revenueGrowth and never touches unrelated fields", async () => {
    mocks.fetchQuarterlyFinancials.mockResolvedValue(quarterlyRows([100, 102, 104, 106, 120]));
    const result = await revenueGrowthNode(makeState(), NOW);

    expect(result.revenueGrowth?.ticker).toBe("NVDA");
    expect(result.revenueGrowth?.revenueGrowthPct).toBeCloseTo(20, 5);
    expect(Object.keys(result).sort()).toEqual(["growthCheckErrors", "revenueGrowth"]);
  });

  it("returns null and a note when there is no ticker", async () => {
    const result = await revenueGrowthNode(makeState({ tickers: [] }), NOW);
    expect(result.revenueGrowth).toBeNull();
    expect(result.growthCheckErrors?.some((e) => e.includes("no ticker"))).toBe(true);
  });

  it("notes skipped tickers when more than one is present, but still analyses tickers[0]", async () => {
    mocks.fetchQuarterlyFinancials.mockResolvedValue(quarterlyRows([100, 102, 104, 106, 120]));
    const result = await revenueGrowthNode(makeState({ tickers: ["AAPL", "MSFT"] }), NOW);
    expect(result.revenueGrowth?.ticker).toBe("AAPL");
    expect(result.growthCheckErrors?.some((e) => e.includes("MSFT"))).toBe(true);
  });

  it("degrades to insufficient_data with a note when the fetch throws", async () => {
    mocks.fetchQuarterlyFinancials.mockRejectedValue(new Error("network down"));
    const result = await revenueGrowthNode(makeState(), NOW);

    expect(result.revenueGrowth?.basis).toBe("insufficient_data");
    expect(result.growthCheckErrors?.some((e) => e.includes("network down"))).toBe(true);
  });

  it("never throws — a fetch failure degrades instead of crashing the graph", async () => {
    mocks.fetchQuarterlyFinancials.mockRejectedValue(new Error("boom"));
    await expect(revenueGrowthNode(makeState(), NOW)).resolves.toBeDefined();
  });
});
