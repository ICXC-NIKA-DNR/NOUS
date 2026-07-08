// The document model + command layer (M7.1).
//
// A GcalcDocument is the single serializable unit of "a graph you're working
// on" — its expression/folder tree plus per-document settings. Every mutation
// in the app goes through `applyCommand(doc, cmd)`, a pure reducer: this one
// choke point is what makes undo/redo (M7.2) a matter of snapshotting rather
// than threading history through dozens of call sites.
//
// The tree supports arbitrary folder nesting from the start (folders hold
// expressions and other folders, any depth) so the folder UI in M7.3 slots in
// without reshaping state. Session-only for now — but the shape is a plain,
// JSON-serializable object so file persistence (M8) and a document library
// drop in later without restructuring.

import type { AngleMode } from '../core/evaluator.ts';
import type { ExpressionEntry, SliderMeta } from '../ui/ExpressionRow.tsx';

/** A plottable expression row. Extends the row-render shape with a tag so it
 * can share a tree with folders. */
export interface ExpressionItem extends ExpressionEntry {
  kind: 'expression';
}

/** A named container. `collapsed` is a UI-only editing convenience (not part
 * of undo); `visible` cascades to every descendant when off (undoable). */
export interface FolderItem {
  kind: 'folder';
  id: number;
  name: string;
  collapsed: boolean;
  visible: boolean;
  children: Item[];
}

export type Item = ExpressionItem | FolderItem;

export interface GcalcDocument {
  items: Item[];
  angleMode: AngleMode;
  precision: number;
}

/* ------------------------------------------------------------------ */
/* Item factories — the only place ids/colours are minted             */
/* ------------------------------------------------------------------ */

let nextId = 1;
let nextColor = 0;

/** Mint a fresh session-local item id. Ids are never serialized (M8): opened
 * documents remint every id through here, so they can't collide with items
 * already alive in other tabs. */
export function mintId(): number {
  return nextId++;
}

/** Mint an expression item. Call only from event handlers or module scope —
 * never inside a React state initializer/updater, which re-runs under
 * StrictMode and would skip ids/colours. */
export function makeExpression(source = '', slider?: SliderMeta): ExpressionItem {
  return { kind: 'expression', id: mintId(), source, colorIndex: nextColor++, visible: true, slider };
}

export function makeFolder(name = 'Folder', children: Item[] = []): FolderItem {
  return { kind: 'folder', id: mintId(), name, collapsed: false, visible: true, children };
}

export function emptyDocument(items: Item[]): GcalcDocument {
  return { items, angleMode: 'radians', precision: 6 };
}

/* ------------------------------------------------------------------ */
/* Tree helpers (nesting-aware, all pure)                              */
/* ------------------------------------------------------------------ */

/** Rebuild the tree, replacing the item with `id` via `update`. Folders are
 * recursed into. Untouched branches keep their identity (cheap re-renders). */
function updateItem(items: Item[], id: number, update: (item: Item) => Item): Item[] {
  let changed = false;
  const next = items.map((item) => {
    if (item.id === id) {
      changed = true;
      return update(item);
    }
    if (item.kind === 'folder') {
      const children = updateItem(item.children, id, update);
      if (children !== item.children) {
        changed = true;
        return { ...item, children };
      }
    }
    return item;
  });
  return changed ? next : items;
}

/** Remove the item with `id` from anywhere in the tree. */
function removeItem(items: Item[], id: number): Item[] {
  let changed = false;
  const next: Item[] = [];
  for (const item of items) {
    if (item.id === id) {
      changed = true;
      continue;
    }
    if (item.kind === 'folder') {
      const children = removeItem(item.children, id);
      if (children !== item.children) {
        changed = true;
        next.push({ ...item, children });
        continue;
      }
    }
    next.push(item);
  }
  return changed ? next : items;
}

/** Insert `newItems` immediately after the item with `afterId` (nesting-aware);
 * appends to root when `afterId` isn't found. */
function insertAfter(items: Item[], afterId: number, newItems: Item[]): Item[] {
  let inserted = false;
  const walk = (list: Item[]): Item[] => {
    const out: Item[] = [];
    for (const item of list) {
      out.push(item);
      if (item.id === afterId) {
        out.push(...newItems);
        inserted = true;
      } else if (item.kind === 'folder') {
        const children = walk(item.children);
        if (children !== item.children) out[out.length - 1] = { ...item, children };
      }
    }
    return out;
  };
  const next = walk(items);
  return inserted ? next : [...items, ...newItems];
}

/**
 * Insert `item` into `targetFolderId`'s children (root when null), immediately
 * before the child whose id is `beforeId` — or at the end when `beforeId` is
 * null or not present. Referencing a sibling rather than a raw index keeps
 * drag-and-drop free of remove-then-insert index arithmetic.
 */
function insertBefore(
  items: Item[],
  targetFolderId: number | null,
  beforeId: number | null,
  item: Item,
): Item[] {
  const place = (list: Item[]): Item[] => {
    const idx = beforeId === null ? -1 : list.findIndex((it) => it.id === beforeId);
    return idx === -1 ? [...list, item] : [...list.slice(0, idx), item, ...list.slice(idx)];
  };
  if (targetFolderId === null) return place(items);
  return items.map((it) => {
    if (it.kind === 'folder' && it.id === targetFolderId) return { ...it, children: place(it.children) };
    if (it.kind === 'folder') {
      const children = insertBefore(it.children, targetFolderId, beforeId, item);
      if (children !== it.children) return { ...it, children };
    }
    return it;
  });
}

/** Is `id` inside `folder`'s subtree (so moving the folder there would detach
 * it from itself)? */
function isDescendant(folder: FolderItem, id: number | null): boolean {
  if (id === null) return false;
  for (const child of folder.children) {
    if (child.id === id) return true;
    if (child.kind === 'folder' && isDescendant(child, id)) return true;
  }
  return false;
}

/** Find an item by id anywhere in the tree. */
export function findItem(items: Item[], id: number): Item | null {
  for (const item of items) {
    if (item.id === id) return item;
    if (item.kind === 'folder') {
      const found = findItem(item.children, id);
      if (found) return found;
    }
  }
  return null;
}

/** Where an item sits: its parent folder id (null = root) and the id of the
 * following sibling (null = last). Lets drag-and-drop express "drop after X"
 * as a move before X's next sibling without any index math. */
export function locate(
  items: Item[],
  id: number,
): { parentId: number | null; nextSiblingId: number | null } | null {
  const scan = (list: Item[], parentId: number | null): ReturnType<typeof locate> => {
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) {
        return { parentId, nextSiblingId: i + 1 < list.length ? list[i + 1].id : null };
      }
      const item = list[i];
      if (item.kind === 'folder') {
        const found = scan(item.children, item.id);
        if (found) return found;
      }
    }
    return null;
  };
  return scan(items, null);
}

/** Depth-first expression list with effective visibility (own toggle AND
 * every ancestor folder visible). Definitions/sliders stay in scope
 * regardless of visibility — only plotting honours `effectiveVisible`. */
export function flattenExpressions(
  doc: GcalcDocument,
): Array<{ item: ExpressionItem; effectiveVisible: boolean }> {
  const out: Array<{ item: ExpressionItem; effectiveVisible: boolean }> = [];
  const walk = (items: Item[], ancestorsVisible: boolean): void => {
    for (const item of items) {
      if (item.kind === 'expression') {
        out.push({ item, effectiveVisible: ancestorsVisible && item.visible });
      } else {
        walk(item.children, ancestorsVisible && item.visible);
      }
    }
  };
  walk(doc.items, true);
  return out;
}

/* ------------------------------------------------------------------ */
/* Commands + reducer                                                  */
/* ------------------------------------------------------------------ */

export type Command =
  // expression edits
  | { type: 'edit'; id: number; source: string }
  | { type: 'setSlider'; id: number; slider: SliderMeta }
  | { type: 'toggleVisible'; id: number }
  | { type: 'setNote'; id: number; note: string | undefined }
  | { type: 'add'; item: ExpressionItem }
  | { type: 'insertAfter'; afterId: number; items: Item[] }
  | { type: 'delete'; id: number; fallback: ExpressionItem }
  // folders
  | { type: 'addFolder'; folder: FolderItem }
  | { type: 'renameFolder'; id: number; name: string }
  | { type: 'toggleFolderCollapsed'; id: number }
  | { type: 'toggleFolderVisible'; id: number }
  // drag-and-drop reparent/reorder: move `id` into `targetFolderId` (root when
  // null), before sibling `beforeId` (append when null).
  | { type: 'move'; id: number; targetFolderId: number | null; beforeId: number | null }
  // document settings
  | { type: 'setAngleMode'; angleMode: AngleMode }
  | { type: 'setPrecision'; precision: number };

/** The single mutation choke point. Pure: (document, command) → document. */
export function applyCommand(doc: GcalcDocument, cmd: Command): GcalcDocument {
  switch (cmd.type) {
    case 'edit':
      return withItems(
        doc,
        updateItem(doc.items, cmd.id, (it) =>
          it.kind === 'expression' ? { ...it, source: cmd.source, note: undefined } : it,
        ),
      );

    case 'setSlider':
      return withItems(
        doc,
        updateItem(doc.items, cmd.id, (it) =>
          it.kind === 'expression' ? { ...it, slider: cmd.slider } : it,
        ),
      );

    case 'toggleVisible':
      return withItems(
        doc,
        updateItem(doc.items, cmd.id, (it) =>
          it.kind === 'expression' ? { ...it, visible: !it.visible } : it,
        ),
      );

    case 'setNote':
      return withItems(
        doc,
        updateItem(doc.items, cmd.id, (it) =>
          it.kind === 'expression' ? { ...it, note: cmd.note } : it,
        ),
      );

    case 'add':
      return withItems(doc, [...doc.items, cmd.item]);

    case 'insertAfter':
      return withItems(doc, insertAfter(doc.items, cmd.afterId, cmd.items));

    case 'delete': {
      const items = removeItem(doc.items, cmd.id);
      // Never leave the document with nothing to type into.
      return withItems(doc, items.length === 0 ? [cmd.fallback] : items);
    }

    case 'addFolder':
      return withItems(doc, [...doc.items, cmd.folder]);

    case 'renameFolder':
      return withItems(
        doc,
        updateItem(doc.items, cmd.id, (it) =>
          it.kind === 'folder' ? { ...it, name: cmd.name } : it,
        ),
      );

    case 'toggleFolderCollapsed':
      return withItems(
        doc,
        updateItem(doc.items, cmd.id, (it) =>
          it.kind === 'folder' ? { ...it, collapsed: !it.collapsed } : it,
        ),
      );

    case 'toggleFolderVisible':
      return withItems(
        doc,
        updateItem(doc.items, cmd.id, (it) =>
          it.kind === 'folder' ? { ...it, visible: !it.visible } : it,
        ),
      );

    case 'move': {
      const moving = findItem(doc.items, cmd.id);
      if (moving === null || cmd.beforeId === cmd.id) return doc;
      // A folder can't be dropped into itself or its own subtree.
      if (
        moving.kind === 'folder' &&
        (cmd.targetFolderId === moving.id || isDescendant(moving, cmd.targetFolderId))
      ) {
        return doc;
      }
      return withItems(
        doc,
        insertBefore(removeItem(doc.items, cmd.id), cmd.targetFolderId, cmd.beforeId, moving),
      );
    }

    case 'setAngleMode':
      return doc.angleMode === cmd.angleMode ? doc : { ...doc, angleMode: cmd.angleMode };

    case 'setPrecision':
      return doc.precision === cmd.precision ? doc : { ...doc, precision: cmd.precision };
  }
}

function withItems(doc: GcalcDocument, items: Item[]): GcalcDocument {
  return items === doc.items ? doc : { ...doc, items };
}

/**
 * Commands that represent content edits and therefore belong in undo history.
 * Settings (angle mode, precision), transient CAS notes, and folder
 * collapse/expand are excluded — they aren't content the user expects Ctrl+Z
 * to touch. (Consumed by M7.2; kept here beside the command definitions.)
 */
export function isUndoable(cmd: Command): boolean {
  switch (cmd.type) {
    case 'setNote':
    case 'toggleFolderCollapsed':
    case 'setAngleMode':
    case 'setPrecision':
      return false;
    default:
      return true;
  }
}
