# Build plan

Dependency-ordered. Each milestone is "done" when its acceptance criteria pass
and `npm test` is green. Don't start M(n+1) before M(n) is done.

---

## M0 — Scaffold runs
Tauri v2 + React + Vite app opens a window: dark charcoal background, empty left
sidebar, empty canvas area on the right. Inter/IBM Plex Sans bundled and applied.

**Accept:** `npm run tauri dev` opens the window on the dev machine; window title
and app identifier set; no console errors.

## M1 — Expression core *(delivered — verify, don't rebuild)*
Lexer → Pratt parser → AST → recursive numeric evaluator, structured errors with
clickable-fix suggestions, deg/rad context. Pure TS, no DOM.

**Accept:** `npm test` passes the existing suite on the dev machine.

## M2 — Explicit plotting + navigation
Canvas 2D renderer: `y = f(x)` curves via adaptive sampling (denser near high
curvature/discontinuities), pan (drag) and zoom (wheel, pinch), gridlines + axis
labels with sane tick stepping, toggleable. Sidebar accepts expressions, live
math-rendered display (KaTeX-style), per-expression color from the pastel
rotation, toggle/delete per expression.

**Accept:** `y = sin(x)`, `y = 1/x`, `y = x^3 - x` render correctly incl.
discontinuity handling; 60fps pan/zoom with 10 curves.

## M3 — Sliders + the performance target
Undefined variable in an expression → evaluator's `undefined-variable` suggestion
→ auto-generate a slider (min/max/step editable). Implement
`compile(ast): (env) => number` closures for the plot hot path (recursive
evaluator stays as the test oracle — property-test them against each other).
Dirty-tracking: a slider drag re-renders only dependent expressions.

**Accept:** perf harness script loads 50 expressions bound to sliders; dragging
stays smooth (frame budget logged, no sustained drops below ~50fps on the dev
machine). This gate is hard — do not proceed past it "for now".

## M4 — Full plot-type coverage
Parametric `(x(t), y(t))`, polar `r = f(θ)`, implicit `f(x,y) = g(x,y)` (marching
squares), inequalities with translucent shaded regions, piecewise (extend parser:
`{cond: value, cond: value, fallback}`), domain restrictions `{0 < x < 5}` wired
into every plot type, data tables / discrete points, vectors + vector fields.

**Accept:** gallery document exercising every type renders correctly; restriction
syntax works on each; tests for the parser extensions.

## M5 — CAS layer *(superseded by CAS_SPEC.md — from-scratch MIT engine, no Giac)*
`CasEngine` interface: simplify, solve, derivative, integral (def/indef), limit —
each result available exact *and* approximate, UI toggle per result. Giac WASM
(or chosen alternative) behind the interface, loaded in a worker so the UI never
blocks. Inline syntax (`derivative(f(x))`) and per-expression right-click/button
menu route through the same layer. Configurable numeric display precision applied
everywhere.

**Accept:** `solve(x^2 = 2)` shows `±√2` exact and `±1.41421…` approx at the
configured precision; long CAS calls don't freeze the UI; angle mode respected.

## M6 — Graph intelligence & interaction *(done)*
Click-on-curve shows coordinates; automatic detection + labels for roots,
extrema, intersections (systems of equations get intersection points plotted);
draggable points that snap to and slide along a curve with dependent expressions
updating live. Regressions on data tables: linear, polynomial, exponential
(least squares), plotted with parameters shown.

**Accept:** intersections of `y=x^2` and `y=x+1` auto-labeled; dragging a point
along a curve live-updates a dependent expression; regression on a sample table
matches known coefficients in tests.

## M7 — Organization, documents, undo
Command/action layer for *all* document mutations, then: arbitrarily nested
folders (collapse/expand, rename, drag-and-drop of expressions and whole folders,
folder-level show/hide), multiple document tabs each with independent expression
list + folder tree + view state, full undo/redo across expression edits, slider
drags (coalesced), folder ops, deletions.

**Accept:** undo/redo round-trips a scripted sequence of ~20 mixed mutations;
nested folder DnD works; two tabs hold independent state.

## M8 — Persistence, share, export
Versioned `.nous` JSON save/open via native OS dialogs (per-document, includes
folders + sliders + view window). "Copy Share Code": same serializer →
compact JSON → base64 to clipboard; pasting a valid code reconstructs the graph.
Local autosave with crash-recovery offer on next launch. Local-only error log
file (path shown in UI) for attaching to GitHub issues. PNG and SVG export of
the current view.

**Accept:** save → close → open round-trips a complex document byte-equivalently
(modulo timestamps); share code round-trips; kill the process mid-edit →
relaunch offers recovery; exported SVG opens correctly.

Status: M8.1–M8.4 all landed (see docs/dev/M8_checkpoint_prompt.md for the
session spec).
- M8.1 serializer + share codes — `src/state/serialize.ts` (ids reminted on
  load), UI in `src/ui/DocActions.tsx`
- M8.2 platform layer — `src/platform/files.ts`: Tauri-native dialogs with a
  browser fallback (blob download / file input)
- M8.3 autosave + crash recovery (`src/state/autosave.ts`,
  `src/platform/autosave.ts`) + error log (`src/platform/errorlog.ts`)
- M8.4 PNG + SVG export (`src/plot/exportSvg.ts`, buttons on the canvas)

Resolved M8.2 assumption: dialog picks DO extend the fs scope at runtime
(verified in tauri-plugin-dialog source), but `fs:default` alone was NOT
enough — explicit `fs:allow-read/write-text-file` (+ `write-file`, applog
scope) command permissions were required; see
`src-tauri/capabilities/default.json`.

⚠ Outstanding manual desktop tests (native dialogs can't be automated here):
save/open via real OS dialogs, and clean-exit marking on window close (wry
may not fire beforeunload; a Tauri onCloseRequested hook covers it — verify).

## M9 — Input polish
Live autocomplete (function names + templates) as-you-type, search-bar style.
Clickable error fixes rendered inline from the M1 suggestion machinery. Keyboard
shortcuts (new/delete expression, toggle visibility, undo/redo, zoom in/out/
reset) + a shortcuts reference reachable from the UI.

**Accept:** typing `si` offers `sin(`; unmatched-paren error shows a one-click
fix that edits the expression in place; every listed shortcut works.

Status: M9.1–M9.3 all landed (see docs/dev/M9_checkpoint_prompt.md).
- M9.1 autocomplete — engine in `src/core/autocomplete.ts`, dropdown in
  ExpressionRow. Its "user-defined f(x) completes" criterion was deferred to
  M9.5 (the language had no function definitions when M9 landed); M9.5 wires
  user-function names into the vocabulary with paren insert, satisfying it.
- M9.2 clickable fixes — new suggestions for invalid-number, stray
  characters, trailing operators; kinds with no mechanical fix (empty-input,
  wrong-arity, not-a-condition, not-a-value, cas-unsupported) documented in
  `src/core/__tests__/suggestions.test.ts`.
- M9.3 shortcuts — one BINDINGS table (`src/ui/shortcuts.ts`) drives both the
  global handler and the reference panel (⌨ button or `?`).

## M9.5 — User-defined functions
Multi-letter function definitions: `f(x) = x^2` then `f(9)` evaluates to 81;
`myfn(x, y) = …` works for any name not reserved. Parens required at call
sites — paren-less application (`sin 2x`) stays reserved for built-ins, so
implicit multiplication (`xy`, `abx`) never silently captures user names.
Multi-letter names are for FUNCTIONS ONLY in this pass; slider/value names
stay single-letter. Shadowing a reserved name and recursive definitions both
produce structured errors with suggestions where possible.

Design (settled — see docs/dev/M9_5_checkpoint_prompt.md):
- Two-pass naming: a cheap definition-head pre-scan (`word(params) =` at row
  start) harvests candidate names, fed into the real lex/parse as
  `extraNames`. No second expression parser; the AST stays the one source
  of truth.
- Plot hot path: user calls are INLINED at analysis time (substitute args
  into the body AST, expandCas-style) so compile.ts never sees them; cycle
  detection rejects recursion before inlining can hang.
- The evaluator's existing `EvalContext.functions` machinery is the
  reference semantics; the compiled/inlined path must agree with it.
- Satisfies M9.1's deferred acceptance criterion: a defined `f(x) = …` now
  appears in autocomplete (with paren insert) via the defined-names flow.

**Accept:** `f(x) = x^2` row defines; `f(9)` in another row shows 81;
`y = f(x) + f(2x)` plots correctly and stays smooth under a slider drag
(inlining, not per-sample interpretation); `sin(x) = 1` and `f(x) = f(x-1)`
produce structured errors; typing `f` in another row autocompletes `f(`;
`.nous` save/share round-trips documents containing function definitions.

Status: M9.5.1–M9.5.3 all landed.
- M9.5.1 parsing — `src/core/funcdef.ts` head pre-scan; lexer `callableNames`
  (parens-required, no bare capture) + parser `userFunctions`.
- M9.5.2 inlining + cycles — `src/core/inline.ts`; `buildFunctionScope` in
  analyze.ts marks recursive/duplicate names invalid (error at def + call).
- M9.5.3 UX — function names autocomplete with `(`; def rows render KaTeX;
  CAS operates on the inlined body (inline runs before expandCas).
- Judgment call (flagged): a reserved-name head like `sin(x) = 1` is NOT
  treated as a shadow-error definition — it stays an implicit-equation plot,
  so existing plots don't regress. Only non-reserved names with distinct
  single-letter params become function definitions.
- Minor: a plot row `y = f(x)` shows its INLINED body (`y = x²`) in the KaTeX
  preview rather than `f(x)`; revisit in M10 polish if the original notation
  is preferred.

## M10 — Release hygiene
App icon + window/taskbar branding. Verify pastel palette under CVD simulation
and adjust. CONTRIBUTING.md finalized, README build steps re-verified from a
clean clone on at least two OSes, MIT licensing audit (esp. the CAS boundary),
CI running `npm test` on push.

Known UI polish to verify here:
- Sidebar `<select>` (precision dropdown) dropdown arrow renders in
  WebKitGTK's light-theme color inside the real Tauri window, despite
  `color-scheme: dark` being set on `:root` in `src/styles.css` — doesn't
  show up in the Chromium preview, only the actual desktop app. Re-check
  after the color-scheme fix (added 2026-07-03) and either confirm resolved
  or add a custom-rendered dropdown (`appearance: none` + an SVG chevron).
- PNG/SVG export filenames are hardcoded `graph.png`/`graph.svg`
  (GraphCanvas doesn't know the tab name) — name exports after the tab.
- Revisit crash-recovery UX (M8.3): "Recover" currently APPENDS the saved
  tabs next to the fresh "Graph 1". DECIDED (maintainer): it should REPLACE
  the workspace. Implement in M10.2.

Status: M10.1 landed (see docs/dev/M10_checkpoint_prompt.md).
- Palette CVD: the pre-M10 rotation failed hard — blue (#8ab4f8) and purple
  (#c5a9f8) collapsed to ΔE00 0.7 under protanopia. Rather than replace it,
  shipped BOTH as a settings toggle: "Vivid" (default, original candy palette)
  and "Accessible" (CVD-verified via Machado-2009 dichromacy sim + CIEDE2000,
  min pairwise ΔE00 13.1). Global localStorage preference — NOT per-document,
  not in `.nous`; a `:root[data-palette='accessible']` override swaps the
  --curve-N vars live for both canvas and SVG export. Consequence: the shipped
  DEFAULT is not colorblind-safe — the CVD hard constraint is now met by
  opt-in (maintainer's call).
- Branding: Tauri icon pipeline wired (`npm run icon`, `src-tauri/icons/`
  README documents the drop-in); the real 1024² art is still to be supplied by
  the maintainer, so the placeholder icon and current config stay for now.
- Still needs the maintainer's hands: the icon art, and visual confirmation in
  the real Tauri window (icon/branding and the palette — neither reproduces in
  the Chromium preview).

Status: M10.2 landed (the four "Known UI polish" items above).
- Export filenames after the tab: pure `exportBaseName()` (src/ui/exportName.ts,
  node:test-covered) derives a safe name from the active tab; GraphCanvas gets
  it via `getExportName`. Verified live — a "Graph 1" tab exports "Graph 1.svg".
- Crash-recovery REPLACES the workspace: `replaceTabs()`/`replaceDocuments()`;
  `onRecover` swaps the whole tab set (no stray "Graph 1"). Pure-helper tested.
- Inlined-body preview fixed: `analyze` attaches a `displayAst` (pre-user-inline)
  used only by the KaTeX preview; `ast` stays the inlined compute/CAS operand.
  `y = f(x)` now previews as typed, not `y = x²`. Divergence node:test-covered.
- WebKitGTK select arrow: replaced the native arrow with a custom SVG chevron
  (`appearance: none`) on both selects, removing the platform dependency — so
  the real-window re-check is no longer needed for this item.

Remaining for M10: M10.3 (CONTRIBUTING/README clean-clone, licensing audit),
M10.4 (CI + v0.1.0 tag), plus the maintainer-only items noted under M10.1.

**Accept:** clean-clone build works by following README alone; CI green; v0.1.0
tag.
