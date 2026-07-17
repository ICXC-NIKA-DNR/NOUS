// File-menu behavior (M11): the state machine behind ui/DocActions.tsx,
// kept DOM-free (house pattern: ui/shortcuts.ts) so node:test can drive
// every action, toast, and close path without a browser.
//
// Feature-local to DocActions — NOT a shared dropdown component. The CAS
// menu in ExpressionRow.tsx stays fully independent (M11 decision): changes
// here must never affect it, and vice versa.
//
// Close semantics: Escape, outside click, and completed actions all route
// through closeMenu(), which also resets the paste panel (closing IS the
// cancel). The explicit Cancel button closes just the panel, leaving the
// menu open. Save/Open close the menu immediately on click (the native file
// dialog takes over); Copy closes only on success — the clipboard-blocked
// fallback needs the panel to stay up to surface the code by hand.

export interface DocMenuState {
  /** The File dropdown panel. */
  menuOpen: boolean;
  /** The paste-share-code sub-panel inside the dropdown. */
  pasteOpen: boolean;
  pasteText: string;
}

export interface DocMenuDeps {
  /** Build the share code for the active document. */
  makeShareCode: () => string;
  /** Decode + open a pasted share code as a new tab. Throws NousFormatError. */
  openShareCode: (code: string) => void;
  /** Save the active document; resolves to the file name, null on cancel. */
  saveFile: () => Promise<string | null>;
  /** Open a .nous file as a new tab; null on cancel, rejects on bad content. */
  openFile: () => Promise<string | null>;
  /** navigator.clipboard.writeText, injectable for tests. */
  writeClipboard: (text: string) => Promise<void>;
  /** Toast sink (App owns the toast) — fires regardless of menu state. */
  flash: (text: string, error?: boolean) => void;
}

export const INITIAL_DOC_MENU: DocMenuState = {
  menuOpen: false,
  pasteOpen: false,
  pasteText: '',
};

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class DocMenuController {
  state: DocMenuState;
  private readonly deps: () => DocMenuDeps;
  private readonly notify: (state: DocMenuState) => void;

  /** deps is a getter so the React shell can hand in always-fresh props. */
  constructor(deps: () => DocMenuDeps, notify: (state: DocMenuState) => void) {
    this.state = INITIAL_DOC_MENU;
    this.deps = deps;
    this.notify = notify;
  }

  private set(patch: Partial<DocMenuState>): void {
    this.state = { ...this.state, ...patch };
    this.notify(this.state);
  }

  toggleMenu(): void {
    if (this.state.menuOpen) this.closeMenu();
    else this.set({ menuOpen: true });
  }

  /** Escape / outside click / completed action: close and reset the panel. */
  closeMenu(): void {
    this.set({ menuOpen: false, pasteOpen: false, pasteText: '' });
  }

  save(): Promise<void> {
    this.closeMenu();
    return this.deps().saveFile().then(
      (name) => {
        if (name !== null) this.deps().flash(`Saved ${name}`);
      },
      (err) => this.deps().flash(message(err), true),
    );
  }

  open(): Promise<void> {
    this.closeMenu();
    return this.deps().openFile().then(
      (name) => {
        if (name !== null) this.deps().flash(`Opened ${name}`);
      },
      (err) => this.deps().flash(message(err), true),
    );
  }

  copy(): Promise<void> {
    const code = this.deps().makeShareCode();
    return this.deps().writeClipboard(code).then(
      () => {
        this.deps().flash('Share code copied to clipboard');
        this.closeMenu();
      },
      () => {
        // Clipboard blocked (permissions/insecure context): surface the code
        // in the paste panel so it can be copied by hand — menu stays open.
        this.set({ pasteOpen: true, pasteText: code });
        this.deps().flash('Clipboard unavailable — copy the code below', true);
      },
    );
  }

  togglePaste(): void {
    this.set({ pasteOpen: !this.state.pasteOpen });
  }

  /** The panel's Cancel button: discard the panel, keep the menu open. */
  cancelPaste(): void {
    this.set({ pasteOpen: false, pasteText: '' });
  }

  setPasteText(text: string): void {
    this.set({ pasteText: text });
  }

  submitPaste(): void {
    try {
      this.deps().openShareCode(this.state.pasteText);
      this.deps().flash('Graph opened in a new tab');
      this.closeMenu();
    } catch (err) {
      // Pasted codes are untrusted input: surface EVERY failure as a toast,
      // never rethrow — an unexpected error class must not escape the click
      // handler as a silent uncaught exception. Panel stays open for a fix.
      this.deps().flash(message(err), true);
    }
  }
}
