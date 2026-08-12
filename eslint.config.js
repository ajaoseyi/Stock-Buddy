// =============================================================================
// Shared ESLint configuration for the whole monorepo (CLAUDE.md §2: "ESLint +
// Prettier, shared config at repo root").
//
// This is ESLint's "flat config" format (the `eslint.config.js` array style
// that replaced `.eslintrc`). A flat config is literally an array of config
// objects. For any given file, ESLint walks the array top to bottom and merges
// every object whose `files` glob matches. Later objects win on conflicts.
// That ordering is why `eslintConfigPrettier` is last: its only job is to
// switch OFF stylistic rules that would fight Prettier, so it has to be able to
// override everything above it.
// =============================================================================

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  // ---------------------------------------------------------------------------
  // 1. Global ignores.
  //
  // An object containing ONLY `ignores` is special-cased by ESLint: it applies
  // globally rather than to a particular file set. This replaces `.eslintignore`.
  // ---------------------------------------------------------------------------
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      // Fixtures are verbatim third-party API captures — not our code to lint.
      "apps/server/tests/fixtures/**",
    ],
  },

  // ---------------------------------------------------------------------------
  // 2. Baseline rules for every JS/TS file.
  //
  // `js.configs.recommended` is ESLint's core rule set (no-undef, no-dupe-keys,
  // and friends). `tseslint.configs.recommended` layers on the TypeScript
  // parser plus TS-aware rules, and disables core rules that the TS compiler
  // already covers better (e.g. `no-unused-vars` is swapped for the TS version
  // that understands types and interfaces).
  // ---------------------------------------------------------------------------
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ---------------------------------------------------------------------------
  // 3. Project-wide rule tuning.
  //
  // Each rule here maps to a specific, stated convention in CLAUDE.md §8 —
  // this is the automated enforcement of that section, so the reviewer does not
  // have to police it by eye.
  // ---------------------------------------------------------------------------
  {
    rules: {
      // CLAUDE.md §8: "no `any` except at the immediate boundary of an untyped
      // external response, and even then, parse it through zod within the same
      // function." A hard `error` would make those legitimate boundary casts
      // impossible to write; `warn` keeps them visible and reviewable instead.
      "@typescript-eslint/no-explicit-any": "warn",

      // Unused variables are an error, but the conventional `_`-prefix escape
      // hatch stays open — needed for signatures where you must accept an
      // argument you do not use (e.g. an unused `config` param on a node).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // CLAUDE.md §8: "No silent `catch {}`". This rule forbids an empty block
      // anywhere; `allowEmptyCatch` is deliberately NOT enabled, so a bare
      // `catch {}` fails lint. Every caught error must degrade into a `*Errors`
      // state field or be rethrown with added context.
      "no-empty": ["error", { allowEmptyCatch: false }],

      // Floating promises are the classic source of "the cache write silently
      // never happened". Requires type information, so it is only switched on
      // for the server app below — see block 4.
    },
  },

  // ---------------------------------------------------------------------------
  // 4. Server-only: type-aware linting.
  //
  // Rules like `no-floating-promises` need the TypeScript *type checker*, not
  // just the parser — typescript-eslint has to build a real TS program to know
  // that an expression is a Promise. It is slower, which is why it is scoped to
  // the server (where the async tool/graph code that benefits lives) rather
  // than applied repo-wide.
  //
  // `project` points at `tsconfig.eslint.json`, NOT `tsconfig.json`. The build
  // config excludes `tests/` so that `dist/` stays clean, but a file no
  // tsconfig includes is a file typescript-eslint refuses to parse
  // ("was not found by the project service") — which would silently leave the
  // entire test suite unlinted. The `.eslint` config is a superset that
  // includes them.
  // ---------------------------------------------------------------------------
  {
    files: ["apps/server/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: ["./apps/server/tsconfig.eslint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      // Catches `if (someAsyncFn())` — always truthy, always a bug.
      "@typescript-eslint/no-misused-promises": "error",
    },
  },

  // ---------------------------------------------------------------------------
  // 5. Web-only: browser globals.
  //
  // Without this, `no-undef` flags `window`, `document`, and `fetch` in the
  // React app as undefined identifiers.
  // ---------------------------------------------------------------------------
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        window: "readonly",
        document: "readonly",
        fetch: "readonly",
        console: "readonly",
        AbortController: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  },

  // ---------------------------------------------------------------------------
  // 6. Prettier compatibility — MUST stay last.
  //
  // This config contains no rules of its own; it only sets stylistic rules to
  // "off" so ESLint never reports a formatting opinion that contradicts
  // Prettier. Formatting is Prettier's job, correctness is ESLint's.
  // ---------------------------------------------------------------------------
  eslintConfigPrettier,
);
