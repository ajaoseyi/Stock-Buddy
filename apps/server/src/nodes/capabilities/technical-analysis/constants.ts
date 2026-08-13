/**
 * =============================================================================
 * constants.ts — every tunable constant for the technical-analysis capability.
 * =============================================================================
 *
 * ALL VALUES BELOW ARE PLACEHOLDERS pending live calibration
 * (`scripts/calibrate-technical-analysis.ts`), the same status
 * `QUADRANT_PERCENTILE` and `CLEAR_LEAD_THRESHOLD` had before their own
 * capabilities were run against real data (CLAUDE.md §5.9a, §12.8). Textbook
 * defaults, not yet checked against real bar counts or real price levels from
 * this codebase's actual Yahoo fetchers. See CLAUDE.md §14's resolved-notes
 * section once that script has been run.
 */

// -----------------------------------------------------------------------------
// Indicator periods — industry-standard defaults.
// -----------------------------------------------------------------------------

export const SMA_SHORT_PERIOD = 20;
export const SMA_MEDIUM_PERIOD = 50;
export const SMA_LONG_PERIOD = 200;
export const EMA_FAST_PERIOD = 12;
export const EMA_SLOW_PERIOD = 26;
export const MACD_SIGNAL_PERIOD = 9;
export const RSI_PERIOD = 14;
export const ATR_PERIOD = 14;
export const BOLLINGER_PERIOD = 20;
export const BOLLINGER_STDDEV_MULTIPLE = 2;

/** RSI at or above this counts as `"overbought"`. Textbook default — PLACEHOLDER. */
export const RSI_OVERBOUGHT = 70;
/** RSI at or below this counts as `"oversold"`. Textbook default — PLACEHOLDER. */
export const RSI_OVERSOLD = 30;

/**
 * How far back to fetch bars, INDEPENDENT of `state.timeWindow`.
 *
 * `timeWindow` decides what period a REPORTED % change covers (§5.3-style,
 * elsewhere in this codebase) — it has no bearing on how much history this
 * capability's indicators need internally. SMA200 needs ~200 TRADING days
 * (~285 calendar days including weekends/holidays); "2y" leaves comfortable
 * margin for ATR/RSI/EMA seeding too, so no indicator sits right at the edge
 * of the fetched window. PLACEHOLDER — not yet checked against a real bar
 * count from `fetchConstituentOhlcv`.
 */
export const INDICATOR_LOOKBACK_WINDOW = "2y";

/** Below this many bars, `sma200` alone degrades to `null` — not the whole snapshot. */
export const MIN_BARS_FOR_SMA200 = 210;
/** Below this many bars, the ENTIRE indicator snapshot is `insufficient_data` (recent-IPO-style edge case, mirrors §5.7's `firstTradeDate` check). */
export const MIN_BARS_FOR_INDICATORS = 30;

// -----------------------------------------------------------------------------
// Swing detection / support-resistance clustering.
// -----------------------------------------------------------------------------

/** Fractal lookback: a bar must be the local extreme across this many bars on EACH side to count as a swing point. PLACEHOLDER. */
export const SWING_LOOKBACK_BARS = 5;
/** Relative price distance (%) within which two swing points merge into one level. PLACEHOLDER. */
export const SR_CLUSTER_TOLERANCE_PCT = 1.0;
/** Cap on how many support/resistance levels are kept per side, nearest-first. */
export const MAX_LEVELS_PER_SIDE = 5;

// -----------------------------------------------------------------------------
// Trade-level formulas (CLAUDE.md §14.6 — single documented formulas over
// already-computed values, not a §9 blend; see that section before changing
// the shape of these, not just the numbers).
// -----------------------------------------------------------------------------

/** Stop distance from the reference support/resistance level, in ATR multiples. PLACEHOLDER. */
export const ATR_STOP_MULTIPLE = 1.5;
/** Take-profit distance as a multiple of the entry-to-stop distance. PLACEHOLDER. */
export const ATR_RISK_REWARD_MULTIPLE = 2;
/** Swing-method stop buffer beyond the nearest raw swing point, as a percent of price. PLACEHOLDER. */
export const SWING_STOP_BUFFER_PCT = 0.5;

// -----------------------------------------------------------------------------
// Volatility classification — reuses `lib/stats.ts`'s existing robust z-score
// infrastructure (`robustZScore`/its own `MIN_BASELINE_QUARTERS`) rather than
// inventing a parallel one; this constant is only the threshold applied to it.
// -----------------------------------------------------------------------------

/** |z| of (ATR / price) vs. its own trailing history at or beyond this counts as "high"/"low" rather than "normal". PLACEHOLDER. */
export const VOLATILITY_Z_THRESHOLD = 1;
/** How many trailing (ATR/price) ratio points feed the volatility baseline, at most. */
export const VOLATILITY_BASELINE_LOOKBACK = 60;
/** Below this many trailing points, the volatility baseline is not trusted — reuses `lib/stats.ts::robustZScore`'s own minSamples parameter. */
export const VOLATILITY_MIN_BASELINE_POINTS = 20;

// -----------------------------------------------------------------------------
// Scope.
// -----------------------------------------------------------------------------

/** Own constant, not shared with the other `*_TICKER_CAP`s — CLAUDE.md §3's containment rule. */
export const TECHNICAL_ANALYSIS_TICKER_CAP = 5;
