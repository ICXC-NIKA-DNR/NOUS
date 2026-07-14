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
import { clampSpeed, formatSliderValue, SPEED_MAX, SPEED_MIN } from '../state/sliderAnim.ts';
import { toTex } from './tex.ts';

export interface SliderMeta {
  min: number;
  max: number;
  step: number;
  /** ▶ animation running (Slider-Anim-M1). Persists like the rest of the meta. */
  playing?: boolean;
  /** Flat speed multiplier (SPEED_MIN–SPEED_MAX); 1× = BASE_CYCLE_MS per sweep. */
  speed?: number;
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
        <label className="slider-field" title="Animation speed multiplier (0.25×–4×)">
          speed
          <input
            type="number"
            value={meta.speed ?? 1}
            min={SPEED_MIN}
            max={SPEED_MAX}
            step={0.25}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) onMeta({ ...meta, speed: clampSpeed(v) });
            }}
          />
        </label>
      </div>
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
