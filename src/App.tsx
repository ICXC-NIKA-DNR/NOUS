// App shell: expression sidebar (left) + graph canvas (right).
//
// All state lives in one GcalcDocument (state/document.ts); every mutation
// goes through `dispatch(command)` — the single choke point undo/redo (M7.2)
// hooks into. Analysis runs in two passes per render over the document's
// expressions (flattened from the folder tree): collect definition names
// (sliders), then classify every row against that set. Slider values feed the
// shared env the compiled plot closures read.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { engine } from './cas/engine.ts';
import type { Expr, Relation } from './core/ast.ts';
import { compile, type Env } from './core/compile.ts';
import { GcalcError } from './core/errors.ts';
import { expFit, linearFit, polyFit } from './plot/regress.ts';
import {
  emptyDocument,
  flattenExpressions,
  locate,
  makeExpression,
  makeFolder,
  type GcalcDocument,
  type Item,
} from './state/document.ts';
import { useDocumentHistory } from './state/history.ts';
import { analyze, definitionName, formatValue, type Analysis } from './ui/analyze.ts';
import {
  curveColorVar,
  DEFAULT_SLIDER,
  ExpressionRow,
  type CasAction,
  type SliderMeta,
} from './ui/ExpressionRow.tsx';
import { FolderRow } from './ui/FolderRow.tsx';
import { GraphCanvas, type DragPoint, type PlottedCurve } from './ui/GraphCanvas.tsx';
import { galleryItems, PerfHud, perfItems, usePerfAnimation } from './ui/perf.tsx';
import { toSource } from './ui/toSource.ts';

// Symbolic derivative of an explicit curve body, compiled for POI detection.
// Cached by body AST identity (analyses are cached by source, so the AST is
// stable across renders). Radian semantics only — in degree mode the POI
// engine's central-difference fallback stays correct without the π/180 factor
// the symbolic form would need. null = not differentiable (e.g. floor).
const derivCache = new WeakMap<Expr, ((x: number, env: Env) => number) | null>();

function derivativeOf(body: Expr): ((x: number, env: Env) => number) | undefined {
  if (!derivCache.has(body)) {
    let fn: ((x: number, env: Env) => number) | null = null;
    try {
      const compiled = compile(engine.differentiate(body, 'x'), { angleMode: 'radians' });
      fn = (x, env) => {
        env.x = x;
        return compiled(env);
      };
    } catch {
      fn = null;
    }
    derivCache.set(body, fn);
  }
  return derivCache.get(body) ?? undefined;
}

const INITIAL_DOC: GcalcDocument = emptyDocument(
  perfItems() ?? galleryItems() ?? [makeExpression()],
);

const EMPTY_ANALYSIS: Analysis = { kind: 'empty' };

const NO_ACTIONS: readonly CasAction[] = [];
const SCALAR_ACTIONS: readonly CasAction[] = ['derivative', 'integral', 'simplify', 'factor'];
const EQUATION_ACTIONS: readonly CasAction[] = ['solve'];
const TABLE_ACTIONS: readonly CasAction[] = ['fitLinear', 'fitQuadratic', 'fitExp'];

/** The scalar AST a CAS action operates on, or null. */
function casBody(a: Analysis | undefined): Expr | null {
  if (a === undefined) return null;
  if (a.kind === 'value') return a.ast;
  if (a.kind === 'plot' && a.spec.type === 'explicit') return a.spec.body;
  return null;
}

/** A literal data table's points (≥2, no slider deps), or null. */
function dataTablePoints(a: Analysis | undefined): Array<{ x: number; y: number }> | null {
  if (a === undefined || a.kind !== 'plot' || a.spec.type !== 'points') return null;
  if (a.spec.pts.length < 2 || a.deps.length > 0) return null;
  const pts: Array<{ x: number; y: number }> = [];
  for (const p of a.spec.pts) {
    const x = p.fx({});
    const y = p.fy({});
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    pts.push({ x, y });
  }
  return pts;
}

type DropZone = 'before' | 'after' | 'into';

/**
 * Where a drop lands relative to the hovered row, from the cursor's vertical
 * position: expressions split into before/after halves; folders reserve their
 * middle band for "into" (drop inside), edges for before/after.
 */
function dropZone(e: React.DragEvent, isFolder: boolean): DropZone {
  const rect = e.currentTarget.getBoundingClientRect();
  const t = (e.clientY - rect.top) / rect.height;
  if (isFolder) return t < 0.3 ? 'before' : t > 0.7 ? 'after' : 'into';
  return t < 0.5 ? 'before' : 'after';
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
  // All mutations flow through `dispatch`; undo/redo is snapshot history over
  // that single choke point (state/history.ts). `setDocDirect` bypasses history
  // for the automated perf animation only.
  const { doc, dispatch, undo, redo, canUndo, canRedo, setDocDirect } =
    useDocumentHistory(INITIAL_DOC);
  const { angleMode, precision } = doc;

  // Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z or Ctrl+Y redo. Intercepted globally
  // (the expression inputs are React-controlled, so native field undo doesn't
  // apply — document undo is what the user means everywhere in the app).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // Expressions in display order, each with its effective (folder-cascaded)
  // visibility. Definitions stay in scope regardless of visibility; only
  // plotting honours effectiveVisible.
  const flat = useMemo(() => flattenExpressions(doc), [doc]);

  // Pass 1: which names do definition rows define?
  const defined = useMemo(() => {
    const names = new Set<string>();
    for (const { item } of flat) {
      const name = definitionName(item.source);
      if (name !== null) names.add(name);
    }
    return names;
  }, [flat]);

  const definedKey = useMemo(() => [...defined].sort().join(','), [defined]);

  // Pass 2: full analysis, memoized across renders keyed by everything that
  // affects the result — so slider drags re-analyze only the dragged row.
  const cache = useRef(new Map<string, Analysis>());
  const analyses = useMemo(() => {
    const fresh = new Map<string, Analysis>();
    const out = new Map<number, Analysis>();
    for (const { item } of flat) {
      const key = `${angleMode}|${definedKey}|${item.source}`;
      const hit = cache.current.get(key) ?? fresh.get(key) ?? analyze(item.source, angleMode, defined);
      fresh.set(key, hit);
      out.set(item.id, hit);
    }
    cache.current = fresh;
    return out;
  }, [flat, angleMode, defined, definedKey]);

  // Shared env: slider values by name (all definitions, visibility-independent).
  const env = useMemo(() => {
    const e: Env = { x: 0 };
    for (const { item } of flat) {
      const a = analyses.get(item.id);
      if (a?.kind === 'definition') e[a.name] = a.value;
    }
    return e;
  }, [flat, analyses]);

  const curves = useMemo(() => {
    const out: PlottedCurve[] = [];
    for (const { item, effectiveVisible } of flat) {
      const a = analyses.get(item.id);
      if (effectiveVisible && a?.kind === 'plot') {
        out.push({
          id: item.id,
          spec: a.spec,
          fingerprint: a.deps.map((n) => env[n]).join(','),
          color: cssColor(item.colorIndex),
          fPrime:
            angleMode === 'radians' && a.spec.type === 'explicit'
              ? derivativeOf(a.spec.body)
              : undefined,
        });
      }
    }
    return out;
  }, [flat, analyses, env, angleMode]);

  // Points bound to exactly one slider are draggable along their path. The
  // defining slider's meta gives the range/step the drag snaps to.
  const dragPoints = useMemo(() => {
    const out: DragPoint[] = [];
    for (const { item, effectiveVisible } of flat) {
      const a = analyses.get(item.id);
      if (!effectiveVisible || a?.kind !== 'plot' || a.spec.type !== 'points') continue;
      if (a.spec.pts.length !== 1 || a.deps.length !== 1) continue;
      const name = a.deps[0];
      const owner = flat.find((f) => definitionName(f.item.source) === name)?.item;
      const meta = owner?.slider ?? DEFAULT_SLIDER;
      out.push({
        id: item.id,
        name,
        min: meta.min,
        max: meta.max,
        step: meta.step,
        fx: a.spec.pts[0].fx,
        fy: a.spec.pts[0].fy,
      });
    }
    return out;
  }, [flat, analyses]);

  // Live mirrors so the referentially-stable handlers can read current state
  // without re-binding (ExpressionRow's memo() skip depends on stable props).
  const docRef = useRef(doc);
  docRef.current = doc;
  const analysesRef = useRef(analyses);
  analysesRef.current = analyses;

  // Drag-and-drop: the id being dragged (ref, no re-render) and where the drop
  // would land (state, drives the indicator).
  const dragIdRef = useRef<number | null>(null);
  const [dropHint, setDropHint] = useState<{ itemId: number; where: DropZone } | null>(null);

  /* ---- expression mutations (all through dispatch) ---- */

  const onChangeRow = useCallback(
    (id: number, source: string): void => dispatch({ type: 'edit', id, source }),
    [dispatch],
  );

  const onSliderMeta = useCallback(
    (id: number, slider: SliderMeta): void => dispatch({ type: 'setSlider', id, slider }),
    [dispatch],
  );

  /** A slider/point drag rewrites the driving slider's definition row — same
   * path a slider drag takes, so dependent curves update live. */
  const onDragSlider = useCallback(
    (name: string, value: number, step: number): void => {
      const target = flattenExpressions(docRef.current).find(
        (f) => definitionName(f.item.source) === name,
      );
      if (!target) return;
      const decimals = Math.max(0, Math.min(10, -Math.floor(Math.log10(step) + 1e-9)));
      const text = value.toFixed(decimals);
      dispatch({ type: 'edit', id: target.item.id, source: `${name} = ${text === '-0' ? '0' : text}` });
    },
    [dispatch],
  );

  const onToggle = useCallback(
    (id: number): void => dispatch({ type: 'toggleVisible', id }),
    [dispatch],
  );

  const addEntry = useCallback((): void => dispatch({ type: 'add', item: makeExpression() }), [dispatch]);

  const onDelete = useCallback(
    (id: number): void => dispatch({ type: 'delete', id, fallback: makeExpression() }),
    [dispatch],
  );

  /** The create-slider suggestion: insert `name = 1` right after the row. */
  const onCreateSlider = useCallback(
    (afterId: number, name: string): void =>
      dispatch({
        type: 'insertAfter',
        afterId,
        items: [makeExpression(`${name} = 1`, { ...DEFAULT_SLIDER })],
      }),
    [dispatch],
  );

  /* ---- folder mutations ---- */

  const addFolder = useCallback(
    (): void => dispatch({ type: 'addFolder', folder: makeFolder() }),
    [dispatch],
  );
  const onRenameFolder = useCallback(
    (id: number, name: string): void => dispatch({ type: 'renameFolder', id, name }),
    [dispatch],
  );
  const onToggleFolderCollapsed = useCallback(
    (id: number): void => dispatch({ type: 'toggleFolderCollapsed', id }),
    [dispatch],
  );
  const onToggleFolderVisible = useCallback(
    (id: number): void => dispatch({ type: 'toggleFolderVisible', id }),
    [dispatch],
  );

  /* ---- drag-and-drop (reorder + reparent) ---- */

  const onItemDragStart = useCallback((e: React.DragEvent, id: number): void => {
    dragIdRef.current = id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(id)); // Firefox needs a payload
  }, []);

  const onItemDragEnd = useCallback((): void => {
    dragIdRef.current = null;
    setDropHint(null);
  }, []);

  const onItemDragOver = useCallback((e: React.DragEvent, item: Item): void => {
    if (dragIdRef.current === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const where = dropZone(e, item.kind === 'folder');
    setDropHint((h) => (h?.itemId === item.id && h.where === where ? h : { itemId: item.id, where }));
  }, []);

  const onItemDragLeave = useCallback((e: React.DragEvent, item: Item): void => {
    // Ignore leaving into a child element of the same wrapper.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropHint((h) => (h?.itemId === item.id ? null : h));
  }, []);

  const onItemDrop = useCallback(
    (e: React.DragEvent, item: Item): void => {
      e.preventDefault();
      e.stopPropagation(); // nested folders: only the innermost target acts
      const dragId = dragIdRef.current;
      dragIdRef.current = null;
      setDropHint(null);
      if (dragId === null || dragId === item.id) return;
      const where = dropZone(e, item.kind === 'folder');
      if (where === 'into') {
        dispatch({ type: 'move', id: dragId, targetFolderId: item.id, beforeId: null });
        return;
      }
      const loc = locate(docRef.current.items, item.id);
      if (loc === null) return;
      dispatch({
        type: 'move',
        id: dragId,
        targetFolderId: loc.parentId,
        beforeId: where === 'before' ? item.id : loc.nextSiblingId,
      });
    },
    [dispatch],
  );

  /** CAS menu dispatch — every action routes through the one CasEngine, and
   * every resulting mutation through the document dispatch. */
  const onCas = useCallback(
    (id: number, action: CasAction): void => {
      const a = analysesRef.current.get(id);
      const p = precisionRef.current;
      const setNote = (note: string): void => dispatch({ type: 'setNote', id, note });
      const insertAfter = (sources: string[]): void =>
        dispatch({ type: 'insertAfter', afterId: id, items: sources.map((s) => makeExpression(s)) });
      const fmt = (v: number): string => formatValue(v, p);

      try {
        if (action === 'fitLinear' || action === 'fitQuadratic' || action === 'fitExp') {
          const pts = dataTablePoints(a);
          if (pts === null) return;
          if (action === 'fitLinear') {
            const fit = linearFit(pts);
            if (fit === null) return setNote('Linear fit needs 2+ non-vertical points.');
            insertAfter([`y = ${fmt(fit.m)} x + ${fmt(fit.b)}`]);
            setNote(`linear fit · r² = ${fmt(fit.r2)}`);
          } else if (action === 'fitQuadratic') {
            const fit = polyFit(pts, 2);
            if (fit === null) return setNote('Quadratic fit needs 3+ points.');
            const [c0, c1, c2] = fit.coeffs;
            insertAfter([`y = ${fmt(c2)} x^2 + ${fmt(c1)} x + ${fmt(c0)}`]);
            setNote(`quadratic fit · r² = ${fmt(fit.r2)}`);
          } else {
            const fit = expFit(pts);
            if (fit === null) return setNote('Exponential fit needs 2+ points with positive y.');
            insertAfter([`y = ${fmt(fit.a)} e^(${fmt(fit.b)} x)`]);
            setNote(`exponential fit · r² = ${fmt(fit.r2)}`);
          }
          return;
        }

        if (action === 'solve') {
          const target = solveTarget(a);
          if (target === null) return;
          const result = engine.solve(target, 'x');
          switch (result.kind) {
            case 'exact': {
              if (result.solutions.length === 0) return setNote(result.note ?? 'No real solutions.');
              insertAfter(result.solutions.map((s) => `x = ${toSource(s)}`));
              const approx = result.solutions.map((s) => fmt(engine.approximate(s))).join(', ');
              setNote(`exact solutions inserted · x ≈ ${approx}`);
              return;
            }
            case 'numeric':
              insertAfter(result.solutions.map((v) => `x = ${fmt(v)}`));
              setNote(`numeric roots (no exact form) · ${result.solutions.length} found`);
              return;
            case 'all-reals':
              return setNote('True for every x.');
            case 'no-solution-found':
              return setNote(result.note ?? 'The solver gave up.');
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
          return setNote('No closed-form antiderivative found — definite integrals still work numerically.');
        }
        insertAfter([toSource(result)]);
        setNote(
          angleModeRef.current === 'degrees'
            ? 'CAS results use radian semantics.'
            : `${action} inserted below`,
        );
      } catch (err) {
        if (err instanceof GcalcError) return setNote(err.info.message);
        throw err;
      }
    },
    [dispatch],
  );

  // Refs so onCas stays referentially stable (memo()ed rows).
  const precisionRef = useRef(precision);
  precisionRef.current = precision;
  const angleModeRef = useRef(angleMode);
  angleModeRef.current = angleMode;

  const { hudRef, onFrame, toggle } = usePerfAnimation(setDocDirect);

  const dragHandle = (id: number): JSX.Element => (
    <span
      className="drag-handle"
      draggable
      title="Drag to reorder or move into a folder"
      aria-hidden="true"
      onDragStart={(e) => onItemDragStart(e, id)}
      onDragEnd={onItemDragEnd}
    >
      ⠿
    </span>
  );

  // Recursive tree render: folders contain their children (indented) and
  // expressions render a row. Each item is wrapped in a drop target; the
  // memo()ed ExpressionRow still receives only stable callbacks, so the M3
  // perf skip is preserved.
  const renderItem = (item: Item): JSX.Element => {
    const hint = dropHint?.itemId === item.id ? ` drop-${dropHint.where}` : '';
    const dnd = {
      onDragOver: (e: React.DragEvent) => onItemDragOver(e, item),
      onDragLeave: (e: React.DragEvent) => onItemDragLeave(e, item),
      onDrop: (e: React.DragEvent) => onItemDrop(e, item),
    };
    if (item.kind === 'folder') {
      return (
        <div key={item.id} className={`tree-item${hint}`} {...dnd}>
          <FolderRow
            folder={item}
            dragHandle={dragHandle(item.id)}
            onRename={onRenameFolder}
            onToggleCollapsed={onToggleFolderCollapsed}
            onToggleVisible={onToggleFolderVisible}
            onDelete={onDelete}
          >
            {item.children.map(renderItem)}
          </FolderRow>
        </div>
      );
    }
    const a = analyses.get(item.id) ?? EMPTY_ANALYSIS;
    const actions =
      casBody(a) !== null
        ? SCALAR_ACTIONS
        : solveTarget(a) !== null
          ? EQUATION_ACTIONS
          : dataTablePoints(a) !== null
            ? TABLE_ACTIONS
            : NO_ACTIONS;
    return (
      <div key={item.id} className={`tree-item${hint}`} {...dnd}>
        <div className="expr-with-handle">
          {dragHandle(item.id)}
          <ExpressionRow
            entry={item}
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
        </div>
      </div>
    );
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="sidebar-header">
          <h1 className="app-title">gcalc</h1>
          <div className="header-controls">
            <div className="undo-group" role="group" aria-label="History">
              <button
                type="button"
                title="Undo (Ctrl+Z)"
                aria-label="Undo"
                disabled={!canUndo}
                onClick={undo}
              >
                ↶
              </button>
              <button
                type="button"
                title="Redo (Ctrl+Shift+Z)"
                aria-label="Redo"
                disabled={!canRedo}
                onClick={redo}
              >
                ↷
              </button>
            </div>
            <label className="precision-select" title="Numeric display precision (significant digits)">
              <select
                value={precision}
                onChange={(e) => dispatch({ type: 'setPrecision', precision: Number(e.target.value) })}
              >
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
                onClick={() => dispatch({ type: 'setAngleMode', angleMode: 'radians' })}
              >
                rad
              </button>
              <button
                type="button"
                aria-pressed={angleMode === 'degrees'}
                onClick={() => dispatch({ type: 'setAngleMode', angleMode: 'degrees' })}
              >
                deg
              </button>
            </div>
          </div>
        </header>
        <div className="expr-list">{doc.items.map(renderItem)}</div>
        <div className="list-actions">
          <button type="button" className="add-button" onClick={addEntry}>
            + expression
          </button>
          <button type="button" className="add-button" onClick={addFolder}>
            + folder
          </button>
        </div>
      </aside>
      <main className="canvas-area">
        <GraphCanvas
          curves={curves}
          env={env}
          dragPoints={dragPoints}
          precision={precision}
          onDragSlider={onDragSlider}
          onFrame={onFrame}
        />
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
