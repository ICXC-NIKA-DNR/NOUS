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
Versioned `.gcalc` JSON save/open via native OS dialogs (per-document, includes
folders + sliders + view window). "Copy Share Code": same serializer →
compact JSON → base64 to clipboard; pasting a valid code reconstructs the graph.
Local autosave with crash-recovery offer on next launch. Local-only error log
file (path shown in UI) for attaching to GitHub issues. PNG and SVG export of
the current view.

**Accept:** save → close → open round-trips a complex document byte-equivalently
(modulo timestamps); share code round-trips; kill the process mid-edit →
relaunch offers recovery; exported SVG opens correctly.

## M9 — Input polish
Live autocomplete (function names + templates) as-you-type, search-bar style.
Clickable error fixes rendered inline from the M1 suggestion machinery. Keyboard
shortcuts (new/delete expression, toggle visibility, undo/redo, zoom in/out/
reset) + a shortcuts reference reachable from the UI.

**Accept:** typing `si` offers `sin(`; unmatched-paren error shows a one-click
fix that edits the expression in place; every listed shortcut works.

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

**Accept:** clean-clone build works by following README alone; CI green; v0.1.0
tag.
