// Autosave storage + crash detection (M8.3).
//
// Transport is localStorage in BOTH runtimes: the Tauri webview's
// localStorage persists under the app's data directory, so there's no fs
// plugin ceremony and the same code is exercised by the browser preview.
//
// Crash detection is a dirty/clean flag, not process supervision: every
// autosave write marks the session dirty; pagehide/beforeunload marks it
// clean. Next launch, payload + dirty ⇒ unclean exit ⇒ offer recovery.
// (Minimize fires pagehide → clean, but the next edit's autosave re-dirties,
// so the flag always reflects "were there edits after the last safe point".)

import { isTauri } from './files.ts';

const PAYLOAD_KEY = 'nous.autosave.v1';
const CLEAN_KEY = 'nous.cleanExit.v1';

export const autosaveStore = {
  write(payload: string): void {
    try {
      localStorage.setItem(PAYLOAD_KEY, payload);
      localStorage.setItem(CLEAN_KEY, '0');
    } catch {
      // Quota/blocked storage: autosave is best-effort by design.
    }
  },

  markCleanExit(): void {
    try {
      localStorage.setItem(CLEAN_KEY, '1');
    } catch {
      /* see above */
    }
  },

  /** The payload to offer for recovery — present only after an unclean exit. */
  readRecovery(): string | null {
    try {
      if (localStorage.getItem(CLEAN_KEY) === '1') return null;
      return localStorage.getItem(PAYLOAD_KEY);
    } catch {
      return null;
    }
  },

  clear(): void {
    try {
      localStorage.removeItem(PAYLOAD_KEY);
      localStorage.removeItem(CLEAN_KEY);
    } catch {
      /* see above */
    }
  },
};

/** Install the clean-exit markers. Returns an uninstaller (for tests/HMR). */
export function installCleanExitMarker(): () => void {
  const mark = (): void => autosaveStore.markCleanExit();
  window.addEventListener('pagehide', mark);
  window.addEventListener('beforeunload', mark);
  // wry/WebKitGTK doesn't reliably fire beforeunload/pagehide on window
  // close — hook Tauri's close-requested event too (sync localStorage write,
  // safe to run as the close proceeds). Needs a desktop manual test (M8.2's
  // dialog caveat applies to automation here as well).
  let unlistenClose: (() => void) | null = null;
  if (isTauri()) {
    import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().onCloseRequested(mark))
      .then((un) => {
        unlistenClose = un;
      })
      .catch(() => {
        /* browser bundle / missing permission: browser markers still apply */
      });
  }
  return () => {
    window.removeEventListener('pagehide', mark);
    window.removeEventListener('beforeunload', mark);
    unlistenClose?.();
  };
}
