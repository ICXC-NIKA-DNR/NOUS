// One sidebar row: text input, live KaTeX preview, per-curve color chip that
// doubles as the visibility toggle, delete button, and structured error
// display with one-click fixes from the core's Suggestion machinery.

import katex from 'katex';
import { useMemo } from 'react';
import type { Analysis } from './analyze.ts';
import { applyEdit, formatValue } from './analyze.ts';
import { toTex } from './tex.ts';

export interface ExpressionEntry {
  id: number;
  source: string;
  colorIndex: number;
  visible: boolean;
}

const CURVE_COLORS = 6; // --curve-1 … --curve-6 in styles.css

export function curveColorVar(colorIndex: number): string {
  return `var(--curve-${(colorIndex % CURVE_COLORS) + 1})`;
}

interface RowProps {
  entry: ExpressionEntry;
  analysis: Analysis;
  onChange: (source: string) => void;
  onToggle: () => void;
  onDelete: () => void;
  onEnter: () => void;
}

function MathPreview({ analysis }: { analysis: Analysis }): JSX.Element | null {
  const html = useMemo(() => {
    if (analysis.kind === 'empty' || analysis.kind === 'error') return null;
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

export function ExpressionRow({
  entry,
  analysis,
  onChange,
  onToggle,
  onDelete,
  onEnter,
}: RowProps): JSX.Element {
  const plottable = analysis.kind === 'plot';
  const color = curveColorVar(entry.colorIndex);
  const diagnostic = analysis.kind === 'error' ? analysis.diagnostic : null;

  return (
    <div className="expr-row" style={{ borderLeftColor: plottable ? color : 'transparent' }}>
      <div className="expr-main">
        <button
          type="button"
          className={`color-chip${entry.visible ? '' : ' color-chip-off'}`}
          style={plottable ? { background: entry.visible ? color : 'transparent', borderColor: color } : { visibility: 'hidden' }}
          title={entry.visible ? 'Hide' : 'Show'}
          aria-pressed={entry.visible}
          onClick={onToggle}
        />
        <input
          className="expr-input"
          value={entry.source}
          placeholder="y = f(x)"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onEnter();
          }}
        />
        <button type="button" className="expr-delete" title="Delete" onClick={onDelete}>
          ×
        </button>
      </div>
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
              onClick={() => onChange(applyEdit(entry.source, diagnostic.suggestion!.edit!))}
            >
              {diagnostic.suggestion.label}
            </button>
          )}
          {diagnostic.suggestion && !diagnostic.suggestion.edit && (
            <span className="expr-note">{diagnostic.suggestion.label}</span>
          )}
        </div>
      )}
    </div>
  );
}
