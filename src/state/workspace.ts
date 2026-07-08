// Multiple document tabs (M7). A Workspace is a list of tabs, each owning a
// fully independent editing session: its own undo/redo History (and therefore
// its own GcalcDocument) plus its own saved graph viewport. Switching tabs
// switches everything; nothing leaks between them.
//
// Pure helpers first (unit-tested), then the thin useWorkspace hook that
// binds them to React state and exposes the same surface App used for a
// single document — dispatch/undo/redo simply target the active tab.

import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { Viewport } from '../plot/viewport.ts';
import { emptyDocument, makeExpression, type Command, type GcalcDocument } from './document.ts';
import {
  canRedo,
  canUndo,
  dispatch as historyDispatch,
  initHistory,
  redo as historyRedo,
  undo as historyUndo,
  type History,
} from './history.ts';

export interface Tab {
  id: number;
  name: string;
  history: History;
  /** Last known graph viewport; null until the canvas first reports one. */
  viewport: Viewport | null;
}

export interface Workspace {
  tabs: Tab[];
  /** Active tab id (not index — stable across closes/reorders). */
  activeId: number;
}

let nextTabId = 1;

/** Mint a tab. Call from event handlers/module scope only (StrictMode). */
export function makeTab(doc: GcalcDocument, name?: string): Tab {
  const id = nextTabId++;
  return { id, name: name ?? `Graph ${id}`, history: initHistory(doc), viewport: null };
}

export function initWorkspace(firstDoc: GcalcDocument): Workspace {
  const tab = makeTab(firstDoc);
  return { tabs: [tab], activeId: tab.id };
}

export function activeTab(ws: Workspace): Tab {
  // The invariant (workspace always has ≥1 tab, activeId always valid) is
  // maintained by every helper below; fall back defensively to the first tab.
  return ws.tabs.find((t) => t.id === ws.activeId) ?? ws.tabs[0];
}

/** Replace the active tab's history through `update` (dispatch/undo/redo). */
function withActiveHistory(ws: Workspace, update: (h: History) => History): Workspace {
  const tab = activeTab(ws);
  const history = update(tab.history);
  if (history === tab.history) return ws;
  return {
    ...ws,
    tabs: ws.tabs.map((t) => (t.id === tab.id ? { ...t, history } : t)),
  };
}

export function dispatchInActive(ws: Workspace, cmd: Command): Workspace {
  return withActiveHistory(ws, (h) => historyDispatch(h, cmd));
}

export function undoInActive(ws: Workspace): Workspace {
  return withActiveHistory(ws, historyUndo);
}

export function redoInActive(ws: Workspace): Workspace {
  return withActiveHistory(ws, historyRedo);
}

export function selectTab(ws: Workspace, id: number): Workspace {
  if (ws.activeId === id || !ws.tabs.some((t) => t.id === id)) return ws;
  return { ...ws, activeId: id };
}

export function addTab(ws: Workspace, tab: Tab): Workspace {
  return { tabs: [...ws.tabs, tab], activeId: tab.id };
}

/** Close a tab. The last tab never closes; closing the active tab activates
 * its right neighbour (or the new last tab). */
export function closeTab(ws: Workspace, id: number): Workspace {
  if (ws.tabs.length <= 1) return ws;
  const idx = ws.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return ws;
  const tabs = ws.tabs.filter((t) => t.id !== id);
  const activeId =
    ws.activeId === id ? tabs[Math.min(idx, tabs.length - 1)].id : ws.activeId;
  return { tabs, activeId };
}

export function setTabViewport(ws: Workspace, id: number, viewport: Viewport): Workspace {
  const tab = ws.tabs.find((t) => t.id === id);
  if (!tab || tab.viewport === viewport) return ws;
  return { ...ws, tabs: ws.tabs.map((t) => (t.id === id ? { ...t, viewport } : t)) };
}

/* ------------------------------------------------------------------ */
/* React binding                                                       */
/* ------------------------------------------------------------------ */

export interface WorkspaceApi {
  tabs: ReadonlyArray<Pick<Tab, 'id' | 'name'>>;
  activeTabId: number;
  /** The active tab's document + viewport — what the rest of App renders. */
  doc: GcalcDocument;
  savedViewport: Viewport | null;
  canUndo: boolean;
  canRedo: boolean;
  dispatch: (cmd: Command) => void;
  undo: () => void;
  redo: () => void;
  newTab: () => void;
  /** Open a loaded document (share code / file) as a new active tab. */
  openDocument: (doc: GcalcDocument, name?: string, viewport?: Viewport | null) => void;
  close: (id: number) => void;
  select: (id: number) => void;
  reportViewport: (viewport: Viewport) => void;
  /** History-bypassing setter for the active document (perf animation). */
  setDocDirect: Dispatch<SetStateAction<GcalcDocument>>;
}

export function useWorkspace(firstTab: Tab): WorkspaceApi {
  // The initial tab is minted at module scope by the caller — a useState
  // initializer re-runs under StrictMode and would burn tab ids/names.
  const [ws, setWs] = useState<Workspace>({ tabs: [firstTab], activeId: firstTab.id });

  const dispatchCmd = useCallback(
    (cmd: Command): void => setWs((w) => dispatchInActive(w, cmd)),
    [],
  );
  const undoCb = useCallback((): void => setWs(undoInActive), []);
  const redoCb = useCallback((): void => setWs(redoInActive), []);
  const select = useCallback((id: number): void => setWs((w) => selectTab(w, id)), []);
  const close = useCallback((id: number): void => setWs((w) => closeTab(w, id)), []);

  const newTab = useCallback((): void => {
    // Minted here (event handler), never inside the state updater.
    const tab = makeTab(emptyDocument([makeExpression()]));
    setWs((w) => addTab(w, tab));
  }, []);

  const openDocument = useCallback(
    (doc: GcalcDocument, name?: string, viewport?: Viewport | null): void => {
      const tab = makeTab(doc, name);
      if (viewport) tab.viewport = viewport;
      setWs((w) => addTab(w, tab));
    },
    [],
  );

  const reportViewport = useCallback((viewport: Viewport): void => {
    setWs((w) => setTabViewport(w, w.activeId, viewport));
  }, []);

  const setDocDirect = useCallback<Dispatch<SetStateAction<GcalcDocument>>>((action) => {
    setWs((w) =>
      withActiveHistory(w, (h) => {
        const present =
          typeof action === 'function'
            ? (action as (d: GcalcDocument) => GcalcDocument)(h.present)
            : action;
        return present === h.present ? h : { ...h, present };
      }),
    );
  }, []);

  return useMemo(() => {
    const tab = activeTab(ws);
    return {
      tabs: ws.tabs.map((t) => ({ id: t.id, name: t.name })),
      activeTabId: tab.id,
      doc: tab.history.present,
      savedViewport: tab.viewport,
      canUndo: canUndo(tab.history),
      canRedo: canRedo(tab.history),
      dispatch: dispatchCmd,
      undo: undoCb,
      redo: redoCb,
      newTab,
      openDocument,
      close,
      select,
      reportViewport,
      setDocDirect,
    };
  }, [ws, dispatchCmd, undoCb, redoCb, newTab, openDocument, close, select, reportViewport, setDocDirect]);
}
