/**
 * =============================================================================
 * streaming.ts — the shared vocabulary for live progress narration.
 * =============================================================================
 *
 * WHY THIS EXISTS
 * ----------------
 * `POST /api/analyze/stream` (api.ts) lets a client watch the graph run in
 * real time instead of waiting for one final response. LangGraph gives nodes
 * a `writer` callback (on the optional `config: LangGraphRunnableConfig`
 * second parameter) that sends a chunk out on the `"custom"` stream mode the
 * moment it's called — before the node returns. `emitProgress` is the one
 * place that callback is invoked from, so every node emits the same shape.
 *
 * `config` is OPTIONAL and `emitProgress` is a safe no-op without it. That is
 * deliberate, not an oversight: every node function is covered by a
 * fixture-based Vitest unit test that calls it directly as `nodeFn(state)` or
 * `nodeFn(state, now)`, with no LangGraph runtime around it at all (CLAUDE.md
 * §8's "no live network calls in the test suite" rule implies no graph
 * machinery either). Making `config` required, or `writer` required on it,
 * would force every one of those tests to fabricate a config just to satisfy
 * the type — narration is an observability add-on, not a new precondition for
 * calling a node.
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { AnalyzeResponse } from "./api.js";

/**
 * One line of live narration from inside a running node.
 *
 * `phase` exists only for nodes that drive more than one UI step —
 * concretely, `sector_trend` alone does both the "Data retrieval" and "Trend
 * ranking" work the UI shows as separate steps (CLAUDE.md's capability spec
 * never splits that node in two; the UI's step list predates streaming and
 * still draws that distinction). `phase` lets one node's messages route to
 * two different step logs without inventing a second node.
 */
export interface ProgressEvent {
  type: "progress";
  node: string;
  message: string;
  phase?: string;
}

/** Emitted once a node finishes — derived from the graph's `"updates"` stream mode, not written by node code directly. */
export interface NodeCompleteEvent {
  type: "node_complete";
  node: string;
}

/** The terminal success event: the same payload `POST /api/analyze` returns. */
export interface ResultEvent {
  type: "result";
  data: AnalyzeResponse;
}

/** The terminal failure event — mirrors the non-streaming endpoint's error body. */
export interface StreamErrorEvent {
  type: "error";
  error: string;
  details?: string[];
}

/** One line of the NDJSON body written by `POST /api/analyze/stream`. */
export type StreamEvent = ProgressEvent | NodeCompleteEvent | ResultEvent | StreamErrorEvent;

/**
 * Send one narration line, if anything is listening.
 *
 * Safe to call from any node, with or without a `config` — see the file
 * header for why that matters. `config?.writer?.(...)` is the entire
 * contract: `writer` is only populated by LangGraph when the compiled graph
 * is actually being `.stream()`-ed, so a plain `.invoke()` (as
 * `POST /api/analyze`, the non-streaming endpoint, still uses) never pays for
 * this at all.
 */
export function emitProgress(
  config: LangGraphRunnableConfig | undefined,
  node: string,
  message: string,
  phase?: string,
): void {
  config?.writer?.({
    type: "progress",
    node,
    message,
    ...(phase !== undefined ? { phase } : {}),
  } satisfies ProgressEvent);
}
