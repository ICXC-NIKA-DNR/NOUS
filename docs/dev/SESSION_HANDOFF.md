# Session handoff — 2026-07-09

**One-line status:** CI is RED on `main`; the `cargo-deny` job (added this
session, M10.5) flags real advisories. This is the *only* thing blocking the
`v0.1.0` tag — "CI green" is one of the three M10 acceptance criteria.
Everything else in M10.1–M10.6 is committed, pushed, and otherwise green.

HEAD when this was written: `f3c485c` (`docs: record M10.5 + M10.6 status`).
Latest CI run on HEAD: `29047904160` — **failure** (the `cargo deny` job; the
`npm test` 3-OS matrix is green).

---

## 1. Where I am — the CI-red investigation

The `cargo deny (licenses + advisories)` job in `.github/workflows/ci.yml`
(config `src-tauri/deny.toml`) now runs and reports two classes of finding,
both treated as errors by our config:

**A. 2 real vulnerabilities — both in `quick-xml` v0.39.4**
- `RUSTSEC-2026-0194` — quadratic runtime when checking a start tag for
  duplicate attribute names.
- `RUSTSEC-2026-0195` — unbounded namespace-declaration allocation in
  `NsReader` → memory-exhaustion DoS.
- Dependency path (BUILD-dependency only, not in the shipped runtime binary):
  `nous [build-dependencies] → tauri-build → tauri-utils → plist v1.9.0 →
  quick-xml v0.39.4`. `plist` is used at build time (Info.plist / icon
  generation), so real-world reachability is low.

**B. ~16 "unmaintained" advisories — the gtk-rs GTK3 bindings family**
- Transitive via Tauri v2's Linux webview (still on gtk3-rs). **No upstream
  fix exists** — Tauri v2 has not moved off GTK3 on Linux.
- Full ID list from the failing run: RUSTSEC-2024-0370, -0411, -0412, -0413,
  -0414, -0415, -0416, -0417, -0418, -0419, -0420, RUSTSEC-2025-0075, -0080,
  -0081, -0098, -0100, plus the two 2026 vulns above.

---

## 2. Decided vs. still open

**Decided + committed this session:**
- Add `cargo-deny` to CI; `deny.toml` uses a permissive-only license allowlist
  (MPL/GPL/LGPL deliberately excluded so any future copyleft crate trips it).

**Open — not yet decided:**
- **quick-xml: ignore vs. fix.** I was mid-check on whether a newer
  `tauri-build` / `plist` release pulls a *patched* quick-xml, which would let
  us fix rather than ignore. Not yet determined. If a patched version is not
  reachable through `plist`'s semver range, the fallback is to `ignore` both
  IDs in `deny.toml`, documented as build-only.
- **Unmaintained gtk-rs advisories: must be ignored.** No fix exists; just
  needs the `ignore` list written with a justification comment.

**Pending (proposed in the pre-clear audit, NOT yet written):**
- CLAUDE.md hard-constraint #2 update — it still reads as if the *default*
  palette must be CVD-safe, but we shipped Vivid (not CVD-safe) as default and
  Accessible as opt-in. A doc edit, not started.

---

## 3. Exact next action

1. **Determine if the quick-xml vulns are fixable (vs. ignore):**
   ```sh
   cd src-tauri
   cargo tree -i quick-xml            # confirms plist 1.9.0 → quick-xml 0.39.4
   cargo deny check advisories        # full local output lists each advisory's
                                      # patched version (needs: cargo install cargo-deny)
   cargo update -p quick-xml --dry-run # does plist's range allow a patched ver?
   ```
   If a newer `plist`/`tauri-build` release resolves it, bump and commit
   `src-tauri/Cargo.lock`. If not reachable, go to step 2.

2. **If not fixable, ignore with justification** in `src-tauri/deny.toml`:
   ```toml
   [advisories]
   yanked = "deny"
   ignore = [
     # quick-xml — build-dependency only (tauri-build → plist), not in the
     # shipped runtime binary; no reachable patched version through plist.
     "RUSTSEC-2026-0194", "RUSTSEC-2026-0195",
     # gtk-rs GTK3 bindings — unmaintained, transitive via Tauri v2's Linux
     # webview; no upstream fix (Tauri v2 still on GTK3).
     "RUSTSEC-2024-0370", "RUSTSEC-2024-0411", "RUSTSEC-2024-0412",
     "RUSTSEC-2024-0413", "RUSTSEC-2024-0414", "RUSTSEC-2024-0415",
     "RUSTSEC-2024-0416", "RUSTSEC-2024-0417", "RUSTSEC-2024-0418",
     "RUSTSEC-2024-0419", "RUSTSEC-2024-0420", "RUSTSEC-2025-0075",
     "RUSTSEC-2025-0080", "RUSTSEC-2025-0081", "RUSTSEC-2025-0098",
     "RUSTSEC-2025-0100",
   ]
   ```
   (Verify each ID against the current failing run before committing — the set
   can drift as new advisories publish. Get it fresh with:
   `gh run view <latest-run-id> --log-failed | grep -oE 'RUSTSEC-[0-9]{4}-[0-9]{4}' | sort -u`.)

3. **Push and confirm the `cargo deny` job goes green** (npm-test matrix
   already green) → restores the "CI green" acceptance for the tag.

4. **Separately (pending audit item):** edit CLAUDE.md constraint #2 to
   describe the two-palette design (Vivid default / Accessible opt-in).

---

## 4. Already done this session — do NOT redo

All committed + pushed to `main` (auto-push hook = every commit is published):

- **M10.1** — palette Vivid/Accessible toggle (global localStorage pref, live
  swap), app-icon pipeline, `.header-controls` flex-wrap de-crowd.
- **M10.2** — export filenames from tab name (`exportBaseName`), recovery
  REPLACES the workspace, inlined-body preview fix (`displayAst`), custom SVG
  select chevron.
- **M10.3** — CONTRIBUTING/README finalize, `docs/dev/licensing-audit.md`
  (npm tree clean, CAS Giac-free).
- **M10.4** — CI workflow (`npm test`, Node 22, ubuntu/macos/windows) — GREEN.
- **M10.5** — audit fixes: deserialization hardening (F1/F6/F8 —
  `MAX_FOLDER_DEPTH=64`, colorIndex + viewport bounds, `onImport` catch-all,
  hostile-input tests), dialog perm narrowed to open+save (F7), versions →
  `0.1.0` + manifest metadata (F2/F3), README apt system-deps (F4),
  `THIRD_PARTY_LICENSES.md` with full OFL-1.1 text, `src-tauri/deny.toml` +
  cargo-deny CI job (F5).
- **M10.6** — Linux packaging: `src-tauri/app-icon.svg` (NOUS mark) + generated
  icon set, `bundle.active: true` targets `deb` + `appimage`. **Built and
  launch-verified on this machine** (`NOUS_0.1.0_amd64.deb` + `.AppImage`; ldd
  clean; window opens). Touch groundwork: pointerType-gated 2× pick/grab radii
  + wider tap jitter, POI labels reveal near a pinned trace (tap works without
  hover).
- **PLAN.md** — status notes for all of the above; M11 (menu consolidation +
  user-visible perf HUD) and iOS/Android-postponed both logged.

**NOT committed — will be lost on `/clear` unless acted on:**
- The **hostile-input fuzzer** (`hostile.mjs`) and the **CVD palette analysis**
  scripts (`cvd.mjs`, `optimize.mjs`) live ONLY in the session scratchpad
  (`/tmp/…/scratchpad/`), not in the repo. The fuzzer is what found F1 —
  consider committing it under `scripts/` or `docs/dev/` as a regression aid.
- The **CLAUDE.md constraint #2 edit** — proposed in the audit, not written.
- **This handoff file** — written; commit it if you want it in git history
  (it survives `/clear` as a working-tree file either way).

Correction to the request that prompted this file: nothing was written as a
result of the pre-clear *audit* — the fuzzer script and the CLAUDE.md edit were
only proposed there. The PLAN.md entries were committed earlier in the session,
before the audit.
