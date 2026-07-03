// App shell: expression sidebar (left) + graph canvas (right).
// Owns the expression list and the global angle-mode setting. Analysis runs
// in two passes per render: collect definition names (sliders), then
// classify every row against that set. Slider values feed the shared env
// the compiled plot closures read.

import { useCallback, useMemo, useRef, useState } from 'react';
import { engine } from './cas/engine.ts';
import type { Expr, Relation } from './core/ast.ts';
import type { Env } from './core/compile.ts';
import { GcalcError } from './core/errors.ts';
import type { AngleMode } from './core/evaluator.ts';
import { analyze, definitionName, formatValue, type Analysis } from './ui/analyze.ts';
import {
  curveColorVar,
  DEFAULT_SLIDER,
  ExpressionRow,
  type CasAction,
  type ExpressionEntry,
  type SliderMeta,
} from './ui/ExpressionRow.tsx';
import { GraphCanvas, type PlottedCurve } from './ui/GraphCanvas.tsx';
import { galleryEntries, PerfHud, perfEntries, usePerfAnimation } from './ui/perf.tsx';
import { toSource } from './ui/toSource.ts';

let nextId = 1;
let nextColor = 0;

// Only call from event handlers (or module scope) — never inside a state
// updater or initializer: those re-run under StrictMode and would skip
// colors in the rotation.
export function newEntry(source = '', slider?: SliderMeta): ExpressionEntry {
  return { id: nextId++, source, colorIndex: nextColor++, visible: true, slider };
}

const INITIAL_ENTRIES = perfEntries(newEntry) ?? galleryEntries(newEntry) ?? [newEntry()];

const EMPTY_ANALYSIS: Analysis = { kind: 'empty' };

const NO_ACTIONS: readonly CasAction[] = [];
const SCALAR_ACTIONS: readonly CasAction[] = ['derivative', 'integral', 'simplify', 'factor'];
const EQUATION_ACTIONS: readonly CasAction[] = ['solve'];

/** The scalar AST a CAS action operates on, or null. */
function casBody(a: Analysis | undefined): Expr | null {
  if (a === undefined) return null;
  if (a.kind === 'value') return a.ast;
  if (a.kind === 'plot' && a.spec.type === 'explicit') return a.spec.body;
  return null;
}

/** The single-'=' relation a solve action targets, or null. */
function solveTarget(a: Analysis | undefined): Relation | null {
  if (a === undefined || (a.kind !== 'plot' && a.kind !== 'unsupported')) return null;
  let core = a.ast;
  if (core.kind === 'restriction') core = core.body;
  if (core.kind !== 'relation' || core.ops.length !== 1 || core.ops[0] !== '=') return null;
  // y = f(x) rows are function definitions, not equations to solve.
  const isY = (e: Expr): boolean => e.kind === 'ident' && e.name === 'y';
  if (isY(core.operands[0]) || isY(core.operands[1])) return null;
  return core;
}

export function App(): JSX.Element {
  const [entries, setEntries] = useState<ExpressionEntry[]>(INITIAL_ENTRIES);
  const [angleMode, setAngleMode] = useState<AngleMode>('radians');
  const [precision, setPrecision] = useState(6);

  // Pass 1: which names do definition rows define?
  const defined = useMemo(() => {
    const names = new Set<string>();
    for (const entry of entries) {
      const name = definitionName(entry.source);
      if (name !== null) names.add(name);
    }
    return names;
  }, [entries]);

  const definedKey = useMemo(() => [...defined].sort().join(','), [defined]);

  // Pass 2: full analysis, memoized across renders keyed by everything that
  // affects the result — so slider drags re-analyze only the dragged row.
  const cache = useRef(new Map<string, Analysis>());
  const analyses = useMemo(() => {
    const fresh = new Map<string, Analysis>();
    const out = new Map<number, Analysis>();
    for (const entry of entries) {
      const key = `${angleMode}|${definedKey}|${entry.source}`;
      const hit = cache.current.get(key) ?? fresh.get(key) ?? analyze(entry.source, angleMode, defined);
      fresh.set(key, hit);
      out.set(entry.id, hit);
    }
    cache.current = fresh;
    return out;
  }, [entries, angleMode, defined, definedKey]);

  // Shared env: slider values by name. `x` is written by the sample loop.
  const env = useMemo(() => {
    const e: Env = { x: 0 };
    for (const entry of entries) {
      const a = analyses.get(entry.id);
      if (a?.kind === 'definition') e[a.name] = a.value;
    }
    return e;
  }, [entries, analyses]);

  const curves = useMemo(() => {
    const out: PlottedCurve[] = [];
    for (const entry of entries) {
      const a = analyses.get(entry.id);
      if (entry.visible && a?.kind === 'plot') {
        out.push({
          id: entry.id,
          spec: a.spec,
          fingerprint: a.deps.map((n) => env[n]).join(','),
          color: cssColor(entry.colorIndex),
        });
      }
    }
    return out;
  }, [entries, analyses, env]);

  // Row callbacks must be referentially stable or ExpressionRow's memo()
  // can't skip untouched rows — that skip is most of the M3 perf gate. A
  // ref mirror of entries lets the handlers read current state without
  // depending on it.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const onChangeRow = useCallback((id: number, source: string): void => {
    // Editing invalidates any CAS status line on the row.
    setEntries((es) => es.map((e) => (e.id === id ? { ...e, source, note: undefined } : e)));
  }, []);

  const onSliderMeta = useCallback((id: number, slider: SliderMeta): void => {
    setEntries((es) => es.map((e) => (e.id === id ? { ...e, slider } : e)));
  }, []);

  const onToggle = useCallback((id: number): void => {
    setEntries((es) => es.map((e) => (e.id === id ? { ...e, visible: !e.visible } : e)));
  }, []);

  const addEntry = useCallback((): void => {
    const entry = newEntry();
    setEntries((es) => [...es, entry]);
  }, []);

  const onDelete = useCallback((id: number): void => {
    const es = entriesRef.current;
    const replacement = es.length === 1 && es[0].id === id ? newEntry() : null;
    setEntries((cur) => {
      const rest = cur.filter((e) => e.id !== id);
      if (rest.length > 0) return rest;
      return replacement ? [replacement] : cur; // stale mirror → no-op delete
    });
  }, []);

  /** The create-slider suggestion: insert `name = 1` right after the row. */
  const onCreateSlider = useCallback((afterId: number, name: string): void => {
    const slider = newEntry(`${name} = 1`, { ...DEFAULT_SLIDER });
    setEntries((es) => {
      const i = es.findIndex((e) => e.id === afterId);
      const at = i === -1 ? es.length : i + 1;
      return [...es.slice(0, at), slider, ...es.slice(at)];
    });
  }, []);

  const analysesRef = useRef(analyses);
  analysesRef.current = analyses;

  /** CAS menu dispatch — every action routes through the one CasEngine. */
  const onCas = useCallback((id: number, action: CasAction): void => {
    const a = analysesRef.current.get(id);
    const setNote = (note: string): void =>
      setEntries((es) => es.map((e) => (e.id === id ? { ...e, note } : e)));
    const insertAfter = (sources: string[]): void => {
      const rows = sources.map((s) => newEntry(s));
      setEntries((es) => {
        const i = es.findIndex((e) => e.id === id);
        const at = i === -1 ? es.length : i + 1;
        return [...es.slice(0, at), ...rows, ...es.slice(at)];
      });
    };

    try {
      if (action === 'solve') {
        const target = solveTarget(a);
        if (target === null) return;
        const result = engine.solve(target, 'x');
        switch (result.kind) {
          case 'exact': {
            if (result.solutions.length === 0) {
              setNote(result.note ?? 'No real solutions.');
              return;
            }
            insertAfter(result.solutions.map((s) => `x = ${toSource(s)}`));
            const approx = result.solutions
              .map((s) => formatValue(engine.approximate(s), precisionRef.current))
              .join(', ');
            setNote(`exact solutions inserted · x ≈ ${approx}`);
            return;
          }
          case 'numeric':
            insertAfter(
              result.solutions.map((v) => `x = ${formatValue(v, precisionRef.current)}`),
            );
            setNote(`numeric roots (no exact form) · ${result.solutions.length} found`);
            return;
          case 'all-reals':
            setNote('True for every x.');
            return;
          case 'no-solution-found':
            setNote(result.note ?? 'The solver gave up.');
            return;
        }
      }

      const body = casBody(a);
      if (body === null) return;
      let result: Expr | null;
      switch (action) {
        case 'derivative':
          result = engine.differentiate(body, 'x');
          break;
        case 'integral':
          result = engine.integrate(body, 'x');
          break;
        case 'simplify':
          result = engine.simplify(body);
          break;
        case 'factor':
          result = engine.factor(body, 'x');
          break;
        default:
          return;
      }
      if (result === null) {
        setNote('No closed-form antiderivative found — definite integrals still work numerically.');
        return;
      }
      insertAfter([toSource(result)]);
      setNote(
        angleModeRef.current === 'degrees'
          ? 'CAS results use radian semantics.'
          : `${action} inserted below`,
      );
    } catch (err) {
      if (err instanceof GcalcError) {
        setNote(err.info.message);
        return;
      }
      throw err;
    }
  }, []);

  // Refs so onCas stays referentially stable (memo()ed rows).
  const precisionRef = useRef(precision);
  precisionRef.current = precision;
  const angleModeRef = useRef(angleMode);
  angleModeRef.current = angleMode;

  const { hudRef, onFrame, toggle } = usePerfAnimation(setEntries);

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="sidebar-header">
          <h1 className="app-title">gcalc</h1>
          <div className="header-controls">
            <label className="precision-select" title="Numeric display precision (significant digits)">
              <select value={precision} onChange={(e) => setPrecision(Number(e.target.value))}>
                {[3, 4, 5, 6, 8, 10, 12].map((p) => (
                  <option key={p} value={p}>
                    {p} sig
                  </option>
                ))}
              </select>
            </label>
            <div className="angle-toggle" role="group" aria-label="Angle mode">
              <button
                type="button"
                aria-pressed={angleMode === 'radians'}
                onClick={() => setAngleMode('radians')}
              >
                rad
              </button>
              <button
                type="button"
                aria-pressed={angleMode === 'degrees'}
                onClick={() => setAngleMode('degrees')}
              >
                deg
              </button>
            </div>
          </div>
        </header>
        <div className="expr-list">
          {entries.map((entry) => {
            const a = analyses.get(entry.id) ?? EMPTY_ANALYSIS;
            const actions =
              casBody(a) !== null
                ? SCALAR_ACTIONS
                : solveTarget(a) !== null
                  ? EQUATION_ACTIONS
                  : NO_ACTIONS;
            return (
              <ExpressionRow
                key={entry.id}
                entry={entry}
                analysis={a}
                precision={precision}
                casActions={actions}
                onChange={onChangeRow}
                onSliderMeta={onSliderMeta}
                onCreateSlider={onCreateSlider}
                onCas={onCas}
                onToggle={onToggle}
                onDelete={onDelete}
                onEnter={addEntry}
              />
            );
          })}
        </div>
        <button type="button" className="add-button" onClick={addEntry}>
          + add expression
        </button>
      </aside>
      <main className="canvas-area">
        <GraphCanvas curves={curves} env={env} onFrame={onFrame} />
        <PerfHud hudRef={hudRef} toggle={toggle} />
      </main>
    </div>
  );
}

// Resolving var(--curve-N) isn't possible inside canvas; read the computed
// value once per color index instead.
const resolved: string[] = [];
function cssColor(colorIndex: number): string {
  const i = colorIndex % 6;
  if (!resolved[i]) {
    resolved[i] = getComputedStyle(document.documentElement)
      .getPropertyValue(`--curve-${i + 1}`)
      .trim();
  }
  return resolved[i] || curveColorVar(i);
}
