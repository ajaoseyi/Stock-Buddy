/**
 * =============================================================================
 * report-writer.ts — the ONLY node that generates prose.
 * =============================================================================
 *
 * SIX PROMPT PATHS, ONE NODE
 * ----------------------------
 * This node branches on `state.intent`/`activeCapabilities`:
 *
 *   - `sector_trend` (§5.5 below): a data-driven report built from
 *     `sectorRankings`/`sectorLeaders`, checked afterwards by `validator.ts`.
 *   - `single_report`: a data-driven report built from `growthAuthenticity`,
 *     same verification loop.
 *   - `portfolio_scan` (§12.5, §12.8): a data-driven report built from
 *     `portfolioGrowthResults` — one disaggregated verdict per ticker, same
 *     verification loop, NEVER a combined portfolio score. When 2+ tickers
 *     were compared, `tickerComparison`'s computed verdict MAY also be
 *     stated — the one narrow exception to that rule (§9.1).
 *   - `company_snapshot` (§13.8): a data-driven report built from
 *     `companySnapshots` — valuation/financial-health/general facts vs.
 *     sector peers, never blended into one score.
 *   - `technical_analysis` (§14.12): a data-driven report built from
 *     `technicalAnalysis` — a computed trend/momentum stance plus two
 *     independently-computed entry/stop-loss/take-profit level sets
 *     (ATR-based, swing-based), NEVER merged into one "the" stop-loss.
 *   - `followup`: no capability runs on this turn — `activeCapabilities`
 *     stays empty for `followup` (`supervisor.ts`) by design. Instead this
 *     branch re-narrates whichever capability's output is ALREADY in state
 *     from an earlier turn in the same thread, answering the new question
 *     against it rather than re-fetching anything. If neither
 *     `sectorRankings` nor `growthAuthenticity` exists yet, there is nothing
 *     to follow up on — an honest message, no LLM call.
 *   - `general_chat`: the user's prompt was not a finance question the graph
 *     can serve with a capability, so no capability ever ran. This branch
 *     still calls the LLM — it just has no computed data to narrate, and is
 *     told not to invent any.
 *
 * In every branch that DOES call the LLM, the model is handed the user's
 * literal question (`latestUserText(state.messages)`) alongside whatever DATA
 * block exists, and is told to answer that question directly rather than
 * recite a fixed template — the DATA block still bounds every number/ticker
 * it may cite, but the framing of the answer follows what was actually asked.
 *
 * All five stay inside this one file/node on purpose: CLAUDE.md's
 * repo-structure notes call out report-writer.ts as the only node that calls
 * the LLM for user-facing prose, and adding a second LLM-calling node would
 * fork that invariant for no architectural benefit — the existing plugin-seam
 * routing in `graph.ts` (`routeAfterSupervisor`) already lands anything
 * without an active capability here, so no graph changes were needed either.
 *
 * Any OTHER intent that reaches this node with no matching capability and no
 * prior data to follow up on falls through to an honest "not supported" stub
 * with no LLM call (see below) — a different situation from `general_chat`
 * genuinely not being a finance question.
 *
 * CLAUDE.md §5.5 defines what the sector_trend path must produce; §1 defines
 * what it must never do. Both are worth holding in mind together:
 *
 *   §5.5  Name the top trending-up and trending-down sectors with their actual
 *         % figures. For each, name the `anchor_leader` companies first (these
 *         are genuinely driving the move), then note any notable
 *         `emerging_mover` companies as an "early signal" callout. Never invent
 *         a company or number not present in the data.
 *
 *   §1    The LLM never computes a number.
 *
 * HOW THE SECOND RULE IS ACTUALLY ENFORCED
 * ----------------------------------------
 * Not by asking nicely. Three mechanisms, in order of reliability:
 *
 *   1. STRUCTURE — the model receives the computed figures as JSON and is
 *      given no tool with which to fetch or calculate anything else. There is
 *      no arithmetic it can do that will be believed.
 *   2. INSTRUCTION — the prompt states the constraint explicitly, including the
 *      non-obvious part: that deriving a NEW correct number (a sum, an average)
 *      is also forbidden, because a correct-looking figure absent from state is
 *      indistinguishable to a reader from a hallucinated one.
 *   3. VERIFICATION — `validator.ts` re-reads the output and checks every
 *      number and ticker back against state (§5.6). This is the mechanism that
 *      actually holds; 1 and 2 exist to make it rarely fire.
 *
 * §9 also forbids this node from calling an external API. It reads state and
 * calls the LLM; nothing else.
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { AIMessage, type BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type {
  AgentState,
  CompanySnapshotResult,
  GrowthAuthenticityResult,
  PeerRelativeMetric,
  SectorLeader,
  SectorRanking,
  TechnicalAnalysisResult,
  TickerComparisonResult,
} from "../state.js";
import { getLlm, isRateLimitError, type LlmProvider } from "../llm.js";
import { INDUSTRY_TREND_CAPABILITY_ID } from "./capabilities/industry-trend/index.js";
import { GROWTH_AUTHENTICITY_CAPABILITY_ID } from "./capabilities/growth-authenticity/index.js";
import { PORTFOLIO_SCAN_CAPABILITY_ID } from "./capabilities/portfolio-scan/index.js";
import { COMPANY_SNAPSHOT_CAPABILITY_ID } from "./capabilities/company-snapshot/index.js";
import { TECHNICAL_ANALYSIS_CAPABILITY_ID } from "./capabilities/technical-analysis/index.js";
import { latestUserText } from "./supervisor.js";
import { emitProgress } from "../streaming.js";
import { SECTOR_ETF_TO_GICS } from "../tools/yahoo-finance.js";

// =============================================================================
// SECTION 1 — Prompt construction
// =============================================================================

/**
 * The standing instruction. Deliberately blunt about the numeric constraint —
 * this is the prompt-side half of §1, and vagueness here costs retry budget
 * later.
 */
const SYSTEM_PROMPT = `You are a financial analyst writing a concise, factual market report.

ABSOLUTE CONSTRAINTS — these override every other instruction:
1. Use ONLY the companies and numbers present in the DATA block. Never introduce a ticker or figure that does not appear there.
2. Do NOT calculate anything. No sums, averages, differences, ratios, or totals — even if the arithmetic would be correct. A number you derived is indistinguishable from one you invented, to both the reader and the automated validator that checks this report.
3. Quote percentages as they are given, rounded to at most one decimal place.
4. If the DATA block is empty or a figure is missing, say so plainly. An acknowledged gap is acceptable; an invented figure is not.
5. Every classification/flag/stance in the DATA block is already given as a natural-language phrase. Never print a raw code-style identifier — words joined by underscores, e.g. "inorganic_ma_driven" or "mixed_signals" — write it out in plain English exactly as the DATA block already phrases it instead.
6. If any part of the user's question asks for something this system does not compute — most commonly a prediction/forecast of a FUTURE price or percentage move — do not silently answer only the part you can, and do NOT open the report with that limitation either. Lead with the actual answer to the answerable part of the question, and work the limitation in as a brief, plainly-worded aside — e.g. "...(this is based on current data; it isn't a forecast of where the price goes next)" — near where it's relevant, or in a short closing note. One sentence is enough; do not dwell on it.
7. If the question is phrased as a recommendation request ("should I buy/sell/hold X", "is X a good buy") — this system does not tell anyone what to do with their money. But that is not a reason to dodge into a generic restatement of the data instead of answering. Open with ONE short clause making the boundary clear ("I can't tell you whether to buy — but here's what the data shows:"), then immediately answer, in decision-relevant terms, the actual question underneath the question: is the move backed by real fundamentals or not, and what does the computed classification/stance/valuation say about that. Translate the computed label into what it MEANS for the thing they're actually weighing (e.g. classification "explained by macro or sector/commodity beta" -> "the drop doesn't reflect the business itself — revenue is still growing, this looks like broader market/sector pressure"), not just the label restated verbatim. The rest of the report's evidence is what backs that answer up, not a replacement for stating it.

STYLE:
- Open with a one-sentence summary of the period's sector picture.
- Be specific and brief. No hedging, no filler, no investment advice.
- Plain markdown: short paragraphs and bullet lists. No tables.`;

/**
 * The `general_chat` system prompt. Used when the user's message is not a
 * finance question this graph can serve with a capability, so there is no
 * DATA block to hand the model — §1 still applies, restated for a prompt
 * with nothing computed to narrate: don't fabricate the numbers §1 would
 * otherwise forbid deriving.
 */
const GENERAL_CHAT_SYSTEM_PROMPT = `You are the conversational side of a financial analysis agent. This message is not a sector or industry trend question, so no market data has been computed for it — just reply naturally and helpfully.

CONSTRAINTS:
1. Never state a specific stock price, percentage change, or other market figure as fact — you have not been given any real data here. If the user wants real numbers, say you can pull a sector/industry trend analysis (e.g. "which sectors are trending up this month, and who is leading them?") and that is backed by real data.
2. Be brief and direct. No filler, no investment advice.`;

/** Round for display so the model is not tempted to do it itself. */
function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

// =============================================================================
// SECTION 1a — Human-readable labels
// =============================================================================
//
// Every classification/flag/stance a capability node computes is a code-style,
// underscore-joined identifier (e.g. "inorganic_ma_driven") — the right shape
// for state, tests, and decision tables, the wrong shape to hand an LLM that is
// then told to "state the value plainly": without a translation step the model
// just echoes the identifier verbatim into the report (observed live: "AMD's
// move is classified as **inorganic_ma_driven**"). These maps are applied
// wherever a DATA block is built below, so the model only ever sees the
// natural-language phrase it should use — never the raw token.

/** Fallback for any identifier not covered by an explicit map below: "foo_bar" -> "foo bar". */
function snakeToWords(value: string): string {
  return value.replace(/_/g, " ");
}

const CLASSIFICATION_LABELS: Record<GrowthAuthenticityResult["classification"], string> = {
  organic_growth_supported: "organically driven, supported by revenue growth",
  inorganic_ma_driven: "inorganic, M&A-driven",
  macro_or_commodity_beta_driven: "explained by macro or sector/commodity beta",
  price_outpacing_fundamentals_unexplained: "price outpacing fundamentals, unexplained",
  mixed_signals: "showing mixed signals",
  insufficient_data: "not computable (insufficient data)",
};

const DISCREPANCY_FLAG_LABELS: Record<GrowthAuthenticityResult["discrepancy"]["discrepancyFlag"], string> = {
  price_outpacing_revenue: "price outpacing revenue growth",
  revenue_outpacing_price: "revenue growth outpacing price",
  aligned: "aligned with revenue growth",
  insufficient_history: "not computable (insufficient own-history baseline)",
  not_computable: "not computable",
};

const INORGANIC_SIGNAL_LABELS: Record<GrowthAuthenticityResult["inorganic"]["inorganicSignal"], string> = {
  likely_ma_driven: "a likely M&A-driven signal",
  no_signal: "no inorganic-growth signal",
  insufficient_data: "not computable (insufficient data)",
};

const MACRO_BETA_LABELS: Record<GrowthAuthenticityResult["sectorBenchmark"]["macroBetaFlag"], string> = {
  beta_explained: "explained by sector/commodity beta",
  stock_specific_move: "a stock-specific move, not explained by sector beta",
  not_computable: "not computable",
};

const TREND_DIRECTION_LABELS: Record<
  GrowthAuthenticityResult["inorganic"]["goodwillTrend"]["direction"],
  string
> = {
  increasing: "increasing",
  decreasing: "decreasing",
  flat: "flat",
  insufficient_data: "not computable (insufficient data)",
};

const REVENUE_GROWTH_BASIS_LABELS: Record<GrowthAuthenticityResult["revenueGrowth"]["basis"], string> = {
  yoy_quarterly: "year-over-year, quarterly",
  insufficient_data: "not computable (insufficient data)",
};

const QUADRANT_LABELS: Record<SectorLeader["quadrant"], string> = {
  anchor_leader: "an anchor leader (large weight, high speed)",
  emerging_mover: "an emerging mover (small weight, high speed)",
  stable_heavyweight: "a stable heavyweight (large weight, low speed)",
  laggard: "a laggard (small weight, low speed)",
};

const PEER_FLAG_LABELS: Record<PeerRelativeMetric["flag"], string> = {
  favorable_vs_peers: "favorable vs. peers",
  unfavorable_vs_peers: "unfavorable vs. peers",
  in_line_with_peers: "in line with peers",
  not_computable: "not computable",
};

const STANCE_LABELS: Record<TechnicalAnalysisResult["stance"], string> = {
  bullish_setup: "a bullish setup",
  bearish_setup: "a bearish setup",
  neutral_no_setup: "neutral, with no clear setup",
  insufficient_data: "not computable (insufficient data)",
};

const TA_TREND_DIRECTION_LABELS: Record<TechnicalAnalysisResult["trendDirection"], string> = {
  uptrend: "an uptrend",
  downtrend: "a downtrend",
  sideways: "sideways / range-bound",
  insufficient_data: "not computable (insufficient data)",
};

const MOMENTUM_DIRECTION_LABELS: Record<TechnicalAnalysisResult["momentumDirection"], string> = {
  overbought: "overbought",
  oversold: "oversold",
  neutral: "neutral",
  insufficient_data: "not computable (insufficient data)",
};

const VOLATILITY_LEVEL_LABELS: Record<TechnicalAnalysisResult["volatilityLevel"], string> = {
  high: "high",
  normal: "normal",
  low: "low",
  insufficient_data: "not computable (insufficient data)",
};

const COMPARISON_VERDICT_LABELS: Record<TickerComparisonResult["overallVerdict"]["verdict"], string> = {
  clear_lead: "a clear lead",
  narrow_lead: "a narrow lead",
  no_clear_leader: "no clear leader",
  insufficient_comparable_data: "insufficient comparable data",
};

/** Comparison/peer-relative metric identifiers (§12.8, §13.5, §13.6) -> a natural label. */
const METRIC_LABELS: Record<string, string> = {
  revenue_growth_pct: "revenue growth (%)",
  trailing_pe: "trailing P/E",
  forward_pe: "forward P/E",
  price_to_book: "price-to-book",
  ev_to_ebitda: "EV/EBITDA",
  debt_to_equity: "debt-to-equity",
  current_ratio: "current ratio",
  return_on_equity: "return on equity",
  return_on_assets: "return on assets",
  profit_margin: "profit margin",
  fcf_margin: "free-cash-flow margin",
};

/** "trailing_pe" -> "trailing P/E", falling back to word-splitting for anything unlisted. */
function metricLabel(metric: string): string {
  return METRIC_LABELS[metric] ?? snakeToWords(metric);
}

/**
 * `classificationReasonCodes`/`stanceReasonCodes` are machine-readable
 * citations shaped like `"discrepancy:price_outpacing_revenue"` — a second
 * place raw identifiers would otherwise leak into the DATA block. Translated
 * into a short natural-language phrase using the same maps above, per prefix.
 */
function humanizeReasonCode(code: string): string {
  const parts = code.split(":");
  const prefix = parts[0] ?? "";
  const value = parts[1];
  if (value === undefined) return snakeToWords(code);

  switch (prefix) {
    case "discrepancy":
      return `price-vs-revenue: ${DISCREPANCY_FLAG_LABELS[value as GrowthAuthenticityResult["discrepancy"]["discrepancyFlag"]] ?? snakeToWords(value)}`;
    case "inorganic_signal":
      return `M&A signal: ${INORGANIC_SIGNAL_LABELS[value as GrowthAuthenticityResult["inorganic"]["inorganicSignal"]] ?? snakeToWords(value)}`;
    case "macro_beta":
      return `sector benchmark: ${MACRO_BETA_LABELS[value as GrowthAuthenticityResult["sectorBenchmark"]["macroBetaFlag"]] ?? snakeToWords(value)}`;
    case "trend":
      return `trend: ${TA_TREND_DIRECTION_LABELS[value as TechnicalAnalysisResult["trendDirection"]] ?? snakeToWords(value)}`;
    case "momentum":
      return `momentum: ${MOMENTUM_DIRECTION_LABELS[value as TechnicalAnalysisResult["momentumDirection"]] ?? snakeToWords(value)}`;
    default:
      return `${snakeToWords(prefix)}: ${snakeToWords(value)}`;
  }
}

/**
 * Filter degradation notes (`trendDataErrors`) down to the ones relevant to a
 * scoped question, the same way `buildDataBlock` filters the figures
 * themselves.
 *
 * Free-text notes have no structured "which sector does this concern" field,
 * so relevance is inferred: a note is EXCLUDED only if it names a GICS sector
 * OTHER than one of the requested ones (e.g. a "Real Estate cross-check
 * unavailable" note has no bearing on a question scoped to Information
 * Technology). A note naming no sector at all (a budget-wide note) is kept,
 * since it isn't demonstrably about an unrelated sector. `requestedSectors`
 * empty means unscoped — every note is kept, unchanged from before this
 * filter existed.
 */
function filterCaveatsForScope(errors: string[], requestedSectors: string[]): string[] {
  if (requestedSectors.length === 0) return errors;

  const requested = new Set(requestedSectors);
  const otherSectors = Object.values(SECTOR_ETF_TO_GICS).filter((s) => !requested.has(s));

  return errors.filter((note) => !otherSectors.some((sector) => note.includes(sector)));
}

/**
 * Build the DATA block: the computed figures, as compact JSON.
 *
 * Two shaping decisions matter here:
 *
 * - Leaders are TRIMMED to the few names per sector the report will actually
 *   discuss. A 70-constituent list would bury the `anchor_leader` names §5.5
 *   asks to be foregrounded, and every extra row is another number the model
 *   might quote and the validator must then check.
 *
 * - `weightScore` and `speedScore` are presented as SEPARATE labelled fields,
 *   never merged (§5.4, §9). The prompt explains what each means so the model
 *   narrates the combination correctly without being handed a blended figure.
 *
 * - When `requestedSectors` is non-empty (the user named a sector), the block
 *   is FILTERED down to just those sector(s) — a presentation choice, not a
 *   computation: every figure still traces back unchanged to `sectorRankings`
 *   /`sectorLeaders`, only the subset handed to the model narrows. An empty
 *   `requestedSectors` (a general "what's trending" question) keeps today's
 *   full behaviour.
 */
export function buildDataBlock(
  sectorRankings: SectorRanking[] | null,
  sectorLeaders: Record<string, SectorLeader[]> | null,
  timeWindow: string,
  requestedSectors: string[] = [],
): string {
  const requested = new Set(requestedSectors);
  const scoped = requested.size > 0;

  const rankings = (sectorRankings ?? [])
    .filter((r) => !scoped || requested.has(r.sector))
    .map((r) => ({
      sector: r.sector,
      pctChange: round(r.pctChange),
      source: r.source,
    }));

  const leaders: Record<string, unknown[]> = {};
  for (const [sector, list] of Object.entries(sectorLeaders ?? {})) {
    if (scoped && !requested.has(sector)) continue;
    // Anchor leaders and emerging movers first — §5.5's required narrative
    // order — then the highest-speed remainder for context.
    const prioritised = [
      ...list.filter((l) => l.quadrant === "anchor_leader"),
      ...list.filter((l) => l.quadrant === "emerging_mover"),
      ...list.filter((l) => l.quadrant === "stable_heavyweight"),
    ].slice(0, 6);

    leaders[sector] = prioritised.map((l) => ({
      ticker: l.ticker,
      weightPctOfSector: round(l.weightScore),
      speedZScore: round(l.speedScore),
      relativeVolume: round(l.relativeVolume),
      quadrant: QUADRANT_LABELS[l.quadrant],
    }));
  }

  return JSON.stringify({ timeWindow, sectorRankings: rankings, sectorLeaders: leaders }, null, 2);
}

/**
 * The per-ticker fields of a growth-authenticity DATA block, exactly as
 * computed and labelled — shared by `buildGrowthDataBlock` (one ticker) and
 * `buildPortfolioScanDataBlock` (§12, many tickers) so the two capabilities
 * can never drift into presenting the same figures differently.
 */
function buildGrowthEntry(g: GrowthAuthenticityResult): Record<string, unknown> {
  return {
    ticker: g.ticker,
    classification: CLASSIFICATION_LABELS[g.classification],
    classificationReasonCodes: g.classificationReasonCodes.map(humanizeReasonCode),
    revenueGrowth: {
      latestQuarterEnd: g.revenueGrowth.latestQuarterEnd,
      revenueGrowthPct:
        g.revenueGrowth.revenueGrowthPct === null ? null : round(g.revenueGrowth.revenueGrowthPct),
      basis: REVENUE_GROWTH_BASIS_LABELS[g.revenueGrowth.basis],
    },
    priceVsRevenue: {
      priceChangePct:
        g.discrepancy.priceChangePct === null ? null : round(g.discrepancy.priceChangePct),
      priceToRevenueGrowthRatio:
        g.discrepancy.priceToRevenueGrowthRatio === null
          ? null
          : round(g.discrepancy.priceToRevenueGrowthRatio),
      discrepancyFlag: DISCREPANCY_FLAG_LABELS[g.discrepancy.discrepancyFlag],
    },
    inorganicGrowthCheck: {
      goodwillChangePct:
        g.inorganic.goodwillTrend.deltaPct === null ? null : round(g.inorganic.goodwillTrend.deltaPct),
      ppeChangePct:
        g.inorganic.ppeTrend.deltaPct === null ? null : round(g.inorganic.ppeTrend.deltaPct),
      cashDirection: TREND_DIRECTION_LABELS[g.inorganic.cashTrend.direction],
      inorganicSignal: INORGANIC_SIGNAL_LABELS[g.inorganic.inorganicSignal],
    },
    sectorBenchmark: {
      sector: g.sectorBenchmark.sector,
      sectorBenchmarkPct:
        g.sectorBenchmark.sectorBenchmarkPct === null
          ? null
          : round(g.sectorBenchmark.sectorBenchmarkPct),
      stockVsSectorSpreadPct:
        g.sectorBenchmark.stockVsSectorSpreadPct === null
          ? null
          : round(g.sectorBenchmark.stockVsSectorSpreadPct),
      macroBetaFlag: MACRO_BETA_LABELS[g.sectorBenchmark.macroBetaFlag],
    },
  };
}

/**
 * Build the growth-authenticity DATA block.
 *
 * Every disaggregated field is presented, labelled, exactly as computed — the
 * point of this capability is that the model narrates the classification, it
 * never derives one, so nothing here is pre-summarised into a single score.
 */
export function buildGrowthDataBlock(
  growthAuthenticity: GrowthAuthenticityResult | null,
  timeWindow: string,
): string {
  if (growthAuthenticity === null) {
    return JSON.stringify({ timeWindow, growthAuthenticity: null }, null, 2);
  }

  return JSON.stringify({ timeWindow, ...buildGrowthEntry(growthAuthenticity) }, null, 2);
}

/**
 * Build the portfolio-scan DATA block (§12.4/§12.5): one entry per analysed
 * ticker, each exactly as disaggregated as a standalone growth-authenticity
 * result. Never pre-summarised into a portfolio-level figure — the report
 * writer narrates per ticker, it does not compute a combined score.
 *
 * `tickerComparison` (§12.8) is appended verbatim when 2+ tickers were
 * compared — the ONE place §9.1's narrow blending carve-out applies. Every
 * underlying metric value stays disaggregated in `metricRanks` alongside the
 * computed `overallVerdict`, so the model can state the verdict without ever
 * needing to (or being tempted to) recompute one of its own.
 */
export function buildPortfolioScanDataBlock(
  portfolioGrowthResults: GrowthAuthenticityResult[] | null,
  tickerComparison: TickerComparisonResult | null,
  timeWindow: string,
): string {
  const results = (portfolioGrowthResults ?? []).map((g) => buildGrowthEntry(g));

  const comparison =
    tickerComparison === null
      ? null
      : {
          tickers: tickerComparison.tickers,
          metricRanks: tickerComparison.metricRanks.map((r) => ({
            metric: metricLabel(r.metric),
            higherIsBetter: r.higherIsBetter,
            values: r.values.map((v) => ({
              ticker: v.ticker,
              value: v.value === null ? null : round(v.value),
            })),
            winner: r.winner,
          })),
          overallVerdict: {
            ...tickerComparison.overallVerdict,
            verdict: COMPARISON_VERDICT_LABELS[tickerComparison.overallVerdict.verdict],
          },
        };

  return JSON.stringify({ timeWindow, results, tickerComparison: comparison }, null, 2);
}

/** Round a peer-relative metric's numeric fields for display (§13). */
function roundMetric(m: PeerRelativeMetric): Record<string, unknown> {
  return {
    metric: metricLabel(m.metric),
    value: m.value === null ? null : round(m.value),
    peerMedian: m.peerMedian === null ? null : round(m.peerMedian),
    zScore: m.zScore === null ? null : round(m.zScore),
    higherIsBetter: m.higherIsBetter,
    flag: PEER_FLAG_LABELS[m.flag],
  };
}

/**
 * The per-ticker fields of a company-snapshot DATA block entry, exactly as
 * computed and labelled (§13.3/§13.5/§13.6) — never pre-blended into a
 * "valuation score"/"health score".
 */
function buildCompanySnapshotEntry(s: CompanySnapshotResult): Record<string, unknown> {
  return {
    ticker: s.ticker,
    profile:
      s.profile === null
        ? null
        : {
            sector: s.profile.sector,
            industry: s.profile.industry,
            marketCap: s.profile.marketCap,
            fullTimeEmployees: s.profile.fullTimeEmployees,
            beta: s.profile.beta === null ? null : round(s.profile.beta),
            dividendYieldPct:
              s.profile.dividendYieldPct === null ? null : round(s.profile.dividendYieldPct),
            fiftyTwoWeekLow: s.profile.fiftyTwoWeekLow,
            fiftyTwoWeekHigh: s.profile.fiftyTwoWeekHigh,
            trailingEps: s.profile.trailingEps === null ? null : round(s.profile.trailingEps),
            forwardEps: s.profile.forwardEps === null ? null : round(s.profile.forwardEps),
            analystTargetMeanPrice: s.profile.analystTargetMeanPrice,
            analystRecommendationKey: s.profile.analystRecommendationKey,
            // Yahoo's OWN trailing figure — deliberately distinct from
            // growth-authenticity's `revenueGrowth.revenueGrowthPct` (§13.3).
            reportedRevenueGrowthPct:
              s.profile.reportedRevenueGrowthPct === null ? null : round(s.profile.reportedRevenueGrowthPct),
          },
    valuationVsPeers:
      s.valuation === null
        ? null
        : { sector: s.valuation.sector, peerCount: s.valuation.peerCount, metrics: s.valuation.metrics.map(roundMetric) },
    financialHealthVsPeers:
      s.financialHealth === null
        ? null
        : {
            sector: s.financialHealth.sector,
            peerCount: s.financialHealth.peerCount,
            metrics: s.financialHealth.metrics.map(roundMetric),
          },
  };
}

/** Build the company-snapshot DATA block (§13): one entry per analysed ticker. */
export function buildCompanySnapshotDataBlock(
  companySnapshots: CompanySnapshotResult[] | null,
  timeWindow: string,
): string {
  const results = (companySnapshots ?? []).map((s) => buildCompanySnapshotEntry(s));
  return JSON.stringify({ timeWindow, results }, null, 2);
}

/** Round a nullable number for display, or pass `null` through unchanged. */
function roundNullable(value: number | null): number | null {
  return value === null ? null : round(value);
}

/**
 * The per-symbol fields of a technical-analysis DATA block entry (§14).
 *
 * `atrBasedLevels` and `swingBasedLevels` are kept as TWO SEPARATE top-level
 * keys, never merged into one `levels` object — the prompt (below) also
 * instructs the model to present them as two distinct sections, and the
 * validator (§14.13) mechanically checks both actually appear labelled.
 */
function buildTechnicalAnalysisEntry(t: TechnicalAnalysisResult): Record<string, unknown> {
  const ind = t.indicators;
  return {
    symbol: t.symbol,
    requestedAs: t.requestedAs === "sector_etf" ? "sector ETF" : t.requestedAs,
    sectorName: t.sectorName,
    stance: STANCE_LABELS[t.stance],
    stanceReasonCodes: t.stanceReasonCodes.map(humanizeReasonCode),
    trendDirection: TA_TREND_DIRECTION_LABELS[t.trendDirection],
    momentumDirection: MOMENTUM_DIRECTION_LABELS[t.momentumDirection],
    volatilityLevel: VOLATILITY_LEVEL_LABELS[t.volatilityLevel],
    indicators: {
      sma20: roundNullable(ind.sma20),
      sma50: roundNullable(ind.sma50),
      sma200: roundNullable(ind.sma200),
      ema12: roundNullable(ind.ema12),
      ema26: roundNullable(ind.ema26),
      rsi14: roundNullable(ind.rsi14),
      macdLine: roundNullable(ind.macd.macdLine),
      macdSignalLine: roundNullable(ind.macd.signalLine),
      macdHistogram: roundNullable(ind.macd.histogram),
      atr14: roundNullable(ind.atr14),
      bollingerUpper: roundNullable(ind.bollinger.upper),
      bollingerMiddle: roundNullable(ind.bollinger.middle),
      bollingerLower: roundNullable(ind.bollinger.lower),
      latestClose: roundNullable(ind.latestClose),
      asOfDate: ind.asOfDate,
    },
    supportLevels: t.supportLevels.map((l) => ({ price: round(l.price), touches: l.touches })),
    resistanceLevels: t.resistanceLevels.map((l) => ({ price: round(l.price), touches: l.touches })),
    atrBasedLevels: {
      entry: roundNullable(t.atrLevels.entry),
      stopLoss: roundNullable(t.atrLevels.stopLoss),
      takeProfit: roundNullable(t.atrLevels.takeProfit),
      basisNote: t.atrLevels.basisNote,
    },
    swingBasedLevels: {
      entry: roundNullable(t.swingLevels.entry),
      stopLoss: roundNullable(t.swingLevels.stopLoss),
      takeProfit: roundNullable(t.swingLevels.takeProfit),
      basisNote: t.swingLevels.basisNote,
    },
  };
}

/** Build the technical-analysis DATA block (§14): one entry per analysed symbol. */
export function buildTechnicalAnalysisDataBlock(
  technicalAnalysis: TechnicalAnalysisResult[] | null,
  timeWindow: string,
): string {
  const results = (technicalAnalysis ?? []).map((t) => buildTechnicalAnalysisEntry(t));
  return JSON.stringify({ timeWindow, results }, null, 2);
}

/**
 * The task instruction for the growth-authenticity capability.
 *
 * The one instruction that matters most is the last CONSTRAINT below:
 * `classification` was computed by deterministic code (growth-classification.ts),
 * not by the model, and the model's job is to explain it using the given
 * numbers — never to independently judge organic-vs-inorganic or propose a
 * different explanation. `validator.ts` enforces this after the fact by
 * checking the draft actually states the computed classification.
 */
function buildGrowthTaskPrompt(state: AgentState, dataBlock: string): string {
  const userQuestion = latestUserText(state.messages);

  const caveats =
    state.growthCheckErrors.length > 0
      ? `\n\nDATA CAVEATS — mention these briefly at the end, in one short "Data notes" ` +
        `section, only where they affect a claim you made:\n` +
        state.growthCheckErrors.map((e) => `- ${e}`).join("\n")
      : "";

  const corrections =
    state.validationNotes.length > 0
      ? `\n\n⚠️ YOUR PREVIOUS DRAFT WAS REJECTED. Fix these specific problems:\n` +
        state.validationNotes.map((n) => `- ${n}`).join("\n") +
        `\nRewrite the report from scratch, keeping strictly to the DATA block.`
      : "";

  return `THE USER ASKED: "${userQuestion}"

Answer that question directly, over the period "${state.timeWindow}". Use the required structure below to organise the answer, but lead with whatever the question is actually asking about rather than reciting the structure regardless of phrasing.

WHAT THE FIELDS MEAN:
- classification: the computed answer to "why did this stock move", already given in the DATA block in plain English (e.g. "organically driven", "inorganic, M&A-driven", "explained by macro or sector/commodity beta", "price outpacing fundamentals, unexplained", "showing mixed signals", or "not computable").
- revenueGrowth.revenueGrowthPct: year-over-year quarterly revenue growth.
- priceVsRevenue: how the stock's price move compares to its revenue growth, and whether that gap is unusual for THIS company's own history.
- inorganicGrowthCheck: goodwill/PP&E/cash balance-sheet evidence of M&A activity. Goodwill is the primary signal; PP&E only counts alongside a cash decrease.
- sectorBenchmark: whether the move is explained by the stock's own sector/commodity beta rather than being company-specific.

CONSTRAINTS SPECIFIC TO THIS REPORT:
- State the "classification" value plainly, using the exact natural-language wording already given in the DATA block — never the underlying code-style identifier — and explain it using ONLY the numbers given above (price change, revenue growth, goodwill/PP&E/cash trend, sector benchmark spread).
- Do NOT independently judge whether the move is organic or not, and do NOT propose a different explanation than "classification" — it was computed by deterministic code, not by you.
- Do NOT calculate anything new — no new ratios, no new differences. Quote only the numbers in the DATA block.

REQUIRED STRUCTURE:
1. One-sentence verdict stating the classification in plain language, translated into what it means for the specific thing the user asked about (see constraint 7 in the system prompt if the question was phrased as a recommendation request) — not just the label restated.
2. The evidence backing that verdict: revenue growth vs. price change, then the M&A check, then the sector-benchmark check — whichever are most relevant to the classification.
3. "Data notes" — only if caveats are supplied below.

DATA:
${dataBlock}${caveats}${corrections}`;
}

/**
 * The task instruction for the portfolio-scan capability (§12.5).
 *
 * Same non-negotiable rule as `buildGrowthTaskPrompt`, restated per ticker:
 * each `classification` was computed by deterministic code, never by the
 * model. The one instruction unique to this prompt is the anti-blending
 * constraint — §12.1/§12.5 explicitly forbid a combined portfolio score,
 * extending §5.4/§9's rule to the multi-ticker case.
 */
function buildPortfolioScanTaskPrompt(state: AgentState, dataBlock: string): string {
  const userQuestion = latestUserText(state.messages);

  const caveats =
    state.portfolioScanErrors.length > 0
      ? `\n\nDATA CAVEATS — mention these briefly at the end, in one short "Data notes" ` +
        `section, only where they affect a claim you made:\n` +
        state.portfolioScanErrors.map((e) => `- ${e}`).join("\n")
      : "";

  const corrections =
    state.validationNotes.length > 0
      ? `\n\n⚠️ YOUR PREVIOUS DRAFT WAS REJECTED. Fix these specific problems:\n` +
        state.validationNotes.map((n) => `- ${n}`).join("\n") +
        `\nRewrite the report from scratch, keeping strictly to the DATA block.`
      : "";

  return `THE USER ASKED: "${userQuestion}"

Answer that question directly, over the period "${state.timeWindow}". The DATA block below has one entry per ticker the user named — use the required structure to organise the answer, but lead with whatever the question is actually asking about.

WHAT THE FIELDS MEAN (same meaning for every ticker's entry):
- classification: the computed answer to "why did this stock move", already given in the DATA block in plain English (e.g. "organically driven", "inorganic, M&A-driven", "explained by macro or sector/commodity beta", "price outpacing fundamentals, unexplained", "showing mixed signals", or "not computable").
- revenueGrowth.revenueGrowthPct: year-over-year quarterly revenue growth.
- priceVsRevenue: how the stock's price move compares to its revenue growth, and whether that gap is unusual for THIS company's own history.
- inorganicGrowthCheck: goodwill/PP&E/cash balance-sheet evidence of M&A activity. Goodwill is the primary signal; PP&E only counts alongside a cash decrease.
- sectorBenchmark: whether the move is explained by the stock's own sector/commodity beta rather than being company-specific.

CONSTRAINTS SPECIFIC TO THIS REPORT:
- State EACH ticker's "classification" plainly, using the exact natural-language wording already given in the DATA block — never the underlying code-style identifier — and explain it using ONLY that ticker's own numbers in the DATA block. Never cite one ticker's figures as evidence for another.
- Do NOT independently judge whether any ticker's move is organic or not, and do NOT propose a different explanation than its "classification" — it was computed by deterministic code, not by you.
- ABSOLUTE: never compute, state, or imply a combined "portfolio score" or an arithmetic average across tickers. Each ticker's classification is a fully separate, disaggregated verdict — that separation is the point of this report, not an incidental detail.
- IF "tickerComparison" is non-null (present only when 2+ tickers were compared): you MAY state its computed "overallVerdict.verdict" (already given in plain English, e.g. "a clear lead", "a narrow lead", "no clear leader", or "insufficient comparable data") and "overallVerdict.strongerTicker" plainly, and may reference "metricRanks"' per-metric winners — this is a deterministic rank-count comparison, not a blended score, and stating it is expected. Frame "a narrow lead" as e.g. "X edges out Y on more metrics" rather than "X is clearly stronger than Y". If the verdict is "insufficient comparable data" or "no clear leader", say so plainly rather than picking a side. NEVER invent your own ranking beyond what "tickerComparison" states, and never combine its metric values into a new number of your own.
- Do NOT calculate anything new — no new ratios, no new differences. Quote only the numbers in the DATA block.

REQUIRED STRUCTURE:
1. One-sentence summary naming how many tickers were checked.
2. One short subsection per ticker: its verdict (classification, in plain language) and the evidence behind it (revenue growth vs. price change, then the M&A check, then the sector-benchmark check — whichever are most relevant). Tickers sharing a classification may be grouped together for readability, but each ticker's own numbers must still be stated individually.
3. If "tickerComparison" is non-null: a short "Comparison" subsection stating its computed verdict and which metrics drove it.
4. "Data notes" — only if caveats are supplied below.

DATA:
${dataBlock}${caveats}${corrections}`;
}

/**
 * The task instruction for the company-snapshot capability (§13.8).
 *
 * Unlike growth-authenticity, there is no single computed "classification" to
 * state — this capability hands over a broad set of facts/metrics and the
 * model answers whatever the user actually asked, using the discount/premium
 * (not good/bad) framing §13.5 requires for valuation specifically.
 */
function buildCompanySnapshotTaskPrompt(state: AgentState, dataBlock: string): string {
  const userQuestion = latestUserText(state.messages);

  const caveats =
    state.companySnapshotErrors.length > 0
      ? `\n\nDATA CAVEATS — mention these briefly at the end, in one short "Data notes" ` +
        `section, only where they affect a claim you made:\n` +
        state.companySnapshotErrors.map((e) => `- ${e}`).join("\n")
      : "";

  const corrections =
    state.validationNotes.length > 0
      ? `\n\n⚠️ YOUR PREVIOUS DRAFT WAS REJECTED. Fix these specific problems:\n` +
        state.validationNotes.map((n) => `- ${n}`).join("\n") +
        `\nRewrite the report from scratch, keeping strictly to the DATA block.`
      : "";

  return `THE USER ASKED: "${userQuestion}"

Answer that question directly, using the DATA block below (one entry per ticker named). Lead with whatever the question actually asked about — valuation, financial health, or general facts — rather than reciting every section regardless of what was asked.

WHAT THE FIELDS MEAN:
- profile: general company facts (sector, market cap, employees, beta, dividend yield, 52-week range, EPS, analyst target price/recommendation). "reportedRevenueGrowthPct" is Yahoo's OWN trailing revenue-growth figure — if this conversation is ALSO discussing a "revenueGrowth.revenueGrowthPct" figure from a growth-authenticity check on the same ticker, the two are computed differently and CAN legitimately differ; name them distinctly, never as if they were the same number.
- valuationVsPeers.metrics: trailing/forward P/E, price-to-book, EV/EBITDA, each compared to a sample of the company's sector peers. A "flag" of "favorable vs. peers" here means CHEAPER than peers (a discount) — use a discount/premium-to-peers framing, never "good"/"bad" outright, since a cheap valuation is not unconditionally a good thing.
- financialHealthVsPeers.metrics: debt/equity, current ratio, return on equity/assets, profit margin, free-cash-flow margin, each compared to the same peer sample. Here "favorable vs. peers" does mean healthier (less leverage, better returns/margins).

CONSTRAINTS SPECIFIC TO THIS REPORT:
- Never combine the valuation or financial-health metrics into one overall "score" — state each metric's own value and flag individually.
- Use the discount/premium framing for valuation metrics specifically (see above) — do not editorialise a cheap valuation as simply "good", or an expensive one as simply "bad".
- Do NOT calculate anything new — no new ratios, no new differences. Quote only the numbers in the DATA block.

REQUIRED STRUCTURE:
1. One-sentence summary naming the ticker(s) covered.
2. Whatever the user actually asked about (valuation / financial health / general facts), using the relevant metrics above.
3. "Data notes" — only if caveats are supplied below.

DATA:
${dataBlock}${caveats}${corrections}`;
}

/**
 * The task instruction for the technical-analysis capability (§14.12).
 *
 * The two instructions that matter most: (1) never merge the ATR-based and
 * swing-based levels into one statement — they are two independently
 * computed answers, kept disaggregated all the way through, mirroring
 * §5.4/§9's weight/speed discipline; (2) prefix every price level with "$" so
 * the validator's dedicated dollar-figure check (§14.13) can mechanically
 * verify it — no other capability's numeric output needs this, because no
 * other capability states a literal price a user could act on.
 */
function buildTechnicalAnalysisTaskPrompt(state: AgentState, dataBlock: string): string {
  const userQuestion = latestUserText(state.messages);

  const caveats =
    state.technicalAnalysisErrors.length > 0
      ? `\n\nDATA CAVEATS — mention these briefly at the end, in one short "Data notes" ` +
        `section, only where they affect a claim you made:\n` +
        state.technicalAnalysisErrors.map((e) => `- ${e}`).join("\n")
      : "";

  const corrections =
    state.validationNotes.length > 0
      ? `\n\n⚠️ YOUR PREVIOUS DRAFT WAS REJECTED. Fix these specific problems:\n` +
        state.validationNotes.map((n) => `- ${n}`).join("\n") +
        `\nRewrite the report from scratch, keeping strictly to the DATA block.`
      : "";

  return `THE USER ASKED: "${userQuestion}"

Answer that question directly. The DATA block below has one entry per ticker or sector ETF analysed — use the required structure to organise the answer.

WHAT THE FIELDS MEAN:
- stance: the computed trading stance, already given in the DATA block in plain English (e.g. "a bullish setup", "a bearish setup", "neutral, with no clear setup", or "not computable"). Computed from trendDirection and momentumDirection ONLY (volatilityLevel is context, not an input).
- trendDirection / momentumDirection: an uptrend/downtrend/sideways reading from moving averages, and overbought/oversold/neutral from RSI(14) — both already phrased in plain English in the DATA block.
- volatilityLevel: how today's ATR compares to this symbol's own recent history. Context only.
- supportLevels / resistanceLevels: nearest-first detected price levels from swing-point clustering, with a "touches" count (how many swing points formed that level).
- atrBasedLevels: entry/stop-loss/take-profit computed as a volatility-adjusted (ATR) formula off the nearest support/resistance level.
- swingBasedLevels: entry/stop-loss/take-profit computed from raw price structure alone — the stop is just beyond the nearest swing point, the target is the next detected level. "takeProfit" being null here is a REAL finding (no further level was detected), not a missing data point.

CONSTRAINTS SPECIFIC TO THIS REPORT:
- State the "stance" plainly, using the exact natural-language wording already given in the DATA block — never the underlying code-style identifier — and explain it using ONLY trendDirection/momentumDirection. Do NOT independently judge the setup or propose a different stance than the one given — it was computed by deterministic code, not you.
- ALWAYS present "atrBasedLevels" and "swingBasedLevels" as TWO SEPARATE, clearly labelled sections (e.g. "ATR-based levels" / "Swing-based levels") — even when the two happen to roughly agree. Never merge them into a single "the stop-loss is X" statement.
- Prefix every specific price level you state — entry, stop-loss, take-profit, support, resistance — with a "$" sign and the exact number from the DATA block (e.g. "$142.50"). Do not round it any differently than the DATA block already has.
- If a level is null, say plainly it isn't computable and why (use its "basisNote") — never invent one.
- Do NOT calculate anything new — no new ratios, no reward:risk math of your own, no averaging the two methodologies together. Quote only the numbers in the DATA block.
- This is a description of a computed technical setup, not investment advice — no urgency ("act now") or certainty ("guaranteed") beyond what the data supports.

REQUIRED STRUCTURE:
1. One-sentence summary naming the symbol(s) covered and each one's computed stance.
2. Per symbol: brief trend/momentum context, then "ATR-based levels" and "Swing-based levels" as two distinct subsections stating entry/stop-loss/take-profit with the required "$" prefix (or plainly stating why a level is unavailable).
3. "Data notes" — only if caveats are supplied below.

DATA:
${dataBlock}${caveats}${corrections}`;
}

/** The task instruction for this capability (§5.5). */
function buildTaskPrompt(state: AgentState, dataBlock: string): string {
  const userQuestion = latestUserText(state.messages);

  // Scoped to the requested sector(s), same as the DATA block itself — a
  // "Real Estate cross-check unavailable" note has no place in the caveats
  // of a report scoped to Information Technology (see filterCaveatsForScope).
  const scopedTrendDataErrors = filterCaveatsForScope(state.trendDataErrors, state.sectors);

  const caveats =
    scopedTrendDataErrors.length > 0
      ? `\n\nDATA CAVEATS — mention these briefly at the end, in one short "Data notes" ` +
        `section, only where they affect a claim you made:\n` +
        scopedTrendDataErrors.map((e) => `- ${e}`).join("\n")
      : "";

  // On a retry, the validator's complaints are prepended so the model corrects
  // rather than re-rolls. This is what makes the loop a CORRECTION loop.
  const corrections =
    state.validationNotes.length > 0
      ? `\n\n⚠️ YOUR PREVIOUS DRAFT WAS REJECTED. Fix these specific problems:\n` +
        state.validationNotes.map((n) => `- ${n}`).join("\n") +
        `\nRewrite the report from scratch, keeping strictly to the DATA block.`
      : "";

  // A sector named in the question scopes the DATA block (buildDataBlock)
  // down to just that sector already — mirror that here in the structure, so
  // the model isn't told "use only the requested sector's data" while also
  // being told to fill a "Trending up" AND "Trending down" section that
  // requires sectors no longer in the DATA block at all.
  const scoped = state.sectors.length > 0;

  const requiredStructure = scoped
    ? `REQUIRED STRUCTURE:
1. One-sentence direct answer to the question asked.
2. The requested sector's performance for the period (its exact pctChange figure). Name its anchor-leader companies FIRST and say why they matter (size plus speed). Then, if any exist, flag emerging-mover companies as an "early signal" — a smaller name moving before the index reflects it.
3. "Data notes" — only if caveats are supplied below.`
    : `REQUIRED STRUCTURE:
1. One-sentence summary of the period.
2. "Trending up" — name the top rising sectors with their exact pctChange figures. For each, name its anchor-leader companies FIRST and say why they matter (size plus speed). Then, if any exist, flag emerging-mover companies as an "early signal" — a smaller name moving before the index reflects it.
3. "Trending down" — the same treatment for the falling sectors.
4. "Data notes" — only if caveats are supplied below.`;

  return `THE USER ASKED: "${userQuestion}"

Answer that question directly, for the period "${state.timeWindow}". Use the required structure below to organise the answer, but lead with whatever the question is actually asking about — e.g. if it names one sector or one company, lead with that — rather than reciting the full structure regardless of phrasing.

WHAT THE FIELDS MEAN:
- pctChange: the sector ETF's percent price change over the period.
- weightPctOfSector: how much of the sector that company represents, from disclosed ETF holdings. A structural size measure.
- speedZScore: how fast the company moved RELATIVE TO ITS SECTOR PEERS, in standard deviations. 0 is average for the sector; positive is faster.
- relativeVolume: today's volume divided by its 20-day average. Above ~1.5 suggests unusual participation.
- quadrant: already phrased in plain English in the DATA block. "an anchor leader" = large AND fast, the companies genuinely driving the sector's move. "an emerging mover" = small but fast, an early signal that has not yet moved the index. "a stable heavyweight" = large but not moving. "a laggard" = neither.

These two measures are deliberately kept separate. Do not merge, add, or average them.

${requiredStructure}

DATA:
${dataBlock}${caveats}${corrections}`;
}

/**
 * The honest, no-LLM message for a sector_trend question scoped to a sector
 * whose leader data is compromised by Alpha Vantage quota exhaustion.
 *
 * Unlike the sector cross-check (a confidence badge on a number Yahoo already
 * provides — losing it costs nothing real), the ETF-holdings fallback this
 * gates on is a genuine data-quality hit: Yahoo's top-10 holdings list
 * structurally cannot show a low-weight, high-speed company, so the
 * `emerging_mover` "early signal" callout §5.5 asks for is unreachable for
 * this sector right now (§5.8b/§5.9b). Rather than narrate a quietly
 * incomplete picture as if it were the full one, this is a plain deterministic
 * string — no arithmetic, no LLM call — matching the honest-stub shape
 * already used elsewhere in this node (`followup`/`portfolio_scan`/
 * `company_snapshot` with nothing to work with).
 */
function buildQuotaCompromisedMessage(sectors: string[]): string {
  const list = sectors.join(" and ");
  const plural = sectors.length > 1;

  return (
    `I can't give you a complete picture of ${list} right now. Alpha Vantage's daily data ` +
    `quota is exhausted, so ${list}'s leader breakdown is falling back to Yahoo Finance's ` +
    `top-10 holdings list — and a top-10 list can't show a smaller, faster-moving company, ` +
    `which is exactly the "early signal" you'd want to catch. Rather than give you an answer ` +
    `that's silently missing that part, ${plural ? "these are" : "this is"} worth checking again ` +
    `once the quota resets (Alpha Vantage resets daily). In the meantime I can still tell you ` +
    `${list}'s overall performance trend, or the trend picture across all sectors — just ask ` +
    `without naming ${plural ? "them" : "it"} specifically.`
  );
}

/**
 * The task instruction for a `followup` question — reuses whichever
 * capability's DATA block is already in state from an earlier turn (see
 * `reportWriterNode`'s disambiguation). Deliberately does NOT restate a full
 * REQUIRED STRUCTURE: a follow-up answers ONE new question, not the whole
 * analysis again.
 */
function buildFollowupTaskPrompt(state: AgentState, dataBlock: string, userQuestion: string): string {
  const corrections =
    state.validationNotes.length > 0
      ? `\n\n⚠️ YOUR PREVIOUS DRAFT WAS REJECTED. Fix these specific problems:\n` +
        state.validationNotes.map((n) => `- ${n}`).join("\n") +
        `\nRewrite the answer from scratch, keeping strictly to the DATA block.`
      : "";

  return `THE USER HAS A FOLLOW-UP QUESTION about an analysis already given earlier in this conversation: "${userQuestion}"

Answer it directly, using ONLY the DATA block below — the same data already computed earlier in this conversation. Do not invent, recompute, or re-derive anything not already present there. Focus on what was actually asked; you do not need to re-narrate the full original report.

DATA:
${dataBlock}${corrections}`;
}

// =============================================================================
// SECTION 2 — Model invocation
// =============================================================================

/** What `invokeWithFallback` returns: either generated text, or the last error. */
type InvokeResult = { text: string; provider: LlmProvider } | { error: unknown };

/**
 * Call the LLM, trying the primary provider then falling back to the
 * secondary on a rate limit (§2). Shared by both prompt paths below so the
 * fallback behaviour can't drift between them.
 *
 * Only a rate limit is worth switching provider for — a malformed-prompt
 * error would fail identically on the other provider, so it is not retried.
 */
async function invokeWithFallback(messages: BaseMessage[]): Promise<InvokeResult> {
  const attempts: (LlmProvider | undefined)[] = [undefined, "groq"];
  let lastError: unknown = null;

  for (const provider of attempts) {
    try {
      const { model, provider: used } = getLlm(provider);
      const response = await model.invoke(messages);
      const text =
        typeof response.content === "string" ? response.content : JSON.stringify(response.content);
      return { text, provider: used };
    } catch (error) {
      lastError = error;
      if (!isRateLimitError(error)) break;
      console.warn(`[report-writer] provider rate-limited, trying fallback: ${String(error)}`);
    }
  }

  return { error: lastError };
}

// =============================================================================
// SECTION 3 — The node
// =============================================================================

/**
 * Generate `draftReport` from the computed state.
 *
 * READS  `intent`, `messages`, `tickers`, `sectors`, `sectorRankings`, `sectorLeaders`,
 *        `timeWindow`, `trendDataErrors`, `partialHoldingsSectors`, `growthAuthenticity`,
 *        `growthCheckErrors`, `portfolioGrowthResults`, `tickerComparison`,
 *        `portfolioScanErrors`, `companySnapshots`, `companySnapshotErrors`,
 *        `technicalAnalysis`, `technicalAnalysisErrors`,
 *        `validationNotes`, `activeCapabilities`, `retryCount`
 * WRITES `draftReport`, `messages`, `retryCount`, `dataErrors`
 * NEVER  touches `sectorRankings`/`sectorLeaders` (§9) or calls an external
 *        API. It reads the numbers; it does not produce them.
 *
 * `retryCount` is incremented here rather than in the validator because this
 * node is what actually consumes the budget — one increment per LLM attempt is
 * the meaningful count, and `graph.ts` compares it against the ceiling.
 */
export async function reportWriterNode(
  state: AgentState,
  config?: LangGraphRunnableConfig,
): Promise<Partial<AgentState>> {
  const attemptMessage =
    state.validationNotes.length > 0
      ? `Revising report based on validation feedback (attempt ${state.retryCount + 1})...`
      : "Writing report...";

  // Genuinely not a finance question (see module header). This DOES call the
  // LLM — there is just no capability DATA block to hand it.
  if (state.intent === "general_chat") {
    const messages = [
      new SystemMessage(GENERAL_CHAT_SYSTEM_PROMPT),
      new HumanMessage(latestUserText(state.messages)),
    ];

    emitProgress(config, "report_writer", attemptMessage);
    const result = await invokeWithFallback(messages);
    if ("error" in result) {
      const message = result.error instanceof Error ? result.error.message : String(result.error);
      return {
        draftReport: null,
        dataErrors: [...state.dataErrors, `Report generation failed: ${message}`],
        retryCount: state.retryCount + 1,
      };
    }

    console.info(
      `[report-writer] general_chat reply generated via ${result.provider} ` +
        `(attempt ${state.retryCount + 1})`,
    );
    return {
      draftReport: result.text,
      messages: [new AIMessage(result.text)],
      retryCount: state.retryCount + 1,
    };
  }

  // Which capability (if any) actually ran (§4's other intents may reach here
  // with none implemented yet — §9). Exactly one branch, matching the
  // established one-branch-per-capability shape rather than a registry.
  let prompt: string;
  if (state.activeCapabilities.includes(INDUSTRY_TREND_CAPABILITY_ID)) {
    // Gate, don't narrate around: a sector the user explicitly asked about
    // whose holdings fell back to Yahoo's top-10 is missing a real signal
    // (emerging_mover), not just a confidence badge — see
    // buildQuotaCompromisedMessage. Unscoped questions ("what's trending")
    // are unaffected: `state.sectors` is empty there, so this never fires.
    const compromisedSectors = state.sectors.filter((s) =>
      state.partialHoldingsSectors.includes(s),
    );
    if (compromisedSectors.length > 0) {
      const message = buildQuotaCompromisedMessage(compromisedSectors);
      console.info(
        `[report-writer] sector_trend gated: quota-compromised holdings for ${compromisedSectors.join(", ")}`,
      );
      return {
        draftReport: message,
        finalReport: message,
        validationPassed: true,
        messages: [new AIMessage(message)],
      };
    }

    const dataBlock = buildDataBlock(
      state.sectorRankings,
      state.sectorLeaders,
      state.timeWindow,
      state.sectors,
    );
    prompt = buildTaskPrompt(state, dataBlock);
  } else if (state.activeCapabilities.includes(GROWTH_AUTHENTICITY_CAPABILITY_ID)) {
    const dataBlock = buildGrowthDataBlock(state.growthAuthenticity, state.timeWindow);
    prompt = buildGrowthTaskPrompt(state, dataBlock);
  } else if (state.activeCapabilities.includes(PORTFOLIO_SCAN_CAPABILITY_ID)) {
    const dataBlock = buildPortfolioScanDataBlock(
      state.portfolioGrowthResults,
      state.tickerComparison,
      state.timeWindow,
    );
    prompt = buildPortfolioScanTaskPrompt(state, dataBlock);
  } else if (state.activeCapabilities.includes(COMPANY_SNAPSHOT_CAPABILITY_ID)) {
    const dataBlock = buildCompanySnapshotDataBlock(state.companySnapshots, state.timeWindow);
    prompt = buildCompanySnapshotTaskPrompt(state, dataBlock);
  } else if (state.activeCapabilities.includes(TECHNICAL_ANALYSIS_CAPABILITY_ID)) {
    const dataBlock = buildTechnicalAnalysisDataBlock(state.technicalAnalysis, state.timeWindow);
    prompt = buildTechnicalAnalysisTaskPrompt(state, dataBlock);
  } else if (
    state.intent === "followup" &&
    (state.growthAuthenticity !== null ||
      state.sectorRankings !== null ||
      state.companySnapshots !== null ||
      state.technicalAnalysis !== null)
  ) {
    // Disambiguation: a thread can have sectorRankings/growthAuthenticity/
    // companySnapshots/technicalAnalysis ALL populated, from different
    // earlier turns, with no ordering signal in state to say which is most
    // recent. A ticker freshly parsed from THIS message is the strongest
    // available signal the question is about a ticker-scoped analysis rather
    // than the sector one — a documented heuristic (§5.3/§9's "no silent
    // guessing" principle), not a coin flip. Among the three ticker-scoped
    // capabilities, technicalAnalysis wins first when present — a
    // trading-levels question is the narrowest and least likely to be
    // confused with the other two once TA data exists in the thread — then
    // companySnapshot (broader than growth-authenticity), then
    // growthAuthenticity, extending the same "most specific wins" reasoning
    // already used to prioritize companySnapshot over growthAuthenticity.
    const followsTechnicalAnalysis = state.technicalAnalysis !== null && state.tickers.length > 0;
    const followsCompanySnapshot =
      !followsTechnicalAnalysis && state.companySnapshots !== null && state.tickers.length > 0;
    const followsGrowthCheck =
      !followsTechnicalAnalysis &&
      !followsCompanySnapshot &&
      state.growthAuthenticity !== null &&
      (state.tickers.length > 0 || state.sectorRankings === null);

    const dataBlock = followsTechnicalAnalysis
      ? buildTechnicalAnalysisDataBlock(state.technicalAnalysis, state.timeWindow)
      : followsCompanySnapshot
        ? buildCompanySnapshotDataBlock(state.companySnapshots, state.timeWindow)
        : followsGrowthCheck
          ? buildGrowthDataBlock(state.growthAuthenticity, state.timeWindow)
          : buildDataBlock(state.sectorRankings, state.sectorLeaders, state.timeWindow, state.sectors);
    prompt = buildFollowupTaskPrompt(state, dataBlock, latestUserText(state.messages));
  } else if (state.intent === "followup") {
    // Nothing computed yet in this thread to follow up on — honest message,
    // no LLM call, since there is nothing to narrate.
    const message =
      "There's no earlier analysis in this conversation yet to follow up on. Ask a " +
      'sector/industry trend question (e.g. "which sectors are trending up this ' +
      'month?") or a single-ticker growth-authenticity question (e.g. "is NVDA\'s ' +
      'growth backed by revenue?") to get started.';
    return {
      draftReport: message,
      finalReport: message,
      validationPassed: true,
      messages: [new AIMessage(message)],
    };
  } else if (state.intent === "portfolio_scan") {
    // Reached only when no ticker was named (§12.2) — `activeCapabilities`
    // stays empty in that case (`supervisor.ts`), so `portfolioGrowthScanNode`
    // never ran and there is nothing to narrate. Honest, no LLM call.
    const message =
      "I can check several tickers' growth authenticity at once, but need at least " +
      'one to check — for example: "are AAPL, MSFT, and NVDA all growing for real, ' +
      'or is this just the AI trade?" or "compare NVDA and AMD".';
    return {
      draftReport: message,
      finalReport: message,
      validationPassed: true,
      messages: [new AIMessage(message)],
    };
  } else if (state.intent === "company_snapshot") {
    // Reached only when no ticker was named — `activeCapabilities` stays
    // empty in that case (`supervisor.ts`), so `companySnapshotScanNode`
    // never ran and there is nothing to narrate. Honest, no LLM call.
    const message =
      "I can pull valuation, financial-health, and general-fundamentals data for a " +
      'ticker or a small handful, but need at least one to check — for example: "is ' +
      'NVDA overvalued compared to other chipmakers?" or "what\'s AAPL\'s debt situation ' +
      'look like?"';
    return {
      draftReport: message,
      finalReport: message,
      validationPassed: true,
      messages: [new AIMessage(message)],
    };
  } else if (state.intent === "technical_analysis") {
    // Reached only when no ticker or sector was named — `activeCapabilities`
    // stays empty in that case (`supervisor.ts`), so `technicalAnalysisScanNode`
    // never ran and there is nothing to narrate. Honest, no LLM call.
    const message =
      "I can build a technical-analysis trading setup for a ticker, a few tickers, or a " +
      'sector, but need at least one to check — for example: "give me an entry point and ' +
      'stop loss for NVDA" or "what\'s the RSI on the tech sector right now?"';
    return {
      draftReport: message,
      finalReport: message,
      validationPassed: true,
      messages: [new AIMessage(message)],
    };
  } else {
    // An honest "not supported" rather than a fabricated answer — and no LLM
    // call, since there is nothing to narrate.
    const message =
      "That request is outside what this agent can currently analyse. It supports " +
      "sector and industry trend analysis, single-ticker growth-authenticity checks, " +
      "multi-ticker portfolio scans/comparisons, company valuation/financial-health " +
      "snapshots, and technical-analysis trading setups — for example: \"which sectors " +
      'are trending up this month, and who is leading them?", "is NVDA\'s growth backed ' +
      'by revenue or just the AI trade?", "compare NVDA and AMD", "is NVDA overvalued ' +
      'compared to other chipmakers?", or "give me an entry point and stop loss for NVDA"';
    return {
      draftReport: message,
      finalReport: message,
      validationPassed: true,
      messages: [new AIMessage(message)],
    };
  }

  const messages = [new SystemMessage(SYSTEM_PROMPT), new HumanMessage(prompt)];
  emitProgress(config, "report_writer", attemptMessage);
  const result = await invokeWithFallback(messages);

  if ("error" in result) {
    // §8: degrade into a `*Errors` field rather than crashing the run. The
    // graph still terminates and the API still responds — with an honest
    // failure instead of a 500.
    const message = result.error instanceof Error ? result.error.message : String(result.error);
    return {
      draftReport: null,
      dataErrors: [...state.dataErrors, `Report generation failed: ${message}`],
      retryCount: state.retryCount + 1,
    };
  }

  console.info(
    `[report-writer] draft generated via ${result.provider} (attempt ${state.retryCount + 1})`,
  );

  return {
    draftReport: result.text,
    messages: [new AIMessage(result.text)],
    retryCount: state.retryCount + 1,
  };
}
