/**
 * =============================================================================
 * main.tsx — the browser entry point.
 * =============================================================================
 *
 * This is the file `index.html`'s <script type="module"> points at, and it does
 * exactly one job: hand the #root DOM node over to React. Everything after this
 * point is React's world.
 *
 * Three details worth understanding rather than copying:
 *
 * 1. NO `import React from "react"`. The `"jsx": "react-jsx"` setting in
 *    tsconfig.json turns on the automatic JSX runtime, so the compiler injects
 *    the JSX factory import itself.
 *
 * 2. `createRoot` (not the legacy `ReactDOM.render`) is React 18's concurrent
 *    root API. CLAUDE.md §2 pins React 18.
 *
 * 3. The `!` on `getElementById("root")!`. `getElementById` returns
 *    `HTMLElement | null` because the compiler cannot know the element exists.
 *    We do — it is hard-coded in index.html — so the non-null assertion is
 *    correct here. This is the ONE place in the web app where that assertion is
 *    justified; anywhere else it would be papering over a real unknown.
 *
 * ROUTES (§7.2)
 * --------------
 * Every one of `App`'s steps is its own URL rather than only client-side
 * state: `/` (landing/new conversation), `/t/:threadId` (a conversation's
 * latest report), `/t/:threadId/sector/:sector` (a sector selected),
 * `/t/:threadId/sector/:sector/ticker/:ticker` (a leader's drilldown open).
 * All four render the exact same `App` element, which reads `threadId` /
 * `sector` / `ticker` via `useParams()` — the URL is the state, not a mirror
 * of it, so a refresh or a shared link reproduces the same view.
 *
 * A PRODUCTION DEPLOYMENT NOTE, not a code concern here: `BrowserRouter` needs
 * the HOST to serve `index.html` for any of these paths, not just `/` — Vite's
 * dev server already does this (SPA fallback is its default), but a static
 * production host must be configured for it too, or a direct visit to
 * `/t/<uuid>` 404s at the HTTP layer before React ever runs.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { App } from "./App.js";
// Imported for their side effect: Vite sees these, bundles the CSS, and
// injects it. There is no JS export — the import IS the mechanism.
//
// Order matters. `design-system.css` is the Modernist design system —
// tokens (`--color-*`, `--font-*`, `--space-*`) and its component classes
// (`.btn`, `.input`, `.table`, ...) — imported verbatim from the Claude
// Design project (see that file's header for why it must stay byte-for-byte
// identical to the export). `styles.css` is the app-specific layer built on
// top of those tokens, so it must load second to read the variables the first
// file defines.
import "./design-system.css";
import "./styles.css";

const rootElement = document.getElementById("root")!;

createRoot(rootElement).render(
  // StrictMode is a development-only wrapper. It deliberately double-invokes
  // component render functions and effects to surface impure renders and
  // missing effect cleanups early. It disappears entirely in a production
  // build — it costs nothing shipped.
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/t/:threadId" element={<App />} />
        <Route path="/t/:threadId/sector/:sector" element={<App />} />
        <Route path="/t/:threadId/sector/:sector/ticker/:ticker" element={<App />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
