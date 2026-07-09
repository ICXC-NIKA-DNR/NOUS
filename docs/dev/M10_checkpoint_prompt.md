# M10 Release Hygiene — Checkpoint Prompt

This is a checkpoint session, and the last one. Treat it as a hard save
point: after this work is done and accepted, we tag v0.1.0. Take the time
to do this right rather than fast — this is what a stranger cloning the
repo sees first.

## Context

M9.5 (user-defined functions) is locked. M10 is release hygiene per
PLAN.md: branding, colorblind-safe palette, docs, licensing, CI, and the
UI-polish backlog that accumulated across M8/M9/M9.5. **No M10 code exists
yet.** Work M10.1 → M10.4 in order, committing at each sub-milestone
(`M10.1: <what>` etc.) before starting the next.

Constraints already decided (CLAUDE.md — follow, don't re-decide):

- Dark mode is the only theme; charcoal, not pure black. The pastel curve
  rotation must stay distinguishable under all three CVD types — that's a
  hard constraint, and M10 is where it gets verified.
- MIT license, no telemetry, everything local. The CAS is from-scratch
  MIT (CAS_SPEC.md) — no Giac, no GPL. The licensing audit confirms this,
  it does not reopen it.
- One serializer for save / share / autosave; all document mutations go
  through dispatch. Polish work must not fork either.
- New files only get corrected naming; locked artifacts keep their names.
  Every `src/core/` behavior change lands with a node:test.

Several M10 items cannot be verified in this sandbox — they need the real
desktop window or a second machine. Those are called out per-part and
collected in the acceptance gate; flag each clearly in the deliverable
rather than claiming a pass.

## Part 1 — M10.1: Branding + colorblind-safe palette

- **App icon + taskbar/window branding.** `src-tauri/icons/` currently
  holds a single placeholder `icon.png`. Produce a real multi-resolution
  icon set through the Tauri icon pipeline (`tauri icon`) so every target
  platform has its native format. `productName`/window `title` (`NOUS`)
  and `identifier` (`com.nousproject.app`) are already set — verify, don't
  re-mint.
- **Palette CVD verification.** Re-verify `--curve-1…--curve-6`
  (`src/styles.css:19-24`) under deuteranopia/protanopia/tritanopia
  simulation. Adjust any pair that collides. Any hue you change must be
  updated in every place a curve color lives: the CSS vars, the hex
  fallback in `src/plot/render.ts:110`, and anywhere SVG export emits
  color — one rotation, kept in sync.

**Accept (M10.1):** `npm run tauri build` yields an app whose window,
taskbar/dock, and about-box show the NOUS icon and name (maintainer
confirms visually); icons exist for all target platforms, not a lone PNG.
Each adjacent pair in the curve rotation stays distinguishable under all
three CVD simulations (method documented); any changed hue is consistent
across CSS, render.ts, and PNG/SVG export.

## Part 2 — M10.2: UI polish backlog

Four items that accumulated across M8/M9/M9.5. Each is small; each commits
as part of M10.2.

- **Export filenames after the tab (M8.4 leftover).**
  `src/ui/GraphCanvas.tsx:1061` and `:1117` hardcode `'graph.png'` /
  `'graph.svg'` because GraphCanvas doesn't know the active tab's name.
  Thread the active tab name in, sanitize it to a safe filename, and fall
  back to `graph` when empty. PNG and SVG must derive from the same base.
- **Recovery restores by replacing, not appending (M8.3 leftover —
  DECIDED, final).** `src/App.tsx:650` `onRecover` loops
  `openDocument(...)` per recovered tab, so recovered tabs currently land
  *beside* the fresh "Graph 1". Change it to **replace** the workspace:
  recovery restores the autosaved session as the whole tab set, and the
  untouched fresh "Graph 1" is discarded rather than kept alongside. The
  Discard path is unchanged. This behavior is settled — do not relitigate
  append vs replace.
- **Inlined-body plot preview (M9.5 note).** A `y = f(x)` row shows
  `y = x²` in the KaTeX preview: `src/ui/analyze.ts:426-427` inlines user
  calls before building the plot AST, and `src/ui/ExpressionRow.tsx:105`
  renders that inlined `analysis.ast`. Carry a pre-inline display AST for
  the preview; the compile/eval path keeps using the inlined AST unchanged
  (perf must not regress). Value/function-definition rows already render
  from their own source and shouldn't change.
- **Select dropdown arrow in WebKitGTK.** `src/styles.css:6` already sets
  `color-scheme: dark`. Re-check in the **real Tauri window** whether the
  precision `<select>` arrow (`.precision-select select`, styles.css:400)
  now renders dark. If it still draws light, add `appearance: none` + an
  inline SVG chevron. This reproduces only in the desktop window, never in
  the Chromium preview.

**Accept (M10.2):** exporting from a tab named "Projectile" downloads
`Projectile.png`/`Projectile.svg`, odd/empty names fall back safely, both
formats share the base. Recover after a mid-edit kill yields exactly the
autosaved tab set with no stray empty "Graph 1" (the workspace is
replaced); Discard still clears autosave and leaves the fresh session.
With `f(x)=x^2` defined, a `y = f(x)` row's preview reads `y = f(x)`, not
`y = x²`, while the plot and slider-drag perf are unchanged — asserted by
an analyze test on display-AST vs compile-AST. The precision dropdown
arrow is dark in the actual desktop window (maintainer screenshot) or a
custom chevron is in place; the preview is unaffected.

## Part 3 — M10.3: Docs, licensing, clean-clone verification

- **CONTRIBUTING.md** finalized (build/test/PR flow, the node:test
  convention, commit-message format).
- **README from a clean clone on ≥2 OSes.** A stranger following only the
  README, from a fresh `git clone`, must reach a running app. Fix the step
  or the doc in the same commit if anything drifts (CLAUDE.md rule). This
  is inherently a maintainer task — the sandbox is one machine.
- **MIT licensing audit.** Confirm `LICENSE` is MIT; scan dependency
  licenses for anything MIT-incompatible; and — the important one —
  confirm the CAS boundary: the from-scratch TS CAS (CAS_SPEC.md) contains
  no Giac and no GPL/other-licensed code. Record the audit result.

**Accept (M10.3):** a fresh clone + README steps alone build and run on two
OSes (maintainer-run, noted in the deliverable); dependency-license scan
shows nothing incompatible with MIT; CAS confirmed Giac-free;
CONTRIBUTING.md reflects the real workflow.

## Part 4 — M10.4: CI + release tag

- **CI runs `npm test` on push/PR** (GitHub Actions), green required on
  main. Node ≥22.18 so the node:test `.ts` runner works.
- **Tag v0.1.0** once the whole gate below passes.

**Accept (M10.4):** the CI workflow runs `npm test` on push and is green on
main; `v0.1.0` is tagged after every item above lands.

## Acceptance gate (do not tag v0.1.0 without these passing)

- `npm test` passes in full; any polish touching `src/core`/`src/ui/analyze`
  has node:test coverage (export-name derivation and the display-AST split
  at minimum).
- Palette CVD check documented; any hue change reflected in CSS, render.ts,
  and export.
- CI green on push to main.
- Clean-clone build works following the README alone on ≥2 OSes.
- **Outstanding manual desktop tests finally confirmed before tagging**
  (maintainer, sandbox can't do these):
  - M8 leftovers (PLAN.md:111-114): save/open via real OS dialogs;
    clean-exit marking on window close (`onCloseRequested`).
  - Select-arrow appearance and app-icon/taskbar branding in the real
    window.
- Committed at each sub-milestone boundary (M10.1–M10.4).

## Deliverable

At the end: a summary of (1) the icon pipeline used and what the maintainer
must still eyeball; (2) the CVD verification method and any palette changes,
with the sync points touched; (3) each polish item's resolution — including
the export-name sanitization rule and the recovery replace behavior;
(4) the licensing-audit result (CAS boundary + dependency scan); (5) the CI
setup, confirmation it's green, and the tag; (6) the manual-test checklist
that gated the release and its results.
