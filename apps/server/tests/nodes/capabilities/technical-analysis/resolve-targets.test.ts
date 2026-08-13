/**
 * =============================================================================
 * tests/nodes/capabilities/technical-analysis/resolve-targets.test.ts
 * =============================================================================
 */

import { describe, expect, it } from "vitest";
import { resolveTechnicalAnalysisTargets } from "../../../../src/nodes/capabilities/technical-analysis/resolve-targets.js";
import { TECHNICAL_ANALYSIS_TICKER_CAP } from "../../../../src/nodes/capabilities/technical-analysis/constants.js";

describe("resolveTechnicalAnalysisTargets", () => {
  it("tickers take priority over sectors when both are named", () => {
    const { targets } = resolveTechnicalAnalysisTargets(["NVDA"], ["Information Technology"]);
    expect(targets).toEqual([{ symbol: "NVDA", requestedAs: "ticker", sectorName: null }]);
  });

  it("resolves a sector-only request to its ETF ticker", () => {
    const { targets, errors } = resolveTechnicalAnalysisTargets([], ["Information Technology"]);
    expect(targets).toEqual([
      { symbol: "XLK", requestedAs: "sector_etf", sectorName: "Information Technology" },
    ]);
    expect(errors).toEqual([]);
  });

  it("supports multiple tickers at once, in the order named", () => {
    const { targets } = resolveTechnicalAnalysisTargets(["NVDA", "AMD"], []);
    expect(targets.map((t) => t.symbol)).toEqual(["NVDA", "AMD"]);
  });

  it("caps at TECHNICAL_ANALYSIS_TICKER_CAP and reports the rest as skipped", () => {
    const tickers = Array.from({ length: TECHNICAL_ANALYSIS_TICKER_CAP + 2 }, (_, i) => `T${i}`);
    const { targets, skipped } = resolveTechnicalAnalysisTargets(tickers, []);
    expect(targets).toHaveLength(TECHNICAL_ANALYSIS_TICKER_CAP);
    expect(skipped).toEqual(tickers.slice(TECHNICAL_ANALYSIS_TICKER_CAP));
  });

  it("returns nothing, no error, when neither tickers nor sectors were named", () => {
    const { targets, skipped, errors } = resolveTechnicalAnalysisTargets([], []);
    expect(targets).toEqual([]);
    expect(skipped).toEqual([]);
    expect(errors).toEqual([]);
  });
});
