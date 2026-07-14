// Undo/redo over the document command layer (M7.2).
//
// Because applyCommand is pure and documents are immutable, history is just a
// past/present/future of whole-document snapshots — no per-command inverse
// needed. Undo pops `past` into `present` (pushing the old present onto
// `future`); redo does the reverse.
//
// Two behaviours the milestone calls out:
//   * Only content edits enter history (isUndoable). Settings (angle mode,
//     precision), transient CAS notes, and folder collapse never create an
//     undo step — Ctrl+Z shouldn't toggle your display precision.
//   * A slider/point drag or a burst of typing in one row COALESCES into a
//     single undo step. Consecutive commands that share a coalesce key extend
//     the current step instead of stacking new ones, so one Ctrl+Z undoes the
//     whole gesture rather than 200 intermediate frames.
//
// The pure functions here (dispatch/undo/redo) are unit-tested; useHistory
// just binds them to React state.

import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { applyCommand, isUndoable, type Command, type GcalcDocument } from './document.ts';

export interface History {
  past: GcalcDocument[];
  present: GcalcDocument;
  future: GcalcDocument[];
  /** Coalesce key of the step currently on top of `past`, or null. */
  lastKey: string | null;
}

/** Cap on retained undo depth (bounds memory; snapshots share structure). */
const LIMIT = 200;

export function initHistory(present: GcalcDocument): History {
  return { past: [], present, future: [], lastKey: null };
}

export const canUndo = (h: History): boolean => h.past.length > 0;
export const canRedo = (h: History): boolean => h.future.length > 0;

/**
 * A command's coalesce key: repeated edits to the *same row* (slider drag,
 * typing burst) share one, so they fold into a single undo step. Everything
 * else returns null → always its own step.
 */
function coalesceKey(cmd: Command): string | null {
  if (cmd.type === 'edit') return `edit:${cmd.id}`;
  if (cmd.type === 'renameFolder') return `rename:${cmd.id}`; // typing a name = one step
  if (cmd.type === 'setSlider') return `slider:${cmd.id}`; // curve-node drag = one step
  return null;
}

/** Apply a command, recording history when it's an undoable content edit. */
export function dispatch(h: History, cmd: Command): History {
  const next = applyCommand(h.present, cmd);
  if (next === h.present) return h; // no-op (e.g. setPrecision to current value)

  // Settings / notes / folder-collapse: change the document, leave history be.
  if (!isUndoable(cmd)) {
    return { ...h, present: next };
  }

  const key = coalesceKey(cmd);
  if (key !== null && key === h.lastKey) {
    // Extend the current step: keep the same undo checkpoint, just move present.
    return { past: h.past, present: next, future: [], lastKey: key };
  }

  // New undo step: the old present becomes a checkpoint; redo is invalidated.
  const past = [...h.past, h.present];
  if (past.length > LIMIT) past.shift();
  return { past, present: next, future: [], lastKey: key };
}

export function undo(h: History): History {
  if (h.past.length === 0) return h;
  const present = h.past[h.past.length - 1];
  return {
    past: h.past.slice(0, -1),
    present,
    future: [h.present, ...h.future],
    lastKey: null, // the next edit starts a fresh step, never coalescing across an undo
  };
}

export function redo(h: History): History {
  if (h.future.length === 0) return h;
  const [present, ...future] = h.future;
  return { past: [...h.past, h.present], present, future, lastKey: null };
}

/* ------------------------------------------------------------------ */
/* React binding                                                       */
/* ------------------------------------------------------------------ */

export interface DocumentHistory {
  doc: GcalcDocument;
  dispatch: (cmd: Command) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /**
   * Bypass history entirely — sets the document directly. Only for automated,
   * non-user mutations that must never enter undo (the perf-mode slider
   * animation).
   */
  setDocDirect: Dispatch<SetStateAction<GcalcDocument>>;
}

export function useDocumentHistory(initial: GcalcDocument): DocumentHistory {
  const [history, setHistory] = useState<History>(() => initHistory(initial));

  const dispatchCmd = useCallback((cmd: Command): void => {
    setHistory((h) => dispatch(h, cmd));
  }, []);

  const undoCb = useCallback((): void => setHistory(undo), []);
  const redoCb = useCallback((): void => setHistory(redo), []);

  const setDocDirect = useCallback<Dispatch<SetStateAction<GcalcDocument>>>((action) => {
    setHistory((h) => {
      const present =
        typeof action === 'function'
          ? (action as (d: GcalcDocument) => GcalcDocument)(h.present)
          : action;
      return present === h.present ? h : { ...h, present };
    });
  }, []);

  return useMemo(
    () => ({
      doc: history.present,
      dispatch: dispatchCmd,
      undo: undoCb,
      redo: redoCb,
      canUndo: canUndo(history),
      canRedo: canRedo(history),
      setDocDirect,
    }),
    [history, dispatchCmd, undoCb, redoCb, setDocDirect],
  );
}
