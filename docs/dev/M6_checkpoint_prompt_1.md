# M6 Fix, Interaction Overhaul, and Full Frontend Sweep — Checkpoint Prompt

This is a checkpoint session. Treat it as a hard save point: after this work is
done and accepted, we lock M6 in and move forward from here. Take the time to
do this right rather than fast.

## Context

M6 (Graph intelligence & interaction) is functionally in place per PLAN.md but
came out clunky — some things behave weirdly. Before moving to M7, this session
has two goals:

1. Fix whatever is actually broken/weird in the existing M6 implementation.
2. Replace/extend the point-interaction model with a proper Desmos-style
   click-and-drag trace, including live instantaneous rate of change.

Then do a full frontend sweep: responsive layout, and fix the known zoom/drag
issues on the canvas. Root-cause fixes are in scope even if the root cause
lives in M2–M5 code (e.g. shared canvas/rendering/coordinate-transform logic) —
don't patch around a bug in the plotting engine if the actual defect is
upstream of M6.

## Part 1 — Audit and fix existing M6 behavior

Before writing anything new, review the current M6 implementation end to end:
click-on-curve coordinates, root/extrema/intersection detection and labeling,
draggable curve-following points, and the regression feature. Identify and fix
whatever is producing the "clunky"/"weird" behavior — this may include
coordinate transform bugs, stale state on pan/zoom, mislabeled or duplicate
detected points, incorrect intersection solving, or event-handling races. Note
what was wrong and what you changed as you go; I want a summary at the end, not
just a diff.

## Part 2 — Desmos-style click-and-drag point trace

Replace/extend the point interaction with this behavior:

- **Trigger:** click and hold anywhere on a plotted curve, then drag. As the
  cursor moves, continuously update to show the point on the curve at the
  cursor's current x (or nearest parameter value for non-explicit plot types).
- **Continuity:** while the curve is continuous, this should feel seamless —
  no visible stepping or lag, the point and tooltip track the cursor smoothly.
- **Info shown:** a small tooltip/popup anchored right next to the traced
  point, showing its coordinates and the instantaneous rate of change (slope)
  at that point.
- **Slope computation is mode-based:**
  - Default: numeric finite-difference approximation, computed fast enough for
    smooth real-time dragging. This is display-only and does not need to route
    through the CAS layer.
  - Optional switch: exact symbolic derivative via the M5 CAS engine, when the
    CAS can produce one for the given expression. Fall back to numeric if the
    CAS can't handle it.
  - This numeric-by-default / CAS-as-toggle split is display-layer only. Leave
    the CAS engine's role for the expression list / left panel exactly as it
    is — this is not a request to change what the CAS is used for elsewhere.
- **Discontinuities, holes, domain boundaries, asymptotes:** detect these
  during the trace and handle them explicitly rather than letting the tooltip
  show garbage or silently freeze:
  - At a removable discontinuity or hole: show a distinct "discontinuity/hole"
    label, including the limit value if one exists (e.g. a removable
    discontinuity with a well-defined limit).
  - At a vertical asymptote or domain boundary: show an appropriate distinct
    label (not a numeric value that implies the function is defined there).
  - When the cursor moves past a gap into the next continuous section of the
    same curve (e.g. past a vertical asymptote, or the curve leaves and
    re-enters the visible viewport), the trace point should jump straight to
    the next valid section — a clean "teleport" rather than interpolating
    through the gap or disappearing. Use your judgment on exactly how this
    feels, but it should read as intentional and smooth, the way Desmos
    handles it, not like a bug.
- **On release:** pin the point and its tooltip on the canvas as a persistent
  marker. It should stay visible until the user clicks elsewhere on empty
  canvas space, at which point it clears. Multiple pins are not required
  unless it falls out naturally — a single pinned point that replaces the
  previous one on the next click-drag is fine.
- This interaction should compose with the existing M6 features (auto-labeled
  roots/extrema/intersections, draggable curve-snapped points) rather than
  replace them — those stay as-is unless your audit in Part 1 found real bugs
  in them.

## Part 3 — Full frontend sweep

- Make the layout properly responsive to window size (sidebar, canvas, any
  panels/tooltips) — no fixed-pixel assumptions that break on resize.
- Fix the known zoom and drag issues on the graph canvas. Diagnose root cause
  first; if it's in shared M2/M3 pan-zoom or coordinate-transform code, fix it
  there rather than papering over it in M6-specific code.
- General pass for visual polish and pleasant-to-use feel, consistent with the
  dark charcoal / pastel-curve-palette / Inter-or-IBM-Plex-Sans direction
  already set in CLAUDE.md. Don't introduce new design language — refine what
  exists.

## Acceptance gate (do not declare this done without these passing)

- `npm test` passes in full.
- New/changed behavior has test coverage where it's feasible to test
  (coordinate math, discontinuity detection, slope calculation) — UI
  interaction itself can be manually verified, but the underlying math should
  be tested.
- Numeric cross-check pattern from CAS_SPEC.md / M5 is applied to the new
  slope calculations: verify the numeric finite-difference slope agrees with
  the CAS symbolic derivative (where the CAS can produce one) within
  reasonable tolerance, for a handful of representative functions including at
  least one with a removable discontinuity and one with a vertical asymptote.
- Manual pass: resize the window through several sizes and confirm layout
  holds up; pan/zoom on the canvas feels correct at multiple zoom levels; drag
  a trace across a discontinuity and an asymptote and confirm the
  teleport/labeling behavior described above.

## Deliverable

At the end: a summary of (1) what was actually wrong in the old M6 and what
you fixed, (2) how the new trace/slope interaction works and any judgment
calls you made on the "teleport" feel, (3) what if anything you touched outside
M6 and why, (4) confirmation that the acceptance gate above passed.
