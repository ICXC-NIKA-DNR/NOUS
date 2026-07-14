# Session handoff — 2026-07-11

**One-line status:** `v0.1.0` is **tagged and released on GitHub** (tag +
release both point at HEAD `aa1e68b`; `HEAD == origin/main == v0.1.0`), the
latest CI run on that commit is **GREEN** (run 29140232729, all 4 jobs), and
this session's live thread was *non-code* — marketing media capture + the
LinkedIn launch post + a browser preview left running for a perf screenshot.

> NOTE ON COMMIT HASHES: a git history rewrite happened earlier this session
> (author email `jahernandez.09.27@gmail.com` → `JMHernandez2718@proton.me`
> via `git filter-repo`, force-pushed). **Every commit hash changed.** All
> hashes in this file are the current post-rewrite ones. Any older handoff /
> doc that cites pre-rewrite hashes (e.g. `ee7b834`, `79dcfd0`, `fde2566`)
> now points at nothing — those are stale by design, not errors.

---

## 1. Where I am (live thread at session end)

No code is mid-change. The repo is at a clean tagged release. The last thing
in flight was **personal marketing media**, not project work:

- A **browser preview** was started (Claude Preview MCP, serverId
  `d65a76fb-bc35-4066-bb4f-39a3e1be203c`) and navigated to
  `http://localhost:1420/?perf=50` so the maintainer could screenshot the
  perf-stress HUD at native resolution (the video-extracted frame was grainy).
  The perf harness auto-animates 50 slider-bound expressions. **This server
  may still be running** — stop it when done.
- To enable that preview I created **`.claude/launch.json`** (vite dev config).
  It is the ONLY uncommitted change in the tree (`git status` shows `?? .claude/`).
  It is harness scaffolding, untracked, NOT part of NOUS — safe to delete
  (`rm -rf .claude`) once the preview is finished with.
- All marketing assets live OUTSIDE the repo in `~/nous-media/` (screenshots,
  MP4/GIF field + perf clips) and `~/nous-media/.tooling/` (Playwright capture
  scripts). Nothing there is tracked. A high-res 2× perf screenshot already
  exists at `~/nous-media/showcase/perf-stress.png`.

**Confirmed this session (not hypothesis):**
- Desktop WebKitGTK build tops out ~55 fps idle, and during a 50-expression
  *active* slider sweep the rolling fps sits ~35–44 (dips at the center pinch).
  The **Chromium preview hits a true 60 fps** (idle ceiling 59). In BOTH,
  NOUS's own `draw avg` is ~0.7–1.7 ms/frame — the plot renderer is trivially
  fast; the fps ceiling is compositor/React-bound, not plot-bound.
- The earlier "60 fps with 50 expressions" reading came from a *frozen*-slider
  clip (nothing redrawing). Under genuine simultaneous animation the desktop
  number is ~40. This is a real accuracy nuance for any "60fps" marketing claim.

---

## 2. Decided vs. still open

### Decided + committed this session (current hashes; all pushed, CI green)
- `aa1e68b` — **dragDropEnabled: false** → fixes Windows in-app expression
  drag-and-drop (wry/WebView2 was revoking Chromium's OLE drop target). **= the
  v0.1.0 tag.**
- `f0f88cb` — **core:window:allow-destroy** → X button now closes the app
  (the M8.3 onCloseRequested listener needed the destroy permission).
- `09983ec` — window-level Ctrl+wheel `preventDefault` → stops native WebView
  page-zoom leaking through outside the canvas.
- `f0cb036` — bundle identifier `com.nousproject.app` → `com.nousproject.nous`
  (the `.app` suffix collided with macOS convention; done pre-tag so no user
  data to migrate).
- `b6e7be4` — pinned MPL-2.0 license exceptions to exact crate versions in
  `deny.toml`; `cc144fb` — PLAN.md concrete Sept-16-2026 Node-20 runner
  deadline; `35d6cac` — Linux clean-clone verification record.
- README chain: `7abf76e` (per-OS Building-from-source), `97362b2` (trackpad
  pinch known-limitation), `f7d87c7` (bundling enabled), `9000361` (title
  nous→NOUS, maintainer web edit), `5beb417` (.gitignore env/OS-junk + hook
  rename), `516c3d7` (lockfile 0.1.0 sync).
- **Git history rewrite** — gmail→proton author email across all 68 commits,
  force-pushed; verified 0 remaining occurrences locally and on GitHub.
- **Repo settings (GitHub API, not commits):** made **public**; branch
  protection on `main` (PR required, 0 approvals, 4 required status checks,
  `enforce_admins: false` so direct push still works, no force-push/deletion);
  **secret scanning + push protection ON**; Dependabot alerts + security
  updates ON. Dependabot alert #1 (glib `VariantStrIter` unsoundness) dismissed
  as `tolerable_risk` (GTK3-pinned via Tauri, no reachable fix).
- **v0.1.0 tagged + GitHub release published** (maintainer did this ~05:16 UTC).

### Open — not yet decided
- **LinkedIn post "60 fps" claim.** Drafted and iterated in chat (not saved to
  any file). The post as last drafted implies 60fps under 50 live expressions;
  the desktop build is really ~40 under active load (see §1). Recommended
  reword: lead with "**50 live expressions redrawn in ~1ms/frame**" (the
  bulletproof metric) instead of an fps number, OR caption 60fps as the
  in-browser/preview build. **Maintainer to decide before posting.**
- **Repo link placement in the post** — body (one-click, but LinkedIn
  suppresses reach on outbound body links) vs. first comment (better reach).
  Unresolved; last draft had it in the body.
- **The perf screenshot itself** — maintainer was about to capture it from the
  live preview; may or may not be done.

### Proposed but NOT written anywhere (don't lose these)
- **`Gcalc*` → `Nous*` identifier rename** — `GcalcDocument` (56 uses) and
  `GcalcError` (49 uses) across 26 source files are renamed-project residue.
  Proposed as an early-M11 mechanical chore; NOT in PLAN.md.
- **CLAUDE.md title still reads "# gcalc — project spec"** (line 1). Flagged in
  the earlier scrub, deliberately left (CLAUDE.md is maintainer-gated). One-line
  fix when wanted.
- **Rust-side "reset window zoom" command** (`set_zoom_level(1.0)`) as a
  belt-and-suspenders recovery for the Linux trackpad-pinch limitation — safe
  public API, proposed, not written. M11 nice-to-have at most.
- **Delete the history-rewrite backup** at `~/Claude/nous-git-backup-2026-07-11/`
  — it still contains the OLD gmail email in its objects (that was its job).
  Delete once satisfied the rewrite is stable. Also optional: ask GitHub Support
  to GC the old unreachable commit objects server-side (nobody had the SHAs, so
  practical risk ~nil).
- **Delete `.claude/launch.json`** (this session's untracked preview config)
  once the preview is done.

---

## 3. Exact next action

**If finishing the marketing capture:**
1. Screenshot the live preview at `http://localhost:1420/?perf=50` (server
   `d65a76fb-bc35-4066-bb4f-39a3e1be203c`) — capture when curves fan out wide
   (fps ~60, draw ~0.7ms), not at the center pinch.
2. Stop the preview server (Claude Preview MCP `preview_stop`), then:
   ```sh
   cd ~/Claude/nous && rm -rf .claude   # remove untracked preview config
   git status --short                    # expect clean
   ```

**The real remaining PROJECT work (maintainer-gated, from PLAN.md M10):**
v0.1.0 was tagged with these still open — worth doing before heavy promotion:
```sh
# On a Windows machine — clean-clone build; this also re-tests the two
# WebView2 fixes that CANNOT be verified on Linux:
git clone https://github.com/ICXC-NIKA-DNR/NOUS.git && cd NOUS
npm install && npm run tauri build -- --bundles nsis
#   → then MANUALLY verify in the running app:
#     (a) X button closes it            (commit f0f88cb)
#     (b) drag an expression row into a folder works (commit aa1e68b)
```
Plus the other M10 maintainer-gated items: real-window visual confirms of
icon/branding + palette, and optionally final icon art (one-command regen).

---

## 4. Cross-check vs. PLAN.md / SCRATCH.md (flagged, NOT silently applied)

- **SCRATCH.md does not exist** in this repo — nothing to reconcile there.
- **PLAN.md** — candidates the maintainer may want to merge in (I did not edit
  PLAN.md this session except the already-committed `cc144fb` Node-20 note):
  1. **v0.1.0 is now tagged/released** — PLAN.md's M10 "Tag v0.1.0 once the
     above pass" acceptance can be checked off, BUT note the tag happened while
     the Windows clean-clone build + real-window visual confirms were still
     open. Status wording should reflect "tagged; Windows verification still
     pending" rather than "M10 fully complete."
  2. **Perf reality (rough edge worth recording):** desktop WebKitGTK runs
     ~40 fps under 50-expression active animation (draw ~1ms; ceiling is
     compositor-bound). PLAN.md/CLAUDE.md's "≥50 expressions, smooth" hard
     target is met on *draw cost* but the fps figure deserves an honest note so
     future marketing/docs don't over-claim 60fps for the desktop build.
  3. **`Gcalc*`→`Nous*` rename** and the **CLAUDE.md "gcalc" title** — neither
     is tracked in PLAN.md; log them as M11 cleanup if desired.
  4. The **Windows drag-and-drop re-test** and **dragDropEnabled rationale**
     ARE already in PLAN.md (added when `aa1e68b` landed) — no action needed.

---

## 5. Already done — do NOT redo
- All commits in §2 are pushed; CI green on `aa1e68b`. Don't re-fix the
  drag-drop, close-button, ctrl-wheel, or identifier issues — they're shipped.
- The email history rewrite is complete and verified — do NOT re-run
  filter-repo or force-push.
- Repo is already public with branch protection + secret scanning configured —
  don't re-apply those API calls.
