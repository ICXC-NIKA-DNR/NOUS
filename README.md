# nous

Free, open-source, cross-platform desktop graphing calculator.
Desmos-like interactivity, GeoGebra-level CAS depth. Windows / macOS / Linux.

**Status: early development.** The expression core (parser + evaluator) is
implemented and tested; the UI and plotting engine are being built milestone
by milestone — see `PLAN.md`. `CLAUDE.md` is the working spec.

## Prerequisites

- Node.js ≥ 22.18 (the test suite runs TypeScript directly via Node's type stripping)
- Rust toolchain (stable) — https://rustup.rs
- Platform WebView deps for Tauri v2. On Debian/Ubuntu/Mint:

  ```sh
  sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
  ```

  Other distros: see Tauri's prerequisites page
  (https://v2.tauri.app/start/prerequisites/). Windows and macOS need no
  extra system packages beyond Rust + Node.

## Build & run

```sh
npm install
npm test               # type-check + core test suite (no Rust needed)
npm run tauri dev      # run the desktop app
npm run tauri build    # release build (bundling is disabled until M10 adds icons)
```

If Tauri CLI versions have drifted from this scaffold, regenerate the config
with `npx tauri init`/`create-tauri-app` rather than hand-patching, then
re-apply the identifier (`com.nousproject.nous`) and window settings.

### Linux: choppy rendering / low fps

Some WebKitGTK + GPU driver combinations (seen on Intel iGPUs) deliver
requestAnimationFrame at well below the display refresh rate through the
DMA-BUF renderer. If panning or slider drags feel choppy, launch with:

```sh
WEBKIT_DISABLE_DMABUF_RENDERER=1 npm run tauri dev
```

Canvas rasterization falls back to CPU, which NOUS's renderer is tuned for
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

## CAS

The symbolic layer is built from scratch in TypeScript (MIT, zero external
CAS dependencies — see `CAS_SPEC.md` for the scoping rationale):

- **Differentiation** — full and exact: every builtin function, product/
  quotient/chain rules, `f(x)^g(x)` via logarithmic differentiation.
- **Simplification** — exact rational constant folding (bigint), like-term
  and power collection, Pythagorean identity, radical reduction (`√8 → 2√2`).
- **Solving** — linear and quadratic exactly (`x² = 2` → `±√2`), symbolic
  slider coefficients in the linear case, Newton + bisection numerics for
  everything else; results say which tier they came from.
- **Integration** — pattern-table indefinite (power rule, trig, exp/log,
  linear inner functions, u-substitution, fixed by-parts forms); definite
  integrals always work via adaptive Simpson when no closed form is known.
- **Limits** — direct substitution, L'Hôpital for 0/0 and ∞/∞ (recursion-
  capped), one-sided, signed infinities.

Use it from the `∂` menu on any expression row, or inline: `derivative(f)`,
`integral(f)`. Every symbolic operation is property-tested against numeric
cross-checks (central differences, quadrature, evaluate-after-simplify).

CAS results use radian semantics regardless of the display angle mode.

## Known limitations

Deliberate scope decisions (see `CAS_SPEC.md`), not accidents:

- **No general symbolic integration** (no Risch algorithm). The pattern
  table covers what graphing-calculator users actually integrate; when
  nothing matches, `integral(...)` says so honestly, and definite integrals
  fall back to numerics — `∫₀¹ e^(x²) dx` still answers.
- **No symbolic solving beyond quadratics** — higher-degree polynomials and
  transcendental equations solve numerically (all real roots in the search
  range), which covers the target use.
- **No complex numbers in v1** — `x² + 1 = 0` reports two complex roots
  exist and that they aren't displayed, rather than pretending there's no
  answer.
- **No matrix CAS, differential equations, or series expansions** — v2
  candidates if the project grows.

## Input syntax

Desmos-style plain text: implicit multiplication (`2xy`), `^` powers,
chained inequalities (`0 < x < 5`), domain restrictions (`x^2 {0 < x < 5}`),
points `(a, b)`, lists `[1, 2, 3]`, `|x|`, paren-less trig (`sin 2x`),
subscripted names (`R_oc`, `a_1`), and unicode (`π`, `θ`, `≤`, `·`).
The spec of record is `src/core/__tests__/parser.test.ts`.

## License

MIT — see `LICENSE`. The CAS is built from scratch in this repo (no Giac,
no GPL code); the licensing question that shaped that decision is documented
in `CAS_SPEC.md`.
