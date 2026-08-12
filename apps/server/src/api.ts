/**
 * =============================================================================
 * api.ts — the Fastify HTTP surface.
 * =============================================================================
 *
 * CLAUDE.md §7:
 *   POST /api/analyze — body `{ query: string }`. Returns
 *   `{ finalReport, sectorRankings, sectorLeaders, dataErrors, trendDataErrors,
 *      growthAuthenticity, growthCheckErrors, timeWindow, validationPassed,
 *      threadId }`.
 *   CORS allows only the Vite dev origin in development.
 *
 * THIS FILE IS THE VALIDATION BOUNDARY — see §4.1(b)
 * --------------------------------------------------
 * A verified property of `@langchain/langgraph@1.4.8`: **it does not run zod
 * validation on graph input.** Invoking with a required field missing does not
 * throw; the node simply observes `undefined` while the compiler still believes
 * the field is a `string`.
 *
 * So `intent` and `timeWindow` being required in `AgentStateSchema` buys
 * nothing at runtime unless someone actually parses. That someone is this file:
 * the initial state goes through `AgentStateSchema.parse()` BEFORE
 * `graph.invoke()`, turning a malformed request into a loud 400 rather than a
 * quiet `undefined` halfway down the graph.
 */

import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { HumanMessage } from "@langchain/core/messages";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AgentStateSchema, type AgentState } from "./state.js";
import { getGraph } from "./graph.js";
import { getApiCallCounts } from "./tools/cache.js";
import {
  countCheckpoints,
  countThreads,
  deleteThread,
  getCheckpointer,
  getThreadLastQuery,
  listRecentThreads,
  pruneThread,
  recordThreadActivity,
} from "./checkpointer.js";
import { DEFAULT_TIME_WINDOW } from "./nodes/supervisor.js";
import type { StreamEvent } from "./streaming.js";

// =============================================================================
// SECTION 1 — Request/response contracts
// =============================================================================

/**
 * The request body (§7).
 *
 * Bounded length because the string becomes an LLM prompt: an unbounded field
 * is both a cost risk on a metered free tier and a trivially abusable input.
 */
export const AnalyzeRequestSchema = z.object({
  query: z.string().trim().min(1, "query must not be empty").max(1000),

  /**
   * Conversation thread to continue. Omit to start a new one — the server
   * generates an id and returns it, which the client then sends back on
   * follow-up questions.
   *
   * WHY IT IS CLIENT-SUPPLIED RATHER THAN A COOKIE OR SESSION: the server
   * holds no session state and does no authentication, so the thread id IS the
   * conversation handle. Constraining it to a UUID (rather than accepting any
   * string) matters for a reason that is easy to miss — the value goes
   * straight into a `thread_id` lookup, so an unconstrained string would let a
   * caller guess or enumerate other people's threads. A v4 UUID is not
   * guessable. This is not full authorisation, and it should not be mistaken
   * for it: anyone holding the id can read the thread. It is the right level
   * of protection for a single-user local tool, and would need real auth
   * before any multi-user deployment.
   */
  threadId: z.uuid().optional(),
});

export type AnalyzeRequest = z.infer<typeof AnalyzeRequestSchema>;

/**
 * The response body (§7), plus `trendDataErrors`.
 *
 * §7 lists four fields; `trendDataErrors` is included as a fifth because the
 * capability's degradation notes are exactly what the UI needs to say "this
 * report was built with incomplete data" rather than presenting a degraded
 * answer as a complete one. Keeping it separate from `dataErrors` preserves
 * §4's namespacing — a future capability adds its own error field without
 * disturbing this one.
 */
export interface AnalyzeResponse {
  finalReport: string | null;
  sectorRankings: AgentState["sectorRankings"];
  sectorLeaders: AgentState["sectorLeaders"];
  dataErrors: string[];
  trendDataErrors: string[];
  /** The growth-authenticity capability's assembled result, or null if it didn't run. */
  growthAuthenticity: AgentState["growthAuthenticity"];
  /** Non-fatal degradation notes specific to the growth-authenticity capability. */
  growthCheckErrors: string[];
  /** Echoed back so the UI can label the tables with the period actually used. */
  timeWindow: string;
  /** True when validation passed; false means the report carries caveats. */
  validationPassed: boolean;
  /**
   * The conversation thread this run belongs to. Echoed on every response —
   * newly generated when the request omitted one. Clients MUST send it back to
   * ask a follow-up; without it every question starts a fresh thread.
   */
  threadId: string;
}

/** The `GET /api/thread/:threadId` response — `AnalyzeResponse` plus the query that produced it. */
export interface ThreadSnapshotResponse extends AnalyzeResponse {
  /** The last question asked in this thread, as recorded in the thread index. */
  query: string;
}

// =============================================================================
// SECTION 1B — Shared request/response construction
//
// Used by BOTH `POST /api/analyze` and `POST /api/analyze/stream` so the
// validation boundary (§4.1(b), this file's header) and the response shape
// stay defined in exactly one place, whichever endpoint a request hits.
// =============================================================================

type ResolvedAnalyzeRequest =
  | { ok: true; graphInput: Partial<AgentState>; threadId: string; query: string }
  | { ok: false; status: number; error: string; details?: string[] };

/**
 * Run boundary checks 1 and 2 (request body, then initial graph state) and
 * resolve the thread id and graph input. Does NOT run the graph — callers
 * decide whether to `.invoke()` or `.stream()` it.
 */
function resolveAnalyzeRequest(body: unknown): ResolvedAnalyzeRequest {
  // --- Boundary check 1: the request body itself ---------------------------
  const parsedBody = AnalyzeRequestSchema.safeParse(body);
  if (!parsedBody.success) {
    return {
      ok: false,
      status: 400,
      error: "Invalid request body",
      details: parsedBody.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`),
    };
  }

  // --- Boundary check 2: the initial graph state (§4.1(b)) -----------------
  //
  // `intent` and `timeWindow` are provisional here — the supervisor is what
  // actually derives them from the query. They are supplied so the state is
  // COMPLETE and parseable at the boundary, which is the guarantee LangGraph
  // does not provide for us.
  let initialState: AgentState;
  try {
    initialState = AgentStateSchema.parse({
      messages: [new HumanMessage(parsedBody.data.query)],
      intent: "sector_trend",
      timeWindow: DEFAULT_TIME_WINDOW,
    }) as AgentState;
  } catch (error) {
    // Reaching here means the schema and this construction have drifted apart
    // — a programming error, not a user error, so it is a 500 with detail
    // rather than a 400.
    return {
      ok: false,
      status: 500,
      error: "Failed to construct initial agent state",
      details: [error instanceof Error ? error.message : String(error)],
    };
  }

  // A new id per request unless the client is continuing an existing thread.
  const isNewThread = parsedBody.data.threadId === undefined;
  const threadId = parsedBody.data.threadId ?? randomUUID();

  // On a NEW thread, `initialState` (with its provisional `intent`/`timeWindow`
  // placeholders) is exactly what should seed the graph. On a CONTINUING
  // thread, those same placeholders would OVERWRITE the checkpointer's
  // persisted `intent`/`timeWindow` before `supervisorNode` ever runs — both
  // are simple overwrite-reducer channels (§4.1(a)), so any field present in
  // this input replaces the checkpointed value, present or not. `intent` gets
  // unconditionally re-derived by the supervisor every turn regardless, so
  // that loss is harmless — but `timeWindow` is what lets a `followup` question
  // that doesn't restate a period ("what about the emerging movers?") still
  // know which window the analysis it's following up on actually used. So only
  // `messages` is sent on a continuing thread; every other field is left
  // untouched, flowing through from the checkpoint as-is.
  const graphInput: Partial<AgentState> = isNewThread
    ? initialState
    : { messages: initialState.messages };

  return { ok: true, graphInput, threadId, query: parsedBody.data.query };
}

/** Build the `POST /api/analyze` response shape (§7) from a finished graph run. */
function buildAnalyzeResponse(result: AgentState, threadId: string): AnalyzeResponse {
  return {
    finalReport: result.finalReport,
    sectorRankings: result.sectorRankings,
    sectorLeaders: result.sectorLeaders,
    dataErrors: result.dataErrors,
    trendDataErrors: result.trendDataErrors,
    growthAuthenticity: result.growthAuthenticity,
    growthCheckErrors: result.growthCheckErrors,
    timeWindow: result.timeWindow,
    validationPassed: result.validationPassed,
    threadId,
  };
}

// =============================================================================
// SECTION 1C — Anonymous device identity
//
// There is no auth system (§9 of the "no auth" note added alongside this): a
// device generates its own random UUID client-side, keeps it in localStorage,
// and sends it as `X-Device-Id` on every request. It is NOT a security
// boundary — same caveat as the thread-id UUID above: anyone holding a
// thread id can still read that thread via GET /api/thread/:threadId. What
// the device id buys is narrower — it is the key `GET /api/threads` filters
// on, so "recent conversations" means "recent on this browser", nothing more.
// =============================================================================

const DeviceIdHeaderSchema = z.uuid();

/** Read and validate `X-Device-Id`. Returns null if absent or malformed. */
function resolveDeviceId(request: { headers: Record<string, unknown> }): string | null {
  const header = request.headers["x-device-id"];
  const value = Array.isArray(header) ? header[0] : header;
  const parsed = DeviceIdHeaderSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Record this run in the device's recent-threads index, if a device id was
 * supplied. Best-effort and non-fatal by design (§8): a client that omits the
 * header still gets its answer, it just won't appear in any history list.
 */
function recordActivityIfDeviceKnown(deviceId: string | null, threadId: string, query: string): void {
  if (deviceId === null) return;
  try {
    recordThreadActivity(getCheckpointer(), deviceId, threadId, query);
  } catch (error) {
    console.warn(
      `[api] failed to record thread activity for ${threadId}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// =============================================================================
// SECTION 2 — Server construction
// =============================================================================

/** Parse the CORS allow-list from the environment (§7). */
function corsOrigins(): string[] {
  const raw = process.env["CORS_ORIGIN"] ?? "http://localhost:5173";
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== "");
}

/**
 * Build the Fastify app.
 *
 * Returned rather than started, so tests can drive it with `app.inject()` —
 * no port binding, no real network.
 */
export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env["NODE_ENV"] === "production" ? "info" : "debug",
    },
  });

  // §7: only the Vite dev origin in development. The comment in .env.example
  // notes this must be tightened before any public deployment.
  await app.register(cors, {
    origin: corsOrigins(),
    methods: ["GET", "POST"],
  });

  // ---------------------------------------------------------------------------
  // GET /api/health — liveness plus free-tier visibility.
  //
  // The API-call counts are surfaced because §6 requires quota burn to be
  // visible during development, and an endpoint is easier to check mid-session
  // than scrolling server logs.
  // ---------------------------------------------------------------------------
  app.get("/api/health", async () => ({
    status: "ok",
    apiCallCounts: getApiCallCounts(),
    // Checkpoint volume is surfaced for the same reason as the API counts:
    // it grows silently and is the one thing that can make a long-running
    // instance heavy. `threads` climbing while `checkpoints` stays proportional
    // means pruning is working.
    checkpoints: {
      threads: countThreads(getCheckpointer()),
      total: countCheckpoints(getCheckpointer()),
    },
  }));

  // ---------------------------------------------------------------------------
  // GET /api/threads — recent conversations for the calling device.
  //
  // Backs the web app's history modal (§7.2). Requires `X-Device-Id` — unlike
  // `POST /api/analyze`, where the header is optional/best-effort, a listing
  // request without one has nothing to filter on, so it is a 400 rather than
  // an empty list (an empty list would be indistinguishable from "this device
  // genuinely has no history yet").
  // ---------------------------------------------------------------------------
  app.get("/api/threads", async (request, reply) => {
    const deviceId = resolveDeviceId(request);
    if (deviceId === null) {
      return reply.status(400).send({ error: "X-Device-Id header must be a UUID" });
    }

    const threads = listRecentThreads(getCheckpointer(), deviceId, 10);
    return reply.status(200).send({ threads });
  });

  // ---------------------------------------------------------------------------
  // GET /api/thread/:threadId — the latest state of one conversation.
  //
  // §7.1 notes `POST /api/analyze` always runs the graph forward — there was
  // previously no way to re-read a thread's current answer without asking a
  // new question. This closes that gap so a thread's URL
  // (`/t/:threadId` in the web app) stays loadable after a refresh or when
  // opened from the history modal, instead of only working via the in-memory
  // client cache of the tab that produced it.
  //
  // Reads the checkpointer's snapshot directly — no `.invoke()`, so this never
  // burns API quota or touches the LLM (§9: no LLM/data-provider calls outside
  // a graph run).
  // ---------------------------------------------------------------------------
  app.get<{ Params: { threadId: string } }>("/api/thread/:threadId", async (request, reply) => {
    const parsed = z.uuid().safeParse(request.params.threadId);
    if (!parsed.success) {
      return reply.status(400).send({ error: "threadId must be a UUID" });
    }
    const threadId = parsed.data;

    const snapshot = await getGraph().getState({ configurable: { thread_id: threadId } });
    // An unknown or already-deleted thread produces an EMPTY values object
    // (LangGraph does not throw for a thread_id it has never seen), not a
    // rejected promise — so absence is detected by checking for the fields a
    // real run always sets, not by catching an error.
    const values = snapshot.values as Partial<AgentState> | undefined;
    if (values === undefined || values.messages === undefined) {
      return reply.status(404).send({ error: "Thread not found" });
    }

    const response = buildAnalyzeResponse(values as AgentState, threadId);
    const query = getThreadLastQuery(getCheckpointer(), threadId) ?? "";
    return reply.status(200).send({ ...response, query });
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/thread/:threadId — discard a conversation.
  //
  // Pruning bounds a thread's size but never removes it entirely, so without
  // this there would be no way to end a conversation. Also the honest answer to
  // "how do I make it forget?".
  // ---------------------------------------------------------------------------
  app.delete<{ Params: { threadId: string } }>("/api/thread/:threadId", async (request, reply) => {
    const parsed = z.uuid().safeParse(request.params.threadId);
    if (!parsed.success) {
      return reply.status(400).send({ error: "threadId must be a UUID" });
    }

    deleteThread(getCheckpointer(), parsed.data);
    return reply.status(200).send({ deleted: parsed.data });
  });

  // ---------------------------------------------------------------------------
  // POST /api/analyze — run the graph (§7).
  // ---------------------------------------------------------------------------
  app.post("/api/analyze", async (request, reply) => {
    const resolved = resolveAnalyzeRequest(request.body);
    if (!resolved.ok) {
      if (resolved.status >= 500) {
        request.log.error({ error: resolved.error, details: resolved.details }, resolved.error);
      }
      return reply
        .status(resolved.status)
        .send({ error: resolved.error, ...(resolved.details ? { details: resolved.details } : {}) });
    }
    const { graphInput, threadId, query } = resolved;

    // --- Run the graph -------------------------------------------------------
    try {
      // `configurable.thread_id` is what the checkpointer keys on. The compiled
      // graph REQUIRES it — a graph built with a checkpointer throws without
      // one — so this is not optional plumbing.
      const result = (await getGraph().invoke(graphInput, {
        configurable: { thread_id: threadId },
      })) as AgentState;

      const response = buildAnalyzeResponse(result, threadId);
      recordActivityIfDeviceKnown(resolveDeviceId(request), threadId, query);

      // Prune AFTER responding conceptually — the user's answer does not depend
      // on it, and a prune failure is logged rather than surfaced (see
      // `pruneThread`). Measured: one turn writes 7 checkpoints totalling
      // ~125 KB, and they accumulate rather than replace, so without this the
      // store grows without bound.
      pruneThread(getCheckpointer(), threadId);

      return reply.status(200).send(response);
    } catch (error) {
      // The nodes are written to degrade rather than throw (§8), so arriving
      // here means something genuinely unexpected happened — a bug, not a data
      // gap. Log the full error, return a safe message.
      request.log.error({ error }, "Graph invocation failed");
      return reply.status(500).send({
        error: "Analysis failed",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/analyze/stream — run the graph, streaming live progress.
  //
  // Same request contract and same eventual result as `POST /api/analyze`
  // (built from the shared helpers above) — the only difference is that this
  // endpoint also writes one NDJSON line per `StreamEvent` (streaming.ts) as
  // the graph actually executes, so a client can render real progress instead
  // of a timed approximation. `POST /api/analyze` is left untouched as a
  // non-streaming fallback.
  //
  // `reply.hijack()` takes the response out of Fastify's normal
  // serialize-and-send lifecycle so this handler can write the body
  // incrementally via the raw Node response — which also means Fastify's own
  // error logging no longer applies past this point, so failures here are
  // logged explicitly.
  // ---------------------------------------------------------------------------
  app.post("/api/analyze/stream", async (request, reply) => {
    const resolved = resolveAnalyzeRequest(request.body);
    if (!resolved.ok) {
      if (resolved.status >= 500) {
        request.log.error({ error: resolved.error, details: resolved.details }, resolved.error);
      }
      return reply
        .status(resolved.status)
        .send({ error: resolved.error, ...(resolved.details ? { details: resolved.details } : {}) });
    }
    const { graphInput, threadId, query } = resolved;
    const deviceId = resolveDeviceId(request);

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
    });

    const write = (event: StreamEvent): void => {
      reply.raw.write(`${JSON.stringify(event)}\n`);
    };

    try {
      const stream = await getGraph().stream(graphInput, {
        configurable: { thread_id: threadId },
        streamMode: ["updates", "custom"],
      });

      for await (const [mode, data] of stream) {
        if (mode === "custom") {
          write(data as StreamEvent);
        } else if (mode === "updates") {
          for (const node of Object.keys(data as Record<string, unknown>)) {
            write({ type: "node_complete", node });
          }
        }
      }

      // Read the final state back through the checkpointer rather than
      // hand-merging the partial `"updates"` chunks above — that reuses the
      // graph's own reducers (notably `messages`' append reducer) instead of
      // re-implementing them here.
      const snapshot = await getGraph().getState({ configurable: { thread_id: threadId } });
      const response = buildAnalyzeResponse(snapshot.values as AgentState, threadId);
      recordActivityIfDeviceKnown(deviceId, threadId, query);
      write({ type: "result", data: response });
    } catch (error) {
      // Mirrors `POST /api/analyze`'s catch block: nodes degrade rather than
      // throw (§8), so reaching here means something genuinely unexpected
      // happened. `reply.hijack()` means Fastify will not log this itself.
      request.log.error({ error }, "Streaming graph invocation failed");
      write({
        type: "error",
        error: "Analysis failed",
        details: [error instanceof Error ? error.message : String(error)],
      });
    } finally {
      // Same reasoning as `POST /api/analyze`: prune after the response is
      // underway, since the client's answer does not depend on it.
      pruneThread(getCheckpointer(), threadId);
      reply.raw.end();
    }
  });

  return app;
}
