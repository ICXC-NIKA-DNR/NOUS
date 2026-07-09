# App icons

This directory holds the generated app-icon set. **Do not hand-edit these
files** — they are produced from `src-tauri/app-icon.svg` (the NOUS mark:
charcoal tile, palette-blue parabola, yellow vertex point) by the Tauri icon
pipeline.

## Regenerating (one command)

1. Edit **`src-tauri/app-icon.svg`** (or replace it — a squared 1024×1024 PNG
   with transparency also works; update the `icon` script in package.json if
   the filename changes). Note: the tauri icon SVG parser rejects XML
   comments — keep the SVG comment-free.
2. From the repo root, run:

   ```
   npm run icon
   ```

This overwrites every file in this directory: the desktop set
(`32x32.png`, `64x64.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`,
`icon.ico`, `icon.png`), the Windows Store logos (`Square*Logo.png`,
`StoreLogo.png`), and `android/` + `ios/` launcher icons (unused — this is a
desktop-only app; mobile is postponed, see PLAN.md).

Bundling is enabled (`bundle.active: true` in `tauri.conf.json`) with Linux
targets `deb` + `appimage`; the `bundle.icon` array references the generated
set, so a regenerated icon flows into installers with no config edits.
