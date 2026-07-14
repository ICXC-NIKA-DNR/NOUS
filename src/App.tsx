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
  applyCommand,
  emptyDocument,
  flattenExpressions,
  locate,
  makeExpression,
  makeFolder,
  type Command,
  type GcalcDocument,
  type Item,
} from './state/document.ts';
import {
  advancePhase,
  formatSliderValue,
  metaMultiplier,
  phaseFromValue,
  sliderValueAt,
} from './state/sliderAnim.ts';
import { autosaveStore, installCleanExitMarker } from './platform/autosave.ts';
import { errorLogPath, installErrorLog } from './platform/errorlog.ts';
import { filePlatform } from './platform/files.ts';
import { packSession, unpackSession, type UnpackedSession } from './state/autosave.ts';
import { decodeShareCode, documentToJson, encodeShareCode, parseNousJson } from './state/serialize.ts';
import { makeTab, useWorkspace } from './state/workspace.ts';
import { scanFunctionHead } from './core/funcdef.ts';
import { DocActions } from './ui/DocActions.tsx';
import type { Viewport } from './plot/viewport.ts';
import { analyze, buildFunctionScope, definitionName, formatValue, type Analysis } from './ui/analyze.ts';
import {
  curveColorVar,
  DEFAULT_SLIDER,
  ExpressionRow,
  type CasAction,
  type SliderMeta,
} from './ui/ExpressionRow.tsx';
import { FolderRow } from './ui/FolderRow.tsx';
import { GraphCanvas, type DragPoint, type GraphApi, type PlottedCurve } from './ui/GraphCanvas.tsx';
import { matchShortcut } from './ui/shortcuts.ts';
import { ShortcutsPanel } from './ui/ShortcutsPanel.tsx';
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
// Minted at module scope: StrictMode double-invokes state initializers, which
// would burn tab ids ("Graph 2" as the first tab).
const INITIAL_TAB = makeTab(INITIAL_DOC);

// Curve-palette preference. This is a viewer-level accessibility choice (which
// palette is legible to *this* user), so it lives globally in localStorage —
// NOT in the per-document state serialized into .nous, where opening someone
// else's vivid-palette file would clobber a colorblind user's choice. "vivid"
// is the default candy palette; "accessible" is the CVD-verified set. Both are
// defined as --curve-N vars in styles.css and swapped via a :root attribute,
// so canvas and SVG export switch together (see cssColor / render below).
type PaletteMode = 'vivid' | 'accessible';
const PALETTE_KEY = 'nous.paletteMode';
function readStoredPalette(): PaletteMode {
  try {
    return localStorage.getItem(PALETTE_KEY) === 'accessible' ? 'accessible' : 'vivid';
  } catch {
    return 'vivid';
  }
}
// Default 'vivid' is the base :root; only 'accessible' needs the attribute.
function applyPaletteAttr(mode: PaletteMode): void {
  const root = document.documentElement;
  if (mode === 'accessible') root.setAttribute('data-palette', 'accessible');
  else root.removeAttribute('data-palette');
}
// Apply the stored choice at module load, before React's first render, so the
// canvas resolves the right --curve-N values on the initial paint.
const INITIAL_PALETTE = readStoredPalette();
applyPaletteAttr(INITIAL_PALETTE);

// Perf-HUD visibility. Viewer-level preference like the palette: lives in
// localStorage, not in the document. ?perf=N still forces the HUD on
// regardless of this toggle (the harness/gallery path).
const PERF_HUD_KEY = 'nous.showPerfHud';
function readStoredPerfHud(): boolean {
  try {
    return localStorage.getItem(PERF_HUD_KEY) === 'on';
  } catch {
    return false;
  }
}
const INITIAL_PERF_HUD = readStoredPerfHud();

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
  // The workspace holds document tabs, each an independent editing session
  // (own document, own undo/redo, own viewport). All mutations flow through
  // `dispatch` into the ACTIVE tab's history; `setDocDirect` bypasses history
  // for automated animations only (perf harness, ▶ slider playback).
  const {
    tabs,
    activeTabId,
    doc,
    savedViewport,
    dispatch,
    undo,
    redo,
    canUndo,
    canRedo,
    newTab,
    openDocument,
    replaceDocuments,
    getSessionTabs,
    close: closeTab,
    select: selectTab,
    reportViewport,
    setDocDirect,
  } = useWorkspace(INITIAL_TAB);
  const { angleMode, precision } = doc;

  // Live viewport per tab, in a ref: onViewportChange fires at pointer rate
  // during pan/zoom, and a state write per frame would re-render the whole
  // app. The ref feeds the seed on tab switch; the workspace's stored copy is
  // refreshed at switch time (all a future serializer needs).
  const liveViewports = useRef(new Map<number, Viewport>());
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const onViewportChange = useCallback((vp: Viewport): void => {
    liveViewports.current.set(activeTabIdRef.current, vp);
  }, []);

  const onSelectTab = useCallback(
    (id: number): void => {
      // Flush the outgoing tab's live viewport into workspace state so its
      // exact view is what the seed restores later.
      const current = liveViewports.current.get(activeTabIdRef.current);
      if (current) reportViewport(current);
      selectTab(id);
    },
    [reportViewport, selectTab],
  );

  // Global keyboard shortcuts (M7 undo/redo + M9.3), all through the one
  // BINDINGS table in ui/shortcuts.ts. Intercepted globally: the expression
  // inputs are React-controlled, so native field undo doesn't apply —
  // document-level actions are what the user means everywhere in the app.
  const graphApi = useRef<GraphApi | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>(INITIAL_PALETTE);
  const changePalette = useCallback((mode: PaletteMode): void => {
    applyPaletteAttr(mode); // set the :root attr first so getComputedStyle is fresh
    resolved.length = 0; // drop cached hex → curves re-resolve from the new vars
    try {
      localStorage.setItem(PALETTE_KEY, mode);
    } catch {
      // ignore storage failures (private mode / quota); the switch still applies live
    }
    setPaletteMode(mode);
  }, []);
  const [showPerfHud, setShowPerfHud] = useState<boolean>(INITIAL_PERF_HUD);
  const togglePerfHud = useCallback((): void => {
    setShowPerfHud((on) => !on);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(PERF_HUD_KEY, showPerfHud ? 'on' : 'off');
    } catch {
      // ignore storage failures (private mode / quota); the toggle still applies live
    }
  }, [showPerfHud]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setShortcutsOpen(false);
        return; // never consumed further: rows use Esc for their own dismissals
      }
      const target = e.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement;
      const action = matchShortcut({
        key: e.key,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        typing,
      });
      if (action === null) return;
      // Row-targeted actions apply to the row whose input has focus.
      const rowId = ((): number | null => {
        const el = target?.closest?.('[data-item-id]');
        const raw = el?.getAttribute('data-item-id');
        return raw ? Number(raw) : null;
      })();
      e.preventDefault();
      switch (action) {
        case 'undo':
          return undo();
        case 'redo':
          return redo();
        case 'new-expression':
          return dispatch({ type: 'add', item: makeExpression() });
        case 'delete-expression':
          if (rowId !== null) dispatch({ type: 'delete', id: rowId, fallback: makeExpression() });
          return;
        case 'toggle-visibility':
          if (rowId !== null) dispatch({ type: 'toggleVisible', id: rowId });
          return;
        case 'zoom-in':
          return graphApi.current?.zoomIn();
        case 'zoom-out':
          return graphApi.current?.zoomOut();
        case 'zoom-reset':
          return graphApi.current?.resetView();
        case 'show-shortcuts':
          return setShortcutsOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, dispatch]);

  // Ctrl+wheel anywhere must never reach the WebView: WebKitGTK applies its
  // native page zoom to any ctrl-modified wheel event that isn't
  // default-prevented, and GraphCanvas's own listener only covers the canvas.
  // Non-passive for the same reason as there. Plain scrolling is untouched,
  // and the canvas handler still zooms the graph (this fires in addition,
  // not instead — preventDefault twice is harmless).
  useEffect(() => {
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey) e.preventDefault();
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, []);

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

  // Pass 1b (M9.5): the document's user-function scope — names (for parsing),
  // usable definitions (inlined at call sites), and names marked invalid
  // (recursive / defined more than once). Rebuilt when any definition row's
  // text changes; `functionsKey` also feeds the per-row analysis cache so a
  // body edit re-analyzes the rows that call it.
  const functionsKey = useMemo(() => {
    const parts: string[] = [];
    for (const { item } of flat) {
      if (scanFunctionHead(item.source) !== null) parts.push(item.source);
    }
    return parts.join('\n');
  }, [flat]);

  const functionScope = useMemo(
    () => buildFunctionScope(flat.map((f) => f.item.source)),
    // functionsKey captures every definition-row edit that can change scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [functionsKey],
  );

  // Pass 2: full analysis, memoized across renders keyed by everything that
  // affects the result — so slider drags re-analyze only the dragged row.
  const cache = useRef(new Map<string, Analysis>());
  const analyses = useMemo(() => {
    const fresh = new Map<string, Analysis>();
    const out = new Map<number, Analysis>();
    for (const { item } of flat) {
      const key = `${angleMode}|${definedKey}|${functionsKey}|${item.source}`;
      const hit =
        cache.current.get(key) ??
        fresh.get(key) ??
        analyze(item.source, angleMode, defined, functionScope);
      fresh.set(key, hit);
      out.set(item.id, hit);
    }
    cache.current = fresh;
    return out;
  }, [flat, angleMode, defined, definedKey, functionScope, functionsKey]);

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
  }, [flat, analyses, env, angleMode, paletteMode]);

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

  /* ---- slider animation (Slider-Anim-M1): ▶ sliders sweep min→max→min ---- */

  // Phase per playing slider, transient (never persisted): pressing ▶ resumes
  // from the row's current value via phaseFromValue; pausing forgets the phase.
  const animPhases = useRef(new Map<number, number>());
  // The loop restarts only when the SET of playing sliders changes; per-frame
  // reads go through docRef/analysesRef so edits don't re-run the effect.
  const playingKey = useMemo(
    () =>
      flat
        .filter((f) => f.item.slider?.playing)
        .map((f) => f.item.id)
        .join(','),
    [flat],
  );
  useEffect(() => {
    if (playingKey === '') {
      animPhases.current.clear();
      return;
    }
    const playing = new Set(playingKey.split(',').map(Number));
    for (const id of [...animPhases.current.keys()]) {
      if (!playing.has(id)) animPhases.current.delete(id);
    }
    let raf = 0;
    let last = 0;
    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick);
      const delta = last > 0 ? now - last : 0;
      last = now;
      if (delta <= 0) return;
      const edits: Command[] = [];
      for (const { item } of flattenExpressions(docRef.current)) {
        const meta = item.slider;
        if (!meta?.playing) continue;
        const name = definitionName(item.source);
        if (name === null) continue;
        let phase = animPhases.current.get(item.id);
        if (phase === undefined) {
          const a = analysesRef.current.get(item.id);
          const value = a?.kind === 'definition' ? a.value : meta.min;
          phase = phaseFromValue(value, meta.min, meta.max);
        }
        phase = advancePhase(phase, delta, metaMultiplier(meta));
        animPhases.current.set(item.id, phase);
        const value = sliderValueAt(phase, meta.min, meta.max);
        edits.push({
          type: 'edit',
          id: item.id,
          source: `${name} = ${formatSliderValue(value, meta.step)}`,
        });
      }
      if (edits.length > 0) {
        // Straight to the document, never through undo history — per-frame
        // automated writes would flood the stack (same rule as the perf
        // harness animation).
        setDocDirect((d) => edits.reduce(applyCommand, d));
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playingKey, setDocDirect]);

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

  /* ---- persistence (M8.1/M8.2): one serializer, several transports ---- */

  const savedViewportRef = useRef(savedViewport);
  savedViewportRef.current = savedViewport;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const activeViewport = useCallback(
    (): Viewport | null =>
      liveViewports.current.get(activeTabIdRef.current) ?? savedViewportRef.current,
    [],
  );

  const activeTabName = useCallback(
    (): string =>
      tabsRef.current.find((t) => t.id === activeTabIdRef.current)?.name ?? 'Graph',
    [],
  );

  const makeShareCode = useCallback(
    (): string => encodeShareCode(docRef.current, { viewport: activeViewport() }),
    [activeViewport],
  );

  const saveFile = useCallback((): Promise<string | null> => {
    const name = activeTabName();
    const json = documentToJson(docRef.current, { name, viewport: activeViewport() });
    return filePlatform.saveNousFile(json, `${name}.nous`);
  }, [activeTabName, activeViewport]);

  const openFile = useCallback(async (): Promise<string | null> => {
    const file = await filePlatform.openNousFile();
    if (file === null) return null;
    const loaded = parseNousJson(file.contents);
    // Prefer the name stored in the file; fall back to the file name.
    openDocument(loaded.doc, loaded.name ?? file.name.replace(/\.nous$/i, ''), loaded.viewport);
    return file.name;
  }, [openDocument]);

  const openShareCode = useCallback(
    (code: string): void => {
      // Throws NousFormatError on bad input; DocActions renders the message.
      const loaded = decodeShareCode(code);
      openDocument(loaded.doc, loaded.name, loaded.viewport);
    },
    [openDocument],
  );

  /* ---- autosave + crash recovery (M8.3) ---- */

  // Recovery payload found on launch (unclean previous exit). Read once on
  // mount, not in the initializer: reads are cheap but the offer should also
  // survive a StrictMode double-mount unambiguously.
  const [recovery, setRecovery] = useState<UnpackedSession | null>(null);
  useEffect(() => {
    const payload = autosaveStore.readRecovery();
    if (payload === null) return;
    try {
      setRecovery(unpackSession(payload));
    } catch {
      // Half-written payload from a crash mid-write: nothing recoverable.
      autosaveStore.clear();
    }
  }, []);

  const onRecover = useCallback((): void => {
    // Replace the workspace with the recovered tabs, rather than appending them
    // beside the fresh "Graph 1" (M10.2 decision): recovery restores the prior
    // session as the whole tab set.
    if (recovery) replaceDocuments(recovery.tabs);
    autosaveStore.clear();
    setRecovery(null);
  }, [recovery, replaceDocuments]);

  const onDiscardRecovery = useCallback((): void => {
    autosaveStore.clear();
    setRecovery(null);
  }, []);

  // Debounced autosave on any document/tab change. The first run after mount
  // is skipped: an untouched fresh session must not mark itself dirty, or
  // every clean launch-then-kill would offer to "recover" an empty graph.
  const autosaveArmed = useRef(false);
  useEffect(() => {
    if (!autosaveArmed.current) {
      autosaveArmed.current = true;
      return;
    }
    const timer = setTimeout(() => {
      const tabsNow = getSessionTabs().map((t) => ({
        name: t.name,
        doc: t.doc,
        viewport: liveViewports.current.get(t.id) ?? t.viewport,
      }));
      autosaveStore.write(packSession(tabsNow));
    }, 800);
    return () => clearTimeout(timer);
  }, [doc, tabs, getSessionTabs]);

  // Clean-exit marker + error log capture; the log path renders in the footer.
  const [logPath, setLogPath] = useState('');
  useEffect(() => {
    const uninstallMarker = installCleanExitMarker();
    const uninstallLog = installErrorLog();
    let alive = true;
    errorLogPath().then((p) => {
      if (alive) setLogPath(p);
    });
    return () => {
      alive = false;
      uninstallMarker();
      uninstallLog();
    };
  }, []);

  const { hudRef, onFrame, toggle } = usePerfAnimation(setDocDirect, showPerfHud);

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
        <div key={item.id} className={`tree-item${hint}`} data-item-id={item.id} {...dnd}>
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
      <div key={item.id} className={`tree-item${hint}`} data-item-id={item.id} {...dnd}>
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
            definedNames={defined}
            definedFunctions={functionScope.names}
          />
        </div>
      </div>
    );
  };

  return (
    <div className="app">
      <aside className="sidebar">
        {recovery && (
          <div className="recovery-banner" role="alertdialog" aria-label="Recover unsaved work">
            <span>
              NOUS didn&apos;t close cleanly. Recover unsaved work from{' '}
              {new Date(recovery.savedAt).toLocaleString()} ({recovery.tabs.length}{' '}
              {recovery.tabs.length === 1 ? 'graph' : 'graphs'})?
            </span>
            <div className="recovery-actions">
              <button type="button" onClick={onRecover}>
                Recover
              </button>
              <button type="button" onClick={onDiscardRecovery}>
                Discard
              </button>
            </div>
          </div>
        )}
        <div className="tab-bar" role="tablist" aria-label="Documents">
          {tabs.map((t) => (
            <div
              key={t.id}
              role="tab"
              aria-selected={t.id === activeTabId}
              tabIndex={0}
              className={`tab${t.id === activeTabId ? ' tab-active' : ''}`}
              onClick={() => onSelectTab(t.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') onSelectTab(t.id);
              }}
            >
              <span className="tab-name">{t.name}</span>
              {tabs.length > 1 && (
                <button
                  type="button"
                  className="tab-close"
                  title="Close tab"
                  aria-label={`Close ${t.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.id);
                  }}
                >
                  ×
                </button>
              )}
            </div>
          ))}
          <button type="button" className="tab-new" title="New graph" onClick={newTab}>
            +
          </button>
        </div>
        <DocActions
          makeShareCode={makeShareCode}
          openShareCode={openShareCode}
          saveFile={saveFile}
          openFile={openFile}
        />
        <header className="sidebar-header">
          <h1 className="app-title">NOUS</h1>
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
            <label className="palette-select" title="Curve color palette (Accessible is colorblind-safe)">
              <select
                value={paletteMode}
                onChange={(e) => changePalette(e.target.value as PaletteMode)}
                aria-label="Curve color palette"
              >
                <option value="vivid">Vivid</option>
                <option value="accessible">Accessible</option>
              </select>
            </label>
            <button
              type="button"
              className="shortcuts-button"
              title="Keyboard shortcuts (?)"
              aria-label="Keyboard shortcuts"
              onClick={() => setShortcutsOpen(true)}
            >
              ⌨
            </button>
            <button
              type="button"
              className="shortcuts-button perf-toggle"
              title="Show performance stats"
              aria-label="Show performance stats"
              aria-pressed={showPerfHud}
              onClick={togglePerfHud}
            >
              fps
            </button>
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
        {logPath && (
          <div className="error-log-path" title="Attach this log to GitHub issues — it never leaves your machine">
            Error log: <code>{logPath}</code>
          </div>
        )}
      </aside>
      <main className="canvas-area">
        <GraphCanvas
          key={activeTabId} // remount per tab: each restores its own viewport
          curves={curves}
          env={env}
          dragPoints={dragPoints}
          precision={precision}
          onDragSlider={onDragSlider}
          onFrame={onFrame}
          initialViewport={liveViewports.current.get(activeTabId) ?? savedViewport}
          onViewportChange={onViewportChange}
          apiRef={graphApi}
          getExportName={activeTabName}
        />
        <PerfHud hudRef={hudRef} toggle={toggle} manual={showPerfHud} />
      </main>
      {shortcutsOpen && <ShortcutsPanel onClose={() => setShortcutsOpen(false)} />}
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
