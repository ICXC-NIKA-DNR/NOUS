// A folder header (M7.3): collapse chevron, cascading-visibility eye, inline-
// editable name, delete. Purely presentational — App owns the tree, the
// commands, and drag-and-drop, and renders the folder's children beneath the
// header (indented) when it isn't collapsed.

import type { ReactNode } from 'react';
import type { FolderItem } from '../state/document.ts';

interface FolderRowProps {
  folder: FolderItem;
  /** Drag handle element (App wires the DnD). */
  dragHandle: ReactNode;
  /** Rendered child items, shown when the folder is expanded. */
  children: ReactNode;
  onRename: (id: number, name: string) => void;
  onToggleCollapsed: (id: number) => void;
  onToggleVisible: (id: number) => void;
  onDelete: (id: number) => void;
}

/** Open-eye / slashed-eye icon reflecting folder visibility. */
function EyeIcon({ visible }: { visible: boolean }): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <circle cx="12" cy="12" r="3" fill="currentColor" />
      {!visible && <line x1="3" y1="21" x2="21" y2="3" stroke="currentColor" strokeWidth="2" />}
    </svg>
  );
}

export function FolderRow({
  folder,
  dragHandle,
  children,
  onRename,
  onToggleCollapsed,
  onToggleVisible,
  onDelete,
}: FolderRowProps): JSX.Element {
  return (
    <div className="folder">
      <div className="folder-header">
        {dragHandle}
        <button
          type="button"
          className="folder-chevron"
          title={folder.collapsed ? 'Expand' : 'Collapse'}
          aria-expanded={!folder.collapsed}
          onClick={() => onToggleCollapsed(folder.id)}
        >
          {folder.collapsed ? '▸' : '▾'}
        </button>
        <button
          type="button"
          className={`folder-eye${folder.visible ? '' : ' folder-eye-off'}`}
          title={folder.visible ? 'Hide folder' : 'Show folder'}
          aria-label={folder.visible ? 'Hide folder' : 'Show folder'}
          aria-pressed={!folder.visible}
          onClick={() => onToggleVisible(folder.id)}
        >
          <EyeIcon visible={folder.visible} />
        </button>
        <input
          className="folder-name"
          value={folder.name}
          spellCheck={false}
          aria-label="Folder name"
          onChange={(e) => onRename(folder.id, e.target.value)}
        />
        <button
          type="button"
          className="folder-delete"
          title="Delete folder and its contents"
          onClick={() => onDelete(folder.id)}
        >
          ×
        </button>
      </div>
      {!folder.collapsed && <div className="folder-children">{children}</div>}
    </div>
  );
}
