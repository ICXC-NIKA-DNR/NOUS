// The "File" menu (M11): Save / Open / Copy share code / Paste share code,
// collapsed from their own row into one dropdown in the header controls,
// left of the ⌨ shortcuts button. This component is presentation only —
// all behavior lives in ui/docMenu.ts (node:test-able); serialization stays
// in state/serialize.ts and document creation in the workspace's
// openDocument. Status messages go to App's floating toast via `flash`,
// which outlives the menu.
//
// Deliberately independent of the CAS menu in ExpressionRow.tsx (M11
// decision): same visual vocabulary, zero shared code — a change to either
// menu must have no effect on the other. Unlike the CAS menu, this one
// closes on outside click and Escape (added locally, on purpose).

import { useEffect, useRef, useState } from 'react';
import { DocMenuController, INITIAL_DOC_MENU, type DocMenuState } from './docMenu.ts';

interface Props {
  /** Build the share code for the active document. */
  makeShareCode: () => string;
  /** Decode + open a pasted share code as a new tab. Throws NousFormatError. */
  openShareCode: (code: string) => void;
  /** Save the active document via the platform layer. Resolves to the saved
   * file name, or null when cancelled. */
  saveFile: () => Promise<string | null>;
  /** Open a .nous file as a new tab. Null when cancelled; throws
   * NousFormatError on malformed content. */
  openFile: () => Promise<string | null>;
  /** Show a floating toast (App owns it; independent of menu state). */
  flash: (text: string, error?: boolean) => void;
}

export function DocActions(props: Props): JSX.Element {
  const [state, setState] = useState<DocMenuState>(INITIAL_DOC_MENU);
  const propsRef = useRef(props);
  propsRef.current = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pasteRef = useRef<HTMLTextAreaElement>(null);

  const ctrlRef = useRef<DocMenuController | null>(null);
  if (ctrlRef.current === null) {
    ctrlRef.current = new DocMenuController(
      () => ({
        ...propsRef.current,
        writeClipboard: (text) => navigator.clipboard.writeText(text),
      }),
      setState,
    );
  }
  const ctrl = ctrlRef.current;

  // Close on outside click / Escape while open. Escape returns focus to the
  // trigger; both routes go through closeMenu(), which resets the paste
  // panel (closing is the cancel).
  useEffect(() => {
    if (!state.menuOpen) return;
    const onPointerDown = (e: PointerEvent): void => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) {
        ctrl.closeMenu();
      }
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        ctrl.closeMenu();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [state.menuOpen, ctrl]);

  // Focus + select the textarea when the paste panel opens — for the
  // clipboard-blocked Copy fallback this is the code, ready to hand-copy.
  useEffect(() => {
    if (!state.pasteOpen) return;
    pasteRef.current?.focus();
    pasteRef.current?.select();
  }, [state.pasteOpen]);

  return (
    <div className="file-menu" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="file-menu-button"
        title="Save, open, and share this graph"
        aria-haspopup="menu"
        aria-expanded={state.menuOpen}
        onClick={() => ctrl.toggleMenu()}
      >
        File
      </button>
      {state.menuOpen && (
        <div className="file-menu-panel" role="menu" aria-label="File and share">
          <button
            type="button"
            role="menuitem"
            title="Save this graph as a .nous file"
            onClick={() => void ctrl.save()}
          >
            Save
          </button>
          <button
            type="button"
            role="menuitem"
            title="Open a .nous file"
            onClick={() => void ctrl.open()}
          >
            Open
          </button>
          <button
            type="button"
            role="menuitem"
            title="Copy a share code for this graph"
            onClick={() => void ctrl.copy()}
          >
            Copy share code
          </button>
          <button
            type="button"
            role="menuitem"
            title="Open a graph from a pasted share code"
            aria-expanded={state.pasteOpen}
            onClick={() => ctrl.togglePaste()}
          >
            Paste share code
          </button>
          {state.pasteOpen && (
            <div className="file-menu-paste">
              <textarea
                ref={pasteRef}
                className="share-input"
                rows={3}
                placeholder="Paste a share code…"
                aria-label="Share code"
                value={state.pasteText}
                onChange={(e) => ctrl.setPasteText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    ctrl.submitPaste();
                  }
                }}
              />
              <div className="file-menu-paste-actions">
                <button
                  type="button"
                  disabled={state.pasteText.trim() === ''}
                  onClick={() => ctrl.submitPaste()}
                >
                  Open graph
                </button>
                <button type="button" onClick={() => ctrl.cancelPaste()}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
