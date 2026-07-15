// One sidebar row: text input, live KaTeX preview, per-curve color chip that
// doubles as the visibility toggle, delete button, structured error display
// with one-click fixes, slider rendering for definitions, and the CAS menu
// (derivative / integral / simplify / factor / solve) routing through the
// single CasEngine.

import katex from 'katex';
import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  applyCompletion,
  complete,
  type CompletionResult,
} from '../core/autocomplete.ts';
import type { Analysis } from './analyze.ts';
import { applyEdit, formatValue } from './analyze.ts';
import {
  addCurveNode,
  formatSliderValue,
  MAX_CURVE_NODES,
  moveCurveNode,
  normalizedCurveNodes,
  prepareCurve,
  removeCurveNode,
  type CurveNode,
  type GraphSpan,
  type LoopSeam,
  type SpeedMode,
} from '../state/sliderAnim.ts';
import { toTex } from './tex.ts';

export interface SliderMeta {
  min: number;
  max: number;
  step: number;
  /** ▶ animation running (Slider-Anim-M1). Persists like the rest of the meta. */
  playing?: boolean;
  /** Interpolation between the speed nodes (Slider-Anim-M3): 'flat' = linear
   * segments, 'curve' = PCHIP. Default 'flat'. (The M1 scalar `speed` field
   * is gone — legacy files' speed seeds the two anchors at load.) */
  speedMode?: SpeedMode;
  /** Speed-ramp control points, sorted by phase; anchors at phase 0 and 1. */
  curveNodes?: CurveNode[];
  /** Anchor lock: 'smooth' keeps the start and end anchors' y equal (under
   * roundTrip that's continuous speed across cycles; under oneWay, equal
   * speeds at min and max); 'hard' lets them differ. */
  loopSeam?: LoopSeam;
  /** What the curve's x-axis depicts (Slider-Anim-M4): one min→max traversal
   * ('oneWay', default — the return retraces in reverse) or the full
   * min→max→min cycle ('roundTrip'). Legacy curves load as 'roundTrip'. */
  graphSpan?: GraphSpan;
}

export interface ExpressionEntry {
  id: number;
  source: string;
  colorIndex: number;
  visible: boolean;
  /** Present on definition rows; created with defaults by the slider action. */
  slider?: SliderMeta;
  /** Transient CAS status line (solve summaries, radians reminders). */
  note?: string;
}

export type CasAction =
  | 'derivative'
  | 'integral'
  | 'simplify'
  | 'factor'
  | 'solve'
  | 'fitLinear'
  | 'fitQuadratic'
  | 'fitExp';

const CAS_LABELS: Record<CasAction, string> = {
  derivative: 'Derivative',
  integral: 'Integral',
  simplify: 'Simplify',
  factor: 'Factor',
  solve: 'Solve for x',
  fitLinear: 'Fit: linear',
  fitQuadratic: 'Fit: quadratic',
  fitExp: 'Fit: exponential',
};

export const DEFAULT_SLIDER: SliderMeta = { min: -10, max: 10, step: 0.1 };

const CURVE_COLORS = 6; // --curve-1 … --curve-6 in styles.css

export function curveColorVar(colorIndex: number): string {
  return `var(--curve-${(colorIndex % CURVE_COLORS) + 1})`;
}


interface RowProps {
  entry: ExpressionEntry;
  analysis: Analysis;
  precision: number;
  casActions: readonly CasAction[];
  onChange: (id: number, source: string) => void;
  onSliderMeta: (id: number, meta: SliderMeta) => void;
  onCreateSlider: (id: number, name: string) => void;
  onCas: (id: number, action: CasAction) => void;
  onToggle: (id: number) => void;
  onDelete: (id: number) => void;
  onEnter: () => void;
  /** Slider/value names defined in the document — autocomplete scope. */
  definedNames: ReadonlySet<string>;
  /** User-defined function names — autocompleted with a paren (M9.5). */
  definedFunctions: ReadonlySet<string>;
}

function MathPreview({ analysis, precision }: { analysis: Analysis; precision: number }): JSX.Element | null {
  const html = useMemo(() => {
    if (analysis.kind === 'function-definition') {
      // Upright function name, italic params: f(x) = <body>.
      const head = `\\operatorname{${analysis.name}}\\left(${analysis.params.join(', ')}\\right)`;
      return katex.renderToString(`${head} = ${toTex(analysis.body)}`, {
        throwOnError: false,
        output: 'html',
      });
    }
    if (analysis.kind !== 'plot' && analysis.kind !== 'value' && analysis.kind !== 'unsupported') {
      return null;
    }
    // Prefer the display AST (pre-user-inline) so `y = f(x)` shows `f(x)`, not
    // its inlined body; falls back to the compute AST for rows without one.
    const shown = analysis.displayAst ?? analysis.ast;
    const tex =
      analysis.kind === 'value'
        ? `${toTex(shown)} = ${formatValue(analysis.value, precision)}`
        : toTex(shown);
    return katex.renderToString(tex, { throwOnError: false, output: 'html' });
  }, [analysis, precision]);

  if (html === null) return null;
  // KaTeX output is generated locally from our own AST — not user HTML.
  return <div className="math-preview" dangerouslySetInnerHTML={{ __html: html }} />;
}

/* ---- speed-curve editor (Slider-Anim-M2) ---- */

// Fixed-pixel SVG (no CSS scaling) so pointer math is a direct subtraction.
const CURVE_W = 224;
const CURVE_H = 96;
const CURVE_PAD = 10;

/** phase 0–1 → x px. */
const curveX = (phase: number): number => CURVE_PAD + phase * (CURVE_W - 2 * CURVE_PAD);
/** multiplier → y px, log₂-scaled: 4× top, 1× center, ¼× bottom. */
const curveY = (mult: number): number =>
  CURVE_PAD + ((2 - Math.log2(mult)) / 4) * (CURVE_H - 2 * CURVE_PAD);

function SpeedCurveEditor({
  meta,
  onMeta,
}: {
  meta: SliderMeta;
  onMeta: (meta: SliderMeta) => void;
}): JSX.Element {
  // One editor for both interpolation modes (Slider-Anim-M3): the same node
  // graph drives playback whether segments are linear ('flat') or PCHIP
  // ('curve'). Display falls back to the normalized default (two anchors at
  // 1×); any edit materializes the nodes into the meta.
  const nodes = normalizedCurveNodes(meta);
  const seam: LoopSeam = meta.loopSeam ?? 'smooth';
  const mode: SpeedMode = meta.speedMode ?? 'flat';
  const span: GraphSpan = meta.graphSpan ?? 'oneWay';
  const svgRef = useRef<SVGSVGElement>(null);
  const dragIndex = useRef<number | null>(null);
  // Every edit stamps graphSpan alongside the nodes: the load-normalizer
  // treats span-less curves as legacy 'roundTrip', so a curve authored under
  // the 'oneWay' default must say so explicitly to survive a reload.
  const setNodes = (next: CurveNode[]): void =>
    onMeta({ ...meta, graphSpan: span, curveNodes: next });

  const path = useMemo(() => {
    const at = prepareCurve(nodes, seam, mode);
    const pts: string[] = [];
    for (let i = 0; i <= 64; i++) {
      const p = i / 64;
      pts.push(`${i === 0 ? 'M' : 'L'}${curveX(p).toFixed(1)},${curveY(at(p)).toFixed(1)}`);
    }
    return pts.join(' ');
  }, [nodes, seam, mode]);

  const dragTo = (i: number, e: React.PointerEvent): void => {
    // The SVG is CSS-sized to the sidebar; map client px back into viewBox px.
    const rect = svgRef.current!.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) * CURVE_W) / rect.width;
    const vy = ((e.clientY - rect.top) * CURVE_H) / rect.height;
    const phase = (vx - CURVE_PAD) / (CURVE_W - 2 * CURVE_PAD);
    const ly = 2 - (4 * (vy - CURVE_PAD)) / (CURVE_H - 2 * CURVE_PAD);
    // Clamps: anchors pin to x 0/1 (smooth also y-locks them together),
    // middles stay between their neighbors, y stays in the speed range.
    setNodes(moveCurveNode(nodes, i, phase, 2 ** ly, seam));
  };

  return (
    <div className="speed-curve">
      <div className="speed-curve-controls">
        <div className="angle-toggle" role="group" aria-label="Interpolation">
          <button
            type="button"
            aria-pressed={mode === 'flat'}
            title="Straight segments between nodes"
            onClick={() => onMeta({ ...meta, speedMode: 'flat', curveNodes: nodes })}
          >
            linear
          </button>
          <button
            type="button"
            aria-pressed={mode === 'curve'}
            title="Smooth spline through the nodes"
            onClick={() => onMeta({ ...meta, speedMode: 'curve', curveNodes: nodes })}
          >
            curve
          </button>
        </div>
        <div className="angle-toggle" role="group" aria-label="Graph span">
          <button
            type="button"
            aria-pressed={span === 'oneWay'}
            title="X-axis is one min→max traversal; the return retraces it in reverse"
            onClick={() => onMeta({ ...meta, graphSpan: 'oneWay', curveNodes: nodes })}
          >
            one-way
          </button>
          <button
            type="button"
            aria-pressed={span === 'roundTrip'}
            title="X-axis is the entire min→max→min cycle, forward and back drawn explicitly"
            onClick={() => onMeta({ ...meta, graphSpan: 'roundTrip', curveNodes: nodes })}
          >
            round-trip
          </button>
        </div>
        <div className="angle-toggle" role="group" aria-label="Loop seam">
          <button
            type="button"
            aria-pressed={seam === 'smooth'}
            title="Start and end anchors locked together — the speeds at the two ends always match"
            onClick={() =>
              // Entering smooth mode snaps the end anchor onto node 0 in
              // the data (moveCurveNode's anchor-sync does exactly that).
              onMeta({
                ...meta,
                graphSpan: span,
                loopSeam: 'smooth',
                curveNodes: moveCurveNode(nodes, 0, 0, nodes[0].multiplier, 'smooth'),
              })
            }
          >
            smooth
          </button>
          <button
            type="button"
            aria-pressed={seam === 'hard'}
            title="Anchors move independently — the speeds at the two ends can differ"
            onClick={() => onMeta({ ...meta, graphSpan: span, loopSeam: 'hard', curveNodes: nodes })}
          >
            hard
          </button>
        </div>
        <button
          type="button"
          className="curve-node-btn"
          aria-label="Add curve node"
          disabled={nodes.length >= MAX_CURVE_NODES}
          onClick={() => setNodes(addCurveNode(nodes, seam, mode))}
        >
          +
        </button>
        <button
          type="button"
          className="curve-node-btn"
          aria-label="Remove curve node"
          disabled={nodes.length <= 2}
          onClick={() => setNodes(removeCurveNode(nodes))}
        >
          −
        </button>
      </div>
      <svg
        ref={svgRef}
        className="speed-curve-graph"
        viewBox={`0 0 ${CURVE_W} ${CURVE_H}`}
        role="img"
        aria-label="Speed curve: phase through one cycle vs speed multiplier"
      >
        {[4, 1, 0.25].map((m) => (
          <g key={m}>
            <line
              className={`speed-curve-grid${m === 1 ? ' one' : ''}`}
              x1={CURVE_PAD}
              x2={CURVE_W - CURVE_PAD}
              y1={curveY(m)}
              y2={curveY(m)}
            />
            <text className="speed-curve-label" x={1} y={curveY(m) + 2.5}>
              {m === 0.25 ? '¼' : m}×
            </text>
          </g>
        ))}
        <text
          className="speed-curve-label axis"
          x={CURVE_W / 2}
          y={CURVE_H - 2}
          textAnchor="middle"
        >
          {span === 'oneWay' ? 'min → max (returns in reverse)' : 'min → max → min'}
        </text>
        <path className="speed-curve-path" d={path} />
        {nodes.map((node, i) => (
          <circle
            key={i}
            className={`speed-curve-node${i === 0 || i === nodes.length - 1 ? ' anchor' : ''}`}
            cx={curveX(node.phase)}
            cy={curveY(node.multiplier)}
            r={4.5}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              dragIndex.current = i;
            }}
            onPointerMove={(e) => {
              if (dragIndex.current === i) dragTo(i, e);
            }}
            onPointerUp={() => {
              dragIndex.current = null;
            }}
            onPointerCancel={() => {
              dragIndex.current = null;
            }}
          />
        ))}
      </svg>
    </div>
  );
}

function SliderControls({
  name,
  value,
  meta,
  onChange,
  onMeta,
}: {
  name: string;
  value: number;
  meta: SliderMeta;
  onChange: (source: string) => void;
  onMeta: (meta: SliderMeta) => void;
}): JSX.Element {
  const [advanced, setAdvanced] = useState(false);
  const numField = (label: string, key: 'min' | 'max' | 'step'): JSX.Element => (
    <label className="slider-field">
      {label}
      <input
        type="number"
        value={meta[key]}
        step={key === 'step' ? 0.01 : 1}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v) && (key !== 'step' || v > 0)) onMeta({ ...meta, [key]: v });
        }}
      />
    </label>
  );
  return (
    <div className="slider-block">
      <div className="slider-row">
        <button
          type="button"
          className="slider-play"
          title={meta.playing ? 'Pause' : 'Animate slider'}
          aria-label={meta.playing ? `Pause ${name}` : `Animate ${name}`}
          aria-pressed={meta.playing === true}
          onClick={() => onMeta({ ...meta, playing: !meta.playing })}
        >
          {meta.playing ? '⏸' : '▶'}
        </button>
        <input
          type="range"
          className="slider-range"
          min={meta.min}
          max={meta.max}
          step={meta.step}
          value={Number.isFinite(value) ? value : 0}
          onChange={(e) =>
            onChange(`${name} = ${formatSliderValue(Number(e.target.value), meta.step)}`)
          }
        />
      </div>
      <div className="slider-meta">
        {numField('min', 'min')}
        {numField('step', 'step')}
        {numField('max', 'max')}
        <button
          type="button"
          className="curve-toggle"
          title="Animation speed: drag nodes on the graph (0.25×–4×, linear or curved)"
          aria-expanded={advanced}
          onClick={() => setAdvanced((a) => !a)}
        >
          speed {advanced ? '▾' : '▸'}
        </button>
      </div>
      {advanced && <SpeedCurveEditor meta={meta} onMeta={onMeta} />}
    </div>
  );
}

export const ExpressionRow = memo(function ExpressionRow({
  entry,
  analysis,
  precision,
  casActions,
  onChange,
  onSliderMeta,
  onCreateSlider,
  onCas,
  onToggle,
  onDelete,
  onEnter,
  definedNames,
  definedFunctions,
}: RowProps): JSX.Element {
  const id = entry.id;
  const [menuOpen, setMenuOpen] = useState(false);

  /* ---- autocomplete (M9.1) ---- */
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [ac, setAc] = useState<CompletionResult | null>(null);
  const [acIndex, setAcIndex] = useState(0);
  // Caret to restore after an accepted completion re-renders the input.
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    inputRef.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [entry.source]);

  const refreshCompletions = (source: string, caret: number | null): void => {
    setAc(caret === null ? null : complete(source, caret, definedNames, definedFunctions));
    setAcIndex(0);
  };

  const accept = (index: number): void => {
    if (ac === null) return;
    const item = ac.items[index];
    if (!item) return;
    const applied = applyCompletion(entry.source, ac, item);
    pendingCaret.current = applied.caret;
    setAc(null);
    changeSource(applied.source);
    inputRef.current?.focus();
  };
  const plottable = analysis.kind === 'plot';
  const color = curveColorVar(entry.colorIndex);
  const diagnostic = analysis.kind === 'error' ? analysis.diagnostic : null;
  const sliderAction =
    diagnostic?.suggestion?.action === 'create-slider' ? diagnostic.suggestion : null;

  const changeSource = useMemo(() => (source: string) => onChange(id, source), [onChange, id]);

  return (
    <div className="expr-row" style={{ borderLeftColor: plottable ? color : 'transparent' }}>
      <div className="expr-main">
        <button
          type="button"
          className={`color-chip${entry.visible ? '' : ' color-chip-off'}`}
          style={plottable ? { background: entry.visible ? color : 'transparent', borderColor: color } : { visibility: 'hidden' }}
          title={entry.visible ? 'Hide' : 'Show'}
          aria-pressed={entry.visible}
          onClick={() => onToggle(id)}
        />
        <div className="ac-anchor">
          <input
            ref={inputRef}
            className="expr-input"
            value={entry.source}
            placeholder="y = f(x)"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              changeSource(e.target.value);
              refreshCompletions(e.target.value, e.target.selectionStart);
            }}
            onKeyDown={(e) => {
              if (ac !== null) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  const d = e.key === 'ArrowDown' ? 1 : -1;
                  setAcIndex((i) => (i + d + ac.items.length) % ac.items.length);
                  return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  accept(acIndex);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setAc(null);
                  return;
                }
              }
              if (e.key === 'Enter') onEnter();
            }}
            onBlur={() => setAc(null)}
            onClick={(e) => refreshCompletions(entry.source, e.currentTarget.selectionStart)}
          />
          {ac !== null && (
            <div className="ac-menu" role="listbox" aria-label="Completions">
              {ac.items.map((item, i) => (
                <button
                  key={item.name}
                  type="button"
                  role="option"
                  aria-selected={i === acIndex}
                  className={`ac-item${i === acIndex ? ' ac-item-active' : ''}`}
                  // mousedown so the input's blur (which closes the menu)
                  // doesn't fire before the click lands
                  onMouseDown={(e) => {
                    e.preventDefault();
                    accept(i);
                  }}
                  onMouseEnter={() => setAcIndex(i)}
                >
                  <span className="ac-label">{item.label}</span>
                  <span className="ac-kind">{item.kind}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {casActions.length > 0 && (
          <div className="cas-anchor">
            <button
              type="button"
              className="cas-button"
              title="CAS operations"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
            >
              ∂
            </button>
            {menuOpen && (
              <div className="cas-menu" role="menu">
                {casActions.map((action) => (
                  <button
                    key={action}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onCas(id, action);
                    }}
                  >
                    {CAS_LABELS[action]}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <button type="button" className="expr-delete" title="Delete" onClick={() => onDelete(id)}>
          ×
        </button>
      </div>
      {analysis.kind === 'definition' && (
        <SliderControls
          name={analysis.name}
          value={analysis.value}
          meta={entry.slider ?? DEFAULT_SLIDER}
          onChange={changeSource}
          onMeta={(meta) => onSliderMeta(id, meta)}
        />
      )}
      <MathPreview analysis={analysis} precision={precision} />
      {entry.note && <div className="expr-note">{entry.note}</div>}
      {analysis.kind === 'unsupported' && (
        <div className="expr-note">{analysis.reason}</div>
      )}
      {diagnostic && entry.source.trim() !== '' && (
        <div className="expr-error">
          <span>{diagnostic.message}</span>
          {diagnostic.suggestion?.edit && (
            <button
              type="button"
              className="fix-button"
              onClick={() => changeSource(applyEdit(entry.source, diagnostic.suggestion!.edit!))}
            >
              {diagnostic.suggestion.label}
            </button>
          )}
          {sliderAction && (
            <button
              type="button"
              className="fix-button"
              onClick={() => onCreateSlider(id, sliderAction.name!)}
            >
              {sliderAction.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
});
