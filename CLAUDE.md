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
            stats.ts                  # local median/MAD robust z-score helper
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
      /fixtures                      # saved sample API responses for offline tests
    /scripts
      calibrate-growth-authenticity.ts # manual, real-API script — never run from tests (§11.9)
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
- Capabilities are added one at a time, each fully specified in its own §-section (§5, §11, ...) before being built. The growth-authenticity capability (§11) is the second; do not add a third speculatively — wait for it to be specified here first.
- Do not silently fall back to the "calmest" or most neutral-sounding classification/flag when a computation lacks the data to resolve it. §11.9 records a real incident: a missing baseline defaulted to `"aligned"` and hid a genuine ~12.6x price/revenue divergence on live data. Missing data gets its own honest label (e.g. `"insufficient_history"`, `"not_computable"`), never the label that happens to mean "everything looks fine."
- Do not call any external API from inside `report-writer.ts` or `validator.ts` — they only read from state.
- Do not skip the cache layer "just for testing" in a way that leaves uncached calls in the committed code.
- Do not put API keys or LLM calls in the `apps/web` React app — it is a pure client of `apps/server`'s HTTP API.

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
