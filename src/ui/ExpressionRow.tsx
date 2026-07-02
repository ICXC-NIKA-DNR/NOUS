// One sidebar row: text input, live KaTeX preview, per-curve color chip that
// doubles as the visibility toggle, delete button, and structured error
// display with one-click fixes from the core's Suggestion machinery.
// Definition rows (`a = 1`) render a slider with editable min/max/step.

import katex from 'katex';
import { memo, useMemo } from 'react';
import type { Analysis } from './analyze.ts';
import { applyEdit, formatValue } from './analyze.ts';
import { toTex } from './tex.ts';

export interface SliderMeta {
  min: number;
  max: number;
  step: number;
}

export interface ExpressionEntry {
  id: number;
  source: string;
  colorIndex: number;
  visible: boolean;
  /** Present on definition rows; created with defaults by the slider action. */
  slider?: SliderMeta;
}

export const DEFAULT_SLIDER: SliderMeta = { min: -10, max: 10, step: 0.1 };

const CURVE_COLORS = 6; // --curve-1 … --curve-6 in styles.css

export function curveColorVar(colorIndex: number): string {
  return `var(--curve-${(colorIndex % CURVE_COLORS) + 1})`;
}

/** Format a slider value with just enough decimals for its step. */
function formatSliderValue(value: number, step: number): string {
  const decimals = Math.max(0, Math.min(10, -Math.floor(Math.log10(step) + 1e-9)));
  const s = value.toFixed(decimals);
  return s === '-0' ? '0' : s;
}

// All callbacks are id-first and referentially stable in App, so memo() can
// skip the 50+ untouched rows when one slider drags (the M3 perf gate).
interface RowProps {
  entry: ExpressionEntry;
  analysis: Analysis;
  onChange: (id: number, source: string) => void;
  onSliderMeta: (id: number, meta: SliderMeta) => void;
  onCreateSlider: (id: number, name: string) => void;
  onToggle: (id: number) => void;
  onDelete: (id: number) => void;
  onEnter: () => void;
}

function MathPreview({ analysis }: { analysis: Analysis }): JSX.Element | null {
  const html = useMemo(() => {
    if (analysis.kind !== 'plot' && analysis.kind !== 'value' && analysis.kind !== 'unsupported') {
      return null;
    }
    const tex =
      analysis.kind === 'value'
        ? `${toTex(analysis.ast)} = ${formatValue(analysis.value)}`
        : toTex(analysis.ast);
    return katex.renderToString(tex, { throwOnError: false, output: 'html' });
  }, [analysis]);

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
  const numField = (label: string, key: keyof SliderMeta): JSX.Element => (
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
      <div className="slider-meta">
        {numField('min', 'min')}
        {numField('step', 'step')}
        {numField('max', 'max')}
      </div>
    </div>
  );
}

export const ExpressionRow = memo(function ExpressionRow({
  entry,
  analysis,
  onChange,
  onSliderMeta,
  onCreateSlider,
  onToggle,
  onDelete,
  onEnter,
}: RowProps): JSX.Element {
  const id = entry.id;
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
        <input
          className="expr-input"
          value={entry.source}
          placeholder="y = f(x)"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => changeSource(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onEnter();
          }}
        />
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
      <MathPreview analysis={analysis} />
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
