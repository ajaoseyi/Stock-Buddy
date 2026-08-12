/**
 * tests/nodes/report-writer.test.ts — §5.5
 *
 * The LLM is replaced with a fake through `setLlmForTesting`, so these tests
 * run with no API key and no network (§8). What they verify is everything
 * AROUND the model call: what context it receives, what the prompt instructs,
 * how the retry loop feeds corrections back, and how provider failure degrades.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type {
  AgentState,
  GrowthAuthenticityResult,
  SectorLeader,
  SectorRanking,
} from "../../src/state.js";
import { setLlmForTesting } from "../../src/llm.js";
import { buildDataBlock, reportWriterNode } from "../../src/nodes/report-writer.js";

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
    goodwillTrend: { deltaPct: null, zScore: null, baselineQuarterCount: 0, direction: "insufficient_data" },
    ppeTrend: { deltaPct: null, zScore: null, baselineQuarterCount: 0, direction: "insufficient_data" },
    cashTrend: { deltaPct: null, zScore: null, baselineQuarterCount: 0, direction: "insufficient_data" },
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

const RANKINGS: SectorRanking[] = [
  { sector: "Information Technology", pctChange: 8.331, window: "1mo", source: "cross_checked" },
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
      ticker: "AVGO",
      weightScore: 0.67,
      speedScore: 0.83,
      relativeVolume: 0.97,
      quadrant: "emerging_mover",
    },
    {
      ticker: "NVDA",
      weightScore: 12.64,
      speedScore: 0.59,
      relativeVolume: 1.09,
      quadrant: "stable_heavyweight",
    },
    {
      ticker: "INTC",
      weightScore: 4.2,
      speedScore: -1.37,
      relativeVolume: 0.92,
      quadrant: "laggard",
    },
  ],
};

function stateWith(overrides: Partial<AgentState> = {}): AgentState {
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
    draftReport: null,
    validationPassed: false,
    validationNotes: [],
    finalReport: null,
    retryCount: 0,
    ...overrides,
  };
}

/** Capture what the model was asked, and reply with a fixed string. */
function fakeLlm(reply = "Technology rose 8.33%.") {
  const invoke = vi.fn(async (_messages: BaseMessage[]) => new AIMessage(reply));
  setLlmForTesting({ provider: "gemini", model: { invoke } as unknown as BaseChatModel });
  return invoke;
}

/** A model that always throws — used for the degradation paths. */
function failingLlm(error: Error) {
  const invoke = vi.fn(async () => {
    throw error;
  });
  setLlmForTesting({ provider: "gemini", model: { invoke } as unknown as BaseChatModel });
  return invoke;
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  setLlmForTesting(null);
  vi.restoreAllMocks();
});

// =============================================================================
describe("buildDataBlock — what the model is allowed to see", () => {
  it("includes sector rankings with their percentage changes", () => {
    const block = JSON.parse(buildDataBlock(RANKINGS, LEADERS, "1mo"));

    expect(block.sectorRankings[0].sector).toBe("Information Technology");
    expect(block.sectorRankings[0].pctChange).toBe(8.33); // rounded for display
  });

  // §5.4 / §9: the separation must survive all the way to the prompt.
  it("presents weight and speed as SEPARATE labelled fields", () => {
    const block = JSON.parse(buildDataBlock(RANKINGS, LEADERS, "1mo"));
    const msft = block.sectorLeaders["Information Technology"].find(
      (l: { ticker: string }) => l.ticker === "MSFT",
    );

    expect(msft.weightPctOfSector).toBe(7.23);
    expect(msft.speedZScore).toBe(1.83);
    // No blended field of any name.
    expect(Object.keys(msft).sort()).toEqual([
      "quadrant",
      "relativeVolume",
      "speedZScore",
      "ticker",
      "weightPctOfSector",
    ]);
  });

  // §5.5 requires anchor_leaders named first, then emerging_movers.
  it("orders leaders so anchor_leader comes before emerging_mover", () => {
    const block = JSON.parse(buildDataBlock(RANKINGS, LEADERS, "1mo"));
    const order = block.sectorLeaders["Information Technology"].map(
      (l: { quadrant: string }) => l.quadrant,
    );

    expect(order[0]).toBe("anchor_leader");
    expect(order[1]).toBe("emerging_mover");
  });

  // Every extra row is another number the model might quote and the validator
  // must then check — and a long tail buries the names §5.5 wants foregrounded.
  it("omits laggards to keep the context focused", () => {
    const block = JSON.parse(buildDataBlock(RANKINGS, LEADERS, "1mo"));
    const tickers = block.sectorLeaders["Information Technology"].map(
      (l: { ticker: string }) => l.ticker,
    );

    expect(tickers).not.toContain("INTC");
  });

  it("handles null capability output without throwing", () => {
    const block = JSON.parse(buildDataBlock(null, null, "1mo"));

    expect(block.sectorRankings).toEqual([]);
    expect(block.sectorLeaders).toEqual({});
  });
});

// =============================================================================
describe("reportWriterNode — prompt construction", () => {
  it("returns the model's text as draftReport", async () => {
    fakeLlm("Technology rose 8.33%, led by MSFT.");

    const result = await reportWriterNode(stateWith());

    expect(result.draftReport).toBe("Technology rose 8.33%, led by MSFT.");
  });

  it("instructs the model not to calculate anything (§1)", async () => {
    const invoke = fakeLlm();

    await reportWriterNode(stateWith());

    const system = String(invoke.mock.calls[0]![0]![0]!.content);
    expect(system).toMatch(/Do NOT calculate/i);
    expect(system).toMatch(/No sums, averages, differences/i);
  });

  it("tells the model the two scores must not be merged (§5.4)", async () => {
    const invoke = fakeLlm();

    await reportWriterNode(stateWith());

    const prompt = String(invoke.mock.calls[0]![0]![1]!.content);
    expect(prompt).toMatch(/Do not merge, add, or average them/i);
  });

  it("passes the computed figures into the prompt", async () => {
    const invoke = fakeLlm();

    await reportWriterNode(stateWith());

    const prompt = String(invoke.mock.calls[0]![0]![1]!.content);
    expect(prompt).toContain("8.33");
    expect(prompt).toContain("MSFT");
  });

  it("threads the user's literal question into the sector_trend prompt, not just a fixed template", async () => {
    const invoke = fakeLlm();

    await reportWriterNode(
      stateWith({ messages: [new HumanMessage("why is tech up specifically because of NVDA?")] }),
    );

    const prompt = String(invoke.mock.calls[0]![0]![1]!.content);
    expect(prompt).toContain("why is tech up specifically because of NVDA?");
  });

  it("threads the user's literal question into the growth-authenticity prompt", async () => {
    const invoke = fakeLlm();

    await reportWriterNode(
      stateWith({
        intent: "single_report",
        activeCapabilities: ["growth_authenticity"],
        sectorRankings: null,
        sectorLeaders: null,
        growthAuthenticity: GROWTH_AUTHENTICITY,
        messages: [new HumanMessage("is APA's growth backed by revenue or just oil prices?")],
      }),
    );

    const prompt = String(invoke.mock.calls[0]![0]![1]!.content);
    expect(prompt).toContain("is APA's growth backed by revenue or just oil prices?");
  });

  it("includes data caveats when the capability degraded", async () => {
    const invoke = fakeLlm();

    await reportWriterNode(stateWith({ trendDataErrors: ["emerging_mover suppressed for AVGO"] }));

    const prompt = String(invoke.mock.calls[0]![0]![1]!.content);
    expect(prompt).toMatch(/DATA CAVEATS/);
    expect(prompt).toContain("emerging_mover suppressed for AVGO");
  });

  it("increments retryCount so the graph can bound the loop", async () => {
    fakeLlm();

    const result = await reportWriterNode(stateWith({ retryCount: 1 }));

    expect(result.retryCount).toBe(2);
  });

  it("appends the draft to the message history", async () => {
    fakeLlm("A report.");

    const result = await reportWriterNode(stateWith());

    expect(result.messages).toHaveLength(1);
  });
});

// =============================================================================
describe("reportWriterNode — the correction loop", () => {
  // This is what makes the retry a CORRECTION rather than a re-roll.
  it("feeds validator complaints back into the prompt", async () => {
    const invoke = fakeLlm();

    await reportWriterNode(
      stateWith({
        retryCount: 1,
        validationNotes: ['The report mentions "TSLA", which does not appear in the data.'],
      }),
    );

    const prompt = String(invoke.mock.calls[0]![0]![1]!.content);
    expect(prompt).toMatch(/PREVIOUS DRAFT WAS REJECTED/);
    expect(prompt).toContain("TSLA");
  });

  it("sends no correction block on the first attempt", async () => {
    const invoke = fakeLlm();

    await reportWriterNode(stateWith());

    const prompt = String(invoke.mock.calls[0]![0]![1]!.content);
    expect(prompt).not.toMatch(/PREVIOUS DRAFT WAS REJECTED/);
  });
});

// =============================================================================
describe("reportWriterNode — unimplemented capabilities (§9)", () => {
  it("answers honestly rather than fabricating an analysis", async () => {
    const invoke = fakeLlm();

    const result = await reportWriterNode(
      stateWith({ intent: "portfolio_scan", activeCapabilities: [] }),
    );

    expect(result.finalReport).toMatch(/outside what this agent can currently analyse/);
    // No LLM call at all — nothing to narrate.
    expect(invoke).not.toHaveBeenCalled();
  });

  it("marks the honest refusal as validated so the graph terminates", async () => {
    const result = await reportWriterNode(stateWith({ activeCapabilities: [] }));

    // Otherwise the validator would reject it for citing no figures and burn
    // the whole retry budget on a message that is already correct.
    expect(result.validationPassed).toBe(true);
  });
});

// =============================================================================
describe("reportWriterNode — followup", () => {
  it("re-narrates the existing sectorRankings/sectorLeaders when that's all a thread has", async () => {
    const invoke = fakeLlm();

    await reportWriterNode(
      stateWith({
        intent: "followup",
        activeCapabilities: [],
        growthAuthenticity: null,
        messages: [new HumanMessage("what about the emerging movers?")],
      }),
    );

    const prompt = String(invoke.mock.calls[0]![0]![1]!.content);
    expect(prompt).toContain("what about the emerging movers?");
    expect(prompt).toMatch(/FOLLOW-UP QUESTION/);
    // Reuses the SAME data already computed earlier — no re-fetch, no new numbers.
    expect(prompt).toContain("MSFT");
  });

  it("re-narrates growthAuthenticity when that's all a thread has", async () => {
    const invoke = fakeLlm();

    await reportWriterNode(
      stateWith({
        intent: "followup",
        activeCapabilities: [],
        sectorRankings: null,
        sectorLeaders: null,
        growthAuthenticity: GROWTH_AUTHENTICITY,
        messages: [new HumanMessage("why does the sector benchmark say beta_explained?")],
      }),
    );

    const prompt = String(invoke.mock.calls[0]![0]![1]!.content);
    expect(prompt).toContain("APA");
    expect(prompt).toContain("why does the sector benchmark say beta_explained?");
  });

  it("prefers growthAuthenticity when the followup names a ticker and both are present", async () => {
    const invoke = fakeLlm();

    await reportWriterNode(
      stateWith({
        intent: "followup",
        activeCapabilities: [],
        tickers: ["APA"],
        growthAuthenticity: GROWTH_AUTHENTICITY,
        // sectorRankings/sectorLeaders stay populated from the DEFAULT stateWith() —
        // a thread that ran BOTH capabilities across two earlier turns.
        messages: [new HumanMessage("and APA specifically?")],
      }),
    );

    const prompt = String(invoke.mock.calls[0]![0]![1]!.content);
    expect(prompt).toContain("APA");
    expect(prompt).not.toContain("Information Technology");
  });

  it("prefers sectorRankings when both are present and no ticker was named", async () => {
    const invoke = fakeLlm();

    await reportWriterNode(
      stateWith({
        intent: "followup",
        activeCapabilities: [],
        tickers: [],
        growthAuthenticity: GROWTH_AUTHENTICITY,
        messages: [new HumanMessage("what about the laggards?")],
      }),
    );

    const prompt = String(invoke.mock.calls[0]![0]![1]!.content);
    expect(prompt).toContain("Information Technology");
  });

  it("answers honestly with no LLM call when there is nothing to follow up on yet", async () => {
    const invoke = fakeLlm();

    const result = await reportWriterNode(
      stateWith({
        intent: "followup",
        activeCapabilities: [],
        sectorRankings: null,
        sectorLeaders: null,
        growthAuthenticity: null,
        messages: [new HumanMessage("what about the emerging movers?")],
      }),
    );

    expect(result.finalReport).toMatch(/no earlier analysis in this conversation/);
    expect(result.validationPassed).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });
});

// =============================================================================
describe("reportWriterNode — general chat", () => {
  it("DOES call the LLM for a non-finance prompt, unlike an unimplemented intent", async () => {
    const invoke = fakeLlm("Hi! I can analyse sector and industry trends for you.");

    const result = await reportWriterNode(
      stateWith({
        intent: "general_chat",
        activeCapabilities: [],
        sectorRankings: null,
        sectorLeaders: null,
        messages: [new HumanMessage("hello, what can you do?")],
      }),
    );

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result.draftReport).toBe("Hi! I can analyse sector and industry trends for you.");
  });

  it("sends the user's own message, not a sector DATA block", async () => {
    const invoke = fakeLlm();

    await reportWriterNode(
      stateWith({
        intent: "general_chat",
        activeCapabilities: [],
        sectorRankings: null,
        sectorLeaders: null,
        messages: [new HumanMessage("tell me a joke")],
      }),
    );

    const system = String(invoke.mock.calls[0]![0]![0]!.content);
    const prompt = String(invoke.mock.calls[0]![0]![1]!.content);
    expect(prompt).toBe("tell me a joke");
    expect(prompt).not.toContain("DATA:");
    expect(system).not.toMatch(/DATA block/);
  });

  it("increments retryCount and appends the reply to message history", async () => {
    fakeLlm("Sure, happy to help.");

    const result = await reportWriterNode(
      stateWith({
        intent: "general_chat",
        activeCapabilities: [],
        sectorRankings: null,
        sectorLeaders: null,
        messages: [new HumanMessage("hi")],
        retryCount: 0,
      }),
    );

    expect(result.retryCount).toBe(1);
    expect(result.messages).toHaveLength(1);
  });

  it("degrades into dataErrors rather than throwing on provider failure", async () => {
    failingLlm(new Error("connection refused"));

    const result = await reportWriterNode(
      stateWith({
        intent: "general_chat",
        activeCapabilities: [],
        sectorRankings: null,
        sectorLeaders: null,
        messages: [new HumanMessage("hi")],
      }),
    );

    expect(result.draftReport).toBeNull();
    expect(result.dataErrors!.join(" ")).toMatch(/Report generation failed.*connection refused/);
  });
});

// =============================================================================
describe("reportWriterNode — provider failure (§8)", () => {
  it("degrades into dataErrors rather than throwing", async () => {
    failingLlm(new Error("connection refused"));

    const result = await reportWriterNode(stateWith());

    // §8: never let a failure crash the run. The graph still terminates and
    // the API still responds — with rankings intact and an honest note.
    expect(result.draftReport).toBeNull();
    expect(result.dataErrors!.join(" ")).toMatch(/Report generation failed.*connection refused/);
  });

  it("still increments retryCount on failure, so the loop cannot spin", async () => {
    failingLlm(new Error("boom"));

    const result = await reportWriterNode(stateWith({ retryCount: 0 }));

    expect(result.retryCount).toBe(1);
  });

  it("tries the fallback provider on a rate limit (§2)", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("429 Too Many Requests");
    });
    setLlmForTesting({ provider: "gemini", model: { invoke } as unknown as BaseChatModel });

    await reportWriterNode(stateWith());

    // Primary then fallback — both resolve to the same injected fake here, but
    // the second attempt proves the fallback path is taken.
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a non-rate-limit error", async () => {
    // A malformed-prompt error would fail identically on the other provider,
    // so retrying just wastes a call.
    const invoke = failingLlm(new Error("invalid request: malformed prompt"));

    await reportWriterNode(stateWith());

    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
