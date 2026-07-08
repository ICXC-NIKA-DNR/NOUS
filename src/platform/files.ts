// Platform file access (M8.2). One interface, two implementations:
//
//  - Tauri: native OS save/open dialogs (plugin-dialog) + fs plugin writes.
//    Dialog-selected paths are runtime-authorized for the fs plugin, so
//    `dialog:default` + `fs:default` cover save/open at user-chosen paths.
//  - Browser (the Vite preview): blob download for save, a hidden
//    <input type=file> for open — keeps every M8 flow verifiable without the
//    desktop shell.
//
// The Tauri plugins are imported dynamically and only on the Tauri branch, so
// the browser bundle never evaluates them. Detection uses the
// __TAURI_INTERNALS__ global the v2 runtime injects.

export interface OpenedFile {
  /** File name without directory (used as the tab/document name). */
  name: string;
  contents: string;
}

export interface FilePlatform {
  /** Prompt for a location and write `contents`. Resolves to the chosen file
   * name, or null when the user cancelled. */
  saveNousFile(contents: string, suggestedName: string): Promise<string | null>;
  /** Prompt for a .nous file and read it. Null when cancelled. */
  openNousFile(): Promise<OpenedFile | null>;
  /** Save an export (PNG bytes / SVG text) via dialog or download. Resolves
   * to the chosen file name, or null when cancelled. */
  saveExport(
    data: Uint8Array | string,
    suggestedName: string,
    ext: string,
    mime: string,
  ): Promise<string | null>;
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i === -1 ? path : path.slice(i + 1);
}

/* ------------------------------------------------------------------ */
/* Tauri: native dialogs + fs plugin                                   */
/* ------------------------------------------------------------------ */

const NOUS_FILTER = [{ name: 'NOUS graph', extensions: ['nous'] }];

const tauriPlatform: FilePlatform = {
  async saveNousFile(contents, suggestedName) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const path = await save({ defaultPath: suggestedName, filters: NOUS_FILTER });
    if (path === null) return null;
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    await writeTextFile(path, contents);
    return baseName(path);
  },

  async openNousFile() {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({ multiple: false, directory: false, filters: NOUS_FILTER });
    if (path === null) return null;
    const { readTextFile } = await import('@tauri-apps/plugin-fs');
    return { name: baseName(path), contents: await readTextFile(path) };
  },

  async saveExport(data, suggestedName, ext, mime) {
    void mime; // download-transport concern only
    const { save } = await import('@tauri-apps/plugin-dialog');
    const path = await save({
      defaultPath: suggestedName,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (path === null) return null;
    const fs = await import('@tauri-apps/plugin-fs');
    if (typeof data === 'string') await fs.writeTextFile(path, data);
    else await fs.writeFile(path, data);
    return baseName(path);
  },
};

/* ------------------------------------------------------------------ */
/* Browser fallback: blob download + file input                        */
/* ------------------------------------------------------------------ */

const browserPlatform: FilePlatform = {
  saveNousFile(contents, suggestedName) {
    const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedName;
    a.click();
    URL.revokeObjectURL(url);
    // A download can't be cancelled observably; report it as saved.
    return Promise.resolve(suggestedName);
  },

  openNousFile() {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.nous,application/json';
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return resolve(null);
        file.text().then((contents) => resolve({ name: file.name, contents }), reject);
      };
      // Cancel fires no event in every engine; `cancel` is supported in the
      // ones we target (Chromium preview, WebKitGTK).
      input.oncancel = () => resolve(null);
      input.click();
    });
  },

  saveExport(data, suggestedName, _ext, mime) {
    const blob = new Blob([data as BlobPart], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedName;
    a.click();
    URL.revokeObjectURL(url);
    return Promise.resolve(suggestedName);
  },
};

export const filePlatform: FilePlatform = isTauri() ? tauriPlatform : browserPlatform;
