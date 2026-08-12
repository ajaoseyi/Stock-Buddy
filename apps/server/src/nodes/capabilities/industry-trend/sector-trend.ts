/**
 * =============================================================================
 * sector-trend.ts — rank the 11 GICS sectors by performance. DETERMINISTIC.
 * =============================================================================
 *
 * CLAUDE.md §5.3. No LLM is involved at any point in this file, and none may
 * ever be added to it (§1, §9): every number here is computed by code.
 *
 * WHAT IT DOES, IN ORDER
 * ----------------------
 *   1. Fetch daily price history for all 11 SPDR sector ETFs (cached).
 *   2. Compute % change over `timeWindow` for each, mapping ETF → GICS sector.
 *   3. Rank most-positive to most-negative.
 *   4. Cross-check the extremes against Alpha Vantage (§5.8a) and record any
 *      disagreement WITHOUT resolving it.
 *   5. Write `sectorRankings` and any `trendDataErrors`.
 *
 * WHY % CHANGE IS COMPUTED FROM `adjclose` WHERE AVAILABLE
 * -------------------------------------------------------
 * The adjusted close back-adjusts for dividends and splits. Sector ETFs pay
 * quarterly distributions, and on the ex-dividend date the raw close drops by
 * roughly the distribution amount. Over a 3-month window that is a real
 * downward bias of a few tenths of a percent in the raw series — small, but
 * the same order as the cross-check disagreement threshold, so using raw
 * closes would manufacture phantom source disagreements. Utilities and Real
 * Estate, the highest-yielding sectors, would be flagged most often.
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { AgentState, SectorRanking } from "../../../state.js";
import {
  AlphaVantageApiError,
  fetchDailySeries,
  hasQuotaFor,
} from "../../../tools/alpha-vantage.js";
import {
  SECTOR_ETF_TO_GICS,
  fetchSectorEtfHistory,
  resolveWindowStart,
  type PriceBar,
} from "../../../tools/yahoo-finance.js";
import { emitProgress } from "../../../streaming.js";

// =============================================================================
// SECTION 1 — Tunables
// =============================================================================

/**
 * How many sectors from each end get the Alpha Vantage cross-check.
 *
 * Read from the environment so the free-tier cost is adjustable without a code
 * change (§5.8a). 3 → top 3 + bottom 3 → 6 Alpha Vantage calls per cold run,
 * against a 25/day cap.
 */
function topN(): number {
  const raw = Number(process.env["SECTOR_TREND_TOP_N"] ?? 3);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 3;
}

/**
 * How far two sources may differ, in PERCENTAGE POINTS, before it counts as a
 * disagreement (§5.3: "more than a defined threshold" — the spec delegates the
 * number, this is where it is defined).
 *
 * 0.5pp is chosen because Yahoo and Alpha Vantage legitimately differ a little:
 * they may apply different dividend-adjustment conventions and use slightly
 * different session boundaries. A threshold of 0 would flag all 11 sectors
 * every run and make the signal worthless.
 */
function disagreementThreshold(): number {
  const raw = Number(process.env["SECTOR_TREND_DISAGREEMENT_PCT"] ?? 0.5);
  return Number.isFinite(raw) && raw > 0 ? raw : 0.5;
}

// =============================================================================
// SECTION 2 — Pure helpers (exported for direct unit testing)
// =============================================================================

/**
 * Percent change between the first and last usable bar in a series.
 *
 * Prefers `adjclose` over `close` per the header note. Nulls are filtered
 * first: Yahoo genuinely returns them for halted sessions and for the
 * placeholder bar of a session that has not closed yet, and a null at either
 * end would otherwise produce `NaN` and silently poison the ranking.
 *
 * @returns the percent change, or `null` if fewer than two usable bars exist.
 *          `null` rather than 0, because "no data" and "no movement" are
 *          different claims and only one of them is safe to report.
 */
export function computePctChange(bars: PriceBar[]): number | null {
  const usable = bars
    .map((bar) => bar.adjclose ?? bar.close)
    .filter((price): price is number => price !== null && price !== undefined && price > 0);

  if (usable.length < 2) return null;

  const first = usable[0]!;
  const last = usable.at(-1)!;
  return ((last - first) / first) * 100;
}

/**
 * Order sectors most-positive to most-negative.
 *
 * §5.7 requires that a tie must not error and must sort stably. Three
 * comparison keys, applied in order, make the output fully deterministic —
 * which matters because the report writer names "the top sector", and that
 * name must not change between two runs over identical data:
 *
 *   1. `pctChange` descending — the actual ranking.
 *   2. `|pctChange|` descending — §5.7's stated tiebreak. This only bites for
 *      exact ties, where it is a no-op, but it is written out so the rule is
 *      visible rather than implied.
 *   3. sector name ascending — the final backstop. Without it, two sectors at
 *      exactly 0.00% would rely on the input order of an object's keys.
 */
export function rankSectors(rankings: SectorRanking[]): SectorRanking[] {
  return [...rankings].sort((a, b) => {
    if (a.pctChange !== b.pctChange) return b.pctChange - a.pctChange;

    const absDiff = Math.abs(b.pctChange) - Math.abs(a.pctChange);
    if (absDiff !== 0) return absDiff;

    return a.sector < b.sector ? -1 : a.sector > b.sector ? 1 : 0;
  });
}

/**
 * Which sectors are "trending" enough to be worth a cross-check and a leader
 * breakdown: the top N risers and the bottom N fallers (§5.4).
 *
 * Deduplicates by design. With fewer than 2N sectors — or in a degraded run
 * where most ETFs failed to fetch — the two slices overlap, and a sector must
 * not be analysed twice.
 */
export function selectTrendingSectors(ranked: SectorRanking[], n: number): SectorRanking[] {
  const top = ranked.slice(0, n);
  const bottom = ranked.slice(-n);
  const seen = new Set<string>();

  return [...top, ...bottom].filter((ranking) => {
    if (seen.has(ranking.sector)) return false;
    seen.add(ranking.sector);
    return true;
  });
}

// =============================================================================
// SECTION 3 — The node
// =============================================================================

/**
 * Rank the 11 GICS sectors by performance over `state.timeWindow`.
 *
 * READS  `timeWindow`
 * WRITES `sectorRankings`, `trendDataErrors`
 * NEVER TOUCHES anything else — see the state contract in `./index.ts`.
 *
 * Never throws for a data problem. Every per-ETF failure degrades into a
 * `trendDataErrors` entry and the remaining sectors are still ranked (§8: a
 * tool-layer failure must not crash a graph run). A run in which every single
 * fetch failed returns an empty ranking plus 11 error notes, which the report
 * writer can honestly describe as "no data available".
 */
export async function sectorTrendNode(
  state: AgentState,
  now: Date = new Date(),
  config?: LangGraphRunnableConfig,
): Promise<Partial<AgentState>> {
  console.error("DEBUG sectorTrendNode CALLED, activeCapabilities=", state.activeCapabilities);
  const trendDataErrors: string[] = [];
  const { timeWindow } = state;

  // A malformed window is a hard error, not a degradation: §4.1(b) explains
  // why silently defaulting it would produce a confident report about a period
  // the user never asked for.
  let windowStart: Date;
  try {
    windowStart = resolveWindowStart(timeWindow, now);
  } catch (error) {
    return {
      sectorRankings: [],
      trendDataErrors: [
        `Cannot analyse sector trend: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  // --- Step 1 & 2: fetch and compute, one entry per sector ------------------
  //
  // `Promise.allSettled` rather than `Promise.all` is the whole reason a single
  // dead ticker cannot take down the run: `all` rejects on the first failure
  // and discards the 10 successful results alongside it.
  const etfTickers = Object.keys(SECTOR_ETF_TO_GICS);

  emitProgress(
    config,
    "sector_trend",
    `Fetching price history for ${etfTickers.length} sector ETFs...`,
    "data_retrieval",
  );

  const settled = await Promise.allSettled(
    etfTickers.map(async (etf) => {
      const history = await fetchSectorEtfHistory(etf, timeWindow, now);
      return { etf, history };
    }),
  );

  const rankings: SectorRanking[] = [];

  /**
   * The LAST bar date in each sector's Yahoo series, keyed by sector name.
   *
   * ⚠️ THIS EXISTS TO FIX A REAL BUG, not for tidiness. The cross-check must
   * compare the SAME period, and bounding only the start is not enough:
   *
   *   Yahoo (cached, 24h TTL)  2026-07-02 → 2026-07-31   +11.89%
   *   Alpha Vantage "compact"  2026-07-02 → 2026-08-07   + 8.04%
   *
   * Alpha Vantage always returns its last 100 bars up to TODAY, whereas the
   * Yahoo series ends whenever it was fetched. Filtering AV on `>= windowStart`
   * alone therefore measured a LONGER period, and the two figures diverged for
   * a reason that had nothing to do with the providers disagreeing.
   *
   * That is the worst possible failure for this feature: it produced confident
   * "sources disagree" warnings — on 4 of 4 sectors in a live run — that were
   * entirely an artefact of our own window handling. A cross-check that cries
   * wolf is worse than no cross-check, because it trains the reader to ignore
   * a signal that is supposed to mean something.
   *
   * WHY THE FULL BAR SERIES AND NOT JUST ITS END DATE. Clamping AV to Yahoo's
   * end date is STILL not enough, because Alpha Vantage's free tier lags Yahoo
   * by a few trading days:
   *
   *   Yahoo           2026-07-10 → 2026-08-10   +8.03%
   *   Alpha Vantage   2026-07-10 → 2026-08-07   +4.39%
   *                                ^^^^^^^^^^ AV has no bars for the last 3 days
   *
   * An upper clamp does nothing when the other side simply does not HAVE those
   * bars — the comparison spans different periods again, and the gap is once
   * more our artefact rather than a real provider disagreement.
   *
   * So the cross-check recomputes BOTH figures over the INTERSECTION of the two
   * date ranges, which needs the Yahoo bars themselves. The REPORTED
   * `pctChange` is never touched — only the comparison is re-based — so the
   * headline figure still covers the window the user actually asked for.
   */
  const seriesBySector = new Map<string, PriceBar[]>();

  for (const [index, outcome] of settled.entries()) {
    const etf = etfTickers[index]!;
    const sector = SECTOR_ETF_TO_GICS[etf]!;

    if (outcome.status === "rejected") {
      const reason = outcome.reason as unknown;
      trendDataErrors.push(
        `${sector} (${etf}): price history unavailable — ` +
          `${reason instanceof Error ? reason.message : String(reason)}`,
      );
      continue;
    }

    const pctChange = computePctChange(outcome.value.history.quotes);
    if (pctChange === null) {
      trendDataErrors.push(
        `${sector} (${etf}): insufficient price data over "${timeWindow}" ` +
          `(${outcome.value.history.quotes.length} bars) — excluded from ranking.`,
      );
      continue;
    }

    // Keep the primary series so the cross-check can re-base both figures onto
    // the same date range (see `seriesBySector` above).
    seriesBySector.set(sector, outcome.value.history.quotes);

    rankings.push({
      sector,
      pctChange,
      window: timeWindow,
      source: "yahoo_finance",
    });
  }

  emitProgress(
    config,
    "sector_trend",
    `${rankings.length} of ${etfTickers.length} sector ETFs fetched`,
    "data_retrieval",
  );

  // --- Step 3: rank ---------------------------------------------------------
  emitProgress(config, "sector_trend", "Ranking sectors by % change...", "trend_ranking");
  const ranked = rankSectors(rankings);

  // --- Step 4: cross-check the extremes (§5.8a) -----------------------------
  await crossCheckExtremes({ ranked, windowStart, seriesBySector, trendDataErrors, config });

  return { sectorRankings: ranked, trendDataErrors };
}

/**
 * Recompute both providers' percent change over the date range they SHARE.
 *
 * This is what makes the cross-check meaningful. Comparing a figure measured
 * over 2026-07-10..08-10 against one measured over 2026-07-10..08-07 is not a
 * disagreement between providers, it is a disagreement between periods — and
 * on live data that artefact fired on every single cross-checked sector.
 *
 * The overlap is `[max(starts), min(ends)]`, restricted to dates both series
 * actually contain, then each side's own first and last bar inside that range
 * is used. Yahoo's `adjclose` is preferred where present for the same reason
 * the main ranking uses it (dividend adjustment); Alpha Vantage's
 * `TIME_SERIES_DAILY` is unadjusted, which is itself a small source of
 * genuine, reportable divergence.
 *
 * @returns the two comparable figures and the range they cover, or `null` when
 *          the overlap is too small to measure.
 */
export function compareOverOverlap(
  primaryBars: PriceBar[],
  avBars: { date: string; close: number }[],
  windowStart: Date,
): { primaryPct: number; avPct: number; from: string; to: string } | null {
  if (primaryBars.length < 2 || avBars.length < 2) return null;

  const startIso = windowStart.toISOString().slice(0, 10);
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  // Usable primary bars: inside the window and carrying a real price.
  const primary = primaryBars
    .map((b) => ({ date: iso(b.date), price: b.adjclose ?? b.close }))
    .filter((b): b is { date: string; price: number } => b.price !== null && b.price > 0)
    .filter((b) => b.date >= startIso);

  const av = avBars.filter((b) => b.date >= startIso && b.close > 0);
  if (primary.length < 2 || av.length < 2) return null;

  // The shared range: latest start, earliest end.
  const from = primary[0]!.date > av[0]!.date ? primary[0]!.date : av[0]!.date;
  const to = primary.at(-1)!.date < av.at(-1)!.date ? primary.at(-1)!.date : av.at(-1)!.date;
  if (from >= to) return null;

  const pIn = primary.filter((b) => b.date >= from && b.date <= to);
  const aIn = av.filter((b) => b.date >= from && b.date <= to);
  if (pIn.length < 2 || aIn.length < 2) return null;

  return {
    primaryPct: ((pIn.at(-1)!.price - pIn[0]!.price) / pIn[0]!.price) * 100,
    avPct: ((aIn.at(-1)!.close - aIn[0]!.close) / aIn[0]!.close) * 100,
    from,
    to,
  };
}

/**
 * Verify the sectors the report will actually name against a second provider.
 *
 * MUTATES `ranked` in place (upgrading `source` to `"cross_checked"`) and
 * appends to `trendDataErrors`. Both are locals owned by the caller, so this is
 * contained rather than shared mutation.
 *
 * The rule from §5.3, restated because it is the point of the whole exercise:
 * **when the two sources disagree, do not pick one.** Record the discrepancy
 * and leave `source` as `"yahoo_finance"` so the provenance stays honest. A
 * cross-check that silently overwrote the primary would be worse than no
 * cross-check, because it would look authoritative while hiding the conflict.
 */
async function crossCheckExtremes(args: {
  ranked: SectorRanking[];
  windowStart: Date;
  /** Each sector's primary (Yahoo) bars, for re-basing the comparison. */
  seriesBySector: Map<string, PriceBar[]>;
  trendDataErrors: string[];
  config?: LangGraphRunnableConfig | undefined;
}): Promise<void> {
  const { ranked, windowStart, seriesBySector, trendDataErrors, config } = args;
  const candidates = selectTrendingSectors(ranked, topN());

  if (candidates.length === 0) return;

  // Check the budget UP FRONT so the run degrades once, with a single clear
  // note, instead of half-completing and leaving some sectors cross-checked
  // and others silently not (§5.7).
  if (!hasQuotaFor(candidates.length)) {
    trendDataErrors.push(
      `Alpha Vantage cross-check skipped: insufficient daily quota for ${candidates.length} ` +
        `sectors. Rankings are from Yahoo Finance only.`,
    );
    return;
  }

  // Map GICS sector name back to its ETF ticker, since that is what we query.
  const sectorToEtf = new Map(
    Object.entries(SECTOR_ETF_TO_GICS).map(([etf, sector]) => [sector, etf]),
  );

  for (const ranking of candidates) {
    const etf = sectorToEtf.get(ranking.sector);
    if (etf === undefined) continue;

    emitProgress(
      config,
      "sector_trend",
      `Cross-checking ${ranking.sector} against Alpha Vantage...`,
      "trend_ranking",
    );

    try {
      const series = await fetchDailySeries(etf);

      // ─────────────────────────────────────────────────────────────────────
      // RE-BASE BOTH SERIES ONTO THEIR OVERLAPPING DATE RANGE.
      //
      // Two independent misalignments make a naive comparison meaningless, and
      // both were observed live:
      //
      //  1. Alpha Vantage "compact" returns its last 100 bars up to TODAY,
      //     regardless of the window asked about — so it runs PAST the Yahoo
      //     series, which ends whenever it was fetched (up to 24h stale, §6).
      //  2. Alpha Vantage's free tier LAGS Yahoo by a few trading days — so it
      //     can also stop SHORT of the Yahoo series:
      //
      //       Yahoo  2026-07-10 → 2026-08-10  +8.03%
      //       AV     2026-07-10 → 2026-08-07  +4.39%
      //
      // Clamping AV to Yahoo's range fixes (1) but not (2): you cannot clamp
      // your way to bars the provider does not have. So BOTH figures are
      // recomputed over the intersection.
      //
      // The reported `ranking.pctChange` is deliberately NOT modified — it
      // still covers the window the user asked for. Only the comparison is
      // re-based, because a comparison is only meaningful between like periods.
      // ─────────────────────────────────────────────────────────────────────
      const primaryBars = seriesBySector.get(ranking.sector) ?? [];
      const comparison = compareOverOverlap(primaryBars, series, windowStart);

      if (comparison === null) {
        trendDataErrors.push(
          `${ranking.sector} (${etf}): Alpha Vantage returned too few overlapping bars ` +
            `to cross-check; using Yahoo Finance only.`,
        );
        continue;
      }

      const { primaryPct, avPct, from, to } = comparison;
      const gap = Math.abs(avPct - primaryPct);

      if (gap <= disagreementThreshold()) {
        ranking.source = "cross_checked";
      } else {
        trendDataErrors.push(
          `${ranking.sector} (${etf}): sources disagree over ${from}..${to} — ` +
            `Yahoo ${primaryPct.toFixed(2)}% vs Alpha Vantage ${avPct.toFixed(2)}% ` +
            `(gap ${gap.toFixed(2)}pp, threshold ${disagreementThreshold()}pp). ` +
            `Reporting the Yahoo figure for the full window; treat with caution.`,
        );
      }
    } catch (error) {
      // §5.7: quota exhaustion falls back to Yahoo-only with a note rather than
      // failing the capability. Stop trying once the budget is gone — further
      // attempts would just be 5 more wasted calls.
      if (error instanceof AlphaVantageApiError && error.isRateLimit) {
        trendDataErrors.push(
          `Alpha Vantage quota exhausted during cross-check; remaining sectors use ` +
            `Yahoo Finance only. (${error.message})`,
        );
        return;
      }

      trendDataErrors.push(
        `${ranking.sector} (${etf}): cross-check unavailable — ` +
          `${error instanceof Error ? error.message : String(error)}. Using Yahoo Finance only.`,
      );
    }
  }
}
