// Local-only error log (M8.3). Captures uncaught errors and unhandled
// rejections so users can attach them to GitHub issues. Never leaves the
// machine — no telemetry (CLAUDE.md).
//
//  - Tauri: appended to <AppLog>/nous-errors.log via the fs plugin
//    (fs:default creates app dirs; scope-applog-recursive + write permission
//    cover the appends). The UI shows the real path.
//  - Browser: a capped localStorage ring (no real files in a web page); the
//    UI labels it as such.

import { isTauri } from './files.ts';

const LOG_FILE = 'nous-errors.log';
const BROWSER_KEY = 'nous.errorLog.v1';
const BROWSER_MAX_ENTRIES = 200;

function formatEntry(kind: string, detail: unknown): string {
  const text =
    detail instanceof Error
      ? `${detail.message}\n${detail.stack ?? ''}`.trimEnd()
      : String(detail);
  return `[${new Date().toISOString()}] ${kind}: ${text}\n`;
}

async function appendTauri(entry: string): Promise<void> {
  const { appLogDir } = await import('@tauri-apps/api/path');
  const { BaseDirectory, exists, mkdir, readTextFile, writeTextFile } = await import(
    '@tauri-apps/plugin-fs'
  );
  await appLogDir(); // resolves/validates the dir path
  if (!(await exists('', { baseDir: BaseDirectory.AppLog }))) {
    await mkdir('', { baseDir: BaseDirectory.AppLog, recursive: true });
  }
  let prior = '';
  try {
    prior = await readTextFile(LOG_FILE, { baseDir: BaseDirectory.AppLog });
  } catch {
    // first write
  }
  await writeTextFile(LOG_FILE, prior + entry, { baseDir: BaseDirectory.AppLog });
}

function appendBrowser(entry: string): void {
  try {
    const lines = (localStorage.getItem(BROWSER_KEY) ?? '').split('\n---\n').filter(Boolean);
    lines.push(entry.trimEnd());
    localStorage.setItem(BROWSER_KEY, lines.slice(-BROWSER_MAX_ENTRIES).join('\n---\n'));
  } catch {
    // Storage blocked: logging is best-effort.
  }
}

export function logError(kind: string, detail: unknown): void {
  const entry = formatEntry(kind, detail);
  if (isTauri()) {
    appendTauri(entry).catch(() => appendBrowser(entry));
  } else {
    appendBrowser(entry);
  }
}

/** Where the log lives, for display in the UI. */
export async function errorLogPath(): Promise<string> {
  if (isTauri()) {
    try {
      const { appLogDir } = await import('@tauri-apps/api/path');
      const dir = await appLogDir();
      return `${dir.replace(/[/\\]$/, '')}/${LOG_FILE}`;
    } catch {
      /* fall through */
    }
  }
  return `browser localStorage (${BROWSER_KEY})`;
}

/** Install global capture. Returns an uninstaller (tests/HMR). */
export function installErrorLog(): () => void {
  const onError = (e: ErrorEvent): void => logError('error', e.error ?? e.message);
  const onRejection = (e: PromiseRejectionEvent): void => logError('unhandledrejection', e.reason);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
