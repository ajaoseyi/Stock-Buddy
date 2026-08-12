/**
 * tests for api/client.ts
 *
 * `fetch` is stubbed, so nothing leaves the machine. What matters here is the
 * behaviour a component depends on: that a failure arrives as a typed,
 * readable `ApiError` rather than an opaque rejection, and that the thread id
 * round-trips so follow-up questions actually continue a conversation.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  analyze,
  analyzeStream,
  deleteThread,
  fetchThread,
  listRecentThreads,
  type StreamEvent,
} from "./client.js";
import { resetDeviceIdForTesting } from "../deviceId.js";

afterEach(() => {
  resetDeviceIdForTesting();
});

const OK_BODY = {
  finalReport: "Energy led, gaining 11.89%.",
  sectorRankings: [{ sector: "Energy", pctChange: 11.89, window: "1mo", source: "cross_checked" }],
  sectorLeaders: { Energy: [] },
  dataErrors: [],
  trendDataErrors: [],
  timeWindow: "1mo",
  validationPassed: true,
  threadId: "11111111-2222-4333-8444-555555555555",
};

function stubFetch(body: unknown, ok = true, status = 200) {
  const spy = vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// =============================================================================
describe("analyze — the happy path", () => {
  it("returns the parsed response", async () => {
    stubFetch(OK_BODY);

    const result = await analyze({ query: "what sectors are trending" });

    expect(result.finalReport).toBe("Energy led, gaining 11.89%.");
    expect(result.sectorRankings?.[0]?.pctChange).toBe(11.89);
  });

  it("POSTs JSON to /api/analyze", async () => {
    const spy = stubFetch(OK_BODY);

    await analyze({ query: "what sectors are trending" });

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/analyze");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ query: "what sectors are trending" });
  });

  // §7.1: omitted vs supplied threadId is the difference between starting a
  // conversation and continuing one.
  it("omits threadId entirely when starting a new conversation", async () => {
    const spy = stubFetch(OK_BODY);

    await analyze({ query: "q" });

    const body = JSON.parse(
      String((spy.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    );
    // Sent as absent, not null — the server's schema treats it as optional.
    expect("threadId" in body).toBe(false);
  });

  it("sends threadId when continuing a conversation", async () => {
    const spy = stubFetch(OK_BODY);

    await analyze({ query: "and energy?", threadId: "abc-123" });

    const body = JSON.parse(
      String((spy.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    );
    expect(body.threadId).toBe("abc-123");
  });
});

// =============================================================================
describe("analyze — error handling", () => {
  it("throws ApiError with the server's message on a 400", async () => {
    stubFetch({ error: "Invalid request body", details: ["query: too long"] }, false, 400);

    await expect(analyze({ query: "x" })).rejects.toThrow(ApiError);
  });

  it("carries the status and details through for display", async () => {
    stubFetch({ error: "Invalid request body", details: ["query: too long"] }, false, 400);

    try {
      await analyze({ query: "x" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ApiError).status).toBe(400);
      expect((error as ApiError).details).toEqual(["query: too long"]);
    }
  });

  // A proxy or a crash can return HTML where JSON was expected; that must not
  // mask the real status code.
  it("still reports the status when the error body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 502,
        json: async () => {
          throw new SyntaxError("Unexpected token <");
        },
      })),
    );

    await expect(analyze({ query: "x" })).rejects.toThrow(/502/);
  });

  // The most common real failure in development, and worth saying plainly
  // rather than surfacing as "fetch failed".
  it("explains a transport failure as the server not running", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    await expect(analyze({ query: "x" })).rejects.toThrow(/Is it running on port 3001/);
  });

  it("distinguishes caller cancellation from a timeout", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        controller.abort();
        throw new DOMException("Aborted", "AbortError");
      }),
    );

    // A cancellation is the user superseding a request, not a failure to show.
    await expect(analyze({ query: "x", signal: controller.signal })).rejects.toThrow(
      /Request cancelled/,
    );
  });
});

// =============================================================================
// analyzeStream — POST /api/analyze/stream, consumed as NDJSON over a fetch
// ReadableStream rather than EventSource (see client.ts's header comment on
// `analyzeStream` for why). `fetch` is stubbed with a fake reader whose
// `read()` calls hand back pre-encoded chunks one at a time, so a test can
// control exactly how NDJSON lines are split across chunk boundaries.
// =============================================================================

const STREAM_OK_BODY = {
  finalReport: "Energy led, gaining 11.89%.",
  sectorRankings: [{ sector: "Energy", pctChange: 11.89, window: "1mo", source: "cross_checked" }],
  sectorLeaders: { Energy: [] },
  dataErrors: [],
  trendDataErrors: [],
  timeWindow: "1mo",
  validationPassed: true,
  threadId: "11111111-2222-4333-8444-555555555555",
};

/** Stub `fetch` to resolve with a body whose reader yields `chunks` in order, one `read()` at a time. */
function stubStreamFetch(chunks: string[], { ok = true, status = 200 } = {}) {
  const encoder = new TextEncoder();
  const encoded = chunks.map((chunk) => encoder.encode(chunk));
  let index = 0;

  const reader = {
    read: vi.fn(async () => {
      if (index < encoded.length) {
        const value = encoded[index];
        index += 1;
        return { done: false, value };
      }
      return { done: true, value: undefined };
    }),
  };

  const spy = vi.fn(async () => ({
    ok,
    status,
    json: async () => ({ error: "unused for the streaming happy path" }),
    body: { getReader: () => reader },
  }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("analyzeStream — the happy path", () => {
  it("delivers progress and node_complete events, then resolves with the result", async () => {
    stubStreamFetch([
      '{"type":"progress","node":"sector_trend","message":"Fetching..."}\n' +
        '{"type":"node_complete","node":"sector_trend"}\n',
      `{"type":"result","data":${JSON.stringify(STREAM_OK_BODY)}}\n`,
    ]);

    const events: StreamEvent[] = [];
    const result = await analyzeStream({
      query: "what sectors are trending",
      onEvent: (event) => events.push(event),
    });

    expect(result.finalReport).toBe("Energy led, gaining 11.89%.");
    // `onEvent` also receives the terminal "result" event (App.tsx's reducer
    // ignores it) — filtered out here since this test is about the live
    // progress narration, not the terminal event's delivery.
    expect(events.filter((e) => e.type !== "result")).toEqual([
      { type: "progress", node: "sector_trend", message: "Fetching..." },
      { type: "node_complete", node: "sector_trend" },
    ]);
  });

  it("POSTs JSON to /api/analyze/stream", async () => {
    const spy = stubStreamFetch([`{"type":"result","data":${JSON.stringify(STREAM_OK_BODY)}}\n`]);

    await analyzeStream({ query: "what sectors are trending", onEvent: () => {} });

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/analyze/stream");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ query: "what sectors are trending" });
  });

  // The whole point of reading a stream instead of one JSON body: a chunk
  // boundary can land in the middle of a line, and the reassembled event must
  // still parse correctly rather than throwing or silently dropping a line.
  it("reassembles an NDJSON line split across two chunks", async () => {
    const fullLine = '{"type":"progress","node":"sector_leaders","message":"Analyzing Energy (1 of 6)..."}\n';
    const splitPoint = 40;

    stubStreamFetch([
      fullLine.slice(0, splitPoint),
      fullLine.slice(splitPoint) + `{"type":"result","data":${JSON.stringify(STREAM_OK_BODY)}}\n`,
    ]);

    const events: StreamEvent[] = [];
    await analyzeStream({ query: "q", onEvent: (event) => events.push(event) });

    expect(events.filter((e) => e.type !== "result")).toEqual([
      { type: "progress", node: "sector_leaders", message: "Analyzing Energy (1 of 6)..." },
    ]);
  });
});

describe("analyzeStream — error handling", () => {
  it("rejects with the server's message on an in-stream error event", async () => {
    stubStreamFetch(['{"type":"error","error":"Analysis failed","details":["boom"]}\n']);

    await expect(analyzeStream({ query: "q", onEvent: () => {} })).rejects.toThrow("Analysis failed");
  });

  it("carries error details through from the in-stream event", async () => {
    stubStreamFetch(['{"type":"error","error":"Analysis failed","details":["boom"]}\n']);

    try {
      await analyzeStream({ query: "q", onEvent: () => {} });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ApiError).details).toEqual(["boom"]);
    }
  });

  it("throws ApiError on a non-2xx response, same as analyze()", async () => {
    stubStreamFetch([], { ok: false, status: 400 });

    await expect(analyzeStream({ query: "q", onEvent: () => {} })).rejects.toThrow(ApiError);
  });

  it("rejects if the stream ends without a result or error event", async () => {
    stubStreamFetch(['{"type":"node_complete","node":"supervisor"}\n']);

    await expect(analyzeStream({ query: "q", onEvent: () => {} })).rejects.toThrow(
      /ended unexpectedly/,
    );
  });
});

// =============================================================================
describe("deleteThread", () => {
  it("DELETEs the thread endpoint", async () => {
    const spy = stubFetch({ deleted: "abc" });

    await deleteThread("abc-123");

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/thread/abc-123");
    expect(init.method).toBe("DELETE");
  });

  it("throws on a failure status", async () => {
    stubFetch({}, false, 400);

    await expect(deleteThread("bad")).rejects.toThrow(ApiError);
  });
});

// =============================================================================
// §7.2 — deep-linking a thread and the history modal's data source.
// =============================================================================
describe("fetchThread", () => {
  it("GETs the thread endpoint and returns the snapshot", async () => {
    const spy = stubFetch({ ...OK_BODY, query: "what sectors are trending" });

    const result = await fetchThread("11111111-2222-4333-8444-555555555555");

    const [url] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/thread/11111111-2222-4333-8444-555555555555");
    expect(result.query).toBe("what sectors are trending");
    expect(result.finalReport).toBe("Energy led, gaining 11.89%.");
  });

  // The caller (App.tsx) branches on 404 specifically to distinguish "gone"
  // from a transient failure — this must survive as a readable status, not
  // collapse into a generic message.
  it("throws a distinguishable ApiError with status 404 when the thread is gone", async () => {
    stubFetch({ error: "Thread not found" }, false, 404);

    try {
      await fetchThread("no-such-thread");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(404);
    }
  });
});

describe("listRecentThreads", () => {
  it("GETs /api/threads with the device id header and returns the list", async () => {
    const spy = stubFetch({
      threads: [{ threadId: "t-1", lastQuery: "what sectors are trending", updatedAt: 1_000 }],
    });

    const result = await listRecentThreads();

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/threads");
    expect((init.headers as Record<string, string>)["X-Device-Id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(result).toEqual([
      { threadId: "t-1", lastQuery: "what sectors are trending", updatedAt: 1_000 },
    ]);
  });

  it("throws ApiError on a failure status", async () => {
    stubFetch({}, false, 500);

    await expect(listRecentThreads()).rejects.toThrow(ApiError);
  });
});

// =============================================================================
describe("device id header (§7.2)", () => {
  it("attaches X-Device-Id to POST /api/analyze", async () => {
    const spy = stubFetch(OK_BODY);

    await analyze({ query: "q" });

    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-Device-Id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("attaches X-Device-Id to POST /api/analyze/stream", async () => {
    const spy = stubStreamFetch([`{"type":"result","data":${JSON.stringify(STREAM_OK_BODY)}}\n`]);

    await analyzeStream({ query: "q", onEvent: () => {} });

    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-Device-Id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("sends the same device id on repeated calls within a session", async () => {
    const spy = stubFetch(OK_BODY);

    await analyze({ query: "first" });
    await analyze({ query: "second" });

    const first = (spy.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<
      string,
      string
    >;
    const second = (spy.mock.calls[1] as unknown as [string, RequestInit])[1].headers as Record<
      string,
      string
    >;
    expect(first["X-Device-Id"]).toBe(second["X-Device-Id"]);
  });
});
