/**
 * =============================================================================
 * api/client.ts — the ONLY place the web app talks to the server.
 * =============================================================================
 *
 * CLAUDE.md §7: "The web app's `api/client.ts` is the only place that calls
 * this endpoint — components never call `fetch` directly."
 *
 * WHY THAT RULE EARNS ITS KEEP
 * ----------------------------
 * It is not merely tidiness. Concentrating every request here means:
 *
 *   - the response SHAPE is asserted in one place, so a server contract change
 *     produces one compile error instead of a scattering of runtime surprises;
 *   - error handling, timeouts and cancellation are uniform rather than
 *     reinvented per component;
 *   - components stay presentational (§8), which is what makes them trivial to
 *     reason about — they receive data and render it, nothing else.
 *
 * §9 also applies here in the negative: this file holds NO API keys and calls
 * NO market-data or LLM provider. It talks to our own server and nothing else.
 * Every secret lives server-side in `apps/server/.env`.
 *
 * Every request also carries `X-Device-Id` (§7.2) — the browser's anonymous,
 * non-authenticating identifier from `deviceId.ts`. The server uses it only to
 * scope `GET /api/threads`; nothing here treats it as a credential.
 *
 * THE TYPES BELOW MIRROR THE SERVER, DELIBERATELY BY HAND
 * ------------------------------------------------------
 * They are re-declared rather than imported from `apps/server`. Importing
 * across the workspace boundary would couple the browser bundle to the server's
 * module graph — which pulls in zod, LangChain and better-sqlite3, none of
 * which can run in a browser. A hand-mirrored interface is a small, explicit
 * duplication that keeps the two halves genuinely independent, and the shape is
 * pinned by the server's own API tests.
 */

import { getDeviceId } from "../deviceId.js";

// =============================================================================
// SECTION 1 — The server contract (mirrors apps/server/src/state.ts)
// =============================================================================

/**
 * Where a sector's percentage figure came from.
 *
 * Note what is absent: any value meaning "the sources disagreed and we picked
 * one". §5.3 forbids that, so it is unrepresentable. A disagreement arrives in
 * `trendDataErrors` instead — which is why the UI surfaces those notes rather
 * than hiding them.
 */
export type RankingSource = "yahoo_finance" | "alpha_vantage" | "cross_checked";

export interface SectorRanking {
  sector: string;
  /** Percent change over `window`. 3.4 means +3.4%. */
  pctChange: number;
  window: string;
  source: RankingSource;
}

export type Quadrant = "anchor_leader" | "emerging_mover" | "stable_heavyweight" | "laggard";

/**
 * One company in a sector's leader list.
 *
 * ⚠️ `weightScore` and `speedScore` ARE TWO DIFFERENT MEASUREMENTS ON TWO
 * DIFFERENT SCALES, and §5.4/§9 forbid combining them anywhere in the
 * pipeline — including here, in the client, and including in how they are
 * displayed. `SectorLeadersPanel` renders them as separate columns for exactly
 * this reason.
 *
 *   weightScore — percent of the sector ETF this company represents (0-100).
 *   speedScore  — z-score of its momentum vs its sector peers. 0 is average
 *                 for the sector; negative is legitimate and common.
 */
export interface SectorLeader {
  ticker: string;
  weightScore: number;
  speedScore: number;
  /** Today's volume ÷ its 20-day average. 1.0 is normal. */
  relativeVolume: number;
  quadrant: Quadrant;
}

/** The `POST /api/analyze` response (§7, §7.1). */
export interface AnalyzeResponse {
  finalReport: string | null;
  sectorRankings: SectorRanking[] | null;
  sectorLeaders: Record<string, SectorLeader[]> | null;
  /** Problems not attributable to one capability. */
  dataErrors: string[];
  /** Degradation notes from the industry-trend capability. */
  trendDataErrors: string[];
  /** The window the supervisor actually parsed — label the tables with this. */
  timeWindow: string;
  /** False means the report carries caveats and was not fully verified. */
  validationPassed: boolean;
  /** Send this back to ask a follow-up in the same conversation. */
  threadId: string;
}

/**
 * The `GET /api/thread/:threadId` response (§7.2) — `AnalyzeResponse` plus the
 * question that produced it, so a thread opened from a bare URL (a refresh, a
 * bookmark, a history-modal click) has something to show as the active query
 * without the client having asked anything itself.
 */
export interface ThreadSnapshotResponse extends AnalyzeResponse {
  query: string;
}

/** One row of `GET /api/threads` (§7.2) — backs the history modal. */
export interface RecentThread {
  threadId: string;
  lastQuery: string;
  updatedAt: number;
}

// =============================================================================
// SECTION 1B — Live progress events (mirrors apps/server/src/streaming.ts)
// =============================================================================

/** One line of live narration from inside a running graph node. */
export interface ProgressEvent {
  type: "progress";
  node: string;
  message: string;
  /** Sub-phase within a node, for nodes that drive more than one UI step. */
  phase?: string;
}

/** A graph node finished. */
export interface NodeCompleteEvent {
  type: "node_complete";
  node: string;
}

/** The terminal success event — same payload `POST /api/analyze` returns. */
export interface ResultEvent {
  type: "result";
  data: AnalyzeResponse;
}

/** The terminal failure event. */
export interface StreamErrorEvent {
  type: "error";
  error: string;
  details?: string[];
}

/** One line of the NDJSON body `POST /api/analyze/stream` writes. */
export type StreamEvent = ProgressEvent | NodeCompleteEvent | ResultEvent | StreamErrorEvent;

// =============================================================================
// SECTION 2 — Errors
// =============================================================================

/**
 * A failure the UI can render meaningfully.
 *
 * A distinct class so `App` can tell "the server rejected this request"
 * (actionable — fix the question) from "the server is unreachable"
 * (actionable — start the server), rather than showing one generic message for
 * two very different problems.
 */
export class ApiError extends Error {
  readonly status: number | null;
  readonly details: string[];

  constructor(message: string, status: number | null, details: string[] = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

// =============================================================================
// SECTION 3 — The request
// =============================================================================

/**
 * Base URL for the API.
 *
 * Empty by default, which makes requests same-origin relative paths
 * (`/api/analyze`). In development that hits Vite's dev-server proxy, which
 * forwards to the Fastify server on :3001 — so the browser never makes a
 * cross-origin request and CORS never enters the picture (see vite.config.ts).
 *
 * `VITE_API_BASE_URL` overrides it for a deployment where the client and
 * server are served from different origins. Only variables prefixed `VITE_`
 * are exposed to the bundle by Vite, which is a useful guard: a stray
 * `GOOGLE_API_KEY` in the environment cannot leak into the browser build.
 */
const API_BASE = import.meta.env["VITE_API_BASE_URL"] ?? "";

/**
 * How long to wait before giving up, in milliseconds.
 *
 * Generous on purpose. A COLD request — empty cache — fetches 11 sector ETFs
 * plus up to 100 constituents per analysed sector, and was measured at ~24
 * seconds end to end. A warm one takes ~4.5s. A conventional 10s timeout would
 * abort exactly the first request a new user makes, which is the worst possible
 * one to fail.
 */
const REQUEST_TIMEOUT_MS = 120_000;

/** Arguments for {@link analyze}. */
export interface AnalyzeArgs {
  query: string;
  /**
   * Continue an existing conversation. Omit to start a new one; the server
   * generates an id and returns it on every response.
   */
  threadId?: string;
  /** Lets the caller cancel — e.g. if the user submits again mid-flight. */
  signal?: AbortSignal;
}

/**
 * Run a sector analysis.
 *
 * @throws {ApiError} on a non-2xx response, a network failure, or a timeout.
 *         Never returns a partially-typed object: either the full contract
 *         arrives, or this throws.
 */
export async function analyze({ query, threadId, signal }: AnalyzeArgs): Promise<AnalyzeResponse> {
  // Combine our timeout with any caller-supplied cancellation, so whichever
  // fires first aborts the request.
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);

  const onExternalAbort = () => timeoutController.abort();
  signal?.addEventListener("abort", onExternalAbort);

  try {
    const response = await fetch(`${API_BASE}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Id": getDeviceId() },
      // `threadId` is omitted entirely when undefined rather than sent as null,
      // because the server's schema treats it as optional, not nullable.
      body: JSON.stringify(threadId === undefined ? { query } : { query, threadId }),
      signal: timeoutController.signal,
    });

    if (!response.ok) {
      // The server sends `{ error, details? }` for 4xx/5xx. Parsing is
      // best-effort: a proxy or crash can return HTML instead of JSON, and a
      // parse failure there must not mask the real status code.
      let message = `Request failed with status ${response.status}`;
      let details: string[] = [];
      try {
        const body = (await response.json()) as { error?: string; details?: string[] };
        if (typeof body.error === "string") message = body.error;
        if (Array.isArray(body.details)) details = body.details;
      } catch {
        // Deliberately empty is NOT allowed by §8 — so note what happens:
        // we keep the status-derived message above and carry on. The failure
        // is still reported, just without server-supplied detail.
        message = `${message} (response body was not JSON)`;
      }
      throw new ApiError(message, response.status, details);
    }

    return (await response.json()) as AnalyzeResponse;
  } catch (error) {
    if (error instanceof ApiError) throw error;

    // An abort is either our timeout or the caller cancelling. Distinguish
    // them, because only one is a problem worth showing the user.
    if (error instanceof DOMException && error.name === "AbortError") {
      if (signal?.aborted === true) {
        throw new ApiError("Request cancelled.", null);
      }
      throw new ApiError(
        `The request timed out after ${REQUEST_TIMEOUT_MS / 1000}s. A first request with an ` +
          `empty cache can take ~25s; something may be wrong with the server.`,
        null,
      );
    }

    // Everything left is a transport failure — most commonly the server simply
    // not running, which is worth saying plainly rather than as "fetch failed".
    throw new ApiError(
      `Could not reach the server. Is it running on port 3001? ` +
        `(${error instanceof Error ? error.message : String(error)})`,
      null,
    );
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

/** Arguments for {@link analyzeStream}. */
export interface AnalyzeStreamArgs extends AnalyzeArgs {
  /** Called once per NDJSON line as it arrives — before the run has finished. */
  onEvent: (event: StreamEvent) => void;
}

/**
 * Run a sector analysis, calling `onEvent` with live progress as the graph
 * actually executes server-side (`POST /api/analyze/stream`), and resolving
 * with the same final shape {@link analyze} would have returned.
 *
 * Deliberately NOT built on `EventSource`: this request needs a JSON POST
 * body (the query, and an optional `threadId`), and `EventSource` is
 * GET-only. The server writes newline-delimited JSON (NDJSON) instead of full
 * SSE framing — there is no reconnection/Last-Event-ID need here, since this
 * is one in-flight request already governed by the same
 * AbortController-based timeout as {@link analyze}.
 *
 * @throws {ApiError} on a non-2xx response, a network failure, a timeout, or
 *         a `"error"` event from the server. Exactly like `analyze`, this
 *         either resolves with the full contract or throws — never a partial
 *         result — even though `onEvent` may have already delivered several
 *         progress lines by the time that happens.
 */
export async function analyzeStream({
  query,
  threadId,
  signal,
  onEvent,
}: AnalyzeStreamArgs): Promise<AnalyzeResponse> {
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);

  const onExternalAbort = () => timeoutController.abort();
  signal?.addEventListener("abort", onExternalAbort);

  try {
    const response = await fetch(`${API_BASE}/api/analyze/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Id": getDeviceId() },
      body: JSON.stringify(threadId === undefined ? { query } : { query, threadId }),
      signal: timeoutController.signal,
    });

    if (!response.ok) {
      // Mirrors `analyze()`: a non-2xx here means the request was rejected
      // before the graph ever started streaming, so the body is still plain
      // JSON (`{ error, details? }`), not NDJSON.
      let message = `Request failed with status ${response.status}`;
      let details: string[] = [];
      try {
        const body = (await response.json()) as { error?: string; details?: string[] };
        if (typeof body.error === "string") message = body.error;
        if (Array.isArray(body.details)) details = body.details;
      } catch {
        message = `${message} (response body was not JSON)`;
      }
      throw new ApiError(message, response.status, details);
    }

    if (response.body === null) {
      throw new ApiError("Streaming response had no body.", response.status);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    // Holds whatever's left after the last complete `\n`-terminated line —
    // a chunk boundary can land in the middle of a line, so this must
    // persist across `read()` calls rather than being parsed per-chunk.
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim() === "") continue;
        const event = JSON.parse(line) as StreamEvent;

        if (event.type === "result") {
          onEvent(event);
          return event.data;
        }
        if (event.type === "error") {
          throw new ApiError(event.error, null, event.details ?? []);
        }
        onEvent(event);
      }
    }

    // The stream ended without a terminal "result"/"error" line — the server
    // always writes one or the other before `reply.raw.end()`, so reaching
    // this is a transport-level truncation, not a normal outcome.
    throw new ApiError("Stream ended unexpectedly before a result arrived.", null);
  } catch (error) {
    if (error instanceof ApiError) throw error;

    if (error instanceof DOMException && error.name === "AbortError") {
      if (signal?.aborted === true) {
        throw new ApiError("Request cancelled.", null);
      }
      throw new ApiError(
        `The request timed out after ${REQUEST_TIMEOUT_MS / 1000}s. A first request with an ` +
          `empty cache can take ~25s; something may be wrong with the server.`,
        null,
      );
    }

    throw new ApiError(
      `Could not reach the server. Is it running on port 3001? ` +
        `(${error instanceof Error ? error.message : String(error)})`,
      null,
    );
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * Discard a conversation thread (§7.1).
 *
 * Pruning bounds a thread's size on the server but never removes it, so this
 * is the only way to actually end one.
 */
export async function deleteThread(threadId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/api/thread/${encodeURIComponent(threadId)}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    throw new ApiError(`Could not delete thread (status ${response.status})`, response.status);
  }
}

/**
 * Re-fetch a thread's latest state without asking a new question (§7.2).
 *
 * What makes `/t/:threadId` a real, deep-linkable URL rather than something
 * that only works for the tab that produced it: a refresh, a bookmark, or a
 * click from the history modal all land here instead of needing an in-memory
 * cache that a page load would have already lost.
 *
 * @throws {ApiError} with `status: 404` if the thread does not exist (never
 *         created, or discarded via {@link deleteThread}) — the caller should
 *         treat that as "this conversation is gone", not a transient failure.
 */
export async function fetchThread(threadId: string): Promise<ThreadSnapshotResponse> {
  const response = await fetch(`${API_BASE}/api/thread/${encodeURIComponent(threadId)}`);

  if (!response.ok) {
    if (response.status === 404) {
      throw new ApiError("This conversation could not be found.", 404);
    }
    throw new ApiError(`Could not load thread (status ${response.status})`, response.status);
  }

  return (await response.json()) as ThreadSnapshotResponse;
}

/**
 * The current device's most recent conversations, newest first (§7.2).
 *
 * Backs the history modal. "Current device" means whatever `getDeviceId()`
 * returns — a different browser, or this one with `localStorage` cleared,
 * simply has no history to show, which is the honest behaviour of a scheme
 * with no server-side account to fall back on.
 */
export async function listRecentThreads(): Promise<RecentThread[]> {
  const response = await fetch(`${API_BASE}/api/threads`, {
    headers: { "X-Device-Id": getDeviceId() },
  });

  if (!response.ok) {
    throw new ApiError(`Could not load history (status ${response.status})`, response.status);
  }

  const body = (await response.json()) as { threads: RecentThread[] };
  return body.threads;
}
