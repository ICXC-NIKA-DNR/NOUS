/**
 * Derive a filesystem-safe basename (no extension) for an exported file from a
 * document/tab name. Strips characters that are illegal in filenames on common
 * OSes (path separators, Windows-reserved chars, control chars), collapses
 * whitespace, drops leading/trailing dots, caps the length, and falls back to
 * `graph` when nothing usable remains. Callers append `.png` / `.svg`.
 */
const ILLEGAL = /[\\/:*?"<>|]/g;
const CONTROL = /[\x00-\x1f]/g;

export function exportBaseName(name: string): string {
  const cleaned = name
    .replace(ILLEGAL, '')
    .replace(CONTROL, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .trim()
    .slice(0, 100)
    .trim();
  return cleaned || 'graph';
}
