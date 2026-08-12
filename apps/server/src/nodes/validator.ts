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
  GrowthAuthenticityResult,
  GrowthClassification,
  SectorLeader,
  SectorRanking,
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
 * READS  `draftReport`, `sectorRankings`, `sectorLeaders`, `growthAuthenticity`,
 *        `retryCount`
 * WRITES `validationPassed`, `validationNotes`, `finalReport`
 * NEVER  calls an LLM or an external API (§9); never modifies the capability
 *        outputs it is checking against.
 *
 * On success it promotes the draft to `finalReport`. On failure it leaves
 * `finalReport` null and writes actionable notes — `graph.ts` reads
 * `validationPassed` to decide whether to loop back to the report writer.
 */
export function validatorNode(
  state: AgentState,
  config?: LangGraphRunnableConfig,
): Partial<AgentState> {
  emitProgress(config, "validator", "Validating report against computed data...");

  const { draftReport, sectorRankings, sectorLeaders, growthAuthenticity } = state;

  if (draftReport === null || draftReport.trim() === "") {
    return {
      validationPassed: false,
      validationNotes: ["No draft report was produced."],
      finalReport: null,
    };
  }

  const industryKnown = collectKnownValues(sectorRankings, sectorLeaders);
  const growthKnown = collectGrowthKnownValues(growthAuthenticity);
  const known: KnownValues = {
    tickers: new Set([...industryKnown.tickers, ...growthKnown.tickers]),
    numbers: [...industryKnown.numbers, ...growthKnown.numbers],
  };
  const notes: string[] = [];

  // Checks 1 and 2 only apply when SOME capability actually ran
  // (`sectorRankings !== null` or `growthAuthenticity !== null` — the
  // null-vs-[] contract documented in `state.ts`). When neither did, there is
  // no computed data for the draft to be making claims against in the first
  // place — most commonly the `general_chat` path, whose free-form reply may
  // legitimately contain an incidental capitalised word or a "%"-looking
  // number. Checking it against an empty known-value set would reject it for
  // citing "unknown" figures it was never claiming were computed data,
  // burning retry budget on a report that was correct.
  const industryTrendRan = sectorRankings !== null;
  const growthAuthenticityRan = growthAuthenticity !== null;
  const anyCapabilityRan = industryTrendRan || growthAuthenticityRan;

  // Hoisted out of the `anyCapabilityRan` branch below because check 3 also
  // needs to know how many percentages were cited, regardless of whether
  // checking them against known values applies.
  const citedNumbers = extractPercentages(draftReport);

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
  const hasData = (sectorRankings?.length ?? 0) > 0 || growthAuthenticityRan;
  if (hasData && citedNumbers.length === 0) {
    notes.push(
      "The report contains no percentage figures even though computed data " +
        "was supplied. Name the specific figures from the DATA block.",
    );
  }

  // --- Check 4: the growth-authenticity classification must be narrated -----
  // Checks 1-3 confirm the report's NUMBERS are real; this confirms its
  // CONCLUSION matches what those numbers were computed to support. Without
  // it, a report could cite entirely real figures while still narrating a
  // different verdict than `growthAuthenticity.classification` — passing
  // every check above while silently overriding the one thing this
  // capability's LLM prompt explicitly forbids it from doing.
  if (growthAuthenticity !== null) {
    const classificationNote = checkClassificationNarrated(draftReport, growthAuthenticity);
    if (classificationNote !== null) notes.push(classificationNote);
  }

  const validationPassed = notes.length === 0;

  return {
    validationPassed,
    validationNotes: notes,
    finalReport: validationPassed ? draftReport : null,
  };
}
