/**
 * =============================================================================
 * sector-leaders.ts — weight, speed, and quadrant per sector. DETERMINISTIC.
 * =============================================================================
 *
 * CLAUDE.md §5.4. No LLM, ever (§1, §9).
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE ONE RULE THIS FILE EXISTS TO ENFORCE                                  │
 * │                                                                           │
 * │ §5.4: "Explicitly forbidden in this node: combining weight and speed into │
 * │ a single composite score."  §9 repeats the ban.                           │
 * │                                                                           │
 * │ There is no line in this file that adds, multiplies, or averages          │
 * │ `weightScore` with `speedScore`. They are computed by separate functions, │
 * │ from separate data sources, and thresholded independently. The ONLY place │
 * │ they meet is `classifyQuadrant`, which reads each against its own cutoff  │
 * │ and returns a LABEL — never a number.                                     │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * WHY THE SEPARATION IS LOAD-BEARING RATHER THAN STYLISTIC
 * --------------------------------------------------------
 * The two metrics answer different questions on different timescales:
 *
 *   weightScore — "how much of this sector IS this company?"  Structural,
 *                 slow-moving, sourced from disclosed ETF holdings. NVDA at
 *                 ~12.6% of XLK means XLK mathematically cannot move much
 *                 without NVDA moving.
 *
 *   speedScore  — "how fast is it moving RELATIVE TO ITS PEERS?"  Behavioural,
 *                 fast-moving, z-scored against the sector's own constituent
 *                 distribution.
 *
 * A blended score would rank a 12%-weight/flat stock identically to a
 * 0.3%-weight/exploding one. Those are opposite answers to "who is leading
 * this sector?" — one is the reason the index moved, the other is a signal
 * that has not shown up in the index yet. Collapsing them destroys exactly the
 * distinction the user is asking about.
 *
 * WHY SPEED IS Z-SCORED RATHER THAN RAW
 * -------------------------------------
 * §5.4 requires speed to be "relative to sector peers, not absolute". A +4%
 * month means something very different in Utilities (typically calm) than in
 * Energy (typically volatile). A z-score restates the return as "how many
 * standard deviations from this sector's own mean", so a +4% Utilities move
 * can correctly outrank a +6% Energy move. Without it, the leader lists would
 * simply rediscover which sectors are volatile.
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { AgentState, Quadrant, SectorLeader, SectorRanking } from "../../../state.js";
import { fetchEtfHoldings, type EtfHolding } from "../../../tools/etf-holdings.js";
import {
  SECTOR_ETF_TO_GICS,
  fetchConstituentOhlcv,
  resolveWindowStart,
  type PriceBar,
} from "../../../tools/yahoo-finance.js";
import { selectTrendingSectors } from "./sector-trend.js";
import { emitProgress } from "../../../streaming.js";

// =============================================================================
// SECTION 1 — Tunables
// =============================================================================

/**
 * Percentile cutoff separating "high" from "low" on BOTH axes.
 *
 * §5.4 says to "apply fixed thresholds (e.g., top/bottom tercile) to weight
 * and speed independently". 0.667 implements that literally: the top third of
 * the sector is "high", the remaining two thirds are "low".
 *
 * WHAT THIS CHOICE MEANS IN PRACTICE. It is deliberately demanding. With a
 * tercile cutoff, "high weight" means genuinely top-third-by-size, so in a
 * 70-constituent sector roughly 23 names qualify. A median split (0.5) would
 * instead label half the sector "high weight", which makes `anchor_leader`
 * a much weaker claim — and `anchor_leader` is the label §5.5 tells the report
 * writer to present as "the ones genuinely driving the move".
 *
 * Exported so it can be tuned, and so tests can assert against a known value.
 */
export const QUADRANT_PERCENTILE = 0.667;

/**
 * Upper bound on constituents fetched per sector.
 *
 * A cold run over 6 sectors at ~70 constituents each is ~400 Yahoo calls.
 * Yahoo publishes no rate limit, but §5.2 still says to be a considerate
 * client, and the calls are cached for 24h so this cost is paid once a day.
 *
 * ⚠️ RAISING THIS IS SAFE; LOWERING IT IS NOT NEUTRAL. Constituents are taken
 * heaviest-first, so a low cap truncates the SMALL-weight tail — precisely the
 * companies that can be `emerging_mover`s (§5.8b). When the cap actually
 * truncates a sector, a warning is recorded, because a silently truncated list
 * would let the report claim a sector has no emerging movers when the truth is
 * that we never looked.
 */
export const MAX_CONSTITUENTS_PER_SECTOR = 100;

/** How many constituent price requests may be in flight at once. */
const FETCH_CONCURRENCY = 6;

/** Trailing window for the average-volume baseline, per §5.4. */
const RELATIVE_VOLUME_LOOKBACK_DAYS = 20;

// =============================================================================
// SECTION 2 — Statistics
// =============================================================================

/** Arithmetic mean. Returns 0 for an empty input so callers need no guard. */
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * POPULATION standard deviation (divide by N, not N−1).
 *
 * Population is correct here rather than sample: we hold the ETF's entire
 * disclosed constituent list, so this is the whole population of the sector,
 * not a sample drawn from a larger one. Using N−1 would inflate the spread
 * slightly and shrink every z-score — harmless for ordering, but wrong, and it
 * would make the numbers disagree with any external check.
 */
export function stdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Z-score: how many standard deviations `value` sits from the mean.
 *
 * Returns 0 when the spread is zero — i.e. every constituent moved by the
 * identical amount. That is mathematically undefined (a division by zero), and
 * 0 is the honest answer: with no dispersion, nobody is faster than anybody.
 */
export function zScore(value: number, populationMean: number, populationStdDev: number): number {
  if (populationStdDev === 0 || !Number.isFinite(populationStdDev)) return 0;
  return (value - populationMean) / populationStdDev;
}

/**
 * Percentile of a numeric array, using linear interpolation between the two
 * nearest ranks.
 *
 * Interpolation rather than nearest-rank so the cutoff moves smoothly as
 * constituents are added or removed. With nearest-rank, a sector gaining one
 * holding can jump the threshold onto a different value and reclassify
 * companies that did not themselves change — which would look like a data bug
 * in a report diff.
 *
 * @param p 0..1, e.g. 0.667 for the top-tercile boundary.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;

  const rank = p * (sorted.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = sorted[lowerIndex]!;
  const upper = sorted[upperIndex]!;

  if (lowerIndex === upperIndex) return lower;
  return lower + (upper - lower) * (rank - lowerIndex);
}

// =============================================================================
// SECTION 3 — Quadrant classification
// =============================================================================

/** The two independent cutoffs. Computed once per sector, from that sector's own data. */
export interface QuadrantThresholds {
  /** Weight at or above this is "high weight". In PERCENT, e.g. 3.2 = 3.2%. */
  weightCutoff: number;
  /** Speed z-score at or above this is "high speed". Unitless. */
  speedCutoff: number;
}

/**
 * Derive the two cutoffs from a sector's own constituent distribution.
 *
 * SECTOR-RELATIVE BY DESIGN. The cutoffs are recomputed per sector rather than
 * fixed globally, because sector composition varies enormously: a 3% holding
 * is unremarkable in a concentrated sector like Information Technology and
 * very large in a flat one like Industrials. A single global weight cutoff
 * would classify entire sectors as uniformly "high weight" or uniformly "low".
 */
export function computeThresholds(
  weights: number[],
  speeds: number[],
  p: number = QUADRANT_PERCENTILE,
): QuadrantThresholds {
  return {
    weightCutoff: percentile(weights, p),
    speedCutoff: percentile(speeds, p),
  };
}

/**
 * Assign one of the four quadrants.
 *
 * ⚠️ READ THIS BEFORE CHANGING ANYTHING HERE. The two arguments are compared
 * against their OWN cutoffs and never against each other. There is deliberately
 * no arithmetic combining them — that is §5.4's explicit prohibition, and the
 * separation must survive all the way to the UI (§9).
 *
 *                     high speed              low speed
 *                 ┌──────────────────────┬──────────────────────────┐
 *     high weight │   anchor_leader      │   stable_heavyweight     │
 *                 │   big AND moving —   │   big but not the reason │
 *                 │   the actual cause   │   the sector moved       │
 *                 │   of the sector move │                          │
 *                 ├──────────────────────┼──────────────────────────┤
 *      low weight │   emerging_mover     │   laggard                │
 *                 │   moving hard, too   │   small and slow         │
 *                 │   small to shift the │                          │
 *                 │   index yet —        │                          │
 *                 │   the "early signal" │                          │
 *                 └──────────────────────┴──────────────────────────┘
 *
 * §5.5 consumes these labels directly: name `anchor_leader` companies first
 * because they are what actually moved the sector, then flag `emerging_mover`
 * names as an early-signal callout.
 *
 * Comparisons are `>=` so that a company sitting exactly on the cutoff counts
 * as high. With interpolated percentiles an exact tie is rare, but the choice
 * is made explicitly rather than left to a strict-inequality accident.
 *
 * @param suppressEmergingMover
 *   Set when the holdings list is PARTIAL (Yahoo's top-10 fallback — §5.8b).
 *   See `EMERGING_MOVER_SUPPRESSION` below for why this exists; in short, on a
 *   top-10 list "low weight" is a relative artefact, not a fact about the
 *   company, and emitting `emerging_mover` produces a confident false claim
 *   rather than merely a missing one.
 */
export function classifyQuadrant(
  weightPct: number,
  speedZ: number,
  thresholds: QuadrantThresholds,
  suppressEmergingMover = false,
): Quadrant {
  const isHighWeight = weightPct >= thresholds.weightCutoff;
  const isHighSpeed = speedZ >= thresholds.speedCutoff;

  if (isHighWeight && isHighSpeed) return "anchor_leader";
  if (!isHighWeight && isHighSpeed) {
    // ─────────────────────────────────────────────────────────────────────────
    // EMERGING_MOVER_SUPPRESSION
    //
    // Observed on live XLK data with the Yahoo top-10 fallback: AVGO, the
    // FOURTH-LARGEST holding in the sector at 4.67%, was classified
    // `emerging_mover` — because within a 10-name list the weight cutoff sits
    // at 4.715%, so a top-5 holding reads as "low weight".
    //
    // §5.5 instructs the report writer to present `emerging_mover` companies
    // as an "early signal" — a small company moving before the index notices.
    // For AVGO that is simply false, and it is the kind of false claim that
    // reads as authoritative.
    //
    // A missing signal is honest. A confident wrong one is not. So when the
    // holdings list is known to be partial, this quadrant is not emitted at
    // all and the company falls back to its weight-only classification.
    // ─────────────────────────────────────────────────────────────────────────
    return suppressEmergingMover ? "laggard" : "emerging_mover";
  }
  if (isHighWeight && !isHighSpeed) return "stable_heavyweight";
  return "laggard";
}

/**
 * Today's volume ÷ the trailing 20-day average (§5.4). A SECONDARY
 * confirmation signal — never an input to the quadrant.
 *
 * 1.0 means trading at its usual pace; 2.5 means two and a half times normal,
 * which suggests a price move has genuine participation behind it rather than
 * being a thin-volume drift.
 *
 * @returns the ratio, or `1` (neutral) when there is not enough volume data.
 *          1 rather than 0 because 0 would read as "did not trade at all",
 *          a claim we cannot support from missing data.
 */
export function computeRelativeVolume(bars: PriceBar[]): number {
  const volumes = bars
    .map((bar) => bar.volume)
    .filter((v): v is number => v !== null && v !== undefined && v > 0);

  if (volumes.length < 2) return 1;

  const latest = volumes.at(-1)!;
  // Exclude the latest bar from its own baseline, otherwise a huge volume day
  // inflates the average it is being measured against and understates itself.
  const baseline = volumes.slice(-(RELATIVE_VOLUME_LOOKBACK_DAYS + 1), -1);
  const average = mean(baseline.length > 0 ? baseline : volumes.slice(0, -1));

  if (average <= 0) return 1;
  return latest / average;
}

// =============================================================================
// SECTION 4 — Building one sector's leader list
// =============================================================================

/** A constituent's raw measurements, before z-scoring. */
interface ConstituentMeasurement {
  ticker: string;
  weightPct: number;
  /** Raw % change over the window, or `null` if not speed-rankable. */
  rawPctChange: number | null;
  relativeVolume: number;
}

/**
 * Run an async mapper over `items` with bounded concurrency.
 *
 * A plain `Promise.all` over ~400 constituent fetches would open 400 sockets at
 * once — rude to an unofficial upstream (§5.2) and likely to trigger
 * connection resets that look like data errors. A simple worker pool keeps
 * `FETCH_CONCURRENCY` requests in flight and no more.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Build the leader list for ONE sector.
 *
 * Exported for direct unit testing — this is where the whole §5.4 computation
 * lives, so it is worth exercising without a full graph state around it.
 *
 * @returns the leaders plus any degradation notes for `trendDataErrors`.
 */
export async function buildSectorLeaders(args: {
  sectorName: string;
  etfTicker: string;
  timeWindow: string;
  now: Date;
}): Promise<{ leaders: SectorLeader[]; warnings: string[] }> {
  const { sectorName, etfTicker, timeWindow, now } = args;

  // --- Step 1: WEIGHT, from disclosed holdings (§5.4 authoritative source) ---
  const holdingsResult = await fetchEtfHoldings(etfTicker, sectorName);
  const warnings = [...holdingsResult.warnings];

  if (holdingsResult.holdings.length === 0) {
    return { leaders: [], warnings };
  }

  // Heaviest-first, so a cap truncates the small tail rather than the top.
  let constituents: EtfHolding[] = holdingsResult.holdings;
  if (constituents.length > MAX_CONSTITUENTS_PER_SECTOR) {
    warnings.push(
      `${sectorName}: constituent list truncated from ${constituents.length} to ` +
        `${MAX_CONSTITUENTS_PER_SECTOR} (heaviest first) — the smallest holdings were not ` +
        `analysed, so "emerging_mover" coverage is incomplete for this sector.`,
    );
    constituents = constituents.slice(0, MAX_CONSTITUENTS_PER_SECTOR);
  }

  // --- Step 2: SPEED inputs, from per-constituent price history --------------
  const windowStart = resolveWindowStart(timeWindow, now);

  const measurements = await mapWithConcurrency(
    constituents,
    FETCH_CONCURRENCY,
    async (holding): Promise<ConstituentMeasurement> => {
      try {
        const history = await fetchConstituentOhlcv(holding.ticker, timeWindow, now);

        // §5.7's recent-IPO case. A company listed after the window opened has
        // no return over that window. Detected from `firstTradeDate` on the
        // price response itself, which needs no extra API call.
        const firstTrade = history.meta.firstTradeDate;
        if (firstTrade instanceof Date && firstTrade.getTime() > windowStart.getTime()) {
          warnings.push(
            `${sectorName}: ${holding.ticker} listed ${firstTrade.toISOString().slice(0, 10)}, ` +
              `after the "${timeWindow}" window opened — excluded from speed ranking, ` +
              `weight retained.`,
          );
          return {
            ticker: holding.ticker,
            weightPct: holding.weightPct,
            rawPctChange: null,
            relativeVolume: computeRelativeVolume(history.quotes),
          };
        }

        const prices = history.quotes
          .map((bar) => bar.adjclose ?? bar.close)
          .filter((p): p is number => p !== null && p !== undefined && p > 0);

        if (prices.length < 2) {
          warnings.push(
            `${sectorName}: ${holding.ticker} has insufficient price history over ` +
              `"${timeWindow}" (${prices.length} usable bars) — excluded from speed ranking, ` +
              `weight retained.`,
          );
          return {
            ticker: holding.ticker,
            weightPct: holding.weightPct,
            rawPctChange: null,
            relativeVolume: computeRelativeVolume(history.quotes),
          };
        }

        const first = prices[0]!;
        const last = prices.at(-1)!;

        return {
          ticker: holding.ticker,
          weightPct: holding.weightPct,
          rawPctChange: ((last - first) / first) * 100,
          relativeVolume: computeRelativeVolume(history.quotes),
        };
      } catch (error) {
        // §8: degrade, never crash. The company keeps its weight and drops out
        // of the speed ranking.
        warnings.push(
          `${sectorName}: ${holding.ticker} price fetch failed — ` +
            `${error instanceof Error ? error.message : String(error)}. ` +
            `Excluded from speed ranking, weight retained.`,
        );
        return {
          ticker: holding.ticker,
          weightPct: holding.weightPct,
          rawPctChange: null,
          relativeVolume: 1,
        };
      }
    },
  );

  // --- Step 3: z-score speed against THIS SECTOR's own distribution ---------
  //
  // Only speed-rankable constituents contribute to the mean and standard
  // deviation. Including a partial-window return would drag both, corrupting
  // every OTHER constituent's z-score — the failure is not confined to the one
  // bad row (§5.7).
  const rankableReturns = measurements
    .map((m) => m.rawPctChange)
    .filter((r): r is number => r !== null);

  const sectorMean = mean(rankableReturns);
  const sectorStdDev = stdDev(rankableReturns);

  const speeds = measurements.map((m) =>
    m.rawPctChange === null ? 0 : zScore(m.rawPctChange, sectorMean, sectorStdDev),
  );
  const weights = measurements.map((m) => m.weightPct);

  // --- Step 4: independent thresholds, then classify ------------------------
  //
  // Thresholds are computed from the rankable population only, so that
  // sentinel zeros for excluded companies cannot drag the speed cutoff.
  const rankableSpeeds = measurements
    .map((m, i) => (m.rawPctChange === null ? null : speeds[i]!))
    .filter((s): s is number => s !== null);

  const thresholds = computeThresholds(weights, rankableSpeeds.length > 0 ? rankableSpeeds : [0]);

  // When the holdings list is partial, `emerging_mover` is not merely
  // unreachable — it is actively WRONG, because every name on a top-10 list is
  // a large holding. See EMERGING_MOVER_SUPPRESSION in `classifyQuadrant`.
  const suppressEmergingMover = holdingsResult.isPartial;

  const leaders: SectorLeader[] = measurements.map((m, i) => ({
    ticker: m.ticker,
    weightScore: m.weightPct,
    speedScore: speeds[i]!,
    relativeVolume: m.relativeVolume,
    quadrant: classifyQuadrant(m.weightPct, speeds[i]!, thresholds, suppressEmergingMover),
  }));

  // Only warn when the suppression actually changed something. A blanket note
  // on every degraded sector would be noise; this one names the companies
  // affected, so the reader knows exactly what was withheld and why.
  if (suppressEmergingMover) {
    const affected = measurements
      .filter((m, i) => classifyQuadrant(m.weightPct, speeds[i]!, thresholds) === "emerging_mover")
      .map((m) => m.ticker);

    if (affected.length > 0) {
      warnings.push(
        `${sectorName}: "emerging_mover" suppressed for ${affected.join(", ")} — only the top ` +
          `${measurements.length} holdings were available, so a large holding can appear ` +
          `"low weight" relative to its peers. Reporting these as an early signal would be ` +
          `misleading; classified by weight alone instead.`,
      );
    }
  }

  // §5.4: "sorted by speed score descending within each sector".
  // Ticker is the tiebreak so identical speeds produce a stable, reproducible
  // order rather than depending on fetch completion order.
  leaders.sort((a, b) =>
    b.speedScore !== a.speedScore
      ? b.speedScore - a.speedScore
      : a.ticker < b.ticker
        ? -1
        : a.ticker > b.ticker
          ? 1
          : 0,
  );

  return { leaders, warnings };
}

// =============================================================================
// SECTION 5 — The node
// =============================================================================

/**
 * Compute leader lists for the trending sectors.
 *
 * READS  `sectorRankings`, `timeWindow`, `trendDataErrors`
 * WRITES `sectorLeaders`, `trendDataErrors`
 * NEVER TOUCHES anything else — see the state contract in `./index.ts`.
 *
 * Runs only for the top N up and bottom N down sectors (§5.4), not all 11.
 * Building a leader list costs one holdings fetch plus one price fetch per
 * constituent, and §1's free-tier budget will not absorb that for sectors
 * nobody asked about.
 *
 * MUST run after `sectorTrendNode`, which populates `sectorRankings`.
 */
export async function sectorLeadersNode(
  state: AgentState,
  now: Date = new Date(),
  config?: LangGraphRunnableConfig,
): Promise<Partial<AgentState>> {
  const { sectorRankings, timeWindow } = state;

  // `null` means the trend node did not run; `[]` means it ran and found
  // nothing. Both leave us with no sectors to analyse, but they are different
  // situations and the note says which (see the state.ts comment on this pair).
  if (sectorRankings === null || sectorRankings.length === 0) {
    return {
      sectorLeaders: {},
      trendDataErrors: [
        ...state.trendDataErrors,
        sectorRankings === null
          ? "Sector leaders skipped: sector rankings were never computed."
          : "Sector leaders skipped: no sectors were successfully ranked.",
      ],
    };
  }

  const topNValue = Number(process.env["SECTOR_TREND_TOP_N"] ?? 3);
  const n = Number.isFinite(topNValue) && topNValue > 0 ? Math.floor(topNValue) : 3;
  const trending: SectorRanking[] = selectTrendingSectors(sectorRankings, n);

  const sectorToEtf = new Map(
    Object.entries(SECTOR_ETF_TO_GICS).map(([etf, sector]) => [sector, etf]),
  );

  const sectorLeaders: Record<string, SectorLeader[]> = {};
  const trendDataErrors = [...state.trendDataErrors];

  // Sectors are processed sequentially: each one already fans out internally
  // over its constituents, so running sectors in parallel too would multiply
  // concurrency by 6 and overwhelm the upstream.
  for (const [i, ranking] of trending.entries()) {
    emitProgress(
      config,
      "sector_leaders",
      `Analyzing ${ranking.sector} (${i + 1} of ${trending.length})...`,
    );

    const etfTicker = sectorToEtf.get(ranking.sector);
    if (etfTicker === undefined) {
      trendDataErrors.push(
        `${ranking.sector}: no sector ETF mapping found — cannot compute leaders.`,
      );
      continue;
    }

    try {
      const { leaders, warnings } = await buildSectorLeaders({
        sectorName: ranking.sector,
        etfTicker,
        timeWindow,
        now,
      });

      sectorLeaders[ranking.sector] = leaders;
      trendDataErrors.push(...warnings);
    } catch (error) {
      // §8: one sector failing must not lose the other five.
      trendDataErrors.push(
        `${ranking.sector}: leader analysis failed — ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      sectorLeaders[ranking.sector] = [];
    }
  }

  return { sectorLeaders, trendDataErrors };
}
