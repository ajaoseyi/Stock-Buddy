# CLAUDE.md — Smart Financial Solutions agent

This file is the standing context for any Claude Code session working on this repo. Read it fully before writing code. It governs architecture decisions, coding conventions, and the spec for the first fully-formed capability.

---

## 1. Project overview

A LangGraph-based financial AI agent, built entirely in **TypeScript**. It is built as a **capability-plugin architecture**: the graph has a fixed core (shared state, supervisor, report writer, validator) and each analytical capability is a self-contained set of deterministic nodes that plug into that core. Today there is exactly one fully-specified capability — **industry trend and sector-leader analysis** — described in full in Section 5. More capabilities will be added later as separate, independently-specified units; do not build speculative support for capabilities that don't exist yet, but do keep the extension points described in Section 4 intact.

**Non-negotiable design rule, stated once, applying everywhere in this repo:** the LLM never computes a number. Every numeric claim in a user-facing report must trace back to a value produced by deterministic TypeScript code and passed to the LLM as context. If you're about to write a prompt that asks the model to estimate, calculate, or "figure out" a number, stop — that logic belongs in a plain function node instead.

**Budget constraint:** this project runs on free tiers only, by design. Every tool that calls an external API must respect that provider's documented rate limit and must cache results rather than re-fetching on every graph run. See Section 6 for the exact caching contract.

**Two runtime halves:** LangGraph only runs server-side. This repo is a small monorepo: a Node/TypeScript **server** app that owns the graph, the tools, and an HTTP API; and a **web** app (React + Vite) that is a pure client calling that API. The web app never talks to LLM providers or market-data APIs directly.

---

## 2. Tech stack

- **Language:** TypeScript 5+ everywhere (server and web). `strict: true` in every `tsconfig.json` — no exceptions.
- **Runtime:** Node.js 20+
- **Orchestration:** `@langchain/langgraph` (the JS/TS SDK). Verify the current `Annotation`/`StateGraph` API against the installed package version before writing graph code — the JS SDK's API surface has moved faster than its docs at times.
- **LLM:** Google Gemini 2.5 Flash via `@langchain/google-genai` (free tier) as primary; Groq (`groq-sdk` or `@langchain/groq`) as a fast fallback if Gemini is rate-limited. Both are configured behind a single `getLlm()` factory — never hardcode a provider inside a node.
- **Validation:** `zod` for parsing every external API response and for validating `AgentState` shape at graph boundaries. Untyped `any` from a fetch call should never reach a node function — parse it through a zod schema first.
- **Market data:**
  - `yahoo-finance2` (npm) — primary, no key required, TypeScript-typed
  - Finnhub — plain REST via `fetch`, typed with a local zod schema (no official first-party TS SDK to depend on)
  - Alpha Vantage — plain REST via `fetch`, typed with a local zod schema
- **Server framework:** Fastify (lightweight, first-class TypeScript support) exposing a small HTTP API that the web app calls.
- **Cache/persistence:** SQLite via `better-sqlite3` — synchronous, simple, no external service.
- **Web UI:** React 18 + Vite, TypeScript, fetch-based API client. No server-side rendering needed for this phase.
- **Testing:** Vitest for both server and web. All deterministic nodes and tools covered by fixture-based unit tests — no live network calls in the test suite.
- **Lint/format:** ESLint + Prettier, shared config at repo root.
- **Env management:** `.env` in `apps/server`, loaded via `dotenv`, fully documented in `apps/server/.env.example`. The web app never holds API keys.

---

## 3. Repo structure

```
/apps
  /server
    /src
      state.ts                  # AgentState — single source of truth for graph state (zod schema + inferred type)
      graph.ts                   # StateGraph assembly, conditional edges, entry point
      llm.ts                      # getLlm() factory — provider-agnostic
      /lib
        stats.ts                    # shared median/MAD robust z-score helper (promoted once a 3rd capability needed it — see growth-authenticity's former stats.ts)
        technical-indicators.ts     # §14 — SMA/EMA/RSI/MACD/ATR/Bollinger + swing detection/clustering
      /nodes
        supervisor.ts
        report-writer.ts          # only node that calls the LLM for user-facing prose
        validator.ts                # checks report claims against computed state fields
        /capabilities
          /industry-trend
            index.ts                # capability manifest: which state fields it reads/writes
            sector-trend.ts          # deterministic: ranks sectors by performance
            sector-leaders.ts         # deterministic: weight score + speed score + quadrant
          /growth-authenticity      # §11 — single-ticker "is this growth real" check
            index.ts                # capability manifest
            revenue-growth.ts        # deterministic: YoY revenue growth
            price-revenue-discrepancy.ts # deterministic: price vs. revenue, own-history z-score
            inorganic-signal.ts      # deterministic: goodwill/PP&E/cash M&A signal
            sector-benchmark.ts      # deterministic: sector/commodity-beta check
            growth-classification.ts # deterministic: decision table -> final label
          /portfolio-scan           # §12 — N-ticker growth-authenticity scan + comparison
            index.ts                # capability manifest
            portfolio-growth-scan.ts # deterministic orchestration: loops the growth-authenticity nodes per ticker
            ticker-comparison.ts    # §12.8 — deterministic: fixed decision table -> comparative verdict
          /company-snapshot         # §13 — valuation/financial-health/profile for a ticker or a few
            index.ts                # capability manifest
            company-profile.ts       # deterministic: general company facts
            peer-sample.ts            # internal: resolves sector + bounded peer sample
            valuation-metrics.ts      # deterministic: PE/PB/EV-EBITDA vs peers
            financial-health.ts       # deterministic: margins/debt/returns vs peers
            company-snapshot-scan.ts  # the one graph node: loops the compute functions per ticker
          /technical-analysis       # §14 — trading-strategy suggestions for a ticker/few/sector
            index.ts                # capability manifest
            constants.ts             # every tunable constant (periods, thresholds, ATR/RR multiples)
            resolve-targets.ts       # deterministic: ticker-vs-sector→ETF resolution, cap/skip
            indicator-snapshot.ts    # deterministic: point-in-time SMA/EMA/RSI/MACD/ATR/Bollinger
            market-context.ts        # deterministic: trend/momentum/volatility flags
            support-resistance.ts    # deterministic: swing detection -> support/resistance levels
            stance-classification.ts # deterministic: decision table -> bullish/bearish/neutral
            trade-levels-atr.ts      # deterministic: ATR-methodology entry/stop/target
            trade-levels-swing.ts    # deterministic: swing-methodology entry/stop/target
            technical-analysis-scan.ts # the one graph node: loops resolved targets
      /tools
        yahoo-finance.ts
        finnhub.ts
        alpha-vantage.ts
        etf-holdings.ts             # sector ETF constituent + weight fetcher
        cache.ts                     # shared caching layer, TTL per data type
      api.ts                          # Fastify routes exposing the graph (POST /api/analyze)
      index.ts                         # server entrypoint
    /tests
      /nodes
      /tools
      /lib
      /fixtures                      # saved sample API responses for offline tests
    /scripts
      calibrate-growth-authenticity.ts # manual, real-API script — never run from tests (§11.9)
      calibrate-company-snapshot.ts     # manual, real-API script — never run from tests (§13.11)
      calibrate-technical-analysis.ts   # manual, real-API script — never run from tests (§14.15)
    package.json
    tsconfig.json
    .env.example
  /web
    /src
      App.tsx
      /components
        ReportView.tsx
        SectorRankingsTable.tsx
        SectorLeadersPanel.tsx
      /api
        client.ts                    # typed fetch wrapper around the server API
      main.tsx
    index.html
    package.json
    tsconfig.json
    vite.config.ts
package.json                          # root — npm workspaces for apps/server and apps/web
CLAUDE.md
```

**Rule:** a capability lives entirely under `apps/server/src/nodes/capabilities/<capability-name>/`. Its `index.ts` documents, in comments, which `AgentState` fields it reads and writes.

**Correction, found building the second capability (§11):** the claim that only `supervisor.ts` and `graph.ts` need edits outside the capability folder did not hold. `state.ts` needs a new namespaced field block every time (the state contract itself is shared, and always will be); `report-writer.ts` and `validator.ts` are NOT capability-agnostic today — each has one hardcoded `if (activeCapabilities.includes(SOME_ID))` branch per capability, so adding one means adding a branch to both. Expect five touch-points, not two: `state.ts`, `supervisor.ts`, `graph.ts`, `report-writer.ts`, `validator.ts` — plus the capability's own folder.

---

## 4. Shared state schema

Define with `zod` so the same schema gives you runtime validation and a static type via `z.infer`.

```typescript
import { z } from "zod";

export const SectorLeaderSchema = z.object({
  ticker: z.string(),
  weightScore: z.number(), // % weight in sector ETF, from disclosed holdings
  speedScore: z.number(), // z-scored momentum vs sector peers
  relativeVolume: z.number(),
  quadrant: z.enum(["anchor_leader", "emerging_mover", "stable_heavyweight", "laggard"]),
});

export const SectorRankingSchema = z.object({
  sector: z.string(),
  pctChange: z.number(),
  window: z.string(),
  source: z.enum(["yahoo_finance", "alpha_vantage", "cross_checked"]),
});

export const AgentStateSchema = z.object({
  // Conversation
  messages: z.array(z.any()), // BaseMessage[] from @langchain/core

  // Request parsing (supervisor)
  tickers: z.array(z.string()).default([]),
  sectors: z.array(z.string()).default([]),
  intent: z.enum(["sector_trend", "single_report", "portfolio_scan", "followup"]),
  timeWindow: z.string(), // e.g. "5d", "1mo", "3mo", "ytd"
  activeCapabilities: z.array(z.string()).default([]),

  // --- Industry trend capability ---
  sectorRankings: z.array(SectorRankingSchema).nullable().default(null),
  sectorLeaders: z.record(z.string(), z.array(SectorLeaderSchema)).nullable().default(null),
  trendDataErrors: z.array(z.string()).default([]),

  // Generic
  dataErrors: z.array(z.string()).default([]),

  // Report writer + validator
  draftReport: z.string().nullable().default(null),
  validationPassed: z.boolean().default(false),
  validationNotes: z.array(z.string()).default([]),
  finalReport: z.string().nullable().default(null),
  retryCount: z.number().default(0),
});

export type AgentState = z.infer<typeof AgentStateSchema>;
```

**Extension contract for future capabilities:** each new capability adds its own clearly-namespaced fields (prefixed or grouped, as `sectorRankings`/`sectorLeaders` are here) rather than reusing or overloading an existing field. Never let two capabilities write to the same state field. When you wire this into `@langchain/langgraph`'s `Annotation.Root`, confirm the reducer semantics against the installed SDK version — some fields (like `messages`) need an append reducer, most of these should be simple overwrite reducers.

### 4.1 Resolved notes (added after verifying the installed SDK — `@langchain/langgraph@1.4.8`)

The `Annotation.Root` instruction above predates the installed SDK. Both notes below record decisions taken deliberately, not defaults inherited from an example.

**(a) State is wired by passing the zod schema to `StateGraph` directly — not via `Annotation.Root`.**

`@langchain/langgraph@1.4.8` accepts a zod object as a state schema (`StateDefinitionInit = StateDefinition | InteropZodObject | AnyStateSchema | AnnotationRoot<any>`). Verified empirically against `AgentStateSchema`, not just at the type level:

- every field's `.default()` is honoured as the channel default (`sectorRankings` → `null`, `dataErrors` → `[]`, `retryCount` → `0`);
- fields without an explicit reducer overwrite, which is the desired semantic for all but one field;
- `messages` is the one exception and must be wrapped in `withLangGraph` from `@langchain/langgraph/zod` to give it an append reducer.

```typescript
import { withLangGraph } from "@langchain/langgraph/zod";

export const GraphState = AgentStateSchema.extend({
  messages: withLangGraph(z.array(z.any()), {
    reducer: { schema: z.array(z.any()), fn: (left, right) => [...left, ...right] },
    default: () => [],
  }),
});
```

Rationale: `Annotation.Root` would require restating all 15 fields (and re-declaring every default) in `graph.ts`, giving the project two hand-synchronised copies of its own state definition. The zod path keeps `state.ts` the single source of truth that §4 opens by asking for.

**(b) `intent` and `timeWindow` stay required, and are enforced at the API boundary.**

These are the only two fields with no `.default()`. Verified behaviour: **LangGraph does not run zod validation on graph input** — invoking with `timeWindow` omitted does not throw, and the node observes `undefined` while the static type still claims `string`.

Therefore `api.ts` must build the initial state through `AgentStateSchema.parse()` before calling `graph.invoke()`, so a malformed request fails loudly at the boundary with a 400. Do not paper over this by adding `.default()` to either field: a defaulted `timeWindow` turns "we failed to parse the user's window" into a confident report covering a window the user never asked for, which is the same class of silent wrong answer §5.3 forbids for source disagreements.

---

## 5. Capability spec: industry trend and sector leaders (fully formed — build this first)

### 5.1 Goal

Given a request like "what industries are trending up or down, and who's leading them," produce:

1. A ranked list of GICS sectors by performance over a chosen window.
2. For each trending sector (top N up, top N down), a list of leader companies with **two separate, never-blended metrics**: a weight score and a speed score, plus a quadrant classification.

### 5.2 Data sources and roles

| Source                                                                                             | Role                                                                        | Free-tier limit to respect                                              |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `yahoo-finance2`, SPDR sector ETF tickers (XLK, XLE, XLF, XLV, XLI, XLY, XLP, XLU, XLB, XLRE, XLC) | Primary sector trend signal — % price change per ETF over the window        | No documented limit, but cache aggressively; unofficial upstream source |
| Alpha Vantage `SECTOR` endpoint (REST)                                                             | Secondary/cross-check sector trend signal                                   | 25 requests/day, 5/min — call once, cache 24h                           |
| Alpha Vantage `ETF_PROFILE` (or `yahoo-finance2` fund holdings)                                    | Authoritative source for sector leader **weight** (ETF-disclosed holding %) | Same 25/day quota — cache 7 days, holdings don't change often           |
| `yahoo-finance2` daily OHLCV for sector constituents                                               | Sector leader **speed** (momentum)                                          | No documented limit; cache 24h                                          |
| Finnhub `stock/profile2` (REST)                                                                    | Company → sector/industry tagging                                           | 60 calls/min — cache indefinitely per ticker (rarely changes)           |

### 5.3 Node: `sector-trend.ts` (deterministic, no LLM)

- Input: `timeWindow` from state.
- Fetches ETF price history for all 11 sector ETFs (from cache if fresh).
- Computes % change over `timeWindow` per ETF, maps ETF ticker → GICS sector name.
- Optionally cross-checks against Alpha Vantage `SECTOR` data if available; if the two sources disagree by more than a defined threshold, note the discrepancy in `trendDataErrors` rather than silently picking one.
- Writes `sectorRankings`: sorted array, most positive to most negative.

### 5.4 Node: `sector-leaders.ts` (deterministic, no LLM)

For each sector flagged as trending (top N up, top N down from `sectorRankings`):

- **Weight score:** pull that sector's ETF holdings (cached), take each constituent's disclosed weight %. This is the authoritative structural-size metric — do not derive it from raw market cap unless holdings data is unavailable, in which case fall back explicitly and flag the fallback in `trendDataErrors`.
- **Speed score:** pull daily price + volume for the same constituents, compute % change over `timeWindow`, z-score it against the sector's own constituent distribution (so speed is relative to sector peers, not absolute), and compute relative volume (today's volume ÷ 20-day average) as a secondary confirmation signal.
- **Quadrant classification:** apply fixed thresholds (e.g., top/bottom tercile) to weight and speed independently to assign one of: `anchor_leader` (high weight, high speed), `emerging_mover` (low weight, high speed), `stable_heavyweight` (high weight, low speed), `laggard` (low weight, low speed).
- Writes `sectorLeaders`: `{ [sectorName]: SectorLeader[] }`, sorted by speed score descending within each sector.

**Explicitly forbidden in this node:** combining weight and speed into a single composite score. They must remain separate fields all the way to the report writer — the report writer decides how to narrate the combination, but the underlying data stays disaggregated so the user (or a future capability, or the React UI) can re-slice it differently.

### 5.5 Report writer's role for this capability

When `activeCapabilities` includes `"industry_trend"`, the report writer receives `sectorRankings` and `sectorLeaders` as structured JSON context and is prompted to:

- Name the top trending-up and trending-down sectors with their actual % figures.
- For each, name the `anchor_leader` companies first (these are the ones genuinely driving the move), then note any notable `emerging_mover` companies as an "early signal" callout.
- Never invent a company or number not present in `sectorLeaders`/`sectorRankings`.

### 5.6 Validator's role for this capability

Confirm every ticker and every percentage mentioned in `draftReport` for this capability appears in `sectorRankings` or `sectorLeaders`. Flag and trigger a retry if not.

### 5.7 Edge cases to handle explicitly

- A sector ETF holding a company that's had a very recent IPO — insufficient price history for a `timeWindow` like `"1y"`. Exclude from speed ranking, note in `trendDataErrors`, still include in weight ranking if holdings data is available.
- Alpha Vantage quota exhausted for the day — fall back to `yahoo-finance2`-only sector trend, note the missing cross-check in `trendDataErrors` rather than failing the whole capability.
- Two sectors with near-identical performance (tie) — stable sort by absolute magnitude, don't error.
- Any external response that fails its zod parse — treat as a fetch failure, not a crash: log to `dataErrors`/`trendDataErrors` and degrade gracefully.

### 5.8 Resolved notes (added after probing the live APIs)

Two assumptions in §5.2–§5.4 did not survive contact with the providers. Both were verified against the live APIs, and both decisions below were taken deliberately.

**(a) Alpha Vantage's `SECTOR` endpoint is retired. The cross-check uses `TIME_SERIES_DAILY` on the top/bottom sectors instead.**

`SECTOR` returns `{}` with HTTP 200. This is not a key problem — the same empty body comes back for the demo key _and_ for a deliberately invalid key, whereas `TIME_SERIES_DAILY` returns full data even with that invalid key. A working endpoint answers a bad key with data or an error message, never with silence.

Replacement procedure for `sector-trend.ts`:

1. Rank all 11 sectors from Yahoo ETF price history.
2. Take only the sectors the report will actually name (top N up + bottom N down) and re-derive their % change from Alpha Vantage `TIME_SERIES_DAILY`.
3. Agreement within threshold → `source: "cross_checked"`. Disagreement → record in `trendDataErrors` and do **not** silently pick one (§5.3 unchanged). Quota exhausted → `source: "yahoo_finance"` plus a note (§5.7 unchanged).

Sectors outside the top/bottom N keep `source: "yahoo_finance"`. Spending quota only on figures the user will read keeps the cost at ~6 of 25 daily calls; Alpha Vantage's 5/min limit still applies and must be throttled.

**The two series MUST be compared over their overlapping date range, not as fetched.** This was found the hard way: the first live run reported "sources disagree" on 4 of 4 cross-checked sectors, with gaps up to 3.64pp. None of them were real. Two independent misalignments caused it:

1. **Alpha Vantage `compact` returns its last 100 bars up to today**, regardless of the window asked about — so it runs PAST the Yahoo series, which ends whenever it was fetched (up to 24h stale from cache, §6).
2. **Alpha Vantage's free tier lags Yahoo by a few trading days** — so it can also stop SHORT:

```
Yahoo           2026-07-10 → 2026-08-10   +8.03%
Alpha Vantage   2026-07-10 → 2026-08-07   +4.39%
                             ^^^^^^^^^^ AV has no bars for the last 3 days
```

Clamping Alpha Vantage to Yahoo's range fixes (1) but not (2) — you cannot clamp your way to bars a provider does not have. `compareOverOverlap()` therefore recomputes BOTH figures over `[max(starts), min(ends)]`. The reported `pctChange` is never modified; only the comparison is re-based, so the headline figure still covers the window the user asked for.

After the fix, the same live query returns all 6 cross-checked sectors agreeing and **zero** disagreement notes.

The general lesson, since it will recur with any second source: **a cross-check that cries wolf is worse than no cross-check**, because it trains the reader to ignore the one signal that is supposed to mean something. Before reporting a disagreement, be certain the two figures measure the same thing.

**(b) Yahoo's holdings module returns only the top 10. Alpha Vantage `ETF_PROFILE` is the primary weight source.**

Verified: `ETF_PROFILE` returns the full constituent list (105 rows for QQQ); Yahoo's `quoteSummary` `topHoldings` module returns 10.

This is not merely a coverage difference. §5.4's `emerging_mover` quadrant is _low weight + high speed_, and the top 10 holdings of a sector ETF are by construction the high-weight names — so a top-10 list makes that quadrant unreachable, and it is exactly the one §5.5 asks the report writer to surface as an "early signal" callout.

Therefore `etf-holdings.ts` uses `ETF_PROFILE` as primary (1 call per analysed sector, cached 7 days per §6) and falls back to Yahoo's top-10 only when Alpha Vantage is unavailable. The fallback must be recorded in `trendDataErrors` — noting that `emerging_mover` coverage is incomplete for that sector — in the same way §5.4 already requires for the market-cap fallback.

Both sources report weight as a FRACTION (`0.0828` = 8.28%). Conversion to percent happens in exactly one place, in `etf-holdings.ts`, so the two can never end up on different scales.

### 5.9 Resolved notes (quadrant thresholds — settled against live data)

**(a) The quadrant cutoff is the top tercile (`QUADRANT_PERCENTILE = 0.667`) on BOTH axes.**

§5.4's "e.g., top/bottom tercile" is taken literally: the top third of a sector is "high", the remaining two thirds are "low". Cutoffs are recomputed per sector from that sector's own distribution, because a 3% holding is unremarkable in concentrated Information Technology and very large in a flat sector.

Verified on live XLK data (1-month window), tercile vs a median split:

| | tercile (0.667) | median (0.5) |
| --- | --- | --- |
| `anchor_leader` | 2 | 3 |
| `emerging_mover` | 1 | 2 |
| `stable_heavyweight` | 1 | 2 |
| `laggard` | 6 | 3 |

Tercile keeps `anchor_leader` a demanding claim, which matches §5.5's framing of them as the companies "genuinely driving the move". The trade-off accepted: `laggard` becomes a large bucket that includes companies which merely had an average month.

Note the threshold sensitivity this exposed — NVDA's speed z-score was `0.590` against a cutoff of `0.591`, so the sector's largest holding fell out of `anchor_leader` by a rounding-level margin. Inherent to any hard threshold; recorded here so it is not rediscovered as a bug.

**(b) `emerging_mover` is SUPPRESSED when the holdings list is partial.**

Found on live data: with the Yahoo top-10 fallback, AVGO — the **fourth-largest** holding in XLK at 4.67% — was classified `emerging_mover`, because within a 10-name list the weight cutoff sits at 4.715% and a top-5 holding therefore reads as "low weight".

§5.5 instructs the report writer to present `emerging_mover` companies as an "early signal": a small company moving before the index notices. For AVGO that is false, and it is the kind of false claim that reads as authoritative.

So when `HoldingsResult.isPartial` is true, `classifyQuadrant` does not emit `emerging_mover` at all; affected companies fall back to their weight-only classification, and a `trendDataErrors` note names them explicitly. `weightScore` and `speedScore` are unchanged — suppression affects only the label, so the underlying numbers stay disaggregated for the UI to re-slice (§5.4, §9).

The governing principle, worth stating once: **a missing signal is honest; a confident wrong one is not.** This is the same reasoning as §5.3's refusal to silently resolve a source disagreement.

---

## 6. Caching contract (applies to every tool, not just this capability)

- Every external API call goes through `tools/cache.ts`, keyed by `(source, endpoint, paramsHash)`, backed by `better-sqlite3`.
- TTLs by data type: sector price history — 24h; ETF holdings — 7 days; company sector/industry tags — indefinite (invalidate manually if needed); daily OHLCV for momentum — 24h.
- No node should ever call an external API directly — always through a `tools/*.ts` function that wraps the cache check.
- Log every cache miss (i.e., every real API call) so it's visible during development how close you are to a rate limit.

---

## 7. API contract between server and web app

- `POST /api/analyze` — body: `{ query: string }`. Server runs the graph, returns `{ finalReport: string, sectorRankings: SectorRanking[], sectorLeaders: Record<string, SectorLeader[]>, dataErrors: string[] }`.
- The web app's `api/client.ts` is the only place that calls this endpoint — components never call `fetch` directly.
- CORS: server allows only the Vite dev origin in development; tighten before any public deployment.

### 7.1 Conversation threads (added when persistence was introduced — see §10)

`POST /api/analyze` additionally accepts an optional `threadId` (UUID) and always returns one, plus `trendDataErrors`, `timeWindow`, and `validationPassed`:

```
request   { query: string, threadId?: string }
response  { finalReport, sectorRankings, sectorLeaders, dataErrors,
            trendDataErrors, timeWindow, validationPassed, threadId }
```

Omit `threadId` to start a new conversation; send the returned value back to ask a follow-up. It is constrained to a UUID rather than any string because the value goes straight into a thread lookup — an unconstrained id would let a caller enumerate other people's conversations. That is not authorisation and must not be mistaken for it: anyone holding the id can read the thread.

`DELETE /api/thread/:threadId` discards a conversation entirely. Pruning (§10) bounds a thread's size but never removes it, so without this there is no way to end one.

### 7.2 Deep-linkable routes, thread history, and anonymous device identity

The web app uses `react-router-dom` so every step is its own URL, not just client-side state: `/` (landing), `/t/:threadId` (a conversation's latest report), `/t/:threadId/sector/:sector` (a sector selected), `/t/:threadId/sector/:sector/ticker/:ticker` (a leader's drilldown open). All four render the same `App` component, which derives `activeSector`/`drilldownTicker` from `useParams()` instead of local state — the URL IS the state, so a refresh, a bookmark, or a link shared from the history modal below all reproduce the exact same view.

That only works if a thread's report can be re-fetched without re-running the graph, which §7.1 explicitly did not support (`POST /api/analyze` always moves a conversation forward). Two endpoints close that gap:

- **`GET /api/thread/:threadId`** — returns the same shape as §7.1's response, plus `query` (the last question asked, from the index below), read straight off the checkpointer's current snapshot (`getGraph().getState(...)`). No `.invoke()`, so this never touches the LLM or a market-data provider (§9) and burns no quota. 404 if the thread was never created or was deleted.
- **`GET /api/threads`** — up to 10 most-recently-active threads, newest first, for the history modal. Requires `X-Device-Id` (see below); 400 without it, since an empty result would then be indistinguishable from "this device has no history yet".

**Anonymous device identity, deliberately not a login system.** The web app generates a `crypto.randomUUID()` once per browser, keeps it in `localStorage`, and sends it as `X-Device-Id` on every request. There is no session, no cookie, no server-side account. This is the same trust model §7.1 already accepted for thread ids — a UUID's unguessability is what does the work, not encryption; "encrypting" a value that already has 122 bits of entropy would need a key stored *somewhere client-accessible*, which secures nothing. **It is not authorisation**, exactly as §7.1 says about thread ids: anyone holding a thread's URL can open it via `GET /api/thread/:threadId` regardless of device id. The device id only decides which device's `GET /api/threads` list a thread shows up in.

Server-side, this is backed by a small `thread_index` table in `checkpoints.sqlite` (`checkpointer.ts`) — one row per thread (`thread_id` primary key, `device_id`, `last_query`, `updated_at`), upserted by `recordThreadActivity()` after every successful `/api/analyze`(`/stream`) call that supplied the header, and read by `listRecentThreads()`. It is deliberately NOT read out of the checkpointer's own internal `metadata` column — that would mean writing to it on every super-step to keep a "last query" string current, which is exactly the repeated-full-snapshot cost §10 already measured and warned about for `sectorLeaders`. `deleteThread()` removes the index row too, so a discarded conversation actually disappears from history rather than 404ing forever in the list.

---

## 10. Conversation persistence (checkpointer)

Graph state is checkpointed per thread by `@langchain/langgraph-checkpoint-sqlite`, wired in `src/checkpointer.ts` and compiled into the graph by `getGraph()`.

**Storage is a SEPARATE SQLite file** from the §6 cache — `.cache/checkpoints.sqlite` vs `.cache/stock-buddy.sqlite`. Their lifecycles differ completely: the cache is disposable and may be deleted at any time to force a re-fetch, whereas deleting checkpoints destroys conversation history. One shared file would make "clear the cache" silently wipe user conversations.

**Checkpointing is not free, and the cost is not obvious.** Measured against this project's real state:

| | |
| --- | --- |
| checkpoints per turn | 7 (one per super-step, not one per run) |
| storage per turn | ~125 KB |
| largest single checkpoint | ~40 KB |
| after a second turn | ~294 KB — **accumulates, does not replace** |

The three 40 KB entries are `sectorLeaders` (~34 KB, 261 leader rows across 6 sectors) being re-serialised into every checkpoint written after it is first set. The state is not large; it is snapshotted repeatedly.

**Therefore retention is mandatory, not an optimisation.** `pruneThread()` keeps the newest `MAX_CHECKPOINTS_PER_THREAD` (default 10) after every run. Unpruned, 1,000 threads would reach roughly 287 MB. The state a follow-up needs always lives in the newest checkpoint, so pruning costs deep rewind history, never conversational continuity. Pruning must clear the `writes` table as well as `checkpoints` — orphaned write rows are invisible in any listing but still occupy disk, which would quietly defeat the whole exercise.

**Two verified behaviours worth not rediscovering:**

- `SqliteSaver` creates its tables LAZILY, on first read or write, via a `protected setup()`. A freshly started server has no `checkpoints` table, so any `SELECT` against it throws `no such table`. `/api/health` must guard on `sqlite_master` before counting, or it returns 500 on a cold server — the one moment it most needs to answer.
- `@langchain/langgraph-checkpoint-sqlite@1.0.3` depends on `better-sqlite3@^12` while the project runs 13, so npm installs a second nested copy. Verified working on Node 24, but it is a second native module to build — relevant on Windows (see the README note).

**Deployment:** this is a file on the server's disk, exactly like the cache. On an ephemeral filesystem (Railway/Render/Fly without an attached volume; Vercel/Lambda at all) it does not survive a redeploy and every thread is lost. Attach a persistent volume, or move to `@langchain/langgraph-checkpoint-postgres`, before relying on it in production. The same caveat applies to the §6 cache, where the cost is sharper: a cold cache costs ~8–11 Alpha Vantage calls against a 25/day cap, so two redeploys in one day can exhaust the quota.

---

## 8. Coding conventions

- `strict: true` TypeScript everywhere; no `any` except at the immediate boundary of an untyped external response, and even then, parse it through zod within the same function.
- Every node function typed as `(state: AgentState) => Promise<Partial<AgentState>>` (or the exact signature your installed `@langchain/langgraph` version expects — confirm before assuming).
- JSDoc on every node stating: what it reads from state, what it writes, what it must never touch.
- No silent `catch {}` — every caught error either degrades into a `*Errors` state field or is rethrown with added context. Never let a tool-layer failure crash a graph run.
- Every deterministic node (anything not calling an LLM) must have a Vitest unit test using fixture data, no live network calls in the test suite.
- React components: function components with typed props, no implicit `any` props. Keep components presentational — all data fetching happens in `api/client.ts`, not inside components.
- Commit messages: `<capability or component>: <what changed>`, e.g. `industry-trend: add weight/speed quadrant classification`.

---

## 9. What NOT to do

- Do not let the LLM touch `sectorRankings` or `sectorLeaders` computation — those are pure-TypeScript nodes only.
- Do not blend weight and speed into one score anywhere in the pipeline.
- Do not blend independently-computed numeric signals into a single arithmetic score anywhere in the pipeline (this rule extends to every capability, not only weight/speed — see §9.1 below for the one narrow, deliberate carve-out this project has made, and only that one).
- Capabilities are added one at a time, each fully specified in its own §-section (§5, §11, §12, §13, §14, ...) before being built. The growth-authenticity capability (§11) is the second; portfolio scan (§12) is the third; company sector snapshot (§13) is the fourth; technical analysis / trading-strategy suggestions (§14) is the fifth. Do not add a sixth speculatively — wait for it to be specified here first.
- Do not silently fall back to the "calmest" or most neutral-sounding classification/flag when a computation lacks the data to resolve it. §11.9 records a real incident: a missing baseline defaulted to `"aligned"` and hid a genuine ~12.6x price/revenue divergence on live data. Missing data gets its own honest label (e.g. `"insufficient_history"`, `"not_computable"`), never the label that happens to mean "everything looks fine."
- Do not call any external API from inside `report-writer.ts` or `validator.ts` — they only read from state.
- Do not skip the cache layer "just for testing" in a way that leaves uncached calls in the committed code.
- Do not put API keys or LLM calls in the `apps/web` React app — it is a pure client of `apps/server`'s HTTP API.

### 9.1 Resolved decision — a narrow carve-out for cross-ticker comparison (added alongside §12.8)

The anti-blending rule above is about **arithmetic** blending — summing, averaging, or weighting numbers into one figure with hidden coefficients. It was never a rule against *comparison*. §12.8 introduces exactly one new kind of computation that is now permitted: a **rank-count decision table** over metrics that were already independently computed and verified elsewhere in the pipeline, applied ACROSS tickers rather than within one.

Precisely what is now allowed, and what is still forbidden:

**Allowed:**

- Counting, per metric, which of N tickers has the more favourable computed value for that metric (a categorical "who won this metric" tally) — the same kind of operation `growth-classification.ts`'s decision table already performs on categorical flags, just counted across tickers instead of read off one ticker's own flags.
- Naming a "stronger" ticker via a FIXED rule over those counts (e.g. "the ticker with a majority of metric wins, provided the margin clears a documented threshold") — see §12.8 for the exact table.
- Keeping every underlying metric value, per ticker, fully disaggregated and visible alongside the verdict (§12.8's `TickerComparisonResultSchema.metricRanks`). The verdict AUGMENTS the disaggregated view; it never replaces it.

**Still forbidden, without exception:**

- Adding, multiplying, or weighting the underlying numeric VALUES themselves into a single number (no "NVDA scores 8.2, AMD scores 6.1").
- Any hidden or per-request-tunable weighting of which metric matters more — the metric list and the win-margin threshold are fixed constants in code (`ticker-comparison.ts`), reviewed the same way `QUADRANT_PERCENTILE` (§5.9a) and `MIN_BASELINE_QUARTERS` (§11.9) are, never inferred by the LLM or accepted as a request parameter.
- The LLM computing, adjusting, or overriding the verdict. It narrates `overallVerdict.verdict`/`strongerTicker` exactly as `report-writer.ts` already narrates `classification` (§11.7) — never re-derives it.
- Using price return / price-vs-revenue discrepancy as a "win" metric toward the verdict. Rewarding whichever ticker's price already ran further would quietly reintroduce the exact "mistaking a price rally for strength" failure mode growth-authenticity (§11) exists to catch. Price figures stay in the report as disaggregated context, never as a comparison input.
- Applying this carve-out anywhere outside §12.8's cross-ticker verdict — a single company's own valuation/financial-health metrics (§13) stay exactly as disaggregated as §5.4's weight/speed always have. §9.1 widens nothing else.

---

## 11. Capability spec: growth authenticity check (fully formed, built)

### 11.1 Goal

A user asks a single-ticker question ("is NVDA's growth backed by revenue, or just the AI trade?"). Produce a deterministic classification of **why** the stock moved over `timeWindow` — organic revenue growth, M&A, sector/commodity beta, or unexplained — plus the disaggregated evidence behind it, never a blended "authenticity score." This is the guardrail against the "illusion of growth": mistaking a price rally, an acquisition, or a commodity swing for genuine operational growth.

Triggered by `intent === "single_report"` (existing enum value, previously unimplemented). Single ticker only — `tickers[0]`; extra tickers are noted and skipped, not analysed.

### 11.2 Data sources and roles

| Source | Role | Notes |
| --- | --- | --- |
| Yahoo `fundamentalsTimeSeries`, `module: "financials"` | Quarterly revenue → YoY growth | No key. See §11.9 — real depth is ~5 usable quarters, not the years the endpoint's params suggest. |
| Yahoo `fundamentalsTimeSeries`, `module: "balance-sheet"` | Goodwill/PP&E/cash → M&A signal | No key. See §11.9 — goodwill was `undefined` in every quarter tested, live. |
| Yahoo `chart` (per-ticker, ~5y) | Price return, both current-window and the own-history baseline series | Reuses the industry-trend capability's fetcher. |
| Yahoo `quoteSummary.assetProfile` | Company's sector taxonomy → mapped to GICS | Reuses the `"company_profile"` cache namespace (indefinite TTL). |
| Yahoo sector ETF `chart` + `topHoldings`/Alpha Vantage `ETF_PROFILE` (via `etf-holdings.ts`) | Sector benchmark + a bounded peer sample | Reused from the industry-trend capability's tools. |

Cached under a new `"quarterly_fundamentals"` namespace, 14-day TTL.

### 11.3 Node: `revenue-growth.ts` (deterministic, no LLM)

YoY quarterly revenue growth, matching "this quarter" to "the same quarter ~1 year earlier" via a tolerance band (335–395 days), not a fixed index offset — real quarterly rows are not guaranteed contiguous. A revenue **decline** is a valid, reported result; only a missing prior-year quarter is `insufficient_data`.

### 11.4 Node: `price-revenue-discrepancy.ts` (deterministic, no LLM)

Computes the current price/revenue ratio (only when revenue growth is strictly positive — see the case matrix), then expresses it as a **robust (median/MAD) z-score against the company's own trailing quarter-end ratio history** — never a flat constant. See §11.9 for why this baseline is, in practice, rarely available from this data source, and how that is now handled honestly.

### 11.5 Node: `inorganic-signal.ts` (deterministic, no LLM)

QoQ (not YoY — an M&A jump shows up next quarter) trend on goodwill, PP&E, and cash, each z-scored against the company's own trailing history. Goodwill is the intended *primary* M&A signal (it only moves through purchase accounting); PP&E only counts as corroborating, and only alongside a simultaneous cash decrease (ordinary organic capex also moves PP&E). See §11.9 — goodwill's real availability from this data source undercuts its "primary" role in practice.

### 11.6 Node: `sector-benchmark.ts` (deterministic, no LLM)

Resolves the company's GICS sector, compares its price move to the sector ETF's own move, then z-scores that spread against a bounded sample (≤10) of the sector's heaviest peers — the "is this just oil at $90/barrel" check. Missing peer data defaults to `"stock_specific_move"` (the cautious direction), never `"beta_explained"` without evidence.

### 11.7 Node: `growth-classification.ts` (deterministic, no LLM)

Pure decision table over the three upstream categorical flags (never an arithmetic blend — mirrors `classifyQuadrant` in `sector-leaders.ts`). `"insufficient_history"` and `"not_computable"` both count as "unknown" for the all-unknown → `insufficient_data` check; neither is ever treated as evidence of alignment. The report writer narrates `classification`; `validator.ts` additionally checks the draft's prose actually states it (a keyword-presence heuristic, `checkClassificationNarrated`), closing the gap where a report could cite real numbers while narrating a different conclusion.

### 11.8 Edge cases

- Recent IPO / insufficient price history for `timeWindow` → `not_computable`, via the same inline `firstTradeDate` check `sector-leaders.ts` uses.
- Multiple tickers in one query → analyse `tickers[0]` only, note the rest as skipped.
- Any external response failing its zod parse → degrades into `growthCheckErrors`, never crashes the run.
- Insufficient own-history baseline → `"insufficient_history"`/`"insufficient_data"`, never guessed (§11.9).

### 11.9 Resolved notes (added after live calibration against real Yahoo data)

Three assumptions here did not survive contact with live data — verified against two real tickers (`APA`, an energy company that merged with Callon Petroleum in 2024; `COST`, a steady non-M&A grower), via `apps/server/scripts/calibrate-growth-authenticity.ts`, which runs the actual shipped node pipeline against live data. Fixtures of the raw responses are captured under `tests/fixtures/yahoo-*-apa.json` / `-cost.json` (via `capture.mjs growth-authenticity`) and locked into a regression test (`tests/nodes/growth-authenticity-live-fixtures.test.ts`).

**(a) Yahoo's free `fundamentalsTimeSeries` endpoint returns a FIXED ~5 usable quarters, regardless of `period1`.** The design assumed a ~4-year `period1` would yield 8–16 quarters for the own-history baselines. Live calls with `period1` as far back as 2018 returned the identical ~5 rows (7 raw, first 2 always empty) for both tickers, quarterly and annual alike — the params do not control real depth at all. This directly caps what the own-history baselines (§11.4, §11.5) can ever achieve: at most ~3 historical QoQ deltas, and effectively zero historical YoY-spaced ratio points (a YoY comparison needs ~2 years of real depth; ~5 quarters is ~15 months).

**(b) That capped depth exposed a real bug, not just a tight threshold.** `MIN_BASELINE_QUARTERS` started at a placeholder of 6 — unreachable given (a), so `price-revenue-discrepancy.ts`'s ratio z-score was *always* `null` in practice, and the code silently reported `discrepancyFlag: "aligned"` whenever that happened. Live evidence of the failure: on real APA data, price was +113% over the window against revenue +8.95% (raw ratio ≈12.6x — a bigger divergence than the original 2.0x flat cutoff this design replaced would ever need to flag), and the system reported `"aligned"`, the calmest possible label, purely because there was no baseline to check against. `"aligned"` is a claim ("checked, no discrepancy") the code had no right to make. Fixed by adding a distinct `discrepancyFlag` value, `"insufficient_history"`, and lowering `MIN_BASELINE_QUARTERS` to `3` (the real achievable ceiling for the QoQ baselines, confirmed live) rather than lowering it further to paper over the YoY case, which structurally cannot be satisfied by this data source. `classifyGrowthAuthenticity` was updated so `"insufficient_history"` counts as "unknown," never as evidence of alignment.

**(c) Goodwill — the designed *primary* M&A signal — was `undefined` in every quarter tested, for both tickers, at every date range tried (including annual).** Not sparse: genuinely absent from this field via this endpoint. In practice, PP&E-plus-cash-decrease (the documented *secondary*, corroborating signal) is the only inorganic-growth evidence this data source reliably provides. This is recorded here rather than silently degraded around, per the same "a missing signal is honest" principle §5.9(b) already established — the capability still calls `goodwillTrend.direction: "insufficient_data"` plainly rather than inventing a value.

**Still open — not yet calibrated:** `ROBUST_Z_THRESHOLD` (±2) has not been checked against a case where a z-score was actually produced from real, non-empty history (finding (a) meant calibration surfaced a data-*availability* problem severe enough to fix first). Revisit once a fixture captures a company with 3+ genuine historical PP&E/goodwill deltas spanning a real M&A event within Yahoo's visible window — APA's Callon merger (closed April 2024) predates the ~15 months of real data Yahoo actually serves as of any given "now," so it could not be used to calibrate this specific cutoff.

---

## 12. Capability spec: portfolio scan (fully formed — build this third)

### 12.1 Goal

Given a multi-ticker request ("are AAPL, MSFT, and NVDA all growing for real, or is this just AI hype?"), run the existing growth-authenticity classification (§11) independently for each named ticker and present the disaggregated results side by side. There is no portfolio-level score or verdict — per §5.4/§9's anti-blending rule, extended here to the multi-ticker case: N independent classifications, never averaged or ranked into one.

Triggered by `intent === "portfolio_scan"` (existing enum value). Fires either on "my portfolio/holdings/positions" phrasing (unchanged from the original intent design) or on a message naming more than one ticker — `single_report` remains single-ticker by design (§11.1), so a second named ticker means this is the multi-ticker case, not a `single_report` request with extras to discard.

### 12.2 Scope and cap

Bounded to `PORTFOLIO_SCAN_TICKER_CAP = 5` tickers per request. Extra tickers beyond the cap are noted in `portfolioScanErrors` and skipped — the same "note and skip" pattern §11.1 established for `single_report`'s extra tickers, now applied as a cap rather than a hard single-ticker limit. The cap exists for the same reason §11.2's quota table exists: `sector-benchmark.ts`'s Alpha Vantage cross-check spends one call per analysed ticker's sector (deduplicated when tickers share a sector, since the underlying sector fetch is itself cache-backed per §6) against a 25/day budget.

If `tickers.length === 0` (e.g. "how's my portfolio doing" with no tickers named — the original "my portfolio" phrasing does not require named tickers), no LLM call — an honest prompt asking the user to name the tickers, mirroring the existing unimplemented-intent message style.

### 12.3 Node: `portfolio-growth-scan.ts` (deterministic orchestration, no new analysis, no LLM)

Not a new analytical algorithm — a new capability folder that drives the five existing, already-tested, already-calibrated growth-authenticity node functions (`revenueGrowthNode`, `priceRevenueDiscrepancyNode`, `inorganicSignalNode`, `sectorBenchmarkNode`, `growthClassificationNode`, all under `nodes/capabilities/growth-authenticity/`, unmodified) once per ticker, sequentially, outside the LangGraph state-channel mechanism:

For each ticker (bounded by the cap):

1. Build a synthetic per-ticker state slice: `{ tickers: [ticker], timeWindow: state.timeWindow, growthCheckErrors: [] }`.
2. Thread it through the five node functions in the same order `graph.ts` already wires them for a single ticker (`revenueGrowthNode → priceRevenueDiscrepancyNode → inorganicSignalNode → sectorBenchmarkNode → growthClassificationNode`), accumulating each returned partial state into the slice before calling the next — exactly what the graph's edges do for `tickers[0]` today, just driven by a plain loop instead of graph execution.
3. Collect the resulting `growthAuthenticity` (now populated for that ticker) into `portfolioGrowthResults`.

Sequential, not `Promise.all`-parallel — deliberately, to respect §11.2's per-provider rate limits (Alpha Vantage 5/min) the same way concurrent multi-ticker fetches would risk violating.

This reuses 100% of §11's tested, calibrated logic (including the §11.9 fixes — insufficient-history handling, goodwill's real unavailability, etc.) with zero modification to any growth-authenticity file. The only new code is the loop and the per-ticker state threading.

### 12.4 State

```typescript
portfolioGrowthResults: z.array(GrowthAuthenticityResultSchema).nullable().default(null),
portfolioScanErrors: z.array(z.string()).default([]),
```

Namespaced separately from `growthAuthenticity` (singular, owned by §11) per §4's extension contract — never reuse a field across capabilities or across a capability's own single-vs-multi call shapes.

### 12.5 Report writer's role

When `activeCapabilities` includes `"portfolio_scan"`, the report writer receives `portfolioGrowthResults` as a JSON array (one entry per analysed ticker, same shape as §11's single-ticker DATA block) and is prompted to:

- State each ticker's classification and headline evidence separately.
- Optionally group tickers that share a classification for readability (e.g. "Two of these look organically driven: ...").
- Never compute, state, or imply a combined "portfolio score" or an arithmetic average across tickers — the same absolute constraint §1/§9 already apply to a single report, restated for N of them at once. When `tickerComparison` is populated (§12.8, 2+ tickers only), the report writer MAY state its computed `overallVerdict` and the per-metric ranks it contains — that is a deterministic, disaggregated comparison, not a blended score, and is the one narrow exception this rule now carves out (§9.1).

### 12.6 Validator's role

Extends the existing per-report checks (§11.7) to iterate over `portfolioGrowthResults`: each ticker's classification must be stated in the draft, and each ticker's cited figures must trace back to that ticker's own entry in the array — not cross-matched against a different ticker's numbers in the same report.

When `tickerComparison` is populated, the validator additionally confirms the draft states `tickerComparison.overallVerdict.verdict` (and, when non-null, `strongerTicker`) plainly — the same "was the computed conclusion actually narrated" check §11.7/§12.6 already run for `classification`, extended to this second kind of computed verdict (`checkComparativeVerdictNarrated` in `validator.ts`).

### 12.7 Edge cases

- Fewer than the cap named: analyse all of them, no capping note needed.
- More than the cap named: analyse the first `PORTFOLIO_SCAN_TICKER_CAP` in the order named, note the rest skipped in `portfolioScanErrors`.
- Zero tickers named (bare "my portfolio" phrasing): honest "name the tickers" message, no LLM call, no node run.
- A ticker within the batch resolves to `insufficient_data`/`not_computable` (§11.8's existing per-ticker edge cases): that ticker's entry in `portfolioGrowthResults` carries the honest label; it does not block or skip the other tickers in the same batch.

### 12.8 Ticker comparison (resolved decision — added after the anti-blending rule was deliberately narrowed, see §9.1)

**Trigger:** automatic whenever `portfolio_scan` runs with `tickers.length >= 2` after the §12.2 cap is applied. With exactly one ticker, `tickerComparison` stays `null` — there is nothing to compare.

**What it adds, on top of the existing §12.3 per-ticker growth-authenticity results:** a SECOND, broader per-ticker data pull — the company-snapshot capability's three deterministic compute functions (§13.3–§13.6: `computeCompanyProfile`, `computeValuationMetrics`, `computeFinancialHealth`) — driven internally, once per compared ticker, via the exact same "synthetic per-ticker state slice, outside the graph's own channels" pattern §12.3 already established for growth-authenticity's five nodes. This is the single shared data layer §13.1 refers to: one set of fetchers and compute functions, consumed two ways — by `company_snapshot`'s own orchestrator (§13.7), and by this node — for the same reason §13 exists at all (a "small handful of tickers" question and a "compare 2+ tickers" question need the same facts).

Nothing computed here is written to `state.companySnapshots` — that field stays exclusively owned by the `company_snapshot` capability (§4's never-share-a-field rule), exactly as §12.3 already keeps its own internal five-node loop from ever touching `state.growthAuthenticity`.

**The decision table** (`classifyTickerComparison` in `ticker-comparison.ts`, modelled directly on `classifyGrowthAuthenticity` in `growth-classification.ts` — a fixed table over counted/categorical inputs, never an arithmetic blend of the underlying numbers, per §9.1):

1. Build the comparison metric set: `revenue_growth_pct` (from each ticker's already-computed `portfolioGrowthResults[i].revenueGrowth.revenueGrowthPct`, higher = favourable) plus the 4 valuation metrics and 6 financial-health metrics from each ticker's freshly-computed company-snapshot data (§13.5, §13.6) — 11 candidate metrics total, each with a fixed, documented `higherIsBetter` direction (lower is favourable for every valuation multiple and for `debt_to_equity`; higher is favourable for everything else). Price change and the price/revenue discrepancy are DELIBERATELY EXCLUDED from this set — see §9.1's rationale.
2. A metric only counts toward `comparableMetricCount` if EVERY compared ticker has a non-null computed value for it. A ticker with `insufficient_data`/`not_computable` on a metric does not force a guess — it simply removes that metric from the comparison (the same "a missing signal is honest" principle as §5.9(b)/§11.9(b), applied here to which metrics are eligible to be counted at all, not to a single value).
3. For each comparable metric, the ticker with the more favourable value gets one "win"; a tie (values within the metric's own reported precision) awards NO win to either ticker, rather than forcing an arbitrary tiebreak.
4. `winCounts` is tallied per ticker. Let `topCount` be the highest tally and `runnerUpCount` the second-highest (0 if fewer than 2 tickers have any wins).
5. `comparableMetricCount === 0` → `verdict: "insufficient_comparable_data"`, `strongerTicker: null`.
6. `topCount === 0` (every comparable metric tied) → `verdict: "no_clear_leader"`, `strongerTicker: null`.
7. `topCount === runnerUpCount` (the top spot is itself tied between two or more tickers) → `verdict: "no_clear_leader"`, `strongerTicker: null`.
8. `(topCount - runnerUpCount) / comparableMetricCount >= CLEAR_LEAD_THRESHOLD` (constant, `0.5` — the leading ticker won more than half the comparable metrics more than the runner-up did) → `verdict: "clear_lead"`, `strongerTicker` = the top ticker.
9. Otherwise → `verdict: "narrow_lead"`, `strongerTicker` = the top ticker, and the report-writer prompt is told to hedge the framing ("edges out", not "is clearly stronger than").

**State:**

```typescript
tickerComparison: TickerComparisonResultSchema.nullable().default(null),
```

Added to the EXISTING §12.4 portfolio-scan state block — not a new block, since this is owned by the same capability. Errors reuse the existing `portfolioScanErrors` field (same rationale growth-authenticity already uses one `growthCheckErrors` field across all five of its nodes — this is a within-capability reuse, not the across-capability reuse §4 forbids).

### 12.9 Resolved notes — ticker comparison (placeholder, to be filled after live calibration, mirroring §5.8/§9.1/§11.9/§13.11)

Not yet calibrated against real multi-ticker data. Once run, record here: whether `CLEAR_LEAD_THRESHOLD = 0.5` produces a sensible mix of `clear_lead`/`narrow_lead`/`no_clear_leader` outcomes on real tickers, and whether the tie-tolerance band chosen for step 3 above is too tight or too loose against real valuation-multiple precision (these tend to carry more decimal noise than a price % figure).

---

## 13. Capability spec: company sector snapshot (fully formed — build this fourth)

### 13.1 Goal

§11 (growth-authenticity) answers one narrow question — "is this ticker's growth real" — for one ticker. This capability answers a much broader class of question about one ticker (or a small handful): "how is NVDA valued against its peers", "is AAPL's balance sheet healthy", "give me NVDA's key stats" — anything a user might ask that is bounded by a ticker (or a few) but not shaped like the single growth-authenticity question. It is deliberately a SEPARATE intent/capability from `single_report` (growth-authenticity), NOT a broadening of it, so that an ordinary "is NVDA's growth real" question does not pay this capability's extra API cost every time (§1's budget constraint).

Produces, per analysed ticker: general company facts (sector, market cap, key stats), valuation multiples compared to sector peers, and financial-health ratios compared to sector peers — each kept fully disaggregated, per-metric, never blended into one "valuation score" or "health score" (§9's rule, unchanged and NOT part of the §9.1 carve-out, which applies only to the cross-ticker verdict in §12.8, not to blending a single company's own metrics together).

**This capability's data layer is intentionally shared with §12.8's ticker-comparison node.** The three compute functions in §13.3–§13.6 are plain functions (not LangGraph nodes — see §13.7's note on why), called both by this capability's own orchestrator (§13.7) for a `company_snapshot` report, and internally by `ticker-comparison.ts` (§12.8) when 2+ tickers are named under `portfolio_scan`. One data-collection layer, two consumers.

Triggered by `intent === "company_snapshot"` (new enum value). Bounded to `COMPANY_SNAPSHOT_TICKER_CAP = 5` tickers (own constant, not shared with `PORTFOLIO_SCAN_TICKER_CAP` — same value today, but capability-owned per §3's containment rule). Extra tickers beyond the cap: noted in `companySnapshotErrors` and skipped, same "note and skip" pattern as §11.1/§12.2.

### 13.2 Data sources and roles

| Source | Role | Free-tier limit to respect |
| --- | --- | --- |
| `yahoo-finance2`, `quoteSummary` with `modules: ["assetProfile","summaryDetail","defaultKeyStatistics","financialData"]` | ONE combined call per ticker returning: sector/industry/employees (`assetProfile`), trailingPE/forwardPE/marketCap/dividendYield/beta/52-week range (`summaryDetail`), enterpriseValue/priceToBook/sharesOutstanding (`defaultKeyStatistics`), debtToEquity/currentRatio/returnOnEquity/profitMargins/ebitda/freeCashflow/totalRevenue/revenueGrowth (`financialData`) | No key, no documented limit — cache 24h (§13.2a) |
| Alpha Vantage `ETF_PROFILE` (via the EXISTING `tools/etf-holdings.ts`, unmodified) | Peer sample for a ticker's sector, reusing §5.4/§5.8(b)'s authoritative holdings source | 25/day, 5/min, 7-day cache — dedup'd per sector, same cache key growth-authenticity's `sector-benchmark.ts` already uses (§13's rate-limit note) |
| `yahoo-finance2`, same combined `quoteSummary` call, per PEER ticker | The peer distribution valuation/health metrics are z-scored against | No key, no documented limit — same 24h cache namespace as the target ticker's own call |

No new Finnhub usage. Sector resolution reuses `fetchCompanySector` (Yahoo `assetProfile`) + a LOCAL copy of `mapYahooSectorToGics`/`YAHOO_SECTOR_TO_GICS` (§13.4) — Finnhub's `stock/profile2` is not used here, mirroring `sector-benchmark.ts`'s own existing choice, not a new decision. If live calibration (§13.11) finds Yahoo's valuation/health coverage too sparse for some listings, Finnhub's `stock/metric` endpoint (60/min, unused headroom) is the natural documented fallback to add — deferred, not built speculatively (§1).

**(a)** One combined `quoteSummary` call fetches all four modules at once — cheaper than four separate calls. Cached under a NEW namespace, `"company_fundamentals_snapshot"`, TTL 24h — a deliberate single TTL for a genuinely mixed-cadence payload (`trailingPE`/`marketCap` move daily with price; `debtToEquity`/`returnOnEquity` only change quarterly); splitting the cache TTL per sub-field would mean splitting the underlying API call back into four to cache them independently, undoing the combined-call saving. 24h matches the fastest-moving fields in the bundle and is a harmless (if occasionally unnecessary) re-fetch for the slow-moving ones.

### 13.3 `company-profile.ts` — `computeCompanyProfile(ticker, now)` (deterministic, no LLM)

Plain function, NOT a LangGraph node (see §13.7 for why). Calls the combined `fetchCompanyFundamentalsSnapshot(ticker)` (new function, §13's tools section) and extracts, unmodified, un-peer-compared: `sector` (mapped GICS, via the local `mapYahooSectorToGics` copy), `industry` (Yahoo's raw string, unmapped — kept alongside the GICS sector because it's more specific and a user may ask "what industry, not just sector"), `marketCap`, `fullTimeEmployees`, `beta`, `dividendYieldPct`, `fiftyTwoWeekLow/High`, `trailingEps`/`forwardEps`, `analystTargetMeanPrice`, `analystRecommendationKey`, and `reportedRevenueGrowthPct` — Yahoo's own `financialData.revenueGrowth` figure, LABELLED DISTINCTLY from growth-authenticity's `revenueGrowth.revenueGrowthPct` (§11.3), because the two are computed differently (Yahoo's own trailing figure vs. this codebase's own YoY-quarterly computation from raw `fundamentalsTimeSeries` data) and CAN legitimately disagree. Never presented as if they were the same number — the report-writer prompt for this capability states which is which whenever both are in context (a `followup` thread that has both `growthAuthenticity` and `companySnapshots` populated).

Returns `{ result: CompanyProfileFacts | null, errors: string[] }`. Missing fields degrade to `null` per-field (§5.7/§11.8's established honesty convention) — never fabricated, never silently omitted from the object shape.

### 13.4 `peer-sample.ts`

`resolvePeerSample(ticker, now): Promise<{ sector: string | null; peers: string[]; errors: string[] }>`

Resolves the ticker's GICS sector (via `fetchCompanySector` + a LOCAL `mapYahooSectorToGics`/`YAHOO_SECTOR_TO_GICS` — duplicated from `growth-authenticity/sector-benchmark.ts` DELIBERATELY, per §3's containment rule and the exact "duplicate until a third consumer appears" policy `growth-authenticity/stats.ts`'s own header states — company-snapshot is only the SECOND consumer of this ~15-line table, so duplicating it here is the policy-consistent choice, not an oversight), then fetches that sector's ETF holdings via the EXISTING `tools/etf-holdings.ts::fetchEtfHoldings` (unmodified — same Alpha-Vantage-primary/Yahoo-fallback tool `sector-benchmark.ts` already uses), and returns up to `PEER_SAMPLE_SIZE = 10` heaviest peers (own local constant — NOT imported from `sector-benchmark.ts`'s identically-named-and-valued constant, same containment reasoning). Re-exported via `index.ts` alongside the three compute functions below, because `ticker-comparison.ts` (§12.8, in the portfolio-scan capability folder) needs the same sector/peer resolution — not part of the report-writer/validator-facing surface, just a second internal consumer.

### 13.5 `valuation-metrics.ts` — `computeValuationMetrics(ticker, sector, peers, now)` (deterministic, no LLM)

For the target ticker AND each of up to 10 peers: fetch the combined fundamentals snapshot (§13.2, same cache namespace, so peers already fetched by a prior request are free). Extract 4 metrics: `trailing_pe`, `forward_pe`, `price_to_book`, and `ev_to_ebitda` (COMPUTED — `enterpriseValue / ebitda`, guarded: `null` if `ebitda` is missing or `<= 0`, since a negative/zero EBITDA multiple has no meaningful interpretation, the same guard style `price-revenue-discrepancy.ts` already applies to its own ratio).

Each metric is z-scored (robust median/MAD — via the shared `apps/server/src/lib/stats.ts` module, §13's implementation notes) against the peer sample's SAME metric, producing a `flag` from the existing `ROBUST_Z_THRESHOLD` cutoff (reused, not a new constant): `"favorable_vs_peers"` / `"unfavorable_vs_peers"` / `"in_line_with_peers"` / `"not_computable"` (insufficient peer data). ALL FOUR VALUATION METRICS use `higherIsBetter: false` — LOWER means cheaper-than-peers, which is labelled `"favorable_vs_peers"`. The report-writer prompt is explicitly told this means "trades at a discount/premium to peers", never "good/bad" — cheap is not unconditionally good, and this capability must not imply it is.

Writes nothing to graph state directly (plain function) — returns `{ result: ValuationMetricsResult | null, errors: string[] }`, consumed by whichever orchestrator called it (§13.7 or §12.8).

### 13.6 `financial-health.ts` — `computeFinancialHealth(ticker, sector, peers, now)` (deterministic, no LLM)

Same shape as §13.5, for 6 metrics: `debt_to_equity` (`higherIsBetter: false`), `current_ratio`, `return_on_equity`, `return_on_assets`, `profit_margin` (all `higherIsBetter: true`), and `fcf_margin` (COMPUTED — `freeCashflow / totalRevenue`, guarded null if `totalRevenue <= 0` or missing, `higherIsBetter: true`).

### 13.7 `company-snapshot-scan.ts` — `companySnapshotScanNode` (the ONLY node this capability registers in `graph.ts`)

**Deliberate deviation from the growth-authenticity precedent, stated explicitly so it is not mistaken for an inconsistency:** growth-authenticity registers FIVE separate chained nodes in `graph.ts` because those five ARE the real single-ticker graph path for `single_report`. Company-snapshot has no such single-ticker chain to begin with — §13.1 already scopes it to "a ticker or a small handful", so it needs the loop-over-tickers shape from day one, the same shape `portfolio-growth-scan.ts` already uses for exactly that reason. Building a 3-node chain here and then immediately wrapping it in a loop (as ticker-comparison would also need) would be pure indirection. So: §13.3–§13.6 are plain functions, not nodes; this file is the one real `(state, now, config) => Promise<Partial<AgentState>>` node, directly mirroring `portfolioGrowthScanNode`'s own shape and cap/skip/degrade logic (§12.2/§12.7) applied to this capability's own ticker cap.

For each of up to `COMPANY_SNAPSHOT_TICKER_CAP` tickers (sequential, not parallel — same rate-limit discipline §12.3 already established): resolve the peer sample once (§13.4), then run `computeCompanyProfile`, `computeValuationMetrics`, `computeFinancialHealth`, assemble one `CompanySnapshotResult`, push to `companySnapshots`.

READS `tickers`, `timeWindow`. WRITES `companySnapshots`, `companySnapshotErrors`.

### 13.8 Report writer's role

When `activeCapabilities` includes `"company_snapshot"`, the report writer receives `companySnapshots` (one entry per analysed ticker) as JSON and is prompted to:

- Answer the user's actual question first, using whichever subset of profile/valuation/financial-health facts is relevant, rather than reciting all three sections regardless of what was asked.
- Present each valuation/financial-health metric's `flag` using the "discount/premium to peers" framing (§13.5), never "good/bad" or "cheap/expensive" as an unqualified verdict.
- Never combine metrics into one score (§9, unchanged — this capability is NOT covered by the §9.1 carve-out, which applies only to §12.8's cross-ticker verdict).
- Distinguish `companySnapshots[].profile.reportedRevenueGrowthPct` from `growthAuthenticity.revenueGrowth.revenueGrowthPct` by name whenever both are present in context (a `followup` thread), per §13.3.

### 13.9 Validator's role

`collectCompanySnapshotKnownValues(companySnapshots)`, parallel in shape to `collectGrowthKnownValues`/`collectPortfolioScanKnownValues`: every ticker plus every numeric field across `profile`/`valuation.metrics[].value`/`valuation.metrics[].peerMedian`/`valuation.metrics[].zScore` and the financial-health equivalents, merged into `validator.ts`'s existing known-value union.

### 13.10 Edge cases

- A ticker with thin/no fundamentals coverage (ADR, recent IPO, non-US listing): `computeCompanyProfile`/`computeValuationMetrics`/`computeFinancialHealth` each degrade their own null fields honestly (§5.9(b)/§11.9's principle) rather than throwing; the ticker still gets an entry in `companySnapshots` with whatever was computable.
- Fewer than `PEER_SAMPLE_SIZE` peers resolvable (a niche sector, or Alpha Vantage quota exhausted so `fetchEtfHoldings` degrades to Yahoo's top-10 — §5.8(b), unmodified): z-scores fall back to `not_computable` below a minimum peer-count threshold (reuse the shared stats module's existing minimum-sample-size convention, applied to peer count instead of quarter count), noted in `companySnapshotErrors`.
- More than the cap named: analyse the first `COMPANY_SNAPSHOT_TICKER_CAP`, note the rest skipped (§11.1/§12.2/§12.7's established pattern).
- `ev_to_ebitda`/`fcf_margin` not computable (negative/zero denominator): `not_computable`, never a nonsensical negative multiple.

### 13.11 Resolved notes (placeholder — fill in after live calibration, same discipline as §5.8/§11.9/§12.9)

Not yet calibrated against real tickers. Once run, record here: whether Yahoo's `quoteSummary` coverage for the four modules is as reliable live as `fundamentalsTimeSeries` was NOT (§11.9(a) found the latter capped at ~5 quarters regardless of request — this combined call may have its own undocumented quirks worth a live check before trusting it silently); whether the reused `ROBUST_Z_THRESHOLD` (itself still uncalibrated per §11.9's own "still open" note) behaves sensibly on peer-relative valuation data specifically.

---

## 14. Capability spec: technical analysis and trading-strategy suggestions (fully formed, built)

### 14.1 Goal

Given a ticker, a few tickers, or a sector, produce a deterministic technical-analysis trading-strategy suggestion — "wait for X to reach $Y, enter, stop-loss at $Z, take-profit at $W" — with every number traceable to code, never an LLM guess. This is the same non-negotiable rule §1 states for every capability, but it matters more here than anywhere else in the codebase: this is the only capability whose output is a literal price a reader could act on directly, not just a classification label or a peer-relative flag.

Triggered by `intent === "technical_analysis"` (new enum value). Unlike `single_report`/`portfolio_scan`'s ticker-count split, this capability explicitly supports a ticker, several tickers, or a sector — the same request shape whether one or several targets are named — because the underlying computation (fetch bars, run indicators, classify a stance, compute two independent level sets) is identical per target regardless of how many are named.

A user asking "is NVDA's growth real" wants §11's narrower question; a user asking "when should I buy NVDA, and where's my stop" wants this capability. The two are deliberately separate intents (mirrors §13.1's reasoning for why `company_snapshot` is not a broadening of `single_report`) so an ordinary growth-authenticity or company-snapshot question never pays this capability's computation cost, and vice versa.

**Explicitly NOT statistical/ML price forecasting.** This capability produces rule-based technical-analysis signals (moving averages, momentum, support/resistance, volatility) and formula-driven price levels derived from them — not a probability-weighted price prediction. That distinction is deliberate, not a limitation stated apologetically: a forecasting model's output has no natural place in this architecture's "the LLM never computes a number, only deterministic code does" contract, whereas classic technical-analysis indicators are themselves pure, deterministic transforms of historical price data — exactly the kind of computation this codebase already trusts.

### 14.2 Data sources and roles

| Source | Role | Free-tier limit to respect |
| --- | --- | --- |
| `yahoo-finance2`, `fetchConstituentOhlcv`/`fetchSectorEtfHistory` (`tools/yahoo-finance.ts`, UNMODIFIED) | Full daily OHLCV (open/high/low/close/volume) for a ticker or a sector ETF — the ONLY data this capability needs | No key, no documented limit — already cached 24h under the EXISTING `daily_ohlcv`/`sector_price_history` namespaces (§6) |

**Zero new external calls, zero Alpha Vantage spend.** Every prior capability in this codebase spent some of the 25/day Alpha Vantage quota (§5's cross-check, §11's sector benchmark, §13's peer-sample holdings). This one does not — full OHLCV was already being fetched for the industry-trend capability, and every indicator/support-resistance computation this capability needs is a pure function of that same data. Verified live (§14.15): a calibration run covering two tickers and one sector ETF made exactly 3 Yahoo calls and zero Alpha Vantage calls.

Sector requests resolve to that sector's own ETF (e.g. Technology → XLK) via the EXISTING `SECTOR_ETF_TO_GICS` map (`tools/yahoo-finance.ts`, unmodified, reused directly — not duplicated, since it already lives in the shared tools layer and is already imported by three other files).

### 14.3 Node: `resolve-targets.ts` — ticker vs. sector→ETF resolution (deterministic)

`resolveTechnicalAnalysisTargets(tickers, sectors)`. Tickers named take priority; sectors are only resolved when zero tickers were named (mirrors the "note and skip" cap pattern of §11.1/§12.2/§13.1, now applied to a priority rule instead of a cap). Capped at `TECHNICAL_ANALYSIS_TICKER_CAP = 5` (own constant, not shared with the other `*_TICKER_CAP`s, per §3's containment rule); extras beyond the cap are noted in `technicalAnalysisErrors` and skipped.

### 14.4 Node: `indicator-snapshot.ts` / `lib/technical-indicators.ts` (deterministic, no LLM)

`lib/technical-indicators.ts` is a new shared math library (placed in `lib/` alongside `stats.ts` rather than capability-local, for the same reason `stats.ts` itself lives there: pure, capability-agnostic numeric code with multiple internal consumers from day one): SMA, EMA, RSI (Wilder smoothing), MACD, ATR (Wilder smoothing), Bollinger Bands, plus fractal swing-point detection and level clustering (§14.6).

`indicator-snapshot.ts` runs this library over a target's fetched bars (using `adjclose ?? close`, the same convention `sector-leaders.ts` already established) and keeps only the LAST value of each series — the point-in-time snapshot. **Degrades per-field, not as a whole object**: `sma200` needs far more history than `rsi14`, so a target with, say, 60 usable bars has a real `rsi14`/`sma20` while `sma200` alone stays `null` — the same per-field-null convention `CompanyProfileFacts` already uses (§13.3).

Indicator periods (SMA 20/50/200, EMA 12/26, MACD signal 9, RSI 14, ATR 14, Bollinger 20/2) are industry-standard defaults — see §14.15.

### 14.5 Node: `market-context.ts` — trend/momentum/volatility flags (deterministic)

Three independent, documented formulas, each producing a categorical LABEL — mirrors `classifyQuadrant`/`classifyGrowthAuthenticity`'s "the only thing produced is a label" discipline, extended here to flags that feed a LATER decision table rather than being the final output themselves:

- `computeTrendDirection`: `close > sma50 > sma200` → `"uptrend"`; the mirror ordering → `"downtrend"`; anything else (including a crossed/tangled ordering) → `"sideways"`; any of the three missing → `"insufficient_data"`.
- `computeMomentumDirection`: `rsi14 >= RSI_OVERBOUGHT` → `"overbought"`; `<= RSI_OVERSOLD` → `"oversold"`; otherwise `"neutral"`; missing `rsi14` → `"insufficient_data"`.
- `computeVolatilityLevel`: today's ATR, as a percent of price, compared to its own trailing history via the EXISTING `lib/stats.ts::robustZScore` (reused, not reimplemented) — `"high"`/`"low"` at `|z| >= VOLATILITY_Z_THRESHOLD`, else `"normal"`.

**`volatilityLevel` is DELIBERATELY NOT an input to `stance-classification.ts` (§14.9).** It is presented alongside trend/momentum as context only — the same role `relativeVolume` plays relative to the weight/speed quadrant (§5.4: "a SECONDARY confirmation signal ... never an input to the quadrant").

### 14.6 Node: `support-resistance.ts` — swing detection + level clustering (deterministic)

`detectSwingPoints` (lib): a bar is a swing high/low when its high/low is the extreme across `SWING_LOOKBACK_BARS` bars on EACH side — the standard fractal method. `clusterLevels` (lib): merges swing points within `SR_CLUSTER_TOLERANCE_PCT` (relative, not absolute) of each other into one level, price = the mean of the merged points, `touches` = how many merged.

**Support/resistance classification is a CAPABILITY-LAYER decision, not a library one.** `clusterLevels` returns raw merged price levels with no support/resistance label; `support-resistance.ts` splits them by comparing each level's price to the CURRENT price at call time — a level is "support" only because it currently sits below where the stock trades, which is a fact about the moment, not about the price history alone. This is why the classification cannot live in the price-agnostic `lib/technical-indicators.ts`.

**Clarification, so this is never mistaken for a §9 violation:** computing `stopLoss = nearestSupport - ATR_STOP_MULTIPLE * atr14` (§14.7) is a SINGLE DOCUMENTED FORMULA over one already-selected level and one already-computed indicator value — the same category as `ev_to_ebitda = enterpriseValue / ebitda` (§13.5), not "blending independent signals into a score." What §9 actually forbids never happens here: `trendDirection`/`momentumDirection` combine only into the `stance` LABEL via §14.9's ordered table, never into an arithmetic figure; and the two trade-level methodologies (§14.7, §14.8) stay two permanently separate objects, never merged into one "the stop-loss."

### 14.7 Node: `trade-levels-atr.ts` — ATR methodology (deterministic)

Confirmed product decision: TWO independently-computed, always-disaggregated stop-loss/take-profit methodologies, never merged. This is the volatility-adjusted one:

- Bullish setup: `entry` = nearest support; `stopLoss = entry - ATR_STOP_MULTIPLE * atr14`; `takeProfit = entry + ATR_RISK_REWARD_MULTIPLE * (entry - stopLoss)`.
- Bearish setup: the mirror image off the nearest resistance.
- Every field degrades to `null` (never guessed) when its precondition is missing — same "a missing signal is honest" principle as §5.9(b)/§11.9(b), applied here to a PRICE rather than a classification flag.

### 14.8 Node: `trade-levels-swing.ts` — swing methodology (deterministic)

The price-structure-only counterpart: stop = just beyond the nearest RAW swing point (not a clustered level — the point the support/resistance level itself was built from) via `SWING_STOP_BUFFER_PCT`; target = the next detected level in the trade's direction (nearest resistance for a bullish setup, nearest support for a bearish one).

**The qualitative point of difference from the ATR method:** `takeProfit` is genuinely `null` when no further level was detected — NOT a fallback formula. A `null` target here is real information ("price structure gives no target"), and papering over it with a formula would quietly turn this from a second, independent methodology into a disguised copy of the first.

### 14.9 Node: `stance-classification.ts` — decision table (deterministic)

```
THE ONE RULE THIS FILE EXISTS TO ENFORCE

classifyTechnicalStance is an ORDERED IF/ELSE CHAIN over two categorical
flags (trendDirection, momentumDirection) — NOT a cross-product lookup
table, and no line adds/multiplies/averages a number. Mirrors
classifyGrowthAuthenticity exactly: the only thing produced is a LABEL.
```

Order matters, and is deliberate:

1. Either input `insufficient_data` → the whole stance is `insufficient_data`.
2. `uptrend` + NOT `overbought` → `bullish_setup` (a trend already moving up, with momentum that has not already spent itself — the textbook pullback/continuation setup). `uptrend` + `overbought` deliberately does NOT qualify — buying into an overbought reading inside an uptrend is exactly the setup most likely to mean-revert against the trade.
3. `downtrend` + NOT `oversold` → `bearish_setup`, the mirror image.
4. Anything else (a `sideways` trend, or a trend directly contradicted by an exhausted momentum reading) → `neutral_no_setup` — an honest "no trade here" rather than forcing a direction.

### 14.10 Node: `technical-analysis-scan.ts` — the ONE orchestrator node

Same deliberate deviation from growth-authenticity's five-node chain that `company-snapshot-scan.ts`/`portfolio-growth-scan.ts` already make, for the same reason (§13.7): this capability is scoped to "a ticker, a few tickers, or a sector" from day one, so it needs the loop-over-targets shape immediately rather than a chain of graph nodes immediately wrapped in a loop. Every other file in this capability's folder is a plain function, not a node.

Sequential over targets (not `Promise.all`) — the same one-thing-at-a-time discipline every other multi-item loop in this codebase uses. A per-target failure (fetch error, or fewer than `MIN_BARS_FOR_INDICATORS` usable bars — the recent-IPO-style edge case, §14.14) degrades that target's entry to an honest `insufficient_data` result, never the whole batch (§8).

READS `tickers`, `sectors`, `timeWindow`. WRITES `technicalAnalysis`, `technicalAnalysisErrors`.

### 14.11 State

```typescript
technicalAnalysis: z.array(TechnicalAnalysisResultSchema).nullable().default(null),
technicalAnalysisErrors: z.array(z.string()).default([]),
```

`TechnicalAnalysisResultSchema` carries: `symbol`, `requestedAs` (`"ticker"` | `"sector_etf"`), `sectorName` (populated only for the latter), the full `IndicatorSnapshot`, `trendDirection`/`momentumDirection`/`volatilityLevel`, `supportLevels`/`resistanceLevels` (nearest-first), `atrLevels`/`swingLevels` (two permanently separate `TradeLevels` objects), `stance`, and `stanceReasonCodes`.

`intent` enum gains `"technical_analysis"`.

### 14.12 Report writer's role

When `activeCapabilities` includes `"technical_analysis"`, the report writer receives one entry per analysed symbol (indicators, flags, both level sets) and is prompted to:

- State the computed `stance` plainly, explained using ONLY `trendDirection`/`momentumDirection` — never independently judge the setup or propose a different one.
- **ALWAYS present `atrBasedLevels` and `swingBasedLevels` as two distinct, separately labelled sections** — even when they happen to roughly agree. Never merge them into one "the stop-loss is X" statement.
- **Prefix every specific price level with a `"$"` sign**, exactly as computed — the prompt-side half of §14.13's dedicated dollar-figure verification.
- Never invent a level when the computed value is `null` — state plainly why, using the field's own `basisNote`.
- No new arithmetic — no reward:risk math of its own, no averaging the two methodologies together.

### 14.13 Validator's role

`collectTechnicalAnalysisKnownValues()` folds every analysed symbol and its indicator/level numbers into the existing known-value union (§5.6), same shape every other `collectX` function already has.

**Three checks specific to this capability, beyond the generic ones:**

- `checkSymbolNarrated()` — the draft must literally name the symbol. Necessary because `TICKER_STOPWORDS` (`validator.ts`) already exempts all 11 sector ETF tickers from the generic unknown-ticker check (added so ordinary prose mentioning an ETF wasn't flagged as an unknown company) — harmless while an ETF was never itself the analysed subject. This capability makes a sector-ETF result's `symbol` genuinely the thing being analysed, so the generic check can no longer catch a report naming the WRONG ETF. A trade level attributed to the wrong symbol is actively dangerous, not just mislabelled, which is why this gets a dedicated check rather than relying on the pre-existing mechanism.
- `checkStanceNarrated()` — per symbol, mirrors `checkClassificationNarrated` (§11.7).
- `checkBothMethodsLabeled()` — a mechanical backstop for the "never merge the two methodologies" prompt instruction: when a methodology actually produced a non-null stop-loss, its own keyword ("ATR"/"average true range", or "swing") must appear somewhere in the draft.

**A fourth, capability-wide check closes a gap the existing numeric-verification machinery did not have:** `checkPriceLevelsCited()` plus `extractDollarAmounts()`/`PRICE_RELATIVE_TOLERANCE`. The EXISTING check 2 (`extractPercentages`/`PERCENTAGE_TOLERANCE`) only ever looks for `%`-suffixed figures — company-snapshot's own non-percentage numeric fields (beta, EPS, market cap) already sit outside what that check verifies, a pre-existing gap this codebase had accepted. This capability's headline output is a DOLLAR price a reader could act on directly — the one output in this codebase worth closing that gap for specifically. `PRICE_RELATIVE_TOLERANCE` (0.5%) is RELATIVE, not absolute like `PERCENTAGE_TOLERANCE`, because a $500 stock and a $5 stock need different absolute rounding allowances for the same two decimal places.

`TICKER_STOPWORDS` also gained `RSI`/`MACD`/`ATR`/`SMA`/`EMA` — legitimate technical-analysis vocabulary a report will routinely contain ("ATR-based levels"), not company tickers. Found immediately on writing the first integration test — without it, every technical-analysis report would fail check 1 for "citing" a nonexistent ticker called "ATR".

**Check 3 (the empty-report guard) needed a matching adjustment.** It originally required at least one cited percentage whenever computed data existed, on the assumption every capability's headline numbers are percentages. This capability's are dollar prices, so a well-formed report can legitimately cite zero `%` figures. Fixed by accepting EITHER a cited percentage OR (when technical-analysis ran) a cited dollar figure — verified live: before the fix, every correct technical-analysis report failed this check.

### 14.14 Edge cases

- A target with fewer than `MIN_BARS_FOR_INDICATORS` usable bars (recent IPO, thin listing): the WHOLE result for that target is `insufficient_data` — stance, both level sets, every indicator — rather than a half-populated object. Distinct from `MIN_BARS_FOR_SMA200`, which degrades only that one field (§14.4) while the rest of the snapshot still resolves.
- `neutral_no_setup`/`insufficient_data` stance: both trade-level methodologies stay `null` by construction (§14.7/§14.8) — there is no support/resistance-anchored entry to build a level from when the stance isn't directional.
- A `sideways` trend with either momentum reading: `neutral_no_setup`, not a forced direction. Verified live (§14.15): COST, in a sideways trend on the calibration date, correctly produced `neutral_no_setup` with both level sets `null` and an honest `basisNote` — not a guessed level.
- Swing-based `takeProfit` with no further level detected: stays `null`, never a fallback formula (§14.8).
- A ticker AND a sector both named in one request: ticker wins (§14.3) — the sector is silently not analysed, no error, since naming both is itself ambiguous and ticker-priority is the documented resolution.
- More than `TECHNICAL_ANALYSIS_TICKER_CAP` targets named: analyse the first five, note the rest skipped (§11.1/§12.2/§13.1's established pattern).

### 14.15 Resolved notes (added after live calibration via `scripts/calibrate-technical-analysis.ts`)

Calibrated against NVDA (steady large-cap uptrend), COST (sideways/neutral case), and the Information Technology sector ETF (XLK), via `npx tsx scripts/calibrate-technical-analysis.ts NVDA COST sector:"Information Technology"`.

**(a) `INDICATOR_LOOKBACK_WINDOW="2y"` reliably returns real, deep history from Yahoo's `chart` endpoint — unlike §11.9(a)'s `fundamentalsTimeSeries` surprise.** All three targets resolved `sma200` (needing ~200 real trading days) without issue; this is the SAME `chart` endpoint `sector-leaders.ts`/`sector-trend.ts` already prove reliable at scale, not a new, unverified code path. No depth-capping surprise analogous to the quarterly-fundamentals endpoint's ~5-quarter ceiling was observed.

**(b) `ATR_STOP_MULTIPLE=1.5`/`ATR_RISK_REWARD_MULTIPLE=2` produce sane, non-degenerate stop distances proportional to real volatility, not fixed percentages.** NVDA: ATR14≈$7.11 on a ~$217 stock (≈3.3% of price) gave a stop ≈4.9% below entry and a target maintaining the 2:1 reward:risk ratio exactly (verified by hand from the script's printed output: risk ≈$10.67, reward ≈$21.33). XLK: ATR14≈$4.67 on a ~$180 ETF (≈2.6% of price) gave proportionally tighter levels. Both plausible for their respective volatility, neither degenerate (no zero/negative distances, no absurdly wide bands).

**(c) The `neutral_no_setup` honesty path was observed live, not just in tests.** COST's real trend on the calibration date was `sideways` (its close sat between its 20/50/200-day averages in a crossed ordering) — the system correctly reported `neutral_no_setup` with BOTH trade-level sets `null` and a plain `basisNote`, rather than forcing a level off a support/resistance pair that existed but had no directional stance behind it. This is the live-data confirmation of §14.7/§14.8's null-degrade design, the same category of check §5.9(b) already modelled.

**(d) `SWING_LOOKBACK_BARS=5`/`SR_CLUSTER_TOLERANCE_PCT=1.0` produced sensible, distinct support/resistance ladders, not noise.** COST returned 5 clearly separated support levels with touch counts ranging 2–10 (not one degenerate mega-cluster, not dozens of near-duplicate levels one tolerance-percent apart). No adjustment indicated by this run.

**Still open — not yet observed:** every calibration run so far classified `volatilityLevel` as `"low"` on the sampled date; `VOLATILITY_Z_THRESHOLD=1` has not yet been checked against a real `"high"`-volatility reading (an earnings-day gap or a genuine volatility spike). Since `volatilityLevel` is context only and never feeds the stance decision table (§14.5), this does not block trusting the shipped behaviour, but the threshold itself carries the same "still open" status §11.9 records for `ROBUST_Z_THRESHOLD` until a live high-volatility case is captured.
