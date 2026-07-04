# Session Prompt — Full Sweep, Frontend Polish, and Auto-Push Setup

This session covers three separate pieces of work. Do them in this order, and
treat them as distinct tasks with their own verification — don't blend them
together or let one silently affect another.

---

## Part 0 — Verify repo state before touching anything

James believes he may have turned the *entire* project folder into a git repo
(i.e. `git init` was run at the top level, possibly pulling in more than just
the intended project files). Before doing any of Parts 1–3, check this first:

- Run `git status` and `git ls-files` to see exactly what's tracked.
- Confirm the `.git` root is where it should be (the gcalc project root) and
  not accidentally a parent folder that includes unrelated directories.
- Check for anything that shouldn't be tracked: build output, `node_modules`,
  `target/` (Rust build artifacts), OS files (`.DS_Store`, `Thumbs.db`), editor
  config, local env files, credentials/secrets, or anything clearly outside
  the gcalc project itself.
- Check `.gitignore` exists and actually covers the above — if it's missing
  entries or missing entirely, that's likely why things got swept in.
- Critically: verify that everything Claude Code has been actively working
  with this cycle — the M6 checkpoint changes, CLAUDE.md, PLAN.md,
  CAS_SPEC.md, any new source files from recent sessions — is actually present
  and tracked in this repo. Don't assume; list them out and confirm each one
  is there and matches what was actually worked on, not stale or missing.
- Report back a clear summary: what's tracked, what's missing that should be
  there, what's tracked that shouldn't be, and what you'd recommend removing
  from tracking (via `.gitignore` + `git rm --cached`) before this goes
  further. Do NOT delete, untrack, or push anything yet — just report and wait
  for my go-ahead, since untracking/removing things is a change I want to
  confirm first.

Only proceed to Part 1 once this is resolved.

---

## Part 1 — Full pre-publication code sweep

Context: this repo is currently private and heading toward a public GitHub
launch. Before that happens, audit the entire codebase against the standards
in CLAUDE.md (read it first if you haven't already this session). Specifically
check for:

- **Readability over cleverness** — flag or fix any code that's needlessly
  clever, under-commented, or hard to follow.
- **Hidden behavior** — anything that does something non-obvious without
  explanation (implicit coercion, silent fallbacks, side effects buried in
  getters, etc). Surface it and either document it clearly or simplify it.
- **Modularity and single responsibility** — functions/modules doing too much,
  or logic that's duplicated instead of shared.
- **Dependency minimalism** — check package.json / Cargo.toml for anything
  unused, redundant, or added for a single trivial use that could be inlined.
- **Naming** — descriptive names over abbreviations, consistent with the rest
  of the codebase.
- **Documentation of complex algorithms** — anything mathematically or
  algorithmically non-trivial (parser, CAS engine, adaptive sampling,
  discontinuity detection, etc.) should explain *why* it's built the way it
  is, plus time/space complexity where relevant, per CLAUDE.md's standard.
- **License correctness** — re-verify the MIT licensing boundary is clean,
  especially around the CAS layer (per CAS_SPEC.md and the Giac/GPL decision).
  No GPL or incompatible-license code or dependencies anywhere in the tree.
- **Test coverage** — confirm `npm test` is green, and that recent work
  (especially anything from the M6 checkpoint, if that's already been done
  this cycle) has real test coverage, not just manual verification.

Produce a summary of what you found and what you changed, organized by
category above. If something is a judgment call rather than a clear fix
(e.g. "this dependency could be removed but it'd mean rewriting X"), flag it
for me to decide rather than making the call unilaterally — this matches the
AI-collaborator role defined in CLAUDE.md.

Do NOT touch front-end visual design in this part — that's Part 2. This part
is code quality, correctness, and hygiene only.

---

## Part 2 — Frontend changes

I want to make some changes to the front end. Before doing anything, ask me
what specifically I want changed — don't assume. Once I tell you, apply the
changes consistent with the existing design direction (dark charcoal
background, pastel curve-color rotation, Inter/IBM Plex Sans typography) as
established in CLAUDE.md and prior sessions. Keep changes reviewable — don't
restructure unrelated components while making a targeted visual change.

---

## Part 3 — Automate GitHub push logging

Do not set this up until Part 0's tracking issues are resolved and I've
confirmed the `.gitignore`/untracking recommendations. No point auto-pushing
until the tracked file set is actually clean.


Goal: I want my local commits to automatically push to GitHub so my work
history is logged there, without me having to remember to run `git push`
manually every time. This is NOT a request for CI, automated testing on push,
or release automation — just: commit locally, and have it show up on GitHub
without an extra manual step.

Implement this as a **git post-commit hook**:

- Create `.git/hooks/post-commit` that runs `git push origin <current-branch>`
  automatically right after every local commit completes.
- Make the hook executable.
- Make sure it fails gracefully and visibly if the push fails (e.g. no network,
  auth issue, diverged branch) — it should print a clear message to the
  terminal, not fail silently or hang.
- Since `.git/hooks/` isn't tracked by git itself, also add a copy of this
  hook script somewhere in the actual repo (e.g. `scripts/git-hooks/`), plus a
  short note in CONTRIBUTING.md or README explaining that contributors who
  want the same auto-push behavior need to copy it into `.git/hooks/`
  themselves (git hooks aren't shared automatically via clone).
- Confirm this only affects push behavior, not commit behavior — I still
  control when and what gets committed; this just removes the manual push
  step after that point.

Test it: make a trivial commit and confirm the hook fires and the push
succeeds (or fails with a clear, visible message if something's misconfigured
on my end, like remote auth).

---

## Deliverable

At the end of the session, summarize:
1. What the code sweep found and changed, plus anything flagged for my decision.
2. What frontend changes were made (once I've told you what I want).
3. Confirmation the post-commit auto-push hook is installed, working, and
   documented for other contributors.
