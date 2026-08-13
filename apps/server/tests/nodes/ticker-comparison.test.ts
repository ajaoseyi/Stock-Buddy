/**
 * =============================================================================
 * tests/nodes/ticker-comparison.test.ts
 * =============================================================================
 *
 * `classifyTickerComparison` is the most important single function in the
 * ticker-comparison capability (§12.8) — same role as `classifyGrowthAuthenticity`
 * in `growth-classification.test.ts`. Exhaustively tests the fixed rank-count
 * decision table: this is the ONE place CLAUDE.md §9.1's narrow blending
 * carve-out applies, so its boundary is worth locking down precisely.
 */

import { describe, expect, it } from "vitest";
import type {
  CompanyProfileFacts,
  FinancialHealthResult,
  GrowthAuthenticityResult,
  PeerRelativeMetric,
  ValuationMetricsResult,
} from "../../src/state.js";
import {
  CLEAR_LEAD_THRESHOLD,
  COMPARISON_METRICS,
  classifyTickerComparison,
} from "../../src/nodes/capabilities/portfolio-scan/ticker-comparison.js";

// =============================================================================
// Fixture builders
// =============================================================================

function makeGrowthResult(ticker: string, revenueGrowthPct: number | null): GrowthAuthenticityResult {
  return {
    ticker,
    timeWindow: "1y",
    revenueGrowth: {
      ticker,
      latestQuarterEnd: "2026-06-30",
      revenueGrowthPct,
      basis: revenueGrowthPct === null ? "insufficient_data" : "yoy_quarterly",
    },
    discrepancy: {
      priceChangePct: null,
      priceToRevenueGrowthRatio: null,
      ratioZScore: null,
      baselineQuarterCount: 0,
      discrepancyFlag: "not_computable",
    },
    inorganic: {
      goodwillTrend: { deltaPct: null, zScore: null, baselineQuarterCount: 0, direction: "insufficient_data" },
      ppeTrend: { deltaPct: null, zScore: null, baselineQuarterCount: 0, direction: "insufficient_data" },
      cashTrend: { deltaPct: null, zScore: null, baselineQuarterCount: 0, direction: "insufficient_data" },
      inorganicSignal: "insufficient_data",
    },
    sectorBenchmark: {
      sector: null,
      sectorBenchmarkPct: null,
      stockVsSectorSpreadPct: null,
      macroBetaFlag: "not_computable",
    },
    classification: "insufficient_data",
    classificationReasonCodes: [],
  };
}

function makeMetric(
  metric: string,
  value: number | null,
  higherIsBetter: boolean,
): PeerRelativeMetric {
  return { metric, value, peerMedian: null, zScore: null, higherIsBetter, flag: "not_computable" };
}

const VALUATION_METRIC_NAMES = ["trailing_pe", "forward_pe", "price_to_book", "ev_to_ebitda"] as const;
const HEALTH_METRIC_NAMES = [
  "debt_to_equity",
  "current_ratio",
  "return_on_equity",
  "return_on_assets",
  "profit_margin",
  "fcf_margin",
] as const;

interface TickerFixtureValues {
  revenueGrowthPct: number | null;
  trailing_pe: number | null;
  forward_pe: number | null;
  price_to_book: number | null;
  ev_to_ebitda: number | null;
  debt_to_equity: number | null;
  current_ratio: number | null;
  return_on_equity: number | null;
  return_on_assets: number | null;
  profit_margin: number | null;
  fcf_margin: number | null;
}

function buildPerTickerEntry(ticker: string, values: TickerFixtureValues) {
  const valuation: ValuationMetricsResult = {
    sector: "Information Technology",
    peerCount: 10,
    metrics: VALUATION_METRIC_NAMES.map((name) => makeMetric(name, values[name], false)),
  };
  const financialHealth: FinancialHealthResult = {
    sector: "Information Technology",
    peerCount: 10,
    metrics: HEALTH_METRIC_NAMES.map((name) =>
      makeMetric(name, values[name], name !== "debt_to_equity"),
    ),
  };
  const profile: CompanyProfileFacts | null = null;

  return {
    growth: makeGrowthResult(ticker, values.revenueGrowthPct),
    snapshot: { profile, valuation, financialHealth },
  };
}

/** All 11 metrics favouring AAA over BBB, used as the base for the lead-margin tests. */
const AAA_FAVOURED: TickerFixtureValues = {
  revenueGrowthPct: 20, // higher is better -> AAA wins
  trailing_pe: 10, // lower is better -> AAA wins
  forward_pe: 9,
  price_to_book: 2,
  ev_to_ebitda: 8,
  debt_to_equity: 0.3,
  current_ratio: 2.5, // higher is better -> AAA wins
  return_on_equity: 0.25,
  return_on_assets: 0.15,
  profit_margin: 0.3,
  fcf_margin: 0.2,
};

const BBB_TRAILING: TickerFixtureValues = {
  revenueGrowthPct: 5,
  trailing_pe: 25,
  forward_pe: 22,
  price_to_book: 6,
  ev_to_ebitda: 18,
  debt_to_equity: 1.2,
  current_ratio: 1.1,
  return_on_equity: 0.08,
  return_on_assets: 0.04,
  profit_margin: 0.1,
  fcf_margin: 0.05,
};

// =============================================================================
// COMPARISON_METRICS shape
// =============================================================================

describe("COMPARISON_METRICS", () => {
  it("defines exactly 11 metrics", () => {
    expect(COMPARISON_METRICS).toHaveLength(11);
  });

  it("excludes price change and price/revenue discrepancy (§9.1)", () => {
    const names = COMPARISON_METRICS.map((m) => m.metric);
    expect(names).not.toContain("price_change_pct");
    expect(names).not.toContain("price_to_revenue_growth_ratio");
    expect(names).not.toContain("discrepancy");
  });

  it("marks every valuation multiple and debt_to_equity as higherIsBetter: false", () => {
    const lowerIsFavourable = ["trailing_pe", "forward_pe", "price_to_book", "ev_to_ebitda", "debt_to_equity"];
    for (const name of lowerIsFavourable) {
      const def = COMPARISON_METRICS.find((m) => m.metric === name);
      expect(def?.higherIsBetter).toBe(false);
    }
  });
});

// =============================================================================
// classifyTickerComparison — the decision table (§12.8)
// =============================================================================

describe("classifyTickerComparison", () => {
  it("clear_lead: one ticker wins more than half the comparable metrics more than the runner-up", () => {
    const perTicker = new Map([
      ["AAA", buildPerTickerEntry("AAA", AAA_FAVOURED)],
      ["BBB", buildPerTickerEntry("BBB", BBB_TRAILING)],
    ]);

    const result = classifyTickerComparison(["AAA", "BBB"], perTicker);

    expect(result.overallVerdict.comparableMetricCount).toBe(11);
    expect(result.overallVerdict.winCounts["AAA"]).toBe(11);
    expect(result.overallVerdict.winCounts["BBB"]).toBe(0);
    expect((11 - 0) / 11).toBeGreaterThanOrEqual(CLEAR_LEAD_THRESHOLD);
    expect(result.overallVerdict.verdict).toBe("clear_lead");
    expect(result.overallVerdict.strongerTicker).toBe("AAA");
  });

  it("narrow_lead: the leader's margin over the runner-up is below the clear-lead threshold", () => {
    // AAA wins 6, BBB wins 5 -> margin = (6-5)/11 ≈ 0.09, well under 0.5.
    const mixed: TickerFixtureValues = {
      ...AAA_FAVOURED,
      // Flip 5 of AAA's 11 wins to BBB's favour by making AAA's own values worse
      // than BBB's trailing fixture on 5 metrics.
      current_ratio: 0.9,
      return_on_equity: 0.02,
      return_on_assets: 0.01,
      profit_margin: 0.05,
      fcf_margin: 0.01,
    };
    const perTicker = new Map([
      ["AAA", buildPerTickerEntry("AAA", mixed)],
      ["BBB", buildPerTickerEntry("BBB", BBB_TRAILING)],
    ]);

    const result = classifyTickerComparison(["AAA", "BBB"], perTicker);

    expect(result.overallVerdict.winCounts["AAA"]).toBe(6);
    expect(result.overallVerdict.winCounts["BBB"]).toBe(5);
    expect(result.overallVerdict.verdict).toBe("narrow_lead");
    expect(result.overallVerdict.strongerTicker).toBe("AAA");
  });

  it("no_clear_leader: every comparable metric ties", () => {
    const perTicker = new Map([
      ["AAA", buildPerTickerEntry("AAA", AAA_FAVOURED)],
      ["BBB", buildPerTickerEntry("BBB", AAA_FAVOURED)],
    ]);

    const result = classifyTickerComparison(["AAA", "BBB"], perTicker);

    expect(result.overallVerdict.winCounts["AAA"]).toBe(0);
    expect(result.overallVerdict.winCounts["BBB"]).toBe(0);
    expect(result.overallVerdict.verdict).toBe("no_clear_leader");
    expect(result.overallVerdict.strongerTicker).toBeNull();
  });

  it("no_clear_leader: the top spot is itself tied between two tickers (3-way)", () => {
    // AAA wins 5 metrics outright (revenue growth + the 4 valuation
    // multiples), BBB wins the OTHER 5 (debt/equity + the 4 return/margin
    // metrics), CCC never has the best value on any of those 10, and the
    // 11th metric (fcf_margin) ties 3-way so nobody wins it. Net: AAA=5,
    // BBB=5, CCC=0 — a genuine tied-for-first result, not a same-value tie.
    const aaa: TickerFixtureValues = {
      revenueGrowthPct: 30,
      trailing_pe: 5,
      forward_pe: 5,
      price_to_book: 1,
      ev_to_ebitda: 4,
      debt_to_equity: 5,
      current_ratio: 0.5,
      return_on_equity: 0.01,
      return_on_assets: 0.01,
      profit_margin: 0.01,
      fcf_margin: 0.1,
    };
    const bbb: TickerFixtureValues = {
      revenueGrowthPct: 5,
      trailing_pe: 20,
      forward_pe: 20,
      price_to_book: 5,
      ev_to_ebitda: 15,
      debt_to_equity: 0.2,
      current_ratio: 3.0,
      return_on_equity: 0.3,
      return_on_assets: 0.2,
      profit_margin: 0.35,
      fcf_margin: 0.1,
    };
    const ccc: TickerFixtureValues = {
      revenueGrowthPct: 1,
      trailing_pe: 30,
      forward_pe: 30,
      price_to_book: 8,
      ev_to_ebitda: 20,
      debt_to_equity: 3.0,
      current_ratio: 0.3,
      return_on_equity: 0.01,
      return_on_assets: 0.01,
      profit_margin: 0.01,
      fcf_margin: 0.1,
    };
    const perTicker = new Map([
      ["AAA", buildPerTickerEntry("AAA", aaa)],
      ["BBB", buildPerTickerEntry("BBB", bbb)],
      ["CCC", buildPerTickerEntry("CCC", ccc)],
    ]);

    const result = classifyTickerComparison(["AAA", "BBB", "CCC"], perTicker);

    expect(result.overallVerdict.winCounts["AAA"]).toBe(5);
    expect(result.overallVerdict.winCounts["BBB"]).toBe(5);
    expect(result.overallVerdict.winCounts["CCC"]).toBe(0);
    expect(result.overallVerdict.verdict).toBe("no_clear_leader");
    expect(result.overallVerdict.strongerTicker).toBeNull();
  });

  it("insufficient_comparable_data: no metric has a value for every compared ticker", () => {
    const allNull: TickerFixtureValues = {
      revenueGrowthPct: null,
      trailing_pe: null,
      forward_pe: null,
      price_to_book: null,
      ev_to_ebitda: null,
      debt_to_equity: null,
      current_ratio: null,
      return_on_equity: null,
      return_on_assets: null,
      profit_margin: null,
      fcf_margin: null,
    };
    const perTicker = new Map([
      ["AAA", buildPerTickerEntry("AAA", AAA_FAVOURED)],
      ["BBB", buildPerTickerEntry("BBB", allNull)],
    ]);

    const result = classifyTickerComparison(["AAA", "BBB"], perTicker);

    expect(result.overallVerdict.comparableMetricCount).toBe(0);
    expect(result.overallVerdict.verdict).toBe("insufficient_comparable_data");
    expect(result.overallVerdict.strongerTicker).toBeNull();
  });

  it("a metric missing for just ONE ticker is excluded from comparableMetricCount, not guessed", () => {
    const partial: TickerFixtureValues = { ...BBB_TRAILING, trailing_pe: null };
    const perTicker = new Map([
      ["AAA", buildPerTickerEntry("AAA", AAA_FAVOURED)],
      ["BBB", buildPerTickerEntry("BBB", partial)],
    ]);

    const result = classifyTickerComparison(["AAA", "BBB"], perTicker);

    expect(result.overallVerdict.comparableMetricCount).toBe(10);
    const trailingPeRank = result.metricRanks.find((r) => r.metric === "trailing_pe")!;
    expect(trailingPeRank.winner).toBeNull();
  });

  it("keeps every underlying metric value disaggregated in metricRanks alongside the verdict (§9.1)", () => {
    const perTicker = new Map([
      ["AAA", buildPerTickerEntry("AAA", AAA_FAVOURED)],
      ["BBB", buildPerTickerEntry("BBB", BBB_TRAILING)],
    ]);

    const result = classifyTickerComparison(["AAA", "BBB"], perTicker);

    expect(result.metricRanks).toHaveLength(11);
    const trailingPeRank = result.metricRanks.find((r) => r.metric === "trailing_pe")!;
    expect(trailingPeRank.values).toEqual([
      { ticker: "AAA", value: AAA_FAVOURED.trailing_pe },
      { ticker: "BBB", value: BBB_TRAILING.trailing_pe },
    ]);
    // Lower trailing P/E is favourable -> AAA (10) beats BBB (25).
    expect(trailingPeRank.winner).toBe("AAA");
  });

  it("never combines the underlying numeric values into a single blended score (§9.1)", () => {
    // Structural guard: the verdict object must never carry a bare numeric
    // "score" field — only categorical verdict/strongerTicker plus integer
    // win tallies, per the §9.1 carve-out's boundary.
    const perTicker = new Map([
      ["AAA", buildPerTickerEntry("AAA", AAA_FAVOURED)],
      ["BBB", buildPerTickerEntry("BBB", BBB_TRAILING)],
    ]);

    const result = classifyTickerComparison(["AAA", "BBB"], perTicker);

    expect(Object.keys(result.overallVerdict).sort()).toEqual(
      ["comparableMetricCount", "strongerTicker", "verdict", "winCounts"].sort(),
    );
  });
});
