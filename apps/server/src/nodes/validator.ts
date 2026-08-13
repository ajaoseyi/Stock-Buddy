/**
 * =============================================================================
 * validator.ts — check the draft against the computed data. DETERMINISTIC.
 * =============================================================================
 *
 * CLAUDE.md §5.6: "Confirm every ticker and every percentage mentioned in
 * `draftReport` for this capability appears in `sectorRankings` or
 * `sectorLeaders`. Flag and trigger a retry if not."
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THIS FILE IS WHERE §1 IS ENFORCED                                         │
 * │                                                                           │
 * │ "The LLM never computes a number. Every numeric claim in a user-facing    │
 * │  report must trace back to a value produced by deterministic TypeScript   │
 * │  code."                                                                   │
 * │                                                                           │
 * │ Every other file upholds that by construction — the capability nodes do   │
 * │ the arithmetic and the model only narrates. But a model CAN still         │
 * │ hallucinate a plausible figure inside otherwise-correct prose, and prose  │
 * │ is the one thing we cannot constrain by typing. So this node re-reads the │
 * │ finished text and checks every number and ticker back against the state   │
 * │ that produced it. It is the last gate before a report reaches a user.     │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * IT USES NO LLM, AND THAT IS THE POINT. Asking a model to check another
 * model's arithmetic reintroduces exactly the failure being guarded against.
 * String extraction plus a numeric comparison is boring, exhaustively testable,
 * and cannot itself hallucinate.
 *
 * §9 also forbids this node from calling any external API — it reads state only.
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type {
  AgentState,
  CompanySnapshotResult,
  GrowthAuthenticityResult,
  GrowthClassification,
  SectorLeader,
  SectorRanking,
  TechnicalAnalysisResult,
  TickerComparisonResult,
  TickerOverallVerdict,
} from "../state.js";
import { emitProgress } from "../streaming.js";

// =============================================================================
// SECTION 1 — Tolerances
// =============================================================================

/**
 * How far a quoted percentage may sit from a computed one and still count as
 * the same number, in percentage points.
 *
 * 0.05pp accommodates ordinary rounding: the data says `8.331%`, a good report
 * says "8.3%". It is deliberately tight — wide enough for one decimal place of
 * rounding, far too narrow to let an invented figure slip through. A model
 * writing "about 9%" when the value is 8.33 will and should fail.
 */
export const PERCENTAGE_TOLERANCE = 0.05;

/**
 * Words that look like tickers but are not, so the validator does not demand
 * they appear in the data.
 *
 * Without this list, a report legitimately containing "GICS" or "ETF" would be
 * rejected for citing an unknown company — a false failure that would burn the
 * whole retry budget and end with a caveated report for no reason.
 */
const TICKER_STOPWORDS = new Set([
  "GICS",
  "ETF",
  "ETFS",
  "USD",
  "CEO",
  "CFO",
  "IPO",
  "USA",
  "US",
  "EPS",
  "AI",
  "IT",
  "API",
  "YTD",
  "AND",
  "THE",
  "FOR",
  "ARE",
  "NOT",
  "BUT",
  "ALL",
  "TOP",
  // Technical-analysis indicator acronyms (§14) — legitimate vocabulary in a
  // technical-analysis report ("ATR-based levels", "RSI is overbought"), not
  // company tickers. Same rationale as the sector-ETF tickers below.
  "RSI",
  "MACD",
  "ATR",
  "SMA",
  "EMA",
  "XLK",
  "XLE",
  "XLF",
  "XLV",
  "XLI",
  "XLY",
  "XLP",
  "XLU",
  "XLB",
  "XLRE",
  "XLC",
  "Q1",
  "Q2",
  "Q3",
  "Q4",
  "NOTE",
  "DATA",
  "NAV",
  "SPDR",
]);

// =============================================================================
// SECTION 2 — Extraction
// =============================================================================

/**
 * Pull every percentage figure out of the prose.
 *
 * Handles `8.33%`, `+8.3%`, `-2.1%`, `8 %`, and the spelled form
 * "8.33 percent". The sign is captured but comparison below uses magnitude
 * matching against signed values, because a report may legitimately write
 * "fell 2.1%" for a value stored as `-2.1`.
 */
export function extractPercentages(text: string): number[] {
  const found: number[] = [];
  for (const match of text.matchAll(/([+-]?\d+(?:\.\d+)?)\s*(?:%|percent(?:age)?\b)/gi)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) found.push(value);
  }
  return found;
}

/**
 * Pull every plausible ticker symbol out of the prose.
 *
 * Conservative by design: only all-caps runs of 1-5 letters, minus the
 * stop-list. Over-extraction causes false validation failures, which are worse
 * than under-extraction here — a missed ticker is caught by the percentage
 * check if it came with a number attached, and a false failure wastes the
 * entire retry budget.
 */
export function extractTickers(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\b([A-Z]{1,5})\b/g)) {
    const candidate = match[1]!;
    if (!TICKER_STOPWORDS.has(candidate)) found.add(candidate);
  }
  return [...found].sort();
}

/**
 * How far a quoted DOLLAR price level may sit from a computed one and still
 * count as the same number — RELATIVE, not absolute, unlike
 * `PERCENTAGE_TOLERANCE` above. A $500 stock and a $5 stock need different
 * absolute tolerances for the same "2 decimal places of rounding" allowance;
 * 0.5% comfortably covers ordinary rounding at any price scale without being
 * wide enough to let an invented level slip through.
 *
 * This exists because `extractPercentages`/`PERCENTAGE_TOLERANCE` above only
 * ever look for `%`-suffixed figures — technical-analysis's headline output
 * (entry/stop-loss/take-profit/support/resistance) is a DOLLAR price, a
 * numeric domain no other capability's report ever states as its primary
 * claim. Trade levels are the one output in this codebase a reader could act
 * on directly, so they get their own dedicated mechanical check
 * (`checkPriceLevelsCited` below) rather than relying on the generic
 * percentage check to catch a wrong one.
 */
export const PRICE_RELATIVE_TOLERANCE = 0.005;

/** Pull every `$`-prefixed price out of the prose, e.g. `$142.50`, `$1,234.5`. */
export function extractDollarAmounts(text: string): number[] {
  const found: number[] = [];
  for (const match of text.matchAll(/\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/g)) {
    const value = Number(match[1]!.replace(/,/g, ""));
    if (Number.isFinite(value)) found.push(value);
  }
  return found;
}

/** Relative-tolerance match for a dollar price against a set of computed price levels — see `PRICE_RELATIVE_TOLERANCE`. */
function matchesKnownPrice(quoted: number, known: number[]): boolean {
  return known.some((value) => {
    const scale = Math.max(Math.abs(value), 1);
    return Math.abs(value - quoted) <= scale * PRICE_RELATIVE_TOLERANCE;
  });
}

// =============================================================================
// SECTION 3 — The known-value index
// =============================================================================

/** Everything the report is permitted to assert, gathered from state. */
interface KnownValues {
  tickers: Set<string>;
  /** Every number the report may legitimately quote, as computed. */
  numbers: number[];
}

/**
 * Collect every ticker and every number the capability actually computed.
 *
 * The number set intentionally includes all three metrics — sector percentage
 * changes, weight scores, and speed scores — because §5.5 lets the report
 * writer mention any of them. What it does NOT include is anything derived:
 * if the model writes "the top two sectors gained 11.4% combined", that sum
 * appears nowhere in state and correctly fails, because §1 forbids the model
 * doing arithmetic even when the arithmetic is right.
 */
export function collectKnownValues(
  sectorRankings: SectorRanking[] | null,
  sectorLeaders: Record<string, SectorLeader[]> | null,
): KnownValues {
  const tickers = new Set<string>();
  const numbers: number[] = [];

  for (const ranking of sectorRankings ?? []) {
    numbers.push(ranking.pctChange);
  }

  for (const leaders of Object.values(sectorLeaders ?? {})) {
    for (const leader of leaders) {
      tickers.add(leader.ticker.toUpperCase());
      numbers.push(leader.weightScore);
      numbers.push(leader.speedScore);
      numbers.push(leader.relativeVolume);
    }
  }

  return { tickers, numbers };
}

/**
 * Collect the ticker and numbers the growth-authenticity capability actually
 * computed. Parallel to `collectKnownValues` rather than merged into it —
 * matches the established one-branch-per-capability shape already used in
 * `report-writer.ts` and `graph.ts`.
 */
export function collectGrowthKnownValues(
  growthAuthenticity: GrowthAuthenticityResult | null,
): KnownValues {
  if (growthAuthenticity === null) return { tickers: new Set(), numbers: [] };

  const g = growthAuthenticity;
  const numbers = [
    g.revenueGrowth.revenueGrowthPct,
    g.discrepancy.priceChangePct,
    g.discrepancy.priceToRevenueGrowthRatio,
    g.inorganic.goodwillTrend.deltaPct,
    g.inorganic.ppeTrend.deltaPct,
    g.inorganic.cashTrend.deltaPct,
    g.sectorBenchmark.sectorBenchmarkPct,
    g.sectorBenchmark.stockVsSectorSpreadPct,
  ].filter((n): n is number => n !== null);

  return { tickers: new Set([g.ticker.toUpperCase()]), numbers };
}

/**
 * Collect the tickers and numbers the portfolio-scan capability actually
 * computed (§12.6) — the union of `collectGrowthKnownValues` over every
 * analysed ticker, same "any computed number is fair game to quote" contract
 * `collectKnownValues` already applies to a sector's multiple leaders. This
 * does not verify a cited number is attributed to the RIGHT ticker's own
 * entry (that would need per-sentence attribution, a different kind of check
 * than this file's boring, deterministic ticker/number matching does
 * anywhere else) — only that it is a real, computed figure from SOME
 * analysed ticker.
 */
export function collectPortfolioScanKnownValues(
  portfolioGrowthResults: GrowthAuthenticityResult[] | null,
): KnownValues {
  const tickers = new Set<string>();
  const numbers: number[] = [];

  for (const result of portfolioGrowthResults ?? []) {
    const entry = collectGrowthKnownValues(result);
    for (const ticker of entry.tickers) tickers.add(ticker);
    numbers.push(...entry.numbers);
  }

  return { tickers, numbers };
}

/**
 * Collect the tickers and numbers the ticker-comparison node actually
 * computed (§12.8) — every per-ticker metric value plus the verdict's own
 * `winCounts`/`comparableMetricCount`. Parallel to the other `collectX`
 * functions rather than merged into `collectPortfolioScanKnownValues`,
 * matching this file's established one-function-per-computed-field-group
 * shape.
 */
export function collectTickerComparisonKnownValues(
  tickerComparison: TickerComparisonResult | null,
): KnownValues {
  if (tickerComparison === null) return { tickers: new Set(), numbers: [] };

  const tickers = new Set(tickerComparison.tickers.map((t) => t.toUpperCase()));
  const numbers: number[] = [tickerComparison.overallVerdict.comparableMetricCount];

  for (const rank of tickerComparison.metricRanks) {
    for (const v of rank.values) {
      if (v.value !== null) numbers.push(v.value);
    }
  }
  for (const count of Object.values(tickerComparison.overallVerdict.winCounts)) {
    numbers.push(count);
  }

  return { tickers, numbers };
}

/**
 * Collect the tickers and numbers the company-snapshot capability actually
 * computed (§13.9) — every ticker's profile facts plus every valuation/
 * financial-health metric's `value`/`peerMedian`/`zScore`.
 */
export function collectCompanySnapshotKnownValues(
  companySnapshots: CompanySnapshotResult[] | null,
): KnownValues {
  const tickers = new Set<string>();
  const numbers: number[] = [];

  for (const snapshot of companySnapshots ?? []) {
    tickers.add(snapshot.ticker.toUpperCase());

    if (snapshot.profile !== null) {
      const p = snapshot.profile;
      for (const n of [
        p.marketCap,
        p.fullTimeEmployees,
        p.beta,
        p.dividendYieldPct,
        p.fiftyTwoWeekLow,
        p.fiftyTwoWeekHigh,
        p.trailingEps,
        p.forwardEps,
        p.analystTargetMeanPrice,
        p.reportedRevenueGrowthPct,
      ]) {
        if (n !== null) numbers.push(n);
      }
    }

    for (const metrics of [snapshot.valuation?.metrics, snapshot.financialHealth?.metrics]) {
      for (const m of metrics ?? []) {
        if (m.value !== null) numbers.push(m.value);
        if (m.peerMedian !== null) numbers.push(m.peerMedian);
        if (m.zScore !== null) numbers.push(m.zScore);
      }
    }
  }

  return { tickers, numbers };
}

/**
 * Every DOLLAR-scale price level the technical-analysis capability actually
 * computed for a batch of symbols — support/resistance levels plus both
 * methodologies' entry/stop-loss/take-profit. This is the target set for
 * `checkPriceLevelsCited`'s dedicated dollar-figure check, kept separate from
 * `collectTechnicalAnalysisKnownValues` below (which feeds the generic
 * ticker/number union every other capability also feeds) because a price
 * level is the one figure in this capability's output a reader could act on
 * directly — it gets its own targeted verification, not just a place in the
 * general pool.
 */
export function collectTechnicalAnalysisPriceLevels(
  technicalAnalysis: TechnicalAnalysisResult[] | null,
): number[] {
  const values: number[] = [];

  for (const t of technicalAnalysis ?? []) {
    for (const level of [...t.supportLevels, ...t.resistanceLevels]) values.push(level.price);
    for (const levels of [t.atrLevels, t.swingLevels]) {
      if (levels.entry !== null) values.push(levels.entry);
      if (levels.stopLoss !== null) values.push(levels.stopLoss);
      if (levels.takeProfit !== null) values.push(levels.takeProfit);
    }
    if (t.indicators.latestClose !== null) values.push(t.indicators.latestClose);
  }

  return values;
}

/**
 * Collect the symbols and numbers the technical-analysis capability actually
 * computed (§14.13) — every analysed symbol, its price levels (via
 * `collectTechnicalAnalysisPriceLevels`), and its indicator values. Numbers
 * here mostly won't be caught by check 2 below (which only extracts
 * `%`-suffixed figures, and indicators/prices are not percentages) — the same
 * pre-existing gap `collectCompanySnapshotKnownValues`'s non-percentage
 * fields (beta, EPS, market cap) already have. `checkPriceLevelsCited` closes
 * that gap specifically for price levels, the one numeric domain here worth
 * closing it for.
 */
export function collectTechnicalAnalysisKnownValues(
  technicalAnalysis: TechnicalAnalysisResult[] | null,
): KnownValues {
  const tickers = new Set<string>();
  const numbers: number[] = [...collectTechnicalAnalysisPriceLevels(technicalAnalysis)];

  for (const t of technicalAnalysis ?? []) {
    tickers.add(t.symbol.toUpperCase());
    const ind = t.indicators;
    for (const n of [
      ind.sma20,
      ind.sma50,
      ind.sma200,
      ind.ema12,
      ind.ema26,
      ind.rsi14,
      ind.macd.macdLine,
      ind.macd.signalLine,
      ind.macd.histogram,
      ind.atr14,
      ind.bollinger.middle,
      ind.bollinger.upper,
      ind.bollinger.lower,
    ]) {
      if (n !== null) numbers.push(n);
    }
  }

  return { tickers, numbers };
}

/**
 * Does `draftReport` actually name `result.symbol`? A dedicated check because
 * `TICKER_STOPWORDS` already exempts all 11 sector ETF tickers (XLK...XLC,
 * added so ordinary prose mentioning a sector ETF wasn't flagged as an
 * unknown ticker) — harmless while an ETF was never itself the analysed
 * subject. Now a sector-level technical-analysis request produces a result
 * whose `symbol` genuinely IS e.g. "XLK", and `extractTickers` will silently
 * strip it from `citedTickers`, so check 1 alone can never catch a report
 * that names the WRONG sector ETF. That matters more here than for a
 * classification label: a trade level attributed to the wrong symbol is
 * actively dangerous, not just mislabelled.
 */
export function checkSymbolNarrated(draftReport: string, result: TechnicalAnalysisResult): string | null {
  const pattern = new RegExp(`\\b${result.symbol}\\b`, "i");
  if (!pattern.test(draftReport)) {
    return (
      `The report does not name "${result.symbol}" even though technical analysis was ` +
      `computed for it. State which ticker/ETF each set of levels belongs to.`
    );
  }
  return null;
}

/**
 * Keyword sets required in the draft report for each `stance` value — same
 * heuristic substring-match style as `CLASSIFICATION_KEYWORDS` below (a false
 * negative costs a harmless retry, not a wrong answer reaching the user).
 */
const STANCE_KEYWORDS: Record<TechnicalAnalysisResult["stance"], string[]> = {
  bullish_setup: ["bullish", "buy setup", "long setup", "buying opportunity", "pullback"],
  bearish_setup: ["bearish", "sell setup", "short setup", "selling opportunity", "rally"],
  neutral_no_setup: ["no clear setup", "no setup", "neutral", "sideways", "no trade"],
  insufficient_data: [
    "insufficient data",
    "not enough data",
    "limited data",
    "cannot determine",
    "insufficient price history",
  ],
};

/**
 * Does `draftReport` actually state the computed stance for `result`? Mirrors
 * `checkClassificationNarrated` — closes the gap where a report could cite
 * real levels while narrating a different conclusion than the one those
 * levels were computed under.
 */
export function checkStanceNarrated(draftReport: string, result: TechnicalAnalysisResult): string | null {
  const lower = draftReport.toLowerCase();
  const required = STANCE_KEYWORDS[result.stance];

  if (!required.some((keyword) => lower.includes(keyword))) {
    return (
      `The report does not clearly state the computed stance ("${result.stance}") for ` +
      `${result.symbol}. State the stance plainly and explain it using only trendDirection/momentumDirection.`
    );
  }
  return null;
}

/**
 * Mechanical backstop for the "never merge the two trade-level methodologies"
 * instruction (CLAUDE.md §14.12): when a methodology actually produced a
 * non-null stop-loss, its own keyword ("ATR"/"average true range" or "swing")
 * must appear somewhere in the draft — a report that quotes both sets of
 * numbers without ever labelling which is which has effectively blended them
 * for the reader, even if the underlying figures stayed technically separate.
 */
export function checkBothMethodsLabeled(draftReport: string, result: TechnicalAnalysisResult): string | null {
  const lower = draftReport.toLowerCase();
  const missing: string[] = [];

  if (result.atrLevels.stopLoss !== null && !lower.includes("atr") && !lower.includes("average true range")) {
    missing.push(`the ATR-based levels for ${result.symbol} (mention "ATR" or "average true range")`);
  }
  if (result.swingLevels.stopLoss !== null && !lower.includes("swing")) {
    missing.push(`the swing-based levels for ${result.symbol} (mention "swing")`);
  }

  if (missing.length === 0) return null;
  return `The report does not clearly label ${missing.join(" and ")}. Present both methodologies as separately labelled sections.`;
}

/**
 * Does every `$`-prefixed price in `draftReport` match a computed price level
 * across all analysed symbols? The dedicated dollar-figure counterpart to
 * check 2's percentage check (§ file header on `PRICE_RELATIVE_TOLERANCE`) —
 * run once across the whole batch, not per-symbol, since a price figure
 * could legitimately be attributed to any of the analysed symbols and this
 * check (like check 2) does not attempt per-sentence attribution.
 */
export function checkPriceLevelsCited(
  draftReport: string,
  technicalAnalysis: TechnicalAnalysisResult[],
): string | null {
  if (technicalAnalysis.length === 0) return null;

  const known = collectTechnicalAnalysisPriceLevels(technicalAnalysis);
  const cited = extractDollarAmounts(draftReport);
  const unknown = cited.filter((n) => !matchesKnownPrice(n, known));

  if (unknown.length === 0) return null;
  return (
    `The report cites ${unknown.map((n) => `$${n}`).join(", ")}, which ` +
    `${unknown.length === 1 ? "does" : "do"} not match any computed price level. Quote only ` +
    `the exact entry/stop-loss/take-profit/support/resistance figures supplied, prefixed with "$".`
  );
}

/**
 * Keyword sets required in the draft report for each `classification` value —
 * a heuristic, case-insensitive substring check, not true semantic
 * verification. Deliberately NOT a second LLM call judging the first: that
 * would just move the "LLM never judges without a deterministic backstop"
 * problem up one level (a judge LLM can hallucinate agreement too) rather
 * than solving it. Consistent with this file's existing string/number-
 * matching-only style. A false negative here costs a harmless retry, not a
 * wrong answer reaching the user — an acceptable trade for staying boring and
 * exhaustively testable.
 */
const CLASSIFICATION_KEYWORDS: Record<GrowthClassification, string[]> = {
  organic_growth_supported: ["organic", "revenue growth is supporting", "fundamentals support"],
  inorganic_ma_driven: ["acquisition", "m&a", "merger", "inorganic", "goodwill"],
  macro_or_commodity_beta_driven: [
    "sector",
    "commodity",
    "macro",
    "broader market",
    "industry-wide",
  ],
  price_outpacing_fundamentals_unexplained: [
    "outpacing",
    "decoupled",
    "unexplained",
    "not supported by",
  ],
  mixed_signals: ["mixed signal", "mixed picture", "unclear"],
  insufficient_data: ["insufficient data", "not enough data", "limited data", "cannot determine"],
};

/**
 * Does `draftReport` actually state the computed classification, or has it
 * drifted from what `growth-classification.ts` decided?
 *
 * This closes a real gap: `report-writer.ts` INSTRUCTS the model not to
 * deviate from `classification`, but an instruction is not enforcement —
 * without this check, nothing would catch a report that quotes real numbers
 * (passing checks 1/2 above) while narrating a different conclusion than the
 * one those numbers were computed to support.
 */
export function checkClassificationNarrated(
  draftReport: string,
  growthAuthenticity: GrowthAuthenticityResult,
): string | null {
  const lower = draftReport.toLowerCase();
  const required = CLASSIFICATION_KEYWORDS[growthAuthenticity.classification];

  if (!required.some((keyword) => lower.includes(keyword))) {
    return (
      `The report does not clearly state the computed classification ` +
      `("${growthAuthenticity.classification}") for ${growthAuthenticity.ticker}. ` +
      `State the classification plainly and explain it using only the supplied data.`
    );
  }
  return null;
}

/**
 * Keyword sets required in the draft report for each comparative-verdict
 * value (§12.8) — same heuristic substring-match style as
 * `CLASSIFICATION_KEYWORDS` above, not semantic verification (this file's
 * established, deliberate trade-off: a false negative costs a harmless
 * retry, not a wrong answer reaching the user).
 */
const COMPARISON_VERDICT_KEYWORDS: Record<TickerOverallVerdict["verdict"], string[]> = {
  clear_lead: ["clear lead", "clearly ahead", "clearly stronger", "wins on most", "leads on most"],
  narrow_lead: ["edges out", "slight edge", "narrow lead", "marginally ahead", "slightly ahead"],
  no_clear_leader: ["no clear leader", "no clear winner", "evenly matched", "roughly even", "too close to call"],
  insufficient_comparable_data: [
    "insufficient",
    "not enough comparable data",
    "cannot be compared",
    "can't be compared",
  ],
};

/**
 * Does `draftReport` actually state the computed comparative verdict (§12.8),
 * and — when the verdict names one — the ticker it favoured? Mirrors
 * `checkClassificationNarrated`'s "was the computed conclusion actually
 * narrated" check, extended to this second kind of computed verdict (§9.1,
 * §12.6).
 */
export function checkComparativeVerdictNarrated(
  draftReport: string,
  tickerComparison: TickerComparisonResult,
): string | null {
  const lower = draftReport.toLowerCase();
  const { verdict, strongerTicker } = tickerComparison.overallVerdict;
  const required = COMPARISON_VERDICT_KEYWORDS[verdict];

  if (!required.some((keyword) => lower.includes(keyword))) {
    return (
      `The report does not clearly state the computed comparison verdict ("${verdict}") ` +
      `across ${tickerComparison.tickers.join(", ")}. State the verdict plainly using only ` +
      `the supplied comparison data.`
    );
  }

  if (strongerTicker !== null && !draftReport.toUpperCase().includes(strongerTicker)) {
    return (
      `The report does not name "${strongerTicker}" as the ticker the computed comparison ` +
      `favoured. State which ticker the comparison verdict points to.`
    );
  }

  return null;
}

/**
 * Does `quoted` match any computed value within tolerance?
 *
 * Compares against both the signed value and its magnitude. A report that says
 * "Materials fell 4.2%" is correct prose for a stored `-4.2`; demanding the
 * minus sign in the text would fail good writing.
 */
function matchesKnownNumber(quoted: number, known: number[]): boolean {
  return known.some(
    (value) =>
      Math.abs(value - quoted) <= PERCENTAGE_TOLERANCE ||
      Math.abs(Math.abs(value) - Math.abs(quoted)) <= PERCENTAGE_TOLERANCE,
  );
}

// =============================================================================
// SECTION 4 — The node
// =============================================================================

/**
 * Validate `draftReport` against the computed state.
 *
 * READS  `draftReport`, `finalReport`, `sectorRankings`, `sectorLeaders`,
 *        `growthAuthenticity`, `portfolioGrowthResults`, `tickerComparison`,
 *        `companySnapshots`, `technicalAnalysis`, `retryCount`
 * WRITES `validationPassed`, `validationNotes`, `finalReport`
 * NEVER  calls an LLM or an external API (§9); never modifies the capability
 *        outputs it is checking against.
 *
 * If `report-writer.ts` already set `finalReport` (its signal for "this is a
 * fixed, non-data-driven reply — nothing to check"), that is trusted as-is
 * and none of the checks below run. Otherwise: on success the draft is
 * promoted to `finalReport`. On failure `finalReport` stays null and
 * actionable notes are written — `graph.ts` reads `validationPassed` to
 * decide whether to loop back to the report writer.
 */
export function validatorNode(
  state: AgentState,
  config?: LangGraphRunnableConfig,
): Partial<AgentState> {
  emitProgress(config, "validator", "Validating report against computed data...");

  const {
    draftReport,
    finalReport,
    sectorRankings,
    sectorLeaders,
    growthAuthenticity,
    portfolioGrowthResults,
    tickerComparison,
    companySnapshots,
    technicalAnalysis,
  } = state;

  // `report-writer.ts` sets `finalReport` directly (not just `draftReport`) in
  // exactly four places: the honest "nothing to follow up on" / "no ticker
  // named" / "not supported" replies. None of those narrate computed data —
  // they are fixed strings that happen to name EXAMPLE tickers (e.g. "compare
  // NVDA and AMD") for illustration. Running them through the checks below
  // anyway is not just redundant, it is actively wrong: on a follow-up turn
  // where an EARLIER turn already populated e.g. `portfolioGrowthResults`,
  // `anyCapabilityRan` below turns true from that carried-over data, and the
  // example tickers almost never appear in that data's own known-ticker set —
  // so check 1 fails, `validationPassed` flips to false, and the loop retries.
  // But these branches never increment `retryCount` (there is nothing to
  // retry — the message is identical every time), so `routeAfterValidation`'s
  // `retryCount >= MAX_REPORT_ATTEMPTS` budget check never trips either.
  // Verified live: this is a genuine infinite loop, not just a slow one —
  // `report_writer` <-> `validator` repeats the same doomed check until
  // LangGraph's hard 25-step ceiling throws `GraphRecursionError`.
  // `finalReport` being set at all is report-writer's own signal that this
  // draft is final and needs no checking; honour it instead of recomputing a
  // verdict this message was never trying to earn.
  if (finalReport !== null) {
    return { validationPassed: true, validationNotes: [], finalReport };
  }

  if (draftReport === null || draftReport.trim() === "") {
    return {
      validationPassed: false,
      validationNotes: ["No draft report was produced."],
      finalReport: null,
    };
  }

  const industryKnown = collectKnownValues(sectorRankings, sectorLeaders);
  const growthKnown = collectGrowthKnownValues(growthAuthenticity);
  const portfolioKnown = collectPortfolioScanKnownValues(portfolioGrowthResults);
  const comparisonKnown = collectTickerComparisonKnownValues(tickerComparison);
  const companySnapshotKnown = collectCompanySnapshotKnownValues(companySnapshots);
  const technicalAnalysisKnown = collectTechnicalAnalysisKnownValues(technicalAnalysis);
  const known: KnownValues = {
    tickers: new Set([
      ...industryKnown.tickers,
      ...growthKnown.tickers,
      ...portfolioKnown.tickers,
      ...comparisonKnown.tickers,
      ...companySnapshotKnown.tickers,
      ...technicalAnalysisKnown.tickers,
    ]),
    numbers: [
      ...industryKnown.numbers,
      ...growthKnown.numbers,
      ...portfolioKnown.numbers,
      ...comparisonKnown.numbers,
      ...companySnapshotKnown.numbers,
      ...technicalAnalysisKnown.numbers,
    ],
  };
  const notes: string[] = [];

  // Checks 1 and 2 only apply when SOME capability actually ran
  // (`sectorRankings !== null`, `growthAuthenticity !== null`, or
  // `portfolioGrowthResults !== null` — the null-vs-[] contract documented in
  // `state.ts`). When none did, there is no computed data for the draft to be
  // making claims against in the first place — most commonly the
  // `general_chat` path, whose free-form reply may legitimately contain an
  // incidental capitalised word or a "%"-looking number. Checking it against
  // an empty known-value set would reject it for citing "unknown" figures it
  // was never claiming were computed data, burning retry budget on a report
  // that was correct.
  const industryTrendRan = sectorRankings !== null;
  const growthAuthenticityRan = growthAuthenticity !== null;
  const portfolioScanRan = portfolioGrowthResults !== null;
  const companySnapshotRan = companySnapshots !== null;
  const technicalAnalysisRan = technicalAnalysis !== null;
  const anyCapabilityRan =
    industryTrendRan ||
    growthAuthenticityRan ||
    portfolioScanRan ||
    companySnapshotRan ||
    technicalAnalysisRan;

  // Hoisted out of the `anyCapabilityRan` branch below because check 3 also
  // needs to know how many percentages were cited, regardless of whether
  // checking them against known values applies.
  const citedNumbers = extractPercentages(draftReport);
  // Technical-analysis's headline output is DOLLAR price levels, not
  // percentages — a well-formed report for this capability can legitimately
  // cite zero `%` figures. Counted separately so check 3 below does not
  // reject every valid technical-analysis report for "citing no data".
  const citedDollarAmounts = extractDollarAmounts(draftReport);

  if (anyCapabilityRan) {
    // --- Check 1: every ticker mentioned must exist in the computed data ----
    const citedTickers = extractTickers(draftReport);
    const unknownTickers = citedTickers.filter((ticker) => !known.tickers.has(ticker));

    if (unknownTickers.length > 0) {
      notes.push(
        `The report mentions ${unknownTickers.map((t) => `"${t}"`).join(", ")}, which ` +
          `${unknownTickers.length === 1 ? "does" : "do"} not appear in the computed data. ` +
          `Only write about companies present in the supplied data.`,
      );
    }

    // --- Check 2: every percentage must trace to a computed value -----------
    const unknownNumbers = citedNumbers.filter((n) => !matchesKnownNumber(n, known.numbers));

    if (unknownNumbers.length > 0) {
      notes.push(
        `The report cites ${unknownNumbers.map((n) => `${n}%`).join(", ")}, which ` +
          `${unknownNumbers.length === 1 ? "does" : "do"} not match any computed figure. ` +
          `Quote only the exact percentages supplied, and do not calculate new ones ` +
          `(no sums, averages, or differences).`,
      );
    }
  }

  // --- Check 3: a report with data available should actually use it ---------
  // Guards the degenerate pass: prose that cites nothing cannot contain a wrong
  // number, so checks 1 and 2 would both trivially succeed on an empty answer.
  const hasData =
    (sectorRankings?.length ?? 0) > 0 ||
    growthAuthenticityRan ||
    (portfolioGrowthResults?.length ?? 0) > 0 ||
    (companySnapshots?.length ?? 0) > 0 ||
    (technicalAnalysis?.length ?? 0) > 0;
  const usedQuantitativeData =
    citedNumbers.length > 0 || (technicalAnalysisRan && citedDollarAmounts.length > 0);
  if (hasData && !usedQuantitativeData) {
    notes.push(
      "The report contains no percentage figures (or, for technical analysis, no " +
        '"$"-prefixed price levels) even though computed data was supplied. Name the ' +
        "specific figures from the DATA block.",
    );
  }

  // --- Check 4: every classification must be narrated (§11.7, §12.6) --------
  // Checks 1-3 confirm the report's NUMBERS are real; this confirms its
  // CONCLUSION(S) match what those numbers were computed to support. Without
  // it, a report could cite entirely real figures while still narrating a
  // different verdict than the computed `classification` — passing every
  // check above while silently overriding the one thing this capability's LLM
  // prompt explicitly forbids it from doing. For portfolio-scan this runs
  // once PER TICKER — each of the N independent verdicts must be stated, not
  // just one of them.
  if (growthAuthenticity !== null) {
    const classificationNote = checkClassificationNarrated(draftReport, growthAuthenticity);
    if (classificationNote !== null) notes.push(classificationNote);
  }
  for (const result of portfolioGrowthResults ?? []) {
    const classificationNote = checkClassificationNarrated(draftReport, result);
    if (classificationNote !== null) notes.push(classificationNote);
  }

  // --- Check 5: the comparative verdict must be narrated (§12.6, §12.8) -----
  // Same "conclusion matches the numbers" reasoning as check 4, applied to
  // the second kind of computed verdict this codebase now produces.
  if (tickerComparison !== null) {
    const comparisonNote = checkComparativeVerdictNarrated(draftReport, tickerComparison);
    if (comparisonNote !== null) notes.push(comparisonNote);
  }

  // --- Check 6: technical-analysis symbol/stance/method-labelling (§14.13) --
  // Three per-symbol checks specific to this capability, plus one batch-wide
  // dollar-figure check (7) below — see each function's own header for why
  // each is necessary beyond checks 1-3 above.
  for (const result of technicalAnalysis ?? []) {
    const symbolNote = checkSymbolNarrated(draftReport, result);
    if (symbolNote !== null) notes.push(symbolNote);

    const stanceNote = checkStanceNarrated(draftReport, result);
    if (stanceNote !== null) notes.push(stanceNote);

    const methodNote = checkBothMethodsLabeled(draftReport, result);
    if (methodNote !== null) notes.push(methodNote);
  }

  // --- Check 7: every cited dollar price traces to a computed level --------
  // The dedicated counterpart to check 2, for the one capability whose
  // headline output is a price a reader could act on directly.
  if (technicalAnalysis !== null) {
    const priceLevelsNote = checkPriceLevelsCited(draftReport, technicalAnalysis);
    if (priceLevelsNote !== null) notes.push(priceLevelsNote);
  }

  const validationPassed = notes.length === 0;

  return {
    validationPassed,
    validationNotes: notes,
    finalReport: validationPassed ? draftReport : null,
  };
}
