/**
 * =============================================================================
 * inorganic-signal.ts — balance-sheet evidence of M&A-driven growth. DETERMINISTIC.
 * =============================================================================
 *
 * Third node in the growth-authenticity pipeline (see ./index.ts). No LLM,
 * ever (§1, §9).
 *
 * GOODWILL IS THE PRIMARY SIGNAL, PP&E IS ONLY CORROBORATING
 * -------------------------------------------------------------
 * Goodwill only moves materially through M&A purchase accounting — an
 * acquisition creates it on the balance sheet immediately. PP&E also moves
 * from ordinary organic capex (building a new plant is real investment, not
 * "inorganic"), so treating a PP&E jump as equally diagnostic as a goodwill
 * jump would misclassify a company that is simply expanding. PP&E therefore
 * only counts alongside a simultaneous cash decrease — the pattern the
 * original feedback described (funding a purchase by drawing down cash).
 *
 * QoQ, NOT YoY
 * -------------
 * An M&A-driven balance-sheet jump shows up in the NEXT reported quarter, not
 * a year later — unlike revenue growth (revenue-growth.ts), which is
 * genuinely seasonal and needs a YoY comparison.
 *
 * OWN-HISTORY BASELINE, NOT A FLAT PERCENTAGE
 * ---------------------------------------------
 * A flat "PP&E jump >= 20%" cutoff misfires in both directions: it's a routine
 * false positive for asset-heavy sectors (energy, utilities — exactly the
 * APA-shaped case that motivated this capability) with large regular capex
 * swings, and too loose to ever catch anything for asset-light companies whose
 * normal PP&E movement is near zero. Each of goodwill/PP&E/cash is instead
 * z-scored (robust median/MAD, see ./stats.ts) against THIS company's own
 * trailing QoQ deltas.
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { AgentState, InorganicSignalResult, Trend } from "../../../state.js";
import { emitProgress } from "../../../streaming.js";
import {
  fetchQuarterlyBalanceSheet,
  type QuarterlyBalanceSheetRow,
} from "../../../tools/yahoo-finance.js";
import { ROBUST_Z_THRESHOLD, robustZScore } from "./stats.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Tolerance band, in days, for matching "the immediately preceding quarter". */
export const QOQ_TOLERANCE_DAYS_MIN = 75;
export const QOQ_TOLERANCE_DAYS_MAX = 110;

/** |deltaPct| below this counts as "flat" rather than a real trend, to avoid labelling noise. */
const FLAT_DEAD_ZONE_PCT = 2;

const INSUFFICIENT_TREND: Trend = {
  deltaPct: null,
  zScore: null,
  baselineQuarterCount: 0,
  direction: "insufficient_data",
};

interface DatedValue {
  date: Date;
  value: number;
}

/** Extract one numeric field from balance-sheet rows, sorted oldest to newest. */
export function extractField(
  rows: QuarterlyBalanceSheetRow[],
  field: "goodwill" | "netPPE" | "cashAndCashEquivalents",
): DatedValue[] {
  return rows
    .filter(
      (r): r is QuarterlyBalanceSheetRow & Record<typeof field, number> => r[field] !== undefined,
    )
    .map((r) => ({ date: r.date, value: r[field]! }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

/** Find the immediately preceding quarter, within tolerance. Mirrors `findYoyPriorRow`. */
function findPriorQuarter(rows: DatedValue[], atIndex: number): DatedValue | null {
  const anchor = rows[atIndex];
  if (anchor === undefined) return null;

  for (let i = atIndex - 1; i >= 0; i--) {
    const candidate = rows[i]!;
    const diffDays = (anchor.date.getTime() - candidate.date.getTime()) / MS_PER_DAY;
    if (diffDays > QOQ_TOLERANCE_DAYS_MAX) return null;
    if (diffDays >= QOQ_TOLERANCE_DAYS_MIN) return candidate;
  }
  return null;
}

/**
 * Compute the latest QoQ trend for one field, z-scored against the company's
 * own trailing history of QoQ deltas.
 *
 * Exported for direct unit testing.
 */
export function computeTrend(rows: DatedValue[]): Trend {
  if (rows.length === 0) return INSUFFICIENT_TREND;

  const latestIndex = rows.length - 1;
  const latest = rows[latestIndex]!;
  const prior = findPriorQuarter(rows, latestIndex);

  if (prior === null || prior.value === 0) return INSUFFICIENT_TREND;

  const deltaPct = ((latest.value - prior.value) / Math.abs(prior.value)) * 100;

  // Historical QoQ deltas, EXCLUDING the current (latest) quarter — that one
  // is the point being tested, not part of its own baseline.
  const historicalDeltas: number[] = [];
  for (let i = 1; i < latestIndex; i++) {
    const p = findPriorQuarter(rows, i);
    if (p === null || p.value === 0) continue;
    historicalDeltas.push(((rows[i]!.value - p.value) / Math.abs(p.value)) * 100);
  }

  const zScore = robustZScore(historicalDeltas, deltaPct);
  const direction: Trend["direction"] =
    Math.abs(deltaPct) < FLAT_DEAD_ZONE_PCT ? "flat" : deltaPct > 0 ? "increasing" : "decreasing";

  return { deltaPct, zScore, baselineQuarterCount: historicalDeltas.length, direction };
}

/**
 * Classify the M&A signal from the three trends. Pure decision table — never
 * an arithmetic blend of goodwill/PP&E/cash.
 *
 * Exported for direct unit testing.
 */
export function classifyInorganicSignal(
  goodwillTrend: Trend,
  ppeTrend: Trend,
  cashTrend: Trend,
): InorganicSignalResult["inorganicSignal"] {
  if (
    goodwillTrend.direction === "insufficient_data" &&
    ppeTrend.direction === "insufficient_data"
  ) {
    return "insufficient_data";
  }

  const goodwillJump = goodwillTrend.zScore !== null && goodwillTrend.zScore >= ROBUST_Z_THRESHOLD;
  if (goodwillJump) return "likely_ma_driven";

  const ppeJump = ppeTrend.zScore !== null && ppeTrend.zScore >= ROBUST_Z_THRESHOLD;
  const cashDecreasing = cashTrend.direction === "decreasing";
  if (ppeJump && cashDecreasing) return "likely_ma_driven";

  return "no_signal";
}

/**
 * READS  `tickers`
 * WRITES `inorganicSignal`, `growthCheckErrors`
 * NEVER TOUCHES anything else — see the state contract in `./index.ts`.
 *
 * Never throws. A fetch failure degrades into `growthCheckErrors` plus an
 * `insufficient_data` result rather than crashing the graph (§8).
 */
export async function inorganicSignalNode(
  state: AgentState,
  now: Date = new Date(),
  config?: LangGraphRunnableConfig,
): Promise<Partial<AgentState>> {
  const growthCheckErrors = [...state.growthCheckErrors];
  const ticker = state.tickers[0];

  if (ticker === undefined) {
    return { inorganicSignal: null, growthCheckErrors };
  }

  emitProgress(config, "inorganic_signal", `Checking ${ticker}'s balance sheet for M&A signals...`);

  let rows: QuarterlyBalanceSheetRow[];
  try {
    rows = await fetchQuarterlyBalanceSheet(ticker, now);
  } catch (error) {
    growthCheckErrors.push(
      `${ticker}: quarterly balance sheet unavailable — ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      inorganicSignal: {
        goodwillTrend: INSUFFICIENT_TREND,
        ppeTrend: INSUFFICIENT_TREND,
        cashTrend: INSUFFICIENT_TREND,
        inorganicSignal: "insufficient_data",
      },
      growthCheckErrors,
    };
  }

  const goodwillTrend = computeTrend(extractField(rows, "goodwill"));
  const ppeTrend = computeTrend(extractField(rows, "netPPE"));
  const cashTrend = computeTrend(extractField(rows, "cashAndCashEquivalents"));
  const inorganicSignal = classifyInorganicSignal(goodwillTrend, ppeTrend, cashTrend);

  if (inorganicSignal === "insufficient_data") {
    growthCheckErrors.push(
      `${ticker}: insufficient quarterly balance-sheet history for goodwill/PP&E trend analysis ` +
        `(${rows.length} rows returned).`,
    );
  }

  return {
    inorganicSignal: { goodwillTrend, ppeTrend, cashTrend, inorganicSignal },
    growthCheckErrors,
  };
}
