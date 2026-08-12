/**
 * Fixture capture script — RUN MANUALLY, NEVER FROM THE TEST SUITE.
 *
 * CLAUDE.md §8 requires fixture-based tests with no live network calls. This
 * script is how those fixtures come into existence: it makes ONE real call per
 * endpoint and writes the raw response to disk. From then on the test suite
 * mocks against these files and never touches the network again.
 *
 * Re-run only when a provider's response shape is believed to have changed.
 * Each run costs real free-tier quota — the Alpha Vantage captures in
 * particular consume 1 of 25 daily calls each.
 *
 *     node tests/fixtures/capture.mjs yahoo
 *     node tests/fixtures/capture.mjs alpha-vantage   # needs ALPHA_VANTAGE_API_KEY
 *     node tests/fixtures/capture.mjs finnhub         # needs FINNHUB_API_KEY
 *     node tests/fixtures/capture.mjs growth-authenticity   # no key required
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YahooFinance from "yahoo-finance2";

const HERE = dirname(fileURLToPath(import.meta.url));
const which = process.argv[2] ?? "yahoo";

function save(name, data) {
  const path = join(HERE, `${name}.json`);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
  const size = JSON.stringify(data).length;
  console.log(`  wrote ${name}.json (${size.toLocaleString()} bytes)`);
}

// -----------------------------------------------------------------------------
if (which === "yahoo") {
  const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

  // A fixed period1 keeps the fixture deterministic and re-capturable.
  const period1 = new Date("2026-05-01T00:00:00Z");

  console.log("Capturing Yahoo fixtures (no API key required)...");

  // 1. A sector ETF — drives sector-trend.ts.
  const xlk = await yf.chart("XLK", { period1, interval: "1d" });
  save("yahoo-chart-xlk", xlk);

  // 2. A second sector ETF, so cross-sector ranking can be tested with two
  //    genuinely different real series.
  const xle = await yf.chart("XLE", { period1, interval: "1d" });
  save("yahoo-chart-xle", xle);

  // 3. A constituent — drives the speed score in sector-leaders.ts.
  const nvda = await yf.chart("NVDA", { period1, interval: "1d" });
  save("yahoo-chart-nvda", nvda);

  // 4. Fund holdings (top 10 only — see the caveat in yahoo-finance.ts).
  const holdings = await yf.quoteSummary("XLK", { modules: ["topHoldings"] });
  save("yahoo-topholdings-xlk", holdings.topHoldings);

  console.log("Done.");
}

// -----------------------------------------------------------------------------
if (which === "growth-authenticity") {
  const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

  // Two real tickers used to calibrate the growth-authenticity capability's
  // thresholds against live data (CLAUDE.md §11.9) — an M&A/commodity case
  // (APA, energy, merged with Callon Petroleum in 2024) and an organic-growth
  // case (COST). `period1` is deliberately far back (2018) — live calibration
  // found `fundamentalsTimeSeries` returns a FIXED ~5 usable quarters no
  // matter how far back it's asked to look, so this fixture captures exactly
  // what the app actually receives, not what was assumed at design time.
  const period1 = new Date("2018-01-01T00:00:00Z");
  const now = new Date();

  console.log("Capturing growth-authenticity fixtures (no API key required)...");

  for (const ticker of ["apa", "cost"]) {
    const symbol = ticker.toUpperCase();

    const financials = await yf.fundamentalsTimeSeries(symbol, {
      type: "quarterly",
      module: "financials",
      period1,
      period2: now,
    });
    save(`yahoo-fundamentals-financials-${ticker}`, financials);

    const balanceSheet = await yf.fundamentalsTimeSeries(symbol, {
      type: "quarterly",
      module: "balance-sheet",
      period1,
      period2: now,
    });
    save(`yahoo-fundamentals-balance-sheet-${ticker}`, balanceSheet);

    const chart1y = await yf.chart(symbol, { period1: new Date("2025-05-01"), interval: "1d" });
    save(`yahoo-chart-${ticker}-1y`, chart1y);

    const chart5y = await yf.chart(symbol, { period1: new Date("2021-05-01"), interval: "1d" });
    save(`yahoo-chart-${ticker}-5y`, chart5y);

    const profile = await yf.quoteSummary(symbol, { modules: ["assetProfile"] });
    save(`yahoo-assetprofile-${ticker}`, profile.assetProfile ?? {});
  }

  console.log("Done.");
}

// -----------------------------------------------------------------------------
if (which === "alpha-vantage") {
  const key = process.env.ALPHA_VANTAGE_API_KEY;
  if (!key) throw new Error("ALPHA_VANTAGE_API_KEY not set — cannot capture.");

  console.log("Capturing Alpha Vantage fixtures (uses real daily quota)...");

  const etfProfile = await fetch(
    `https://www.alphavantage.co/query?function=ETF_PROFILE&symbol=XLK&apikey=${key}`,
  ).then((r) => r.json());
  save("alpha-vantage-etf-profile-xlk", etfProfile);

  const daily = await fetch(
    `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=XLK&outputsize=compact&apikey=${key}`,
  ).then((r) => r.json());
  save("alpha-vantage-daily-xlk", daily);

  console.log("Done.");
}

// -----------------------------------------------------------------------------
if (which === "finnhub") {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) throw new Error("FINNHUB_API_KEY not set — cannot capture.");

  console.log("Capturing Finnhub fixtures...");

  const profile = await fetch(
    `https://finnhub.io/api/v1/stock/profile2?symbol=NVDA&token=${key}`,
  ).then((r) => r.json());
  save("finnhub-profile2-nvda", profile);

  console.log("Done.");
}
