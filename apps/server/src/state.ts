/**
 * =============================================================================
 * state.ts — the single source of truth for graph state.
 * =============================================================================
 *
 * WHAT THIS FILE IS
 * -----------------
 * A LangGraph graph is, at heart, a state machine: every node is a function
 * that receives the current state and returns a *patch* to it. That shared
 * state object is the only way two nodes ever communicate — there are no
 * function arguments passed node-to-node, no globals, no hidden context. So
 * the shape defined here is effectively the wiring diagram of the whole agent.
 *
 * WHY ZOD AND NOT A PLAIN `interface`
 * -----------------------------------
 * CLAUDE.md §4 asks for zod specifically, and the reason is that a zod schema
 * is two things at once:
 *
 *   1. a RUNTIME validator  — `AgentStateSchema.parse(x)` throws on bad data;
 *   2. a STATIC type        — `z.infer<typeof AgentStateSchema>` gives you the
 *                             TypeScript type for free.
 *
 * A hand-written `interface` gives you only (2). That matters here because
 * state crosses two untrusted boundaries: the HTTP request body arriving at
 * `POST /api/analyze`, and LLM output being folded back into state by the
 * report writer. At both of those points we want a real runtime check, and we
 * want it derived from the same declaration as the type — so the two can never
 * drift apart.
 *
 * THE ONE RULE THAT GOVERNS THIS FILE (CLAUDE.md §1)
 * -------------------------------------------------
 * The LLM never computes a number. Look at the field list below with that in
 * mind and it splits cleanly in two:
 *
 *   - Numeric fields (`sectorRankings`, `sectorLeaders`) are written ONLY by
 *     deterministic TypeScript nodes. The LLM reads them as context.
 *   - Prose fields (`draftReport`, `finalReport`) are written by the LLM and
 *     then checked BACK against the numeric fields by `validator.ts` (§5.6).
 *
 * Every number in a user-facing report therefore traces to a value some plain
 * function computed. That is the whole architecture in one sentence.
 *
 * EXTENSION CONTRACT (CLAUDE.md §4)
 * ---------------------------------
 * Future capabilities add their own namespaced fields in their own labelled
 * block. Two capabilities must never write the same field. The block comment
 * markers below ("--- Industry trend capability ---") are the convention: a new
 * capability appends a new block, it does not widen an existing one.
 */

import { z } from "zod";
// `import type` (not a plain `import`) because `verbatimModuleSyntax` is on:
// this brings in ONLY the type and emits no runtime import of the module.
import type { BaseMessage } from "@langchain/core/messages";

// =============================================================================
// SECTION 1 — Domain sub-schemas
//
// These are the two record types the industry-trend capability produces. They
// are exported on their own (not just as part of AgentState) because three
// other places need them independently: the API response type in `api.ts`,
// the validator's claim-checking logic, and the React tables in apps/web.
// =============================================================================

/**
 * One company inside one sector's leader list.
 *
 * THE CENTRAL DESIGN POINT OF THIS ENTIRE CAPABILITY lives in the two score
 * fields below. CLAUDE.md §5.4 forbids, in bold, blending them into a single
 * composite number, and §9 repeats the ban. The reason is that they answer
 * genuinely different questions and combining them destroys information:
 *
 *   weightScore — "how much of this sector IS this company?"
 *                 A structural, slow-moving fact. NVDA being ~15% of XLK means
 *                 XLK cannot move much without NVDA moving.
 *
 *   speedScore  — "how fast is this company moving RELATIVE TO ITS PEERS?"
 *                 A behavioural, fast-moving fact, z-scored against the
 *                 sector's own constituent distribution so a +4% week means
 *                 something different in a calm sector than a volatile one.
 *
 * A single blended score would rank a 15%-weight/flat stock identically to a
 * 3%-weight/exploding one, which is precisely the distinction a user asking
 * "who's leading this sector?" is trying to draw. Keeping them separate is
 * what makes the `quadrant` field below meaningful at all.
 */
export const SectorLeaderSchema = z.object({
  /** Stock symbol, e.g. "NVDA". Uppercase, as returned by the holdings source. */
  ticker: z.string(),

  /**
   * Percentage weight of this company in its sector ETF, taken from the ETF's
   * DISCLOSED holdings (§5.4: this is the authoritative structural-size
   * metric). Expressed as a percentage, so ~15.2 means 15.2% of the fund.
   *
   * Deriving this from raw market cap is a documented FALLBACK ONLY, allowed
   * when holdings data is unavailable, and the fallback must be recorded in
   * `trendDataErrors` when it happens.
   */
  weightScore: z.number(),

  /**
   * Momentum, z-scored against this sector's own constituents.
   *
   * A z-score restates a raw value as "how many standard deviations from the
   * group mean": z = (x − mean) / stdDev. So 0 is exactly average for the
   * sector, +2 is two standard deviations hotter than its peers, −1.5 is
   * notably colder. Being sector-relative is the point — §5.4 is explicit that
   * speed is "relative to sector peers, not absolute".
   *
   * Unbounded in both directions, and legitimately negative for laggards.
   */
  speedScore: z.number(),

  /**
   * Today's volume ÷ the trailing 20-day average volume. A SECONDARY
   * confirmation signal (§5.4), not an input to the quadrant.
   *
   * 1.0 = trading at its normal pace. 2.5 = two and a half times normal, which
   * suggests a price move has real participation behind it rather than being
   * a thin-volume drift.
   */
  relativeVolume: z.number(),

  /**
   * Where this company falls on the weight × speed grid. Assigned by applying
   * fixed thresholds (§5.4 suggests terciles) to weight and speed
   * INDEPENDENTLY — never to a combined score.
   *
   *                      high speed          low speed
   *                  ┌───────────────────┬────────────────────────┐
   *      high weight │  anchor_leader    │  stable_heavyweight    │
   *                  │  genuinely driving│  big, but not the      │
   *                  │  the sector move  │  reason it moved       │
   *                  ├───────────────────┼────────────────────────┤
   *       low weight │  emerging_mover   │  laggard               │
   *                  │  early signal —   │  small and slow        │
   *                  │  moving hard, too │                        │
   *                  │  small to move the│                        │
   *                  │  index yet        │                        │
   *                  └───────────────────┴────────────────────────┘
   *
   * The report writer (§5.5) uses this directly: name `anchor_leader`
   * companies first because they are the ones actually causing the sector
   * move, then flag `emerging_mover` names as an "early signal" callout.
   */
  quadrant: z.enum(["anchor_leader", "emerging_mover", "stable_heavyweight", "laggard"]),
});

/**
 * One GICS sector's performance over the requested window.
 *
 * Produced by `sector-trend.ts` (§5.3) from the 11 SPDR sector ETFs. The
 * array of these in state is sorted most-positive to most-negative.
 */
export const SectorRankingSchema = z.object({
  /** Human-readable GICS sector name, e.g. "Information Technology". */
  sector: z.string(),

  /** Percent change over `window`. 3.4 means +3.4%; negative means down. */
  pctChange: z.number(),

  /**
   * Which window this figure covers, echoed from `AgentState.timeWindow`.
   * Carried per-row rather than assumed globally so a report can never
   * accidentally present a 1-month number as a 5-day one.
   */
  window: z.string(),

  /**
   * Provenance — which data source this number came from. `"cross_checked"`
   * means Yahoo and Alpha Vantage were compared and AGREED within threshold.
   *
   * Note what this enum does NOT contain: a value meaning "the sources
   * disagreed and we picked one". §5.3 forbids silently resolving a
   * disagreement; a conflict is recorded in `trendDataErrors` instead. Leaving
   * that value out of the enum makes the forbidden behaviour unrepresentable.
   */
  source: z.enum(["yahoo_finance", "alpha_vantage", "cross_checked"]),
});

// -----------------------------------------------------------------------------
// Growth-authenticity capability sub-schemas.
//
// Produced by `nodes/capabilities/growth-authenticity/*`. Five nodes, four of
// which own exactly one of the fields below (never shared) plus a fifth that
// assembles the public-facing `GrowthAuthenticityResultSchema` from the other
// four. See CLAUDE.md §11 once written; for now the state contract lives in
// `nodes/capabilities/growth-authenticity/index.ts`.
//
// Per CLAUDE.md's anti-blending rule (§5.4/§9, applied identically here): every
// numeric signal below stays disaggregated all the way to the report writer.
// `classification` is the one field that reduces them to a single value, and it
// is a categorical label from a fixed decision table over categorical flags —
// never an arithmetic blend of the numbers themselves.
// -----------------------------------------------------------------------------

/**
 * A trend over a company's own trailing history, expressed as both a raw %
 * change and a robust z-score against that same history.
 *
 * `zScore` uses MEDIAN and MAD (median absolute deviation), not mean/stdDev,
 * because a single genuine past event (e.g. one real prior acquisition quarter
 * inside the lookback window) would otherwise blow out a mean/stdDev baseline
 * and mask a new one. `baselineQuarterCount` records how many historical points
 * fed the baseline so a caller can tell "no signal" apart from "not enough
 * history to have an opinion".
 */
export const TrendSchema = z.object({
  deltaPct: z.number().nullable(),
  zScore: z.number().nullable(),
  baselineQuarterCount: z.number(),
  direction: z.enum(["increasing", "decreasing", "flat", "insufficient_data"]),
});

/** YoY quarterly revenue growth for one ticker. From `revenue-growth.ts`. */
export const RevenueGrowthResultSchema = z.object({
  ticker: z.string(),
  /** ISO date (yyyy-mm-dd) of the most recent quarter used, or null if none. */
  latestQuarterEnd: z.string().nullable(),
  revenueGrowthPct: z.number().nullable(),
  basis: z.enum(["yoy_quarterly", "insufficient_data"]),
});

/**
 * How the stock's price move compares to its revenue growth. From
 * `price-revenue-discrepancy.ts`.
 *
 * `priceToRevenueGrowthRatio` is only ever computed when `revenueGrowthPct` is
 * strictly positive — dividing by a flat-or-declining revenue figure produces a
 * number with no meaningful interpretation, so that case is instead an explicit
 * `discrepancyFlag` value rather than a silent NaN/Infinity.
 *
 * `"insufficient_history"` (added after live calibration against real Yahoo
 * data — see CLAUDE.md §11.9) is DELIBERATELY DISTINCT from `"aligned"`.
 * Yahoo's free `fundamentalsTimeSeries` endpoint returns a fixed ~5 usable
 * quarters (~15 months) regardless of how far back it's asked to look, which
 * structurally cannot satisfy the YoY-spaced own-history baseline this ratio
 * needs. Before this field existed, that case silently fell back to
 * `"aligned"` — a real, observed failure: a live run on APA with price +113%
 * and revenue +8.95% (raw ratio ≈12.6x, a bigger divergence than the original
 * flat 2.0x cutoff this design replaced would ever need to flag) reported
 * `"aligned"` purely because there was no baseline to z-score against.
 * `"aligned"` is a claim ("no discrepancy found"); the honest claim when the
 * baseline is missing is "insufficient history to judge" — a different one.
 */
export const DiscrepancyResultSchema = z.object({
  priceChangePct: z.number().nullable(),
  priceToRevenueGrowthRatio: z.number().nullable(),
  ratioZScore: z.number().nullable(),
  baselineQuarterCount: z.number(),
  discrepancyFlag: z.enum([
    "price_outpacing_revenue",
    "revenue_outpacing_price",
    "aligned",
    "insufficient_history",
    "not_computable",
  ]),
});

/**
 * Balance-sheet evidence of inorganic (M&A-driven) growth. From
 * `inorganic-signal.ts`.
 *
 * Goodwill is the PRIMARY signal — it only moves materially through M&A
 * purchase accounting. PP&E also moves from ordinary organic capex (building a
 * new plant is real, not "inorganic"), so it is corroborating only, and only
 * counts alongside a simultaneous cash decrease.
 */
export const InorganicSignalResultSchema = z.object({
  goodwillTrend: TrendSchema,
  ppeTrend: TrendSchema,
  cashTrend: TrendSchema,
  inorganicSignal: z.enum(["likely_ma_driven", "no_signal", "insufficient_data"]),
});

/**
 * Is the stock's move just its sector/commodity beta? From
 * `sector-benchmark.ts`. This is the direct implementation of "is this just
 * oil at $90/barrel" rather than company-specific news.
 */
export const SectorBenchmarkResultSchema = z.object({
  /** Resolved GICS sector name (matches SECTOR_ETF_TO_GICS values), or null. */
  sector: z.string().nullable(),
  sectorBenchmarkPct: z.number().nullable(),
  /** priceChangePct - sectorBenchmarkPct. */
  stockVsSectorSpreadPct: z.number().nullable(),
  macroBetaFlag: z.enum(["beta_explained", "stock_specific_move", "not_computable"]),
});

/**
 * The assembled, public-facing result. From `growth-classification.ts`, which
 * reads the four fields above and reduces them to this single object via a
 * fixed decision table (mirrors `classifyQuadrant` in `sector-leaders.ts`) —
 * never an arithmetic blend of the underlying numbers.
 */
export const GrowthAuthenticityResultSchema = z.object({
  ticker: z.string(),
  timeWindow: z.string(),
  revenueGrowth: RevenueGrowthResultSchema,
  discrepancy: DiscrepancyResultSchema,
  inorganic: InorganicSignalResultSchema,
  sectorBenchmark: SectorBenchmarkResultSchema,
  classification: z.enum([
    "organic_growth_supported",
    "inorganic_ma_driven",
    "macro_or_commodity_beta_driven",
    "price_outpacing_fundamentals_unexplained",
    "mixed_signals",
    "insufficient_data",
  ]),
  /** Machine-readable citations, e.g. "discrepancy:price_outpacing_revenue". */
  classificationReasonCodes: z.array(z.string()),
});

// =============================================================================
// SECTION 2 — The graph state schema
// =============================================================================

/**
 * The complete shared state for one graph run.
 *
 * Grouped into blocks by owner. Read the "written by" note on each block as a
 * contract: if a node writes a field outside its block, that is a bug, and the
 * JSDoc on each node (required by §8) is where that is declared and reviewed.
 */
export const AgentStateSchema = z.object({
  // ---------------------------------------------------------------------------
  // CONVERSATION
  // Written by: the API layer (seeds the user turn) and the report writer.
  // ---------------------------------------------------------------------------

  /**
   * The message history, as `BaseMessage[]` from `@langchain/core`.
   *
   * Typed `z.any()` DELIBERATELY, and this is the one place in the codebase
   * where that is correct. `BaseMessage` is a class hierarchy with methods and
   * internal LangChain machinery — modelling it structurally in zod would be a
   * large, brittle mirror of someone else's implementation detail that adds no
   * safety. §8's ban on `any` is about untyped *external API responses*
   * reaching node code; these objects arrive already typed by LangChain.
   *
   * The static type is narrowed back to `BaseMessage[]` in `AgentState` below,
   * so callers still get real autocomplete.
   *
   * REDUCER NOTE: this is the one field that must APPEND rather than overwrite
   * when wired into the graph — a node returning one new message means "add
   * this turn", not "the history is now one message long". Every other field
   * below uses a plain overwrite reducer.
   */
  messages: z.array(z.any()),

  // ---------------------------------------------------------------------------
  // REQUEST PARSING
  // Written by: `supervisor.ts`, from the raw user question. Read by: every
  // capability node. Nothing downstream re-parses the user's text — the
  // supervisor is the only place natural language becomes structured fields.
  // ---------------------------------------------------------------------------

  /**
   * Explicit tickers mentioned by the user, e.g. ["NVDA", "AMD"].
   * Unused by the industry-trend capability (which discovers its tickers from
   * ETF holdings) but part of the core state contract for future capabilities.
   */
  tickers: z.array(z.string()).default([]),

  /**
   * Sectors the user named explicitly. EMPTY IS MEANINGFUL: it means "the user
   * didn't narrow it down, rank all 11", which is the common case for a
   * question like "what sectors are trending up this month".
   */
  sectors: z.array(z.string()).default([]),

  /**
   * What the user is asking for. Drives routing in `graph.ts`.
   *
   * `sector_trend` routes to the industry-trend capability; `single_report`
   * routes to the growth-authenticity capability (single ticker, "why did this
   * stock move and is it real"); `portfolio_scan` routes to the portfolio-scan
   * capability (§12 of CLAUDE.md — multiple named tickers, or "my portfolio"
   * phrasing, each classified independently). `followup` activates NO
   * capability of its own — it reuses whatever capability output is already
   * in state from an earlier turn in the same thread (`report-writer.ts`'s
   * followup branch), only reachable when a prior analysis actually exists.
   * `general_chat` is different in kind, not just capability-less — it is the
   * honest classification for input that is not a finance question at all
   * (small talk, "what can you do?"), and it DOES get a real LLM-generated
   * reply from `report-writer.ts`, just without ever activating a
   * capability's tool calls.
   *
   * NOTE: no `.default()`. See the "two required fields" comment at the end of
   * this file — this is intentional and worth a decision from the reviewer.
   */
  intent: z.enum(["sector_trend", "single_report", "portfolio_scan", "followup", "general_chat"]),

  /**
   * Lookback window for all performance math, e.g. "5d", "1mo", "3mo", "ytd".
   *
   * Typed as a free-form `z.string()` per §4 rather than an enum, because the
   * value is passed through to `yahoo-finance2`, whose accepted period/range
   * vocabulary is its own. Tightening this to an enum would mean maintaining a
   * copy of a third-party library's accepted values here.
   *
   * Also has no `.default()` — same note at the end of the file.
   */
  timeWindow: z.string(),

  /**
   * Which capabilities should run for this request, e.g. ["industry_trend"].
   *
   * THIS IS THE PLUGIN SEAM described in §1 and §3. `graph.ts` routes on this
   * array; the report writer branches on it (§5.5: "When `activeCapabilities`
   * includes `"industry_trend"` ..."). Adding a capability later means the
   * supervisor learns to push a new string here — no existing capability's
   * code changes.
   */
  activeCapabilities: z.array(z.string()).default([]),

  // ---------------------------------------------------------------------------
  // --- Industry trend capability ---
  // Written by: `nodes/capabilities/industry-trend/*` ONLY.
  // Read by:    `report-writer.ts`, `validator.ts`, and the API response.
  //
  // `null` vs `[]` is a real distinction in this block and both nodes must
  // respect it:
  //     null → this capability did not run
  //     []   → it ran and legitimately found nothing
  // Collapsing the two would make "the graph skipped this" indistinguishable
  // from "there is genuinely no data", which the validator needs to tell apart.
  // ---------------------------------------------------------------------------

  /** All 11 sectors, ranked most-positive to most-negative. From `sector-trend.ts` (§5.3). */
  sectorRankings: z.array(SectorRankingSchema).nullable().default(null),

  /**
   * Leader lists keyed by sector name, e.g. `{ "Information Technology": [...] }`.
   * From `sector-leaders.ts` (§5.4). Within each sector, sorted by `speedScore`
   * descending.
   *
   * Only populated for the sectors flagged as trending (top N up, top N down) —
   * not all 11 — because building a leader list costs one holdings fetch plus
   * one OHLCV fetch per constituent, and §1's free-tier budget will not absorb
   * that for sectors nobody asked about.
   */
  sectorLeaders: z.record(z.string(), z.array(SectorLeaderSchema)).nullable().default(null),

  /**
   * Non-fatal problems specific to this capability, as human-readable strings.
   *
   * This field is how §5.7's edge cases stay visible instead of becoming
   * silent wrong answers. Things that land here:
   *   - a recent IPO excluded from speed ranking for want of price history;
   *   - Alpha Vantage's 25/day quota exhausted, so the cross-check was skipped;
   *   - Yahoo and Alpha Vantage disagreeing beyond threshold on a sector;
   *   - weight falling back to market cap because holdings data was missing.
   *
   * Appending here is ALWAYS preferable to throwing: §8 forbids a tool-layer
   * failure crashing a graph run, and a partial answer with a stated caveat
   * beats no answer.
   */
  trendDataErrors: z.array(z.string()).default([]),

  // ---------------------------------------------------------------------------
  // --- Growth-authenticity capability ---
  // Written by: `nodes/capabilities/growth-authenticity/*` ONLY. Each of the
  // first four fields is owned by exactly one node — never co-written, because
  // this project's zod-object state fields use an OVERWRITE reducer, not a
  // deep merge, so two nodes sharing one object field would let the second
  // silently erase the first's work. `growthAuthenticity` is the fifth node's
  // assembled result and is what `report-writer.ts`/`validator.ts`/`api.ts`
  // actually consume.
  //
  // Same null-vs-populated convention as the industry-trend block: null means
  // this node/capability did not run.
  // ---------------------------------------------------------------------------

  /** From `revenue-growth.ts`. */
  revenueGrowth: RevenueGrowthResultSchema.nullable().default(null),
  /** From `price-revenue-discrepancy.ts`. */
  priceRevenueDiscrepancy: DiscrepancyResultSchema.nullable().default(null),
  /** From `inorganic-signal.ts`. */
  inorganicSignal: InorganicSignalResultSchema.nullable().default(null),
  /** From `sector-benchmark.ts`. */
  sectorBenchmark: SectorBenchmarkResultSchema.nullable().default(null),
  /** From `growth-classification.ts`. The report/validator/API-facing result. */
  growthAuthenticity: GrowthAuthenticityResultSchema.nullable().default(null),

  /** Non-fatal problems specific to this capability. Same role as `trendDataErrors`. */
  growthCheckErrors: z.array(z.string()).default([]),

  // ---------------------------------------------------------------------------
  // GENERIC
  // ---------------------------------------------------------------------------

  /**
   * Non-fatal problems not attributable to any one capability — cache failures,
   * a provider being unreachable, a zod parse failing on an external response.
   *
   * Surfaced to the user via the API response (§7), so the UI can show "this
   * report was built with incomplete data" rather than presenting a degraded
   * answer as a complete one.
   */
  dataErrors: z.array(z.string()).default([]),

  // ---------------------------------------------------------------------------
  // REPORT WRITER + VALIDATOR
  // The bounded feedback loop. Written by: `report-writer.ts`, `validator.ts`.
  // ---------------------------------------------------------------------------

  /**
   * LLM-authored prose, not yet checked. The ONLY LLM-generated field that
   * exists before validation.
   */
  draftReport: z.string().nullable().default(null),

  /**
   * Did `draftReport` survive `validator.ts`? The validator confirms every
   * ticker and every percentage in the draft actually appears in
   * `sectorRankings`/`sectorLeaders` (§5.6). This is the enforcement point for
   * §1 — an LLM that invents a plausible-sounding number fails here.
   */
  validationPassed: z.boolean().default(false),

  /**
   * Why validation failed, specifically enough to be actionable — e.g.
   * "report cites AVGO at +9.1% but sectorLeaders has no AVGO entry".
   *
   * Fed back into the report writer's prompt on retry, which is what makes the
   * loop a correction loop rather than a re-roll.
   */
  validationNotes: z.array(z.string()).default([]),

  /** The validated report. Non-null means this run produced a trustworthy answer. */
  finalReport: z.string().nullable().default(null),

  /**
   * How many times we have been round the write → validate → rewrite loop.
   *
   * This exists purely to BOUND that loop. A graph whose conditional edge can
   * route backwards has no built-in termination guarantee: an LLM that keeps
   * hallucinating the same number would otherwise loop until it burned the
   * free-tier quota. `graph.ts` compares this against a maximum and, once
   * exceeded, ends the run with the best draft plus its caveats rather than
   * retrying forever.
   */
  retryCount: z.number().default(0),
});

// =============================================================================
// SECTION 3 — Inferred types
// =============================================================================

/** One company in a sector's leader list. */
export type SectorLeader = z.infer<typeof SectorLeaderSchema>;

/** One sector's ranked performance. */
export type SectorRanking = z.infer<typeof SectorRankingSchema>;

/** The quadrant union, extracted so nodes/UI can switch over it exhaustively. */
export type Quadrant = SectorLeader["quadrant"];

/** A trend with a robust z-score against the company's own trailing history. */
export type Trend = z.infer<typeof TrendSchema>;

/** YoY quarterly revenue growth for one ticker. */
export type RevenueGrowthResult = z.infer<typeof RevenueGrowthResultSchema>;

/** Price-vs-revenue-growth discrepancy for one ticker. */
export type DiscrepancyResult = z.infer<typeof DiscrepancyResultSchema>;

/** Balance-sheet evidence of inorganic (M&A-driven) growth. */
export type InorganicSignalResult = z.infer<typeof InorganicSignalResultSchema>;

/** Sector/macro-beta comparison for one ticker. */
export type SectorBenchmarkResult = z.infer<typeof SectorBenchmarkResultSchema>;

/** The assembled growth-authenticity result. */
export type GrowthAuthenticityResult = z.infer<typeof GrowthAuthenticityResultSchema>;

/** The classification union, extracted so nodes/UI can switch over it exhaustively. */
export type GrowthClassification = GrowthAuthenticityResult["classification"];

/**
 * Raw inferred state — `messages` is `any[]` here, straight from the schema.
 * Not exported; used only as the base for the narrowed `AgentState` below.
 */
type AgentStateBase = z.infer<typeof AgentStateSchema>;

/** The intent union, extracted so the supervisor can switch over it exhaustively. */
export type Intent = AgentStateBase["intent"];

/**
 * The graph state type used everywhere in the server.
 *
 * Identical to the inferred schema type except that `messages` is narrowed
 * from `any[]` back to `BaseMessage[]`. This is the "parse at the boundary,
 * keep real types inside" pattern §8 asks for: zod stays permissive about the
 * message objects at runtime (they are LangChain's own class instances, not
 * plain data), while the compiler still holds us to the real interface.
 */
export type AgentState = Omit<AgentStateBase, "messages"> & {
  messages: BaseMessage[];
};

// -----------------------------------------------------------------------------
// NOTE ON THE TWO REQUIRED FIELDS  (resolved — see CLAUDE.md §4.1(b))
//
// `intent` and `timeWindow` are the only fields with no `.default()`, exactly
// as §4 specifies. They stay that way, and the guarantee is enforced at the
// HTTP boundary rather than by the graph.
//
// This is not belt-and-braces; it is load-bearing, because of a verified
// behaviour of the installed SDK:
//
//     @langchain/langgraph@1.4.8 does NOT run zod validation on graph input.
//
// Invoking the graph with `timeWindow` omitted does not throw — the node
// simply observes `undefined` while the compiler still believes the field is
// a `string`. The static type would be lying. So `api.ts` runs the initial
// state through `AgentStateSchema.parse()` BEFORE `graph.invoke()`, turning a
// malformed request into a loud 400 instead of a quiet `undefined` halfway
// down the graph.
//
// Why not just add `.default("1mo")` and be done with it? Because that
// converts "we failed to parse the user's requested window" into a confident
// report about a window nobody asked for. That is the same class of silent
// wrong answer §5.3 forbids when two data sources disagree. A default here
// would hide exactly the failure we most want to see.
// -----------------------------------------------------------------------------
