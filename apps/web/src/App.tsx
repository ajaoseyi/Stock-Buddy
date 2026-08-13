/**
 * =============================================================================
 * App.tsx — root component. Owns request state; navigation state lives in the
 * URL (§7.2), not here.
 * =============================================================================
 *
 * CLAUDE.md §8: "Keep components presentational — all data fetching happens in
 * `api/client.ts`, not inside components."
 *
 * App is the one exception, and only in a narrow sense: it holds the request
 * STATE (loading / result / error) and calls `analyze()` / `fetchThread()`.
 * It does not contain fetch logic, URL construction, or response parsing —
 * all of that lives in the client module. Everything below App is purely
 * presentational.
 *
 * THE FIVE VIEWS
 * ---------------
 * landing → working → report, with error reachable from either landing or a
 * follow-up asked from report, plus loading-thread for a direct visit to a
 * thread's URL. There is deliberately no separate `view` piece of state that
 * could drift out of sync — `view` is derived from `loading` / `loadingThread`
 * / `error` / `result`.
 *
 * URL IS THE STATE, NOT A MIRROR OF IT (§7.2)
 * ---------------------------------------------
 * `activeSector` and `drilldownTicker` used to be `useState`. They are now
 * read from `useParams()` and changed only via `navigate()` — every step
 * (which thread, which sector, which ticker drilldown) is its own URL:
 *
 *   /                                              landing / new conversation
 *   /t/:threadId                                   a conversation's latest report
 *   /t/:threadId/sector/:sector                     a sector selected
 *   /t/:threadId/sector/:sector/ticker/:ticker       a leader's drilldown open
 *
 * This is what makes a link to any of those four states reproduce the exact
 * same view on a refresh or when shared — the routing table lives in
 * `main.tsx`, all four patterns render this same `App`.
 *
 * CONVERSATION THREADS (§7.1) + DEEP-LINKING (§7.2)
 * ---------------------------------------------------
 * The server returns a `threadId` on every response; it becomes the URL's
 * `:threadId` param. A follow-up ("and what about energy?") is sent with the
 * URL's current thread id, so it resumes state server-side instead of
 * starting from nothing. Visiting `/t/:threadId` directly (refresh, bookmark,
 * a click from the history modal) has no in-memory response to show, so an
 * effect below fetches the thread's latest state via `fetchThread()` —
 * §7.2's `GET /api/thread/:threadId`, which reads the checkpointer's snapshot
 * without re-running the graph.
 *
 * WHY PAST TURNS ARE CACHED LOCALLY, NOT REFETCHED
 * ----------------------------------------------------
 * The breadcrumb history lets a reader step back to an earlier answer WITHIN
 * this thread. There is no endpoint to fetch a specific past turn by itself —
 * `GET /api/thread/:threadId` always returns the LATEST state, and
 * `POST /api/analyze` always runs the graph forward. So `historyEntries`
 * below is a small client-side cache of `{ query, response }` pairs for THIS
 * tab's session: stepping back is instant and costs no quota, and it is
 * honest about being a REPLAY, not a new analysis (nothing re-validates or
 * re-fetches when a chip is clicked). A thread loaded fresh from the URL
 * starts with exactly one entry — its latest turn — since that is all the
 * server exposes.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ApiError,
  analyzeStream,
  fetchThread,
  type AnalyzeResponse,
  type StreamEvent,
} from "./api/client.js";
import { ReportView, type NarrativeLink } from "./components/ReportView.js";
import { SectorRankingsTable } from "./components/SectorRankingsTable.js";
import { SectorLeadersPanel } from "./components/SectorLeadersPanel.js";
import { DataNotesPanel } from "./components/DataNotesPanel.js";
import { LeaderDrilldown } from "./components/LeaderDrilldown.js";
import { HistoryModal } from "./components/HistoryModal.js";
import { formatSpeed, formatWeight } from "./components/quadrant.js";
import { relativeTimeLabel } from "./relativeTime.js";

/** Example questions, so a new user is not staring at an empty box. */
const EXAMPLES = [
  "What sectors are trending up this month and who is leading them?",
  "Which industries are falling over the past 3 months?",
  "How did technology and energy perform year to date?",
];

/**
 * The five stages a run passes through, mirroring `graph.ts`'s node sequence
 * (supervisor → sector-trend → sector-leaders → report-writer → validator).
 *
 * Driven by REAL events from `POST /api/analyze/stream` (`analyzeStream` in
 * `api/client.ts`), not a timer — each line below only appears once the
 * corresponding node actually emitted it server-side. `sector_trend` alone
 * drives both `data_retrieval` and `trend_ranking`: CLAUDE.md's capability
 * spec never splits that node in two, but the UI's step list predates
 * streaming and still draws that distinction, so its progress events carry a
 * `phase` field that routes them to one log or the other (see
 * `stepIdForProgress` below).
 */
type StepId = "data_retrieval" | "trend_ranking" | "leader_identification" | "report_writing" | "validation";

const STEP_IDS: readonly StepId[] = [
  "data_retrieval",
  "trend_ranking",
  "leader_identification",
  "report_writing",
  "validation",
];

const STEP_LABELS: Record<StepId, string> = {
  data_retrieval: "Data retrieval",
  trend_ranking: "Trend ranking",
  leader_identification: "Leader identification",
  report_writing: "Report writing",
  validation: "Validation",
};

/** One step's live state: whether it's run yet, and the real narration it has produced so far. */
interface StepState {
  status: "pending" | "active" | "done";
  log: string[];
  /** How many times this step has run. >1 means the report writer/validator retry loop looped back. */
  attempt: number;
}

type StepStates = Record<StepId, StepState>;

function freshStep(status: StepState["status"] = "pending"): StepState {
  return { status, log: [], attempt: 1 };
}

/** `data_retrieval` starts active so the working view isn't blank the instant a request begins. */
function initialStepStates(): StepStates {
  return {
    data_retrieval: freshStep("active"),
    trend_ranking: freshStep(),
    leader_identification: freshStep(),
    report_writing: freshStep(),
    validation: freshStep(),
  };
}

/** Which step a `progress` event's narration belongs to. `null` = not shown in this view (e.g. `supervisor`). */
function stepIdForProgress(node: string, phase: string | undefined): StepId | null {
  switch (node) {
    case "sector_trend":
      return phase === "trend_ranking" ? "trend_ranking" : "data_retrieval";
    case "sector_leaders":
      return "leader_identification";
    case "report_writer":
      return "report_writing";
    case "validator":
      return "validation";
    default:
      return null;
  }
}

/** Which step(s) a `node_complete` event closes out. `sector_trend` alone closes two — see file note above. */
function stepIdsForNodeComplete(node: string): StepId[] {
  switch (node) {
    case "sector_trend":
      return ["data_retrieval", "trend_ranking"];
    case "sector_leaders":
      return ["leader_identification"];
    case "report_writer":
      return ["report_writing"];
    case "validator":
      return ["validation"];
    default:
      return [];
  }
}

function updateStep(states: StepStates, stepId: StepId, fn: (step: StepState) => StepState): StepStates {
  return { ...states, [stepId]: fn(states[stepId]) };
}

/**
 * Fold one `StreamEvent` into the working view's step states.
 *
 * RETRY HANDLING: `report_writer`/`validator` can each fire more than once
 * (bounded by `MAX_REPORT_ATTEMPTS` server-side). When an event for a step
 * arrives while that step is already `"done"`, this is a new attempt: the
 * step reopens to `"active"` and a separator line is pushed rather than the
 * log being cleared, so the full history — including that a retry happened —
 * stays visible. Hiding it would be the same kind of silent-correction this
 * codebase's server side explicitly refuses to do elsewhere.
 */
function applyStreamEvent(event: StreamEvent, prev: StepStates): StepStates {
  if (event.type === "progress") {
    const stepId = stepIdForProgress(event.node, event.phase);
    if (stepId === null) return prev;

    return updateStep(prev, stepId, (step) => {
      if (step.status === "done") {
        const attempt = step.attempt + 1;
        return { status: "active", attempt, log: [...step.log, `— Attempt ${attempt} —`, event.message] };
      }
      return { ...step, status: "active", log: [...step.log, event.message] };
    });
  }

  if (event.type === "node_complete") {
    return stepIdsForNodeComplete(event.node).reduce(
      (states, stepId) => updateStep(states, stepId, (step) => ({ ...step, status: "done" })),
      prev,
    );
  }

  return prev;
}

/** One past turn in this conversation, cached for instant breadcrumb replay. */
interface HistoryEntry {
  query: string;
  response: AnalyzeResponse;
  fetchedAt: number;
}

/** The top-ranked sector in a response, or the first sector with leader data. */
function defaultSector(response: AnalyzeResponse): string | null {
  const rankings = response.sectorRankings ?? [];
  if (rankings.length > 0) {
    return [...rankings].sort((a, b) => b.pctChange - a.pctChange)[0]!.sector;
  }
  const leaderSectors = Object.keys(response.sectorLeaders ?? {});
  return leaderSectors[0] ?? null;
}

/**
 * Build the narrative's clickable entities from COMPUTED state only.
 *
 * §1's non-negotiable rule — the LLM never computes a number, every claim
 * traces to deterministic output — extends here: a link is only offered for a
 * sector or ticker that genuinely exists in `sectorRankings`/`sectorLeaders`.
 * A hallucinated name in the prose has nothing to match against and simply
 * renders as flat text (see `ReportView`'s matcher), which is the correct
 * failure mode — no link to nowhere, and no special-casing required here.
 */
function buildNarrativeLinks(
  response: AnalyzeResponse,
  onSelectSector: (sector: string) => void,
  onOpenDrilldown: (ticker: string, sector: string) => void,
): NarrativeLink[] {
  const links: NarrativeLink[] = [];

  for (const ranking of response.sectorRankings ?? []) {
    links.push({ text: ranking.sector, onSelect: () => onSelectSector(ranking.sector) });
  }

  for (const [sector, leaders] of Object.entries(response.sectorLeaders ?? {})) {
    for (const leader of leaders) {
      links.push({
        text: leader.ticker,
        title: `${formatWeight(leader.weightScore)} weight · ${formatSpeed(leader.speedScore)} speed`,
        onSelect: () => onOpenDrilldown(leader.ticker, sector),
      });
    }
  }

  return links;
}

// =============================================================================
// URL helpers (§7.2) — the single place a route for one of the four patterns
// in `main.tsx` gets built, so the encoding rule (sector/ticker names can
// contain spaces and punctuation) lives in exactly one place.
// =============================================================================

function threadPath(threadId: string): string {
  return `/t/${threadId}`;
}

function sectorPath(threadId: string, sector: string): string {
  return `${threadPath(threadId)}/sector/${encodeURIComponent(sector)}`;
}

function tickerPath(threadId: string, sector: string, ticker: string): string {
  return `${sectorPath(threadId, sector)}/ticker/${encodeURIComponent(ticker)}`;
}

/** Small inline icon so the history trigger needs no icon-library dependency. */
function HistoryIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 7v5l3.5 2M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function App() {
  const params = useParams<{ threadId?: string; sector?: string; ticker?: string }>();
  const navigate = useNavigate();

  const urlThreadId = params.threadId;
  const urlSector = params.sector !== undefined ? decodeURIComponent(params.sector) : null;
  const urlTicker = params.ticker !== undefined ? decodeURIComponent(params.ticker) : null;

  // --- Request state -----------------------------------------------------------
  const [query, setQuery] = useState("");
  const [followUpQuery, setFollowUpQuery] = useState("");
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [activeQueryLabel, setActiveQueryLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  /** Loading a THREAD SNAPSHOT (no graph run) — distinct from `loading`, which is a live analysis. */
  const [loadingThread, setLoadingThread] = useState(false);

  // --- Client-side history / modal state ----------------------------------------
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const [stepStates, setStepStates] = useState<StepStates>(initialStepStates);
  const [now, setNow] = useState(() => Date.now());

  /** Lets a new submission cancel one already in flight. */
  const abortRef = useRef<AbortController | null>(null);

  /** Sentinel at the foot of the working log — scrolled into view as new step events arrive. */
  const workingEndRef = useRef<HTMLDivElement | null>(null);

  // Keep "Xm ago" from going stale during a long session on the report view.
  useEffect(() => {
    if (result === null) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [result]);

  // Keep the newest streamed line in view as the working log grows — otherwise
  // a long-running step (leader identification across 6 sectors) scrolls the
  // page's live edge out of the viewport while the user is still watching.
  useEffect(() => {
    if (!loading) return;
    workingEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [loading, stepStates]);

  // --- Deep-linking (§7.2): load a thread's snapshot when the URL names one
  // this tab doesn't already have in memory — a refresh, a bookmark, or a
  // click from the history modal. Skipped while `loading`, because a
  // just-submitted analyze/stream call is already producing this exact
  // result and will land in `result` momentarily via `submit` below.
  useEffect(() => {
    if (urlThreadId === undefined) return;
    if (result !== null && result.threadId === urlThreadId) return;
    if (loading) return;

    let cancelled = false;
    setLoadingThread(true);
    setError(null);
    setErrorDetails([]);

    fetchThread(urlThreadId)
      .then((snapshot) => {
        if (cancelled) return;
        setResult(snapshot);
        setActiveQueryLabel(snapshot.query);
        setHistoryEntries([{ query: snapshot.query, response: snapshot, fetchedAt: Date.now() }]);
      })
      .catch((caught) => {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : String(caught));
        setErrorDetails(caught instanceof ApiError ? caught.details : []);
      })
      .finally(() => {
        if (!cancelled) setLoadingThread(false);
      });

    return () => {
      cancelled = true;
    };
  }, [urlThreadId, result, loading]);

  const submit = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed === "" || loading) return;

      // Cancel any in-flight request — the user has moved on, and letting the
      // old response land would overwrite the new one out of order.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const continuingThreadId = result?.threadId;

      setLoading(true);
      setError(null);
      setErrorDetails([]);
      setStepStates(initialStepStates());

      try {
        const response = await analyzeStream({
          query: trimmed,
          ...(continuingThreadId === undefined ? {} : { threadId: continuingThreadId }),
          signal: controller.signal,
          onEvent: (event: StreamEvent) => {
            // The "result"/"error" events resolve/reject `analyzeStream` itself
            // (see client.ts) — only "progress"/"node_complete" reach here, so
            // this is purely the live step-log update.
            setStepStates((prev) => applyStreamEvent(event, prev));
          },
        });

        setResult(response);
        setActiveQueryLabel(trimmed);
        setHistoryEntries((entries) => [
          ...entries,
          { query: trimmed, response, fetchedAt: Date.now() },
        ]);
        // Bare thread URL — no sector/ticker segment. `activeSector` below
        // falls back to `defaultSector(result)` whenever the URL doesn't name
        // one, so this alone is enough to show the top sector.
        navigate(threadPath(response.threadId));
      } catch (caught) {
        // A cancellation is not a failure — the user superseded it, and the
        // newer request is already updating the UI.
        if (caught instanceof ApiError && caught.message === "Request cancelled.") return;

        setError(caught instanceof Error ? caught.message : String(caught));
        setErrorDetails(caught instanceof ApiError ? caught.details : []);
      } finally {
        // Only the newest request may clear the loading flag; an older,
        // superseded one must not.
        if (abortRef.current === controller) setLoading(false);
      }
    },
    [loading, result, navigate],
  );

  const startNewConversation = () => {
    abortRef.current?.abort();
    setResult(null);
    setError(null);
    setErrorDetails([]);
    setQuery("");
    setFollowUpQuery("");
    setHistoryEntries([]);
    navigate("/");
  };

  /** Replay a past turn from the local cache — no request, see file header. */
  const selectHistoryEntry = (entry: HistoryEntry) => {
    setResult(entry.response);
    setActiveQueryLabel(entry.query);
    // Bare thread URL — the older turn may not have had the same sectors, so
    // any sector/ticker selection from the current turn is not carried over.
    navigate(threadPath(entry.response.threadId));
  };

  const selectSector = useCallback(
    (sector: string) => {
      if (result === null) return;
      navigate(sectorPath(result.threadId, sector));
    },
    [result, navigate],
  );

  // `activeSector` is read below before this can be defined in terms of it,
  // so the fallback sector (when opened without one, e.g. from a narrative
  // ticker link) is resolved inline rather than via a shared closure.
  const openDrilldown = useCallback(
    (ticker: string, sector?: string) => {
      if (result === null) return;
      const targetSector = sector ?? urlSector ?? defaultSector(result);
      if (targetSector === null) return;
      navigate(tickerPath(result.threadId, targetSector, ticker));
    },
    [result, urlSector, navigate],
  );

  const closeDrilldown = useCallback(() => {
    if (result === null) return;
    const sector = urlSector ?? defaultSector(result);
    navigate(sector === null ? threadPath(result.threadId) : sectorPath(result.threadId, sector));
  }, [result, urlSector, navigate]);

  const openThreadFromHistory = (threadId: string) => {
    setHistoryModalOpen(false);
    if (threadId === result?.threadId) return;
    navigate(threadPath(threadId));
  };

  // --- Derived view -----------------------------------------------------------
  const view: "landing" | "working" | "loading-thread" | "error" | "report" = loading
    ? "working"
    : loadingThread
      ? "loading-thread"
      : error !== null
        ? "error"
        : result !== null
          ? "report"
          : "landing";

  // A thread the URL names but the server no longer has (deleted, or a bad
  // link) — distinct from a submit failure, where `result` still holds the
  // previous successful turn and the query box is still worth retrying.
  const isThreadLoadError = error !== null && result === null && urlThreadId !== undefined;

  const activeSector = urlSector ?? (result !== null ? defaultSector(result) : null);
  const drilldownTicker = urlTicker;

  const rankings = result?.sectorRankings ?? [];
  const sectorOrder = [...rankings].sort((a, b) => b.pctChange - a.pctChange).map((r) => r.sector);
  const leaders = result?.sectorLeaders ?? {};

  const narrativeLinks = result === null ? [] : buildNarrativeLinks(result, selectSector, openDrilldown);

  return (
    <div className="sfs-shell">
      {/* --- Nav ------------------------------------------------------------ */}
      <div className="nav">
        <span className="nav-brand" style={{ flexShrink: 0, whiteSpace: "nowrap" }}>
          Smart Financial Solutions
        </span>

        {view === "report" && (
          <form
            className="sfs-nav-search"
            onSubmit={(event) => {
              event.preventDefault();
              void submit(followUpQuery);
              setFollowUpQuery("");
            }}
          >
            <label htmlFor="follow-up" className="sr-only">
              Ask a follow-up
            </label>
            <input
              id="follow-up"
              className="input"
              type="text"
              value={followUpQuery}
              onChange={(event) => setFollowUpQuery(event.target.value)}
              placeholder="Ask a follow-up..."
            />
            <button type="submit" className="btn btn-primary" disabled={followUpQuery.trim() === ""}>
              Ask
            </button>
          </form>
        )}

        <button
          type="button"
          className="btn btn-icon btn-ghost"
          onClick={() => setHistoryModalOpen(true)}
          aria-label="Conversation history"
          title="Conversation history"
        >
          <HistoryIcon />
        </button>

        {view === "report" && (
          <button type="button" className="btn btn-ghost" onClick={startNewConversation}>
            New question
          </button>
        )}
      </div>

      {/* --- Breadcrumb history ---------------------------------------------- */}
      {view === "report" && historyEntries.length > 1 && (
        <div className="sfs-history">
          <div className="text-muted sfs-eyebrow">Back to a previous answer</div>
          <div className="sfs-chip-row">
            {historyEntries.map((entry, i) => (
              <button
                key={`${entry.query}-${i}`}
                type="button"
                className={`tag sfs-chip${entry.query === activeQueryLabel ? " sfs-chip-current" : ""}`}
                onClick={() => selectHistoryEntry(entry)}
              >
                ↩ {entry.query.length > 34 ? `${entry.query.slice(0, 34)}…` : entry.query}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* --- Landing ----------------------------------------------------------- */}
      {view === "landing" && (
        <div className="sfs-landing">
          <div>
            <h1>What do you  want to understand today?</h1>
            <p className="text-muted sfs-landing-sub">
              Ask about sector trends, momentum, or the companies leading them. Every answer shows
              its work.
            </p>
          </div>
          <div className="hr" style={{ width: "100%" }} />
          <form
            className="sfs-ask-row"
            onSubmit={(event) => {
              event.preventDefault();
              void submit(query);
            }}
          >
            <label htmlFor="query" className="sr-only">
              Your question
            </label>
            <input
              id="query"
              className="input"
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="e.g. Which sectors are trending up this month?"
              autoComplete="off"
            />
            <button type="submit" className="btn btn-primary" disabled={query.trim() === ""}>
              Analyze
            </button>
          </form>
          {query.trim() === "" && (
            <div className="sfs-examples">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  className="btn btn-secondary btn-block sfs-example"
                  onClick={() => {
                    setQuery(example);
                    void submit(example);
                  }}
                >
                  {example}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* --- Working ------------------------------------------------------------ */}
      {view === "working" && (
        <div className="sfs-working">
          <div className="sfs-working-inner">
            <p className="text-muted" style={{ fontSize: "13px", marginBottom: "var(--space-4)" }}>
              Analysing: &quot;{query.trim() !== "" ? query : followUpQuery}&quot;
            </p>
            {STEP_IDS.map((stepId) => {
              const step = stepStates[stepId];
              const state =
                step.status === "done"
                  ? "sfs-step-done"
                  : step.status === "active"
                    ? "sfs-step-active"
                    : "sfs-step-pending";
              return (
                <div key={stepId} className={`sfs-step ${state}`}>
                  <div className="sfs-step-mark">{step.status === "done" ? "✓" : ""}</div>
                  <div>
                    <div className="sfs-step-label">{STEP_LABELS[stepId]}</div>
                    {step.log.length > 0 && (
                      <ul className="sfs-step-log">
                        {step.log.map((line, i) => (
                          <li key={i}>{line}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              );
            })}
            <div ref={workingEndRef} />
          </div>
        </div>
      )}

      {/* --- Loading a thread from its URL --------------------------------------- */}
      {view === "loading-thread" && (
        <div className="sfs-working">
          <div className="sfs-working-inner">
            <p className="text-muted" style={{ fontSize: "13px" }}>
              Loading conversation…
            </p>
          </div>
        </div>
      )}

      {/* --- Error --------------------------------------------------------------- */}
      {view === "error" && (
        <div className="sfs-landing">
          <div className="card" style={{ borderLeft: "3px solid var(--color-accent)", width: "100%" }}>
            <h4 style={{ margin: 0 }}>Something went wrong</h4>
            <p style={{ margin: "var(--space-2) 0 0" }}>{error}</p>
            {errorDetails.length > 0 && (
              <ul className="text-muted sfs-note-list">
                {errorDetails.map((detail, i) => (
                  <li key={i}>{detail}</li>
                ))}
              </ul>
            )}
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setError(null);
              setErrorDetails([]);
              // A thread-load failure has nowhere useful to "try again" at —
              // the URL still names a thread that isn't there. A submit
              // failure, by contrast, leaves the query box worth retrying.
              if (isThreadLoadError) navigate("/");
            }}
          >
            {isThreadLoadError ? "Back to start" : "Try again"}
          </button>
        </div>
      )}

      {/* --- Report ---------------------------------------------------------------- */}
      {view === "report" && result !== null && (
        <div className="sfs-report">
          <div className="sfs-report-inner">
            <ReportView
              report={result.finalReport}
              validationPassed={result.validationPassed}
              timeWindow={result.timeWindow}
              updatedLabel={relativeTimeLabel(
                historyEntries.find((e) => e.query === activeQueryLabel)?.fetchedAt ?? now,
                now,
              )}
              query={activeQueryLabel}
              links={narrativeLinks}
            />

            {/*
              `dataErrors` is preferred here because it is never about one
              particular sector — every entry applies regardless of what was
              asked, whereas `trendDataErrors[0]` is whatever the pipeline
              happened to report first (e.g. a different, unrelated sector's
              cross-check failure) and reads as if it applies to this answer
              even when it doesn't. The full, unscoped list of both is still
              available below in DataNotesPanel for anyone auditing the run.
            */}
            {(result.dataErrors.length > 0 || result.trendDataErrors.length > 0) && (
              <div className="text-muted sfs-note">
                &#9679; {result.dataErrors[0] ?? result.trendDataErrors[0]}
              </div>
            )}

            {/*
              The tables come AFTER the prose deliberately. §1's guarantee is that
              every number in the report traces to a computed value — these tables
              are where a reader checks that, so they belong next to the claim
              rather than on a separate screen.
            */}
            <SectorRankingsTable
              rankings={rankings}
              timeWindow={result.timeWindow}
              activeSector={activeSector}
              onSelectSector={selectSector}
            />

            {Object.keys(leaders).length > 0 && (
              <SectorLeadersPanel
                leaders={leaders}
                sectorOrder={sectorOrder}
                timeWindow={result.timeWindow}
                activeSector={activeSector ?? sectorOrder[0] ?? ""}
                onSelectSector={selectSector}
                onOpenDrilldown={(ticker) => openDrilldown(ticker)}
              />
            )}

            <DataNotesPanel trendDataErrors={result.trendDataErrors} dataErrors={result.dataErrors} />
          </div>
        </div>
      )}

      {/* --- Drilldown ------------------------------------------------------------- */}
      {drilldownTicker !== null && (
        <LeaderDrilldown leaders={leaders} ticker={drilldownTicker} onClose={closeDrilldown} />
      )}

      {/* --- History modal ----------------------------------------------------------- */}
      {historyModalOpen && (
        <HistoryModal
          onClose={() => setHistoryModalOpen(false)}
          onSelectThread={openThreadFromHistory}
          currentThreadId={result?.threadId ?? null}
        />
      )}
    </div>
  );
}
