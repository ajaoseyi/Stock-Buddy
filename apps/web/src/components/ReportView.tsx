/**
 * =============================================================================
 * ReportView.tsx — the LLM-authored prose, with its entities made clickable.
 * =============================================================================
 *
 * Presentational only (§8).
 *
 * WHY THERE IS A HAND-ROLLED MARKDOWN RENDERER HERE
 * -------------------------------------------------
 * `report-writer.ts` prompts for "plain markdown: short paragraphs and bullet
 * lists. No tables." That is a small, known subset — headings, bullets, bold,
 * paragraphs — so this renders it directly rather than adding a markdown
 * dependency. CLAUDE.md §2 lists the web stack precisely (React + Vite +
 * TypeScript + fetch) and does not include one; pulling in a parser plus its
 * sanitiser would be a real dependency decision, not a detail to slip in.
 *
 * ⚠️ THE SAFETY POINT, STATED PLAINLY. The renderer below builds React
 * ELEMENTS. It never calls `dangerouslySetInnerHTML`, so any HTML or script in
 * the model's output is displayed as literal text rather than executed. React
 * escapes it automatically. That is not an incidental property — it is the
 * reason this approach is acceptable at all, and it must not be "optimised"
 * into raw HTML injection later.
 *
 * If richer markdown is ever needed (tables, links, nested lists), that is the
 * moment to add a real parser WITH a sanitiser, not to extend the regexes here.
 *
 * THE DESIGN'S CONTRIBUTION: ENTITY TOKENS
 * ----------------------------------------
 * The design turns sector names and tickers inside the narrative into controls
 * that jump to the corresponding data. That is the interaction which makes good
 * on §1's promise — a reader who doubts "NVDA is the anchor leader" clicks NVDA
 * and lands on the computed weight, speed and relative volume behind the claim.
 *
 * ⚠️ THE LINK SET IS SUPPLIED BY THE CALLER AND IS DERIVED FROM COMPUTED STATE,
 * never from the prose. Only tickers present in `sectorLeaders` and sectors
 * present in `sectorRankings` can become links. A hallucinated ticker therefore
 * renders as flat text and quietly fails to be clickable, rather than being
 * dignified with a link to nothing.
 */

import type { JSX } from "react";

// =============================================================================
// SECTION 1 — Entity linking
// =============================================================================

/** One clickable entity in the narrative. */
export interface NarrativeLink {
  /** The exact text to match, e.g. "NVDA" or "Information Technology". */
  text: string;
  /** Where clicking it takes the reader. */
  onSelect: () => void;
  /** Tooltip — typically the figure behind the claim. */
  title?: string;
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile the link set into one matcher.
 *
 * Two properties matter, and both are about NOT creating false links:
 *
 *  - **Longest first.** "Information Technology" must win over a hypothetical
 *    "Technology", otherwise the longer name is shredded into a link plus a
 *    stray word.
 *  - **Case-sensitive, with alphanumeric boundaries.** Tickers are short and
 *    several are ordinary English words — SO (Southern), ON (ON Semiconductor),
 *    ALL (Allstate), KEY, CAT. Requiring the exact upper-case form stops the
 *    word "so" in a sentence from becoming a link to a utility company, and the
 *    boundaries stop "CAT" from matching inside "CATEGORY".
 */
function compileMatcher(links: NarrativeLink[]): RegExp | null {
  if (links.length === 0) return null;

  const alternatives = [...links]
    .sort((a, b) => b.text.length - a.text.length)
    .map((link) => escapeRegExp(link.text))
    .join("|");

  return new RegExp(`(?<![A-Za-z0-9])(${alternatives})(?![A-Za-z0-9])`, "g");
}

// =============================================================================
// SECTION 2 — Markdown
// =============================================================================

/** Everything the renderer needs to turn matched text into a control. */
interface LinkContext {
  matcher: RegExp;
  byText: Map<string, NarrativeLink>;
}

/**
 * Split one run of plain text into text and link nodes.
 *
 * Returns the input unchanged when there is no link context, which is what
 * keeps `renderMarkdown(markdown)` — the one-argument form the tests use —
 * producing exactly the element tree it always did.
 */
function linkify(
  text: string,
  keyPrefix: string,
  context: LinkContext | null,
): (string | JSX.Element)[] {
  if (context === null) return [text];

  const parts: (string | JSX.Element)[] = [];
  let lastIndex = 0;
  let index = 0;
  let match: RegExpExecArray | null;

  // `lastIndex` is stateful on a /g regex, so it is reset before each run —
  // otherwise the second paragraph would start scanning wherever the first
  // stopped and silently skip its opening entity.
  context.matcher.lastIndex = 0;

  while ((match = context.matcher.exec(text)) !== null) {
    const link = context.byText.get(match[1]!);
    if (link === undefined) continue;

    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    parts.push(
      <button
        key={`${keyPrefix}-l${index}`}
        type="button"
        className="sfs-token"
        onClick={link.onSelect}
        {...(link.title === undefined ? {} : { title: link.title })}
      >
        {link.text}
      </button>,
    );
    lastIndex = match.index + match[0].length;
    index++;
  }

  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

/**
 * Render inline emphasis within one line of text.
 *
 * Handles `**bold**` and `` `code` `` only — the two the report writer's prompt
 * actually produces. Returns an array of React nodes; unmatched text passes
 * through `linkify` and otherwise stays a plain string, which React escapes.
 */
function renderInline(
  text: string,
  keyPrefix: string,
  context: LinkContext | null,
): (string | JSX.Element)[] {
  const parts: (string | JSX.Element)[] = [];
  // Split on **bold** and `code`, keeping the delimiters via capture groups.
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(...linkify(text.slice(lastIndex, match.index), `${keyPrefix}-t${index}`, context));
    }

    const token = match[0];
    if (token.startsWith("**")) {
      // Bold text is linkified too — the report writer bolds figures and names,
      // and "**NVDA**" should be no less clickable than a bare mention.
      parts.push(
        <strong key={`${keyPrefix}-b${index}`}>
          {linkify(token.slice(2, -2), `${keyPrefix}-b${index}`, context)}
        </strong>,
      );
    } else {
      // Code spans are left alone: inside backticks the author meant literal
      // text, so turning part of it into a control would misrepresent it.
      parts.push(<code key={`${keyPrefix}-c${index}`}>{token.slice(1, -1)}</code>);
    }
    lastIndex = match.index + token.length;
    index++;
  }

  if (lastIndex < text.length) {
    parts.push(...linkify(text.slice(lastIndex), `${keyPrefix}-t${index}`, context));
  }
  return parts;
}

/**
 * Turn the markdown subset into React elements.
 *
 * Exported so it can be unit-tested without a DOM — the branching here is the
 * only real logic in the component.
 *
 * @param links optional entities to make clickable. Omitted, the output is
 *        plain text nodes exactly as before.
 */
export function renderMarkdown(markdown: string, links: NarrativeLink[] = []): JSX.Element[] {
  const matcher = compileMatcher(links);
  const context: LinkContext | null =
    matcher === null ? null : { matcher, byText: new Map(links.map((l) => [l.text, l])) };

  const lines = markdown.split("\n");
  const blocks: JSX.Element[] = [];

  // Bullets are accumulated so consecutive `- ` lines become ONE <ul> rather
  // than a list per line.
  let bullets: string[] = [];
  let paragraph: string[] = [];

  const flushBullets = () => {
    if (bullets.length === 0) return;
    const items = bullets;
    bullets = [];
    blocks.push(
      <ul key={`ul-${blocks.length}`}>
        {items.map((item, i) => (
          <li key={i}>{renderInline(item, `ul${blocks.length}-${i}`, context)}</li>
        ))}
      </ul>,
    );
  };

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.join(" ");
    paragraph = [];
    blocks.push(<p key={`p-${blocks.length}`}>{renderInline(text, `p${blocks.length}`, context)}</p>);
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    // A horizontal rule — the salvage path in graph.ts emits one before its
    // "unverified report" caveat.
    if (/^-{3,}$/.test(line.trim())) {
      flushParagraph();
      flushBullets();
      blocks.push(<hr key={`hr-${blocks.length}`} />);
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flushParagraph();
      flushBullets();
      const level = heading[1]!.length;
      const content = renderInline(heading[2]!, `h${blocks.length}`, context);
      // Headings inside the report start at h3, because the page already has
      // an h1 and the panel has an h2 — keeping the document outline valid.
      const Tag = (level <= 2 ? "h3" : "h4") as "h3" | "h4";
      blocks.push(<Tag key={`h-${blocks.length}`}>{content}</Tag>);
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      flushParagraph();
      bullets.push(bullet[1]!);
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      flushBullets();
      continue;
    }

    flushBullets();
    paragraph.push(line.trim());
  }

  flushParagraph();
  flushBullets();
  return blocks;
}

// =============================================================================
// SECTION 3 — The component
// =============================================================================

export interface ReportViewProps {
  report: string | null;
  /** False means the report carries caveats and was not fully verified (§5.6). */
  validationPassed: boolean;
  /** The window the supervisor actually parsed, e.g. "1mo". */
  timeWindow: string;
  /** Pre-formatted "3m ago" — computed by App so this stays a pure render. */
  updatedLabel: string;
  /** The question this report answers, echoed so a follow-up thread stays legible. */
  query: string;
  /** Entities to linkify. Derived from computed state by the caller. */
  links: NarrativeLink[];
}

export function ReportView({
  report,
  validationPassed,
  timeWindow,
  updatedLabel,
  query,
  links,
}: ReportViewProps) {
  return (
    <div>
      <div className="sfs-chip-row" style={{ marginBottom: "var(--space-3)" }}>
        <span className="tag tag-outline" style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
          {timeWindow} window · updated {updatedLabel}
        </span>
        {/*
          Validation status is surfaced rather than hidden. A report that failed
          validation still reaches the user (graph.ts salvages it) but WITH its
          failures stated — showing it silently would present unverified claims
          with the same confidence as verified ones.
        */}
        {validationPassed ? (
          <span
            className="tag sfs-tag-verified"
            title="Every ticker and percentage in this report was checked against the computed data."
          >
            verified
          </span>
        ) : (
          <span
            className="tag tag-accent"
            title="Automated validation did not pass. Check the figures against the tables below."
          >
            unverified
          </span>
        )}
      </div>

      {query !== "" && <div className="sfs-requery">Re: &ldquo;{query}&rdquo;</div>}

      <div className="sfs-narrative">
        {report === null || report.trim() === "" ? (
          <p className="text-muted">
            No report was produced for this question. The computed data below may still be
            complete — check the sector figures and the data notes.
          </p>
        ) : (
          renderMarkdown(report, links)
        )}
      </div>
    </div>
  );
}
