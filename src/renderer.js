const CATEGORIES = [
  ['all', '◫', 'Все моды'],
  ['heroes', '⚔', 'Скины героев'],
  ['hero-items', '🗡', 'Предметы героев'],
  ['personas', '◐', 'Облики и личности'],
  ['item-effects', '✨', 'Эффекты предметов'],
  ['effects', '✦', 'Эффекты заклинаний'],
  ['items', '◇', 'Иконки предметов'],
  ['emblems', '🔰', 'Эмблемы'],
  ['trees', '🌲', 'Деревья'],
  ['terrains', '▦', 'Ландшафт'],
  ['river', '≋', 'Реки'],
  ['towers', '♜', 'Башни'],
  ['roshan', '💀', 'Рошан'],
  ['ancient', '⛰', 'Древний / Торментор'],
  ['creeps', '🐉', 'Крипы'],
  ['creep-deny', '✗', 'Добивание крипов'],
  ['ranged-attack', '➶', 'Атака (дальний бой)'],
  ['wards', '◌', 'Варды'],
  ['couriers', '◈', 'Курьеры'],
  ['announcers', '📢', 'Дикторы'],
  ['music', '♪', 'Музыка'],
  ['sounds', '🔊', 'Звуки'],
  ['huds', '🖥', 'Интерфейс (HUD)'],
  ['cursors', '➤', 'Курсоры'],
  ['ui', '▤', 'Мелочи интерфейса'],
  ['fonts', '🔤', 'Шрифты'],
  ['backgrounds', '🖼', 'Фоны и VS-экраны'],
  ['textures', '▧', 'Текстуры и шейдеры'],
  ['other', '○', 'Прочее'],
  ['hero-skins', '◉', 'Скины героев (прочие)'],
];
const CATEGORY_NAMES = new Map(CATEGORIES.map(([key, , label]) => [key, label]));
const state = { mods: [], cart: [], category: 'all', hero: 'all', query: '', availability: 'all', settings: null, manifests: [], activeSetId: null, cached: new Set(), installed: new Set(), catalogMode: 'demo' };
const $ = selector => document.querySelector(selector);
const escapeHtml = text => String(text ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;' }[c]));
const initials = value => String(value || 'D').split(/[\s-]+/).map(x => x[0]).join('').slice(0, 2).toUpperCase();
const toastQueue = []; let toastActive = false;
function toast(message, error = false) { toastQueue.push({ message, error }); pumpToast(); }
function pumpToast() {
  if (toastActive || !toastQueue.length) return;
  toastActive = true;
  const { message, error } = toastQueue.shift();
  const el = $('#toast');
  el.textContent = message; el.className = `toast show${error ? ' error' : ''}`;
  setTimeout(() => { el.className = 'toast'; toastActive = false; pumpToast(); }, 4200);
}
// Звуковое оповещение без внешних файлов: WebAudio, две ноты.
// ok — восходящий динь (готово), err — низкий гул (ошибка). Не роняет UI.
let __audio = null;
function playChime(kind = 'ok') {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    __audio = __audio || new Ctx();
    if (__audio.state === 'suspended') __audio.resume().catch(() => {});
    const notes = kind === 'ok' ? [660, 880] : [220, 160];
    notes.forEach((freq, i) => {
      const osc = __audio.createOscillator(); const gain = __audio.createGain();
      osc.type = kind === 'ok' ? 'sine' : 'square'; osc.frequency.value = freq;
      const t = __audio.currentTime + i * 0.14;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
      osc.connect(gain); gain.connect(__audio.destination);
      osc.start(t); osc.stop(t + 0.15);
    });
  } catch { /* без звука — молча */ }
}
function categoryName(key) { return CATEGORY_NAMES.get(key) || key; }
function conflictMap() { const keys = new Map(); for (const mod of state.cart) for (const key of mod.conflictKeys || []) { const found = keys.get(key) || []; found.push(mod); keys.set(key, found); } return [...keys.entries()].filter(([, mods]) => mods.length > 1); }
function modStatus(mod) { if (state.cached.has(mod.id)) return 'ready'; return mod.downloadUrl ? 'download' : 'demo'; }
// Фильтр наличия («Все / Готово / Требуется скачать») — применяется и к сетке,
// и к спискам слева, чтобы счётчики героев/разделов показывали только то,
// что видно при активном фильтре (иначе «Готово» врёт в сайдбаре).
function matchesAvailability(mod) {
  if (state.availability === 'ready') return state.cached.has(mod.id);
  if (state.availability === 'download') return !state.cached.has(mod.id) && Boolean(mod.downloadUrl);
  return true;
}
function renderCategories() {
  const scoped = (state.hero === 'all' ? state.mods : state.mods.filter(m => m.hero === state.hero)).filter(matchesAvailability);
  $('#categoryList').innerHTML = CATEGORIES.map(([key, icon, label]) => {
    const count = key === 'all' ? scoped.length : scoped.filter(m => m.category === key).length;
    // hide empty categories (unless it's 'all' or currently selected)
    if (count === 0 && key !== 'all' && key !== state.category) return '';
    return `<button class="category-button ${state.category === key ? 'active' : ''}" data-category="${key}"><span class="cat-label"><span class="cat-icon">${icon}</span><span class="cat-mask"><span class="cat-text">${label}</span></span></span><span class="counter">${count}</span></button>`;
  }).join('');
  document.querySelectorAll('[data-category]').forEach(button => {
    button.onclick = () => { state.category = button.dataset.category; render(); };
    // Бегущая строка: только для обрезанных названий.
    // Замер — относительно .cat-mask (иконка вне маски, текст не наедет на неё).
    const t = button.querySelector('.cat-text');
    const box = button.querySelector('.cat-mask');
    if (t && box && t.scrollWidth > box.clientWidth + 1) {
      button.classList.add('marquee');
      t.innerHTML += '<span class="mq-sep">&nbsp;&nbsp;&nbsp;</span>' + t.innerHTML + '<span class="mq-sep">&nbsp;&nbsp;&nbsp;</span>';
    }
  });
}
function renderHeroes() {
  const categoried = (state.category === 'all' ? state.mods : state.mods.filter(m => m.category === state.category)).filter(matchesAvailability);
  const heroes = [...new Set(categoried.map(m => m.hero).filter(h => h && h !== 'Общее'))].sort((a,b) => a.localeCompare(b, 'ru'));
  $('#heroList').innerHTML = `<button class="hero-button ${state.hero === 'all' ? 'active' : ''}" data-hero="all"><span>Все герои</span></button>` + heroes.map(hero => `<button class="hero-button ${state.hero === hero ? 'active' : ''}" data-hero="${escapeHtml(hero)}"><span>${escapeHtml(hero)}</span><span class="counter">${categoried.filter(m => m.hero === hero).length}</span></button>`).join('');
  document.querySelectorAll('[data-hero]').forEach(button => button.onclick = () => { state.hero = button.dataset.hero; render(); });
}
function filteredMods() {
  const query = state.query.toLowerCase().trim();
  return state.mods.filter(mod => {
    const matchesScope = (state.category === 'all' || mod.category === state.category) && (state.hero === 'all' || mod.hero === state.hero);
    const matchesText = !query || [mod.name, mod.hero, mod.replaces, ...(mod.tags || [])].join(' ').toLowerCase().includes(query);
    return matchesScope && matchesText && matchesAvailability(mod);
  });
}
function renderCatalog(conflictEntries = conflictMap()) {
  const list = filteredMods(); const conflicts = new Set(conflictEntries.flatMap(([, mods]) => mods.map(m => m.id))); const selected = new Set(state.cart.map(m => m.id));
  $('#catalogTitle').textContent = state.hero !== 'all' ? state.hero : categoryName(state.category); $('#catalogDescription').textContent = `${list.length} ${list.length === 1 ? 'мод' : 'модов'} · на карточке указан заменяемый элемент`;
  $('#modGrid').innerHTML = list.map(mod => { const status = modStatus(mod); const statusBadge = conflicts.has(mod.id) ? '<span class="status conflict">КОНФЛИКТ</span>' : status === 'ready' ? '<span class="status ready">ГОТОВО</span>' : status === 'demo' ? '<span class="status download">ДЕМО</span>' : ''; const inCart = selected.has(mod.id); const hasImage = Boolean(mod.previewUrl);   const image = hasImage ? `<img class="preview-image" src="${escapeHtml(mod.previewUrl)}" alt="" loading="lazy" decoding="async" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'">` : ''; return `<article class="mod-card ${inCart ? 'selected' : ''} ${conflicts.has(mod.id) ? 'conflict' : ''}" data-mid="${escapeHtml(mod.id)}"><div class="preview-wrap">${image}<div class="avatar ${mod.hero === 'Общее' ? 'global' : ''}" style="${hasImage ? 'display:none' : ''}">${initials(mod.hero)}</div></div><div class="card-body"><div class="card-top">${statusBadge}${state.installed.has(mod.id) ? '<span class="status ingame">В ИГРЕ ✓</span>' : ''}</div><div class="card-title">${escapeHtml(mod.name)}</div><div class="card-hero">${escapeHtml(mod.hero)} · ${escapeHtml(categoryName(mod.category))}</div><div class="card-replaces">Заменяет: ${escapeHtml(mod.replaces)}</div><div class="card-footer">${mod.size && mod.size !== '—' ? `<span class="counter">${escapeHtml(mod.size)}</span>` : ''}<div class="card-actions">${status === 'download' ? `<button class="download-button" data-download="${escapeHtml(mod.id)}">Скачать</button>` : ''}${mod.source === 'Мастерская' && !state.installed.has(mod.id) ? `<button class="delete-button" data-delws="${escapeHtml(mod.id)}" title="Удалить сборку (VPK, кэш, карточка)">🗑</button>` : (status === 'ready' && !state.installed.has(mod.id)) ? `<button class="delete-button" data-delcache="${escapeHtml(mod.id)}" title="Удалить скачанный файл из кэша">🗑</button>` : ''}<button class="add-button" data-mod="${escapeHtml(mod.id)}"${state.installed.has(mod.id) && !inCart ? ' disabled title="Уже установлен в игре"' : ''}>${inCart ? 'Убрать' : state.installed.has(mod.id) ? 'В игре ✓' : 'В набор'}</button></div></div></div></article>`; }).join('');
  $('#emptyState').classList.toggle('hidden', list.length > 0);
}
async function deleteCachedMod(id) {
  const mod = state.mods.find(m => m.id === id);
  if (!mod) return;
  if (!await confirmStyled(`Удалить «${mod.name}» из кэша? Место освободится; при нужде скачается заново.`, { title: 'Удалить из кэша' })) return;
  try {
    await window.mods.deleteCached(id);
    state.cached.delete(id);
    state.cart = state.cart.filter(m => m.id !== id);
    playChime('ok'); toast(`«${mod.name}» удалён из кэша и убран из корзины`);
    render();
  } catch (e) { playChime('err'); toast(e.message || 'Не удалось удалить', true); }
}
async function deleteWorkshopMod(id) {
  const mod = state.mods.find(m => m.id === id);
  if (!mod) return;
  if (!await confirmStyled(`Удалить сборку «${mod.name}»? VPK, копия в кэше и карточка будут стёрты.`, { title: 'Удалить сборку' })) return;
  try {
    const res = await window.mods.deleteWorkshop(id);
    state.cart = state.cart.filter(m => m.id !== id);
    playChime('ok'); toast(`Сборка «${res.name}» удалена`);
    await refreshCatalog();
  } catch (e) { playChime('err'); toast(e.message || 'Не удалось удалить', true); }
}
function renderCart(conflictEntries = conflictMap()) {
  // Группировка корзины: по герою, а карточки без героя (hero 'Общее') —
// по своему разделу каталога, чтобы курьер не лежал в куче с эффектами.
  const cartGroup = mod => (mod.hero && mod.hero !== 'Общее') ? mod.hero : categoryName(mod.category);
  const groups = new Map(); state.cart.forEach(mod => { const key = cartGroup(mod); const values = groups.get(key) || []; values.push(mod); groups.set(key, values); });
  const conflictCount = conflictEntries.length; $('#cartCount').textContent = state.cart.length; $('#readyCount').textContent = `${state.cart.filter(m => state.cached.has(m.id)).length} / ${state.cart.length}`;
  $('#cartList').innerHTML = state.cart.length ? [...groups.entries()].map(([hero, mods]) => `<section class="cart-group"><div class="group-title">${escapeHtml(hero).toUpperCase()}</div>${mods.map(mod => `<div class="cart-item"><div><div class="cart-item-name">${escapeHtml(mod.name)}</div><div class="cart-item-meta">${escapeHtml(mod.replaces)}</div></div><button class="remove" data-remove="${escapeHtml(mod.id)}" title="Убрать из набора">×</button></div>`).join('')}</section>`).join('') : `<div class="cart-empty"><span>＋</span><p>Набор пока пуст</p><small>Нажмите «В набор» на карточке мода, чтобы начать.</small></div>`;
  document.querySelectorAll('[data-remove]').forEach(button => button.onclick = () => toggleCart(button.dataset.remove));
  const conflicts = $('#conflicts');
  conflicts.classList.toggle('hidden', !conflictCount);
  conflicts.innerHTML = conflictCount
    ? `<b>Конфликт${conflictCount === 1 ? '' : 'ы'}: ${conflictCount}</b><ul>${conflictEntries.map(([key, mods]) =>
      `<li><span>${escapeHtml(key.replace(/^(hero|global|workshop):/, ''))}</span>: ${mods.map(mod => escapeHtml(mod.name)).join(' · ')}</li>`
    ).join('')}</ul><small>Оставьте один мод для каждого слота.</small>`
    : '';
  const missing = state.cart.filter(mod => !state.cached.has(mod.id)).length;
  // DEMO-карточки (нет downloadUrl и не в кэше) скачать нельзя — кнопка
  // блокируется сразу, а не падает в downloadMissing посреди применения.
  const hasDemo = state.cart.some(mod => !state.cached.has(mod.id) && !mod.downloadUrl);
  const applyBtn = $('#applyButton');
  applyBtn.disabled = !state.cart.length || Boolean(conflictCount) || hasDemo;
  applyBtn.innerHTML = missing ? `Скачать и применить <span>→</span>` : `Применить набор <span>→</span>`;
  applyBtn.title = hasDemo ? 'В наборе есть демо-карточки без ссылки на скачивание — уберите их' : '';
}
function render() { const conflicts = conflictMap(); renderCategories(); renderHeroes(); renderCatalog(conflicts); renderCart(conflicts); }
function toggleCart(id) { const existing = state.cart.findIndex(mod => mod.id === id); if (existing >= 0) state.cart.splice(existing, 1); else { const mod = state.mods.find(x => x.id === id); if (mod) { if (state.installed.has(id)) { toast(`«${mod.name}» уже установлен в игре — в набор не добавляю`); return; } state.cart.push(mod); } } render(); }
async function refreshCached() {
  state.cached = new Set(await window.mods.cachedIds(state.mods.map(mod => mod.id)));
}
// Какие моды физически лежат в игре (для бейджа «В ИГРЕ» — защита от дублей)
async function refreshInstalled() { try { state.installed = new Set(await window.mods.installedIds()); state.activeSetId = await window.mods.activeSetId(); } catch { state.installed = new Set(); state.activeSetId = null; } }
async function downloadOne(id) { const mod = state.mods.find(item => item.id === id); if (!mod) return; try { toast(`Скачивание: ${mod.name}`); const result = await window.mods.download(mod); state.cached.add(mod.id); toast(`${mod.name}: готово (${Math.round(result.size / 1024 / 1024 * 10) / 10} MB)`); render(); } catch (error) { toast(error.message || 'Не удалось скачать мод', true); } }
async function downloadMissing() {
  const missing = state.cart.filter(mod => !state.cached.has(mod.id));
  const failed = [];
  for (const mod of missing) {
  try {
      toast(`Скачивание: ${mod.name}`);
      const result = await window.mods.download(mod);
      state.cached.add(mod.id);
      toast(`${mod.name}: готово (${Math.round(result.size / 1024 / 1024 * 10) / 10} MB)`);
      render();
    } catch (err) {
      failed.push(mod.name);
      toast(`Не удалось скачать «${mod.name}»: ${err.message || err}`, true);
    }
  }
  if (failed.length) throw new Error('Не удалось скачать: ' + failed.join(', '));
}
async function apply() {
  const button = $('#applyButton'); const original = button.innerHTML;
  button.disabled = true; button.innerHTML = 'Применение…';
  try {
    const missing = state.cart.filter(mod => !state.cached.has(mod.id));
    if (missing.length) await downloadMissing();
    const manifest = await window.mods.apply({ mods: state.cart, gamePath: state.settings.gamePath });
    state.manifests.unshift(manifest);
    state.lastSetId = manifest.id;
    $('#resultTitle').textContent = `Набор применён: ${manifest.files.length} VPK`;
    $('#resultMessage').textContent = `Создан изолированный набор ${manifest.id}. Файлы скопированы, базовый pak01 не изменён. Статус: ${manifest.state}.`;
    $('#resultPath').textContent = manifest.target;
    $('#resultFiles').innerHTML = manifest.files.map(f => `<li>${escapeHtml(f.modName)} → ${escapeHtml(f.file.split(/[\\/]/).pop())}</li>`).join('');
    $('#resultOpenFolder').onclick = () => window.mods.openFolder(manifest.target).catch(e => toast(e.message, true));
    $('#resultHistory').onclick = () => { $('#resultDialog').close(); showHistory(); };
    const installBtn = $('#resultInstall');
    installBtn.disabled = false; installBtn.textContent = 'Установить в игру →';
    installBtn.onclick = () => installLastSet();
    $('#resultDialog').showModal();
    playChime('ok');
    render();
  } catch (error) { playChime('err'); toast(error.message || 'Не удалось применить набор', true); button.innerHTML = original; button.disabled = false; return; }
  button.innerHTML = original; render();
}
// Установка применённого набора в папку озвучки игры (кнопка в диалоге результата).
// Префлайт Steam/Dota — на стороне main, отказ приходит понятной ошибкой.
async function installLastSet() {
  if (!state.lastSetId) { toast('Сначала примените набор', true); return; }
  const btn = $('#resultInstall');
  btn.disabled = true; btn.textContent = 'Установка…';
  try {
    // Предупреждаем заранее: при включённом автозакрытии Steam/Dota сейчас закроются сами
    const rt = await window.workshop.preflight().catch(() => null);
    if (rt && (rt.dota || rt.steam || rt.unknown) && state.settings?.autoCloseSteam !== false)
      toast('Закрываю Steam/Dota, ставлю моды и перезапускаю Steam…');
    const res = await window.mods.installGame(state.lastSetId);
    playChime('ok');
    $('#resultMessage').textContent =
      `✅ Моды в игре: ${res.files.map(f => f.name).join(', ')}. Папка: ${res.dir}. ` +
      'Уберите -language mods из параметров запуска (если добавляли) и запустите игру — ' +
      'язык озвучки в Доте должен совпадать с папкой из настроек.';
    if (res.prevDirChanged) toast('⚠ Прошлая установка была в другой папке озвучки — сверьте язык в Доте, иначе моды не подхватятся', true);
    $('#resultHint').classList.add('hidden');
    btn.textContent = 'Установлено ✓';
    await refreshInstalled(); render();
  } catch (e) {
    playChime('err');
    toast(e.message || 'Не удалось установить в игру', true);
    btn.disabled = false; btn.textContent = 'Установить в игру →';
  }
}
async function refreshCatalog() {
  const label = $('#catalogMode');
  label.textContent = 'Обновление каталога…';
  try {
    const catalog = await window.mods.catalog();
    state.mods = catalog.mods; state.catalogMode = catalog.mode;
    state.installed = new Set(catalog.installedModIds || []);
    label.textContent = catalog.mode === 'online' ? 'D2PFX: онлайн' : catalog.mode === 'cache' ? 'D2PFX: локальный кэш' : 'Демо-каталог (офлайн)';
await refreshCached(); render();
    if (!state.settings.gamePathValid) toast('Папка Dota 2 не найдена автоматически — укажите её в ⚙ Настройках кнопкой «Выбрать»', true);
    if (catalog.mode !== 'online') toast('Источник недоступен — показан сохранённый каталог', true);
    else { $('#notice').classList.add('hidden'); toast('Каталог обновлён'); }
  } catch (error) { label.textContent = 'Ошибка обновления'; toast(error.message, true); }
}
// Кнопка «Выбрать» — только когда авто не справилось: путь либо не проверен,
// либо проверен и бит. При валидном пути её нет, выбирать нечего.
function syncBrowseButton() {
  const ok = state.settings.gamePathValid && $('#gamePathInput').value.trim() === state.settings.gamePath;
  $('#browseButton').style.display = ok ? 'none' : '';
}
async function openSettings() {
  $('#gamePathInput').value = state.settings.gamePath;
  syncBrowseButton();
  renderGamePathStatus();
  const sel = $('#voiceFolderInput');
  const folders = state.settings.langFolders && state.settings.langFolders.length ? state.settings.langFolders : ['dota_russian', 'dota_english'];
  // Человеческие имена папок озвучки: сырой dota_schinese пользователю ни о чём не говорит
  const VOICE_NAMES = { english: 'Английская', russian: 'Русская', schinese: 'Китайская (упрощённая)', tchinese: 'Китайская (традиционная)', korean: 'Корейская', spanish: 'Испанская', french: 'Французская', german: 'Немецкая', portuguese: 'Португальская', brazilian: 'Бразильская', polish: 'Польская', turkish: 'Турецкая', ukrainian: 'Украинская', thai: 'Тайская' };
  const voiceLabel = f => { const key = String(f || '').replace(/^dota_/i, '').toLowerCase(); return `${VOICE_NAMES[key] || key} (${f})`; };
  // «Авто» честно говорит, куда положит: при одной папке — её имя, при нескольких — просит выбрать
  const autoLabel = folders.length === 1 ? `Авто — ставить в ${voiceLabel(folders[0])}` : 'Авто — выберите папку ниже';
  sel.innerHTML = `<option value="">${escapeHtml(autoLabel)}</option>` + folders.map(f => `<option value="${escapeHtml(f)}" ${state.settings.voiceFolder === f ? 'selected' : ''}>${escapeHtml(voiceLabel(f))}</option>`).join('');
  $('#autoCloseInput').checked = state.settings.autoCloseSteam !== false;
  $('#toolStatus').textContent = state.settings.vpkTool ? `Найден установленный VPK-инструмент: ${state.settings.vpkTool}` : 'VPK-инструмент не найден — для готовых VPK он не нужен.';
  renderCatalogSources();
  $('#settingsDialog').showModal();
}
function renderCatalogSources() {
  const urls = state.settings.catalogUrls || [];
  $('#catalogSourceList').innerHTML = urls.length
    ? urls.map(url => `<div class="catalog-source-row"><span title="${escapeHtml(url)}">${escapeHtml(url)}</span><button type="button" class="clear-button" data-remove-catalog="${escapeHtml(url)}">Удалить</button></div>`).join('')
    : '<div class="muted">Дополнительные каталоги не добавлены.</div>';
  document.querySelectorAll('[data-remove-catalog]').forEach(button => {
    button.onclick = async () => {
      try { state.settings = await window.mods.removeCatalogSource(button.dataset.removeCatalog); renderCatalogSources(); toast('Каталог удалён'); }
      catch (error) { toast(error.message, true); }
    };
  });
}
// Статус пути к игре: найденная автоматически папка помечается, битая —
// красным с объяснением. Светофор, а не молчаливый дефолт.
function renderGamePathStatus() {
  const el = $('#gamePathStatus');
  const val = $('#gamePathInput').value.trim();
  if (val !== state.settings.gamePath) {
    el.textContent = 'Нажмите «Сохранить», путь проверится (ищем game/dota/pak01_dir.vpk).';
    return;
  }
  if (state.settings.gamePathValid)
    el.textContent = state.settings.gamePathAuto
      ? '✓ Папка Dota 2 найдена автоматически — если игра стоит в другом месте, укажите вручную.'
      : '✓ Похоже на Dota 2 (pak01 на месте).';
  else
    el.textContent = '✗ Программа не нашла Dota 2 сама (нет game/dota/pak01_dir.vpk) — нажмите «Выбрать» и укажите папку вручную.';
}
async function showHistory() {
  [state.manifests, state.activeSetId] = await Promise.all([window.mods.installed(), window.mods.activeSetId()]);
  const list = $('#historyList');
  list.innerHTML = state.manifests.length ? state.manifests.map(set => {
    const active = set.state === 'applied' && set.id === state.activeSetId;
    const actions = set.state !== 'applied' ? '' : active
      ? `<span class="history-actions"><button class="install-game" disabled title="Этот набор уже находится в игре">Уже в игре ✓</button><button class="clear-set" data-clear-set="${escapeHtml(set.id)}">Убрать из игры</button></span>`
      : `<span class="history-actions"><button class="install-game" data-install="${escapeHtml(set.id)}">Установить в игру</button><button class="rollback" data-rollback="${escapeHtml(set.id)}">Удалить набор</button></span>`;
    const status = active ? 'в игре' : set.state === 'applied' ? 'готов' : set.state;
    return `<article class="history-item"><div class="history-row"><div><div class="history-name">${escapeHtml(set.id)}</div><div class="history-meta">${new Date(set.createdAt).toLocaleString('ru-RU')} · ${set.files.length} VPK · ${escapeHtml(status)}</div></div>${actions}</div></article>`;
  }).join('') : '<div class="empty">Наборов в истории ещё нет.</div>';
  document.querySelectorAll('[data-rollback]').forEach(button => button.onclick = async () => {
    if (!await confirmStyled('Удалить подготовленный набор и его запись из истории? После этого его нужно будет собрать заново.', { title: 'Удалить набор', okText: 'Удалить' })) return;
    try { const result = await window.mods.rollback(button.dataset.rollback); await refreshInstalled(); render(); toast(result.failed?.length ? `Удаление частичное: занято файлов ${result.failed.length}` : 'Набор удалён из истории'); showHistory(); } catch (error) { toast(error.message, true); }
  });
  document.querySelectorAll('[data-clear-set]').forEach(button => button.onclick = async () => {
    if (!await confirmStyled('Убрать активные VPK этого набора из игры? Сам набор останется в истории и его можно будет установить снова.', { title: 'Убрать из игры', okText: 'Убрать', danger: false })) return;
    try { const res = await window.mods.clearGame(); toast(res.removed ? `Активные моды убраны из игры (файлов: ${res.removed})` : 'В игре уже нет наших модов'); await refreshInstalled(); render(); showHistory(); } catch (error) { toast(error.message, true); }
  });
  document.querySelectorAll('[data-install]').forEach(button => button.onclick = async () => { button.disabled = true; try { const res = await window.mods.installGame(button.dataset.install); playChime('ok'); toast(`Моды в игре: ${res.files.map(f => f.name).join(', ')}`); await refreshInstalled(); render(); showHistory(); } catch (error) { playChime('err'); toast(error.message, true); } finally { button.disabled = false; } });
  $('#historyPurge').onclick = async () => { if (!await confirmStyled('Удалить из истории все удалённые и оборванные наборы? Готовые наборы не тронутся.', { title: 'Очистить историю', okText: 'Очистить' })) return; try { const res = await window.mods.purgeHistory(); playChime('ok'); toast(res.removed ? `История очищена: записей ${res.removed}` : 'История уже чиста'); showHistory(); } catch (error) { toast(error.message, true); } };
  $('#historyDialog').showModal();
}
async function boot() {
  if (!window.mods) {
    $('#catalogMode').textContent = 'Ошибка подключения приложения';
    $('#notice').classList.remove('hidden');
    $('#notice').textContent = 'Не удалось загрузить системный мост Electron. Закройте окно, запустите приложение через «npm start» из папки проекта и убедитесь, что открывается не index.html в браузере.';
    return;
  }
  try { const [catalog, settings, manifests] = await Promise.all([window.mods.catalog(), window.mods.settings(), window.mods.installed()]); state.mods = catalog.mods; state.settings = settings; state.manifests = manifests; state.catalogMode = catalog.mode; state.installed = new Set(catalog.installedModIds || []); $('#catalogMode').textContent = catalog.mode === 'online' ? 'D2PFX: онлайн' : catalog.mode === 'cache' ? 'D2PFX: локальный кэш' : 'Демо-каталог (офлайн)'; await refreshCached(); render(); if (catalog.mode !== 'online') { $('#notice').classList.remove('hidden'); $('#notice').textContent = catalog.mode === 'cache' ? 'Источник сейчас недоступен — показан сохранённый каталог D2PFX. Проверьте интернет (должен открываться raw.githubusercontent.com) или включите VPN, затем нажмите ↻ внизу слева.' : 'Источник сейчас недоступен и кэш пуст — показан демо-каталог. Карточки без ссылки нельзя скачать.'; } } catch (error) { toast(error.message, true); }
}
// Карточка крупно: большое фото + всё описание + действия.
// Клик по карточке (мимо кнопок) открывает, кнопки внутри работают как раньше.
function openModDetail(id) {
  const mod = state.mods.find(m => m.id === id);
  if (!mod) return;
  const status = modStatus(mod);
  const inCart = state.cart.some(m => m.id === id);
  $('#modImage').innerHTML = `<div class="avatar global">${initials(mod.hero)}</div>` +
    (mod.previewUrl ? `<img src="${escapeHtml(mod.previewUrl)}" alt="" onerror="this.remove()">` : '');
  $('#modTitle').textContent = mod.name;
  $('#modMeta').textContent = `${mod.hero} · ${categoryName(mod.category)}`;
  $('#modReplaces').textContent = `Заменяет: ${mod.replaces || 'не указано'}`;
  const tags = (mod.tags || []).filter(Boolean);
  $('#modTags').textContent = tags.length ? `Теги: ${tags.join(', ')}` : '';
  $('#modTags').classList.toggle('hidden', !tags.length);
  const size = mod.size && mod.size !== '—' ? mod.size : 'не указан';
  const stateTxt = state.installed.has(mod.id) ? 'В игре ✓' : status === 'ready' ? 'Скачан, готов к применению' : status === 'download' ? 'Нужно скачать' : 'Демо — скачать нельзя';
  $('#modInfo').textContent = `Размер: ${size} · ${stateTxt} · Источник: ${mod.source || 'D2PFX'}`;
  const dl = $('#modDownload');
  dl.style.display = status === 'download' ? '' : 'none';
  dl.onclick = async () => { await downloadOne(id); openModDetail(id); };
  const tg = $('#modToggle');
  tg.textContent = inCart ? 'Убрать из набора' : 'В набор';
  tg.disabled = state.installed.has(mod.id) && !inCart;
  tg.title = tg.disabled ? 'Уже установлен в игре' : '';
  tg.onclick = () => { toggleCart(id); openModDetail(id); };
  const dlg = $('#modDialog');
  if (!dlg.open) dlg.showModal();
}
$('#modGrid').addEventListener('click', e => {
  const button = e.target.closest('button');
  if (button) {
    if (button.dataset.mod) return toggleCart(button.dataset.mod);
    if (button.dataset.download) return downloadOne(button.dataset.download);
    if (button.dataset.delws) return deleteWorkshopMod(button.dataset.delws);
    if (button.dataset.delcache) return deleteCachedMod(button.dataset.delcache);
    return;
  }
  const card = e.target.closest('article[data-mid]');
  if (card) openModDetail(card.dataset.mid);
});
// Закрытие окна кликом по заднему фону (мимо самого окна).
// Клик строго по dialog (e.target === dlg) = мимо контента. guard —
// необязательный запрет (мастерская во время сборки не закрывается).
// Свой диалог подтверждения в стиле программы (нативный confirm() —
// чужеродное белое окно Windows). Возвращает Promise<boolean>.
// Закрытие через ×, Esc, клик по фону или «Отмена» = false.
let __confirmResolve = null;
function confirmStyled(message, { title = 'Подтвердите действие', okText = 'Удалить', danger = true } = {}) {
  const dlg = document.getElementById('confirmDialog');
  if (!dlg) return Promise.resolve(confirm(message)); // фолбэк, если разметки нет
  if (dlg.open) { const r = __confirmResolve; __confirmResolve = null; r?.(false); dlg.close(); }
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmMessage').textContent = message;
  const okBtn = document.getElementById('confirmOk');
  okBtn.textContent = okText;
  okBtn.dataset.danger = danger ? '1' : '0';
  return new Promise(resolve => { __confirmResolve = resolve; dlg.showModal(); });
}
function settleConfirm(value) {
  const dlg = document.getElementById('confirmDialog');
  if (__confirmResolve) { const r = __confirmResolve; __confirmResolve = null; r(value); }
  if (dlg?.open) dlg.close();
}
function backdropClose(id, guard) {
  const dlg = document.getElementById(id);
  if (!dlg || dlg.dataset.backdrop) return;
  dlg.dataset.backdrop = '1';
  dlg.addEventListener('click', e => {
    if (e.target === dlg && (!guard || guard())) dlg.close();
  });
}
backdropClose('modDialog');
backdropClose('resultDialog');
backdropClose('settingsDialog');
backdropClose('historyDialog');
backdropClose('workshopDialog', () => typeof wsBackdropGuard !== 'function' || wsBackdropGuard());
// Привязка кнопок своего диалога подтверждения (один раз)
document.getElementById('confirmOk').onclick = () => settleConfirm(true);
document.getElementById('confirmCancel').onclick = () => settleConfirm(false);
document.getElementById('confirmX').onclick = () => settleConfirm(false);
document.getElementById('confirmDialog').addEventListener('cancel', e => { e.preventDefault(); settleConfirm(false); });
document.getElementById('confirmDialog').addEventListener('click', e => { if (e.target === document.getElementById('confirmDialog')) settleConfirm(false); });
document.getElementById('confirmDialog').addEventListener('close', () => { if (__confirmResolve) { const r = __confirmResolve; __confirmResolve = null; r(false); } });
$('#searchInput').oninput = event => { state.query = event.target.value; renderCatalog(); };
document.querySelectorAll('[data-availability]').forEach(button => button.onclick = () => { state.availability = button.dataset.availability; document.querySelectorAll('[data-availability]').forEach(item => item.classList.toggle('active', item === button)); render(); });
$('#clearCart').onclick = async () => { if (!state.cart.length) return; if (!await confirmStyled('Очистить корзину? Набранные моды придётся добавлять заново.', { title: 'Очистить корзину', okText: 'Очистить', danger: false })) return; state.cart = []; render(); }; $('#applyButton').onclick = apply; $('#settingsButton').onclick = openSettings; $('#historyButton').onclick = showHistory; $('#refreshCatalog').onclick = refreshCatalog; $('#sourceButton').onclick = () => window.mods.openSource(); $('#appRepositoryButton').onclick = () => window.mods.openAppRepository();
$('#gamePathInput').addEventListener('keydown', e => {
  // form method=dialog: Enter в поле пути молча закрывал настройки без
  // сохранения. Давим дефолт и идём через обычное сохранение.
  if (e.key === 'Enter') { e.preventDefault(); $('#saveSettings').click(); }
});
$('#browseButton').onclick = async () => { const chosen = await window.mods.chooseGameFolder(); if (chosen) $('#gamePathInput').value = chosen; };
$('#gamePathInput').addEventListener('input', () => { state.settings.gamePathValid = false; syncBrowseButton(); renderGamePathStatus(); });
$('#addCatalogSource').onclick = async () => { const input = $('#catalogSourceInput'); const url = input.value.trim(); if (!url) return; try { state.settings = await window.mods.addCatalogSource(url); input.value = ''; renderCatalogSources(); toast('Каталог добавлен'); } catch (error) { toast(error.message, true); } };
$('#saveSettings').onclick = async event => { event.preventDefault(); try { state.settings = await window.mods.saveSettings({ gamePath: $('#gamePathInput').value, voiceFolder: $('#voiceFolderInput').value, autoCloseSteam: $('#autoCloseInput').checked, catalogUrls: state.settings.catalogUrls || [] }); $('#settingsDialog').close(); renderGamePathStatus(); if (state.settings.gamePathValid) toast('Настройки сохранены'); else toast('Путь сохранён, но это не похоже на Dota 2 (нет pak01) — установка и поиск работать не будут', true); } catch (error) { toast(error.message, true); } };
boot();
