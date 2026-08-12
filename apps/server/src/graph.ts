/**
 * =============================================================================
 * graph.ts — StateGraph assembly and routing.
 * =============================================================================
 *
 * THE SHAPE OF THE GRAPH
 * ----------------------
 *
 *                        START
 *                          │
 *                    ┌─────▼─────┐
 *                    │supervisor │  parse the question → intent, timeWindow,
 *                    └─────┬─────┘  sectors, activeCapabilities
 *                          │
 *                  ┌────────▼─────────┐
 *                  │routeAfterSupervisor│  conditional edge — one branch per
 *                  └──┬──────┬──────┬─┘  implemented capability
 *        industry_trend│  single_report│  anything else (no capability)
 *                       │       │       │
 *              sectorTrend  revenueGrowth│
 *                   │            │       │
 *              sectorLeaders  priceRevenueDiscrepancy
 *                   │            │
 *                   │       inorganicSignal
 *                   │            │
 *                   │       sectorBenchmark
 *                   │            │
 *                   │       growthClassification
 *                   │            │
 *                    ┌───────────▼┐
 *                    │reportWriter│◄──────────┐  the correction loop
 *                    └─────┬──────┘           │
 *                          │                  │
 *                    ┌─────▼─────┐            │
 *                    │ validator │            │
 *                    └─────┬─────┘            │
 *                          │                  │
 *                  ┌───────▼────────┐         │
 *                  │routeAfter      │─────────┘  failed, budget remains
 *                  │Validation      │
 *                  └───────┬────────┘
 *                          │  passed, OR budget exhausted
 *                         END
 *
 * WHY THE LOOP IS BOUNDED, AND WHY THAT IS NOT A DETAIL
 * -----------------------------------------------------
 * A graph with an edge that routes BACKWARDS has no built-in termination
 * guarantee. If the model keeps hallucinating the same figure, validator keeps
 * rejecting it, and nothing stops the cycle, the run would spin until it
 * exhausted Gemini's free-tier quota — §1's budget constraint turned into an
 * outage by a control-flow oversight.
 *
 * `retryCount` exists solely to bound this. `report-writer.ts` increments it on
 * every LLM attempt, and `routeAfterValidation` compares it against
 * `MAX_REPORT_ATTEMPTS`. Once the budget is gone the run ENDS with the best
 * available draft plus its caveats, rather than retrying forever or returning
 * nothing.
 *
 * STATE WIRING — see CLAUDE.md §4.1(a)
 * ------------------------------------
 * `AgentStateSchema` is passed to `StateGraph` DIRECTLY rather than restated as
 * an `Annotation.Root`. Verified against the installed `@langchain/langgraph`
 * 1.4.8: it accepts a zod object as a state schema, honours every `.default()`
 * as the channel default, and overwrites by default. Only `messages` needs an
 * explicit append reducer, applied via `withLangGraph` below.
 */

import { END, START, StateGraph } from "@langchain/langgraph";
import { withLangGraph } from "@langchain/langgraph/zod";
import { z } from "zod";
import { AgentStateSchema, type AgentState } from "./state.js";
import { getCheckpointer, type Checkpointer } from "./checkpointer.js";
import { supervisorNode } from "./nodes/supervisor.js";
import { reportWriterNode } from "./nodes/report-writer.js";
import { validatorNode } from "./nodes/validator.js";
import {
  INDUSTRY_TREND_CAPABILITY_ID,
  sectorLeadersNode,
  sectorTrendNode,
} from "./nodes/capabilities/industry-trend/index.js";
import {
  GROWTH_AUTHENTICITY_CAPABILITY_ID,
  growthClassificationNode,
  inorganicSignalNode,
  priceRevenueDiscrepancyNode,
  revenueGrowthNode,
  sectorBenchmarkNode,
} from "./nodes/capabilities/growth-authenticity/index.js";

// =============================================================================
// SECTION 1 — Graph state
// =============================================================================

/**
 * The graph's state schema: `AgentStateSchema` with one field re-declared.
 *
 * `messages` is the ONLY field needing a non-default reducer. Every other field
 * overwrites, which is right: when `sector-trend.ts` returns `sectorRankings`,
 * it means "these are the rankings", not "append these to the existing ones".
 *
 * For `messages` the opposite is true — a node returning one new message means
 * "add this turn to the history". Without the append reducer the history would
 * be replaced by a single message on every node return, and the supervisor
 * (which reads the latest human turn) would lose the user's question.
 */
export const GraphState = AgentStateSchema.extend({
  messages: withLangGraph(z.array(z.any()), {
    reducer: {
      schema: z.array(z.any()),
      fn: (left: unknown[], right: unknown[]) => [...left, ...right],
    },
    default: () => [],
  }),
});

/**
 * Maximum LLM attempts at the report before giving up.
 *
 * 3 is chosen against the free-tier budget (~15 requests/minute on Gemini):
 * enough that a one-off hallucination is corrected, few enough that a
 * persistently confused model cannot drain the quota. In practice the first
 * attempt almost always passes, because the report writer is handed exact
 * figures and told not to compute.
 */
export const MAX_REPORT_ATTEMPTS = 3;

// =============================================================================
// SECTION 2 — Routing
// =============================================================================

/** Node name constants, so a typo is a compile error rather than a dead edge. */
export const NODES = {
  supervisor: "supervisor",
  sectorTrend: "sector_trend",
  sectorLeaders: "sector_leaders",
  revenueGrowth: "revenue_growth",
  priceRevenueDiscrepancy: "price_revenue_discrepancy",
  inorganicSignal: "inorganic_signal",
  sectorBenchmark: "sector_benchmark",
  growthClassification: "growth_classification",
  reportWriter: "report_writer",
  validator: "validator",
} as const;

/**
 * After the supervisor: run a capability, or skip straight to the writer.
 *
 * THIS IS THE PLUGIN SEAM (§1, §3). Adding a capability means adding a branch
 * here and a node registration below — no existing capability's code changes.
 *
 * When no implemented capability matches, we route directly to the report
 * writer, which produces an honest "not supported yet" answer. Routing to END
 * instead would return an empty report and leave the API with nothing to say.
 */
export function routeAfterSupervisor(state: AgentState): string {
  if (state.activeCapabilities.includes(INDUSTRY_TREND_CAPABILITY_ID)) {
    return NODES.sectorTrend;
  }
  if (state.activeCapabilities.includes(GROWTH_AUTHENTICITY_CAPABILITY_ID)) {
    return NODES.revenueGrowth;
  }
  return NODES.reportWriter;
}

/**
 * After the validator: finish, or send the draft back for correction.
 *
 * The three outcomes, in the order they are checked:
 *
 *   1. PASSED       → END. `finalReport` is set; this is the success path.
 *   2. BUDGET GONE  → END anyway. See the salvage note below.
 *   3. FAILED, budget remains → back to the report writer, which will see
 *      `validationNotes` in its prompt and correct rather than re-roll.
 */
export function routeAfterValidation(state: AgentState): string {
  if (state.validationPassed) return END;
  if (state.retryCount >= MAX_REPORT_ATTEMPTS) return END;
  return NODES.reportWriter;
}

/**
 * Last-resort salvage when the retry budget runs out with validation failing.
 *
 * Two different situations reach this function, and they are handled
 * differently:
 *
 *   - A draft EXISTS but failed validation: the draft is emitted WITH ITS
 *     FAILURES STATED inline, so the reader can see exactly which claims were
 *     not verified. This is the same principle as §5.3's refusal to silently
 *     resolve a source disagreement, and §5.8b's `emerging_mover` suppression:
 *     a stated caveat is honest, a silent one is not.
 *
 *   - No draft was ever produced (`draftReport` stayed null — every
 *     `report-writer.ts` attempt threw, e.g. the LLM provider being
 *     misconfigured or unreachable). There is no prose to caveat, so
 *     `finalReport` is left null rather than synthesised into a placeholder
 *     apology. `dataErrors` already carries the actual failure reason for
 *     whoever is debugging (surfaced in the UI's data-notes panel); the report
 *     panel itself just stays empty rather than putting a made-up-looking
 *     error message where a report would go. The deterministic tables (which
 *     did succeed) still render either way.
 */
export function salvageUnvalidatedReport(state: AgentState): Partial<AgentState> {
  if (state.validationPassed || state.finalReport !== null) return {};

  if (state.draftReport === null) {
    return {};
  }

  const caveat =
    `\n\n---\n\n**⚠️ Unverified report.** Automated validation did not pass after ` +
    `${MAX_REPORT_ATTEMPTS} attempts, so the following claims could not be confirmed ` +
    `against the computed data:\n` +
    state.validationNotes.map((n) => `- ${n}`).join("\n") +
    `\n\nTreat the figures above with caution and check them against the data tables.`;

  return { finalReport: state.draftReport + caveat };
}

// =============================================================================
// SECTION 3 — Assembly
// =============================================================================

/**
 * Build and compile the agent graph.
 *
 * Node functions are wrapped rather than passed directly because several take
 * an injectable `now` for testability; the graph always supplies the real
 * clock.
 *
 * @param checkpointer optional per-thread persistence (see `checkpointer.ts`).
 *   OPTIONAL ON PURPOSE. A compiled graph with a checkpointer REQUIRES every
 *   `invoke()` to pass `configurable.thread_id` and throws without it. Most
 *   tests exercise routing and node behaviour where threads are irrelevant, so
 *   forcing a checkpointer on them would mean inventing a thread id in dozens
 *   of places to satisfy machinery under no test. Production goes through
 *   `getGraph()` below, which always supplies one.
 */
export function buildGraph(checkpointer?: Checkpointer) {
  const graph = new StateGraph(GraphState)
    // --- Core nodes --------------------------------------------------------
    // `config` is passed straight through to every node so it can emit live
    // progress narration via `config.writer` (see streaming.ts) — it is
    // present here only when the graph is actually being `.stream()`-ed;
    // `.invoke()` (the non-streaming `/api/analyze` path) leaves it absent,
    // and every node treats that as "narration is a no-op" (see streaming.ts).
    .addNode(NODES.supervisor, (state, config) => supervisorNode(state as AgentState, config))

    // --- Capability: industry-trend (§5) ------------------------------------
    // Strictly sequential: sectorLeaders reads `sectorRankings`, so running
    // them in parallel would leave it with null.
    .addNode(NODES.sectorTrend, (state, config) =>
      sectorTrendNode(state as AgentState, undefined, config),
    )
    .addNode(NODES.sectorLeaders, (state, config) =>
      sectorLeadersNode(state as AgentState, undefined, config),
    )

    // --- Capability: growth-authenticity (§11) ------------------------------
    // Strictly sequential: each later node reads a field an earlier one wrote
    // (see ./nodes/capabilities/growth-authenticity/index.ts's state contract).
    .addNode(NODES.revenueGrowth, (state, config) =>
      revenueGrowthNode(state as AgentState, undefined, config),
    )
    .addNode(NODES.priceRevenueDiscrepancy, (state, config) =>
      priceRevenueDiscrepancyNode(state as AgentState, undefined, config),
    )
    .addNode(NODES.inorganicSignal, (state, config) =>
      inorganicSignalNode(state as AgentState, undefined, config),
    )
    .addNode(NODES.sectorBenchmark, (state, config) =>
      sectorBenchmarkNode(state as AgentState, undefined, config),
    )
    .addNode(NODES.growthClassification, (state, config) =>
      growthClassificationNode(state as AgentState, config),
    )

    // --- Report + validation ------------------------------------------------
    .addNode(NODES.reportWriter, (state, config) => reportWriterNode(state as AgentState, config))
    .addNode(NODES.validator, (state, config) => {
      const result = validatorNode(state as AgentState, config);
      // If this was the final permitted attempt and it failed, salvage the
      // draft now — once routing sends us to END there is no later node that
      // could set `finalReport`.
      const merged = { ...(state as AgentState), ...result };
      if (!merged.validationPassed && merged.retryCount >= MAX_REPORT_ATTEMPTS) {
        return { ...result, ...salvageUnvalidatedReport(merged) };
      }
      return result;
    })

    // --- Edges --------------------------------------------------------------
    .addEdge(START, NODES.supervisor)
    .addConditionalEdges(NODES.supervisor, (state) => routeAfterSupervisor(state as AgentState), [
      NODES.sectorTrend,
      NODES.revenueGrowth,
      NODES.reportWriter,
    ])
    .addEdge(NODES.sectorTrend, NODES.sectorLeaders)
    .addEdge(NODES.sectorLeaders, NODES.reportWriter)
    .addEdge(NODES.revenueGrowth, NODES.priceRevenueDiscrepancy)
    .addEdge(NODES.priceRevenueDiscrepancy, NODES.inorganicSignal)
    .addEdge(NODES.inorganicSignal, NODES.sectorBenchmark)
    .addEdge(NODES.sectorBenchmark, NODES.growthClassification)
    .addEdge(NODES.growthClassification, NODES.reportWriter)
    .addEdge(NODES.reportWriter, NODES.validator)
    .addConditionalEdges(NODES.validator, (state) => routeAfterValidation(state as AgentState), [
      NODES.reportWriter,
      END,
    ]);

  return checkpointer === undefined ? graph.compile() : graph.compile({ checkpointer });
}

/**
 * Process-wide compiled graph, WITH per-thread persistence.
 *
 * Lazy so that importing this module (as tests do, to reach the pure routing
 * functions) neither builds a graph nor opens a database file.
 */
let compiled: ReturnType<typeof buildGraph> | null = null;

export function getGraph(): ReturnType<typeof buildGraph> {
  compiled ??= buildGraph(getCheckpointer());
  return compiled;
}

/** Drop the cached graph — used by tests after swapping the checkpointer. */
export function resetGraphForTesting(): void {
  compiled = null;
}
