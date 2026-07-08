# M8 Persistence, Share, and Export — Checkpoint Prompt

This is a checkpoint session. Treat it as a hard save point: after this work is
done and accepted, we lock M8 in and move forward from here. Take the time to
do this right rather than fast.

## Context

M7 (documents, folders, undo/redo) is locked in. M8 adds persistence, sharing,
and export per PLAN.md. **No M8 code exists yet** — this session starts at
M8.1 and works through M8.4 in order, committing at each sub-milestone
(`M8.1: <what>` etc.) before starting the next.

Architecture constraints already decided (CLAUDE.md — follow, don't re-decide):

- `.nous` files are versioned JSON: `{ "format": "nous", "version": 1, ... }`.
- Share codes are the **same serializer**: compact JSON → base64. One
  serializer, two transports — never two serialization paths.
- `src/core/` stays pure TypeScript — no Tauri or DOM APIs. Platform-specific
  file I/O lives behind a platform layer, not in core.
- All document mutations continue to route through the M7 command/action layer.

## Part 1 — M8.1: Serializer + share codes

- Serialize a full document: expressions, folders (structure + collapse/rename
  state), sliders (value + range + step), and view window. Per-document — a
  `.nous` file is one document, not the whole tab set.
- **Ids are session-local counters and are NOT serialized.** Remint ids on
  load so opened documents can't collide with live tabs. (Same StrictMode
  caution as always: mint in handlers/module scope, never in state
  initializers.)
- Deserializer validates `format`/`version` and rejects malformed input with a
  structured error, not a crash — pasted share codes are untrusted input.
- "Copy Share Code" → base64 of compact JSON to clipboard; pasting a valid
  code reconstructs the graph in a new document.

**Accept (M8.1):** serialize → deserialize round-trips a complex document
(nested folders, sliders, restricted domains, view window) equivalently modulo
timestamps and reminted ids; share code round-trips the same document;
malformed/truncated codes produce a user-facing error with no state damage.
All of this is core logic — covered by node:test, no UI needed.

## Part 2 — M8.2: Platform layer (dialogs + fallback)

- Save/Open via Tauri-native OS dialogs, behind an interface with a **browser
  fallback** (blob download for save, file input for open) so the Vite preview
  stays fully verifiable without the desktop shell.
- ⚠ **Unverified assumption to check first:** that dialog-selected paths
  automatically extend the fs plugin's scope in Tauri v2 (`dialog:default` +
  `fs:default` sufficing for user-chosen paths). Verify when wiring; if it
  doesn't hold, fix capabilities before building on top.
- Native dialogs can't be automated in this environment — desktop save/open
  needs a manual test from the maintainer. Flag this explicitly at the end.

**Accept (M8.2):** save → close → open round-trips byte-equivalently (modulo
timestamps) through the browser-fallback path, verified in the preview; the
Tauri path compiles and is wired identically through the same interface, with
the manual-test ask called out in the deliverable.

## Part 3 — M8.3: Autosave + crash recovery

- Local autosave of open documents (debounced/periodic — pick a cadence that
  can't hurt the ≥50-expression redraw perf target).
- On next launch after an unclean exit, offer recovery; accepting restores the
  autosaved documents, declining discards them. A clean exit leaves no
  recovery prompt.
- Local-only error log file, path shown in the UI, for attaching to GitHub
  issues. No telemetry — the log never leaves the machine.

**Accept (M8.3):** kill the process mid-edit → relaunch offers recovery and
restores state; clean exit → no offer; the error log file exists at the path
the UI shows and captures a deliberately triggered error.

## Part 4 — M8.4: PNG + SVG export

- Export the current view (visible curves, points, labels, axes/grid as
  rendered) to PNG and to SVG.
- SVG must be real vector output that opens correctly in external tools, not
  an embedded raster.

**Accept (M8.4):** exported PNG matches the on-screen view; exported SVG opens
correctly in an external viewer/editor with curves as vector paths.

## Acceptance gate (do not declare M8 done without these passing)

- `npm test` passes in full.
- Serializer/deserializer, id reminting, and share-code round-trip have
  node:test coverage, including malformed-input rejection cases.
- Whole-milestone round-trip from PLAN.md holds: save → close → open a complex
  document byte-equivalently (modulo timestamps); share code round-trips;
  kill mid-edit → relaunch offers recovery; exported SVG opens correctly.
- One serializer confirmed: file save, share code, and autosave all go through
  the same code path.
- Committed at each sub-milestone boundary (M8.1–M8.4), not just at the end.

## Deliverable

At the end: a summary of (1) the `.nous` v1 schema and any serialization
judgment calls, (2) whether the Tauri v2 dialog/fs-scope assumption held and
what capabilities were actually needed, (3) autosave cadence/storage choices
and how crash detection works, (4) what still requires a manual desktop test
from the maintainer, (5) confirmation the acceptance gate passed.
