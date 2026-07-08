# gcalc — syntax & feature reference

Everything the app currently understands, plus how to run it. Status:
M0–M7 complete (scaffold, plotting, sliders, full plot-type coverage, CAS,
graph intelligence, folders/tabs/undo).

## Launch it locally

```sh
cd gcalc
export PATH="$HOME/.local/node-v22.18.0-linux-x64/bin:$HOME/.cargo/bin:$PATH"  # if not in your shell rc yet
npm install          # first time only
npm test             # type-check + full test suite (205 tests, no Rust needed)
npm run tauri dev    # opens the desktop window
```

On this machine specifically, WebKitGTK's DMA-BUF renderer caps frame rate
badly on the Intel iGPU. If panning/dragging feels choppy:

```sh
WEBKIT_DISABLE_DMABUF_RENDERER=1 npm run tauri dev
```

Browser-only preview (no Tauri window, same UI) — useful for quick checks:

```sh
npm run dev           # Vite dev server, defaults to http://localhost:1420
```

Debug modes via query string on the dev URL:
- `?gallery=1` — loads one example of every plot type (the M4 acceptance doc)
- `?perf=50` — loads 5 sliders + 50 bound expressions with an fps HUD (the M3 perf gate)

## Expression syntax

Type any of these into a sidebar row.

### Numbers & operators
```
2 + 3 - 4         + - (binary and unary)
2 * 3, 2·3, 2×3   multiplication (·  ×  are accepted unicode)
6 / 2             division
2^10              power (right-associative: x^y^z = x^(y^z))
5!                factorial
-x^2              = -(x^2)
2xy               implicit multiplication = 2·x·y
2(x+1)(x-1)       implicit multiplication with parens
sin 2x            paren-less function application = sin(2x)
1e-3, 2.5e10      scientific notation
|x|               absolute value (desugars to abs(x))
```

Unicode accepted directly: `π τ θ φ` (names), `· ×` (times), `−` (minus),
`≤ ≥` (relations). Subscripted names work: `a_1`, `R_oc`, `x_2`.

### Constants
```
pi    tau (=2π)    e    phi (golden ratio)
```

### Functions (36 builtins)
```
sin cos tan sec csc cot
asin acos atan  (also: arcsin arccos arctan)
sinh cosh tanh asinh acosh atanh
exp ln log (base 10) log2 sqrt cbrt
abs floor ceil round sign
min(a,b) max(a,b) mod(a,b) gcd(a,b) lcm(a,b)
```
Angle mode (rad/deg toggle in the header) applies to trig in/out globally.

### Relations & domain restrictions
```
0 < x < 5              chained inequality (also works with <= > >=)
x = 3
x^2 {0 < x < 5}         trailing {…} restricts the domain — NaN outside it
x^2 {x > 0, x < 10}     multiple comma-separated conditions (all must hold)
```
Restrictions attach to (and gate) every plot type below.

### Piecewise
```
{x < 0: -x, x}                     if/else — fallback is the last bare term
{x < 0: -1, x > 0: 1, 0}           multiple branches, evaluated in order
{x > 0}                            shorthand for {x > 0: 1}  (1 where true)
```
No matching branch and no fallback → NaN (a gap on the graph).
Note: `{…}` right after a complete expression means *restriction*; `{…}` in
primary position (start of the expression, or after `=`) means *piecewise*.

### Points, lists, vectors
```
(3, 4)                          a point
[1, 2, 3]                       a list
[(1,2), (3,4), (5,6)]           a data table of points
vector((0,0), (3,4))            an arrow from the first point to the second
```

## What you can plot

Each of these, typed as a sidebar row, is auto-detected and plotted:

| Type | Example | Notes |
|---|---|---|
| Explicit | `y = sin(x)` or bare `x^3 - x` | adaptive sampling, handles asymptotes/discontinuities |
| Parametric | `(4cos(3t), 4sin(2t)) {0 < t < 2pi}` | default range `t ∈ [0,1]` if no restriction given |
| Polar | `r = 2 + 2cos(theta)` | default range is one full turn (2π rad or 360°) |
| Implicit | `x^2 + y^2 = 25`, `sin(x) = cos(y)` | marching-squares contour |
| Inequality region | `y > x^2`, `1 < x^2+y^2 <= 4` | shaded; strict `< >` draws a dashed boundary, `<= >=` solid |
| Points / data table | `(6, 4)`, `[(1,2),(3,4)]` | plotted as dots |
| Vector | `vector((0,0), (3,4))` | drawn as an arrow |
| Vector field | `(-y, x)` (any point built from x and y) | grid of magnitude-scaled arrows |

Restrictions (`{…}`) work on every type in the table above.

### Sliders
Type `a = 1` (any plain name, not `x`/`y`/a function name) → becomes a
slider row with a draggable range plus editable min/step/max fields.
Reference the name in any other expression (`y = a·x^2 + b`) and it becomes
a dependency; dragging the slider redraws only the curves that use it.

If you type an undefined variable, the error message offers a one-click
**"Add a slider for …"** button that creates the slider row for you.

## CAS (symbolic math)

Click the **∂** button on any row, or type these inline:

```
derivative(f)              d/dx of f
derivative(f, t)           d/dt of f  (explicit variable)
integral(f)                indefinite integral of f (inserts the antiderivative, or
                            an error if no closed form is known — try a definite
                            integral instead, which always works numerically)
```

Per-row CAS menu:
- **Derivative** — exact, all builtins, product/quotient/chain rules
- **Integral** — pattern-table match; honest "no closed form" if nothing matches
- **Simplify** — like terms, powers, Pythagorean identity, exact constant folding
- **Factor** — common factor, difference of squares, rational-root quadratics
- **Solve for x** (on equation rows like `x^2 = 2`) — exact for linear/quadratic
  (`x^2 = 2` → `x = -sqrt(2)`, `x = sqrt(2)`), numeric root-finding otherwise;
  results are inserted as new editable rows, with an approximate decimal
  value shown in a status note

CAS math always uses radians internally, regardless of the display angle
mode. Numeric display precision (3–12 significant digits) is a dropdown in
the sidebar header and applies to every approximate value shown.

**Scope** (see `CAS_SPEC.md` for the full rationale): no general symbolic
integration (Risch), no symbolic solving past degree 2, no complex numbers,
no matrix CAS — all documented, deliberate v1 cuts, not bugs.

## Graph intelligence (M6)

- **Hover any curve** for a live readout of its coordinates and instantaneous
  slope; **click-and-drag along a curve** to trace it. Releasing pins the
  readout; clicking empty canvas clears it.
- Slope is a fast numeric estimate by default; the **Δ / d/dx** button in the
  graph controls switches to the exact CAS derivative (falls back to numeric).
- Tracing across a break shows an honest label instead of a fake value:
  *removable hole* (with its limit), *jump*, *vertical asymptote* (dashed
  line), or *domain boundary* — and the point jumps cleanly past the gap.
- **Special points are detected symbolically** (the CAS decides, not pixel
  sampling): roots, extrema (min/max), and intersections appear as dots;
  intersections keep a label, others reveal theirs when the cursor is near.
  Exact points display exactly — `y=x` ∩ `y=-x` is `(0, 0)`, never `≈` —
  and identical curves get an "identical graphs" badge instead of dots.
- Points bound to one slider, like `(a, a^2)` with slider `a`, get a **drag
  handle**: drag the point along its path and the slider (plus everything
  depending on it) updates live.
- Data-table rows (`[(1,2), (3,4), …]`) get **Fit: linear / quadratic /
  exponential** in the ∂ menu — least squares, inserted as an editable row
  with r² in a status note.

## Organization: folders, tabs, undo (M7)

- **Folders**: **+ folder** adds one; drag rows by the **⠿** handle to
  reorder, or drop onto a folder's middle to move things inside (folders can
  nest arbitrarily; a folder can't be dropped into itself). The folder's
  eye icon hides everything inside it — sliders stay in effect even when
  hidden. Chevron collapses/expands; the name is edited inline; **×**
  deletes the folder with its contents.
- **Document tabs**: the strip above the sidebar. **+** opens a fresh graph;
  each tab keeps its own expression list, folder tree, undo history, and
  view window — switching back restores exactly where you were. **×** closes
  (the last tab never closes).
- **Undo/redo**: **Ctrl/Cmd+Z** and **Ctrl/Cmd+Shift+Z** (or **Ctrl+Y**),
  plus the ↶ ↷ header buttons. Every content edit is undoable — edits, adds,
  deletes, visibility, folder operations, drag-and-drop moves. A slider drag
  (or a typing burst in one row) counts as **one** undo step. Display
  settings (rad/deg, precision) and folder collapse never enter history.

## Sidebar & graph controls

- Color chip = show/hide toggle; click **×** to delete a row; **+ expression**
  or hit Enter in the last row to add one
- Live KaTeX preview above each row (fractions, cases, √, greek, upright
  function names vs. italic variables)
- rad/deg toggle, precision dropdown, and undo/redo are in the sidebar header
- Graph: drag empty space to pan, scroll/pinch to zoom (cursor-anchored),
  **⌗** toggles the grid, **Δ/d-dx** picks the trace-slope mode, **⌂** resets
  the view
