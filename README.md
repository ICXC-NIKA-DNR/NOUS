# gcalc

Free, open-source, cross-platform desktop graphing calculator.
Desmos-like interactivity, GeoGebra-level CAS depth. Windows / macOS / Linux.

**Status: early development.** The expression core (parser + evaluator) is
implemented and tested; the UI and plotting engine are being built milestone
by milestone — see `PLAN.md`. `CLAUDE.md` is the working spec.

## Prerequisites

- Node.js ≥ 22.18 (the test suite runs TypeScript directly via Node's type stripping)
- Rust toolchain (stable) — https://rustup.rs
- Platform WebView deps for Tauri v2 (Linux: `webkit2gtk`; see Tauri's docs)

## Build & run

```sh
npm install
npm test               # type-check + core test suite (no Rust needed)
npm run tauri dev      # run the desktop app
npm run tauri build    # release build (bundling is disabled until M10 adds icons)
```

If Tauri CLI versions have drifted from this scaffold, regenerate the config
with `npx tauri init`/`create-tauri-app` rather than hand-patching, then
re-apply the identifier (`org.gcalc.app`) and window settings.

### Linux: choppy rendering / low fps

Some WebKitGTK + GPU driver combinations (seen on Intel iGPUs) deliver
requestAnimationFrame at well below the display refresh rate through the
DMA-BUF renderer. If panning or slider drags feel choppy, launch with:

```sh
WEBKIT_DISABLE_DMABUF_RENDERER=1 npm run tauri dev
```

Canvas rasterization falls back to CPU, which gcalc's renderer is tuned for
(layered canvases, dirty tracking, decimated strokes).

### Performance harness

Open the app with `?perf=50` appended to the dev URL (edit `devUrl` in
`src-tauri/tauri.conf.json` temporarily) to load 5 sliders + 50 bound
expressions with an fps HUD and automated slider sweeps. The M3 acceptance
gate: no sustained drops below ~50 fps while a slider drags.

## Layout

```
src/core/      pure-TS expression engine: lexer → parser → AST → evaluator
               (no DOM, no React — unit-testable in isolation)
src/           React UI (Vite + Tauri WebView)
src-tauri/     Rust backend (Tauri v2)
PLAN.md        milestone plan with acceptance criteria
CLAUDE.md      architecture spec and constraints
```

## Input syntax

Desmos-style plain text: implicit multiplication (`2xy`), `^` powers,
chained inequalities (`0 < x < 5`), domain restrictions (`x^2 {0 < x < 5}`),
points `(a, b)`, lists `[1, 2, 3]`, `|x|`, paren-less trig (`sin 2x`),
subscripted names (`R_oc`, `a_1`), and unicode (`π`, `θ`, `≤`, `·`).
The spec of record is `src/core/__tests__/parser.test.ts`.

## License

MIT — see `LICENSE`. Note: the planned optional CAS integration has an open
licensing decision (Giac is GPL-3.0); see `CLAUDE.md` before bundling any CAS.
