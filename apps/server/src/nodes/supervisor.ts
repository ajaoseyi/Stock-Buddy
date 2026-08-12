/**
 * =============================================================================
 * supervisor.ts — turn the user's question into structured state.
 * =============================================================================
 *
 * The supervisor is the ONLY place in the graph where natural language becomes
 * structured fields. Everything downstream reads `intent`, `timeWindow` and
 * `sectors`; nothing downstream re-parses the user's text. That single-point
 * rule is what stops two nodes disagreeing about what was asked.
 *
 * `timeWindow`/`sectors`/`tickers` PARSING STAYS DETERMINISTIC (regex)
 * ----------------------------------------------------------------------
 * `timeWindow` decides the period every percentage in the report is measured
 * over. An LLM misreading "this month" as "1y" would silently change every
 * number downstream — the exact failure mode §4.1(b) refuses to accept from a
 * defaulted window. The vocabulary here (eleven sector names, a handful of
 * period phrasings) is small and exhaustively regex-testable, so there is no
 * reason to trade that away.
 *
 * `intent` CLASSIFICATION — RESOLVED NOTE: NOW LLM-DRIVEN
 * ----------------------------------------------------------------------
 * This used to be a pure regex (`SECTOR_TREND_SIGNALS` etc.), on the grounds of
 * determinism, testability, and free-tier cost. That held while there was one
 * capability. It broke down for two concrete reasons:
 *
 *   1. A hand-maintained keyword regex does not scale with capability count.
 *      Every new capability needs its own signal words, and the words start
 *      colliding — `SECTOR_TREND_SIGNALS` matched "best"/"worst"/"top"/"bottom"
 *      standalone, so an out-of-scope question containing any of those generic
 *      words could be misclassified as `sector_trend` and trigger the real
 *      Yahoo/Alpha Vantage/Finnhub capability chain before ever reaching the
 *      (correct) `general_chat` handling.
 *   2. Intent is a genuinely open-ended natural-language judgment — closer to
 *      "what is this message about" than to `timeWindow`'s closed vocabulary of
 *      period phrasings — which is exactly the kind of task a lookup table
 *      strains at and a model is built for.
 *
 * `classifyIntentLlm` below calls the model at temperature 0 with STRUCTURED
 * OUTPUT constrained to the closed `Intent` enum (reusing
 * `AgentStateSchema.shape.intent` so the allowed values can never drift from
 * the real type) and a FIXED prompt with FIXED few-shot examples — no free-text
 * labels, no per-request prompt variation. That does not make the call
 * provably deterministic the way a regex is, but it collapses the practical
 * variance to near zero while adding real semantic understanding, which is the
 * trade this file's design explicitly accepted. Pinning `GEMINI_MODEL` matters
 * more than temperature for reproducibility over time (see `llm.ts`).
 *
 * On any classification failure (both providers erroring, or a non-rate-limit
 * error) `supervisorNode` falls back to the original regex `classifyIntent`,
 * which is kept, unchanged, exactly for this. This is the same degrade-not-
 * crash convention used everywhere else in the codebase (§8): the LLM path
 * is primary, the regex path is a resilience net, not dead code.
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import { AgentStateSchema, type AgentState, type Intent } from "../state.js";
import { getLlm, isRateLimitError, type LlmProvider } from "../llm.js";
import { INDUSTRY_TREND_CAPABILITY_ID } from "./capabilities/industry-trend/index.js";
import { GROWTH_AUTHENTICITY_CAPABILITY_ID } from "./capabilities/growth-authenticity/index.js";
import { SECTOR_ETF_TO_GICS } from "../tools/yahoo-finance.js";
import { emitProgress } from "../streaming.js";

// =============================================================================
// SECTION 1 — Time window parsing
// =============================================================================

/**
 * Phrase → `timeWindow` value. Ordered longest-first at match time so that
 * "year to date" wins over a bare "year".
 *
 * The VALUES here must be strings `resolveWindowStart()` in
 * `tools/yahoo-finance.ts` understands — that function is the single authority
 * on what a window means, and this map only decides which one the user asked
 * for.
 */
const WINDOW_PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  // Year-to-date first: "ytd" and "year to date" both contain tokens that
  // could otherwise match the generic year pattern below.
  [/\b(ytd|year[-\s]?to[-\s]?date|so far this year|this year)\b/i, "ytd"],

  // Explicit numeric forms: "5d", "3 months", "2 weeks", "1 year".
  [/\b(\d+)\s*d(ays?)?\b/i, "$1d"],
  [/\b(\d+)\s*w(k|ks|eeks?)?\b/i, "$1w"],
  [/\b(\d+)\s*mo(nths?)?\b/i, "$1mo"],
  [/\b(\d+)\s*m\b/i, "$1mo"],
  [/\b(\d+)\s*y(rs?|ears?)?\b/i, "$1y"],

  // Relative phrasings. "this month" and "past month" both mean a 1-month
  // lookback here — we do not attempt calendar-month-to-date, because the
  // report would then compare a 3-day window against a 30-day one whenever the
  // question was asked early in a month.
  [/\b(this|past|last|previous)\s+month\b/i, "1mo"],
  [/\b(this|past|last|previous)\s+week\b/i, "1w"],
  [/\b(this|past|last|previous)\s+quarter\b/i, "3mo"],
  [/\b(this|past|last|previous)\s+year\b/i, "1y"],
  [/\btoday\b|\bright now\b|\bcurrently\b/i, "5d"],
  [/\brecent(ly)?\b|\blately\b/i, "1mo"],
];

/**
 * The window used when the user expresses no preference.
 *
 * ⚠️ This is NOT the defaulted-`timeWindow` that §4.1(b) forbids. That note is
 * about the graph silently proceeding when parsing FAILED. Here the parse
 * succeeded and found no period mentioned, which is a different situation: the
 * user asked "what sectors are trending?" and genuinely did not specify. One
 * month is the conventional reading of an unqualified "trending".
 *
 * The distinction is preserved by `parseTimeWindow` returning the value it
 * chose plus whether it was explicit, so the report can say which window it
 * used (`sectorRankings[].window` carries it to the UI regardless).
 */
export const DEFAULT_TIME_WINDOW = "1mo";

/**
 * Extract a lookback window from free text.
 *
 * @returns the resolved window and whether the user stated it explicitly.
 */
export function parseTimeWindow(text: string): { timeWindow: string; explicit: boolean } {
  for (const [pattern, replacement] of WINDOW_PHRASES) {
    const match = pattern.exec(text);
    if (match !== null) {
      // `$1` in a replacement refers to the captured number, so "3 months"
      // becomes "3mo".
      const timeWindow = replacement.replace("$1", match[1] ?? "");
      return { timeWindow, explicit: true };
    }
  }
  return { timeWindow: DEFAULT_TIME_WINDOW, explicit: false };
}

// =============================================================================
// SECTION 2 — Sector parsing
// =============================================================================

/**
 * Colloquial names for each GICS sector.
 *
 * Users do not say "Information Technology" — they say "tech". The canonical
 * names live in `SECTOR_ETF_TO_GICS`; this maps the words people actually type
 * onto them. Keys are matched case-insensitively as whole words.
 */
const SECTOR_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  tech: "Information Technology",
  technology: "Information Technology",
  it: "Information Technology",
  software: "Information Technology",
  semiconductors: "Information Technology",
  energy: "Energy",
  oil: "Energy",
  "oil and gas": "Energy",
  financials: "Financials",
  finance: "Financials",
  financial: "Financials",
  banks: "Financials",
  banking: "Financials",
  healthcare: "Health Care",
  "health care": "Health Care",
  health: "Health Care",
  pharma: "Health Care",
  biotech: "Health Care",
  industrials: "Industrials",
  industrial: "Industrials",
  manufacturing: "Industrials",
  "consumer discretionary": "Consumer Discretionary",
  discretionary: "Consumer Discretionary",
  retail: "Consumer Discretionary",
  "consumer staples": "Consumer Staples",
  staples: "Consumer Staples",
  utilities: "Utilities",
  utility: "Utilities",
  materials: "Materials",
  mining: "Materials",
  chemicals: "Materials",
  "real estate": "Real Estate",
  reits: "Real Estate",
  property: "Real Estate",
  "communication services": "Communication Services",
  communications: "Communication Services",
  telecom: "Communication Services",
  media: "Communication Services",
});

/**
 * Find GICS sectors named in free text.
 *
 * EMPTY IS MEANINGFUL, and downstream depends on it: an empty array means
 * "the user did not narrow it down, rank all 11", which is the common case for
 * "what sectors are trending up this month".
 *
 * Matching is longest-alias-first so "consumer staples" is not consumed by a
 * shorter overlapping alias, and results are deduplicated because several
 * aliases map to the same sector.
 */
export function parseSectors(text: string): string[] {
  const canonical = new Set(Object.values(SECTOR_ETF_TO_GICS));
  const found = new Set<string>();

  // Longest first, so multi-word aliases win over their constituent words.
  const aliases = Object.keys(SECTOR_ALIASES).sort((a, b) => b.length - a.length);

  for (const alias of aliases) {
    // Escape nothing — aliases are plain words/spaces by construction — but
    // anchor on word boundaries so "it" does not match inside "with".
    const pattern = new RegExp(`\\b${alias}\\b`, "i");
    if (pattern.test(text)) {
      const sector = SECTOR_ALIASES[alias]!;
      if (canonical.has(sector)) found.add(sector);
    }
  }

  // Also accept the canonical names typed verbatim.
  for (const sector of canonical) {
    if (new RegExp(`\\b${sector}\\b`, "i").test(text)) found.add(sector);
  }

  return [...found].sort();
}

// =============================================================================
// SECTION 3 — Intent classification
// =============================================================================

/**
 * Signals that the user is asking about sector/industry movement — the one
 * capability that exists today (§9: do not build speculative support for
 * capabilities that are not specified yet).
 */
const SECTOR_TREND_SIGNALS =
  /\b(sector|sectors|industry|industries|trend|trending|leading|leaders?|rotat\w*|outperform\w*|underperform\w*|best|worst|top|bottom)\b/i;

/** Signals the user wants a deep dive on one named company. */
const SINGLE_REPORT_SIGNALS = /\b(report on|analys[ei]s of|tell me about|deep dive|profile)\b/i;

/** Signals the user is asking about a set of holdings they own. */
const PORTFOLIO_SIGNALS = /\b(my portfolio|my holdings|my positions|i own|i hold)\b/i;

/**
 * Signals the message is a follow-up referring back to something already
 * discussed, rather than opening a new topic. Only meaningful when the
 * caller has confirmed a prior analysis actually exists in this thread — see
 * `hasPriorAnalysis` in `supervisorNode` and `classifyIntent`'s guard below.
 */
const FOLLOWUP_SIGNALS =
  /\b(what about|and what about|why (is|was|did|does)|tell me more|what else|any others?|what'?s driving that|go deeper|more (detail|context)|elaborate)\b/i;

/** Extract explicit ticker symbols, e.g. "NVDA", "$AAPL". */
export function parseTickers(text: string): string[] {
  const found = new Set<string>();

  // `$`-prefixed symbols are unambiguous, so accept them regardless of case.
  for (const match of text.matchAll(/\$([A-Za-z]{1,5})\b/g)) {
    found.add(match[1]!.toUpperCase());
  }

  // Bare uppercase runs of 2-5 letters. Deliberately conservative: requiring
  // all-caps avoids turning ordinary words into tickers, and the stop-list
  // below removes the acronyms that show up in ordinary finance questions.
  const NOT_TICKERS = new Set([
    "ETF",
    "GICS",
    "USD",
    "CEO",
    "CFO",
    "IPO",
    "USA",
    "US",
    "EPS",
    "PE",
    "AI",
    "IT",
    "API",
    "YTD",
    "SPY",
    "AND",
    "THE",
    "FOR",
    "ARE",
    "WHAT",
    "WHO",
  ]);
  for (const match of text.matchAll(/\b([A-Z]{2,5})\b/g)) {
    const candidate = match[1]!;
    if (!NOT_TICKERS.has(candidate)) found.add(candidate);
  }

  return [...found].sort();
}

/**
 * Decide what the user is asking for. THE FALLBACK PATH — see this file's
 * header. `classifyIntentLlm` below is primary; this only runs when that
 * fails, so it must keep working entirely on its own.
 *
 * Order matters: a follow-up reading is checked first (but only fires when
 * `hasPriorAnalysis` is true — a referring phrase with nothing to refer to is
 * not a follow-up), then portfolio and single-company phrasings BEFORE the
 * sector signals, because "tell me about NVDA's sector" contains both and the
 * more specific reading should win. Multiple named tickers route to
 * `portfolio_scan` regardless of phrasing — `single_report` is single-ticker
 * by design (§11.1), so a second ticker means this is the multi-ticker case.
 */
export function classifyIntent(
  text: string,
  tickers: string[],
  sectors: string[],
  hasPriorAnalysis: boolean,
): Intent {
  if (hasPriorAnalysis && FOLLOWUP_SIGNALS.test(text)) return "followup";

  if (PORTFOLIO_SIGNALS.test(text) || tickers.length > 1) return "portfolio_scan";

  if (SINGLE_REPORT_SIGNALS.test(text) && tickers.length > 0 && sectors.length === 0) {
    return "single_report";
  }

  if (SECTOR_TREND_SIGNALS.test(text) || sectors.length > 0) return "sector_trend";

  // Nothing matched. This is genuinely not a finance question we can route to
  // an implemented capability — coercing it into `sector_trend` would invoke
  // the industry-trend tool calls (Yahoo/Alpha Vantage/Finnhub) for a prompt
  // like "hello" or "what can you do?", which is the honest-answer principle
  // this file's header describes turned inside out. `general_chat` lets the
  // report writer give a real conversational reply instead, with
  // `activeCapabilities` staying empty so no capability node ever runs.
  return "general_chat";
}

// =============================================================================
// SECTION 3B — LLM intent classification (primary path — see file header)
// =============================================================================

/**
 * Closed output shape for the classifier. Wrapping `AgentStateSchema.shape.intent`
 * (rather than re-declaring the five values here) means the model's allowed
 * outputs can never silently drift from the real `Intent` type.
 */
const IntentClassificationSchema = z.object({
  intent: AgentStateSchema.shape.intent,
});

/**
 * Fixed prompt, fixed few-shot examples — no per-request variation. The
 * examples are drawn directly from this file's own regex test suite so the
 * LLM path stays behaviourally aligned with what the fallback already proves
 * correct (see `tests/nodes/supervisor.test.ts`).
 */
const INTENT_CLASSIFIER_SYSTEM_PROMPT = `You are the routing classifier for a financial analysis agent. Read the user's message and decide which ONE of a fixed set of intents it is.

INTENTS, IN PRECEDENCE ORDER — check top to bottom, the first that clearly applies wins:
1. followup — the message clearly refers BACK to an analysis already given earlier in this conversation ("what about the emerging movers?", "why is that?", "tell me more about the leaders you mentioned") rather than opening a new, self-contained topic. You are told below whether a prior analysis actually exists in this conversation — if it does not, this intent can NEVER apply, even if the phrasing looks like a follow-up. If the message ALSO names a new ticker/sector/portfolio topic not implied by what was already discussed, prefer the more specific intent below instead of this one.
2. portfolio_scan — the user refers to THEIR OWN holdings/portfolio/positions (e.g. "what's happening with my portfolio", "should I sell what I own"), OR names MULTIPLE specific tickers/companies to check together (e.g. "are AAPL, MSFT, and NVDA all growing for real, or is this just the AI trade?").
3. single_report — the user wants a deep dive / analysis / report on ONE specific named company or ticker, and is NOT also asking about its sector or industry more broadly.
4. sector_trend — the user asks about sector/industry movement, market trends, or which stocks/companies are leading/best/worst/top/bottom performers, OR a sector is named, OR a company is named specifically in the context of its sector/industry.
5. general_chat — anything else: greetings, small talk, unrelated topics (weather, jokes, thanks), or a request this agent has no data for. This is the default when nothing above clearly applies.

IMPORTANT: words like "best", "worst", "top", "bottom" are NOT finance signals by themselves — they only support sector_trend when the message is actually about market/sector/company performance. Do not force an off-topic or ambiguous message into sector_trend just because it contains one of those words.

You are also given the tickers and sectors a separate deterministic parser already extracted from the message, and whether this conversation already has a prior analysis to potentially follow up on. Treat the tickers/sectors as hints about what was FOUND in the text, not as a decision about what the message is ABOUT.

EXAMPLES:
"what sectors are trending up this month, and who is leading them?" -> sector_trend
"who is leading the market" -> sector_trend
"how's tech doing lately" -> sector_trend
"what's happening with my portfolio" -> portfolio_scan
"are AAPL, MSFT, and NVDA all growing for real, or is this just the AI trade?" -> portfolio_scan
"give me a deep dive on NVDA" -> single_report
"tell me about NVDA's sector" -> sector_trend
"what about the emerging movers?" (a prior analysis exists) -> followup
"why is that?" (a prior analysis exists) -> followup
"what about the emerging movers?" (no prior analysis exists) -> general_chat
"hello there" -> general_chat
"what's the weather like today" -> general_chat
"tell me a joke" -> general_chat
"thanks, that's helpful" -> general_chat
"who's the best pizza place near me" -> general_chat
"what's on top of your list" -> general_chat

Respond with exactly one intent from the closed set.`;

/**
 * Classify intent via the LLM (temperature 0, structured output — see file
 * header). Tries Gemini then falls back to Groq on a rate limit, mirroring
 * `report-writer.ts`'s `invokeWithFallback`; duplicated here in a few lines
 * rather than extracted into a shared cross-file helper, since the return
 * shape (a parsed structured object, not narration text) differs.
 *
 * @throws if every provider fails. Callers (`supervisorNode`) are expected to
 *         catch this and fall back to the deterministic `classifyIntent`.
 */
export async function classifyIntentLlm(
  text: string,
  tickers: string[],
  sectors: string[],
  hasPriorAnalysis: boolean,
): Promise<Intent> {
  const messages = [
    new SystemMessage(INTENT_CLASSIFIER_SYSTEM_PROMPT),
    new HumanMessage(
      `Message: "${text}"\n` +
        `Detected tickers: ${tickers.length > 0 ? tickers.join(", ") : "none"}\n` +
        `Detected sectors: ${sectors.length > 0 ? sectors.join(", ") : "none"}\n` +
        `Prior analysis exists in this conversation: ${hasPriorAnalysis ? "yes" : "no"}`,
    ),
  ];

  const attempts: (LlmProvider | undefined)[] = [undefined, "groq"];
  let lastError: unknown = null;

  for (const provider of attempts) {
    try {
      const { model } = getLlm(provider, { temperature: 0 });
      const result = await model.withStructuredOutput(IntentClassificationSchema).invoke(messages);
      return result.intent;
    } catch (error) {
      lastError = error;
      if (!isRateLimitError(error)) break;
      console.warn(
        `[supervisor] provider rate-limited during intent classification, trying fallback: ${String(error)}`,
      );
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// =============================================================================
// SECTION 4 — The node
// =============================================================================

/**
 * Pull the newest human turn out of the message history.
 *
 * Exported so `report-writer.ts` can reuse it for the `general_chat` prompt
 * rather than re-implementing message-history-walking — this stays the one
 * place that logic lives, per this file's header.
 */
export function latestUserText(messages: AgentState["messages"]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined) continue;

    // `getType()` is the LangChain v1 accessor; `_getType()` was the v0 name.
    // Both are checked because a message can arrive from either path.
    const type =
      typeof message.getType === "function"
        ? message.getType()
        : ((message as { _getType?: () => string })._getType?.() ?? "");

    if (type === "human") {
      return typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content);
    }
  }
  return "";
}

/**
 * Parse the user's request into routing fields.
 *
 * READS  `messages`, `dataErrors`
 * WRITES `intent`, `timeWindow`, `sectors`, `tickers`, `activeCapabilities`,
 *        and `dataErrors` (only when the LLM classifier failed and the regex
 *        fallback fired — see file header)
 * NEVER TOUCHES the capability outputs, the draft/final report, or the
 *              validation fields.
 *
 * `activeCapabilities` is THE PLUGIN SEAM (§1, §3). Adding a capability later
 * means teaching this function to push another id — no existing capability's
 * code changes. `sector_trend` activates `industry_trend`; `single_report`
 * (with at least one ticker) activates `growth_authenticity`.
 * `followup` deliberately does NOT activate any capability — it reuses
 * whichever capability's output is already sitting in state from an earlier
 * turn (see `report-writer.ts`'s followup branch), rather than re-running
 * fetches for data the conversation already has. `general_chat` is routed to
 * `report-writer.ts`'s conversational branch instead of a capability at all.
 *
 * ASYNC because intent classification is now an LLM call (file header). A
 * failure there degrades into the regex fallback rather than throwing — this
 * node gates the entire graph, so it cannot be the place a run dies outright.
 */
export async function supervisorNode(
  state: AgentState,
  config?: LangGraphRunnableConfig,
): Promise<Partial<AgentState>> {
  const text = latestUserText(state.messages);

  const tickers = parseTickers(text);
  const sectors = parseSectors(text);
  const { timeWindow: parsedTimeWindow, explicit: timeWindowExplicit } = parseTimeWindow(text);

  // Whether this thread already has SOME capability's output to potentially
  // follow up on. Read before this turn's classification touches anything, so
  // it reflects what an EARLIER turn produced, never this one.
  const hasPriorAnalysis = state.sectorRankings !== null || state.growthAuthenticity !== null;
  console.error(
    "DEBUG supervisorNode sees sectorRankings=",
    state.sectorRankings === null ? "null" : `${state.sectorRankings.length} rows`,
    "timeWindow=",
    state.timeWindow,
  );

  emitProgress(config, "supervisor", "Classifying intent...");

  let intent: Intent;
  let dataErrors = state.dataErrors;
  try {
    intent = await classifyIntentLlm(text, tickers, sectors, hasPriorAnalysis);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[supervisor] intent classification LLM failed, using regex fallback: ${message}`);
    dataErrors = [
      ...state.dataErrors,
      `Intent classification LLM failed (${message}); used keyword-based fallback.`,
    ];
    intent = classifyIntent(text, tickers, sectors, hasPriorAnalysis);
  }

  // A follow-up that does not restate a period keeps analysing the SAME
  // window as the analysis it's following up on, rather than silently
  // resetting to the default — `state.timeWindow` here is the prior turn's
  // real value (not a placeholder) because `api.ts` deliberately does not
  // reseed `timeWindow` on a continuing thread. An explicit window in THIS
  // message always wins — the user is allowed to change the period mid-
  // conversation.
  const timeWindow =
    intent === "followup" && !timeWindowExplicit ? state.timeWindow : parsedTimeWindow;

  // `tickers.length > 0` here is a defensive restatement, not new logic —
  // neither classifier ever returns "single_report" without at least one
  // ticker. Kept explicit so a future edit cannot silently break the
  // invariant this line assumes.
  const activeCapabilities: string[] =
    intent === "sector_trend"
      ? [INDUSTRY_TREND_CAPABILITY_ID]
      : intent === "single_report" && tickers.length > 0
        ? [GROWTH_AUTHENTICITY_CAPABILITY_ID]
        : [];

  emitProgress(config, "supervisor", `Understood: ${intent} for ${timeWindow}`);

  const patch: Partial<AgentState> = { intent, timeWindow, sectors, tickers, activeCapabilities };
  // Only touch `dataErrors` when the fallback actually fired — otherwise this
  // node writes exactly the same field set it always has.
  if (dataErrors !== state.dataErrors) {
    patch.dataErrors = dataErrors;
  }
  return patch;
}
