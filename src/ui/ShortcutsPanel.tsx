// Keyboard shortcuts reference (M9.3). Rendered straight from the BINDINGS
// table in shortcuts.ts — the panel and the handler share one source of
// truth. Modal; closes on Esc (App handles), backdrop click, or the × button.

import { BINDINGS } from './shortcuts.ts';

export function ShortcutsPanel({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <div className="shortcuts-backdrop" onClick={onClose}>
      <div
        className="shortcuts-panel"
        role="dialog"
        aria-label="Keyboard shortcuts"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shortcuts-head">
          <h2>Keyboard shortcuts</h2>
          <button type="button" title="Close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <dl className="shortcuts-list">
          {BINDINGS.map((b) => (
            <div key={b.action} className="shortcuts-row">
              <dt>
                <kbd>{b.display}</kbd>
              </dt>
              <dd>{b.description}</dd>
            </div>
          ))}
        </dl>
        <p className="shortcuts-note">Ctrl works as Cmd on macOS. Esc closes this panel.</p>
      </div>
    </div>
  );
}
