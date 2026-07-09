# App icons

This directory holds the generated app-icon set. **Do not hand-edit these
files** — they are produced from a single source image by the Tauri icon
pipeline. `icon.png` here is currently a 128×128 placeholder.

## Regenerating from real branding art (one command)

1. Drop the source artwork at **`src-tauri/app-icon.png`** — a squared
   **1024×1024 PNG with transparency** (a transparent SVG also works; point
   the script at it instead).
2. From the repo root, run:

   ```
   npm run icon
   ```

   (equivalently `npm run tauri icon src-tauri/app-icon.png -o src-tauri/icons`)

This overwrites every file in this directory: the desktop set
(`32x32.png`, `64x64.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`,
`icon.ico`, `icon.png`), the Windows Store logos (`Square*Logo.png`,
`StoreLogo.png`), and `android/` + `ios/` launcher icons (unused — this is a
desktop-only app).

Because the pipeline regenerates `icon.png`, the current
`tauri.conf.json` → `bundle.icon` entry (`["icons/icon.png"]`) picks up the
new art with no further edits for the window/taskbar icon.

## Enabling full installer icons + bundling

The single `icon.png` entry is enough for the window icon. To ship installers
with per-platform icons, once the set above exists, update
`src-tauri/tauri.conf.json`:

```json
"bundle": {
  "active": true,
  "targets": "all",
  "icon": [
    "icons/32x32.png",
    "icons/128x128.png",
    "icons/128x128@2x.png",
    "icons/icon.icns",
    "icons/icon.ico"
  ]
}
```

`bundle.active` is currently `false`; flip it to `true` only when you want
`tauri build` to produce packaged installers. Leaving the expanded `icon`
array in place before the `.icns`/`.ico` files exist will break bundling, so
make this edit *after* running `npm run icon`.
