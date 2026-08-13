/**
 * =============================================================================
 * indicator-snapshot.ts — run the shared math library over fetched bars.
 * DETERMINISTIC, no LLM.
 * =============================================================================
 *
 * Extracts closes/highs/lows from `PriceBar[]` (using `adjclose ?? close`, the
 * same convention `sector-leaders.ts` already uses for price-return math) and
 * runs every function in `lib/technical-indicators.ts`, keeping only the LAST
 * value of each series — "as of the latest bar".
 *
 * DEGRADES PER-FIELD, NOT AS A WHOLE OBJECT. `sma200` needs far more history
 * than `rsi14`; on a bar set long enough for RSI/EMA/ATR but short of
 * `MIN_BARS_FOR_SMA200`, `sma200` alone is `null` while the rest resolve —
 * mirrors `CompanyProfileFacts`'s per-field-null convention (CLAUDE.md §13.3)
 * rather than an all-or-nothing object. The caller (`technical-analysis-
 * scan.ts`) separately gates the WHOLE snapshot on `MIN_BARS_FOR_INDICATORS`
 * for the recent-IPO-style case where there is barely any history at all.
 */

import type { PriceBar } from "../../../tools/yahoo-finance.js";
import type { IndicatorSnapshot } from "../../../state.js";
import { atr, bollingerBands, ema, macd, rsi, sma } from "../../../lib/technical-indicators.js";
import {
  ATR_PERIOD,
  BOLLINGER_PERIOD,
  BOLLINGER_STDDEV_MULTIPLE,
  EMA_FAST_PERIOD,
  EMA_SLOW_PERIOD,
  MACD_SIGNAL_PERIOD,
  MIN_BARS_FOR_SMA200,
  RSI_PERIOD,
  SMA_LONG_PERIOD,
  SMA_MEDIUM_PERIOD,
  SMA_SHORT_PERIOD,
} from "./constants.js";

function last<T>(values: (T | null)[]): T | null {
  return values.length === 0 ? null : (values.at(-1) ?? null);
}

/**
 * Bars with any of the three price fields missing cannot feed indicator math
 * at all — dropped, not zero-filled. Exported: `market-context.ts` and
 * `support-resistance.ts` need the identically-filtered bar set (for the
 * volatility history series and swing detection respectively) and must never
 * develop their own, slightly different filter.
 */
export function usableBars(bars: PriceBar[]): { date: Date; high: number; low: number; close: number }[] {
  return bars
    .filter(
      (b): b is PriceBar & { high: number; low: number; close: number } =>
        b.high !== null && b.low !== null && b.close !== null,
    )
    .map((b) => ({ date: b.date, high: b.high, low: b.low, close: b.adjclose ?? b.close }));
}

export function computeIndicatorSnapshot(bars: PriceBar[]): IndicatorSnapshot {
  const usable = usableBars(bars);
  const closes = usable.map((b) => b.close);

  const rawSma200 = last(sma(closes, SMA_LONG_PERIOD));
  const { macdLine, signalLine, histogram } = macd(
    closes,
    EMA_FAST_PERIOD,
    EMA_SLOW_PERIOD,
    MACD_SIGNAL_PERIOD,
  );
  const { middle, upper, lower } = bollingerBands(closes, BOLLINGER_PERIOD, BOLLINGER_STDDEV_MULTIPLE);

  return {
    sma20: last(sma(closes, SMA_SHORT_PERIOD)),
    sma50: last(sma(closes, SMA_MEDIUM_PERIOD)),
    // Per-field degrade beyond what `sma()` alone provides — see file header.
    sma200: usable.length >= MIN_BARS_FOR_SMA200 ? rawSma200 : null,
    ema12: last(ema(closes, EMA_FAST_PERIOD)),
    ema26: last(ema(closes, EMA_SLOW_PERIOD)),
    rsi14: last(rsi(closes, RSI_PERIOD)),
    macd: {
      macdLine: last(macdLine),
      signalLine: last(signalLine),
      histogram: last(histogram),
    },
    atr14: last(atr(usable, ATR_PERIOD)),
    bollinger: {
      middle: last(middle),
      upper: last(upper),
      lower: last(lower),
    },
    latestClose: closes.at(-1) ?? null,
    asOfDate: usable.at(-1)?.date.toISOString().slice(0, 10) ?? null,
  };
}
