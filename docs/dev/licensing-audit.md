# Licensing audit (M10.3)

Date: 2026-07-09. Scope: confirm the repo ships as MIT with no copyleft
contamination, with particular attention to the CAS boundary (the original
Giac/GPL risk that shaped M5 — see `CAS_SPEC.md`).

## Result: clean — MIT, no copyleft

- **Project license:** `LICENSE` is MIT; `package.json` and
  `src-tauri/Cargo.toml` both declare `license: MIT`.
- **CAS boundary:** `src/cas/` is from-scratch TypeScript (differentiate,
  integrate, limit, rational, simplify, solve, engine). No `giac`, `GPL`,
  `AGPL`, or `copyleft` string appears anywhere in `src/` or `src-tauri/src/`.
  Confirms the from-scratch MIT claim in `CAS_SPEC.md` — no GPL WASM boundary.
- **npm dependencies (82 installed):** all permissive. Counts —
  67 MIT, 5 ISC, 6 dual `Apache-2.0 OR MIT`, 2 Apache-2.0, 1 BSD-3-Clause,
  1 OFL-1.1, 1 CC-BY-4.0. **No GPL/AGPL/LGPL/MPL/EUPL/CDDL.**

## Non-MIT packages — notes

| Package | License | Ships? | Note |
|---|---|---|---|
| `@fontsource/inter` | OFL-1.1 | **yes** (bundled font) | SIL Open Font License — permissive, embedding allowed. On distribution, include the Inter OFL license text (bundled at `node_modules/@fontsource/inter/LICENSE`). |
| `@tauri-apps/*` | dual Apache-2.0 OR MIT | yes (api/plugins) | Used under MIT. |
| `katex`, `react`, `react-dom` | MIT | yes | — |
| `caniuse-lite` | CC-BY-4.0 | no (build-time data) | Attribution license on browser data; dev-only, not in the app bundle. |
| `source-map-js` | BSD-3-Clause | no (dev) | Permissive. |
| `typescript`, `baseline-browser-mapping` | Apache-2.0 | no (dev) | Permissive. |

## Follow-ups (not blockers)

- **Bundled-font attribution:** when installers are produced (bundling is off
  until the icon art lands), ship the Inter OFL license alongside the app —
  e.g. a `THIRD_PARTY_LICENSES` file. OFL only forbids selling the font on its
  own; embedding in the app is fine.
- **Rust transitive crates:** the app crate is MIT and the Tauri/Rust
  ecosystem is overwhelmingly MIT/Apache dual, but `cargo-license` isn't
  available in this environment to enumerate transitive crate licenses. Add a
  `cargo deny` check (license allowlist) to CI for ongoing enforcement, or run
  `cargo license` once locally to record the full Rust tree.

## How this was checked

- `grep -rniE 'giac|GPL|AGPL|copyleft' src/ src-tauri/src/` → no hits.
- A Node scan of every `node_modules/*/package.json` `license` field, grouped
  and filtered for copyleft SPDX identifiers → none.
