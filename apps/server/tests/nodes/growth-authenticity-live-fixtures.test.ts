/**
 * =============================================================================
 * tests/nodes/growth-authenticity-live-fixtures.test.ts
 * =============================================================================
 *
 * Locks in the behavior found during live calibration (CLAUDE.md §11.9)
 * against REAL captured API responses (`tests/fixtures/yahoo-*-apa.json`,
 * `-cost.json` — captured via `capture.mjs growth-authenticity`), so a future
 * change can't silently regress the fix without a test noticing.
 *
 * Two real findings this test exists to guard:
 *   1. APA's real price/revenue ratio (~12.6x — price +113%, revenue +9%)
 *      must report `discrepancyFlag: "insufficient_history"`, never the old
 *      silent `"aligned"` default that hid it.
 *   2. Goodwill is genuinely `undefined` in Yahoo's real balance-sheet data
 *      for both tickers tested — `goodwillTrend.direction` must stay
 *      `"insufficient_data"` rather than something papering over the gap.
 *
 * The sector-benchmark peer sample is NOT captured as a fixture (it would
 * need ~10 more real tickers per sector) — `fetchEtfHoldings` is mocked to
 * return no holdings here, which deterministically exercises the documented
 * graceful-degradation path (`macroBetaFlag: "stock_specific_move"`) rather
 * than reproducing the exact peer-relative number from the live run.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentStateSchema, type AgentState } from "../../src/state.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "fixtures");

function loadJson(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
}

/** Recursively parse ISO date strings back into real `Date` objects. */
function reviveDates<T>(value: T): T {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return new Date(value) as unknown as T;
  }
  if (Array.isArray(value)) return value.map(reviveDates) as unknown as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, reviveDates(v)]),
    ) as T;
  }
  return value;
}

function loadFixture(name: string): unknown {
  return reviveDates(loadJson(name));
}

const mocks = vi.hoisted(() => ({
  fetchQuarterlyFinancials: vi.fn(),
  fetchQuarterlyBalanceSheet: vi.fn(),
  fetchConstituentOhlcv: vi.fn(),
  fetchCompanySector: vi.fn(),
  fetchSectorEtfHistory: vi.fn(),
  fetchEtfHoldings: vi.fn(),
}));

vi.mock("../../src/tools/yahoo-finance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/yahoo-finance.js")>();
  return {
    ...actual,
    fetchQuarterlyFinancials: mocks.fetchQuarterlyFinancials,
    fetchQuarterlyBalanceSheet: mocks.fetchQuarterlyBalanceSheet,
    fetchConstituentOhlcv: mocks.fetchConstituentOhlcv,
    fetchCompanySector: mocks.fetchCompanySector,
    fetchSectorEtfHistory: mocks.fetchSectorEtfHistory,
  };
});

vi.mock("../../src/tools/etf-holdings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/etf-holdings.js")>();
  return { ...actual, fetchEtfHoldings: mocks.fetchEtfHoldings };
});

const { revenueGrowthNode } =
  await import("../../src/nodes/capabilities/growth-authenticity/revenue-growth.js");
const { priceRevenueDiscrepancyNode } =
  await import("../../src/nodes/capabilities/growth-authenticity/price-revenue-discrepancy.js");
const { inorganicSignalNode } =
  await import("../../src/nodes/capabilities/growth-authenticity/inorganic-signal.js");
const { sectorBenchmarkNode } =
  await import("../../src/nodes/capabilities/growth-authenticity/sector-benchmark.js");
const { growthClassificationNode } =
  await import("../../src/nodes/capabilities/growth-authenticity/growth-classification.js");

const NOW = new Date("2026-08-11T00:00:00Z");

function makeState(ticker: string): AgentState {
  return AgentStateSchema.parse({
    messages: [],
    tickers: [ticker],
    intent: "single_report",
    timeWindow: "1y",
    activeCapabilities: ["growth_authenticity"],
  }) as AgentState;
}

async function runPipeline(ticker: string): Promise<AgentState> {
  let state = makeState(ticker);
  state = { ...state, ...(await revenueGrowthNode(state, NOW)) };
  state = { ...state, ...(await priceRevenueDiscrepancyNode(state, NOW)) };
  state = { ...state, ...(await inorganicSignalNode(state, NOW)) };
  state = { ...state, ...(await sectorBenchmarkNode(state, NOW)) };
  state = { ...state, ...(await growthClassificationNode(state)) };
  return state;
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();

  mocks.fetchConstituentOhlcv.mockImplementation(async (ticker: string, timeWindow: string) => {
    const suffix = timeWindow === "5y" ? "5y" : "1y";
    return loadFixture(`yahoo-chart-${ticker.toLowerCase()}-${suffix}`);
  });
  mocks.fetchSectorEtfHistory.mockResolvedValue({
    meta: { symbol: "XLE" },
    quotes: [
      { date: new Date("2025-08-01"), close: 100 },
      { date: new Date("2026-08-01"), close: 100 },
    ],
  });
  // No peer fixtures captured — deterministically exercises the documented
  // graceful-degradation path (see file header) rather than the exact
  // peer-relative number observed in the live calibration run.
  mocks.fetchEtfHoldings.mockResolvedValue({
    holdings: [],
    source: "market_cap",
    warnings: [],
    isPartial: true,
  });
});

describe.each([
  { ticker: "APA", label: "APA (M&A/commodity case)" },
  { ticker: "COST", label: "COST (organic-growth case)" },
])("growth-authenticity pipeline against real captured data — $label", ({ ticker }) => {
  beforeEach(() => {
    const lower = ticker.toLowerCase();
    mocks.fetchQuarterlyFinancials.mockResolvedValue(
      loadFixture(`yahoo-fundamentals-financials-${lower}`),
    );
    mocks.fetchQuarterlyBalanceSheet.mockResolvedValue(
      loadFixture(`yahoo-fundamentals-balance-sheet-${lower}`),
    );
    mocks.fetchCompanySector.mockResolvedValue(loadFixture(`yahoo-assetprofile-${lower}`));
  });

  it("computes a real positive YoY revenue growth figure", async () => {
    const state = await runPipeline(ticker);
    expect(state.revenueGrowth?.basis).toBe("yoy_quarterly");
    expect(state.revenueGrowth?.revenueGrowthPct).not.toBeNull();
  });

  it(
    "REGRESSION: reports insufficient_history for the price/revenue ratio baseline, " +
      "never the old silent 'aligned' default — Yahoo's real quarterly depth (~5 usable " +
      "quarters) cannot satisfy a YoY-spaced baseline",
    async () => {
      const state = await runPipeline(ticker);
      expect(state.priceRevenueDiscrepancy?.discrepancyFlag).toBe("insufficient_history");
      expect(state.priceRevenueDiscrepancy?.baselineQuarterCount).toBe(0);
      // The raw ratio itself IS still reported — only the "is it unusual"
      // judgement is withheld, per the case matrix.
      expect(state.priceRevenueDiscrepancy?.priceToRevenueGrowthRatio).not.toBeNull();
    },
  );

  it(
    "REGRESSION: goodwill is genuinely absent from Yahoo's real balance-sheet data " +
      "for this ticker — stays insufficient_data, not a fabricated zero",
    async () => {
      const state = await runPipeline(ticker);
      expect(state.inorganicSignal?.goodwillTrend.direction).toBe("insufficient_data");
    },
  );

  it("produces a real classification without crashing the pipeline", async () => {
    const state = await runPipeline(ticker);
    expect(state.growthAuthenticity).not.toBeNull();
    expect(state.growthAuthenticity?.classification).not.toBe("insufficient_data");
    expect(state.growthCheckErrors.length).toBeGreaterThan(0); // at least the baseline note
  });
});
