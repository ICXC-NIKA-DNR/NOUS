// Document persistence actions (M8): share-code copy/import now, native
// save/open joins in M8.2. Lives as its own row under the tab bar so the
// header controls row doesn't crowd on narrow windows.
//
// This component owns only presentation state (the paste panel, the transient
// status note); all serialization goes through state/serialize.ts and all
// document creation through the workspace's openDocument.

import { useCallback, useEffect, useRef, useState } from 'react';
import { NousFormatError } from '../state/serialize.ts';

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
}

export function DocActions({ makeShareCode, openShareCode, saveFile, openFile }: Props): JSX.Element {
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((text: string, error = false): void => {
    setNote({ text, error });
    if (noteTimer.current !== null) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(null), error ? 6000 : 3000);
  }, []);

  useEffect(
    () => () => {
      if (noteTimer.current !== null) clearTimeout(noteTimer.current);
    },
    [],
  );

  const onCopy = useCallback((): void => {
    const code = makeShareCode();
    navigator.clipboard.writeText(code).then(
      () => flash('Share code copied to clipboard'),
      () => {
        // Clipboard blocked (permissions/insecure context): surface the code
        // in the paste panel so it can be copied by hand.
        setPasteText(code);
        setPasteOpen(true);
        flash('Clipboard unavailable — copy the code below', true);
      },
    );
  }, [makeShareCode, flash]);

  const onImport = useCallback((): void => {
    try {
      openShareCode(pasteText);
      setPasteText('');
      setPasteOpen(false);
      flash('Graph opened in a new tab');
    } catch (err) {
      if (err instanceof NousFormatError) return flash(err.message, true);
      throw err;
    }
  }, [openShareCode, pasteText, flash]);

  const onSave = useCallback((): void => {
    saveFile().then(
      (name) => {
        if (name !== null) flash(`Saved ${name}`);
      },
      (err) => flash(err instanceof Error ? err.message : String(err), true),
    );
  }, [saveFile, flash]);

  const onOpen = useCallback((): void => {
    openFile().then(
      (name) => {
        if (name !== null) flash(`Opened ${name}`);
      },
      (err) => {
        if (err instanceof NousFormatError) return flash(err.message, true);
        flash(err instanceof Error ? err.message : String(err), true);
      },
    );
  }, [openFile, flash]);

  return (
    <div className="doc-actions">
      <div className="doc-actions-row" role="group" aria-label="File and share">
        <button type="button" title="Save this graph as a .nous file" onClick={onSave}>
          Save
        </button>
        <button type="button" title="Open a .nous file" onClick={onOpen}>
          Open
        </button>
        <button type="button" title="Copy a share code for this graph" onClick={onCopy}>
          Copy share code
        </button>
        <button
          type="button"
          title="Open a graph from a pasted share code"
          aria-expanded={pasteOpen}
          onClick={() => setPasteOpen((open) => !open)}
        >
          Paste share code
        </button>
        {note && (
          <span className={`doc-actions-note${note.error ? ' doc-actions-error' : ''}`} role="status">
            {note.text}
          </span>
        )}
      </div>
      {pasteOpen && (
        <div className="doc-actions-paste">
          <textarea
            className="share-input"
            rows={3}
            placeholder="Paste a share code…"
            aria-label="Share code"
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onImport();
              }
            }}
          />
          <button type="button" disabled={pasteText.trim() === ''} onClick={onImport}>
            Open graph
          </button>
        </div>
      )}
    </div>
  );
}
