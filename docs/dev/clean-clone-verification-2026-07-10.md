# Clean-clone build verification — 2026-07-10 (Linux)

Verification-only session record. Simulates a brand-new contributor's first
build: fresh `git clone` from GitHub into an empty directory, no reused
`target/` or `node_modules`, following CONTRIBUTING.md → README.md steps
exactly.

- **Commit built:** `57510ef`
- **Host:** Linux (dev machine), Node v22.18.0, stable Rust via rustup.
- **Environment note:** miniconda was stripped from `PATH` for the run — its
  `pkg-config` shadows the system one (known machine quirk, see PLAN.md
  M10.6); a genuinely fresh contributor machine wouldn't have it. No other
  deviation from the documented steps.
- **npm cache caveat:** `node_modules` was built fresh, but npm's global
  content cache (`~/.npm`) was warm, so `npm install` (965ms, 83 packages)
  didn't exercise cold downloads. Registry availability wasn't re-verified;
  package *resolution and build* were.

## Results — PASS

| Step | Result | Time |
|---|---|---|
| `git clone` | ok | ~2s |
| `npm install` | ok, 83 packages, 0 vulnerabilities | ~1s (warm npm cache) |
| `npm test` | 349/349 pass, 0 fail | ~3s |
| `npm run tauri build` | ok, 0 rustc warnings | ~4m17s (2m20s Rust compile) |
| **Total** | | **263s (~4.4 min)** |

Artifacts: `NOUS_0.1.0_amd64.deb` (4.9M), `NOUS_0.1.0_amd64.AppImage` (78M),
binary 13M, `ldd` clean (0 unresolved).

## Warnings observed (not visible in CI — CI has no Rust/bundle job)

1. **Tauri:** bundle identifier `com.nousproject.app` ends in `.app`, which
   conflicts with the macOS application-bundle extension. Harmless on Linux;
   worth deciding before any macOS distribution (changing the identifier
   later invalidates user data paths, so it's a now-or-never-ish call).
2. **Vite:** a chunk exceeds 500 kB after minification (code-splitting
   suggestion). Cosmetic for a desktop WebView app; noted for M11 perf work.

## Stale doc found (not fixed — verification-only session)

README.md "Build & run" says `npm run tauri build` "(bundling is disabled
until M10 adds icons)" — stale since M10.6 enabled deb + AppImage bundling.
One-line fix pending maintainer OK.

## Windows

**Not run — blocked.** This session had no Windows host; only this Linux
machine was available. The PLAN.md M10 maintainer-gated item "README
clean-clone build on a second OS" remains open.
