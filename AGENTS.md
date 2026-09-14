# AGENTS.md — Dota Mod Set

Windows-only Electron app (main `src/main.js` ~1900 lines). No lint/typecheck/CI.

## Commands

- `npm start` — run app (`electron .`)
- `npm test` — all 8 suites chained with `&&` (one failure stops the rest)
- Single suite: `node src/<name>.test.js` (e.g. `node src/grouping.test.js`)
- `npm run check` — `node --check` all src files; run before claiming done
- `npm run dist` / `dist:setup` — portable / NSIS build via electron-builder (`dist/` is output, never edit)

## Architecture

- `src/main.js` — main process, all business logic + IPC handlers (catalog, download cache, `applySet`/`rollback`, workshop build, VRF tool download)
- `src/preload.js` — IPC bridge only; every new handler needs a channel here
- `src/renderer.js` + `src/workshop.js` — renderer UI; `workshop.js` holds UI state + pure grouping helpers
- `src/index.html`, `src/styles.css` — view
- Root `*.js` (`build-v2`, `merge-model`, `gltf-*`, `meshinfo`, `find-item`, `verify-merge`) — standalone one-off scripts, NOT bundled (`build.files: src/**/*` minus tests)
- `src/catalog.demo.json` — fallback catalog when source fetch fails

## Tests eat source via markers — do not break them

Test files `eval`-slice functions out of source using marker comments. Keep markers byte-intact:
- `recolor.test.js`: `function rgb2hsv` … `// ── WAVE2` region in `main.js`
- `grouping.test.js`: `// ── GROUP-BLOCK-START ──` … `GROUP-BLOCK-END` in `workshop.js`
- Same pattern for dedup/subslot/preflight/build/helpflags/wave2 blocks
- `effectGroupKey` (workshop.js) is mirrored as `effectGroupKeyMain` (main.js) + `GROUP_TAIL_DROP` set; `grouping.test.js` mirror-sync fails if they drift — edit both

## Safety model (never bypass)

- Sets live only under `<game>/Dota2CosmeticMods/sets/<setId>/pak-slots`; never touch `pak01*` or game processes
- `applySet`: stage files in `transaction-<uuid>` temp dir → `mkdir setRoot` (must be new) → write manifest `state:'staged'` → copy with `COPYFILE_EXCL` → flip to `'applied'`
- `rollback` removes only manifest-listed files whose sha256 still matches; `purgeHistory`, temp sweep same rule
- All catalog/manifest read-modify-write goes through `withCatalogLock`; JSON writes via atomic `writeJson` (tmp+rename)
- ZIP handling: `expandArchive`/`extractZipVpk` in `main.js` (PowerShell `Expand-Archive` + `psQuote`); consume only files found by walking inside the fresh temp dir (ZipSlip rule); nested zips supported
- Downloads: https-only, host must be in `SAFE_DOWNLOAD_HOSTS`; `.vpk`/`.zip` extension checked on original URL (CDN redirects lose it)

## Windows assumptions

- Paths, `reg query HKCU\Software\Valve\Steam`, `Expand-Archive` — no macOS/Linux support; don't add shell-portable abstractions
- Default game path `D:\SteamLibrary\steamapps\common\dota 2 beta`; game detection: registry → `libraryfolders.vdf` → `appmanifest_570.acf` + `pak01_dir.vpk` check
- Source files contain Russian UTF-8 comments; keep encoding, don't transliterate
