# M9 Input Polish — Checkpoint Prompt

This is a checkpoint session. Treat it as a hard save point: after this work is
done and accepted, we lock M9 in and move forward from here. Take the time to
do this right rather than fast.

## Context

M8 (persistence, share, export) is locked in. M9 is input polish per PLAN.md:
autocomplete, clickable error fixes, and keyboard shortcuts. No M9 code exists
yet, but two adjacent pieces already do — build on them, don't duplicate:

- `src/core/errors.ts` defines `Suggestion` (insert/replace `Edit` or a
  `create-slider` action), and `ExpressionRow` already renders
  `suggestion.edit` as a clickable button and `create-slider` as an action.
  M9.2 extends coverage, it does not introduce the mechanism.
- Ctrl/Cmd+Z / Shift+Z / Y undo/redo shortcuts already exist (App.tsx, M7).
  M9.3 adds the rest around them without forking the key-handling path.
- `src/core/names.ts` has `FUNCTION_NAMES` and `defaultKnownNames()` — the
  autocomplete vocabulary source. One list; never a second hardcoded copy.

Architecture constraints (CLAUDE.md — follow, don't re-decide): the AST/parser
is the single source of truth (no regex expression handling in autocomplete);
`src/core/` stays DOM-free; all document mutations go through dispatch;
KaTeX-style math display conventions stay as they are.

## Part 1 — M9.1: Live autocomplete

- As-you-type dropdown anchored to the expression input, search-bar style:
  matches function names (from `names.ts`) and templates as the user types an
  identifier prefix.
- Include defined names in scope (user functions/sliders from the document)
  alongside built-ins; rank prefix matches first.
- Templates insert with the cursor placed usefully — e.g. accepting `sin`
  yields `sin(` with the caret inside (PLAN.md accept: typing `si` offers
  `sin(`).
- Keyboard-first: ↑/↓ to select, Tab/Enter to accept, Esc to dismiss; typing
  continues to filter. Mouse click also accepts. Never steal Enter from the
  existing "new expression" behavior when the dropdown is closed.
- Desmos is the reference for feel (CLAUDE.md): suggest eagerly, dismiss
  unobtrusively, never block typing.

**Accept (M9.1):** typing `si` offers `sin(`; accepting places the caret
inside the parens; a user-defined `f(x) = …` appears in suggestions for `f`;
Esc dismisses and plain typing is never interrupted. Matching/ranking logic is
pure and covered by node:test; only the dropdown rendering is UI.

## Part 2 — M9.2: Clickable error fixes — full coverage

- Audit every `DiagnosticKind` in `errors.ts`: each kind that *can* carry a
  machine-applicable `Suggestion` should (CLAUDE.md: never a bare error
  string where a fix is possible). Known gaps to close, at minimum:
  unmatched/extra paren insert-fix (PLAN.md's named accept case),
  unknown-function nearest-name, unterminated-abs.
- Fixes apply in place through the existing `applyEdit` + dispatch path —
  one click edits the expression, undo reverts it like any other edit.
- Multi-error sources fix the first diagnostic, re-analyze, and surface the
  next one — clicking through several fixes in sequence must feel coherent.

**Accept (M9.2):** an unmatched-paren error shows a one-click fix that edits
the expression in place and clears the error; every diagnostic kind that can
carry a suggestion does, each with a regression test in core (suggestions are
core data, not UI).

## Part 3 — M9.3: Keyboard shortcuts + reference

- Shortcuts per PLAN.md: new expression, delete expression, toggle
  visibility, undo/redo (exists — keep), zoom in/out/reset. Route zoom
  through the same viewport code the buttons/wheel use.
- One key-handling path: extend the existing global handler in App.tsx (or
  factor it out), don't add per-component listeners that fight it. Shortcuts
  must not fire while typing in an input where they'd conflict (e.g. Delete
  while editing text), and must not break the M9.1 dropdown keys.
- A shortcuts reference reachable from the UI (small panel/dialog listing
  every binding), discoverable without reading docs.

**Accept (M9.3):** every listed shortcut works from the canvas and (where
sensible) the sidebar; none misfire mid-typing; the reference panel opens
from the UI, lists all bindings accurately, and closes with Esc.

## Acceptance gate (do not declare M9 done without these passing)

- `npm test` passes in full.
- Autocomplete matching/ranking, new suggestions, and any new core logic have
  node:test coverage; regression test per new suggestion kind (CLAUDE.md rule).
- PLAN.md's accept line holds end-to-end: `si` offers `sin(`; unmatched-paren
  shows a one-click in-place fix; every listed shortcut works.
- Perf: autocomplete doesn't regress typing latency with ≥50 expressions
  (no per-keystroke re-analysis of the whole document).
- Committed at each sub-milestone boundary (M9.1–M9.3).

## Deliverable

At the end: a summary of (1) autocomplete design choices (vocabulary sources,
ranking, template/caret behavior), (2) the diagnostic-kind audit table — which
kinds gained suggestions, which can't carry one and why, (3) the final
shortcut map and any conflicts you resolved, (4) confirmation the acceptance
gate passed.
