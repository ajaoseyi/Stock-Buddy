/**
 * tests/nodes/graph.test.ts
 *
 * Two layers of testing here:
 *
 *   1. The routing functions in isolation — pure, so they can be checked
 *      exhaustively, including the loop-termination logic that stops a
 *      hallucinating model draining the free-tier quota.
 *   2. A REAL compiled graph run, end to end, with the tool layer and the LLM
 *      mocked. This is what proves the edges are actually wired the way the
 *      diagram in graph.ts claims — a routing function can be perfect while
 *      the edge that calls it points at the wrong node.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { END } from "@langchain/langgraph";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AgentState } from "../../src/state.js";

const mocks = vi.hoisted(() => ({
  fetchSectorEtfHistory: vi.fn(),
  fetchDailySeries: vi.fn(),
  hasQuotaFor: vi.fn(() => false),
  fetchEtfHoldings: vi.fn(),
  fetchConstituentOhlcv: vi.fn(),
}));

vi.mock("../../src/tools/yahoo-finance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/yahoo-finance.js")>();
  return {
    ...actual,
    fetchSectorEtfHistory: mocks.fetchSectorEtfHistory,
    fetchConstituentOhlcv: mocks.fetchConstituentOhlcv,
  };
});
vi.mock("../../src/tools/alpha-vantage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/alpha-vantage.js")>();
  return { ...actual, fetchDailySeries: mocks.fetchDailySeries, hasQuotaFor: mocks.hasQuotaFor };
});
vi.mock("../../src/tools/etf-holdings.js", () => ({ fetchEtfHoldings: mocks.fetchEtfHoldings }));

const {
  MAX_REPORT_ATTEMPTS,
  NODES,
  buildGraph,
  routeAfterSupervisor,
  routeAfterValidation,
  salvageUnvalidatedReport,
} = await import("../../src/graph.js");
const { setLlmForTesting } = await import("../../src/llm.js");

function stateWith(overrides: Partial<AgentState> = {}): AgentState {
  return {
    messages: [],
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
    ...overrides,
  };
}

function chart(symbol: string, to: number) {
  return {
    meta: { symbol },
    quotes: [
      { date: new Date("2026-07-01"), open: 100, high: 100, low: 100, close: 100, volume: 1000 },
      { date: new Date("2026-07-31"), open: to, high: to, low: to, close: to, volume: 1000 },
    ],
  };
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});

  // `mockReset` clears BOTH the recorded calls and any previous implementation.
  // Without this, call counts accumulate across tests in this file and an
  // assertion like `not.toHaveBeenCalled()` sees the previous test's 11 calls.
  for (const mock of Object.values(mocks)) mock.mockReset();

  mocks.hasQuotaFor.mockReturnValue(false); // no Alpha Vantage in these tests
  mocks.fetchSectorEtfHistory.mockImplementation(async (etf: string) =>
    chart(etf, etf === "XLK" ? 108.33 : 99),
  );
  mocks.fetchEtfHoldings.mockResolvedValue({
    holdings: [
      { ticker: "MSFT", weightPct: 7.23 },
      { ticker: "NVDA", weightPct: 12.64 },
      { ticker: "INTC", weightPct: 4.2 },
    ],
    source: "alpha_vantage_etf_profile",
    warnings: [],
    isPartial: false,
  });
  mocks.fetchConstituentOhlcv.mockImplementation(async (t: string) =>
    chart(t, t === "MSFT" ? 115 : t === "NVDA" ? 105 : 95),
  );
});

afterEach(() => {
  setLlmForTesting(null);
  vi.restoreAllMocks();
});

// =============================================================================
describe("routeAfterSupervisor — the plugin seam", () => {
  it("routes an industry_trend request into the capability", () => {
    expect(routeAfterSupervisor(stateWith({ activeCapabilities: ["industry_trend"] }))).toBe(
      NODES.sectorTrend,
    );
  });

  // Routing to END instead would return an empty report and leave the API with
  // nothing to say.
  it("routes an unimplemented capability to the writer for an honest refusal", () => {
    expect(routeAfterSupervisor(stateWith({ activeCapabilities: [] }))).toBe(NODES.reportWriter);
  });

  it("ignores capability ids it does not recognise", () => {
    expect(routeAfterSupervisor(stateWith({ activeCapabilities: ["not_built_yet"] }))).toBe(
      NODES.reportWriter,
    );
  });

  it("routes a growth_authenticity request into the capability's first node", () => {
    expect(routeAfterSupervisor(stateWith({ activeCapabilities: ["growth_authenticity"] }))).toBe(
      NODES.revenueGrowth,
    );
  });

  it("routes a technical_analysis request into the capability", () => {
    expect(routeAfterSupervisor(stateWith({ activeCapabilities: ["technical_analysis"] }))).toBe(
      NODES.technicalAnalysisScan,
    );
  });
});

// =============================================================================
describe("routeAfterValidation — bounding the loop", () => {
  it("ends when validation passed", () => {
    expect(routeAfterValidation(stateWith({ validationPassed: true, retryCount: 1 }))).toBe(END);
  });

  it("loops back to the writer when validation failed and budget remains", () => {
    expect(routeAfterValidation(stateWith({ validationPassed: false, retryCount: 1 }))).toBe(
      NODES.reportWriter,
    );
  });

  // THE TERMINATION GUARANTEE. Without this, a persistently hallucinating model
  // would spin until it exhausted the free-tier quota — §1's budget constraint
  // turned into an outage by a control-flow oversight.
  it("ends once the retry budget is exhausted, even though validation failed", () => {
    expect(
      routeAfterValidation(stateWith({ validationPassed: false, retryCount: MAX_REPORT_ATTEMPTS })),
    ).toBe(END);
  });

  it("ends if retryCount somehow exceeds the ceiling", () => {
    expect(
      routeAfterValidation(
        stateWith({ validationPassed: false, retryCount: MAX_REPORT_ATTEMPTS + 5 }),
      ),
    ).toBe(END);
  });

  it("keeps the budget small enough to protect a 15/min free tier", () => {
    expect(MAX_REPORT_ATTEMPTS).toBeLessThanOrEqual(3);
  });
});

// =============================================================================
describe("salvageUnvalidatedReport — failing honestly", () => {
  it("emits the draft with its failures stated inline", () => {
    const result = salvageUnvalidatedReport(
      stateWith({
        draftReport: "Technology surged 15.7%.",
        validationNotes: ["The report cites 15.7%, which does not match any computed figure."],
        retryCount: MAX_REPORT_ATTEMPTS,
      }),
    );

    // Returning nothing would be the worst outcome: an error for a run whose
    // deterministic half succeeded and produced good rankings.
    expect(result.finalReport).toContain("Technology surged 15.7%.");
    expect(result.finalReport).toMatch(/Unverified report/);
    expect(result.finalReport).toContain("does not match any computed figure");
  });

  it("does nothing when validation actually passed", () => {
    expect(salvageUnvalidatedReport(stateWith({ validationPassed: true }))).toEqual({});
  });

  it("leaves finalReport null when there is no draft to salvage", () => {
    const result = salvageUnvalidatedReport(stateWith({ draftReport: null }));
    expect(result).toEqual({});
  });
});

// =============================================================================
describe("The compiled graph, end to end", () => {
  /** A model whose reply is chosen per attempt, so retries can be simulated. */
  function scriptedLlm(replies: string[]) {
    let call = 0;
    const invoke = vi.fn(
      async (_m: BaseMessage[]) => new AIMessage(replies[call++] ?? replies.at(-1)!),
    );
    setLlmForTesting({ provider: "gemini", model: { invoke } as unknown as BaseChatModel });
    return invoke;
  }

  it("runs supervisor → trend → leaders → writer → validator and ends", async () => {
    scriptedLlm(["Information Technology led, gaining 8.33% over the month, driven by MSFT."]);

    const result = (await buildGraph().invoke({
      messages: [new HumanMessage("what sectors are trending up this month")],
      intent: "sector_trend",
      timeWindow: "1mo",
    })) as AgentState;

    // Supervisor parsed the request...
    expect(result.activeCapabilities).toEqual(["industry_trend"]);
    expect(result.timeWindow).toBe("1mo");
    // ...the capability computed real numbers...
    expect(result.sectorRankings).toHaveLength(11);
    expect(result.sectorRankings![0]!.sector).toBe("Information Technology");
    expect(result.sectorRankings![0]!.pctChange).toBeCloseTo(8.33, 1);
    expect(Object.keys(result.sectorLeaders!)).toContain("Information Technology");
    // ...and the report passed validation.
    expect(result.validationPassed).toBe(true);
    expect(result.finalReport).toContain("8.33%");
  });

  // Proves the backward edge is real, not just that the router returns a name.
  it("loops back to the writer when the first draft hallucinates", async () => {
    const invoke = scriptedLlm([
      "Technology soared 42.7%, led by TSLA.", // both a bad number and a bad ticker
      "Information Technology gained 8.33%, driven by MSFT.", // corrected
    ]);

    const result = (await buildGraph().invoke({
      messages: [new HumanMessage("what sectors are trending up this month")],
      intent: "sector_trend",
      timeWindow: "1mo",
    })) as AgentState;

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result.validationPassed).toBe(true);
    expect(result.finalReport).toContain("8.33%");
    expect(result.retryCount).toBe(2);
  });

  it("passes the validator's complaints into the retry prompt", async () => {
    const invoke = scriptedLlm([
      "Technology soared 42.7%.",
      "Information Technology gained 8.33%, driven by MSFT.",
    ]);

    await buildGraph().invoke({
      messages: [new HumanMessage("what sectors are trending up this month")],
      intent: "sector_trend",
      timeWindow: "1mo",
    });

    const retryPrompt = String(invoke.mock.calls[1]![0]![1]!.content);
    expect(retryPrompt).toMatch(/PREVIOUS DRAFT WAS REJECTED/);
    expect(retryPrompt).toContain("42.7%");
  });

  // The whole point of MAX_REPORT_ATTEMPTS.
  it("terminates after the retry budget rather than looping forever", async () => {
    const invoke = scriptedLlm(["Technology soared 42.7%, led by TSLA."]); // never improves

    const result = (await buildGraph().invoke({
      messages: [new HumanMessage("what sectors are trending up this month")],
      intent: "sector_trend",
      timeWindow: "1mo",
    })) as AgentState;

    expect(invoke).toHaveBeenCalledTimes(MAX_REPORT_ATTEMPTS);
    expect(result.validationPassed).toBe(false);
    // Salvaged, not lost: the user still gets the draft plus explicit caveats.
    expect(result.finalReport).toMatch(/Unverified report/);
    // And the deterministic half is intact regardless.
    expect(result.sectorRankings).toHaveLength(11);
  });

  it("skips the capability entirely when portfolio_scan is asked with no named ticker", async () => {
    scriptedLlm(["should not be called"]);

    const result = (await buildGraph().invoke({
      messages: [new HumanMessage("how is my portfolio doing")],
      intent: "sector_trend",
      timeWindow: "1mo",
    })) as AgentState;

    expect(result.intent).toBe("portfolio_scan");
    expect(mocks.fetchSectorEtfHistory).not.toHaveBeenCalled();
    expect(result.sectorRankings).toBeNull(); // never ran, as distinct from []
    // §12.2's own honest message — no ticker named, no LLM call.
    expect(result.finalReport).toMatch(/need at least one to check/);
  });

  // A sector the user explicitly named, whose weight data fell back to
  // Yahoo's top-10 holdings (Alpha Vantage quota exhausted): the report
  // writer declines to narrate it rather than present a quietly incomplete
  // picture, and never calls the LLM to do so.
  it("gates the report instead of narrating when the requested sector's holdings are partial", async () => {
    const invoke = scriptedLlm(["should not be called"]);
    mocks.fetchEtfHoldings.mockImplementation(async (etf: string) => ({
      holdings: [{ ticker: etf === "XLK" ? "MSFT" : "AAA", weightPct: 7.23 }],
      source: etf === "XLK" ? "yahoo_top_holdings" : "alpha_vantage_etf_profile",
      warnings: [],
      isPartial: etf === "XLK",
    }));

    const result = (await buildGraph().invoke({
      messages: [new HumanMessage("what stocks should i buy in the tech sector")],
      intent: "sector_trend",
      timeWindow: "1mo",
    })) as AgentState;

    expect(result.sectors).toEqual(["Information Technology"]);
    expect(result.partialHoldingsSectors).toEqual(["Information Technology"]);
    expect(invoke).not.toHaveBeenCalled();
    expect(result.finalReport).toMatch(/Information Technology/);
    expect(result.finalReport).toMatch(/quota is exhausted/i);
    expect(result.validationPassed).toBe(true);
  });

  it("still produces rankings when the LLM is entirely unavailable", async () => {
    setLlmForTesting({
      provider: "gemini",
      model: {
        invoke: vi.fn(async () => {
          throw new Error("no API key");
        }),
      } as unknown as BaseChatModel,
    });

    const result = (await buildGraph().invoke({
      messages: [new HumanMessage("what sectors are trending up this month")],
      intent: "sector_trend",
      timeWindow: "1mo",
    })) as AgentState;

    // §8: the deterministic half of the pipeline is unaffected by a prose
    // failure, and the run terminates rather than hanging.
    expect(result.sectorRankings).toHaveLength(11);
    expect(result.dataErrors.join(" ")).toMatch(/Report generation failed/);
  });

  it("routes technical_analysis requests to the capability, populates real data, and terminates", async () => {
    // Override the default 2-bar fixture with enough healthy history for the
    // indicators to actually resolve.
    mocks.fetchConstituentOhlcv.mockImplementation(async (ticker: string) => {
      const quotes = [];
      let price = 100;
      for (let i = 0; i < 300; i++) {
        price += 0.15;
        quotes.push({
          date: new Date(2024, 0, i + 1),
          open: price,
          high: price + 0.5,
          low: price - 0.5,
          close: price,
          volume: 1000,
        });
      }
      return { meta: { symbol: ticker }, quotes };
    });
    scriptedLlm([
      "NVDA shows a bullish setup, a buying opportunity. ATR-based levels and " +
        "swing-based levels are both provided above.",
    ]);

    const result = (await buildGraph().invoke({
      messages: [new HumanMessage("give me an entry point and stop loss for NVDA")],
      intent: "sector_trend",
      timeWindow: "1mo",
    })) as AgentState;

    // Supervisor's regex fallback routed this correctly (the scripted LLM
    // stub has no withStructuredOutput, so classifyIntentLlm throws and
    // supervisorNode falls back to classifyIntent).
    expect(result.activeCapabilities).toEqual(["technical_analysis"]);
    expect(result.technicalAnalysis).toHaveLength(1);
    expect(result.technicalAnalysis![0]!.symbol).toBe("NVDA");
    expect(result.technicalAnalysis![0]!.stance).not.toBe("insufficient_data");
    // Zero Alpha Vantage spend (§14's explicit budget win) — this capability
    // never touches that fetcher at all.
    expect(mocks.fetchDailySeries).not.toHaveBeenCalled();
    // The run terminates either way (validated or salvaged) rather than hanging.
    expect(result.finalReport).not.toBeNull();
  });

  it("honours the append reducer on messages", async () => {
    scriptedLlm(["Information Technology gained 8.33%, driven by MSFT."]);

    const result = (await buildGraph().invoke({
      messages: [new HumanMessage("what sectors are trending up this month")],
      intent: "sector_trend",
      timeWindow: "1mo",
    })) as AgentState;

    // The human turn must survive; without the append reducer the history
    // would be replaced and the supervisor would lose the question.
    expect(result.messages.length).toBeGreaterThanOrEqual(2);
  });
});
