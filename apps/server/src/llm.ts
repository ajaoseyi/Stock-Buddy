/**
 * =============================================================================
 * llm.ts — the provider-agnostic model factory.
 * =============================================================================
 *
 * CLAUDE.md §2: "Google Gemini 2.5 Flash via `@langchain/google-genai` (free
 * tier) as primary; Groq as a fast fallback if Gemini is rate-limited. Both are
 * configured behind a single `getLlm()` factory — **never hardcode a provider
 * inside a node**."
 *
 * WHY THE INDIRECTION MATTERS
 * ---------------------------
 * Exactly one node in this codebase generates prose (`report-writer.ts`), and
 * one more could optionally use a model. If either imported
 * `ChatGoogleGenerativeAI` directly, three things would become hard:
 *
 *   1. Falling back to Groq when Gemini is rate-limited — the free tier is
 *      ~15 requests/minute, and the validation retry loop can issue several
 *      calls in quick succession.
 *   2. Testing without a network or an API key. Tests inject a fake through
 *      `setLlmForTesting()` rather than mocking a third-party module.
 *   3. Changing model or provider later, which would otherwise mean editing
 *      node logic to change infrastructure.
 *
 * WHAT THIS FILE IS NOT FOR
 * -------------------------
 * §1's rule stands above everything here: the LLM never computes a number.
 * This factory hands out a text generator for NARRATION only. Every figure it
 * is asked to write about was computed by a deterministic node first and is
 * checked against those computations afterwards by `validator.ts` (§5.6).
 */

import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatGroq } from "@langchain/groq";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

/** Which provider a model instance came from. Used for logging and fallback. */
export type LlmProvider = "gemini" | "groq";

/** A model plus the identity of whoever supplied it. */
export interface LlmHandle {
  model: BaseChatModel;
  provider: LlmProvider;
}

/**
 * Temperature 0.2 rather than 0.
 *
 * The report writer is narrating fixed numbers, so creativity is not wanted —
 * but a temperature of exactly 0 makes some models repetitive and prone to
 * getting stuck in a phrasing rut on the validation-retry loop, where we
 * specifically want a DIFFERENT attempt rather than the same one again. A small
 * non-zero value gives the retry a chance to actually differ.
 */
const TEMPERATURE = 0.2;

/** Test seam — set by unit tests to a fake, cleared afterwards. */
let testOverride: LlmHandle | null = null;

/** Inject a fake model for tests. Pass `null` to restore real behaviour. */
export function setLlmForTesting(handle: LlmHandle | null): void {
  testOverride = handle;
}

/**
 * Build a chat model, preferring Gemini and falling back to Groq.
 *
 * Reads keys at CALL time rather than module load, so `dotenv.config()` in
 * `index.ts` has certainly run first.
 *
 * @param preferred force a specific provider; used by the fallback path so a
 *                  retry can deliberately switch away from a rate-limited one.
 * @param options.temperature override the default 0.2 for this call only.
 *                  `supervisor.ts`'s intent classifier passes `0` here — a
 *                  closed-enum classification decision has none of the
 *                  phrasing-rut concern the default temperature exists to
 *                  avoid (see the constant's own comment), and the lowest
 *                  variance is what a routing decision wants.
 * @throws if no provider is configured at all — an actionable message naming
 *         the environment variables, because this is a setup problem the
 *         developer must fix, not a data problem to degrade around.
 */
export function getLlm(preferred?: LlmProvider, options?: { temperature?: number }): LlmHandle {
  if (testOverride !== null) return testOverride;

  const temperature = options?.temperature ?? TEMPERATURE;
  const googleKey = process.env["GOOGLE_API_KEY"];
  const groqKey = process.env["GROQ_API_KEY"];

  const wantGroq = preferred === "groq";
  const canUseGemini = googleKey !== undefined && googleKey.trim() !== "";
  const canUseGroq = groqKey !== undefined && groqKey.trim() !== "";

  if (canUseGemini && !wantGroq) {
    return {
      provider: "gemini",
      model: new ChatGoogleGenerativeAI({
        /**
         * ⚠️ NOT `gemini-2.5-flash`, despite what §2 says. Verified against the
         * live API: that model now returns
         *
         *     404 — "This model models/gemini-2.5-flash is no longer available
         *            to new users."
         *
         * It still APPEARS in the `models` list endpoint, which makes the
         * failure confusing — the list says it exists, `generateContent` says
         * it does not. `gemini-2.5-flash-lite` is retired the same way.
         *
         * `gemini-flash-latest` is a moving alias that Google points at the
         * current stable Flash model, so it cannot go stale the way a pinned
         * version just did. The trade-off is that the underlying model can
         * change without a code change — acceptable here because this model
         * only NARRATES numbers it is given, and `validator.ts` checks every
         * figure afterwards (§5.6). A model swap cannot introduce a wrong
         * number; at worst it changes prose style.
         *
         * Override with GEMINI_MODEL to pin a specific version.
         */
        model: process.env["GEMINI_MODEL"] ?? "gemini-flash-latest",
        temperature,
        apiKey: googleKey,
      }),
    };
  }

  if (canUseGroq) {
    return {
      provider: "groq",
      model: new ChatGroq({
        model: process.env["GROQ_MODEL"] ?? "llama-3.3-70b-versatile",
        temperature,
        apiKey: groqKey,
      }),
    };
  }

  throw new Error(
    "No LLM provider is configured. Set GOOGLE_API_KEY (primary) or GROQ_API_KEY " +
      "(fallback) in apps/server/.env — see apps/server/.env.example.",
  );
}

/**
 * Is this error the provider telling us to slow down?
 *
 * Both providers surface rate limits as HTTP 429, but the SDKs wrap them
 * differently and neither guarantees a typed error class, so this matches on
 * the recurring vocabulary instead. Used by `report-writer.ts` to decide
 * whether switching provider is worth trying — a 429 is worth retrying
 * elsewhere, a malformed-prompt error is not.
 */
export function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /429|rate.?limit|quota|resource.?exhausted|too many requests/i.test(message);
}
