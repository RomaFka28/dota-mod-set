const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { validateArchiveEntries } = require('./archive-safety');
const { CATALOG_SOURCES, createAuthorSource, normalizeAuthorCatalog, validateCatalogUrl } = require('./catalog-sources');
const { platformRoots, steamLibraryPaths, dotaPathFromLibrary } = require('./platform-paths');

const execFileAsync = promisify(execFile);
const PLATFORM_ROOTS = platformRoots();
const DEFAULT_GAME_PATH = PLATFORM_ROOTS.defaultGamePath;
const D2PFX_SOURCE = CATALOG_SOURCES[0];
const SOURCE_ROOT = D2PFX_SOURCE.repositoryUrl;
const APP_REPOSITORY = 'https://github.com/RomaFka28/dota-mod-set';
const SAFE_DOWNLOAD_HOSTS = new Set(['github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com', 'h6rd.github.io']);
const dataPath = () => path.join(app.getPath('userData'), 'DotaModSet');
const configPath = () => path.join(dataPath(), 'config.json');
const manifestPath = () => path.join(dataPath(), 'installed-manifests.json');
const cachePath = () => path.join(dataPath(), 'cache');
let cacheIndexPromise = null;
function invalidateCacheIndex() { cacheIndexPromise = null; }
async function cacheIndex() {
  if (!cacheIndexPromise) {
    cacheIndexPromise = fs.readdir(cachePath()).catch(() => []);
  }
  return cacheIndexPromise;
}
const demoPath = () => path.join(__dirname, 'catalog.demo.json');
const fontsBackupPath = () => path.join(dataPath(), 'fonts-default-backup');
// Расширения файлов ассетов, которые умеем авто-упаковывать в VPK
// (шрифтовые моды, поставляемые без готового VPK)
const ASSET_FONT_EXTS = new Set(['ttf', 'otf', 'uifont', 'vfont', 'ttc', 'woff', 'woff2']);

async function ensureData() { await Promise.all([fs.mkdir(cachePath(), { recursive: true }), fs.mkdir(dataPath(), { recursive: true })]); }
async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback;
    throw new Error(`Не удалось прочитать JSON ${path.basename(file)}: ${error.message}`, { cause: error });
  }
}
// Атомарная запись JSON: tmp + rename, чтобы краш не оставлял половинчатые
// манифесты/каталоги/записи установки (аудит, волна 2).
async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, file);
}
// Мьютекс мутаций: все read-modify-write каталога/манифестов/записи установки
// идут строго по очереди — иначе конкурентные build+delete+install теряют апдейты.
function createMutex() {
  let tail = Promise.resolve();
  return { run(fn) { const run = tail.then(() => fn()); tail = run.catch(() => {}); return run; } };
}
const catalogLock = createMutex();
function withCatalogLock(fn) { return catalogLock.run(fn); }
function safeId(value) { return String(value || 'mod').replace(/[^a-z0-9_-]/gi, '_').slice(0, 80); }
function hashBuffer(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
// Стриминговый sha256: VPK весят десятки–сотни МБ, целиком в память не читаем.
async function hashStream(file) {
  const hash = crypto.createHash('sha256');
  const fh = await fs.open(file, 'r');
  try { for await (const chunk of fh.createReadStream()) hash.update(chunk); }
  finally { await fh.close().catch(() => {}); }
  return hash.digest('hex');
}
async function hashFile(file) { return hashStream(file); }
function isSubpath(child, parent) { const relative = path.relative(parent, child); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); }
function gameModRoot(gamePath) { return path.join(gamePath, 'Dota2CosmeticMods'); }

// ── Автопоиск папки Dota 2 ──────────────────────────────────────────
// Цепочка: реестр Steam → libraryfolders.vdf → appmanifest_570.acf (id Доты)
// + проверка pak01 на месте. Сохранённый пользователем путь всегда важнее.
async function steamPathFromRegistry() {
  try {
    const { stdout } = await execFileAsync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { timeout: 5000, windowsHide: true });
    const m = stdout.match(/SteamPath\s+REG_SZ\s+(.+)/);
    return m ? m[1].trim().replace(/\//g, path.sep) : null;
  } catch { return null; }
}
function isDotaDir(dir) {
  try { return fss.existsSync(path.join(dir, 'game', 'dota', 'pak01_dir.vpk')); }
  catch { return false; }
}
let __detectedGamePath = null, __detectTried = false;
async function detectGamePath(force = false) {
  if (__detectTried && !force) return __detectedGamePath;
  __detectTried = true; __detectedGamePath = null;
  const libs = [];
  const reg = process.platform === 'win32' ? await steamPathFromRegistry() : null;
  const roots = process.platform === 'win32' ? [reg, ...PLATFORM_ROOTS.steamRoots].filter(Boolean) : PLATFORM_ROOTS.steamRoots;
  for (const root of roots) {
    libs.push(...steamLibraryPaths(root, process.platform));
    try {
      const steamapps = path.join(root, 'steamapps');
      const text = await fs.readFile(path.join(steamapps, 'libraryfolders.vdf'), 'utf8');
      for (const m of text.matchAll(/"path"\s+"([^"]+)"/g))
        libs.push(...steamLibraryPaths(m[1].replace(/\\\\/g, process.platform === 'win32' ? '\\' : '/'), process.platform));
    } catch { /* нет vdf — пропускаем */ }
  }
  if (process.platform === 'win32') for (const d of ['D', 'E', 'F']) libs.push(`${d}:\\SteamLibrary\\steamapps`);
  const uniq = [...new Set(libs)];
  // Сначала строго: манифест 570 + pak01; потом мягко: только pak01
  for (const strict of [true, false]) {
    for (const lib of uniq) {
      const dota = dotaPathFromLibrary(lib, process.platform);
      if (strict && !fss.existsSync(path.join(lib, 'appmanifest_570.acf'))) continue;
      if (isDotaDir(dota)) { __detectedGamePath = dota; return dota; }
    }
  }
  return null;
}
async function settings() {
  await ensureData();
  const saved = await readJson(configPath(), {});
  const gamePath = saved.gamePath || (await detectGamePath()) || DEFAULT_GAME_PATH;
  const catalogUrls = Array.isArray(saved.catalogUrls) ? saved.catalogUrls.filter(url => { try { validateCatalogUrl(url); return true; } catch { return false; } }).slice(0, 10) : [];
  return { gamePath, sourceUrl: saved.sourceUrl || SOURCE_ROOT, catalogUrls, voiceFolder: saved.voiceFolder || '', autoCloseSteam: saved.autoCloseSteam !== false, gamePathAuto: !saved.gamePath, gamePathValid: isDotaDir(path.resolve(gamePath)) };
}

const SKIP_SOURCE_CATEGORIES = new Set(['tools', 'guides', 'sites', 'news']);
function normalizeCategory(value = '') {
  const name = String(value).toLowerCase().replace(/[-_\s]+/g, '-');
  // Мелкие/родственные группы источника объединяем в общие разделы сайдбара,
  // чтобы не плодить ~40 пунктов, но ничего не падало в «Скины героев».
  const MERGE = {
    'herofx': 'effects', 'ti-bp-effects': 'effects',
    'hero-sounds': 'sounds', 'mega-kill': 'sounds',
    'versus-screens': 'backgrounds', 'pedestal': 'backgrounds',
    'tormentor': 'ancient',
    'pings': 'ui', 'ranks': 'ui', 'high-five': 'ui',
    'item-icons': 'items', 'shaders': 'textures',
    'packs': 'other', 'optimization': 'other',
  };
  if (MERGE[name]) return MERGE[name];
  // Все разделы сайдбара + производные. Не схлопывать их в hero-skins.
  const EXACT = ['heroes', 'hero-items', 'item-effects', 'wards', 'couriers', 'emblems', 'trees', 'terrains', 'river', 'towers', 'roshan', 'ancient', 'ranged-attack', 'creeps', 'creep-deny', 'announcers', 'sounds', 'music', 'huds', 'backgrounds', 'cursors', 'ui', 'fonts', 'items', 'effects', 'textures', 'personas', 'other', 'hero-skins'];
  if (EXACT.includes(name)) return name;
  if (/ward/.test(name)) return 'wards';
  if (/courier/.test(name)) return 'couriers';
  if (/persona/.test(name)) return 'personas';
  if (/emblem/.test(name)) return 'emblems';
  if (/(^|-)trees?$/.test(name) || /pine/.test(name)) return 'trees';
  if (/terrain|landscape/.test(name)) return 'terrains';
  if (/announcer/.test(name)) return 'announcers';
  if (/^music$|soundtrack/.test(name)) return 'music';
  if (/^sounds?$|hero-sound/.test(name)) return 'sounds';
  if (/^huds?$/.test(name)) return 'huds';
  if (/background|versus|loading/.test(name)) return 'backgrounds';
  if (/cursor/.test(name)) return 'cursors';
  if (/item.effect|unusual/.test(name)) return 'item-effects';
  if (/hero.item/.test(name)) return 'hero-items';
  if (/ranged|attack/.test(name)) return 'ranged-attack';
  if (/creep.deny/.test(name)) return 'creep-deny';
  if (/creep/.test(name)) return 'creeps';
  if (/effect|particle|fx/.test(name)) return 'effects';
  if (/texture|shader/.test(name)) return 'textures';
  if (/tower/.test(name)) return 'towers';
  if (/river/.test(name)) return 'river';
  if (/roshan/.test(name)) return 'roshan';
  if (/tormentor/.test(name)) return 'tormentor';
  if (/ancient/.test(name)) return 'ancient';
  if (/font|monocraft|typeface/.test(name)) return 'fonts';
  if (/item|weapon|armor|icon/.test(name)) return 'items';
  return 'other';
}

function normalizeMod(raw, index) {
  const name = raw.name || raw.title || raw.displayName || raw.filename || `D2PFX mod ${index + 1}`;
  const link = raw.downloadUrl || raw.download_url || raw.url || raw.link || raw.fileUrl || null;
  return {
    id: safeId(raw.id || raw.slug || raw.filename || name), name, hero: raw.hero || raw.character || raw.targetHero || 'Общее',
    category: normalizeCategory(raw.category || raw.type || raw.tags?.join(' ') || ''),
    replaces: raw.replaces || raw.description || raw.target || 'Описание замены отсутствует в источнике',
    conflictKeys: Array.isArray(raw.conflictKeys) ? raw.conflictKeys : (raw.conflictKey ? [raw.conflictKey] : []),
    size: raw.size || raw.fileSize || null, tags: raw.tags || [], previewUrl: raw.previewUrl || raw.preview_url || null, downloadUrl: typeof link === 'string' && /^https:\/\//.test(link) ? link : null,
    source: raw.source || 'D2PFX',
    sourceId: raw.sourceId || raw.id || null,
    sourceRepository: raw.sourceRepository || SOURCE_ROOT,
    author: raw.author || null,
    license: raw.license || null,
  };
}
function inferHeroFromName(name, heroNames = []) {
  const text = String(name || '').toLowerCase();
  const aliases = { "natures prophet": "Nature's Prophet", "nature prophet": "Nature's Prophet", io: 'Io', "queen of pain": 'Queen of Pain', "wraith king": 'Wraith King', "skywrath mage": 'Skywrath Mage', "vengeful spirit": 'Vengeful Spirit', "shadow fiend": 'Shadow Fiend', "doom bringer": 'Doom', "outworld devourer": 'Outworld Destroyer', "wind ranger": 'Windranger' };
  const candidates = [...heroNames, ...Object.keys(aliases)].sort((a, b) => b.length - a.length);
  const match = candidates.find(hero => new RegExp(`(^|[^a-z])${hero.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^a-z])`, 'i').test(text));
  if (!match) return null;
  return aliases[match.toLowerCase()] || heroNames.find(hero => hero.toLowerCase() === match.toLowerCase()) || match;
}
const HERO_SCOPED_CATEGORIES = new Set(['heroes', 'hero-items', 'personas']);
const SINGLE_SLOT_CATEGORIES = new Set(['emblems', 'trees', 'terrains', 'river', 'towers', 'roshan', 'ancient', 'wards', 'couriers', 'announcers', 'music', 'sounds', 'huds', 'backgrounds', 'cursors', 'ui', 'fonts', 'textures', 'items']);
// ── SUBSLOT-BLOCK-START ──
// Подслоты широких разделов: экран загрузки, VS-заставка и пьедестал —
// РАЗНЫЕ слоты снаряжения (как пины/ранги/дай-пять в мелочах). Без деления
// любые два фона в корзине давали ложный «Конфликт 1». Чистая функция,
// покрыта тестами в subslot.test.js.
function conflictSubSlot(categoryId, name) {
  const n = String(name || '').toLowerCase();
  if (categoryId === 'backgrounds') {
    if (/versus|vs[\s_-]?screen|противостоя|дуэл/.test(n)) return ':versus';
    if (/pedestal|пьедестал|fountain|фонтан/.test(n)) return ':pedestal';
    return ':loading';
  }
  if (categoryId === 'ui') {
    if (/ping|пинг/.test(n)) return ':pings';
    if (/rank|ранг/.test(n)) return ':ranks';
    if (/high.?five|дай.?пять/.test(n)) return ':highfive';
    return ':misc';
  }
  return '';
}
// ── SUBSLOT-BLOCK-END ──
function smartCategoryOverride(name, baseCategoryId) {
  const base = normalizeCategory(baseCategoryId);
  // Шрифты — свой раздел при любой базовой категории: Monocraft/Divagon из
  // источника лежат в 'fonts'/'ui', в обоих случаях по имени видно, что это шрифт.
  if (/font|monocraft|divagon|typeface|шрифт/i.test(String(name || ''))) return 'fonts';
  // Доверяем исходной категории: эмблемы/деревья/террейны уже лежат правильно.
  // Переклассифицируем по имени только то, что ошибочно попало в герои/прочее.
  if (!['heroes', 'hero-skins', 'other', 'items'].includes(base)) return base;
  const n = String(name || '').toLowerCase();
  if (/persona/.test(n)) return 'personas';
  if (/облик|личность/.test(n)) return 'personas';
  if (/emblem/.test(n)) return 'emblems';
  if (/pine cone|pine tree|custom tree|\btree\b/.test(n)) return 'trees';
  if (/terrain/.test(n)) return 'terrains';
  if (/\bward\b/.test(n)) return 'wards';
  if (/courier/.test(n)) return 'couriers';
  if (/announcer/.test(n)) return 'announcers';
  if (/\bmusic\b|soundtrack/.test(n)) return 'music';
  if (/\bhud\b/.test(n)) return 'huds';
  if (/loading screen|loading_screen|versus screen|versus-screen/.test(n)) return 'backgrounds';
  if (/cursor/.test(n)) return 'cursors';
  return base;
}
function flattenD2PfxData(payload, heroNames = []) {
  const source = payload.modsData || payload;
  if (!source || typeof source !== 'object') return [];
  const flat = [];
  for (const [categoryId, value] of Object.entries(source)) {
    // heroes (and some other categories) are plain arrays — wrap them into a single group
    let groups;
    if (Array.isArray(value)) {
      groups = [{ id: categoryId, name: 'Общее', mods: value }];
    } else if (value?.groups && Array.isArray(value.groups)) {
      groups = value.groups;
    } else {
      groups = [{ id: categoryId, name: 'Общее', mods: [] }];
    }
    for (const group of groups) for (const raw of group.mods || []) {
      if (!raw?.name || !raw.file || raw.type === 'guide' || raw.type === 'pack') continue;
      if (SKIP_SOURCE_CATEGORIES.has(String(categoryId).toLowerCase())) continue;
      const file = raw.file;
      const downloadUrl = /^https:\/\//.test(file) ? file : `https://raw.githubusercontent.com/h6rd/Dota2PornFxWeb/main/assets/files/${encodeURIComponent(categoryId)}/${encodeURIComponent(file)}`;
      const activeTags = Object.entries(raw.tags || {}).filter(([, enabled]) => enabled).map(([tag]) => tag);
      const effectiveCategoryId = smartCategoryOverride(raw.name, categoryId);
      // Герой имеет смысл только для геройских категорий. Глобальные моды
      // (эмблемы, деревья, террейны и т.д.) всегда «Общее», иначе они мусорят
      // в фильтре героев и в группировке корзины.
      let hero = 'Общее';
      if (HERO_SCOPED_CATEGORIES.has(effectiveCategoryId)) {
        const inferredHero = inferHeroFromName(raw.name, heroNames);
        const groupedHero = inferHeroFromName(group.name, heroNames);
        hero = raw.hero || groupedHero || inferredHero || 'Общее';
      }
      const slot = activeTags.find(tag => ['totem', 'weapon', 'mount', 'head', 'arm', 'arms', 'armor', 'shoulders', 'back', 'shield', 'hair'].includes(tag));
      const heroKey = hero === 'Общее' ? null : safeId(hero).toLowerCase();
      let conflictKeys = [];
      if (effectiveCategoryId === 'heroes' && heroKey) conflictKeys = [`hero:${heroKey}:model`];
      else if (effectiveCategoryId === 'personas' && heroKey) conflictKeys = [`hero:${heroKey}:persona`];
      else if (effectiveCategoryId === 'hero-items' && heroKey && slot) conflictKeys = [`hero:${heroKey}:${slot}`];
      else if (SINGLE_SLOT_CATEGORIES.has(effectiveCategoryId)) conflictKeys = [`global:${effectiveCategoryId}${conflictSubSlot(effectiveCategoryId, raw.name)}`];
      const previewUrl = raw.preview ? `https://raw.githubusercontent.com/h6rd/Dota2PornFxWeb/main/assets/previews/${encodeURIComponent(categoryId)}/${encodeURIComponent(raw.preview)}` : null;
      flat.push(normalizeMod({ ...raw, id: `${effectiveCategoryId}-${group.id || hero}-${file}`, hero, category: effectiveCategoryId, tags: activeTags, previewUrl, downloadUrl,
        replaces: raw.description || (effectiveCategoryId === 'heroes' ? (heroKey ? `Модель и материалы ${hero}` : 'Модель и материалы героя') : slot ? `Слот «${slot}» ${hero}` : `Элемент: ${hero === 'Общее' ? effectiveCategoryId : hero}`),
        conflictKeys }, flat.length));
    }
  }
  return flat;
}
async function catalogFromSource() {
  try {
    const [modsResponse, constantsResponse] = await Promise.all([
      fetch(D2PFX_SOURCE.catalogUrl, { signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json' } }),
      fetch('https://raw.githubusercontent.com/h6rd/Dota2PornFxWeb/main/assets/data/constants.json', { signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json' } })
    ]);
    if (modsResponse.ok) {
      const [mods, constants] = await Promise.all([modsResponse.json(), constantsResponse.ok ? constantsResponse.json() : {}]);
      const catalog = flattenD2PfxData(mods, constants.HEROES_LIST || []);
      if (catalog.length) return catalog;
    }
  } catch { /* retain offline/cached fallback below */ }
  // The upstream site has evolved its data filenames. Probe known public metadata entry points first.
  const candidates = ['assets/data/mods.json', 'assets/catalog.json', 'assets/mods.json', 'assets/metadata.json', 'assets/data.json'];
  for (const candidate of candidates) {
    try {
      const response = await fetch(`https://raw.githubusercontent.com/h6rd/Dota2PornFxWeb/main/${candidate}`, { signal: AbortSignal.timeout(6000), headers: { Accept: 'application/json' } });
      if (!response.ok) continue;
      const json = await response.json();
      const d2pfx = flattenD2PfxData(json); if (d2pfx.length) return d2pfx;
      const list = Array.isArray(json) ? json : (json.mods || json.items || json.data);
      if (Array.isArray(list) && list.length) return list.map(normalizeMod);
    } catch { /* try next metadata file */ }
  }
  throw new Error('Метаданные D2PFX сейчас недоступны');
}
async function catalogsFromAuthorSources(urls) {
  const result = [];
  for (const url of urls || []) {
    try {
      const source = createAuthorSource(url);
      const response = await fetch(source.catalogUrl, { signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json' } });
      if (!response.ok) continue;
      const document = await response.json();
      const mods = normalizeAuthorCatalog(document, source, normalizeMod);
      result.push(...mods);
    } catch { /* one optional source must not hide the primary catalog */ }
  }
  return result;
}
async function cachedCatalog() { return readJson(path.join(cachePath(), 'catalog.json'), []); }
async function getCatalog() {
  // Локальные моды мастерской живут в том же catalog.json — при онлайне
  // удалённый каталог НЕ должен их затирать (иначе собранный мод исчезает
  // из выдачи сразу после перезагрузки каталога). Сливаем: локальные first.
  const stored = await readJson(path.join(cachePath(), 'catalog.json'), []);
  const storedLocal = stored.filter(isLiveWorkshopEntry);
  const recovered = await recoverOrphanWorkshopVpks(storedLocal);
  // Миграция старых записей: собранные до инференса курьеры лежат с
  // category 'effects' — чиним по имени VPK (только в сторону couriers,
  // обратно ничего не переписываем, чтобы не задеть ручные правки).
  let patched = 0;
  for (const m of storedLocal) {
    if (m && m.category === 'effects' && /courier/i.test(path.basename(String(m.localVpk || '')))) {
      m.category = 'couriers';
      m.tags = workshopTags('couriers');
      if (/восстановлена из файла/.test(m.replaces || '')) m.replaces = 'Курьер · карточка восстановлена из файла';
      patched++;
    }
  }
  const localMods = [...storedLocal, ...recovered];
  if (recovered.length || patched || stored.some(m => m && m.source === 'Мастерская' && !isLiveWorkshopEntry(m))) {
    // Чистим протухшие записи и дописываем восстановленные, остальное не трогаем
    const rest = stored.filter(m => !(m && m.source === 'Мастерская'));
    await writeJson(path.join(cachePath(), 'catalog.json'), [...localMods, ...rest]);
  }
  try {
    const cfg = await settings();
    let remote = [];
    let optionalLoaded = false;
    try { remote = await catalogFromSource(); } catch (error) {
      const optional = await catalogsFromAuthorSources(cfg.catalogUrls);
      if (!optional.length) throw error;
      remote = optional;
      optionalLoaded = true;
    }
    if (cfg.catalogUrls.length && !optionalLoaded) remote = [...remote, ...await catalogsFromAuthorSources(cfg.catalogUrls)];
    const mods = [...localMods, ...remote].map(migrateCatalogEntry);
    await writeJson(path.join(cachePath(), 'catalog.json'), mods);
    return { mods, mode: 'online', installedModIds: await installedModIds() };
  }
  catch { const local = (await cachedCatalog()).map(migrateCatalogEntry); const ids = await installedModIds(); if (local.length) return { mods: local, mode: 'cache', installedModIds: ids }; return { mods: await readJson(demoPath(), []), mode: 'demo', installedModIds: ids }; }
}
function isWorkshopEntry(m) { return Boolean(m && m.source === 'Мастерская' && typeof m.localVpk === 'string'); }
// Миграция закэшированных записей (в памяти, кэш самозаличится при онлайне):
// 1) шрифты, собранные до выделения раздела, лежат с category 'ui';
// 2) фоны/мелочи, собранные до подслотов, лежат с плоским ключом
//    global:backgrounds / global:ui и дают ложные конфликты.
function migrateCatalogEntry(m) {
  if (m && m.category === 'ui' && /font|monocraft|divagon|typeface|шрифт/i.test(String(m.name || ''))) {
    return { ...m, category: 'fonts',
      conflictKeys: (m.conflictKeys || []).map(k => k === 'global:ui' ? 'global:fonts' : k),
      replaces: String(m.replaces || '').replace('Элемент: ui', 'Элемент: fonts') };
  }
  if (m && (m.category === 'backgrounds' || m.category === 'ui') &&
      (m.conflictKeys || []).some(k => k === 'global:backgrounds' || k === 'global:ui')) {
    const sub = conflictSubSlot(m.category, m.name);
    return { ...m, conflictKeys: (m.conflictKeys || []).map(k =>
      (k === 'global:backgrounds' || k === 'global:ui') ? `${k}${sub}` : k) };
  }
  return m;
}
// Моды, собранные мастерской (source + живой localVpk-файл). Протухшие
// записи (VPK удалён вручную) отбрасываем, чтобы не висели мёртвые карточки.
function isLiveWorkshopEntry(m) { if (!isWorkshopEntry(m)) return false; try { return fss.existsSync(m.localVpk); } catch { return false; } }
async function readLocalWorkshopMods() {
  const all = await readJson(path.join(cachePath(), 'catalog.json'), []);
  return all.filter(isLiveWorkshopEntry);
}
// ── DEDUP-BLOCK-START ──
// Сигнатура сборки мастерской: те же исходники + тот же оттенок =
// тот же результат. Чистая функция, покрыта тестами в dedup.test.js.
function workshopBuildSig(paths, hue) {
  const norm = [...(paths || [])].map(p => String(p).replace(/\\/g, '/').toLowerCase()).sort();
  const hueDeg = Math.round(Number(hue) * 360);
  const s = norm.join('\n') + '|' + hueDeg;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `${norm.length}:${hueDeg}:${h.toString(16)}`;
}
// ── DEDUP-BLOCK-END ──
// Категория собранного VPK: если среди исходников/имени есть курьеры —
// это курьер (свой раздел каталога), иначе эффекты. Мастерская тянет
// из pak01 только частицы и курьеров, других вариантов нет.
function inferWorkshopCategory(paths) {
  return (paths || []).some(p => /courier/i.test(String(p))) ? 'couriers' : 'effects';
}
function workshopTags(category) { return category === 'couriers' ? ['мастерская', 'курьеры'] : ['мастерская', 'эффекты']; }
// Восстановление осиротевших VPK мастерской: запись каталога затёрта
// (старый баг перезаписи catalog.json), а файл цел — пересоздаём карточку
// и копию в кэше, чтобы мод снова был ГОТОВ без пересборки.
async function recoverOrphanWorkshopVpks(known) {
  const recovered = [];
  let files = [];
  try { files = (await fs.readdir(workshopPath())).filter(f => /\.vpk$/i.test(f)); } catch { return recovered; }
  const knownPaths = new Set(known.map(m => String(m.localVpk || '').toLowerCase()));
  for (const f of files) {
    try {
      const full = path.join(workshopPath(), f);
      if (knownPaths.has(full.toLowerCase())) continue;
      const st = fss.statSync(full);
      const base = f.replace(/\.vpk$/i, '');
      const pretty = base.replace(/_vpcf_c$/i, '').replace(/_/g, ' ');
      const id = `workshop-${safeId(base)}-${Math.round(st.mtimeMs)}`;
      const category = inferWorkshopCategory([f]);
      const entry = {
        id, name: pretty || base, hero: 'Общее', category,
        replaces: category === 'couriers'
          ? 'Курьер · карточка восстановлена из файла'
          : 'Скомпилированные .vpcf_c эффекты · карточка восстановлена из файла',
        conflictKeys: [`workshop:${safeId(base)}`],
        size: `${(st.size / 1024 / 1024).toFixed(2)} MB`,
        tags: workshopTags(category), previewUrl: null, downloadUrl: null,
        source: 'Мастерская', localVpk: full,
      };
      // Копия в кэше под новый id — без неё карточка не станет ГОТОВО и apply не найдёт файл
      if (!await findCachedFile(id)) {
        await fs.mkdir(cachePath(), { recursive: true });
        await fs.copyFile(full, path.join(cachePath(), `${safeId(id)}-workshop.vpk`));
        invalidateCacheIndex();
      }
      recovered.push(entry);
    } catch { /* битый файл — пропускаем, не роняем каталог */ }
  }
  return recovered;
}
function validateDownloadUrl(url) {
  const parsed = new URL(url); if (parsed.protocol !== 'https:' || !SAFE_DOWNLOAD_HOSTS.has(parsed.hostname)) throw new Error('Ссылка загрузки не входит в разрешённые публичные источники');
  return parsed;
}
async function downloadMod(mod) {
  await ensureData();
  if (!mod.downloadUrl) throw new Error('Для этой карточки нет ссылки на архив. Это демо-элемент или неполные метаданные источника.');
  const url = validateDownloadUrl(mod.downloadUrl);
  // Determine extension from the *original* URL before any redirects — GitHub CDN
  // (objects.githubusercontent.com) rewrites the pathname and loses the extension.
  const extensionFromOriginal = path.extname(url.pathname).toLowerCase();
  if (!['.vpk', '.zip'].includes(extensionFromOriginal)) throw new Error('Поддерживаются только готовые .vpk и .zip архивы');
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Источник вернул HTTP ${response.status}`);
  // validate final redirect host for safety but don't re-check extension there
  validateDownloadUrl(response.url);
  // Стрим на диск с инкрементальным хэшем: архивы до 1 ГБ целиком
  // в память не грузим (иначе OOM роняет весь Electron).
  const tmpFile = path.join(cachePath(), `_dl-${crypto.randomUUID()}.part`);
  const hash = crypto.createHash('sha256');
  let size = 0;
  const fh = await fs.open(tmpFile, 'wx');
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 1024 * 1024 * 1024) throw new Error('Недопустимый размер архива');
      hash.update(chunk);
      await fh.write(chunk);
    }
  } catch (e) { await fh.close().catch(() => {}); await fs.rm(tmpFile, { force: true }).catch(() => {}); throw e; }
  await fh.close();
  if (!size) { await fs.rm(tmpFile, { force: true }).catch(() => {}); throw new Error('Недопустимый размер архива'); }
  const digest = hash.digest('hex');
  const destination = path.join(cachePath(), `${safeId(mod.id)}-${digest.slice(0, 12)}${extensionFromOriginal}`);
  if (!fss.existsSync(destination)) await fs.rename(tmpFile, destination);
  else await fs.rm(tmpFile, { force: true }).catch(() => {});
  // Sidecar с полным хэшем: prepareVpk сверит кэш перед использованием
  await fs.writeFile(destination + '.sha256', digest, 'utf8').catch(() => {});
  invalidateCacheIndex();
  return { file: destination, hash: digest, size };
}
async function findCachedFile(modId) {
  const entries = await cacheIndex();
  return entries.find(x => x.startsWith(`${safeId(modId)}-`) && /\.(vpk|zip)$/i.test(x)) || null;
}
async function findCachedIds(modIds) {
  const ids = Array.isArray(modIds) ? modIds.map(String) : [];
  if (!ids.length) return [];
  const entries = await cacheIndex();
  return ids.filter(id => entries.some(file => file.startsWith(`${safeId(id)}-`) && /\.(vpk|zip)$/i.test(file)));
}
async function listVpkFiles(root) {
  const output = [];
  async function walk(dir) { for (const entry of await fs.readdir(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) await walk(full); else if (entry.isFile() && /\.vpk$/i.test(entry.name)) output.push(full); } }
  await walk(root); return output;
}
function psQuote(p) { return `'${String(p).replace(/'/g, "''")}'`; }
async function listAllFiles(root, limit = 30) {
  const output = [];
  async function walk(dir) {
    if (output.length >= limit) return;
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (output.length >= limit) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) output.push(path.relative(root, full) || entry.name);
    }
  }
  await walk(root); return output;
}
async function expandArchive(zipFile, dest) {
  const inspect = `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead(${psQuote(zipFile)}); try { $z.Entries | ForEach-Object { [PSCustomObject]@{name=$_.FullName;size=$_.Length;externalAttributes=$_.ExternalAttributes} } | ConvertTo-Json -Compress } finally { $z.Dispose() }`;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', inspect], { windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  let entries;
  try { entries = JSON.parse(stdout); } catch { throw new Error('Не удалось проверить содержимое ZIP перед распаковкой'); }
  validateArchiveEntries(Array.isArray(entries) ? entries : [entries]);
  await fs.mkdir(dest, { recursive: true });
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${psQuote(zipFile)} -DestinationPath ${psQuote(dest)} -Force`], { windowsHide: true, timeout: 120000 });
}
// ── Авто-упаковка ассетов без VPK (шрифтовые моды и т.п.) ──────────
// Если в ZIP нет .vpk, но есть файлы ассетов (шрифты, uifont и т.д.),
// собираем из них VPK с правильной внутренней структурой Dota 2.
//
// Поддерживаемые схемы папок внутри ZIP:
//   assets/custom/<file>  — пользовательские заменители  (приоритет 2)
//   assets/default/<file> — оригинальные файлы игры       (приоритет 1)
//   <всё остальное>/<file>— любой файл нужного расширения (приоритет 0)
//
// Все файлы упаковываются в panorama/fonts/<имяфайла> внутри VPK
// — именно там Dota 2 ожидает .otf/.ttf/.uifont (game/dota/panorama/fonts/).
async function buildVpkFromAssets(extractedRoot, outVpkPath) {
  // Рекурсивный обход — собираем только файлы распознанных расширений
  const found = []; // { full, rel }
  async function walkAssets(dir, relBase) {
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel  = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walkAssets(full, rel);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).slice(1).toLowerCase();
        if (ASSET_FONT_EXTS.has(ext)) found.push({ full, rel });
      }
    }
  }
  await walkAssets(extractedRoot, '');
  if (!found.length) return null;

  // Выбираем по одному файлу на каждое нижнерегистровое имя файла:
  // custom (2) > default (1) > прочее (0)
  const priority = rel => {
    const lc = rel.replace(/\\/g, '/').toLowerCase();
    if (/(?:^|\/)assets\/custom\/[^/]+$/.test(lc))  return 2;
    if (/(?:^|\/)assets\/default\/[^/]+$/.test(lc)) return 1;
    return 0;
  };
  const byName = new Map(); // lcBasename → { full, prio }
  for (const f of found) {
    const key = path.basename(f.rel).toLowerCase();
    const p   = priority(f.rel);
    const cur = byName.get(key);
    if (!cur || p > cur.prio) byName.set(key, { full: f.full, prio: p });
  }
  if (!byName.size) return null;

  // Читаем данные и строим записи для buildVpkV1
  const vpkFiles = [];
  for (const { full } of byName.values()) {
    const data = await fs.readFile(full);
    // Source 2 ищет пути в VPK в нижнем регистре; если имя файла из ZIP
    // имеет заглавные буквы (Radiance-Light.otf, Reaver-Regular.otf),
    // путь не совпадёт и шрифт не загрузится — приводим к нижнему регистру.
    vpkFiles.push({ fullPath: `panorama/fonts/${path.basename(full).toLowerCase()}`, data });
  }

  const vpkBuf = buildVpkV1(vpkFiles);
  await fs.writeFile(outVpkPath, vpkBuf);
  return outVpkPath;
}

// ── Поиск и управление файлами шрифтовых модов ─────────────────────
// Шрифты Dota 2 загружаются напрямую из папки game/dota/panorama/fonts.
// Поиск структуры custom/default в архиве мода:
async function findFontModAssets(root) {
  let customDir = null, defaultDir = null;
  const allFonts = [];
  async function walk(dir) {
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const lc = entry.name.toLowerCase();
        const parentLc = path.basename(dir).toLowerCase();
        if (lc === 'custom' && parentLc === 'assets') customDir = full;
        else if (lc === 'default' && parentLc === 'assets') defaultDir = full;
        await walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).slice(1).toLowerCase();
        if (ASSET_FONT_EXTS.has(ext)) allFonts.push({ full, name: entry.name, dir });
      }
    }
  }
  await walk(root);
  if (customDir) {
    const files = (await fs.readdir(customDir).catch(() => []))
      .filter(f => ASSET_FONT_EXTS.has(path.extname(f).slice(1).toLowerCase()));
    if (files.length) return { customDir, defaultDir, files };
  }
  if (allFonts.length) {
    return { customDir: allFonts[0].dir, defaultDir: null, files: allFonts.map(f => f.name) };
  }
  return null;
}

async function ensureDefaultFontsBackup(fallbackSourceDir) {
  const backupDir = fontsBackupPath();
  await fs.mkdir(backupDir, { recursive: true });
  const existing = await fs.readdir(backupDir).catch(() => []);
  if (existing.length >= 40) return backupDir;
  if (fallbackSourceDir && fss.existsSync(fallbackSourceDir)) {
    const entries = await fs.readdir(fallbackSourceDir).catch(() => []);
    for (const file of entries) {
      const src = path.join(fallbackSourceDir, file);
      const dst = path.join(backupDir, file);
      if (!fss.existsSync(dst)) {
        try { await fs.copyFile(src, dst); }
        catch (error) { throw new Error(`Не удалось сохранить резервную копию шрифта ${file}: ${error.message}`, { cause: error }); }
      }
    }
  }
  return backupDir;
}

async function installCustomFonts(customDir, gamePath) {
  const targetDir = path.join(gamePath, 'game', 'dota', 'panorama', 'fonts');
  await fs.mkdir(targetDir, { recursive: true });
  // Очищаем папку от стандартных шрифтов (как делает Install.bat мода)
  for (const f of await fs.readdir(targetDir)) {
    try { await fs.rm(path.join(targetDir, f), { force: true }); }
    catch (error) { throw new Error(`Не удалось удалить старый шрифт ${f}: ${error.message}`, { cause: error }); }
  }
  // Копируем кастомные файлы шрифтов
  const customFiles = await fs.readdir(customDir);
  for (const f of customFiles) {
    try { await fs.copyFile(path.join(customDir, f), path.join(targetDir, f)); }
    catch (error) { throw new Error(`Не удалось установить шрифт ${f}: ${error.message}`, { cause: error }); }
  }
  return customFiles.length;
}

async function restoreDefaultFonts(gamePath) {
  const backupDir = fontsBackupPath();
  const targetDir = path.join(gamePath, 'game', 'dota', 'panorama', 'fonts');
  if (!fss.existsSync(backupDir) || !fss.existsSync(targetDir)) return false;
  const backupFiles = await fs.readdir(backupDir);
  if (!backupFiles.length) return false;
  for (const f of await fs.readdir(targetDir)) {
    try { await fs.rm(path.join(targetDir, f), { force: true }); }
    catch (error) { throw new Error(`Не удалось очистить шрифты перед восстановлением (${f}): ${error.message}`, { cause: error }); }
  }
  for (const f of backupFiles) {
    try { await fs.copyFile(path.join(backupDir, f), path.join(targetDir, f)); }
    catch (error) { throw new Error(`Не удалось восстановить шрифт ${f}: ${error.message}`, { cause: error }); }
  }
  return true;
}
async function extractZipVpk(zipFile, output) {
  await expandArchive(zipFile, output);
  let files = await listVpkFiles(output);
  if (files.length) return files;
  // Вложенные ZIP (мод упакован как zip-в-zip): распаковываем каждый
  // внутренний архив в соседний подкаталог и ищем VPK заново.
  let nested = [];
  try {
    const all = await listAllFiles(output, 200);
    nested = all.filter(f => /\.zip$/i.test(f));
  } catch { nested = []; }
  for (let i = 0; i < nested.length; i++) {
    try { await expandArchive(path.join(output, nested[i]), path.join(output, `__nested_${i}`)); } catch { /* битый вложенный архив — пропускаем */ }
  }
  if (nested.length) files = await listVpkFiles(output);
  if (files.length) return files;
  // Попытка авто-упаковки ассетов (шрифтовые моды без готового VPK):
  // если в архиве есть .ttf/.otf/.uifont и т.д. — строим VPK на лету.
  const autoVpk = path.join(output, '__auto_built.vpk');
  const built = await buildVpkFromAssets(output, autoVpk).catch(() => null);
  if (built) return [built];
  const sample = await listAllFiles(output, 20);
  const hint = sample.length ? ` Содержимое архива: ${sample.join(', ')}.` : ' Архив пуст.';
  throw new Error(`В ZIP не найдены .vpk файлы.${hint} Нужен готовый .vpk (или .zip с .vpk внутри)`);
}
async function prepareVpk(mod, temp) {
  const cached = await findCachedFile(mod.id); if (!cached) throw new Error(`Сначала скачайте «${mod.name}» в локальный кэш`);
  const source = path.join(cachePath(), cached); if (!isSubpath(source, cachePath())) throw new Error('Некорректный путь кэша');
  // Сверяем кэш с хэшем момента скачивания: битый/подменённый файл
  // в cache/ раньше использовался молча. Sidecar может отсутствовать
  // у старых загрузок — тогда пропускаем проверку, но не падаем.
  try {
    const expected = (await fs.readFile(source + '.sha256', 'utf8')).trim();
    if (expected && await hashFile(source) !== expected) {
      await fs.rm(source, { force: true }).catch(() => {});
      await fs.rm(source + '.sha256', { force: true }).catch(() => {});
      throw new Error(`Кэш «${mod.name}» повреждён — скачайте заново`);
    }
  } catch (e) { if (e.message && e.message.startsWith('Кэш')) throw e; }
  if (/\.vpk$/i.test(source)) return [source];
  const modTemp = path.join(temp, safeId(mod.id));
  const vpks = await extractZipVpk(source, modTemp);
  // Проверяем наличие шрифтовых ассетов и стаджим их для набора
  const fontAssets = await findFontModAssets(modTemp).catch(() => null);
  if (fontAssets && fontAssets.customDir) {
    const fontStaging = path.join(temp, '__font_assets');
    await fs.mkdir(path.join(fontStaging, 'custom'), { recursive: true });
    for (const f of fontAssets.files) {
      await fs.copyFile(path.join(fontAssets.customDir, f), path.join(fontStaging, 'custom', f));
    }
    if (fontAssets.defaultDir) {
      await fs.mkdir(path.join(fontStaging, 'default'), { recursive: true });
      const defFiles = await fs.readdir(fontAssets.defaultDir).catch(() => []);
      for (const f of defFiles) {
        await fs.copyFile(path.join(fontAssets.defaultDir, f), path.join(fontStaging, 'default', f));
      }
      await ensureDefaultFontsBackup(fontAssets.defaultDir);
    }
    await writeJson(path.join(fontStaging, 'info.json'), { modId: mod.id, modName: mod.name });
  }
  return vpks;
}
async function applySet({ mods, gamePath }) {
  return withCatalogLock(async () => {
  if (!Array.isArray(mods) || !mods.length) throw new Error('Корзина пуста');
  const resolvedGamePath = path.resolve(gamePath || (await settings()).gamePath);
  if (!fss.existsSync(resolvedGamePath)) throw new Error('Папка Dota 2 не найдена — укажите путь в настройках');
  const temp = path.join(dataPath(), `transaction-${crypto.randomUUID()}`);
  const setId = `set-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const target = path.join(gameModRoot(resolvedGamePath), 'sets', setId, 'pak-slots');
  const setRoot = path.dirname(target);
  const installed = [];
  await fs.mkdir(temp, { recursive: true });
  try {
    const files = [];
    for (const mod of mods) for (const vpk of await prepareVpk(mod, temp)) files.push({ mod, vpk });
    if (!files.length) throw new Error('Нет готовых VPK для установки');
    // The set directory itself must be new. This avoids ever adopting or overwriting a foreign folder.
    await fs.mkdir(path.dirname(setRoot), { recursive: true });
    await fs.mkdir(setRoot);
    await fs.mkdir(target);
    // Staged-запись ДО копирования: краш в щели «копии есть, манифеста нет»
    // оставляет опознаваемый staged-сироту вместо немого мусора.
    const manifests = await readJson(manifestPath(), []);
    const manifest = { schema: 1, id: setId, gamePath: resolvedGamePath, target, createdAt: new Date().toISOString(), files: [], state: 'staged' };
    manifests.unshift(manifest); await writeJson(manifestPath(), manifests);
    for (let index = 0; index < files.length; index++) {
      const file = files[index]; const name = `pak${String(index + 1).padStart(3, '0')}_${safeId(file.mod.id)}.vpk`; const destination = path.join(target, name);
      if (fss.existsSync(destination)) throw new Error(`Безопасная остановка: уже существует ${name}`);
      await fs.copyFile(file.vpk, destination, fss.constants.COPYFILE_EXCL);
      installed.push({ file: destination, sha256: await hashFile(destination), modId: file.mod.id, modName: file.mod.name, slot: index + 1 });
    }
    // Сохраняем ассеты шрифтового мода в папку набора setRoot/font-assets
    const fontStaging = path.join(temp, '__font_assets');
    if (fss.existsSync(path.join(fontStaging, 'custom'))) {
      const setFontDir = path.join(setRoot, 'font-assets');
      await fs.mkdir(path.join(setFontDir, 'custom'), { recursive: true });
      for (const f of await fs.readdir(path.join(fontStaging, 'custom')).catch(() => [])) {
        await fs.copyFile(path.join(fontStaging, 'custom', f), path.join(setFontDir, 'custom', f)).catch(() => {});
      }
      if (fss.existsSync(path.join(fontStaging, 'default'))) {
        await fs.mkdir(path.join(setFontDir, 'default'), { recursive: true });
        for (const f of await fs.readdir(path.join(fontStaging, 'default')).catch(() => [])) {
          await fs.copyFile(path.join(fontStaging, 'default', f), path.join(setFontDir, 'default', f)).catch(() => {});
        }
      }
      manifest.hasFonts = true;
      manifest.fontMod = await readJson(path.join(fontStaging, 'info.json'), null);
    }
    manifest.files = installed; manifest.state = 'applied';
    await writeJson(manifestPath(), manifests);
    return manifest;
  } catch (error) {
    // Transaction cleanup is deliberately file-by-file and hash-checked: foreign files are never removed.
    for (const entry of installed) {
      if (fss.existsSync(entry.file) && await hashFile(entry.file).catch(() => null) === entry.sha256) await fs.rm(entry.file).catch(() => {});
    }
    for (const dir of [target, setRoot]) { try { await fs.rmdir(dir); } catch { /* directory is not ours/empty */ } }
    // Убираем staged-запись, чтобы оборванный набор не висел в истории
    try {
      const manifests = await readJson(manifestPath(), []);
      await writeJson(manifestPath(), manifests.filter(m => m.id !== setId || m.state === 'applied'));
    } catch { /* история недоступна — не маскируем исходную ошибку */ }
    throw error;
  }
  finally { await fs.rm(temp, { recursive: true, force: true }).catch(() => {}); }
  });
}
async function extendSet({ setId, mods, gamePath }) {
  return withCatalogLock(async () => {
    if (!setId || !Array.isArray(mods) || !mods.length) throw new Error('Выберите хотя бы один новый мод');
    const manifests = await readJson(manifestPath(), []);
    const manifest = manifests.find(item => item.id === setId && item.state === 'applied');
    if (!manifest) throw new Error('Текущий набор больше недоступен — соберите новый набор');
    const resolvedGamePath = path.resolve(gamePath || manifest.gamePath || (await settings()).gamePath);
    if (path.resolve(manifest.gamePath || resolvedGamePath) !== resolvedGamePath) throw new Error('Путь к игре изменился — выберите текущий набор заново');
    if (!isSubpath(manifest.target, gameModRoot(resolvedGamePath))) throw new Error('Папка набора находится вне защищённой папки приложения');
    for (const entry of manifest.files) {
      if (!isSubpath(entry.file, manifest.target) || !fss.existsSync(entry.file) || await hashFile(entry.file) !== entry.sha256)
        throw new Error(`Файл текущего набора изменён или пропал: ${path.basename(entry.file)}`);
    }
    const existingIds = new Set(manifest.files.map(file => file.modId).filter(Boolean));
    const duplicate = mods.find(mod => existingIds.has(mod.id));
    if (duplicate) throw new Error(`«${duplicate.name}» уже есть в текущем наборе`);
    const temp = path.join(dataPath(), `transaction-${crypto.randomUUID()}`);
    const added = [];
    await fs.mkdir(temp, { recursive: true });
    try {
      const files = [];
      for (const mod of mods) for (const vpk of await prepareVpk(mod, temp)) files.push({ mod, vpk });
      if (!files.length) throw new Error('Нет готовых VPK для добавления');
      const maxSlot = manifest.files.reduce((max, file) => Math.max(max, Number(file.slot) || 0), 0);
      for (let index = 0; index < files.length; index++) {
        const item = files[index];
        const slot = maxSlot + index + 1;
        const name = `pak${String(slot).padStart(3, '0')}_${safeId(item.mod.id)}.vpk`;
        const destination = path.join(manifest.target, name);
        await fs.copyFile(item.vpk, destination, fss.constants.COPYFILE_EXCL);
        added.push({ file: destination, sha256: await hashFile(destination), modId: item.mod.id, modName: item.mod.name, slot });
      }
      manifest.files.push(...added);
      manifest.updatedAt = new Date().toISOString();
      await writeJson(manifestPath(), manifests);
      return { ...manifest, addedFiles: added };
    } catch (error) {
      for (const entry of added)
        if (fss.existsSync(entry.file) && await hashFile(entry.file).catch(() => null) === entry.sha256) await fs.rm(entry.file).catch(() => {});
      throw error;
    } finally { await fs.rm(temp, { recursive: true, force: true }).catch(() => {}); }
  });
}
async function rollback(setId) {
  const rec = await readJson(installRecordPath(), null);
  const manifestsBefore = await readJson(manifestPath(), []);
  const savedSet = manifestsBefore.find(item => item.id === setId);
  if (!savedSet) {
    if (rec && rec.setId === setId) await fs.rm(installRecordPath(), { force: true }).catch(() => {});
    throw new Error('Набор уже удалён или запись о нём устарела — обновите историю наборов');
  }
  if (savedSet.state !== 'applied') {
    if (rec && rec.setId === setId) await fs.rm(installRecordPath(), { force: true }).catch(() => {});
    return { set: savedSet, skipped: [], failed: [] };
  }
  const isInstalled = Boolean(rec && rec.setId === setId);
  const apps = isInstalled ? await ensureAppsClosed(null) : { steamWasRunning: false };
  try {
    return await withCatalogLock(async () => {
    const manifests = await readJson(manifestPath(), []); const set = manifests.find(x => x.id === setId && x.state === 'applied');
    if (!set) throw new Error('Набор уже изменён — обновите историю наборов');
    const resolvedGame = path.resolve(set.gamePath || (await settings()).gamePath);

    // Если этот набор сейчас был установлен в игре — снимаем его из игры и восстанавливаем дефолтные шрифты
    if (isInstalled) {
      await removeInstallRecord(resolvedGame);
    } else if (set.hasFonts) {
      await restoreDefaultFonts(resolvedGame);
    }
    // Пофайлово и живуче: одна блокировка (Steam держит файл) больше не
    // абортит весь откат с потерей отчёта — копим failed, манифест сохраняем всегда.
    const skipped = []; const failed = [];
    for (const entry of set.files) {
      if (!isSubpath(entry.file, set.target) || !fss.existsSync(entry.file)) continue;
      let cur = null;
      try { cur = await hashFile(entry.file); }
      catch { failed.push(path.basename(entry.file)); continue; }
      if (cur !== entry.sha256) { skipped.push(path.basename(entry.file)); continue; }
      try { await fs.rm(entry.file); }
      catch { failed.push(path.basename(entry.file)); }
    }

    // Удаляем font-assets в папке набора
    const setFontDir = path.join(path.dirname(set.target), 'font-assets');
    await fs.rm(setFontDir, { recursive: true, force: true }).catch(() => {});

    // Only remove our empty directories; never recursively remove a directory with unknown content.
    for (const dir of [set.target, path.dirname(set.target), path.dirname(path.dirname(set.target))]) { try { await fs.rmdir(dir); } catch { break; } }
    // Частичный откат (есть failed) оставляет набор applied — повторный вызов
    // продолжит с места обрыва вместо старта с нуля.
    if (!failed.length) { set.state = 'rolled-back'; set.rolledBackAt = new Date().toISOString(); }
    set.skipped = skipped; set.failed = failed;
    await writeJson(manifestPath(), manifests);
    return { set, skipped, failed };
    });
  } finally {
    if (apps.steamWasRunning) await relaunchSteam(null).catch(() => false);
  }
}
async function removeModFromSet({ setId, modId }) {
  if (!setId || !modId) throw new Error('Не выбран мод для удаления');
  const rec = await readJson(installRecordPath(), null);
  const isInstalled = Boolean(rec && rec.setId === setId);
  const apps = isInstalled ? await ensureAppsClosed(null) : { steamWasRunning: false };
  try {
    return await withCatalogLock(async () => {
      const manifests = await readJson(manifestPath(), []);
      const set = manifests.find(item => item.id === setId && item.state === 'applied');
      if (!set) throw new Error('Набор не найден или уже удалён');
      const setGamePath = path.resolve(set.gamePath || (await settings()).gamePath);
      if (!isSubpath(set.target, gameModRoot(setGamePath))) throw new Error('Папка набора находится вне защищённой папки приложения');
      const removed = set.files.filter(file => String(file.modId) === String(modId));
      if (!removed.length) throw new Error('Этот мод не найден в наборе');
      if (removed.length === set.files.length) throw new Error('Последний мод нельзя удалить отдельно — удалите весь набор');
      const orderedFiles = [...set.files].sort((a, b) => a.slot - b.slot);
      const removedIndexes = new Set(removed.map(entry => orderedFiles.indexOf(entry)));
      for (const entry of set.files) {
        if (!isSubpath(entry.file, set.target) || !fss.existsSync(entry.file)) throw new Error(`Файл набора пропал: ${path.basename(entry.file)}`);
        if (await hashFile(entry.file) !== entry.sha256) throw new Error(`Файл набора изменён: ${path.basename(entry.file)}`);
      }
      // Backup must live next to the set: Steam and app data can be on
      // different drives, and Windows cannot rename files across volumes.
      const backup = path.join(path.dirname(set.target), `.remove-${crypto.randomUUID()}`);
      const moved = [];
      const overlayMoved = [];
      await fs.mkdir(backup, { recursive: true });
      try {
        if (isInstalled) {
          const record = await readJson(installRecordPath(), null);
          const installs = record?.installs || (record?.dir ? [{ dir: record.dir, files: record.files || [] }] : []);
          for (const slot of installs) {
            if (!slot?.dir || !isTrustedOverlayDir(slot.dir)) throw new Error(`Подозрительная запись прошлой установки (${slot?.dir || 'пустой путь'})`);
            const names = [...removedIndexes].map(index => slot.files?.[index]).filter(Boolean);
            if (names.length !== removed.length) throw new Error('Запись установки не соответствует составу набора — переустановите набор целиком');
            for (const name of names) {
              if (!/^pak\d+_dir\.vpk$/i.test(name)) throw new Error(`Недопустимое имя файла установки: ${name}`);
              const source = path.join(path.resolve(slot.dir), name);
              if (!fss.existsSync(source)) throw new Error(`Файл установки пропал: ${name}`);
              const target = path.join(backup, `${path.basename(slot.dir)}-${name}`);
              await fs.rename(source, target);
              overlayMoved.push({ source, target });
            }
          }
        }
        for (const entry of removed) {
          const backupFile = path.join(backup, path.basename(entry.file));
          await fs.rename(entry.file, backupFile);
          moved.push({ entry, backupFile });
        }
        set.files = set.files.filter(file => String(file.modId) !== String(modId));
        if (set.fontMod && String(set.fontMod.modId) === String(modId)) {
          await fs.rm(path.join(path.dirname(set.target), 'font-assets'), { recursive: true, force: true });
          set.hasFonts = false;
          delete set.fontMod;
        }
        if (isInstalled) {
          const record = await readJson(installRecordPath(), null);
          const installs = record?.installs || (record?.dir ? [{ dir: record.dir, files: record.files || [] }] : []);
          for (const slot of installs)
            slot.files = slot.files.filter((_, index) => !removedIndexes.has(index));
          await writeJson(installRecordPath(), {
            ...record,
            schema: 2,
            installs,
            fontsInstalled: Boolean(record?.fontsInstalled && set.hasFonts),
            fileCount: set.files.length,
            setId
          });
          if (record?.fontsInstalled && !set.hasFonts) await restoreDefaultFonts(setGamePath);
        }
        set.updatedAt = new Date().toISOString();
        await writeJson(manifestPath(), manifests);
        return { set, removed: removed.length, wasInstalled: isInstalled };
      } catch (error) {
        for (const item of overlayMoved) await fs.rename(item.target, item.source).catch(() => {});
        for (const item of moved) await fs.rename(item.backupFile, item.entry.file).catch(() => {});
        throw error;
      } finally { await fs.rm(backup, { recursive: true, force: true }).catch(() => {}); }
    });
  } finally {
    if (apps.steamWasRunning) await relaunchSteam(null).catch(() => false);
  }
}
// Чистка истории: выкидываем записи откаченных/оборванных наборов и сносим
// их папки sets/<id> (файлы VPK уже удалены откатом, остаётся пустое дерево).
// Применённые наборы НЕ трогаем. Папку сносим только если она строго внутри
// Dota2CosmeticMods/sets/<id> — чужое не задеваем даже при битой записи.
async function purgeHistory() {
  return withCatalogLock(async () => {
    const manifests = await readJson(manifestPath(), []);
    const keep = [], drop = [];
    for (const m of manifests) ((m && m.state === 'applied' ? keep : drop)).push(m);
    let dirsRemoved = 0;
    for (const m of drop) {
      try {
        const gp = m && m.gamePath ? path.resolve(String(m.gamePath)) : null;
        const setDir = m && m.target ? path.resolve(path.dirname(String(m.target))) : null; // .../sets/<id>
        if (gp && setDir && path.basename(path.dirname(setDir)) === 'sets' &&
            isSubpath(setDir, path.resolve(gameModRoot(gp)))) {
          await fs.rm(setDir, { recursive: true, force: true });
          dirsRemoved++;
        }
      } catch { /* битую запись всё равно выкидываем ниже */ }
    }
    await writeJson(manifestPath(), keep);
    return { removed: drop.length, dirsRemoved };
  });
}
// Стартовый sweep: ws-tmp-* после убитого процесса/краша посреди сборки.
// Трогаем только свои префиксные папки в СВОЕЙ папке данных.
async function sweepTempDirs() {
  try {
    const root = dataPath();
    const names = await fs.readdir(root).catch(() => []);
    for (const n of names)
      if (/^ws-tmp-[0-9a-f-]{8,}$/i.test(n))
        await fs.rm(path.join(root, n), { recursive: true, force: true }).catch(() => {});
  } catch { /* чистка не должна ронять старт */ }
}
async function findVpkTool(gamePath) { for (const candidate of [path.join(gamePath, 'game', 'bin', 'win64', 'vpk.exe'), path.join(gamePath, 'game', 'bin', 'vpk.exe'), path.join(gamePath, 'bin', 'vpk.exe')]) if (fss.existsSync(candidate)) return candidate; return null; }

// ── Установка набора в игру (папка озвучки game/dota_*) ────────────
// Игра монтирует папку актуального языка озвучки (dota_russian,
// dota_english, ...). Трюк с выдуманным языком (-language mods + папка
// game/dota_mods) УМЕР в июле 2026: -language теперь задаёт язык
// в настройках игры и ничего не монтирует. Поэтому кладём моды как
// pak02_dir.vpk... в папку реальной озвучки (pak01 там — файл Valve).
// Прошлую нашу установку снимаем по записи, чужое не трогаем.
function gameLangFolders(gamePath) {
  let entries = [];
  try { entries = fss.readdirSync(path.join(gamePath, 'game'), { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(e => e.isDirectory() && /^dota_[a-z]+$/i.test(e.name) && e.name.toLowerCase() !== 'dota_mods' && fss.existsSync(path.join(gamePath, 'game', e.name, 'pak01_dir.vpk')))
    .map(e => e.name);
}
function resolveOverlayDir(gamePath, voiceFolder) {
  const vf = String(voiceFolder || '');
  if (vf && /^dota_[a-z]+$/i.test(vf)) {
    const dir = path.join(gamePath, 'game', vf);
    if (!fss.existsSync(path.join(dir, 'pak01_dir.vpk'))) throw new Error(`В папке ${vf} нет pak01_dir.vpk — сверьте язык озвучки в настройках Доты и программы`);
    return dir;
  }
  const c = gameLangFolders(gamePath);
  if (c.length === 1) return path.join(gamePath, 'game', c[0]);
  if (!c.length) throw new Error('Не найдены языковые папки Доты (dota_russian/...) — проверьте путь к игре в настройках');
  throw new Error(`Найдено несколько папок озвучки (${c.join(', ')}) — выберите вашу в ⚙ Настройках`);
}
const installRecordPath = () => path.join(dataPath(), 'overlay-install.json');
// Прошлая установка снимается только из доверенного места: game/dota_mods
// (наш legacy) или game/dota_<язык> с pak01_dir.vpk на месте. Иначе запись
// битая/чужая — отказываемся, а не трём файлы по пути из JSON.
function isTrustedOverlayDir(dir) {
  try {
    const resolved = path.resolve(dir);
    if (path.basename(path.dirname(resolved)).toLowerCase() !== 'game') return false;
    const base = path.basename(resolved).toLowerCase();
    if (base === 'dota_mods') return true;
    return /^dota_[a-z]+$/.test(base) && fss.existsSync(path.join(resolved, 'pak01_dir.vpk'));
  } catch { return false; }
}
async function removeInstallRecord(gamePathFallback) {
  const prev = await readJson(installRecordPath(), null);
  if (!prev) return 0;
  // Если были установлены кастомные шрифты — восстанавливаем оригинальные шрифты игры
  if (prev.fontsInstalled) {
    const gp = gamePathFallback || (await settings().then(s => s.gamePath).catch(() => null));
    if (gp) await restoreDefaultFonts(gp).catch(() => {});
  }
  // Нормализуем: старый формат {dir, files} → новый [{dir, files}]
  const installs = prev.installs || (prev.dir ? [{ dir: prev.dir, files: prev.files || [] }] : []);
  let removed = 0;
  for (const slot of installs) {
    if (!slot || !slot.dir) continue;
    if (!isTrustedOverlayDir(slot.dir))
      throw new Error(`Подозрительная запись прошлой установки (${slot.dir}) — уберите файлы вручную и удалите overlay-install.json в папке данных`);
    for (const f of slot.files || []) {
      if (!/^pak\d+_dir\.vpk$/i.test(f)) continue;
      await fs.rm(path.join(path.resolve(slot.dir), f)).then(() => removed++, () => {});
    }
  }
  return removed;
}
async function installSetToGame(setId) {
  // Префлайт ПЕРВЫМ: копирование в папки игры при запущенных Steam/Dota 2
  // даст файловые блокировки. Авто-режим закрывает сам + перезапускает Steam.
  const apps = await ensureAppsClosed(null);
  try { return await installSetToGameInner(setId); }
  finally { if (apps.steamWasRunning) await relaunchSteam(null).catch(() => false); }
}
async function installSetToGameInner(setId) {
  return withCatalogLock(async () => {
  const manifests = await readJson(manifestPath(), []);
  const set = manifests.find(x => x.id === setId && x.state === 'applied');
  if (!set) throw new Error('Набор не найден или уже откачен — примените его заново');
  const gamePath = path.resolve(set.gamePath || (await settings()).gamePath);
  if (!fss.existsSync(gamePath)) throw new Error('Папка Dota 2 не найдена — укажите путь в настройках');
  const files = [...(set.files || [])].sort((a, b) => a.slot - b.slot);
  if (!files.length) throw new Error('В наборе нет файлов');
  const currentSetId = await activeSetId();
  if (currentSetId === setId) throw new Error('Этот набор уже установлен в игре');

  // Устанавливаем во ВСЕ языковые папки сразу: шрифты и скины не должны
  // зависеть от текущего языка интерфейса. Если у пользователя только
  // dota_russian — устанавливаем только туда; если ещё и dota_english — туда тоже.
  const langDirs = gameLangFolders(gamePath).map(name => path.join(gamePath, 'game', name));
  if (!langDirs.length)
    throw new Error('Не найдены языковые папки Доты (dota_russian/...) — проверьте путь к игре в настройках');

  // Проверяем все источники до удаления предыдущей установки: ошибка здесь
  // не должна оставлять пользователя без рабочего набора.
  for (const f of files) {
    if (!isSubpath(f.file, set.target) || !fss.existsSync(f.file))
      throw new Error(`Файл набора пропал: ${path.basename(f.file)}`);
    if (await hashFile(f.file) !== f.sha256)
      throw new Error(`Файл набора изменён: ${path.basename(f.file)}`);
  }

  // Снимаем прошлую нашу установку + чистим legacy dota_mods
  const prevRec = await readJson(installRecordPath(), null);
  await removeInstallRecord();
  for (const f of await fs.readdir(path.join(gamePath, 'game', 'dota_mods')).catch(() => []))
    if (/^pak\d+_dir\.vpk$/i.test(f)) await fs.rm(path.join(gamePath, 'game', 'dota_mods', f)).catch(() => {});

  const installs = []; // [{dir, files:[filename]}] — будет записано в installRecordPath
  try {
    for (const dir of langDirs) {
      await fs.mkdir(dir, { recursive: true });
      if (!fss.existsSync(path.join(dir, 'pak01_dir.vpk')))
        throw new Error(`В папке ${path.basename(dir)} нет pak01_dir.vpk — проверьте путь к игре`);

      let n = 2;
      const taken = new Set(await fs.readdir(dir).catch(() => []));
      while (taken.has(`pak${String(n).padStart(2, '0')}_dir.vpk`)) { n++; if (n > 99) throw new Error(`В папке ${path.basename(dir)} нет свободных pak-слотов`); }
      if (n - 2 + files.length > 99) throw new Error('Слишком много VPK для оверлея (максимум 99)');

      const dirInstalled = [];
      const slot = { dir, files: dirInstalled };
      installs.push(slot);
      for (let i = 0; i < files.length; i++) {
        const dest = path.join(dir, `pak${String(n + i).padStart(2, '0')}_dir.vpk`);
        await fs.copyFile(files[i].file, dest);
        if (await hashFile(dest) !== files[i].sha256) throw new Error(`Ошибка записи: ${path.basename(dest)}`);
        dirInstalled.push(path.basename(dest));
      }
    }
  } catch (e) {
    // Установка охватывает несколько языковых каталогов: при сбое в одном
    // из них удаляем уже скопированные файлы во всех каталогах.
    for (const slot of installs)
      for (const name of slot.files)
        if (/^pak\d+_dir\.vpk$/i.test(name))
          await fs.rm(path.join(slot.dir, name)).catch(() => {});
    throw e;
  }

  // Управление шрифтами интерфейса: если в наборе есть кастомные шрифты — устанавливаем
  const setFontDir = path.join(path.dirname(set.target), 'font-assets');
  let fontsInstalled = false;
  if (fss.existsSync(path.join(setFontDir, 'custom'))) {
    await installCustomFonts(path.join(setFontDir, 'custom'), gamePath);
    fontsInstalled = true;
  } else if (prevRec && prevRec.fontsInstalled) {
    await restoreDefaultFonts(gamePath);
  }

  // Новый формат записи: {schema:2, installs:[{dir,files}], fontsInstalled, setId}
  await writeJson(installRecordPath(), { schema: 2, installs, fontsInstalled, setId, fileCount: files.length });
  const prevDirChanged = Boolean(prevRec && (prevRec.dir || (prevRec.installs || [])[0]?.dir) &&
    !installs.some(s => path.resolve(s.dir) === path.resolve(prevRec.dir || (prevRec.installs || [])[0]?.dir || '')));
  return { dirs: langDirs.map(d => path.basename(d)), files: installs[0]?.files.map(f => ({ name: f, modName: '' })) || [], prevDirChanged, fontsInstalled };
  });
}
// Какие моды физически лежат в игре: запись установки -> манифест -> modId.
// Живым считаем только полный комплект (все файлы записи на месте):
// один выживший файл после ручной чистки — не «установлено», иначе UI врёт
// и deleteWorkshopMod ложно блокирует удаление.
async function installedModIds() {
  const rec = await readJson(installRecordPath(), null);
  if (!rec) return [];
  // Нормализуем форматы: старый {dir,files} и новый {installs:[{dir,files}]}
  const installs = rec.installs || (rec.dir ? [{ dir: rec.dir, files: rec.files || [] }] : []);
  // «Установлено» = хотя бы один слот полностью на месте
  const alive = installs.some(slot => {
    const files = slot && slot.files || [];
    return files.length > 0 && files.every(f => {
      try { return fss.existsSync(path.join(slot.dir, f)); } catch { return false; }
    });
  });
  if (!alive) return [];
  const manifests = await readJson(manifestPath(), []);
  const set = manifests.find(x => x.id === rec.setId);
  if (!set) return [];
  const fileCount = Number.isInteger(rec.fileCount) ? rec.fileCount : set.files.length;
  return [...new Set(set.files.slice(0, fileCount).map(f => f.modId).filter(Boolean))];
}
async function activeSetId() {
  const rec = await readJson(installRecordPath(), null);
  if (!rec || !rec.setId) return null;
  const installs = rec.installs || (rec.dir ? [{ dir: rec.dir, files: rec.files || [] }] : []);
  const alive = installs.some(slot => {
    const files = slot && slot.files || [];
    return files.length > 0 && files.every(file => fss.existsSync(path.join(slot.dir, file)));
  });
  return alive ? String(rec.setId) : null;
}
// Удаление скачанного D2PFX из кэша (освободить место). Безопасно:
// применённые наборы самодостаточны (копии в pak-slots), файлы в игре не трогаем.
// Копии мастерской (*-workshop.vpk) не наши — их удаляет только deleteWorkshopMod.
async function deleteCachedMod(modId) {
  return withCatalogLock(async () => {
  const id = String(modId || '');
  const prefix = `${safeId(id)}-`;
  let entries = [];
  try { entries = await fs.readdir(cachePath()); } catch { entries = []; }
  let removed = 0;
  for (const f of entries) {
    if (!f.startsWith(prefix) || !/\.(vpk|zip)$/i.test(f)) continue;
    if (/-workshop\.vpk$/i.test(f)) continue;
    await fs.rm(path.join(cachePath(), f)).then(() => removed++, () => {});
    await fs.rm(path.join(cachePath(), f + '.sha256')).catch(() => {}); // sidecar хэша
  }
  if (!removed) throw new Error('Файл в кэше не найден — возможно, уже удалён');
  invalidateCacheIndex();
  return { removed };
  });
}
// Удаление своей сборки мастерской: VPK + копия в кэше + карточка каталога.
// Блокируем, пока мод физически в игре — иначе в папке озвучки останутся сироты.
// Мьютекс + повторная проверка installedModIds внутри лока: удаление
// во время установки больше не копирует половинный VPK со стёртой карточкой.
async function deleteWorkshopMod(modId) {
  return withCatalogLock(async () => {
  const id = String(modId || '');
  if ((await installedModIds()).includes(id))
    throw new Error('Мод сейчас установлен в игре — сначала уберите его (История → Очистить dota_mods)');
  const catalogFile = path.join(cachePath(), 'catalog.json');
  const catalog = await readJson(catalogFile, []);
  const entry = catalog.find(m => m && m.id === id);
  if (!entry || !isWorkshopEntry(entry)) throw new Error('Сборка мастерской не найдена (чужие карточки удалять нельзя)');
  // Паранойя: трём localVpk только внутри нашей папки workshop
  const wsDir = path.resolve(workshopPath());
  if (entry.localVpk && isSubpath(path.resolve(entry.localVpk), wsDir))
    await fs.rm(entry.localVpk).catch(() => {});
  await fs.rm(path.join(cachePath(), `${safeId(id)}-workshop.vpk`)).catch(() => {});
  invalidateCacheIndex();
  await writeJson(catalogFile, catalog.filter(m => !(m && m.id === id)));
  return { name: entry.name || id };
  });
}
// Дубль сборки мастерской: те же исходники + тот же оттенок.
// Старые записи без buildSig не матчатся (сигнатуры тогда не писали) — честно молчим.
async function findDuplicateBuild(paths, hue) {
  const sig = workshopBuildSig(paths, hue);
  const dup = (await readLocalWorkshopMods()).find(m => m.buildSig === sig);
  return dup ? { id: dup.id, name: dup.name } : null;
}
// Убрать моды из игры: удаляем файлы из записи установки (включая шрифты) + legacy dota_mods
async function clearGameOverlay(gamePath) {
  const apps = await ensureAppsClosed(null).catch(() => ({ steamWasRunning: false }));
  try {
    return await withCatalogLock(async () => {
    const gamePathResolved = path.resolve(gamePath || (await settings()).gamePath);
    let removed = await removeInstallRecord(gamePathResolved);
    // Всегда гарантированно восстанавливаем оригинальные шрифты игры
    await restoreDefaultFonts(gamePathResolved);
    const legacy = path.join(gamePathResolved, 'game', 'dota_mods');
    for (const f of await fs.readdir(legacy).catch(() => []))
      if (/^pak\d+_dir\.vpk$/i.test(f)) { await fs.rm(path.join(legacy, f)).then(() => removed++, () => {}); }
    return { dir: legacy, removed };
    });
  } finally {
    if (apps.steamWasRunning) await relaunchSteam(null).catch(() => false);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  WORKSHOP PIPELINE — кастомные эффекты частиц
// ═══════════════════════════════════════════════════════════════════

const workshopPath = () => path.join(dataPath(), 'workshop');
const toolsPath   = () => path.join(dataPath(), 'tools');
// VRF ≥ ~13.x поставляет Source2Viewer-CLI.exe (cli-windows-x64.zip),
// старые релизы — Decompiler.exe. Принимаем оба имени.
function vrfExeCandidates() {
  const dir = path.join(toolsPath(), 'vrf');
  return [path.join(dir, 'Source2Viewer-CLI.exe'), path.join(dir, 'Decompiler.exe')];
}
function vrfExePath() {
  for (const c of vrfExeCandidates()) if (fss.existsSync(c)) return c;
  return vrfExeCandidates()[0];
}

const VRF_RELEASES_API = 'https://api.github.com/repos/ValveResourceFormat/ValveResourceFormat/releases/tags/20.0';
const VRF_RELEASE_TAG = '20.0';
const VRF_ASSET_NAME = 'cli-windows-x64.zip';
const VRF_ASSET_SHA256 = 'd32ab327b8bbb42a2528866afb03bb582bdb779d0005488da32b90292afd3ff5';

// ── CRC-32 (нужен для VPK V1 формата) ──────────────────────────────
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ b) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── VPK V1 builder (pure Node.js, без внешних утилит) ──────────────
// files: [{ fullPath: 'particles/econ/axe/foo.vpcf', data: Buffer }]
function buildVpkV1(files) {
  const byExt = new Map();
  for (const f of files) {
    const parts = f.fullPath.replace(/\\/g, '/').split('/');
    const basename = parts.pop();
    const dot = basename.lastIndexOf('.');
    const ext = dot >= 0 ? basename.slice(dot + 1) : '';
    const name = dot >= 0 ? basename.slice(0, dot) : basename;
    const dir = parts.join('/') || ' ';
    if (!byExt.has(ext)) byExt.set(ext, new Map());
    const byDir = byExt.get(ext);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push({ name, data: f.data });
  }
  const tParts = [], dParts = [];
  let dOff = 0;
  const wStr = s => tParts.push(Buffer.from(s + '\0', 'utf8'));
  const wU32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); tParts.push(b); };
  const wU16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xFFFF); tParts.push(b); };
  for (const [ext, dirs] of byExt) {
    wStr(ext);
    for (const [dir, entries] of dirs) {
      wStr(dir);
      for (const { name, data } of entries) {
        wStr(name);
        wU32(crc32(data));
        wU16(0);       // SmallData size
        wU16(0x7FFF);  // embedded in dir VPK
        wU32(dOff);    // data section offset
        wU32(data.length);
        wU16(0xFFFF);  // entry terminator
        dParts.push(data); dOff += data.length;
      }
      wStr(''); // end of filenames for this path
    }
    wStr(''); // end of paths for this extension
  }
  wStr(''); // end of extensions
  const tree = Buffer.concat(tParts);
  const data = Buffer.concat(dParts);
  const hdr  = Buffer.alloc(12);
  hdr.writeUInt32LE(0x55AA1234, 0); // VPK signature
  hdr.writeUInt32LE(1, 4);           // version 1
  hdr.writeUInt32LE(tree.length, 8); // tree size
  return Buffer.concat([hdr, tree, data]);
}

// ── HSV перекраска VPCF ─────────────────────────────────────────────
function rgb2hsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d + 6) % 6 / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h, max === 0 ? 0 : d / max, max];
}
function hsv2rgb(h, s, v) {
  const i = Math.floor(h * 6) % 6, f = h * 6 - Math.floor(h * 6);
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  return [[v,t,p],[q,v,p],[p,v,t],[p,q,v],[t,p,v],[v,p,q]][i];
}
// ── Применить HSV-сдвиг оттенка ко всем цветовым полям .vpcf ────────
// Семантика сверена с референсом h6rd/VPCF-Editor (src/color_parser.py):
//  - ключ цвета = любое поле со словом color/colour (фикс-список имён
//    неизбежно отстаёт от схемы Valve);
//  - в [...] должно быть ровно 3-4 числа, иначе блок не трогаем;
//  - всё остальное внутри скобок (кроме //-комментариев) = блок скипается;
//  - стиль чисел оригинала (int/float, разрядность) сохраняется.
// Отклонения от референса (осознанные, для автокрасилки):
//  - скобки {...} наряду с [...] (в KV3 встречаются оба);
//  - ключи в кавычках ("m_Color" = ...) — в KV3 легальны;
//  - запятые между компонентами не обязательны: референс принимает [1 0 0]
//    (remainder пуст), мы раньше требовали запятые и такие блоки теряли;
//  - вложенные тройки градиентов красятся (см. recolorGradientBlocks);
//  - смешанный [255, 0.5, 0] красится в шкале 0-255 (референс такого не выдаёт,
//    а трактовка «всё float» чернила бы эффект);
//  - мини-skip-лист НЕ-цветов (референс красит всё со словом color, но
//    m_ColorWeights = {1,1,1} из реальных файлов — веса, их портить нельзя).
// Возвращает { text, replaced, total }: сколько блоков найдено и сколько
// реально перекрашено (остальные — серые/прозрачные/nan/не-цвета).
const COLOR_KEY_RE = /colou?r/i;
// Похожие на цветовые ключи, но хранящие НЕ цвета (времена, скорости, веса…).
// Их перекраска испортила бы эффект — скипаем (fail-safe).
// scale/normal осознанно НЕ в списке: m_ColorScale / m_NormalColor с тремя
// числами — вероятные тинты, а скаляры вроде m_flColorScale отсекаются
// проверкой количества чисел и так.
const COLOR_KEY_SKIP_RE = /time|duration|life|delay|rate|speed|position|uv|index|count|factor|tangent|weights?/i;
// f-суффикс (1.0f) в KV3 встречается — принимаем, на выходе пишем plain float
const NUM_TOKEN = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?f?';
const NAN_TOKEN = 'nan|inf(?:inity)?';
// Разделитель между токенами: пробелы, //-комментарии и /* */-комментарии
// (все сохраняются как есть; /* */ покрывает и позицию между ключом и =)
const SEP = '(?:\\s|//[^\\n]*|/\\*[\\s\\S]*?\\*/)*';
// Скобки — [...] или {...} (в KV3 встречаются оба).
// Ключ — голый идентификатор или "в кавычках" (в KV3 легально).
// Запятые между компонентами опциональны (референс принимает [1 0 0]).
const COLOR_ARRAY_RE = new RegExp(
  '((?:"[^"\\n]+"|[A-Za-z_][A-Za-z0-9_]*))' + // 1: key
  `(${SEP}=${SEP}[\\[\\{])` +           // 2: = [ или = {
  `${SEP}(${NUM_TOKEN}|${NAN_TOKEN})${SEP},?` + // 3: r
  `${SEP}(${NUM_TOKEN}|${NAN_TOKEN})${SEP},?` + // 4: g
  `${SEP}(${NUM_TOKEN}|${NAN_TOKEN})` +        // 5: b
  `(?:${SEP},?${SEP}(${NUM_TOKEN}|${NAN_TOKEN}))?` + // 6: a (optional)
  `${SEP},?${SEP}(\\]|\\})`,            // 7: ] или }
  'gis'
);
const BODY_TOKEN_RE = new RegExp(`${NUM_TOKEN}|${NAN_TOKEN}`, 'gi');
const isNumTok = t => /^[+-]?(?:\d|\.)/.test(t);
// Маскировка комментариев пробелами (длины сохраняются, смещения валидны):
// цифры внутри /* 0.5 */ и // ... не должны считаться компонентами цвета
// и перезаписываться заменой. restore возвращает оригиналы на место.
function maskComments(body) {
  const spans = [];
  const clean = body.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, off) => {
    spans.push([off, m]);
    return ' '.repeat(m.length);
  });
  return { clean, spans };
}
function unmaskComments(clean, spans) {
  let out = clean;
  for (const [off, orig] of spans) out = out.slice(0, off) + orig + out.slice(off + orig.length);
  return out;
}
// Формат нового значения под стиль оригинала: int→int, float→та же разрядность
function fmtLike(v, orig) {
  const m = /\.(\d+)/.exec(orig);
  if (!m) return String(Math.max(0, Math.round(v)));
  return Math.max(0, v).toFixed(m[1].length);
}

// Перекраска одной тройки (r,g,b[,a] — строки токенов).
// Возвращает [outR,outG,outB] или null (не цвет / не красится).
function recolorTriple(rs, gs, bs, as, targetHue) {
  const vals = [rs, gs, bs].map(parseFloat);
  const a = as === undefined ? 1 : parseFloat(as);
  if (![...vals, a].every(Number.isFinite)) return null; // nan/inf — скип
  if (vals.some(v => v < 0)) return null; // отрицательные компоненты — не цвета, скип
  // Байтовый 0-255 — если хотя бы один целый токен >1 (смешанный
  // [255, 0.5, 0] раньше красился как HDR и чернел: 255 шло без масштаба).
  // Верхняя граница 255 отсекает настоящий HDR (>255 — без масштаба).
  const hasByte = [rs, gs, bs].some(t => /^[+-]?\d+$/.test(t) && Math.abs(parseInt(t, 10)) > 1);
  const scale = (hasByte && Math.max(...vals) <= 255) ? 255 : 1;
  const [, sat, val] = rgb2hsv(vals[0] / scale, vals[1] / scale, vals[2] / scale);
  // Пропускаем: нейтральные (серые/ч-б), почти-прозрачные, почти-чёрные
  if (sat < 0.08 || val < 0.02 || a < 0.05) return null;
  const [nr, ng, nb] = hsv2rgb(targetHue, sat, val);
  return [fmtLike(nr * scale, rs), fmtLike(ng * scale, gs), fmtLike(nb * scale, bs)];
}
function bareKey(keyTok) { return keyTok.replace(/^"|"$/g, ''); }

function recolorVpcf(content, targetHue) {
  const stats = { replaced: 0, total: 0 };
  // ── Проход 1: плоские блоки ──────────────────────────────────────
  let text = content.replace(COLOR_ARRAY_RE,
    (m, keyTok, eqBracket, rs, gs, bs, as) => {
      const key = bareKey(keyTok);
      if (!COLOR_KEY_RE.test(key) || COLOR_KEY_SKIP_RE.test(key)) return m;
      // Скобки должны быть парными: [..] или {..} (защита от [..} опечаток)
      if ((eqBracket[eqBracket.length - 1] === '[') !== (m[m.length - 1] === ']')) return m;
      // head берём из захваченных групп дословно — комментарии между ключом
      // и = (m_Color /* inline */ = ...) и кавычки ключа сохраняются сами
      const head = keyTok + eqBracket;
      const closeCh = m[m.length - 1];
      const body = m.slice(head.length, -1);
      // Remainder-guard референса: внутри скобок допустимы только числа,
      // запятые, пробелы и комментарии обоих видов. Иначе блок не трогаем.
      // Подсчёт и замена идут по clean (комментарии замаскированы пробелами),
      // иначе цифры внутри /* 0.5 */ считаются компонентами и затираются.
      const { clean, spans } = maskComments(body);
      const toks = clean.match(BODY_TOKEN_RE) || [];
      const rest = clean
        .replace(BODY_TOKEN_RE, '')
        .replace(/[\s,]/g, '');
      if (toks.length !== (as === undefined ? 3 : 4) || rest !== '') return m;
      stats.total++;
      const outs = recolorTriple(rs, gs, bs, as, targetHue);
      if (!outs) return m;
      // Замена строго по порядку и только внутри скобок (имена полей не
      // задеваются, формат инлайн/многострочный сохраняется, замаскированные
      // комментарии возвращаются на место дословно)
      let i = 0;
      const tail = unmaskComments(clean.replace(BODY_TOKEN_RE, tok => (i < 3 ? outs[i++] : tok)), spans);
      stats.replaced++;
      return head + tail + closeCh;
    }
  );
  // ── Проход 2: вложенные градиенты ────────────────────────────────
  text = recolorGradientBlocks(text, targetHue, stats);
  return { text, replaced: stats.replaced, total: stats.total };
}

// Вложенные градиенты (m_ColorGradient = { {1,0,0}, {0,1,0} }):
// референс их скипает, но стопы градиента — те же цвета эффекта.
// Красим внутренние плоские тройки тем же recolorTriple.
// Четвёрки внутри НЕ трогаем: {t, r,g,b} — первое число там время стопа,
// а не R (покраска сломала бы тайминги градиента).
const GRAD_HEAD_RE = new RegExp(
  `((?:"[^"\\n]+"|[A-Za-z_][A-Za-z0-9_]*))(${SEP}=${SEP}[\\[\\{])`, 'gis');
const INNER_TRIPLE_RE = new RegExp(
  `([\\[\\{])${SEP}(${NUM_TOKEN})${SEP},?${SEP}(${NUM_TOKEN})${SEP},?${SEP}(${NUM_TOKEN})${SEP},?${SEP}([\\]\\}])`, 'gi');
// Конец тела блока: парная закрывающая с учётом вложенности.
// Скобки внутри комментариев/строк не считаем (иначе /* } */ сломает поиск).
function gradBodyEnd(text, from) {
  const open = text[from], close = open === '[' ? ']' : '}';
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (c === '/' && n === '/') { const nl = text.indexOf('\n', i + 2); i = nl < 0 ? text.length : nl; continue; }
    if (c === '/' && n === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 1; continue; }
    if (c === '"') { let j = i + 1; while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1; i = j; continue; }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { if (--depth === 0) return i; }
  }
  return -1;
}
function recolorGradientBlocks(text, targetHue, stats) {
  // Ручной цикл, а НЕ text.replace: матч покрывает только голову блока,
  // а переписываем и тело за ним — replace вставил бы новое поверх старого.
  let out = '', pos = 0;
  GRAD_HEAD_RE.lastIndex = 0;
  let m;
  while ((m = GRAD_HEAD_RE.exec(text))) {
    const hm = m[0], keyTok = m[1], off = m.index;
    const key = bareKey(keyTok);
    let repl = null, end = -1;
    if (COLOR_KEY_RE.test(key) && !COLOR_KEY_SKIP_RE.test(key)) {
      end = gradBodyEnd(text, off + hm.length - 1);
      if (end >= 0) {
        const body = text.slice(off + hm.length, end);
        const { clean, spans } = maskComments(body);
        // Без вложенных скобок плоский проход уже всё сделал — нечего искать
        if (/[\[{]/.test(clean)) {
          let found = 0, painted = 0;
          const newClean = clean.replace(INNER_TRIPLE_RE, (tm, ob, rs, gs, bs, cb) => {
            if ((ob === '[') !== (cb === ']')) return tm;
            const toks = tm.match(BODY_TOKEN_RE) || [];
            if (toks.length !== 3) return tm; // 4 числа = {t,r,g,b}, время не трогаем
            found++;
            const outs = recolorTriple(rs, gs, bs, undefined, targetHue);
            if (!outs) return tm;
            painted++;
            let i = 0;
            return tm.replace(BODY_TOKEN_RE, tok => outs[i++]);
          });
          if (found) {
            stats.total += found; stats.replaced += painted;
            if (painted) repl = hm + unmaskComments(newClean, spans) + text[end];
          }
        }
      }
    }
    if (repl === null) { out += text.slice(pos, off + hm.length); pos = off + hm.length; }
    else { out += text.slice(pos, off) + repl; pos = end + 1; }
    GRAD_HEAD_RE.lastIndex = pos;
  }
  return out + text.slice(pos);
}

// ── Проверка .NET ────────────────────────────────────────────────────
// VRF — framework-dependent приложение: ему нужен именно .NET *Runtime*,
// а `dotnet --version` показывает версию SDK (его может не быть при
// установленном рантайме). Поэтому смотрим --list-runtimes.
async function checkDotNet() {
  try {
    const { stdout } = await execFileAsync('dotnet', ['--list-runtimes'], { timeout: 8000, windowsHide: true });
    let best = null;
    for (const line of stdout.split(/\r?\n/)) {
      const m = /Microsoft\.NETCore\.App\s+(\d+)\.(\d+)\.(\d+)/.exec(line);
      if (m && parseInt(m[1], 10) >= 8) {
        const ver = `${m[1]}.${m[2]}.${m[3]}`;
        if (!best || ver > best) best = ver;
      }
    }
    if (best) return { ok: true, version: best };
  } catch { /* fall through to SDK check */ }
  try {
    const { stdout } = await execFileAsync('dotnet', ['--version'], { timeout: 5000, windowsHide: true });
    const ver = stdout.trim();
    // SDK 8+ почти всегда тянет за собой рантайм — считаем годным
    if (parseInt(ver.split('.')[0], 10) >= 8) return { ok: true, version: `${ver} (SDK)` };
    return { ok: false, version: ver || null };
  } catch { return { ok: false, version: null }; }
}

const STEAM_DLC_URL = 'https://store.steampowered.com/app/313250/';
const DOTNET_URL = 'https://dotnet.microsoft.com/download/dotnet/8.0';

// ── Runtime-проверка флагов VRF CLI ──────────────────────────────────
// Синтаксис Source2Viewer-CLI менялся между релизами, поэтому на память
// не полагаемся: при старте мастерской один раз вызываем --help, парсим
// какие флаги реально есть, кэшируем (память + файл с сигнатурой exe).
// При следующем обновлении VRF поломка видна сразу в статусе,
// а не через «поиск ничего не нашёл».
let vrfCapsMem = null;
// ── HELPFLAGS-BLOCK-START ──
// Строгий парсинг --help: собираем множество объявленных флагов-токенов
// (--foo, -f) и ищем точные совпадения. Подстроки не катят: --list-foo
// не считается за --list, а проза в описаниях не даёт ложных срабатываний
// коротких -e/-f/-d (они берутся только как отдельные токены).
function parseHelpFlags(help) {
  const declared = new Set();
  for (const line of String(help || '').split(/\r?\n/)) {
    // Короткий флаг — одиночный символ без прилипших букв (-ef не даёт -e)
    for (const t of line.match(/--[A-Za-z0-9_-]+|-[A-Za-z](?![A-Za-z])/g) || []) declared.add(t);
  }
  const pick = (...names) => names.find(n => declared.has(n)) || null;
  return {
    listFlag: pick('--vpk_list', '--list'),
    extFlag: pick('--vpk_extensions', '-e'),
    pathFlag: pick('--vpk_filepath', '-f'),
    // --decompile подтверждён живым --help как алиас --vpk_decompile
    decompileFlag: pick('--vpk_decompile', '--decompile', '-d'),
  };
}
// ── HELPFLAGS-BLOCK-END ──
async function getVrfCaps() {
  const exe = vrfExePath();
  if (!fss.existsSync(exe)) return { ok: false, reason: 'not-installed' };
  let sig = null;
  try {
    const st = fss.statSync(exe);
    // + хэш первых 64 КБ: обновление поверх того же пути с тем же mtime
    // маловероятно, но хэш делает кэш надёжным
    const fd = fss.openSync(exe, 'r');
    try {
      const head = Buffer.alloc(65536);
      const n = fss.readSync(fd, head, 0, head.length, 0);
      const hash = crypto.createHash('sha1').update(head.subarray(0, n)).digest('hex').slice(0, 12);
      sig = `${exe}|${st.size}|${st.mtimeMs}|${hash}`;
    } finally { fss.closeSync(fd); }
  } catch { return { ok: false, reason: 'stat-failed' }; }
  if (vrfCapsMem && vrfCapsMem.sig === sig) return vrfCapsMem.caps;
  const cacheFile = path.join(toolsPath(), 'vrf', 'caps.json');
  try {
    const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    if (cached && cached.sig === sig && cached.caps) { vrfCapsMem = cached; return cached.caps; }
  } catch { /* кэша нет — пробуем вживую */ }
  // Ненулевой exit тоже может нести текст --help — парсим, что есть.
  // А вот пустой провал (таймаут, нет .NET) НЕ кэшируем: иначе ok:false
  // застревает до смены exe и поиск/сборка блокируются без ретрая.
  let help = '';
  try {
    const { stdout, stderr } = await execFileAsync(exe, ['--help'], { timeout: 20000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    help = `${stdout || ''}\n${stderr || ''}`;
  } catch (e) {
    help = `${e.stdout || ''}\n${e.stderr || ''}`;
    if (!help.trim()) return { ok: false, reason: 'help-failed', error: String(e.message || e).split(/\r?\n/).slice(-4).join('\n') };
  }
  const flags = parseHelpFlags(help);
  const caps = {
    ok: true,
    ...flags,
    helpHead: help.split(/\r?\n/).slice(0, 8).join('\n').slice(0, 600),
  };
  if (!caps.listFlag || !caps.pathFlag) { caps.ok = false; caps.reason = 'flags-missing'; }
  if (caps.ok) {
    vrfCapsMem = { sig, caps };
    await writeJson(cacheFile, vrfCapsMem).catch(() => {});
  }
  return caps;
}

// ── PREFLIGHT-BLOCK-START ──
// Префлайт процессов: сборка пишет в папки Dota и гоняет resourcecompiler —
// запущенные Dota 2 / Steam дают файловые блокировки и падающие компиляции.
// Поэтому перед build проверяем процессы и просим пользователя их закрыть
// (молча ничего не убиваем — только по явной кнопке в UI).
const PREFLIGHT_PROCS = [
  { id: 'dota',  image: 'dota2.exe', label: 'Dota 2' },
  { id: 'steam', image: 'steam.exe', label: 'Steam' },
];
// Чистый парсер CSV-вывода tasklist (покрыт тестами в preflight.test.js)
function parseTasklistCsv(stdout) {
  const found = new Set();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)"/);
    if (m) found.add(m[1].toLowerCase());
  }
  return found;
}
function parseTasklistRows(stdout) {
  return String(stdout || '').split(/\r?\n/).flatMap(line => {
    const m = line.match(/^"([^"]+)","(\d+)"/);
    return m ? [{ image: m[1].toLowerCase(), pid: Number(m[2]) }] : [];
  });
}
async function runningGameProcs() {
  if (process.platform !== 'win32') return { dota: false, steam: false, unknown: false };
  try {
    const { stdout } = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 8000, windowsHide: true });
    const found = parseTasklistCsv(stdout);
    return { dota: found.has('dota2.exe'), steam: found.has('steam.exe'), unknown: false };
  } catch {
    // Fail-closed: tasklist заблокирован/упал — честно говорим «неизвестно»,
    // а не «всё закрыто». ensureAppsClosed заблокирует операцию с понятным текстом.
    return { dota: false, steam: false, unknown: true };
  }
}
async function closeGameProc(id) {
  const proc = PREFLIGHT_PROCS.find(p => p.id === id);
  if (!proc) throw new Error('Неизвестный процесс');
  if (process.platform !== 'win32') throw new Error('Закрытие процессов поддерживается только на Windows');
  const { stdout } = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 8000, windowsHide: true });
  const pids = parseTasklistRows(stdout).filter(row => row.image === proc.image).map(row => row.pid);
  if (!pids.length) return true;
  // Сначала просим процессы закрыться, затем принудительно завершаем только
  // найденные PID с дочерними процессами. Steam иногда держит дочерний
  // steamwebhelper и из-за этого обычный taskkill не срабатывает.
  for (const pid of pids)
    await execFileAsync('taskkill', ['/PID', String(pid), '/T'], { timeout: 8000, windowsHide: true }).catch(() => {});
  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, 500));
    const st = await runningGameProcs();
    if (st.unknown) throw new Error(`${proc.label}: не удалось проверить процессы — закройте вручную через диспетчер задач`);
    if (!st[id]) return true;
  }
  const remaining = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 8000, windowsHide: true });
  for (const pid of parseTasklistRows(remaining).filter(row => row.image === proc.image).map(row => row.pid))
    await execFileAsync('taskkill', ['/F', '/T', '/PID', String(pid)], { timeout: 8000, windowsHide: true }).catch(() => {});
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 500));
    const st = await runningGameProcs();
    if (st.unknown) throw new Error(`${proc.label}: не удалось проверить процессы — закройте вручную через диспетчер задач`);
    if (!st[id]) return true;
  }
  throw new Error(`${proc.label} не закрывается — закройте вручную через диспетчер задач и повторите`);
}
// ── PREFLIGHT-BLOCK-END ──
// Авто-режим: сами закрываем Dota 2 / Steam перед операциями, пишущими
// в папки игры, и перезапускаем Steam после. Работает только если включено
// в настройках (autoCloseSteam); выключено — кидаем понятную ошибку.
async function ensureAppsClosed(sendProgress) {
  const rt = await runningGameProcs();
  if (rt.unknown) throw new Error('Не удалось проверить запущенные процессы (tasklist недоступен) — закройте Steam и Dota 2 вручную и повторите');
  const busy = PREFLIGHT_PROCS.filter(p => rt[p.id]);
  if (!busy.length) return { steamWasRunning: false };
  const cfg = await settings();
  if (!cfg.autoCloseSteam) throw new Error(`Закройте ${busy.map(p => p.label).join(' и ')} перед операцией — иначе файлы заблокированы (или включите автозакрытие в ⚙ Настройках)`);
  let steamWasClosed = false;
  for (const p of busy) {
    (sendProgress || (() => {}))(`⏳ Закрываю ${p.label}...`);
    try {
      await closeGameProc(p.id);
      if (p.id === 'steam') steamWasClosed = true;
      (sendProgress || (() => {}))(`✅ ${p.label} закрыт`);
    } catch (error) {
      // Do not continue with a partially closed process set. Steam can
      // relaunch helpers and keep game files locked during the operation.
      throw error;
    }
  }
  return { steamWasRunning: steamWasClosed };
}
// Перезапуск Steam-клиента после операции (Доту пользователь запустит сам).
// Путь берём из реестра Valve, запасные — стандартные установки.
async function relaunchSteam(sendProgress) {
  if (process.platform !== 'win32') return false;
  const log = sendProgress || (() => {});
  let exe = '';
  try {
    const { stdout } = await execFileAsync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamExe'], { timeout: 8000, windowsHide: true });
    const m = stdout.match(/SteamExe\s+REG_SZ\s+(.+)/);
    if (m) exe = m[1].trim();
  } catch { /* реестра нет — идём по стандартным путям */ }
  if (!exe || !fss.existsSync(exe)) {
    exe = ['C:\\Program Files (x86)\\Steam\\steam.exe', 'C:\\Program Files\\Steam\\steam.exe']
      .find(p => fss.existsSync(p)) || '';
  }
  if (!exe) { log('⚠ Steam.exe не найден — запустите Steam вручную'); return false; }
  // Строгая валидация: запускаем только настоящий steam.exe без shell
  // (значение реестра подконтрольно пользователю — shell:true давал инъекцию).
  if (path.basename(exe).toLowerCase() !== 'steam.exe' || !fss.existsSync(exe)) {
    log('⚠ Подозрительный путь Steam.exe из реестра — запустите Steam вручную');
    return false;
  }
  log('▶ Перезапускаю Steam...');
  const { spawn } = require('node:child_process');
  const child = spawn(exe, [], { shell: false, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return true;
}

// ── Найти resourcecompiler.exe (Dota 2 Workshop Tools) ───────────────
// Workshop Tools — отдельный DLC в Steam (~2 GB), устанавливается через
// Steam → Библиотека → Инструменты → Dota 2 Workshop Tools Alpha
async function findResourceCompiler(gamePath) {
  const candidates = [
    path.join(gamePath, 'game', 'bin', 'win64', 'resourcecompiler.exe'),
    path.join(gamePath, 'game', 'bin', 'resourcecompiler.exe'),
    // Workshop Tools иногда ставятся в отдельную папку
    path.join(gamePath, '..', 'dota 2 beta workshop', 'game', 'bin', 'win64', 'resourcecompiler.exe'),
  ];
  for (const c of candidates) if (fss.existsSync(c)) return c;
  return null;
}

// ── Статус инструментов мастерской ──────────────────────────────────
async function workshopToolStatus(gamePath) {
  const [dotnet, cfg] = await Promise.all([checkDotNet(), settings()]);
  const resolvedGame = path.resolve(gamePath || cfg.gamePath);
  const pakVpk = path.join(resolvedGame, 'game', 'dota', 'pak01_dir.vpk');
  const compilerPath = await findResourceCompiler(resolvedGame);
  const vrfExe = vrfExePath();
  const vrfCaps = fss.existsSync(vrfExe) ? await getVrfCaps() : { ok: false, reason: 'not-installed' };
  return {
    vrfReady:        fss.existsSync(vrfExe),
    vrfCaps,
    dotnetOk:        dotnet.ok,
    dotnetVersion:   dotnet.version,
    pakExists:       fss.existsSync(pakVpk),
    pakVpk,
    compilerReady:   Boolean(compilerPath),
    compilerPath:    compilerPath || null,
    runtime:         await runningGameProcs(), // { dota, steam } — префлайт перед сборкой
    steamDlcUrl:     STEAM_DLC_URL,
    dotnetUrl:       DOTNET_URL,
  };
}

// ── Скачать VRF Decompiler из GitHub Releases ────────────────────────
async function downloadVrfTool(sendProgress) {
  await fs.mkdir(path.join(toolsPath(), 'vrf'), { recursive: true });
  sendProgress('Запрос к GitHub API...');
  const apiRes = await fetch(VRF_RELEASES_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dota-mod-set/1.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!apiRes.ok) throw new Error(`GitHub API: HTTP ${apiRes.status}`);
  const release = await apiRes.json();
  // Используем зафиксированный релиз и имя актива, чтобы обновление upstream
  // не могло незаметно подменить исполняемый инструмент.
  const names = release.assets.map(a => a.name);
  if (release.tag_name !== VRF_RELEASE_TAG)
    throw new Error(`VRF: GitHub вернул неожиданный релиз ${release.tag_name}`);
  const asset = release.assets.find(a => a.name === VRF_ASSET_NAME);
  if (!asset) throw new Error(`VRF: не найден Windows-ZIP среди активов релиза (${names.join(', ')})`);
  if (asset.digest !== `sha256:${VRF_ASSET_SHA256}`)
    throw new Error('VRF: хэш актива не совпадает с зафиксированным значением');
  sendProgress(`Найден ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB) — скачивание...`);
  const zipRes = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(120000) });
  if (!zipRes.ok) throw new Error(`Скачивание VRF: HTTP ${zipRes.status}`);
  const finalUrl = new URL(zipRes.url);
  if (finalUrl.protocol !== 'https:' || finalUrl.hostname !== 'github.com')
    throw new Error(`Скачивание VRF: запрещённый адрес перенаправления ${zipRes.url}`);
  const bytes = Buffer.from(await zipRes.arrayBuffer());
  if (hashBuffer(bytes) !== VRF_ASSET_SHA256)
    throw new Error('VRF: загруженный архив не прошёл проверку SHA-256');
  const vrfDir  = path.join(toolsPath(), 'vrf');
  const zipFile = path.join(vrfDir, '_vrf_dl.zip');
  await fs.writeFile(zipFile, bytes);
  sendProgress('Распаковка архива...');
  await expandArchive(zipFile, vrfDir);
  await fs.rm(zipFile).catch(() => {});
  // EXE может лежать во вложенной папке — ищем по всем известным именам и поднимаем наверх
  const EXE_NAMES = new Set(['Source2Viewer-CLI.exe', 'Decompiler.exe']);
  async function findVrfExe(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isFile() && EXE_NAMES.has(e.name)) return full;
      if (e.isDirectory()) { const r = await findVrfExe(full); if (r) return r; }
    }
    return null;
  }
  if (!fss.existsSync(vrfExePath())) {
    const found = await findVrfExe(vrfDir);
    if (found && path.dirname(found) !== vrfDir) {
      const sub = path.dirname(found);
      for (const f of await fs.readdir(sub))
        await fs.rename(path.join(sub, f), path.join(vrfDir, f)).catch(() => {});
      await fs.rmdir(sub).catch(() => {});
    }
  }
  if (!fss.existsSync(vrfExePath()))
    throw new Error('CLI VRF не найден после распаковки (искали Source2Viewer-CLI.exe / Decompiler.exe). Возможно, структура ZIP изменилась.');
  sendProgress(`✅ VRF ${release.tag_name} установлен`);
  return { version: release.tag_name };
}

// ── Список .vpcf_c в pak01 ──────────────────────────────────────────
// Флаги берём из runtime-проверки getVrfCaps(), а не по памяти.
// Выдача ранжируется (длина токена / позиция в пути) и режется до топ-50,
// возвращается { files, total } — UI показывает «найдено N, показано 50».
const SEARCH_LIMIT = 50;
// ── Зеркало effectGroupKey из src/workshop.js (GROUP-BLOCK) ──────────
// main и renderer — разные миры без общего модуля, поэтому копия здесь.
// Синхронность проверяет grouping.test.js (mirror-sync): сравниваются тела
// effectGroupKey/effectGroupKeyMain И текст GROUP_TAIL_DROP.
const GROUP_TAIL_DROP_MAIN = new Set([
  'bloom', 'ember', 'embers', 'smoke', 'glow', 'glint', 'glare', 'flash', 'flare',
  'flicker', 'shimmer', 'light', 'ray', 'rays', 'spark', 'sparks', 'heat', 'hot',
  'flame', 'flames', 'fire', 'trail', 'trails', 'ash', 'ashes', 'flek', 'fleks',
  'vapor', 'mist', 'steam', 'dust', 'halo', 'fx', 'core', 'body',
  'lower', 'upper', 'side', 'inner', 'outer', 'front', 'back', 'left', 'right',
  'top', 'bottom', 'center', 'middle', 'ground', 'mouth', 'head', 'tail', 'wing',
  'start', 'end', 'loop', 'idle', 'ambient', 'dark',
  'small', 'big', 'large', 'huge', 'tiny', 'mini', 'group', 'alt',
  'edge',
]);
function effectGroupKeyMain(p) {
  const s = String(p || '').replace(/\\/g, '/');
  const slash = s.lastIndexOf('/');
  const dir = (slash >= 0 ? s.slice(0, slash) : '').split('/')
    // Тег сидит внутри сегмента через подчёркивание (ursa_ti10,
    // warlock_cc2024_burning, huskar_2021_immortal) — режем и в середине,
    // и в конце сегмента
    .map(seg => seg.replace(/_?((ti|cc)\d+|(19|20)\d{2})(?=_|$)/gi, ''))
    .filter(seg => seg && !/^((ti|cc)\d+|(19|20)\d{2})$/i.test(seg)).join('/') + (slash >= 0 ? '/' : '');
  const raw = (slash >= 0 ? s.slice(slash + 1) : s).replace(/\.vpcf_c$/i, '');
  const segs = raw.split('_').filter(seg => seg.length > 3 || !/^[a-z]\d*$/i.test(seg));
  const noseTag = segs.filter(seg => !/^((ti|cc)\d+|(19|20)\d{2})$/i.test(seg));
  const base = noseTag.length ? noseTag : segs;
  // Режем хвостовые слои, пока последний сегмент — слой/вариант с цифрами
  // (blade1..blade4) из косметического списка. Минимум 1 сегмент оставляем.
  let n = base.length;
  while (n > 1) {
    const tail = base[n - 1].toLowerCase();
    if (GROUP_TAIL_DROP_MAIN.has(tail) || /^[a-z]+\d+$/i.test(base[n - 1])) n--;
    else break;
  }
  return dir + (base.slice(0, n).join('_') || raw);
}
// ── WAVE2-BLOCK-START ──
// Чистые функции скорости/поиска (волна 2): keyFn инжектится, чтобы не
// дублировать effectGroupKeyMain и тестировать на стабах. Покрыты wave2.test.js.
function scoreParticleList(all, q) {
  const out = [];
  for (const p of all) {
    const pos = p.toLowerCase().indexOf(q);
    if (pos >= 0) out.push({ p, s: (q.length * 1000) / (1 + pos) });
  }
  out.sort((a, b) => b.s - a.s);
  return out;
}
// Достройка топ-групп до ПОЛНЫХ семейств по закэшированному all:
// запрос 'bloom' раньше показывал mount_ambient из 1 файла вместо 5 слоёв
// (группы строились только из совпавших), сборка красила часть эффекта.
function completeFamilies(rankedKeys, all, keyFn) {
  const byKey = new Map();
  for (const p of all) {
    const k = keyFn(p);
    let a = byKey.get(k);
    if (!a) { a = []; byKey.set(k, a); }
    a.push(p);
  }
  const out = [];
  for (const k of rankedKeys) {
    const files = byKey.get(k);
    if (files && files.length) out.push({ key: k, files });
  }
  return out;
}
function pakSigOf(st) { return `${st.size}:${Math.floor(st.mtimeMs)}`; }
// Скоп поиска `in:<подстрока пути>` / антископ `not:<...>`: чипы
// unusual-направления ищут слово только внутри ветки предметов (иначе ambient
// даёт 10к UI/dev/pregame-мусора, а unusual — только интерфейс сундуков).
// Честная оговорка: econ-эффект виден, только если вещь надета (предмет мы не
// выдаём, только красим), поэтому для «видно всем» есть антископ not:econ.
// Чистая, покрыта wave2.test.js.
function splitScope(q) {
  const scope = [];
  const not = [];
  const rest = [];
  for (const tok of String(q || '').toLowerCase().split(/\s+/).filter(Boolean)) {
    if (tok.startsWith('in:') && tok.length > 3) scope.push(tok.slice(3));
    else if (tok.startsWith('not:') && tok.length > 4) not.push(tok.slice(4));
    else rest.push(tok);
  }
  return { scope, not, terms: rest.join(' ') };
}
// ── WAVE2-BLOCK-END ──
async function listParticlesInPak(gamePath, query) {
  const pak = path.join(gamePath, 'game', 'dota', 'pak01_dir.vpk');
  if (!fss.existsSync(pak)) throw new Error('pak01_dir.vpk не найден — проверьте путь к игре');
  const caps = await getVrfCaps();
  if (!caps.ok || !caps.listFlag)
    throw new Error(`VRF CLI не подтвердил свои флаги (${caps.reason || 'unknown'}${caps.error ? `: ${caps.error}` : ''}). Проверьте .NET 8 Runtime и версию VRF.`);
  const all = await getPakParticleList(pak, caps);
  const q = String(query || '').toLowerCase();
  // Скоп in:... сначала режет пул по пути, скоринг и фолбэк идут по остатку.
  // Достройка до полных семейств — по всему all (члены семьи лежат рядом).
  const { scope, not, terms } = splitScope(q);
  const pool = all.filter(p => {
    const lp = p.toLowerCase();
    return scope.every(s => lp.includes(s)) && !not.some(s => lp.includes(s));
  });
  if (!q) {
    const groups = new Map();
    for (const p of all) {
      const k = effectGroupKeyMain(p);
      let g = groups.get(k);
      if (!g) { g = { key: k, files: [] }; groups.set(k, g); }
      g.files.push(p);
    }
    const ordered = [...groups.values()];
    const top = ordered.slice(0, SEARCH_LIMIT);
    return { groups: top, totalGroups: ordered.length, totalFiles: all.length, fallbackToken: '' };
  }
  const rankOf = scored => {
    const rank = new Map(scored.map((x, i) => [x.p, i]));
    const groups = new Map();
    for (const { p } of scored) {
      const k = effectGroupKeyMain(p);
      let g = groups.get(k);
      if (!g) { g = { key: k, files: [] }; groups.set(k, g); }
      g.files.push(p);
    }
    return [...groups.values()].sort((a, b) => rank.get(a.files[0]) - rank.get(b.files[0]));
  };
  let ordered = rankOf(scoreParticleList(pool, terms));
  let fallbackToken = '';
  // Фолбэк по токенам — ПО КЭШУ, без повторных сканов pak01 (раньше до 3
  // полных VRF-прогонов подряд). Критерий тот же: самый специфичный токен.
  // Скоп-токены (in:...) в фолбэк не идут — это фильтр, а не слово поиска.
  if (!ordered.length && /[_\s-]/.test(terms)) {
    const tokens = terms.split(/[_\s-]+/).filter(t => t.length >= 4)
      .sort((a, b) => b.length - a.length).slice(0, 3);
    let best = null;
    for (const tok of tokens) {
      const cand = rankOf(scoreParticleList(pool, tok));
      if (cand.length && (!best || cand.length < best.length)) { best = cand; fallbackToken = tok; }
    }
    if (best) ordered = best;
  }
  // Топ-50 считаем ГРУППАМИ, достроенными до полных семейств: выбираются
  // одним кликом и красятся целиком. Группы — в порядке лучшего ранга участника.
  const top = completeFamilies(ordered.slice(0, SEARCH_LIMIT).map(g => g.key), all, effectGroupKeyMain);
  const matchedFiles = ordered.reduce((n, g) => n + g.files.length, 0);
  return { groups: top, totalGroups: ordered.length, totalFiles: matchedFiles, fallbackToken };
}
// Кэш полного листинга pak01: один VRF-скан на сигнатуру файла (size+mtime).
// Поиск и фолбэк дальше работают по памяти вместо 200-МБ прогонов.
const pakListCache = { sig: null, all: [] };
async function getPakParticleList(pak, caps) {
  let sig = null;
  try { sig = pakSigOf(await fs.stat(pak)); } catch { /* stat не удался — всегда сканируем */ }
  if (sig && sig === pakListCache.sig && pakListCache.all.length) return pakListCache.all;
  const args = ['--input', pak, caps.listFlag];
  if (caps.extFlag) args.push(caps.extFlag, 'vpcf_c');
  let stdout;
  try {
    ({ stdout } = await execFileAsync(vrfExePath(), args, {
      windowsHide: true, timeout: 120000, maxBuffer: 200 * 1024 * 1024,
    }));
  } catch (e) {
    const tail = String(e.stderr || e.stdout || e.message || '').split(/\r?\n/).slice(-5).join('\n');
    throw new Error(`VRF ${caps.listFlag} завершился с ошибкой${tail ? `: ${tail}` : ''}`);
  }
  const all = stdout.split(/\r?\n/)
    .map(l => l.trim().split(/\s+/)[0]) // отрезаем возможный суффикс с размером
    .filter(l => l.endsWith('.vpcf_c'));
  pakListCache.sig = sig; pakListCache.all = all;
  return all;
}

// ── Извлечение одного .vpcf_c через VRF ────────────────────────────
// ВАЖНО: без флага декомпиляции VRF выгружает сырой бинарный .vpcf_c,
// а текстовый .vpcf для перекраски получается только с этим флагом.
// Имя флага берём из runtime-проверки, а не по памяти.
async function extractOneParticle(pakPath, particlePath, outDir) {
  const caps = await getVrfCaps();
  if (!caps.ok || !caps.pathFlag)
    throw new Error(`VRF CLI не подтвердил свои флаги (${caps.reason || 'unknown'}). Проверьте .NET 8 Runtime и версию VRF.`);
  if (!caps.decompileFlag)
    throw new Error('VRF CLI не поддерживает декомпиляцию при экспорте (нет --vpk_decompile/-d) — обновите VRF через кнопку в Мастерской.');
  try {
    await execFileAsync(vrfExePath(),
      ['--input', pakPath, '--output', outDir, caps.pathFlag, particlePath, caps.decompileFlag],
      { windowsHide: true, timeout: 60000 });
  } catch (e) {
    const tail = String(e.stderr || e.stdout || e.message || '').split(/\r?\n/).slice(-5).join('\n');
    throw new Error(`VRF export: ${tail || e.message}`);
  }
  // Ищем результат рекурсивно: новые версии VRF могут класть файл
  // не совсем по ожидаемому пути (см. --output при одном совпадении).
  // НО выбираем не первый попавшийся (порядок readdir недетерминирован),
  // а точное совпадение с запрошенным путём — иначе молча красится чужой файл.
  const norm = s => String(s).replace(/\\/g, '/').toLowerCase();
  const want = norm(particlePath);
  const vpcf = [], raw = [];
  const walk = async (dir) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (/\.vpcf$/i.test(e.name) && !/\.vpcf_c$/i.test(e.name)) vpcf.push(full);
      else if (/\.vpcf_c$/i.test(e.name)) raw.push(full);
    }
  };
  await walk(outDir);
  const exact = list => list.find(f => { const n = norm(f); return n === want || n.endsWith('/' + want); });
  // Приоритет — декомпилированный .vpcf, затем сырой .vpcf_c
  const hit = exact(vpcf) || exact(raw);
  if (hit) return hit;
  if (vpcf.length || raw.length)
    throw new Error(`VRF выгрузил чужое вместо ${path.basename(particlePath)} (кандидаты: ${[...vpcf, ...raw].slice(0, 5).map(f => path.basename(f)).join(', ')})`);
  return null;
}

// ── Компиляция .vpcf → .vpcf_c через Valve resourcecompiler ─────────
// Схема сверена с референсом h6rd/VPCF-Editor (src/compiler.py) — единственная
// проверенная на практике: resourcecompiler НЕ умеет компилировать loose-файлы
// из временной папки. Правильный конвейер Valve:
//   1. положить .vpcf в <dota>/content/dota_addons/<addon>/particles/
//   2. вызвать resourcecompiler.exe -f -filelist <список>
//   3. забрать <stem>.vpcf_c из <dota>/game/dota_addons/<addon>/particles/
//   4. удалить свои копии с обеих сторон (не мусорим в установке игры)
// Требует Dota 2 Workshop Tools (Steam → Инструменты → Dota 2 Workshop Tools Alpha)
// и прав на запись в папку игры (при Program Files — запуск от администратора).
const WS_ADDON = 'dota_mod_set_ws';
function workshopDlcError() {
  return 'Dota 2 Workshop Tools не установлены.\n' +
    'Без resourcecompiler.exe нельзя скомпилировать .vpcf → .vpcf_c.\n' +
    'Игра читает только .vpcf_c — .vpcf в VPK будет проигнорирован.\n' +
    'Установка: Steam → Библиотека → вкладка «Инструменты» → Dota 2 Workshop Tools Alpha\n' +
    `Страница DLC: ${STEAM_DLC_URL}`;
}
// items: [{ stem, srcVpcf, origBase }] → [{ ..., compiled }]
async function compileWorkshopBatch(items, resolvedGame, tempDir, sendProgress) {
  const compilerPath = await findResourceCompiler(resolvedGame);
  if (!compilerPath) throw new Error(workshopDlcError());
  if (!items.length) return [];
  // Assert: путь обязан быть установкой Доты, иначе чистка ниже могла бы
  // задеть чужие файлы при ошибочном gamePath.
  if (!fss.existsSync(path.join(resolvedGame, 'game', 'dota')))
    throw new Error(`Путь не похож на установку Dota 2 (нет game/dota): ${resolvedGame}`);
  const contentDir = path.join(resolvedGame, 'content', 'dota_addons', WS_ADDON, 'particles');
  const gameDir    = path.join(resolvedGame, 'game', 'dota_addons', WS_ADDON, 'particles');
  try {
    await fs.mkdir(contentDir, { recursive: true });
    await fs.mkdir(gameDir, { recursive: true });
  } catch (e) {
    throw new Error(
      `Нет прав на запись в папку Dota 2 (${resolvedGame}). ` +
      `Если игра в Program Files — запустите приложение от имени администратора.\n${e.message || e}`
    );
  }
  // Чистим артефакты прошлых (возможно аварийных) запусков — но только
  // свои расширения в своём неймспейсе, а не всё содержимое каталогов.
  for (const [d, re] of [[contentDir, /\.vpcf$/i], [gameDir, /\.vpcf_c$/i]]) {
    let entries = [];
    try { entries = await fs.readdir(d); } catch { /* нет папки */ }
    for (const e of entries) {
      if (e === '_dms_batch_filelist.txt' || re.test(e))
        await fs.rm(path.join(d, e), { force: true }).catch(() => {});
    }
  }
  // Уникальные стемы: разные пути pak01 могут делить basename
  const seen = new Set();
  const jobs = items.map(it => {
    let u = safeId(it.stem) || 'particle', k = 1;
    while (seen.has(u)) u = `${safeId(it.stem) || 'particle'}_${k++}`;
    seen.add(u);
    return { ...it, ustem: u };
  });
  for (const j of jobs) await fs.copyFile(j.srcVpcf, path.join(contentDir, j.ustem + '.vpcf'));
  const listFile = path.join(contentDir, '_dms_batch_filelist.txt');
  // CRLF + абсолютные пути + без BOM: повторяет то, что пишет референс
  // (Python text mode на Windows), resourcecompiler к формату капризен
  await fs.writeFile(listFile, jobs.map(j => path.join(contentDir, j.ustem + '.vpcf')).join('\r\n'), 'utf8');
  try {
    // cwd = корень игры: воспроизводим окружение референса compiler.py
    // вместо наследования CWD процесса Electron.
    await execFileAsync(compilerPath, ['-f', '-filelist', listFile], { windowsHide: true, timeout: 300000, cwd: resolvedGame });
  } catch (e) {
    const out = String(e.stderr || e.stdout || e.message || '').slice(-1500);
    throw new Error(`resourcecompiler завершился с ошибкой. Вывод: ${out || '(пусто)'}`);
  } finally {
    await fs.rm(listFile, { force: true }).catch(() => {});
  }
  // Опрашиваем ожидаемые выходы вместо фиксированной паузы: быстрые диски
  // отдадут раньше, медленные — дождутся (до ~6 с).
  const expected = new Set(jobs.map(j => j.ustem + '.vpcf_c'));
  for (let i = 0; i < 20; i++) {
    let ready = true;
    for (const name of expected) { try { await fs.access(path.join(gameDir, name)); } catch { ready = false; break; } }
    if (ready) break;
    await new Promise(r => setTimeout(r, 300));
  }
  const results = [];
  for (const j of jobs) {
    await fs.rm(path.join(contentDir, j.ustem + '.vpcf'), { force: true }).catch(() => {});
    const built = path.join(gameDir, j.ustem + '.vpcf_c');
    if (!fss.existsSync(built)) {
      sendProgress(`  ⚠ ${j.origBase}: компилятор не создал .vpcf_c`);
      continue;
    }
    // move = забираем из game/ сразу, чтобы не мусорить в установке
    const dest = path.join(tempDir, j.ustem + '.vpcf_c');
    try { await fs.rename(built, dest); }
    catch { await fs.copyFile(built, dest); await fs.rm(built, { force: true }).catch(() => {}); }
    results.push({ ...j, compiled: dest });
  }
  // Финальная зачистка: наши расширения в неймспейсе удаляем сами
  // (раньше только предупреждали — мусор копился и подбирался следующим прогоном).
  // Чужое (подкаталоги, прочие расширения) не трогаем, только показываем.
  const strange = [];
  for (const [d, re] of [[contentDir, /\.vpcf$/i], [gameDir, /\.vpcf_c$/i]]) {
    let entries = [];
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { /* нет папки */ }
    for (const e of entries) {
      if (e.isDirectory() || (e.isFile() && !re.test(e.name) && e.name !== '_dms_batch_filelist.txt')) { strange.push(path.join(d, e.name)); continue; }
      if (e.isFile()) await fs.rm(path.join(d, e.name), { force: true }).catch(() => {});
    }
  }
  if (strange.length)
    sendProgress(`  ⚠ В аддоне чужие файлы (${strange.length}) — не трогаю: ${strange.slice(0, 3).join(', ')}`);
  return results;
}
// Изоляция ошибок компиляции бисекцией: батч целиком → половины → по одному.
// Один битый .vpcf больше не отменяет всю сборку; падаем только при нуле выходов.
async function compileWorkshopBatchSafe(items, resolvedGame, tempDir, sendProgress) {
  try {
    return await compileWorkshopBatch(items, resolvedGame, tempDir, sendProgress);
  } catch (e) {
    if (items.length < 2) throw e;
    sendProgress(`  ⚠ Батч упал (${items.length} файлов) — делю пополам и добираю по частям…`);
    const mid = Math.ceil(items.length / 2);
    const out = [];
    for (const half of [items.slice(0, mid), items.slice(mid)]) {
      try { out.push(...await compileWorkshopBatchSafe(half, resolvedGame, tempDir, sendProgress)); }
      catch (e2) { sendProgress(`  ⚠ Часть не скомпилировалась (${half.length} файлов): ${String(e2.message || e2).split('\n')[0]}`); }
    }
    if (!out.length) throw e;
    sendProgress(`  ✅ Бисекция спасла ${out.length} из ${items.length}`);
    return out;
  }
}

// ── Полный конвейер мастерской ──────────────────────────────────────
// Шаги: extract .vpcf_c → decompile → recolor .vpcf → compile → .vpcf_c → VPK
async function buildWorkshopMod({ modName, particlePaths, targetHue, gamePath }, sendProgress) {
  await ensureData();
  await fs.mkdir(workshopPath(), { recursive: true });
  const resolvedGame = path.resolve(gamePath || (await settings()).gamePath);
  const pakVpk = path.join(resolvedGame, 'game', 'dota', 'pak01_dir.vpk');
  if (!fss.existsSync(pakVpk))     throw new Error('pak01_dir.vpk не найден — проверьте путь к Dota 2');
  if (!fss.existsSync(vrfExePath())) throw new Error('VRF не установлен — откройте Мастерскую и скачайте его');
  // Проверяем компилятор до начала работы (не ждём до середины конвейера)
  if (!await findResourceCompiler(resolvedGame)) throw new Error(workshopDlcError());
  // Префлайт процессов: запущенные Dota 2 / Steam блокируют файлы в папках
  // игры и роняют resourcecompiler. При включённом autoCloseSteam закрываем
  // сами и перезапускаем Steam в конце (finally — даже при ошибке сборки).
  const apps = await ensureAppsClosed(sendProgress);
  try { return await buildWorkshopModInner({ modName, particlePaths, targetHue, resolvedGame, pakVpk }, sendProgress); }
  finally { if (apps.steamWasRunning) await relaunchSteam(sendProgress).catch(() => false); }
}

// Внутренний конвейер (без префлайта — он выше, в buildWorkshopMod).
// Сериализован мьютексом: общий неймспейс dota_mod_set_ws в папке игры
// не переживёт две параллельные сборки.
async function buildWorkshopModInner({ modName, particlePaths, targetHue, resolvedGame, pakVpk }, sendProgress) {
  return withCatalogLock(async () => {

  const tempDir = path.join(dataPath(), `ws-tmp-${crypto.randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });

  const vpkFiles = []; // { fullPath: 'particles/...vpcf_c', data: Buffer }
  try {
    // ── Фаза 1: извлечение + перекраска (по файлам) ───────────────
    const items = []; // { pp, origBase, stem, srcVpcf }
    let recoloredCount = 0; // файлов, где реально сдвинут оттенок
    for (let i = 0; i < particlePaths.length; i++) {
      const pp = particlePaths[i];
      const base = path.basename(pp);

      // ── Шаг 1: Извлечение и декомпиляция .vpcf_c → .vpcf ──────────
      sendProgress(`[${i + 1}/${particlePaths.length}] ① Декомпиляция: ${base}`);
      const exDir = path.join(tempDir, `ex_${i}`);
      await fs.mkdir(exDir, { recursive: true });
      const decompPath = await extractOneParticle(pakVpk, pp, exDir).catch(e => {
        sendProgress(`  ⚠ VRF ошибка: ${e.message?.split('\n')[0]}`);
        return null;
      });
      if (!decompPath) { sendProgress(`  ⚠ Пропуск: декомпиляция не дала .vpcf`); continue; }

      // ── Шаг 2: Перекраска .vpcf ────────────────────────────────────
      sendProgress(`  ② Перекраска цвета: ${path.basename(decompPath)}`);
      const original = await fs.readFile(decompPath, 'utf8');
      // Защита от сырого бинарника: декомпилированный KV3 всегда начинается
      // с <!-- kv3 ...-->. Без этого перекраска испортила бы файл.
      if (/\.vpcf_c$/i.test(decompPath) || !original.trimStart().startsWith('<!-- kv3')) {
        sendProgress(`  ⚠ Пропуск: VRF отдал бинарный .vpcf_c без декомпиляции (обновите VRF)`);
        continue;
      }
      const { text: recolored, replaced, total } = recolorVpcf(original, targetHue);
      if (total === 0) sendProgress(`  ⚠ Цветовых блоков не найдено — войдёт без изменений`);
      else if (replaced === 0) sendProgress(`  ⚠ Блоков: ${total}, все нейтральные/прозрачные — без изменений`);
      else { sendProgress(`  ② Перекрашено блоков: ${replaced}/${total}`); recoloredCount++; }
      const recoloredPath = decompPath.replace(/\.vpcf$/i, '_recolored.vpcf');
      await fs.writeFile(recoloredPath, recolored, 'utf8');
      items.push({ pp, origBase: base, stem: base.replace(/\.vpcf_c$/i, ''), srcVpcf: recoloredPath });
    }

    if (!items.length) throw new Error('Не удалось обработать ни одного файла частиц');
    // Итог перекраски одной строкой — видно сразу, было ли что красить
    if (recoloredCount === 0) sendProgress(`🎨 Итог: ни один файл не перекрашен (цветовых блоков нет) — VPK содержит оригиналы`);
    else sendProgress(`🎨 Итог: перекрашено файлов: ${recoloredCount} из ${items.length}`);

    // ── Фаза 2: батч-компиляция всех .vpcf → .vpcf_c ────────────────
    // С изоляцией ошибок: один битый файл больше не роняет всю сборку —
    // бисекция добирает всё, что компилируется, падаем только при нуле выходов.
    sendProgress(`③ Компиляция ${items.length} .vpcf → .vpcf_c (батч через resourcecompiler)…`);
    const compiled = await compileWorkshopBatchSafe(items, resolvedGame, tempDir, sendProgress);

    // ── Фаза 3: сборка списка для VPK ──────────────────────────────
    for (const c of compiled) {
      const compiledData = await fs.readFile(c.compiled);
      // Путь внутри VPK = оригинальный путь (с .vpcf_c — как в pak01)
      vpkFiles.push({ fullPath: c.pp, data: compiledData });
      sendProgress(`  ✅ ${c.origBase} (${(compiledData.length / 1024).toFixed(0)} KB)`);
    }

    if (!vpkFiles.length) throw new Error('Не удалось обработать ни одного файла частиц');

    // ── Фаза 4: Упаковка в VPK ─────────────────────────────────────
    sendProgress(`Упаковка ${vpkFiles.length} .vpcf_c в VPK...`);
    const vpkBuf  = buildVpkV1(vpkFiles);
    const modId   = `workshop-${safeId(modName)}-${Date.now()}`;
    // Имя файла — от уникального modId, а не от названия: иначе сборка «Test»
    // с другим цветом молча перезаписывала предыдущий VPK, а старая карточка
    // указывала на чужой контент
    const vpkName = `${modId}.vpk`;
    const vpkDest = path.join(workshopPath(), vpkName);
    await fs.writeFile(vpkDest, vpkBuf);

    // ── Фаза 5: Регистрация в каталоге ──────────────────────────────
    sendProgress('Регистрация в локальном каталоге...');
    const builtCategory = inferWorkshopCategory(particlePaths);
    const localMod = {
      id: modId, name: modName, hero: 'Общее', category: builtCategory,
      buildSig: workshopBuildSig(particlePaths, targetHue),
      replaces: builtCategory === 'couriers'
        ? `Курьер · ${vpkFiles.length} файл(ов)`
        : `Скомпилированные .vpcf_c эффекты · ${vpkFiles.length} файл(ов)`,
      conflictKeys: vpkFiles.map(f => `workshop:${safeId(path.basename(f.fullPath))}`),
      size: `${(vpkBuf.length / 1024 / 1024).toFixed(2)} MB`,
      tags: workshopTags(builtCategory), previewUrl: null, downloadUrl: null,
      source: 'Мастерская', localVpk: vpkDest,
    };
    const cacheFile = path.join(cachePath(), `${safeId(modId)}-workshop.vpk`);
    await fs.copyFile(vpkDest, cacheFile);
    const catalog = await readJson(path.join(cachePath(), 'catalog.json'), []);
    const idx = catalog.findIndex(m => m.id === modId);
    if (idx >= 0) catalog[idx] = localMod; else catalog.unshift(localMod);
    await writeJson(path.join(cachePath(), 'catalog.json'), catalog);

    sendProgress(`✅ Готово — ${vpkName} (${(vpkBuf.length / 1024).toFixed(0)} KB) — содержит скомпилированные .vpcf_c`);
    return { modId, vpkPath: vpkDest, fileCount: vpkFiles.length, sizeBytes: vpkBuf.length };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
  });
}

// ───────────────────────────────────────────────────────────────────
function createWindow() {
  const window = new BrowserWindow({ width: 1500, height: 960, minWidth: 1120, minHeight: 700, backgroundColor: '#0b1018', titleBarStyle: 'hidden', titleBarOverlay: { color: '#0b1018', symbolColor: '#d9e6f3', height: 38 }, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  window.loadFile(path.join(__dirname, 'index.html'));
}
app.whenReady().then(async () => {
  await sweepTempDirs();
  ipcMain.handle('catalog:get', getCatalog);
  ipcMain.handle('settings:get', async () => { const current = await settings(); return { ...current, langFolders: gameLangFolders(current.gamePath), vpkTool: await findVpkTool(current.gamePath) }; });
  ipcMain.handle('settings:save', async (_, next) => { const current = await settings(); const gamePath = String(next.gamePath || current.gamePath).trim(); const voiceFolder = /^dota_[a-z]+$/i.test(String(next.voiceFolder || '')) ? String(next.voiceFolder) : ''; const autoCloseSteam = next.autoCloseSteam !== false; const catalogUrls = Array.isArray(next.catalogUrls) ? next.catalogUrls.slice(0, 10).map(validateCatalogUrl) : current.catalogUrls; await writeJson(configPath(), { ...current, gamePath, voiceFolder, autoCloseSteam, catalogUrls }); const saved = await settings(); return { ...saved, langFolders: gameLangFolders(saved.gamePath), vpkTool: await findVpkTool(gamePath) }; });
  ipcMain.handle('catalog:add-source', async (_, value) => { const url = validateCatalogUrl(value); const current = await settings(); if (current.catalogUrls.includes(url)) return current; if (current.catalogUrls.length >= 10) throw new Error('Можно добавить не более 10 авторских каталогов'); await writeJson(configPath(), { ...current, catalogUrls: [...current.catalogUrls, url] }); return settings(); });
  ipcMain.handle('catalog:remove-source', async (_, value) => { const url = validateCatalogUrl(value); const current = await settings(); await writeJson(configPath(), { ...current, catalogUrls: current.catalogUrls.filter(item => item !== url) }); return settings(); });
  ipcMain.handle('mod:download', async (_, mod) => downloadMod(mod));
  ipcMain.handle('mod:cached', async (_, id) => Boolean(await findCachedFile(id)));
  ipcMain.handle('mods:cached-ids', async (_, ids) => findCachedIds(ids));
  ipcMain.handle('set:apply', async (_, payload) => applySet(payload));
  ipcMain.handle('set:extend', async (_, payload) => extendSet(payload));
  ipcMain.handle('sets:list', () => readJson(manifestPath(), []));
  ipcMain.handle('set:active-id', activeSetId);
  ipcMain.handle('set:rollback', async (_, id) => rollback(id));
  ipcMain.handle('set:remove-mod', async (_, payload) => removeModFromSet(payload));
  ipcMain.handle('sets:purge', async () => purgeHistory());
  ipcMain.handle('set:install-game', async (_, id) => installSetToGame(String(id || '')));
  ipcMain.handle('set:clear-game', async () => clearGameOverlay((await settings()).gamePath));
  ipcMain.handle('mods:installed-ids', async () => installedModIds());
  ipcMain.handle('workshop:find-duplicate', async (_, { paths, hue }) => findDuplicateBuild(paths || [], Number(hue)));
  ipcMain.handle('workshop:delete-mod', async (_, modId) => deleteWorkshopMod(String(modId || '')));
  ipcMain.handle('mod:delete-cached', async (_, modId) => deleteCachedMod(String(modId || '')));
  ipcMain.handle('dialog:game-folder', async () => { const result = await dialog.showOpenDialog({ properties: ['openDirectory'] }); return result.canceled ? null : result.filePaths[0]; });
  ipcMain.handle('set:open-folder', async (_, folder) => { const dir = String(folder || ''); if (!dir) throw new Error('Нет пути для открытия'); await shell.openPath(dir); return true; });
  ipcMain.handle('source:open', () => shell.openExternal(SOURCE_ROOT));
  ipcMain.handle('app-repository:open', () => shell.openExternal(APP_REPOSITORY));
  // Workshop IPC
  ipcMain.handle('workshop:tool-status', async (_, gamePath) => workshopToolStatus(gamePath));
  const SAFE_OPEN_HOSTS = new Set(['store.steampowered.com', 'steamcommunity.com', 'dotnet.microsoft.com', 'github.com']);
  ipcMain.handle('workshop:open-url', async (_, url) => {
    let u;
    try { u = new URL(String(url || '')); } catch { throw new Error('Некорректная ссылка'); }
    if (u.protocol !== 'https:' || !SAFE_OPEN_HOSTS.has(u.hostname)) throw new Error('Ссылка не входит в разрешённые');
    await shell.openExternal(u.toString());
    return true;
  });
  // Сырой вывод --help для диагностики при первом запуске с рантаймом:
  // если флаги называются иначе — видно сразу, а не через парсинг
  ipcMain.handle('workshop:vrf-help', async () => {
    const exe = vrfExePath();
    if (!fss.existsSync(exe)) throw new Error('VRF не установлен');
    const { stdout, stderr } = await execFileAsync(exe, ['--help'], { timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    return `${stdout || ''}\n${stderr || ''}`.trim() || '(пустой вывод)';
  });
  ipcMain.handle('workshop:download-tool', async (event) => {
    const send = msg => event.sender.send('workshop:progress', msg);
    return downloadVrfTool(send);
  });
  ipcMain.handle('workshop:list-particles', async (_, { gamePath, query }) => {
    return listParticlesInPak(gamePath || (await settings()).gamePath, query || '');
  });
  ipcMain.handle('workshop:build', async (event, params) => {
    const send = msg => event.sender.send('workshop:progress', msg);
    return buildWorkshopMod(params, send);
  });
  // Префлайт процессов + закрытие по явной кнопке пользователя
  ipcMain.handle('workshop:preflight', async () => runningGameProcs());
  ipcMain.handle('workshop:close-app', async (_, id) => closeGameProc(String(id || '')));
  createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
