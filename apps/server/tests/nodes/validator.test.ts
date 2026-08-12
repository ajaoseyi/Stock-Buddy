/**
 * tests/nodes/validator.test.ts — §5.6
 *
 * This node is where §1 ("the LLM never computes a number") is actually
 * enforced, so these tests are adversarial: they feed the validator prose
 * containing exactly the mistakes a model plausibly makes — a hallucinated
 * ticker, a fabricated percentage, and a CORRECT number that was nonetheless
 * derived rather than supplied.
 */

import { describe, expect, it } from "vitest";
import type {
  AgentState,
  GrowthAuthenticityResult,
  SectorLeader,
  SectorRanking,
} from "../../src/state.js";
import {
  PERCENTAGE_TOLERANCE,
  checkClassificationNarrated,
  collectGrowthKnownValues,
  collectKnownValues,
  extractPercentages,
  extractTickers,
  validatorNode,
} from "../../src/nodes/validator.js";

const RANKINGS: SectorRanking[] = [
  { sector: "Information Technology", pctChange: 8.33, window: "1mo", source: "cross_checked" },
  { sector: "Energy", pctChange: 1.19, window: "1mo", source: "yahoo_finance" },
  { sector: "Materials", pctChange: -4.2, window: "1mo", source: "yahoo_finance" },
];

const LEADERS: Record<string, SectorLeader[]> = {
  "Information Technology": [
    {
      ticker: "MSFT",
      weightScore: 7.23,
      speedScore: 1.83,
      relativeVolume: 1.72,
      quadrant: "anchor_leader",
    },
    {
      ticker: "AAPL",
      weightScore: 11.09,
      speedScore: 0.8,
      relativeVolume: 2.6,
      quadrant: "anchor_leader",
    },
    {
      ticker: "NVDA",
      weightScore: 12.64,
      speedScore: 0.59,
      relativeVolume: 1.09,
      quadrant: "stable_heavyweight",
    },
  ],
};

function stateWith(draftReport: string | null, overrides: Partial<AgentState> = {}): AgentState {
  return {
    messages: [],
    tickers: [],
    sectors: [],
    intent: "sector_trend",
    timeWindow: "1mo",
    activeCapabilities: ["industry_trend"],
    sectorRankings: RANKINGS,
    sectorLeaders: LEADERS,
    trendDataErrors: [],
    revenueGrowth: null,
    priceRevenueDiscrepancy: null,
    inorganicSignal: null,
    sectorBenchmark: null,
    growthAuthenticity: null,
    growthCheckErrors: [],
    dataErrors: [],
    draftReport,
    validationPassed: false,
    validationNotes: [],
    finalReport: null,
    retryCount: 1,
    ...overrides,
  };
}

// =============================================================================
describe("extractPercentages", () => {
  it("finds plain, signed and spaced forms", () => {
    expect(extractPercentages("rose 8.33% and 1.19 % and +2%")).toEqual([8.33, 1.19, 2]);
  });

  it("finds negative figures", () => {
    expect(extractPercentages("fell -4.2%")).toEqual([-4.2]);
  });

  it("finds the spelled-out form", () => {
    expect(extractPercentages("gained 8.3 percent")).toEqual([8.3]);
  });

  it("returns empty when there are no percentages", () => {
    expect(extractPercentages("technology led the market")).toEqual([]);
  });
});

// =============================================================================
describe("extractTickers", () => {
  it("finds uppercase symbols", () => {
    expect(extractTickers("MSFT and AAPL led")).toEqual(["AAPL", "MSFT"]);
  });

  // Over-extraction causes FALSE failures, which burn the whole retry budget
  // for no reason — worse than under-extraction.
  it("ignores finance vocabulary and sector ETF tickers", () => {
    expect(extractTickers("The GICS sectors tracked by ETF XLK, in USD")).toEqual([]);
  });

  it("ignores lowercase prose", () => {
    expect(extractTickers("technology led the market this month")).toEqual([]);
  });
});

// =============================================================================
describe("collectKnownValues", () => {
  it("gathers tickers from the leader lists", () => {
    const known = collectKnownValues(RANKINGS, LEADERS);
    expect([...known.tickers].sort()).toEqual(["AAPL", "MSFT", "NVDA"]);
  });

  it("gathers all three metric families as quotable numbers", () => {
    const known = collectKnownValues(RANKINGS, LEADERS);
    expect(known.numbers).toContain(8.33); // sector pctChange
    expect(known.numbers).toContain(7.23); // weightScore
    expect(known.numbers).toContain(1.83); // speedScore
  });

  it("handles null state without throwing", () => {
    const known = collectKnownValues(null, null);
    expect(known.tickers.size).toBe(0);
    expect(known.numbers).toEqual([]);
  });
});

// =============================================================================
describe("validatorNode — the success path", () => {
  it("passes a report that quotes only supplied figures", () => {
    const result = validatorNode(
      stateWith(
        "Information Technology led, gaining 8.33% over the month. MSFT was the main driver.",
      ),
    );

    expect(result.validationPassed).toBe(true);
    expect(result.validationNotes).toEqual([]);
  });

  it("promotes a passing draft to finalReport", () => {
    const draft = "Information Technology gained 8.33%, driven by MSFT.";
    const result = validatorNode(stateWith(draft));

    expect(result.finalReport).toBe(draft);
  });

  // The data says 8.33; good prose says 8.3.
  it("allows ordinary rounding to one decimal place", () => {
    const result = validatorNode(stateWith("Technology rose 8.3% while Energy added 1.2%."));

    expect(result.validationPassed).toBe(true);
  });

  // Prose legitimately writes "fell 4.2%" for a stored −4.2.
  it("accepts a magnitude quoted for a negative value", () => {
    const result = validatorNode(stateWith("Materials fell 4.2% over the period."));

    expect(result.validationPassed).toBe(true);
  });

  it("accepts weight and speed figures, not just sector changes", () => {
    const result = validatorNode(
      stateWith(
        "NVDA is 12.64% of the sector but its speed score of 0.59 lagged. Tech rose 8.33%.",
      ),
    );

    expect(result.validationPassed).toBe(true);
  });
});

// =============================================================================
describe("validatorNode — catching hallucinations (§1, §5.6)", () => {
  it("rejects a ticker that is not in the data", () => {
    const result = validatorNode(stateWith("Technology rose 8.33%, led by TSLA and MSFT."));

    expect(result.validationPassed).toBe(false);
    expect(result.validationNotes!.join(" ")).toMatch(/TSLA/);
  });

  it("rejects a fabricated percentage", () => {
    const result = validatorNode(stateWith("Technology surged 15.7% this month."));

    expect(result.validationPassed).toBe(false);
    expect(result.validationNotes!.join(" ")).toMatch(/15\.7%/);
  });

  // THE SUBTLE ONE. 8.33 + 1.19 = 9.52 is arithmetically correct, but §1
  // forbids the model computing it: a derived figure is indistinguishable from
  // a hallucinated one to a reader.
  it("rejects a CORRECT number the model derived itself", () => {
    const result = validatorNode(
      stateWith("Technology and Energy gained 9.52% combined this month."),
    );

    expect(result.validationPassed).toBe(false);
    expect(result.validationNotes!.join(" ")).toMatch(/do not calculate new ones/);
  });

  it("does not set finalReport when validation fails", () => {
    const result = validatorNode(stateWith("Technology surged 15.7%, led by TSLA."));

    expect(result.finalReport).toBeNull();
  });

  it("reports every distinct problem, so one retry can fix them all", () => {
    const result = validatorNode(stateWith("TSLA drove a 15.7% gain."));

    expect(result.validationNotes).toHaveLength(2);
  });

  it("writes notes actionable enough to steer a retry", () => {
    const result = validatorNode(stateWith("Technology surged 15.7%."));

    // The note must say what to do, not merely that something was wrong.
    expect(result.validationNotes!.join(" ")).toMatch(/Quote only the exact percentages supplied/);
  });

  it("rejects a figure just outside the rounding tolerance", () => {
    // 8.33 → quoting 8.5 is not rounding, it is a different number.
    const result = validatorNode(stateWith("Technology rose 8.5%."));
    expect(result.validationPassed).toBe(false);
  });

  it("uses a tolerance tight enough to be meaningful", () => {
    expect(PERCENTAGE_TOLERANCE).toBeLessThanOrEqual(0.05);
  });
});

// =============================================================================
describe("validatorNode — degenerate cases", () => {
  it("fails when there is no draft at all", () => {
    const result = validatorNode(stateWith(null));

    expect(result.validationPassed).toBe(false);
    expect(result.validationNotes!.join(" ")).toMatch(/No draft report/);
  });

  it("fails an empty draft", () => {
    expect(validatorNode(stateWith("   ")).validationPassed).toBe(false);
  });

  // Guards the degenerate pass: prose citing nothing cannot contain a wrong
  // number, so the other two checks would trivially succeed on an empty answer.
  it("rejects a report that cites no figures when data was available", () => {
    const result = validatorNode(
      stateWith("Technology performed well this month and several companies did nicely."),
    );

    expect(result.validationPassed).toBe(false);
    expect(result.validationNotes!.join(" ")).toMatch(/no percentage figures/);
  });

  it("allows a figure-free report when there was genuinely no data", () => {
    // An honest "no data available" must not be rejected for lacking numbers.
    const result = validatorNode(
      stateWith("No sector data was available for this period.", {
        sectorRankings: [],
        sectorLeaders: {},
      }),
    );

    expect(result.validationPassed).toBe(true);
  });

  it("never writes fields owned by other nodes", () => {
    const result = validatorNode(stateWith("Technology rose 8.33%, led by MSFT."));

    expect(Object.keys(result).sort()).toEqual([
      "finalReport",
      "validationNotes",
      "validationPassed",
    ]);
  });
});

// =============================================================================
// The industry-trend capability did not run (sectorRankings === null) — most
// commonly a `general_chat` reply. Checks 1/2 must not fire against an empty
// known-value set, or a free-form conversational reply would be rejected for
// "unknown" figures it was never claiming were sector data.
describe("validatorNode — capability did not run (general_chat)", () => {
  it("passes prose containing an incidental all-caps word with no known tickers", () => {
    const result = validatorNode(
      stateWith("Sure! I'm an AI assistant that can help with sector trend analysis.", {
        intent: "general_chat",
        activeCapabilities: [],
        sectorRankings: null,
        sectorLeaders: null,
      }),
    );

    expect(result.validationPassed).toBe(true);
    expect(result.validationNotes).toEqual([]);
  });

  it("passes prose containing an incidental percentage with no computed data", () => {
    const result = validatorNode(
      stateWith("Historically markets return about 7% a year on average, generally speaking.", {
        intent: "general_chat",
        activeCapabilities: [],
        sectorRankings: null,
        sectorLeaders: null,
      }),
    );

    expect(result.validationPassed).toBe(true);
    expect(result.validationNotes).toEqual([]);
  });

  it("does NOT skip these checks once the capability has actually produced data", () => {
    // Guards against accidentally gating on something broader than nullness.
    const result = validatorNode(stateWith("Technology rose 8.33%, led by TSLA."));

    expect(result.validationPassed).toBe(false);
    expect(result.validationNotes!.join(" ")).toMatch(/TSLA/);
  });
});

// =============================================================================
// growth-authenticity: classification-narration check
// =============================================================================

const GROWTH_AUTHENTICITY: GrowthAuthenticityResult = {
  ticker: "APA",
  timeWindow: "1y",
  revenueGrowth: {
    ticker: "APA",
    latestQuarterEnd: "2026-06-30",
    revenueGrowthPct: 2.1,
    basis: "yoy_quarterly",
  },
  discrepancy: {
    priceChangePct: 38.5,
    priceToRevenueGrowthRatio: 18.3,
    ratioZScore: 2.6,
    baselineQuarterCount: 8,
    discrepancyFlag: "price_outpacing_revenue",
  },
  inorganic: {
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
    sectorBenchmarkPct: 37.1,
    stockVsSectorSpreadPct: 1.4,
    macroBetaFlag: "beta_explained",
  },
  classification: "macro_or_commodity_beta_driven",
  classificationReasonCodes: [
    "discrepancy:price_outpacing_revenue",
    "inorganic_signal:no_signal",
    "macro_beta:beta_explained",
  ],
};

describe("collectGrowthKnownValues", () => {
  it("collects the ticker and every non-null number from the result", () => {
    const known = collectGrowthKnownValues(GROWTH_AUTHENTICITY);
    expect(known.tickers.has("APA")).toBe(true);
    expect(known.numbers).toEqual(expect.arrayContaining([2.1, 38.5, 18.3, 37.1, 1.4]));
  });

  it("returns an empty index when the capability did not run", () => {
    expect(collectGrowthKnownValues(null)).toEqual({ tickers: new Set(), numbers: [] });
  });
});

describe("checkClassificationNarrated", () => {
  it("passes when the draft states the computed classification's keywords", () => {
    const note = checkClassificationNarrated(
      "APA's rally looks driven by broader sector and commodity trends rather than the company itself.",
      GROWTH_AUTHENTICITY,
    );
    expect(note).toBeNull();
  });

  it("fails when the draft narrates a different conclusion than the computed classification", () => {
    const note = checkClassificationNarrated(
      "APA's growth is genuinely organic, driven by strong underlying fundamentals.",
      GROWTH_AUTHENTICITY,
    );
    expect(note).not.toBeNull();
    expect(note).toMatch(/macro_or_commodity_beta_driven/);
  });
});

describe("validatorNode — growth-authenticity integration", () => {
  it("passes a report that cites real figures AND states the right classification", () => {
    const result = validatorNode(
      stateWith(
        "APA is up 38.5% this year, but that looks like a broader sector/commodity move: " +
          "the Energy sector benchmark itself gained 37.1%. Revenue grew only 2.1%.",
        {
          intent: "single_report",
          activeCapabilities: ["growth_authenticity"],
          sectorRankings: null,
          sectorLeaders: null,
          growthAuthenticity: GROWTH_AUTHENTICITY,
        },
      ),
    );
    expect(result.validationPassed).toBe(true);
  });

  it("rejects a report with real figures but a classification that doesn't match the data", () => {
    const result = validatorNode(
      stateWith("APA is up 38.5% this year on genuinely organic revenue growth of 2.1%.", {
        intent: "single_report",
        activeCapabilities: ["growth_authenticity"],
        sectorRankings: null,
        sectorLeaders: null,
        growthAuthenticity: GROWTH_AUTHENTICITY,
      }),
    );
    expect(result.validationPassed).toBe(false);
    expect(result.validationNotes!.join(" ")).toMatch(/macro_or_commodity_beta_driven/);
  });

  it("rejects a report citing a ticker/number not present in growthAuthenticity", () => {
    const result = validatorNode(
      stateWith("APA rose 38.5%, a sector-wide move — TSLA was also up sharply.", {
        intent: "single_report",
        activeCapabilities: ["growth_authenticity"],
        sectorRankings: null,
        sectorLeaders: null,
        growthAuthenticity: GROWTH_AUTHENTICITY,
      }),
    );
    expect(result.validationPassed).toBe(false);
    expect(result.validationNotes!.join(" ")).toMatch(/TSLA/);
  });
});
