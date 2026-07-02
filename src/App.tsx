// App shell: expression sidebar (left) + graph canvas (right).
// Owns the expression list and the global angle-mode setting. Analysis runs
// in two passes per render: collect definition names (sliders), then
// classify every row against that set. Slider values feed the shared env
// the compiled plot closures read.

import { useCallback, useMemo, useRef, useState } from 'react';
import type { Env } from './core/compile.ts';
import type { AngleMode } from './core/evaluator.ts';
import { analyze, definitionName, type Analysis } from './ui/analyze.ts';
import {
  curveColorVar,
  DEFAULT_SLIDER,
  ExpressionRow,
  type ExpressionEntry,
  type SliderMeta,
} from './ui/ExpressionRow.tsx';
import { GraphCanvas, type PlottedCurve } from './ui/GraphCanvas.tsx';
import { galleryEntries, PerfHud, perfEntries, usePerfAnimation } from './ui/perf.tsx';

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

export function App(): JSX.Element {
  const [entries, setEntries] = useState<ExpressionEntry[]>(INITIAL_ENTRIES);
  const [angleMode, setAngleMode] = useState<AngleMode>('radians');

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
    setEntries((es) => es.map((e) => (e.id === id ? { ...e, source } : e)));
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

  const { hudRef, onFrame, toggle } = usePerfAnimation(setEntries);

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="sidebar-header">
          <h1 className="app-title">gcalc</h1>
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
        </header>
        <div className="expr-list">
          {entries.map((entry) => (
            <ExpressionRow
              key={entry.id}
              entry={entry}
              analysis={analyses.get(entry.id) ?? EMPTY_ANALYSIS}
              onChange={onChangeRow}
              onSliderMeta={onSliderMeta}
              onCreateSlider={onCreateSlider}
              onToggle={onToggle}
              onDelete={onDelete}
              onEnter={addEntry}
            />
          ))}
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
