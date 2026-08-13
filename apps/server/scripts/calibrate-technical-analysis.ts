/**
 * =============================================================================
 * calibrate-technical-analysis.ts — RUN MANUALLY, NEVER FROM THE TEST SUITE.
 * =============================================================================
 *
 * Same category as `calibrate-growth-authenticity.ts`: drives the ACTUAL
 * shipped node pipeline (`technicalAnalysisScanNode`) against live data, so
 * the placeholder constants in
 * `nodes/capabilities/technical-analysis/constants.ts`
 * (ATR_STOP_MULTIPLE, ATR_RISK_REWARD_MULTIPLE, RSI_OVERBOUGHT/OVERSOLD,
 * SWING_LOOKBACK_BARS, SR_CLUSTER_TOLERANCE_PCT, VOLATILITY_Z_THRESHOLD,
 * INDICATOR_LOOKBACK_WINDOW) can be checked against real output before
 * CLAUDE.md §14's resolved-notes section is filled in — the same discipline
 * §5.8/§5.9/§11.9 already establish for every other capability's thresholds.
 *
 * Zero Alpha Vantage spend — this capability reuses the industry-trend
 * capability's Yahoo OHLCV fetchers verbatim, so running this script costs
 * nothing against that 25/day quota.
 *
 *     npx tsx scripts/calibrate-technical-analysis.ts NVDA COST
 *     npx tsx scripts/calibrate-technical-analysis.ts sector:"Information Technology"
 */

import { AgentStateSchema, type AgentState } from "../src/state.js";
import { technicalAnalysisScanNode } from "../src/nodes/capabilities/technical-analysis/technical-analysis-scan.js";
import {
  ATR_RISK_REWARD_MULTIPLE,
  ATR_STOP_MULTIPLE,
  INDICATOR_LOOKBACK_WINDOW,
  MIN_BARS_FOR_INDICATORS,
  MIN_BARS_FOR_SMA200,
  RSI_OVERBOUGHT,
  RSI_OVERSOLD,
  SR_CLUSTER_TOLERANCE_PCT,
  SWING_LOOKBACK_BARS,
  SWING_STOP_BUFFER_PCT,
  VOLATILITY_Z_THRESHOLD,
} from "../src/nodes/capabilities/technical-analysis/constants.js";

function round(n: number | null, places = 2): number | null {
  if (n === null) return null;
  const factor = 10 ** places;
  return Math.round(n * factor) / factor;
}

async function calibrate(tickers: string[], sectors: string[]): Promise<void> {
  const label = [...tickers, ...sectors].join(", ");
  console.log(`\n${"=".repeat(70)}\n${label}\n${"=".repeat(70)}`);

  const state: AgentState = AgentStateSchema.parse({
    messages: [],
    tickers,
    sectors,
    intent: "technical_analysis",
    timeWindow: "3mo",
    activeCapabilities: ["technical_analysis"],
  }) as AgentState;

  const result = await technicalAnalysisScanNode(state, new Date());

  for (const r of result.technicalAnalysis ?? []) {
    console.log(`\n-- ${r.symbol} (${r.requestedAs}${r.sectorName ? `, ${r.sectorName}` : ""}) --`);
    console.log(`asOfDate: ${r.indicators.asOfDate}, latestClose: ${r.indicators.latestClose}`);
    console.log(
      `sma20=${round(r.indicators.sma20)} sma50=${round(r.indicators.sma50)} ` +
        `sma200=${round(r.indicators.sma200)} rsi14=${round(r.indicators.rsi14)} ` +
        `atr14=${round(r.indicators.atr14)}`,
    );
    console.log(
      `macd=${round(r.indicators.macd.macdLine)} signal=${round(r.indicators.macd.signalLine)} ` +
        `histogram=${round(r.indicators.macd.histogram)}`,
    );
    console.log(
      `bollinger: lower=${round(r.indicators.bollinger.lower)} middle=${round(r.indicators.bollinger.middle)} ` +
        `upper=${round(r.indicators.bollinger.upper)}`,
    );
    console.log(`trend=${r.trendDirection} momentum=${r.momentumDirection} volatility=${r.volatilityLevel}`);
    console.log(
      `support levels: ${r.supportLevels.map((l) => `$${round(l.price)}(${l.touches})`).join(", ") || "none"}`,
    );
    console.log(
      `resistance levels: ${r.resistanceLevels.map((l) => `$${round(l.price)}(${l.touches})`).join(", ") || "none"}`,
    );
    console.log(`STANCE: ${r.stance} [${r.stanceReasonCodes.join(", ")}]`);
    console.log(
      `ATR-based:   entry=${round(r.atrLevels.entry)} stop=${round(r.atrLevels.stopLoss)} ` +
        `target=${round(r.atrLevels.takeProfit)} — ${r.atrLevels.basisNote}`,
    );
    console.log(
      `Swing-based: entry=${round(r.swingLevels.entry)} stop=${round(r.swingLevels.stopLoss)} ` +
        `target=${round(r.swingLevels.takeProfit)} — ${r.swingLevels.basisNote}`,
    );
  }

  if ((result.technicalAnalysisErrors?.length ?? 0) > 0) {
    console.log("\n-- technicalAnalysisErrors --");
    for (const e of result.technicalAnalysisErrors!) console.log(`  - ${e}`);
  }
}

async function main(): Promise<void> {
  console.log(
    `Calibrating with INDICATOR_LOOKBACK_WINDOW=${INDICATOR_LOOKBACK_WINDOW} ` +
      `MIN_BARS_FOR_INDICATORS=${MIN_BARS_FOR_INDICATORS} MIN_BARS_FOR_SMA200=${MIN_BARS_FOR_SMA200} ` +
      `RSI_OVERBOUGHT=${RSI_OVERBOUGHT} RSI_OVERSOLD=${RSI_OVERSOLD} ` +
      `SWING_LOOKBACK_BARS=${SWING_LOOKBACK_BARS} SR_CLUSTER_TOLERANCE_PCT=${SR_CLUSTER_TOLERANCE_PCT} ` +
      `ATR_STOP_MULTIPLE=${ATR_STOP_MULTIPLE} ATR_RISK_REWARD_MULTIPLE=${ATR_RISK_REWARD_MULTIPLE} ` +
      `SWING_STOP_BUFFER_PCT=${SWING_STOP_BUFFER_PCT} VOLATILITY_Z_THRESHOLD=${VOLATILITY_Z_THRESHOLD}`,
  );

  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error(
      'Usage: npx tsx scripts/calibrate-technical-analysis.ts TICKER [TICKER...] | sector:"Sector Name"',
    );
    process.exit(1);
  }

  // Each arg calibrated independently, so a ticker's cap doesn't swallow a
  // sector arg passed in the same invocation (this capability treats tickers
  // and sectors in the SAME request as ticker-priority — §14.3 — so testing
  // both in one process means separate calls, one per arg).
  for (const arg of args) {
    if (arg.toLowerCase().startsWith("sector:")) {
      await calibrate([], [arg.slice("sector:".length)]);
    } else {
      await calibrate([arg.toUpperCase()], []);
    }
  }
}

await main();
