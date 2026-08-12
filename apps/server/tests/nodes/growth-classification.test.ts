/**
 * =============================================================================
 * tests/nodes/growth-classification.test.ts
 * =============================================================================
 *
 * `classifyGrowthAuthenticity` is the most important single function in the
 * growth-authenticity capability — same role as `classifyQuadrant` in
 * `sector-leaders.test.ts`. Exhaustively tests the decision table, plus a
 * named regression test asserting the APA/oil-price example from the original
 * feedback: a high price/revenue ratio alone, without a `stock_specific_move`
 * flag, must NOT read as "unexplained".
 */

import { describe, expect, it } from "vitest";
import type { AgentState, GrowthAuthenticityResult } from "../../src/state.js";
import {
  classifyGrowthAuthenticity,
  growthClassificationNode,
} from "../../src/nodes/capabilities/growth-authenticity/growth-classification.js";

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

describe("classifyGrowthAuthenticity — the decision table", () => {
  it("all three unknown → insufficient_data", () => {
    const { classification } = classifyGrowthAuthenticity(
      "not_computable",
      "insufficient_data",
      "not_computable",
    );
    expect(classification).toBe("insufficient_data");
  });

  it("insufficient_history counts as unknown alongside not_computable → insufficient_data", () => {
    // REGRESSION: before the live-calibration fix, a missing ratio baseline
    // silently read as "aligned" (a confident "no discrepancy" claim) rather
    // than an honest "we don't know". This locks in the corrected behavior.
    const { classification } = classifyGrowthAuthenticity(
      "insufficient_history",
      "insufficient_data",
      "not_computable",
    );
    expect(classification).toBe("insufficient_data");
  });

  it("insufficient_history is never treated as organic_growth_supported", () => {
    const { classification } = classifyGrowthAuthenticity(
      "insufficient_history",
      "no_signal",
      "stock_specific_move",
    );
    expect(classification).not.toBe("organic_growth_supported");
    expect(classification).toBe("mixed_signals");
  });

  it("sector-beta evidence still applies even when the ratio baseline is insufficient", () => {
    const { classification } = classifyGrowthAuthenticity(
      "insufficient_history",
      "no_signal",
      "beta_explained",
    );
    expect(classification).toBe("macro_or_commodity_beta_driven");
  });

  it("goodwill/PP&E jump wins outright, regardless of the other two flags", () => {
    const { classification } = classifyGrowthAuthenticity(
      "aligned",
      "likely_ma_driven",
      "beta_explained",
    );
    expect(classification).toBe("inorganic_ma_driven");
  });

  it("beta_explained (no M&A signal, discrepancy not revenue-led) → macro/commodity beta", () => {
    const { classification } = classifyGrowthAuthenticity(
      "price_outpacing_revenue",
      "no_signal",
      "beta_explained",
    );
    expect(classification).toBe("macro_or_commodity_beta_driven");
  });

  it(
    "REGRESSION (APA/oil-price case): a high price/revenue ratio alone, without a " +
      "stock_specific_move flag, must NOT read as unexplained — it's macro-driven",
    () => {
      const { classification } = classifyGrowthAuthenticity(
        "price_outpacing_revenue",
        "no_signal",
        "beta_explained",
      );
      expect(classification).not.toBe("price_outpacing_fundamentals_unexplained");
      expect(classification).toBe("macro_or_commodity_beta_driven");
    },
  );

  it("price outpacing revenue + stock-specific move → unexplained (the illusion-of-growth case)", () => {
    const { classification } = classifyGrowthAuthenticity(
      "price_outpacing_revenue",
      "no_signal",
      "stock_specific_move",
    );
    expect(classification).toBe("price_outpacing_fundamentals_unexplained");
  });

  it("aligned discrepancy, no other signal → organic growth supported", () => {
    const { classification } = classifyGrowthAuthenticity(
      "aligned",
      "no_signal",
      "stock_specific_move",
    );
    expect(classification).toBe("organic_growth_supported");
  });

  it("revenue outpacing price → organic growth supported even if not_computable elsewhere", () => {
    const { classification } = classifyGrowthAuthenticity(
      "revenue_outpacing_price",
      "insufficient_data",
      "not_computable",
    );
    expect(classification).toBe("organic_growth_supported");
  });

  it("revenue outpacing price is never demoted to beta-driven just because beta_explained is true", () => {
    const { classification } = classifyGrowthAuthenticity(
      "revenue_outpacing_price",
      "no_signal",
      "beta_explained",
    );
    expect(classification).toBe("organic_growth_supported");
  });

  it("not_computable discrepancy + stock_specific_move + no_signal → mixed_signals fallback", () => {
    const { classification } = classifyGrowthAuthenticity(
      "not_computable",
      "no_signal",
      "stock_specific_move",
    );
    expect(classification).toBe("mixed_signals");
  });

  it("always includes machine-readable reason codes for all three inputs", () => {
    const { reasonCodes } = classifyGrowthAuthenticity("aligned", "no_signal", "beta_explained");
    expect(reasonCodes).toEqual([
      "discrepancy:aligned",
      "inorganic_signal:no_signal",
      "macro_beta:beta_explained",
    ]);
  });
});

describe("growthClassificationNode", () => {
  const FULL: Pick<
    AgentState,
    "revenueGrowth" | "priceRevenueDiscrepancy" | "inorganicSignal" | "sectorBenchmark"
  > = {
    revenueGrowth: {
      ticker: "APA",
      latestQuarterEnd: "2026-06-30",
      revenueGrowthPct: 2.1,
      basis: "yoy_quarterly",
    },
    priceRevenueDiscrepancy: {
      priceChangePct: 41.2,
      priceToRevenueGrowthRatio: 19.6,
      ratioZScore: 2.8,
      baselineQuarterCount: 8,
      discrepancyFlag: "price_outpacing_revenue",
    },
    inorganicSignal: {
      goodwillTrend: {
        deltaPct: null,
        zScore: null,
        baselineQuarterCount: 0,
        direction: "insufficient_data",
      },
      ppeTrend: {
        deltaPct: null,
        zScore: null,
        baselineQuarterCount: 0,
        direction: "insufficient_data",
      },
      cashTrend: {
        deltaPct: null,
        zScore: null,
        baselineQuarterCount: 0,
        direction: "insufficient_data",
      },
      inorganicSignal: "no_signal",
    },
    sectorBenchmark: {
      sector: "Energy",
      sectorBenchmarkPct: 38.9,
      stockVsSectorSpreadPct: 2.3,
      macroBetaFlag: "beta_explained",
    },
  };

  it("assembles the full result when all four upstream fields are populated", async () => {
    const result = await growthClassificationNode(makeState(FULL));
    const g = result.growthAuthenticity as GrowthAuthenticityResult;

    expect(g.ticker).toBe("APA");
    expect(g.timeWindow).toBe("1y");
    expect(g.classification).toBe("macro_or_commodity_beta_driven");
    expect(g.revenueGrowth).toBe(FULL.revenueGrowth);
    expect(g.discrepancy).toBe(FULL.priceRevenueDiscrepancy);
    expect(g.inorganic).toBe(FULL.inorganicSignal);
    expect(g.sectorBenchmark).toBe(FULL.sectorBenchmark);
  });

  it("returns null when any upstream node hasn't run yet", async () => {
    const result = await growthClassificationNode(makeState({ ...FULL, sectorBenchmark: null }));
    expect(result.growthAuthenticity).toBeNull();
  });

  it("returns null when there is no ticker to classify", async () => {
    const result = await growthClassificationNode(makeState({ ...FULL, tickers: [] }));
    expect(result.growthAuthenticity).toBeNull();
  });

  it("never touches any field outside growthAuthenticity", async () => {
    const result = await growthClassificationNode(makeState(FULL));
    expect(Object.keys(result)).toEqual(["growthAuthenticity"]);
  });
});
