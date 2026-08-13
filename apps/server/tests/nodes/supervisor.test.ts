/**
 * tests/nodes/supervisor.test.ts
 *
 * The supervisor is the ONLY place natural language becomes structured state,
 * so a misparse here silently changes every number downstream. `timeWindow`/
 * `sectors`/`tickers` parsing and the regex `classifyIntent` fallback are pure
 * and tested directly. `classifyIntentLlm` and `supervisorNode`'s primary path
 * call the LLM, so — same convention as `report-writer.test.ts` — the model is
 * replaced with a fake through `setLlmForTesting`, so these run with no API key
 * and no network (§8).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HumanMessage, AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AgentState, Intent } from "../../src/state.js";
import * as llmModule from "../../src/llm.js";
import * as yahooFinanceModule from "../../src/tools/yahoo-finance.js";
import {
  DEFAULT_TIME_WINDOW,
  classifyIntent,
  classifyIntentLlm,
  parseSectors,
  parseTickers,
  parseTimeWindow,
  supervisorNode,
  type CompanyMention,
} from "../../src/nodes/supervisor.js";

// resolveCompanyTicker is the deterministic half of company-name resolution
// (§ supervisor.ts file header) — it goes straight to Yahoo's `search()`, so
// it's mocked here the same way `setLlmForTesting` stands in for the LLM,
// keeping this suite offline and deterministic (§8). Everything else in the
// module (SECTOR_ETF_TO_GICS, used by parseSectors) passes through real.
vi.mock("../../src/tools/yahoo-finance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/yahoo-finance.js")>();
  return { ...actual, resolveCompanyTicker: vi.fn() };
});

const resolveCompanyTickerMock = vi.mocked(yahooFinanceModule.resolveCompanyTicker);

function stateWith(text: string, extra: unknown[] = []): AgentState {
  return {
    messages: [...extra, new HumanMessage(text)] as AgentState["messages"],
    tickers: [],
    sectors: [],
    intent: "sector_trend",
    timeWindow: "1mo",
    activeCapabilities: [],
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
  };
}

/** Minimal, schema-valid `GrowthAuthenticityResult`, for hasPriorAnalysis fixtures. */
const MINIMAL_GROWTH_RESULT = {
  ticker: "NVDA",
  timeWindow: "1y",
  revenueGrowth: { ticker: "NVDA", latestQuarterEnd: "2026-06-30", revenueGrowthPct: 10, basis: "yoy_quarterly" as const },
  discrepancy: {
    priceChangePct: 5,
    priceToRevenueGrowthRatio: null,
    ratioZScore: null,
    baselineQuarterCount: 0,
    discrepancyFlag: "not_computable" as const,
  },
  inorganic: {
    goodwillTrend: { deltaPct: null, zScore: null, baselineQuarterCount: 0, direction: "insufficient_data" as const },
    ppeTrend: { deltaPct: null, zScore: null, baselineQuarterCount: 0, direction: "insufficient_data" as const },
    cashTrend: { deltaPct: null, zScore: null, baselineQuarterCount: 0, direction: "insufficient_data" as const },
    inorganicSignal: "insufficient_data" as const,
  },
  sectorBenchmark: { sector: null, sectorBenchmarkPct: null, stockVsSectorSpreadPct: null, macroBetaFlag: "not_computable" as const },
  classification: "insufficient_data" as const,
  classificationReasonCodes: [],
};

/** Minimal, schema-valid `CompanySnapshotResult`, for hasPriorAnalysis fixtures. */
const MINIMAL_SNAPSHOT = {
  ticker: "NVDA",
  timeWindow: "1y",
  profile: null,
  valuation: null,
  financialHealth: null,
};

/** Minimal, schema-valid `TechnicalAnalysisResult`, for hasPriorAnalysis fixtures. */
const MINIMAL_TECHNICAL_ANALYSIS = {
  symbol: "NVDA",
  requestedAs: "ticker" as const,
  sectorName: null,
  timeWindow: "1y",
  indicators: {
    sma20: null,
    sma50: null,
    sma200: null,
    ema12: null,
    ema26: null,
    rsi14: null,
    macd: { macdLine: null, signalLine: null, histogram: null },
    atr14: null,
    bollinger: { middle: null, upper: null, lower: null },
    latestClose: null,
    asOfDate: null,
  },
  trendDirection: "insufficient_data" as const,
  momentumDirection: "insufficient_data" as const,
  volatilityLevel: "insufficient_data" as const,
  supportLevels: [],
  resistanceLevels: [],
  atrLevels: { entry: null, stopLoss: null, takeProfit: null, basisNote: "" },
  swingLevels: { entry: null, stopLoss: null, takeProfit: null, basisNote: "" },
  stance: "insufficient_data" as const,
  stanceReasonCodes: [],
};

/** A structured-output model that always classifies as `intent`, with optional company-name guesses. */
function fakeStructuredLlm(intent: Intent, companyMentions: CompanyMention[] = []) {
  const invoke = vi.fn(async (_messages: BaseMessage[]) => ({ intent, companyMentions }));
  const withStructuredOutput = vi.fn(() => ({ invoke }));
  llmModule.setLlmForTesting({
    provider: "gemini",
    model: { withStructuredOutput } as unknown as BaseChatModel,
  });
  return { invoke, withStructuredOutput };
}

/** A structured-output model that always throws — the fallback-path fixture. */
function failingStructuredLlm(error: Error) {
  const invoke = vi.fn(async (_messages: BaseMessage[]) => {
    throw error;
  });
  const withStructuredOutput = vi.fn(() => ({ invoke }));
  llmModule.setLlmForTesting({
    provider: "gemini",
    model: { withStructuredOutput } as unknown as BaseChatModel,
  });
  return { invoke, withStructuredOutput };
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  resolveCompanyTickerMock.mockReset();
});

afterEach(() => {
  llmModule.setLlmForTesting(null);
  vi.restoreAllMocks();
});

// =============================================================================
describe("parseTimeWindow", () => {
  it.each([
    ["what sectors are trending up this month", "1mo"],
    ["sector performance over the past week", "1w"],
    ["how did sectors do last quarter", "3mo"],
    ["sector trends this year", "ytd"],
    ["year to date sector performance", "ytd"],
    ["ytd leaders", "ytd"],
    ["sector moves over 5 days", "5d"],
    ["performance over 3 months", "3mo"],
    ["2 weeks of sector data", "2w"],
    ["1 year sector trends", "1y"],
    ["what's moving right now", "5d"],
    ["what has been trending recently", "1mo"],
  ])("parses %j → %s", (text, expected) => {
    expect(parseTimeWindow(text).timeWindow).toBe(expected);
  });

  it("marks an explicitly stated window as explicit", () => {
    expect(parseTimeWindow("sectors over 3 months").explicit).toBe(true);
  });

  // NOT the defaulted-window §4.1(b) forbids: that note is about proceeding
  // when parsing FAILED. Here parsing succeeded and found no period stated.
  it("falls back to 1mo when no period is mentioned, and says it was implicit", () => {
    const result = parseTimeWindow("which sectors are leading");
    expect(result.timeWindow).toBe(DEFAULT_TIME_WINDOW);
    expect(result.explicit).toBe(false);
  });

  it("prefers year-to-date over a bare year mention", () => {
    expect(parseTimeWindow("sector performance year to date").timeWindow).toBe("ytd");
  });
});

// =============================================================================
describe("parseSectors", () => {
  it("recognises colloquial names", () => {
    expect(parseSectors("how is tech doing")).toEqual(["Information Technology"]);
    expect(parseSectors("what about energy")).toEqual(["Energy"]);
    expect(parseSectors("banks and pharma")).toEqual(["Financials", "Health Care"]);
  });

  it("recognises canonical GICS names typed verbatim", () => {
    expect(parseSectors("Communication Services outlook")).toEqual(["Communication Services"]);
  });

  it("prefers the longer alias when two overlap", () => {
    // "consumer staples" must not be swallowed by a shorter alias.
    expect(parseSectors("consumer staples performance")).toEqual(["Consumer Staples"]);
  });

  it("deduplicates aliases mapping to one sector", () => {
    expect(parseSectors("tech and technology and software")).toEqual(["Information Technology"]);
  });

  // EMPTY IS MEANINGFUL: it means "rank all 11", the common case.
  it("returns an empty array when no sector is named", () => {
    expect(parseSectors("what is trending up this month")).toEqual([]);
  });

  it("does not match an alias inside a longer word", () => {
    // "it" must not fire on "with" / "profit".
    expect(parseSectors("what is the profit outlook")).toEqual([]);
  });
});

// =============================================================================
describe("parseTickers", () => {
  it("extracts $-prefixed symbols regardless of case", () => {
    expect(parseTickers("how is $nvda doing")).toEqual(["NVDA"]);
  });

  it("extracts bare uppercase symbols", () => {
    expect(parseTickers("compare NVDA and AMD")).toEqual(["AMD", "NVDA"]);
  });

  // Without the stop-list, ordinary finance vocabulary becomes phantom tickers.
  it("ignores common finance acronyms", () => {
    expect(parseTickers("what does the ETF data say about GICS sectors")).toEqual([]);
  });

  // REGRESSION: found live — "RSI" was parsing as a ticker, which then won
  // resolve-targets.ts's ticker-priority rule (§14.3) over the named sector,
  // sending technical-analysis off to fetch a nonexistent "RSI" symbol
  // instead of resolving "tech" to XLK.
  it("ignores technical-analysis indicator acronyms (§14)", () => {
    expect(parseTickers("what's the RSI on the tech sector right now")).toEqual([]);
    expect(parseTickers("is the MACD or ATR showing anything on SMA/EMA crossovers")).toEqual([]);
  });

  it("returns empty for ordinary lowercase prose", () => {
    expect(parseTickers("what sectors are trending up this month")).toEqual([]);
  });
});

// =============================================================================
// classifyIntent (regex) — THE FALLBACK PATH. classifyIntentLlm is primary;
// this only ever runs in production when that fails, so it must keep working
// entirely on its own. See supervisor.ts's file header.
// =============================================================================
describe("classifyIntent", () => {
  it("classifies sector questions", () => {
    expect(classifyIntent("what sectors are trending up", [], [], false)).toBe("sector_trend");
    expect(classifyIntent("who is leading the market", [], [], false)).toBe("sector_trend");
  });

  it("classifies a named-sector question even without trend words", () => {
    expect(classifyIntent("how about energy", [], ["Energy"], false)).toBe("sector_trend");
  });

  it("classifies portfolio questions", () => {
    expect(classifyIntent("how is my portfolio doing", [], [], false)).toBe("portfolio_scan");
  });

  it("classifies multiple named tickers as portfolio_scan, not single_report", () => {
    // single_report is single-ticker by design (§11.1) — a second ticker
    // means this is the multi-ticker case (§12).
    expect(classifyIntent("tell me about AAPL and MSFT", ["AAPL", "MSFT"], [], false)).toBe(
      "portfolio_scan",
    );
  });

  it("classifies single-company deep dives", () => {
    expect(classifyIntent("tell me about NVDA", ["NVDA"], [], false)).toBe("single_report");
  });

  // Specific readings win: this contains both a company and a sector cue.
  it("prefers the sector reading when a sector is also named", () => {
    expect(
      classifyIntent("tell me about NVDA's sector", ["NVDA"], ["Information Technology"], false),
    ).toBe("sector_trend");
  });

  it("falls back to general_chat rather than mislabelling small talk as a sector question", () => {
    // Coercing unmatched input into sector_trend would invoke the
    // industry-trend capability's tool calls for a prompt that never asked
    // for one. general_chat gets a real conversational reply instead, with
    // no capability activated.
    expect(classifyIntent("hello there", [], [], false)).toBe("general_chat");
  });

  it.each([["what's the weather like today"], ["tell me a joke"], ["thanks, that's helpful"]])(
    "classifies non-finance prompt %j as general_chat",
    (text) => {
      expect(classifyIntent(text, [], [], false)).toBe("general_chat");
    },
  );

  // followup — only reachable when a prior analysis actually exists (§12/Part
  // B of the followup implementation plan).
  it("classifies a referring phrase as followup when a prior analysis exists", () => {
    expect(classifyIntent("what about the emerging movers?", [], [], true)).toBe("followup");
    expect(classifyIntent("why is that?", [], [], true)).toBe("followup");
  });

  it("never classifies followup when there is nothing to follow up on", () => {
    // Same referring phrase, but hasPriorAnalysis is false — a referring
    // phrase with nothing to refer to is not a follow-up.
    expect(classifyIntent("what about the emerging movers?", [], [], false)).not.toBe("followup");
  });

  // company_snapshot (§13) — checked BEFORE single_report so a valuation/
  // financial-health question about a company reaches the broader capability.
  it("classifies a valuation/financial-health question with a ticker as company_snapshot", () => {
    expect(classifyIntent("is NVDA overvalued", ["NVDA"], [], false)).toBe("company_snapshot");
    expect(classifyIntent("what's AAPL's debt situation look like", ["AAPL"], [], false)).toBe(
      "company_snapshot",
    );
    expect(classifyIntent("give me NVDA's key stats", ["NVDA"], [], false)).toBe("company_snapshot");
  });

  it("company_snapshot wins over single_report when both signals are present", () => {
    expect(classifyIntent("give me a deep dive on NVDA's valuation", ["NVDA"], [], false)).toBe(
      "company_snapshot",
    );
  });

  it("does not classify company_snapshot signals without a named ticker", () => {
    expect(classifyIntent("what's a good PE ratio look like", [], [], false)).not.toBe(
      "company_snapshot",
    );
  });

  it("still routes multiple named tickers to portfolio_scan even with valuation language", () => {
    // single_report/company_snapshot are single-ticker-scoped by design;
    // a second ticker means this is the multi-ticker case (§12).
    expect(classifyIntent("compare NVDA and AMD valuations", ["NVDA", "AMD"], [], false)).toBe(
      "portfolio_scan",
    );
  });

  // technical_analysis (§14) — checked BEFORE the portfolio/multi-ticker rule.
  describe("technical_analysis", () => {
    it("classifies a single-ticker entry/stop-loss question", () => {
      expect(
        classifyIntent("give me an entry point and stop loss for NVDA", ["NVDA"], [], false),
      ).toBe("technical_analysis");
    });

    it("classifies a sector-only technical question", () => {
      expect(
        classifyIntent("what's the RSI on the tech sector right now", [], ["Information Technology"], false),
      ).toBe("technical_analysis");
    });

    it("REGRESSION: TA phrasing wins over the multi-ticker heuristic that would otherwise route to portfolio_scan", () => {
      expect(
        classifyIntent("give me trading levels for AAPL and MSFT", ["AAPL", "MSFT"], [], false),
      ).toBe("technical_analysis");
    });

    it("does not fire without a named ticker or sector", () => {
      expect(classifyIntent("what's a good stop loss strategy in general", [], [], false)).not.toBe(
        "technical_analysis",
      );
    });
  });
});

// =============================================================================
// classifyIntentLlm — THE PRIMARY PATH.
// =============================================================================
describe("classifyIntentLlm", () => {
  it("returns whatever intent the structured-output model classifies", async () => {
    fakeStructuredLlm("sector_trend");
    const result = await classifyIntentLlm("what sectors are trending up this month", [], [], false);
    expect(result.intent).toBe("sector_trend");
  });

  it("returns the model's company-name guesses alongside the intent", async () => {
    fakeStructuredLlm("single_report", [{ name: "Nvidia", guessedTicker: "NVDA" }]);
    const result = await classifyIntentLlm("is Nvidia's growth real?", [], [], false);
    expect(result.companyMentions).toEqual([{ name: "Nvidia", guessedTicker: "NVDA" }]);
  });

  it("defaults to an empty companyMentions list when the model finds no company names", async () => {
    fakeStructuredLlm("sector_trend");
    const result = await classifyIntentLlm("what sectors are trending up this month", [], [], false);
    expect(result.companyMentions).toEqual([]);
  });

  it("sends the raw message plus detected tickers/sectors as hints", async () => {
    const { invoke } = fakeStructuredLlm("single_report");
    await classifyIntentLlm("tell me about NVDA", ["NVDA"], [], false);

    const messages = invoke.mock.calls[0]![0] as BaseMessage[];
    const human = messages.find((m) => m.getType() === "human")!;
    expect(human.content).toContain("tell me about NVDA");
    expect(human.content).toContain("NVDA");
    expect(human.content).toContain("none"); // no sectors detected
  });

  it("tells the model whether a prior analysis exists", async () => {
    const { invoke } = fakeStructuredLlm("followup");
    await classifyIntentLlm("what about the emerging movers?", [], [], true);

    const messages = invoke.mock.calls[0]![0] as BaseMessage[];
    const human = messages.find((m) => m.getType() === "human")!;
    expect(human.content).toContain("Prior analysis exists in this conversation: yes");
  });

  it("requests temperature 0 from the factory, not the default narration temperature", async () => {
    const getLlmSpy = vi.spyOn(llmModule, "getLlm");
    fakeStructuredLlm("general_chat");

    await classifyIntentLlm("hello there", [], [], false);

    expect(getLlmSpy).toHaveBeenCalledWith(undefined, { temperature: 0 });
  });

  it("throws when the model fails, so supervisorNode can catch it and fall back", async () => {
    failingStructuredLlm(new Error("boom"));
    await expect(classifyIntentLlm("hello", [], [], false)).rejects.toThrow("boom");
  });
});

// =============================================================================
describe("supervisorNode", () => {
  it("produces the full routing field set", async () => {
    fakeStructuredLlm("sector_trend");
    const result = await supervisorNode(stateWith("which sectors are trending up this month"));

    expect(result).toEqual({
      intent: "sector_trend",
      timeWindow: "1mo",
      sectors: [],
      tickers: [],
      activeCapabilities: ["industry_trend"],
    });
  });

  // THE PLUGIN SEAM (§1, §3).
  it("activates industry_trend for a sector question", async () => {
    fakeStructuredLlm("sector_trend");
    const result = await supervisorNode(stateWith("what sectors are leading"));
    expect(result.activeCapabilities).toEqual(["industry_trend"]);
  });

  it("activates growth_authenticity for a single-ticker question", async () => {
    fakeStructuredLlm("single_report");
    const result = await supervisorNode(stateWith("tell me about NVDA's growth"));
    expect(result.intent).toBe("single_report");
    expect(result.activeCapabilities).toEqual(["growth_authenticity"]);
  });

  it("activates company_snapshot for a valuation question with a ticker", async () => {
    fakeStructuredLlm("company_snapshot");
    const result = await supervisorNode(
      stateWith("is NVDA overvalued compared to other chipmakers?"),
    );
    expect(result.intent).toBe("company_snapshot");
    expect(result.activeCapabilities).toEqual(["company_snapshot"]);
  });

  it("activates NOTHING for company_snapshot with no ticker named", async () => {
    fakeStructuredLlm("company_snapshot");
    const result = await supervisorNode(stateWith("is this stock overvalued?"));
    expect(result.intent).toBe("company_snapshot");
    expect(result.activeCapabilities).toEqual([]);
  });

  it("activates technical_analysis for a single-ticker trading-levels question", async () => {
    fakeStructuredLlm("technical_analysis");
    const result = await supervisorNode(stateWith("give me an entry point and stop loss for NVDA"));
    expect(result.intent).toBe("technical_analysis");
    expect(result.activeCapabilities).toEqual(["technical_analysis"]);
  });

  it("activates technical_analysis for a sector-only technical question", async () => {
    fakeStructuredLlm("technical_analysis");
    const result = await supervisorNode(stateWith("what's the RSI on the tech sector right now"));
    expect(result.intent).toBe("technical_analysis");
    expect(result.activeCapabilities).toEqual(["technical_analysis"]);
  });

  it("activates NOTHING for technical_analysis with neither a ticker nor a sector named", async () => {
    fakeStructuredLlm("technical_analysis");
    const result = await supervisorNode(stateWith("what's a good stop loss strategy in general"));
    expect(result.intent).toBe("technical_analysis");
    expect(result.activeCapabilities).toEqual([]);
  });

  it("activates NOTHING for an unimplemented intent", async () => {
    // §9: no speculative support. The graph routes this to an honest
    // "not supported yet" rather than a fabricated answer.
    fakeStructuredLlm("portfolio_scan");
    const result = await supervisorNode(stateWith("how is my portfolio doing"));
    expect(result.intent).toBe("portfolio_scan");
    expect(result.activeCapabilities).toEqual([]);
  });

  it("activates NOTHING for a followup — it reuses whatever capability output is already in state", async () => {
    fakeStructuredLlm("followup");
    const state = stateWith("what about the emerging movers?");
    state.sectorRankings = [{ sector: "Information Technology", pctChange: 8.3, window: "1mo", source: "yahoo_finance" }];

    const result = await supervisorNode(state);

    expect(result.intent).toBe("followup");
    expect(result.activeCapabilities).toEqual([]);
  });

  it("tells the model a prior analysis exists when only portfolioGrowthResults is populated (fixes a pre-existing gap)", async () => {
    const { invoke } = fakeStructuredLlm("followup");
    const state = stateWith("what about the others?");
    state.portfolioGrowthResults = [MINIMAL_GROWTH_RESULT];

    await supervisorNode(state);

    const messages = invoke.mock.calls[0]![0] as BaseMessage[];
    const human = messages.find((m) => m.getType() === "human")!;
    expect(human.content).toContain("Prior analysis exists in this conversation: yes");
  });

  it("tells the model a prior analysis exists when only companySnapshots is populated", async () => {
    const { invoke } = fakeStructuredLlm("followup");
    const state = stateWith("what about its balance sheet?");
    state.companySnapshots = [MINIMAL_SNAPSHOT];

    await supervisorNode(state);

    const messages = invoke.mock.calls[0]![0] as BaseMessage[];
    const human = messages.find((m) => m.getType() === "human")!;
    expect(human.content).toContain("Prior analysis exists in this conversation: yes");
  });

  it("tells the model a prior analysis exists when only technicalAnalysis is populated", async () => {
    const { invoke } = fakeStructuredLlm("followup");
    const state = stateWith("what about the swing-based levels?");
    state.technicalAnalysis = [MINIMAL_TECHNICAL_ANALYSIS];

    await supervisorNode(state);

    const messages = invoke.mock.calls[0]![0] as BaseMessage[];
    const human = messages.find((m) => m.getType() === "human")!;
    expect(human.content).toContain("Prior analysis exists in this conversation: yes");
  });

  describe("followup timeWindow carry-over", () => {
    it("carries the prior turn's timeWindow forward when the followup doesn't restate a period", async () => {
      fakeStructuredLlm("followup");
      const state = stateWith("what about the emerging movers?");
      state.timeWindow = "3mo"; // the prior turn's real window, per api.ts not reseeding it
      state.sectorRankings = [{ sector: "Information Technology", pctChange: 8.3, window: "3mo", source: "yahoo_finance" }];

      const result = await supervisorNode(state);

      expect(result.timeWindow).toBe("3mo");
    });

    it("still honours an explicit period restated in the followup itself", async () => {
      fakeStructuredLlm("followup");
      const state = stateWith("what about the emerging movers over the past week?");
      state.timeWindow = "3mo";
      state.sectorRankings = [{ sector: "Information Technology", pctChange: 8.3, window: "3mo", source: "yahoo_finance" }];

      const result = await supervisorNode(state);

      expect(result.timeWindow).toBe("1w");
    });

    it("does not carry timeWindow forward for a non-followup intent", async () => {
      fakeStructuredLlm("sector_trend");
      const state = stateWith("what sectors are trending");
      state.timeWindow = "3mo";

      const result = await supervisorNode(state);

      expect(result.timeWindow).toBe(DEFAULT_TIME_WINDOW);
    });
  });

  it("activates NOTHING for a general chat prompt, and never invokes sector tools", async () => {
    fakeStructuredLlm("general_chat");
    const result = await supervisorNode(stateWith("hello, what can you do?"));
    expect(result.intent).toBe("general_chat");
    expect(result.activeCapabilities).toEqual([]);
  });

  it("does not misroute an out-of-scope prompt just because it contains a generic superlative", async () => {
    // The whole point of moving off the old regex: "best"/"worst"/"top"/
    // "bottom" alone are not finance signals. The fake here stands in for a
    // real model correctly reading this as small talk, not a sector query.
    fakeStructuredLlm("general_chat");
    const result = await supervisorNode(stateWith("who's the best pizza place near me"));
    expect(result.intent).toBe("general_chat");
    expect(result.activeCapabilities).toEqual([]);
  });

  it("reads the LATEST human turn, not the first", async () => {
    // Multi-turn conversations must route on the current question.
    fakeStructuredLlm("sector_trend");
    const state = stateWith("and what about energy over 3 months", [
      new HumanMessage("what sectors are trending this week"),
      new AIMessage("Technology led..."),
    ]);

    const result = await supervisorNode(state);

    expect(result.timeWindow).toBe("3mo");
    expect(result.sectors).toEqual(["Energy"]);
  });

  it("handles an empty message history without throwing", async () => {
    fakeStructuredLlm("general_chat");
    const state = stateWith("");
    state.messages = [];

    const result = await supervisorNode(state);

    expect(result.timeWindow).toBe(DEFAULT_TIME_WINDOW);
    expect(result.sectors).toEqual([]);
  });

  it("never writes fields owned by other nodes, when classification succeeds", async () => {
    fakeStructuredLlm("sector_trend");
    const result = await supervisorNode(stateWith("what sectors are trending"));

    expect(Object.keys(result).sort()).toEqual([
      "activeCapabilities",
      "intent",
      "sectors",
      "tickers",
      "timeWindow",
    ]);
  });

  // Company-name → ticker resolution — see supervisor.ts's file header.
  // `resolveCompanyTicker` is mocked (top of file); these tests only exercise
  // how supervisorNode uses its result, not the Yahoo lookup logic itself
  // (that's tests/tools/yahoo-finance.test.ts's job).
  describe("company-name resolution", () => {
    it("merges a verified company-name guess into tickers and activates the right capability", async () => {
      resolveCompanyTickerMock.mockResolvedValue({ symbol: "NVDA", name: "NVIDIA Corporation" });
      fakeStructuredLlm("single_report", [{ name: "Nvidia", guessedTicker: "NVDA" }]);

      const result = await supervisorNode(stateWith("is Nvidia's growth backed by real revenue?"));

      expect(resolveCompanyTickerMock).toHaveBeenCalledWith("Nvidia", "NVDA");
      expect(result.tickers).toEqual(["NVDA"]);
      expect(result.intent).toBe("single_report");
      expect(result.activeCapabilities).toEqual(["growth_authenticity"]);
    });

    it("drops an unresolved company-name guess and logs it to dataErrors, without failing the request", async () => {
      resolveCompanyTickerMock.mockResolvedValue(null);
      fakeStructuredLlm("single_report", [{ name: "Nvidia", guessedTicker: "ZZZZ" }]);

      const result = await supervisorNode(stateWith("is Nvidia's growth real?"));

      expect(result.tickers).toEqual([]);
      // No ticker resolved and single_report requires one, so this degrades
      // to no capability activated — an honest "couldn't find it", not a
      // fabricated result.
      expect(result.activeCapabilities).toEqual([]);
      expect(result.dataErrors).toEqual([
        expect.stringContaining('Could not resolve "Nvidia"'),
      ]);
    });

    it("dedupes a guess that duplicates a regex-detected ticker rather than double-counting it", async () => {
      resolveCompanyTickerMock.mockResolvedValue({ symbol: "AMD", name: "Advanced Micro Devices" });
      fakeStructuredLlm("portfolio_scan", [{ name: "AMD", guessedTicker: "AMD" }]);

      const result = await supervisorNode(stateWith("compare NVDA and AMD"));

      expect(result.tickers).toEqual(["AMD", "NVDA"]);
    });

    it("enforces the per-request resolution cap and notes the overflow in dataErrors", async () => {
      resolveCompanyTickerMock.mockImplementation(async (_name, guessedTicker) => ({
        symbol: guessedTicker,
        name: guessedTicker,
      }));
      const mentions: CompanyMention[] = [
        { name: "Company A", guessedTicker: "AAAA" },
        { name: "Company B", guessedTicker: "BBBB" },
        { name: "Company C", guessedTicker: "CCCC" },
        { name: "Company D", guessedTicker: "DDDD" },
        { name: "Company E", guessedTicker: "EEEE" },
        { name: "Company F", guessedTicker: "FFFF" },
      ];
      fakeStructuredLlm("portfolio_scan", mentions);

      const result = await supervisorNode(stateWith("compare six companies"));

      expect(resolveCompanyTickerMock).toHaveBeenCalledTimes(5);
      expect(result.dataErrors).toEqual([
        expect.stringContaining("1 additional company name(s)"),
      ]);
    });

    it("skips company-mention resolution entirely on the LLM-failure fallback path", async () => {
      failingStructuredLlm(new Error("rate limited"));

      await supervisorNode(stateWith("is Nvidia's growth real?"));

      expect(resolveCompanyTickerMock).not.toHaveBeenCalled();
    });

    it("degrades a per-mention resolution failure to a dataErrors note rather than crashing the request", async () => {
      resolveCompanyTickerMock.mockRejectedValue(new Error("network error"));
      fakeStructuredLlm("single_report", [{ name: "Nvidia", guessedTicker: "NVDA" }]);

      const result = await supervisorNode(stateWith("is Nvidia's growth real?"));

      expect(result.intent).toBe("single_report");
      expect(result.tickers).toEqual([]);
      expect(result.dataErrors).toEqual([
        expect.stringContaining('Could not resolve "Nvidia"'),
      ]);
    });
  });

  // THE FALLBACK PATH — see supervisor.ts's file header. This node gates the
  // entire graph, so a classification failure must degrade, never crash.
  describe("when the LLM classifier fails", () => {
    it("falls back to the regex classifier and still routes correctly", async () => {
      failingStructuredLlm(new Error("rate limited"));
      const result = await supervisorNode(stateWith("what sectors are trending up this month"));

      expect(result.intent).toBe("sector_trend");
      expect(result.activeCapabilities).toEqual(["industry_trend"]);
    });

    it("records the failure in dataErrors rather than silently swallowing it", async () => {
      failingStructuredLlm(new Error("rate limited"));
      const result = await supervisorNode(stateWith("what sectors are trending up this month"));

      expect(result.dataErrors).toEqual([
        expect.stringContaining("Intent classification LLM failed"),
      ]);
    });

    it("preserves any dataErrors already on state", async () => {
      failingStructuredLlm(new Error("rate limited"));
      const state = stateWith("what sectors are trending up this month");
      state.dataErrors = ["a prior, unrelated failure"];

      const result = await supervisorNode(state);

      expect(result.dataErrors).toEqual([
        "a prior, unrelated failure",
        expect.stringContaining("Intent classification LLM failed"),
      ]);
    });
  });
});
