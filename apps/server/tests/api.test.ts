/**
 * tests/api.test.ts — §7
 *
 * Driven with Fastify's `app.inject()`, which dispatches a request through the
 * full routing/serialisation stack WITHOUT binding a port or opening a socket.
 * The tool layer and the LLM are mocked, so no live call is made (§8).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { FastifyInstance } from "fastify";

const mocks = vi.hoisted(() => ({
  fetchSectorEtfHistory: vi.fn(),
  hasQuotaFor: vi.fn(() => false),
  fetchEtfHoldings: vi.fn(),
  fetchConstituentOhlcv: vi.fn(),
}));

vi.mock("../src/tools/yahoo-finance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/yahoo-finance.js")>();
  return {
    ...actual,
    fetchSectorEtfHistory: mocks.fetchSectorEtfHistory,
    fetchConstituentOhlcv: mocks.fetchConstituentOhlcv,
  };
});
vi.mock("../src/tools/alpha-vantage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/alpha-vantage.js")>();
  return { ...actual, hasQuotaFor: mocks.hasQuotaFor };
});
vi.mock("../src/tools/etf-holdings.js", () => ({ fetchEtfHoldings: mocks.fetchEtfHoldings }));

const { buildServer } = await import("../src/api.js");
const { setLlmForTesting } = await import("../src/llm.js");
const { setCheckpointerForTesting } = await import("../src/checkpointer.js");
const { resetGraphForTesting } = await import("../src/graph.js");
const { SqliteSaver } = await import("@langchain/langgraph-checkpoint-sqlite");

function chart(symbol: string, to: number) {
  return {
    meta: { symbol },
    quotes: [
      { date: new Date("2026-07-01"), open: 100, high: 100, low: 100, close: 100, volume: 1000 },
      { date: new Date("2026-07-31"), open: to, high: to, low: to, close: to, volume: 1000 },
    ],
  };
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  for (const mock of Object.values(mocks)) mock.mockReset();

  mocks.hasQuotaFor.mockReturnValue(false);
  mocks.fetchSectorEtfHistory.mockImplementation(async (etf: string) =>
    chart(etf, etf === "XLK" ? 108.33 : 99),
  );
  mocks.fetchEtfHoldings.mockResolvedValue({
    holdings: [
      { ticker: "MSFT", weightPct: 7.23 },
      { ticker: "NVDA", weightPct: 12.64 },
    ],
    source: "alpha_vantage_etf_profile",
    warnings: [],
    isPartial: false,
  });
  mocks.fetchConstituentOhlcv.mockImplementation(async (t: string) =>
    chart(t, t === "MSFT" ? 115 : 105),
  );

  setLlmForTesting({
    provider: "gemini",
    model: {
      invoke: vi.fn(async () => new AIMessage("Information Technology gained 8.33%, led by MSFT.")),
    } as unknown as BaseChatModel,
  });

  // An in-memory checkpointer per test: no .cache/checkpoints.sqlite is ever
  // written, and threads cannot leak between tests. `resetGraphForTesting`
  // clears the cached compiled graph so it picks up THIS saver rather than one
  // captured by an earlier test.
  setCheckpointerForTesting(SqliteSaver.fromConnString(":memory:"));
  resetGraphForTesting();

  app = await buildServer();
  await app.ready();
});

afterEach(async () => {
  await app.close();
  setLlmForTesting(null);
  setCheckpointerForTesting(null);
  resetGraphForTesting();
  vi.restoreAllMocks();
});

// =============================================================================
describe("GET /api/health", () => {
  it("reports ok", async () => {
    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok" });
  });

  // §6 requires quota burn to be visible; an endpoint is easier to check
  // mid-session than scrolling server logs.
  it("exposes the per-source API call counts", async () => {
    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.json()).toHaveProperty("apiCallCounts");
  });

  // Checkpoint volume grows silently and is the one thing that can make a
  // long-running instance heavy, so it is surfaced alongside the API counts.
  it("exposes checkpoint volume", async () => {
    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.json().checkpoints).toMatchObject({
      threads: expect.any(Number),
      total: expect.any(Number),
    });
  });
});

// =============================================================================
describe("GET /api/threads — recent threads for a device", () => {
  const DEVICE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

  it("rejects a request with no X-Device-Id header", async () => {
    const response = await app.inject({ method: "GET", url: "/api/threads" });

    expect(response.statusCode).toBe(400);
  });

  it("rejects a non-UUID X-Device-Id header", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/threads",
      headers: { "x-device-id": "not-a-uuid" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns an empty list for a device with no history yet", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/threads",
      headers: { "x-device-id": DEVICE_ID },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().threads).toEqual([]);
  });

  it("lists a thread created by that device, newest first", async () => {
    await app.inject({
      method: "POST",
      url: "/api/analyze",
      payload: { query: "what sectors are trending up this month" },
      headers: { "x-device-id": DEVICE_ID },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/threads",
      headers: { "x-device-id": DEVICE_ID },
    });

    const threads = response.json().threads;
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ lastQuery: "what sectors are trending up this month" });
  });

  it("does not record activity for a request with no device id", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/analyze",
      payload: { query: "what sectors are trending up this month" },
    });
    const { threadId } = created.json();

    const response = await app.inject({
      method: "GET",
      url: "/api/threads",
      headers: { "x-device-id": DEVICE_ID },
    });

    expect(response.json().threads.map((t: { threadId: string }) => t.threadId)).not.toContain(
      threadId,
    );
  });
});

// =============================================================================
describe("GET /api/thread/:threadId — reading a thread without re-running the graph", () => {
  it("returns the thread's latest state", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/analyze",
      payload: { query: "what sectors are trending up this month" },
    });
    const { threadId } = created.json();

    const response = await app.inject({ method: "GET", url: `/api/thread/${threadId}` });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.threadId).toBe(threadId);
    expect(body.sectorRankings).toHaveLength(11);
    expect(body.finalReport).toBe(created.json().finalReport);
  });

  it("includes the query that produced the thread, when a device id recorded it", async () => {
    const deviceId = "11111111-1111-4111-8111-111111111111";
    const created = await app.inject({
      method: "POST",
      url: "/api/analyze",
      payload: { query: "what sectors are trending up this month" },
      headers: { "x-device-id": deviceId },
    });
    const { threadId } = created.json();

    const response = await app.inject({ method: "GET", url: `/api/thread/${threadId}` });

    expect(response.json().query).toBe("what sectors are trending up this month");
  });

  it("returns 404 for a thread that was never created", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/thread/99999999-9999-4999-8999-999999999999",
    });

    expect(response.statusCode).toBe(404);
  });

  it("rejects a non-UUID thread id", async () => {
    const response = await app.inject({ method: "GET", url: "/api/thread/not-a-uuid" });

    expect(response.statusCode).toBe(400);
  });

  it("returns 404 for a thread that was deleted", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/analyze",
      payload: { query: "what sectors are trending up this month" },
    });
    const { threadId } = created.json();
    await app.inject({ method: "DELETE", url: `/api/thread/${threadId}` });

    const response = await app.inject({ method: "GET", url: `/api/thread/${threadId}` });

    expect(response.statusCode).toBe(404);
  });
});

// =============================================================================
describe("DELETE /api/thread/:threadId", () => {
  it("deletes a conversation", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/analyze",
      payload: { query: "what sectors are trending" },
    });
    const { threadId } = created.json();

    const response = await app.inject({ method: "DELETE", url: `/api/thread/${threadId}` });

    expect(response.statusCode).toBe(200);
    expect(response.json().deleted).toBe(threadId);
  });

  it("rejects a non-UUID thread id", async () => {
    const response = await app.inject({ method: "DELETE", url: "/api/thread/not-a-uuid" });

    expect(response.statusCode).toBe(400);
  });
});

// =============================================================================
describe("POST /api/analyze — the §7 contract", () => {
  it("returns every field the contract promises", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/analyze",
      payload: { query: "what sectors are trending up this month" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(Object.keys(body).sort()).toEqual([
      "companySnapshotErrors",
      "companySnapshots",
      "dataErrors",
      "finalReport",
      "growthAuthenticity",
      "growthCheckErrors",
      "portfolioGrowthResults",
      "portfolioScanErrors",
      "sectorLeaders",
      "sectorRankings",
      "technicalAnalysis",
      "technicalAnalysisErrors",
      "threadId",
      "tickerComparison",
      "timeWindow",
      "trendDataErrors",
      "validationPassed",
    ]);
  });

  // ---------------------------------------------------------------------------
  // Conversation threads.
  // ---------------------------------------------------------------------------
  it("generates a thread id when the request omits one", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/analyze",
      payload: { query: "what sectors are trending up this month" },
    });

    // The client sends this back to ask a follow-up.
    expect(response.json().threadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("echoes back a supplied thread id", async () => {
    const threadId = "11111111-2222-4333-8444-555555555555";

    const response = await app.inject({
      method: "POST",
      url: "/api/analyze",
      payload: { query: "what sectors are trending", threadId },
    });

    expect(response.json().threadId).toBe(threadId);
  });

  it("does not clobber a continuing thread's timeWindow before the supervisor runs", async () => {
    // First turn: an explicit 3-month window, producing sectorRankings the
    // second turn can follow up on.
    const first = await app.inject({
      method: "POST",
      url: "/api/analyze",
      payload: { query: "what sectors are trending over 3 months" },
    });
    expect(first.json().timeWindow).toBe("3mo");
    const { threadId } = first.json();

    // Second turn, same thread: a follow-up that does NOT restate a period.
    // If `api.ts` reseeded `timeWindow` to the placeholder default before
    // `supervisorNode` ran, this would silently report "1mo" instead of the
    // window the reused data was actually computed for.
    const second = await app.inject({
      method: "POST",
      url: "/api/analyze",
      payload: { query: "what about the emerging movers?", threadId },
    });

    expect(second.json().timeWindow).toBe("3mo");
  });

  it("still returns sectorRankings on a continuing thread's follow-up turn", async () => {
    // A LangGraph behaviour worth pinning down (verified empirically, not
    // assumed — see api.ts's `resolveAnalyzeRequest`): a channel written by a
    // node that does NOT run again in a given `.invoke()` is not reliably
    // handed to the nodes that DO run, even though the checkpoint itself
    // still has the correct value. Omitting `sectorRankings` from a
    // continuing thread's graph input (relying on it to "just persist") loses
    // it; `resolveAnalyzeRequest` must read it back explicitly instead.
    const first = await app.inject({
      method: "POST",
      url: "/api/analyze",
      payload: { query: "what sectors are trending over 3 months" },
    });
    const { threadId } = first.json();
    expect(first.json().sectorRankings).not.toBeNull();

    const second = await app.inject({
      method: "POST",
      url: "/api/analyze",
      payload: { query: "what about the emerging movers?", threadId },
    });

    expect(second.json().sectorRankings).toEqual(first.json().sectorRankings);
  });

  it("gives each new request a distinct thread", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/analyze",
      payload: { query: "what sectors are trending" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/analyze",
      payload: { query: "what sectors are trending" },
    });

    expect(first.json().threadId).not.toBe(second.json().threadId);
  });

  // A non-UUID would let a caller guess or enumerate other people's threads.
  it("rejects a malformed thread id with 400", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/analyze",
      payload: { query: "what sectors are trending", threadId: "../../etc/passwd" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns a validated report", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/analyze",
      payload: { query: "what sectors are trending up this month" },
    });
    const body = response.json();

    expect(body.validationPassed).toBe(true);
    expect(body.finalReport).toContain("8.33%");
  });

  it("returns the underlying figures so the prose can be checked", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/analyze",
      payload: { query: "what sectors are trending up this month" },
    });
    const body = response.json();

    // The UI must be able to verify the narrative against the numbers.
    expect(body.sectorRankings).toHaveLength(11);
    expect(body.sectorRankings[0].sector).toBe("Information Technology");
    expect(body.sectorRankings[0].pctChange).toBeCloseTo(8.33, 1);
    expect(body.sectorLeaders["Information Technology"]).toBeDefined();
  });

  // §5.4 / §9: the separation survives serialisation, all the way to the client.
  it("keeps weight and speed as separate fields in the JSON response", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/analyze",
      payload: { query: "what sectors are trending up this month" },
    });
    const leader = response.json().sectorLeaders["Information Technology"][0];

    expect(leader).toHaveProperty("weightScore");
    expect(leader).toHaveProperty("speedScore");
    expect(leader.weightScore).not.toBe(leader.speedScore);
  });

  it("echoes the timeWindow the supervisor actually parsed", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/analyze",
      payload: { query: "which sectors led over 3 months" },
    });

    expect(response.json().timeWindow).toBe("3mo");
  });
});

// =============================================================================
// POST /api/analyze/stream — same contract as POST /api/analyze, plus live
// progress. `app.inject()` simulates the raw Node response `reply.hijack()`
// writes to directly, so the NDJSON body comes back whole in `response.body`
// — there's no real socket involved, so this still satisfies §8's "no live
// network calls in the test suite".
// =============================================================================
describe("POST /api/analyze/stream", () => {
  function ndjsonLines(body: string): unknown[] {
    return body
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
  }

  it("streams NDJSON ending in a result event matching the non-streaming contract", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/analyze/stream",
      payload: { query: "what sectors are trending up this month" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/application\/x-ndjson/);

    const events = ndjsonLines(response.body) as Array<{ type: string; data?: unknown }>;
    expect(events.length).toBeGreaterThan(0);

    const last = events.at(-1)!;
    expect(last.type).toBe("result");
    expect(Object.keys(last.data as object).sort()).toEqual([
      "companySnapshotErrors",
      "companySnapshots",
      "dataErrors",
      "finalReport",
      "growthAuthenticity",
      "growthCheckErrors",
      "portfolioGrowthResults",
      "portfolioScanErrors",
      "sectorLeaders",
      "sectorRankings",
      "technicalAnalysis",
      "technicalAnalysisErrors",
      "threadId",
      "tickerComparison",
      "timeWindow",
      "trendDataErrors",
      "validationPassed",
    ]);
  });

  it("emits progress events before the node that produced them completes", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/analyze/stream",
      payload: { query: "what sectors are trending up this month" },
    });

    const events = ndjsonLines(response.body) as Array<{
      type: string;
      node?: string;
    }>;

    const firstSectorTrendComplete = events.findIndex(
      (e) => e.type === "node_complete" && e.node === "sector_trend",
    );
    const firstSectorTrendProgress = events.findIndex(
      (e) => e.type === "progress" && e.node === "sector_trend",
    );

    expect(firstSectorTrendProgress).toBeGreaterThanOrEqual(0);
    expect(firstSectorTrendComplete).toBeGreaterThan(firstSectorTrendProgress);
  });

  // The report-writer/validator retry loop should be visible in the stream,
  // not just in the final `retryCount` — that's the whole point of narrating
  // live rather than just polishing the final response.
  it("narrates each report-writer retry attempt", async () => {
    setLlmForTesting({
      provider: "gemini",
      model: {
        invoke: vi.fn(async () => new AIMessage("This mentions no real figures at all.")),
      } as unknown as BaseChatModel,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/analyze/stream",
      payload: { query: "what sectors are trending up this month" },
    });

    const events = ndjsonLines(response.body) as Array<{ type: string; node?: string; message?: string }>;
    const reportWriterAttempts = events.filter(
      (e) => e.type === "progress" && e.node === "report_writer",
    );

    // A draft with no citable figures fails validation every time, so the
    // loop runs to its bound (MAX_REPORT_ATTEMPTS = 3 in graph.ts).
    expect(reportWriterAttempts.length).toBe(3);
    expect(reportWriterAttempts[1]?.message).toMatch(/attempt 2/);
    expect(reportWriterAttempts[2]?.message).toMatch(/attempt 3/);
  });

  it("rejects a malformed body the same way as the non-streaming endpoint", async () => {
    const response = await app.inject({ method: "POST", url: "/api/analyze/stream", payload: {} });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/Invalid request body/);
  });

  it("still generates a thread id and prunes it like the non-streaming endpoint", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/analyze/stream",
      payload: { query: "what sectors are trending up this month" },
    });

    const events = ndjsonLines(response.body) as Array<{ type: string; data?: { threadId?: string } }>;
    const result = events.at(-1) as { type: string; data: { threadId: string } };

    expect(result.data.threadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});

// =============================================================================
describe("POST /api/analyze — boundary validation (§4.1b)", () => {
  // LangGraph does NOT validate graph input, so this boundary is the only
  // thing standing between a malformed request and an `undefined` halfway
  // down the graph.
  it("rejects a missing query with 400", async () => {
    const response = await app.inject({ method: "POST", url: "/api/analyze", payload: {} });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/Invalid request body/);
  });

  it("rejects an empty query with 400", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/analyze",
      payload: { query: "   " },
    });

    expect(response.statusCode).toBe(400);
  });

  it("rejects a wrongly-typed query with 400", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/analyze",
      payload: { query: 42 },
    });

    expect(response.statusCode).toBe(400);
  });

  // The field becomes an LLM prompt — unbounded input is a cost risk on a
  // metered free tier.
  it("rejects an over-long query with 400", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/analyze",
      payload: { query: "a".repeat(1001) },
    });

    expect(response.statusCode).toBe(400);
  });

  it("names the offending field so the client can fix it", async () => {
    const response = await app.inject({ method: "POST", url: "/api/analyze", payload: {} });

    expect(response.json().details.join(" ")).toMatch(/query/);
  });
});

// =============================================================================
describe("POST /api/analyze — degradation (§8)", () => {
  it("still returns 200 with rankings when the LLM fails", async () => {
    setLlmForTesting({
      provider: "gemini",
      model: {
        invoke: vi.fn(async () => {
          throw new Error("no API key configured");
        }),
      } as unknown as BaseChatModel,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/analyze",
      payload: { query: "what sectors are trending up this month" },
    });

    // The deterministic half succeeded; returning a 500 would throw away good
    // data because the prose layer failed.
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.sectorRankings).toHaveLength(11);
    expect(body.dataErrors.join(" ")).toMatch(/Report generation failed/);
  });

  it("surfaces capability degradation notes to the client", async () => {
    mocks.fetchEtfHoldings.mockResolvedValue({
      holdings: [{ ticker: "MSFT", weightPct: 7.23 }],
      source: "yahoo_top_holdings",
      warnings: ["XLK: weights derived from the top 10 holdings only."],
      isPartial: true,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/analyze",
      payload: { query: "what sectors are trending up this month" },
    });

    // So the UI can say "built with incomplete data" rather than presenting a
    // degraded answer as a complete one.
    expect(response.json().trendDataErrors.join(" ")).toMatch(/top 10 holdings only/);
  });

  it("answers honestly when portfolio_scan is asked with no named ticker", async () => {
    // "how is my portfolio doing" matches PORTFOLIO_SIGNALS (§12.1) but names
    // no ticker, so `activeCapabilities` stays empty (§12.2) and
    // `report-writer.ts` returns its portfolio_scan-specific honest message
    // rather than the generic "unimplemented capability" fallback — every
    // implemented intent now has its own specific handling.
    const response = await app.inject({
      method: "POST",
      url: "/api/analyze",
      payload: { query: "how is my portfolio doing" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().finalReport).toMatch(/need at least one to check/);
  });
});
