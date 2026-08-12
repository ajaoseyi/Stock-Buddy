/**
 * =============================================================================
 * report-writer.ts — the ONLY node that generates prose.
 * =============================================================================
 *
 * FOUR PROMPT PATHS, ONE NODE
 * ----------------------------
 * This node branches on `state.intent`:
 *
 *   - `sector_trend` (§5.5 below): a data-driven report built from
 *     `sectorRankings`/`sectorLeaders`, checked afterwards by `validator.ts`.
 *   - `single_report`: a data-driven report built from `growthAuthenticity`,
 *     same verification loop.
 *   - `followup`: no capability runs on this turn — `activeCapabilities`
 *     stays empty for `followup` (`supervisor.ts`) by design. Instead this
 *     branch re-narrates whichever capability's output is ALREADY in state
 *     from an earlier turn in the same thread, answering the new question
 *     against it rather than re-fetching anything. If neither
 *     `sectorRankings` nor `growthAuthenticity` exists yet, there is nothing
 *     to follow up on — an honest message, no LLM call.
 *   - `general_chat`: the user's prompt was not a finance question the graph
 *     can serve with a capability, so no capability ever ran. This branch
 *     still calls the LLM — it just has no computed data to narrate, and is
 *     told not to invent any.
 *
 * In every branch that DOES call the LLM, the model is handed the user's
 * literal question (`latestUserText(state.messages)`) alongside whatever DATA
 * block exists, and is told to answer that question directly rather than
 * recite a fixed template — the DATA block still bounds every number/ticker
 * it may cite, but the framing of the answer follows what was actually asked.
 *
 * All four stay inside this one file/node on purpose: CLAUDE.md's
 * repo-structure notes call out report-writer.ts as the only node that calls
 * the LLM for user-facing prose, and adding a second LLM-calling node would
 * fork that invariant for no architectural benefit — the existing plugin-seam
 * routing in `graph.ts` (`routeAfterSupervisor`) already lands anything
 * without an active capability here, so no graph changes were needed either.
 *
 * Any OTHER intent that reaches this node with no matching capability and no
 * prior data to follow up on falls through to an honest "not supported" stub
 * with no LLM call (see below) — a different situation from `general_chat`
 * genuinely not being a finance question.
 *
 * CLAUDE.md §5.5 defines what the sector_trend path must produce; §1 defines
 * what it must never do. Both are worth holding in mind together:
 *
 *   §5.5  Name the top trending-up and trending-down sectors with their actual
 *         % figures. For each, name the `anchor_leader` companies first (these
 *         are genuinely driving the move), then note any notable
 *         `emerging_mover` companies as an "early signal" callout. Never invent
 *         a company or number not present in the data.
 *
 *   §1    The LLM never computes a number.
 *
 * HOW THE SECOND RULE IS ACTUALLY ENFORCED
 * ----------------------------------------
 * Not by asking nicely. Three mechanisms, in order of reliability:
 *
 *   1. STRUCTURE — the model receives the computed figures as JSON and is
 *      given no tool with which to fetch or calculate anything else. There is
 *      no arithmetic it can do that will be believed.
 *   2. INSTRUCTION — the prompt states the constraint explicitly, including the
 *      non-obvious part: that deriving a NEW correct number (a sum, an average)
 *      is also forbidden, because a correct-looking figure absent from state is
 *      indistinguishable to a reader from a hallucinated one.
 *   3. VERIFICATION — `validator.ts` re-reads the output and checks every
 *      number and ticker back against state (§5.6). This is the mechanism that
 *      actually holds; 1 and 2 exist to make it rarely fire.
 *
 * §9 also forbids this node from calling an external API. It reads state and
 * calls the LLM; nothing else.
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { AIMessage, type BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type {
  AgentState,
  GrowthAuthenticityResult,
  SectorLeader,
  SectorRanking,
} from "../state.js";
import { getLlm, isRateLimitError, type LlmProvider } from "../llm.js";
import { INDUSTRY_TREND_CAPABILITY_ID } from "./capabilities/industry-trend/index.js";
import { GROWTH_AUTHENTICITY_CAPABILITY_ID } from "./capabilities/growth-authenticity/index.js";
import { latestUserText } from "./supervisor.js";
import { emitProgress } from "../streaming.js";

// =============================================================================
// SECTION 1 — Prompt construction
// =============================================================================

/**
 * The standing instruction. Deliberately blunt about the numeric constraint —
 * this is the prompt-side half of §1, and vagueness here costs retry budget
 * later.
 */
const SYSTEM_PROMPT = `You are a financial analyst writing a concise, factual market report.

ABSOLUTE CONSTRAINTS — these override every other instruction:
1. Use ONLY the companies and numbers present in the DATA block. Never introduce a ticker or figure that does not appear there.
2. Do NOT calculate anything. No sums, averages, differences, ratios, or totals — even if the arithmetic would be correct. A number you derived is indistinguishable from one you invented, to both the reader and the automated validator that checks this report.
3. Quote percentages as they are given, rounded to at most one decimal place.
4. If the DATA block is empty or a figure is missing, say so plainly. An acknowledged gap is acceptable; an invented figure is not.

STYLE:
- Open with a one-sentence summary of the period's sector picture.
- Be specific and brief. No hedging, no filler, no investment advice.
- Plain markdown: short paragraphs and bullet lists. No tables.`;

/**
 * The `general_chat` system prompt. Used when the user's message is not a
 * finance question this graph can serve with a capability, so there is no
 * DATA block to hand the model — §1 still applies, restated for a prompt
 * with nothing computed to narrate: don't fabricate the numbers §1 would
 * otherwise forbid deriving.
 */
const GENERAL_CHAT_SYSTEM_PROMPT = `You are the conversational side of a financial analysis agent. This message is not a sector or industry trend question, so no market data has been computed for it — just reply naturally and helpfully.

CONSTRAINTS:
1. Never state a specific stock price, percentage change, or other market figure as fact — you have not been given any real data here. If the user wants real numbers, say you can pull a sector/industry trend analysis (e.g. "which sectors are trending up this month, and who is leading them?") and that is backed by real data.
2. Be brief and direct. No filler, no investment advice.`;

/** Round for display so the model is not tempted to do it itself. */
function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Build the DATA block: the computed figures, as compact JSON.
 *
 * Two shaping decisions matter here:
 *
 * - Leaders are TRIMMED to the few names per sector the report will actually
 *   discuss. A 70-constituent list would bury the `anchor_leader` names §5.5
 *   asks to be foregrounded, and every extra row is another number the model
 *   might quote and the validator must then check.
 *
 * - `weightScore` and `speedScore` are presented as SEPARATE labelled fields,
 *   never merged (§5.4, §9). The prompt explains what each means so the model
 *   narrates the combination correctly without being handed a blended figure.
 */
export function buildDataBlock(
  sectorRankings: SectorRanking[] | null,
  sectorLeaders: Record<string, SectorLeader[]> | null,
  timeWindow: string,
): string {
  const rankings = (sectorRankings ?? []).map((r) => ({
    sector: r.sector,
    pctChange: round(r.pctChange),
    source: r.source,
  }));

  const leaders: Record<string, unknown[]> = {};
  for (const [sector, list] of Object.entries(sectorLeaders ?? {})) {
    // Anchor leaders and emerging movers first — §5.5's required narrative
    // order — then the highest-speed remainder for context.
    const prioritised = [
      ...list.filter((l) => l.quadrant === "anchor_leader"),
      ...list.filter((l) => l.quadrant === "emerging_mover"),
      ...list.filter((l) => l.quadrant === "stable_heavyweight"),
    ].slice(0, 6);

    leaders[sector] = prioritised.map((l) => ({
      ticker: l.ticker,
      weightPctOfSector: round(l.weightScore),
      speedZScore: round(l.speedScore),
      relativeVolume: round(l.relativeVolume),
      quadrant: l.quadrant,
    }));
  }

  return JSON.stringify({ timeWindow, sectorRankings: rankings, sectorLeaders: leaders }, null, 2);
}

/**
 * Build the growth-authenticity DATA block.
 *
 * Every disaggregated field is presented, labelled, exactly as computed — the
 * point of this capability is that the model narrates the classification, it
 * never derives one, so nothing here is pre-summarised into a single score.
 */
export function buildGrowthDataBlock(
  growthAuthenticity: GrowthAuthenticityResult | null,
  timeWindow: string,
): string {
  if (growthAuthenticity === null) {
    return JSON.stringify({ timeWindow, growthAuthenticity: null }, null, 2);
  }

  const g = growthAuthenticity;
  return JSON.stringify(
    {
      timeWindow,
      ticker: g.ticker,
      classification: g.classification,
      classificationReasonCodes: g.classificationReasonCodes,
      revenueGrowth: {
        latestQuarterEnd: g.revenueGrowth.latestQuarterEnd,
        revenueGrowthPct:
          g.revenueGrowth.revenueGrowthPct === null
            ? null
            : round(g.revenueGrowth.revenueGrowthPct),
        basis: g.revenueGrowth.basis,
      },
      priceVsRevenue: {
        priceChangePct:
          g.discrepancy.priceChangePct === null ? null : round(g.discrepancy.priceChangePct),
        priceToRevenueGrowthRatio:
          g.discrepancy.priceToRevenueGrowthRatio === null
            ? null
            : round(g.discrepancy.priceToRevenueGrowthRatio),
        discrepancyFlag: g.discrepancy.discrepancyFlag,
      },
      inorganicGrowthCheck: {
        goodwillChangePct:
          g.inorganic.goodwillTrend.deltaPct === null
            ? null
            : round(g.inorganic.goodwillTrend.deltaPct),
        ppeChangePct:
          g.inorganic.ppeTrend.deltaPct === null ? null : round(g.inorganic.ppeTrend.deltaPct),
        cashDirection: g.inorganic.cashTrend.direction,
        inorganicSignal: g.inorganic.inorganicSignal,
      },
      sectorBenchmark: {
        sector: g.sectorBenchmark.sector,
        sectorBenchmarkPct:
          g.sectorBenchmark.sectorBenchmarkPct === null
            ? null
            : round(g.sectorBenchmark.sectorBenchmarkPct),
        stockVsSectorSpreadPct:
          g.sectorBenchmark.stockVsSectorSpreadPct === null
            ? null
            : round(g.sectorBenchmark.stockVsSectorSpreadPct),
        macroBetaFlag: g.sectorBenchmark.macroBetaFlag,
      },
    },
    null,
    2,
  );
}

/**
 * The task instruction for the growth-authenticity capability.
 *
 * The one instruction that matters most is the last CONSTRAINT below:
 * `classification` was computed by deterministic code (growth-classification.ts),
 * not by the model, and the model's job is to explain it using the given
 * numbers — never to independently judge organic-vs-inorganic or propose a
 * different explanation. `validator.ts` enforces this after the fact by
 * checking the draft actually states the computed classification.
 */
function buildGrowthTaskPrompt(state: AgentState, dataBlock: string): string {
  const userQuestion = latestUserText(state.messages);

  const caveats =
    state.growthCheckErrors.length > 0
      ? `\n\nDATA CAVEATS — mention these briefly at the end, in one short "Data notes" ` +
        `section, only where they affect a claim you made:\n` +
        state.growthCheckErrors.map((e) => `- ${e}`).join("\n")
      : "";

  const corrections =
    state.validationNotes.length > 0
      ? `\n\n⚠️ YOUR PREVIOUS DRAFT WAS REJECTED. Fix these specific problems:\n` +
        state.validationNotes.map((n) => `- ${n}`).join("\n") +
        `\nRewrite the report from scratch, keeping strictly to the DATA block.`
      : "";

  return `THE USER ASKED: "${userQuestion}"

Answer that question directly, over the period "${state.timeWindow}". Use the required structure below to organise the answer, but lead with whatever the question is actually asking about rather than reciting the structure regardless of phrasing.

WHAT THE FIELDS MEAN:
- classification: the computed answer to "why did this stock move" — one of organic_growth_supported, inorganic_ma_driven, macro_or_commodity_beta_driven, price_outpacing_fundamentals_unexplained, mixed_signals, insufficient_data.
- revenueGrowth.revenueGrowthPct: year-over-year quarterly revenue growth.
- priceVsRevenue: how the stock's price move compares to its revenue growth, and whether that gap is unusual for THIS company's own history.
- inorganicGrowthCheck: goodwill/PP&E/cash balance-sheet evidence of M&A activity. Goodwill is the primary signal; PP&E only counts alongside a cash decrease.
- sectorBenchmark: whether the move is explained by the stock's own sector/commodity beta rather than being company-specific.

CONSTRAINTS SPECIFIC TO THIS REPORT:
- State the "classification" value plainly and explain it using ONLY the numbers given above (price change, revenue growth, goodwill/PP&E/cash trend, sector benchmark spread).
- Do NOT independently judge whether the move is organic or not, and do NOT propose a different explanation than "classification" — it was computed by deterministic code, not by you.
- Do NOT calculate anything new — no new ratios, no new differences. Quote only the numbers in the DATA block.

REQUIRED STRUCTURE:
1. One-sentence verdict stating the classification in plain language.
2. The evidence: revenue growth vs. price change, then the M&A check, then the sector-benchmark check — whichever are most relevant to the classification.
3. "Data notes" — only if caveats are supplied below.

DATA:
${dataBlock}${caveats}${corrections}`;
}

/** The task instruction for this capability (§5.5). */
function buildTaskPrompt(state: AgentState, dataBlock: string): string {
  const userQuestion = latestUserText(state.messages);

  const caveats =
    state.trendDataErrors.length > 0
      ? `\n\nDATA CAVEATS — mention these briefly at the end, in one short "Data notes" ` +
        `section, only where they affect a claim you made:\n` +
        state.trendDataErrors.map((e) => `- ${e}`).join("\n")
      : "";

  // On a retry, the validator's complaints are prepended so the model corrects
  // rather than re-rolls. This is what makes the loop a CORRECTION loop.
  const corrections =
    state.validationNotes.length > 0
      ? `\n\n⚠️ YOUR PREVIOUS DRAFT WAS REJECTED. Fix these specific problems:\n` +
        state.validationNotes.map((n) => `- ${n}`).join("\n") +
        `\nRewrite the report from scratch, keeping strictly to the DATA block.`
      : "";

  return `THE USER ASKED: "${userQuestion}"

Answer that question directly, for the period "${state.timeWindow}". Use the required structure below to organise the answer, but lead with whatever the question is actually asking about — e.g. if it names one sector or one company, lead with that — rather than reciting the full structure regardless of phrasing.

WHAT THE FIELDS MEAN:
- pctChange: the sector ETF's percent price change over the period.
- weightPctOfSector: how much of the sector that company represents, from disclosed ETF holdings. A structural size measure.
- speedZScore: how fast the company moved RELATIVE TO ITS SECTOR PEERS, in standard deviations. 0 is average for the sector; positive is faster.
- relativeVolume: today's volume divided by its 20-day average. Above ~1.5 suggests unusual participation.
- quadrant: anchor_leader = large AND fast, the companies genuinely driving the sector's move. emerging_mover = small but fast, an early signal that has not yet moved the index. stable_heavyweight = large but not moving. laggard = neither.

These two measures are deliberately kept separate. Do not merge, add, or average them.

REQUIRED STRUCTURE:
1. One-sentence summary of the period.
2. "Trending up" — name the top rising sectors with their exact pctChange figures. For each, name its anchor_leader companies FIRST and say why they matter (size plus speed). Then, if any exist, flag emerging_mover companies as an "early signal" — a smaller name moving before the index reflects it.
3. "Trending down" — the same treatment for the falling sectors.
4. "Data notes" — only if caveats are supplied below.

DATA:
${dataBlock}${caveats}${corrections}`;
}

/**
 * The task instruction for a `followup` question — reuses whichever
 * capability's DATA block is already in state from an earlier turn (see
 * `reportWriterNode`'s disambiguation). Deliberately does NOT restate a full
 * REQUIRED STRUCTURE: a follow-up answers ONE new question, not the whole
 * analysis again.
 */
function buildFollowupTaskPrompt(state: AgentState, dataBlock: string, userQuestion: string): string {
  const corrections =
    state.validationNotes.length > 0
      ? `\n\n⚠️ YOUR PREVIOUS DRAFT WAS REJECTED. Fix these specific problems:\n` +
        state.validationNotes.map((n) => `- ${n}`).join("\n") +
        `\nRewrite the answer from scratch, keeping strictly to the DATA block.`
      : "";

  return `THE USER HAS A FOLLOW-UP QUESTION about an analysis already given earlier in this conversation: "${userQuestion}"

Answer it directly, using ONLY the DATA block below — the same data already computed earlier in this conversation. Do not invent, recompute, or re-derive anything not already present there. Focus on what was actually asked; you do not need to re-narrate the full original report.

DATA:
${dataBlock}${corrections}`;
}

// =============================================================================
// SECTION 2 — Model invocation
// =============================================================================

/** What `invokeWithFallback` returns: either generated text, or the last error. */
type InvokeResult = { text: string; provider: LlmProvider } | { error: unknown };

/**
 * Call the LLM, trying the primary provider then falling back to the
 * secondary on a rate limit (§2). Shared by both prompt paths below so the
 * fallback behaviour can't drift between them.
 *
 * Only a rate limit is worth switching provider for — a malformed-prompt
 * error would fail identically on the other provider, so it is not retried.
 */
async function invokeWithFallback(messages: BaseMessage[]): Promise<InvokeResult> {
  const attempts: (LlmProvider | undefined)[] = [undefined, "groq"];
  let lastError: unknown = null;

  for (const provider of attempts) {
    try {
      const { model, provider: used } = getLlm(provider);
      const response = await model.invoke(messages);
      const text =
        typeof response.content === "string" ? response.content : JSON.stringify(response.content);
      return { text, provider: used };
    } catch (error) {
      lastError = error;
      if (!isRateLimitError(error)) break;
      console.warn(`[report-writer] provider rate-limited, trying fallback: ${String(error)}`);
    }
  }

  return { error: lastError };
}

// =============================================================================
// SECTION 3 — The node
// =============================================================================

/**
 * Generate `draftReport` from the computed state.
 *
 * READS  `intent`, `messages`, `tickers`, `sectorRankings`, `sectorLeaders`,
 *        `timeWindow`, `trendDataErrors`, `growthAuthenticity`,
 *        `growthCheckErrors`, `validationNotes`, `activeCapabilities`,
 *        `retryCount`
 * WRITES `draftReport`, `messages`, `retryCount`, `dataErrors`
 * NEVER  touches `sectorRankings`/`sectorLeaders` (§9) or calls an external
 *        API. It reads the numbers; it does not produce them.
 *
 * `retryCount` is incremented here rather than in the validator because this
 * node is what actually consumes the budget — one increment per LLM attempt is
 * the meaningful count, and `graph.ts` compares it against the ceiling.
 */
export async function reportWriterNode(
  state: AgentState,
  config?: LangGraphRunnableConfig,
): Promise<Partial<AgentState>> {
  const attemptMessage =
    state.validationNotes.length > 0
      ? `Revising report based on validation feedback (attempt ${state.retryCount + 1})...`
      : "Writing report...";

  // Genuinely not a finance question (see module header). This DOES call the
  // LLM — there is just no capability DATA block to hand it.
  if (state.intent === "general_chat") {
    const messages = [
      new SystemMessage(GENERAL_CHAT_SYSTEM_PROMPT),
      new HumanMessage(latestUserText(state.messages)),
    ];

    emitProgress(config, "report_writer", attemptMessage);
    const result = await invokeWithFallback(messages);
    if ("error" in result) {
      const message = result.error instanceof Error ? result.error.message : String(result.error);
      return {
        draftReport: null,
        dataErrors: [...state.dataErrors, `Report generation failed: ${message}`],
        retryCount: state.retryCount + 1,
      };
    }

    console.info(
      `[report-writer] general_chat reply generated via ${result.provider} ` +
        `(attempt ${state.retryCount + 1})`,
    );
    return {
      draftReport: result.text,
      messages: [new AIMessage(result.text)],
      retryCount: state.retryCount + 1,
    };
  }

  // Which capability (if any) actually ran (§4's other intents may reach here
  // with none implemented yet — §9). Exactly one branch, matching the
  // established one-branch-per-capability shape rather than a registry.
  let prompt: string;
  if (state.activeCapabilities.includes(INDUSTRY_TREND_CAPABILITY_ID)) {
    const dataBlock = buildDataBlock(state.sectorRankings, state.sectorLeaders, state.timeWindow);
    prompt = buildTaskPrompt(state, dataBlock);
  } else if (state.activeCapabilities.includes(GROWTH_AUTHENTICITY_CAPABILITY_ID)) {
    const dataBlock = buildGrowthDataBlock(state.growthAuthenticity, state.timeWindow);
    prompt = buildGrowthTaskPrompt(state, dataBlock);
  } else if (
    state.intent === "followup" &&
    (state.growthAuthenticity !== null || state.sectorRankings !== null)
  ) {
    // Disambiguation: a thread can have BOTH `sectorRankings` and
    // `growthAuthenticity` populated, from two different earlier turns, with
    // no ordering signal in state to say which is more recent. A ticker
    // freshly parsed from THIS message is the strongest available signal the
    // question is about the single-ticker analysis rather than the sector
    // one — a documented heuristic (§5.3/§9's "no silent guessing"
    // principle), not a coin flip.
    const followsGrowthCheck =
      state.growthAuthenticity !== null &&
      (state.tickers.length > 0 || state.sectorRankings === null);

    const dataBlock = followsGrowthCheck
      ? buildGrowthDataBlock(state.growthAuthenticity, state.timeWindow)
      : buildDataBlock(state.sectorRankings, state.sectorLeaders, state.timeWindow);
    prompt = buildFollowupTaskPrompt(state, dataBlock, latestUserText(state.messages));
  } else if (state.intent === "followup") {
    // Nothing computed yet in this thread to follow up on — honest message,
    // no LLM call, since there is nothing to narrate.
    const message =
      "There's no earlier analysis in this conversation yet to follow up on. Ask a " +
      'sector/industry trend question (e.g. "which sectors are trending up this ' +
      'month?") or a single-ticker growth-authenticity question (e.g. "is NVDA\'s ' +
      'growth backed by revenue?") to get started.';
    return {
      draftReport: message,
      finalReport: message,
      validationPassed: true,
      messages: [new AIMessage(message)],
    };
  } else {
    // An honest "not supported" rather than a fabricated answer — and no LLM
    // call, since there is nothing to narrate.
    const message =
      "That request is outside what this agent can currently analyse. It supports " +
      "sector and industry trend analysis, and single-ticker growth-authenticity " +
      'checks — for example: "which sectors are trending up this month, and who is ' +
      'leading them?" or "is NVDA\'s growth backed by revenue or just the AI trade?"';
    return {
      draftReport: message,
      finalReport: message,
      validationPassed: true,
      messages: [new AIMessage(message)],
    };
  }

  const messages = [new SystemMessage(SYSTEM_PROMPT), new HumanMessage(prompt)];
  emitProgress(config, "report_writer", attemptMessage);
  const result = await invokeWithFallback(messages);

  if ("error" in result) {
    // §8: degrade into a `*Errors` field rather than crashing the run. The
    // graph still terminates and the API still responds — with an honest
    // failure instead of a 500.
    const message = result.error instanceof Error ? result.error.message : String(result.error);
    return {
      draftReport: null,
      dataErrors: [...state.dataErrors, `Report generation failed: ${message}`],
      retryCount: state.retryCount + 1,
    };
  }

  console.info(
    `[report-writer] draft generated via ${result.provider} (attempt ${state.retryCount + 1})`,
  );

  return {
    draftReport: result.text,
    messages: [new AIMessage(result.text)],
    retryCount: state.retryCount + 1,
  };
}
