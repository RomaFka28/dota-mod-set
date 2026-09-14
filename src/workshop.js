// ================================================================
//  Workshop — UI-логика диалога «Мастерская»
// ================================================================

const ws = {
  status: null,          // последний результат tool-status
  groups: [],            // семейства { key, files } — топ-50 с сервера
  total: 0,              // всего семейств
  fileTotal: 0,          // всего файлов во всех семействах
  selected: new Set(),   // выбранные пользователем файлы
  building: false,
  searching: false,      // идёт поиск — тихий опрос статуса на паузе
  statusTimer: null,     // интервал живого опроса, пока диалог открыт
  note: '',              // пояснение к результатам (например, fallback-поиск)
  sortMode: 'best',      // best | name | path — порядок семейств
};
// Гвард закрытия по клику на фон: во время сборки окно не отдаём,
// иначе случайный клик убьёт прогресс и лог
function wsBackdropGuard() { return !ws.building; }

// VRF CLI self-contained: живого --help (caps.ok) достаточно, отдельный
// .NET 8 Runtime при этом не нужен — dotnet.exe может отсутствовать в PATH.
function wsDotnetOk(status) { return Boolean(status && (status.dotnetOk || status.vrfCaps?.ok)); }

// ── Подсказки поиска: unusual-направление ───────────────────────────
// Цель мастерской — кастомные unusual-стили: перекраска аур предметов,
// курьеров и unusual-частиц, а не способностей героев.
const UNUSUAL_HINTS = [
  // in: = только в ветке вещей (для владельцев: эффект виден, если вещь надета).
  // not: = всем видимое (базовые ветки, предмет не нужен).
  // Слово unusual в файлах отсутствует в принципе (проверено живым поиском:
  // unusual not:ui даёт 0) — настоящие unusual лежат как courier_trail_* /
  // courier_eye_glow_* в particles/econ/courier/ (Ethereal Flame, Burning
  // Doom...). Чип ищет следы; глазные сияния — словом courier_eye_glow.
  { label: 'Следы курьеров',  terms: ['courier_trail in:econ'] },
  { label: 'Ауры предметов',   terms: ['ambient in:econ/items'] },
  { label: 'Ауры всем видимые', terms: ['ambient not:econ not:ui not:dev not:pregame'] },
  { label: 'Курьеры',          terms: ['courier'] },
  { label: 'Prismatic',        terms: ['prismatic'] },
  { label: 'Ауры (aura)',      terms: ['aura not:ui not:dev'] },
  { label: 'Greevil',          terms: ['greevil'] },
];

// ── Цвет HSV: получить оттенок из hex ──────────────────────────────
function hexToHue(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  let h;
  if (max === r) h = ((g - b) / d + 6) % 6 / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return h;
}

// ── Отрисовка статус-строки инструментов ───────────────────────────
function wsRenderStatus(status) {
  ws.status = status;
  const el = document.getElementById('wsStatus');
  const rows = [];

  // VRF: готов + runtime-проверка флагов (--help probe в main)
  if (status.vrfReady) {
    const caps = status.vrfCaps || {};
    if (caps.ok)
      rows.push(
        `<span class="ws-ok">✓ VRF CLI — флаги ${escapeHtml(caps.listFlag)} / ${escapeHtml(caps.decompileFlag || '?')}</span>` +
        ' <a href="#" data-vrfhelp="1" class="ws-link" title="Вывести сырой текст --help в лог">показать --help</a>'
      );
    else
      rows.push(`<span class="ws-warn">⚠ VRF есть, но флаги не подтверждены (${escapeHtml(caps.reason || '?')}) — обновите VRF, иначе поиск/сборка могут не работать</span>`);
  }
  else
    rows.push('<span class="ws-warn">✗ VRF Decompiler не установлен — нажмите кнопку ниже</span>');

  // .NET 8 — чёткая ошибка со ссылкой вместо молчаливого сбоя.
  // Нюанс: VRF CLI self-contained (рантайм вшит в exe) — если его --help
  // выполняется (caps.ok), отдельный .NET не нужен. Живой запуск весомее,
  // чем `dotnet --list-runtimes` (dotnet.exe может просто отсутствовать в PATH).
  if (status.dotnetOk)
    rows.push(`<span class="ws-ok">✓ .NET ${escapeHtml(status.dotnetVersion)}</span>`);
  else if (status.vrfCaps?.ok)
    rows.push('<span class="ws-ok">✓ VRF запускается без отдельного .NET (self-contained — Runtime ставить не нужно)</span>');
  else
    rows.push(
      '<span class="ws-warn">✗ .NET 8 Runtime не найден — ' +
      `<a href="#" data-ext="${escapeHtml(status.dotnetUrl || 'https://dotnet.microsoft.com/download/dotnet/8.0')}" class="ws-link">` +
      'скачать с microsoft.com</a></span>'
    );

  // pak01
  if (status.pakExists)
    rows.push('<span class="ws-ok">✓ pak01_dir.vpk найден</span>');
  else
    rows.push('<span class="ws-warn">✗ pak01_dir.vpk не найден — проверьте путь к игре в ⚙ Настройках</span>');

  // Workshop Tools DLC — блокирующее требование для сборки (п.2):
  // ссылка на Steam-страницу DLC + кнопка сборки disabled с тултипом.
  if (status.compilerReady)
    rows.push('<span class="ws-ok">✓ resourcecompiler.exe (Workshop Tools)</span>');
  else
    rows.push(
      '<span class="ws-warn">✗ Workshop Tools DLC не установлен (~2 ГБ, без него сборка заблокирована) — ' +
      `<a href="#" data-ext="${escapeHtml(status.steamDlcUrl || 'https://store.steampowered.com/app/313250/')}" class="ws-link">` +
      'страница DLC в Steam</a>' +
      '<span class="ws-hint"> · Steam → Библиотека → вкладка «Инструменты» → ' +
      'Dota 2 Workshop Tools Alpha</span></span>'
    );

  el.innerHTML = rows.join('');

  // Префлайт процессов: предупреждение сразу при открытии, блокировка — на старте сборки
  {
    const busy = wsBusyList(status.runtime);
    if (busy.length)
      el.innerHTML += `<div style="margin-top:6px"><span class="ws-warn">⚠ Запущено: ${busy.map(k => WS_PF_LABEL[k]).join(', ')} — закройте перед сборкой, иначе файлы будут заблокированы</span></div>`;
  }

  // Поиск требует VRF + подтверждённый флаг списка + pak01 + (.NET или живой VRF)
  document.getElementById('wsSearchBtn').disabled =
    !status.vrfReady || !status.vrfCaps?.ok || !status.vrfCaps?.listFlag ||
    !wsDotnetOk(status) || !status.pakExists;
  // Кнопка скачать VRF
  document.getElementById('wsDlVrf').style.display = status.vrfReady ? 'none' : '';
  wsSyncBuildBtn();
}


function wsSyncBuildBtn() {
  const btn = document.getElementById('wsBuildBtn');
  const nameOk = document.getElementById('wsModName').value.trim().length > 0;
  // Компилятор + флаг декомпиляции обязательны: без них VPK будет
  // с .vpcf, которые игра проигнорирует. Кнопка disabled с тултипом,
  // а не падение в лог (п.2).
  const ready = !ws.building && ws.selected.size > 0 && nameOk &&
    ws.status?.vrfReady && ws.status?.vrfCaps?.ok && ws.status?.vrfCaps?.decompileFlag &&
    wsDotnetOk(ws.status) && ws.status?.pakExists && ws.status?.compilerReady;
  btn.disabled = !ready;
  if (!ws.status?.compilerReady)
    btn.title = 'Требуются Dota 2 Workshop Tools DLC (~2 ГБ) — ссылка в статусе выше';
  else if (!ws.status?.vrfCaps?.decompileFlag)
    btn.title = 'VRF CLI не подтвердил флаг декомпиляции — обновите VRF';
  else if (!wsDotnetOk(ws.status))
    btn.title = 'Требуется .NET 8 Runtime (VRF не запускается)';
  else if (ws.selected.size === 0)
    btn.title = 'Выберите хотя бы один .vpcf_c файл';
  else
    btn.title = '';
}

// ── Fix 3: Подсказки — маркетинговые имена → реальные термины поиска
function wsRenderHints() {
  const el = document.getElementById('wsHints');
  if (!el) return;
  el.innerHTML = UNUSUAL_HINTS.map(h =>
    `<button type="button" class="ws-hint-chip" data-term="${escapeHtml(h.terms[0])}">${escapeHtml(h.label)}</button>`
  ).join('') + '<div class="ws-hint-legend">🎒 = эффект вещи: появится на твоём экране, только если предмет надет. Без 🎒 — появляется сам, вещь не нужна. Всё в мастерской — только для себя: другие игроки видят обычный вид.</div>';
  el.querySelectorAll('.ws-hint-chip').forEach(btn => {
    btn.onclick = () => {
      document.getElementById('wsQuery').value = btn.dataset.term;
      wsSearch();
    };
  });
}

// ── Прогресс-лог ───────────────────────────────────────────────────
function wsLog(msg) {
  const el = document.getElementById('wsLog');
  el.classList.remove('hidden');
  const line = document.createElement('div');
  line.className = 'ws-log-line';
  line.textContent = msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}
function wsClearLog() {
  const el = document.getElementById('wsLog');
  el.innerHTML = '';
  el.classList.add('hidden');
}

// ── Сырой вывод VRF --help в лог (диагностика при первом запуске) ──
async function wsShowVrfHelp() {
  wsLog('— VRF --help (сырой вывод) —');
  try { wsLog(await window.workshop.vrfHelp()); }
  catch (err) { wsLog(`❌ --help не удался: ${err.message || err}`); }
}

// ── GROUP-BLOCK-START ──
// Ключ семейства эффекта: выкидываем сегменты-варианты (1 буква + цифры:
// _b, _c0, _d3) из ЛЮБОЙ позиции имени, чтобы варианты сложились в одну группу:
// laguna_blade_b → laguna_blade; strike_b_ethereal → strike_ethereal.
// Теги версий/событий (_ti8.._ti10, _cc2024, годы _2021.._2025) — мусор
// для группировки: события прошли, а семейства дробят. Чистим и в папке,
// и в имени. Целые слова не трогаем: blade_impact цел
// (impact — часть эффекта), icefire_bomb цел (bomb — слово, не вариант),
// titan цел (не подходит под ^ti\d+$).
// Кромка (edge) в ХВОСТЕ — часть того же предмета (ember sword edge
// красится вместе с телом меча). А blade НЕ режем: в laguna_blade и
// titan_slayer_blade клинок — ядро эффекта, а не деталь (тесты plain-intact
// и titan-kept это фиксируют).
// Хвостовые слои одного эффекта: bloom/ember/smoke/glow/ray/spark/heat/flame/
// fire/trail/ash/vapor + позиционные (lower/mouth/side/inner/outer/ground/
// head) + фазы (start/end/loop) + технический fx. Для перекраски всё это
// красится в один оттенок, поэтому режем итеративно с конца. НЕ режем
// геймплейно-разные слова: debuff/buff/target/cast/impact/proj — они остаются
// отдельными семействами (другой визуал, осознанный выбор).
const GROUP_TAIL_DROP = new Set([
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
function effectGroupKey(p) {
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
    if (GROUP_TAIL_DROP.has(tail) || /^[a-z]+\d+$/i.test(base[n - 1])) n--;
    else break;
  }
  return dir + (base.slice(0, n).join('_') || raw);
}
function prettyGroupName(key) {
  return key.split('/').pop().replace(/_/g, ' ');
}
// ── GROUP-BLOCK-END ──

// ── Отрисовка результатов: только строки семейств, без раскрытия ───
// Один клик по строке выбирает/снимает всё семейство целиком (0/9 → 9/9).
function wsRenderResults() {
  const el = document.getElementById('wsResults');
  if (!ws.groups.length) { el.innerHTML = '<div class="ws-empty">Ничего не найдено</div>'; return; }
  const list = [...ws.groups];
  if (ws.sortMode === 'name') list.sort((a, b) => prettyGroupName(a.key).localeCompare(prettyGroupName(b.key)));
  else if (ws.sortMode === 'path') list.sort((a, b) => a.key.localeCompare(b.key));
  // best = порядок сервера (ранг лучшего файла семейства)
  const note = ws.note ? `<div class="ws-note">${escapeHtml(ws.note)}</div>` : '';
  el.innerHTML = note + list.map((g, gi) => {
    const sel = g.files.filter(p => ws.selected.has(p)).length;
    const dir = g.key.split('/').slice(0, -1).join('/');
    // Эвристика видимости: эффект из ветки вещей грузится только с вещью.
    // Дефолтные вещи (курьер и т.п.) есть у всех — потому «обычно», а не «точно».
    const needsItem = (g.files[0] || '').toLowerCase().startsWith('particles/econ/');
    const badge = needsItem ? '<span class="ws-needsitem" title="Эффект вещи — виден в игре, только если предмет надет">🎒</span>' : '';
    return `<label class="ws-groupline ${sel > 0 ? 'selected' : ''}" data-gi="${gi}">
      <input type="checkbox" data-group="${gi}" ${sel === g.files.length && sel > 0 ? 'checked' : ''} title="Выбрать всё семейство">
      <span class="ws-gname">${escapeHtml(prettyGroupName(g.key))}${badge}</span>
      <span class="ws-gdir">${escapeHtml(dir)}</span>
      <span class="ws-gcount" data-gcount="${gi}">${sel}/${g.files.length}</span>
    </label>`;
  }).join('');
  list.forEach((g, gi) => {
    const sel = g.files.filter(p => ws.selected.has(p)).length;
    const box = el.querySelector(`input[data-group="${gi}"]`);
    if (box) box.indeterminate = sel > 0 && sel < g.files.length;
  });
  el.querySelectorAll('input[data-group]').forEach(gbox => {
    gbox.onchange = () => {
      const gi = Number(gbox.dataset.group);
      const g = list[gi];
      if (gbox.checked) g.files.forEach(p => ws.selected.add(p));
      else g.files.forEach(p => ws.selected.delete(p));
      const label = gbox.closest('label');
      const sel = g.files.filter(p => ws.selected.has(p)).length;
      label.classList.toggle('selected', sel > 0);
      label.querySelector('[data-gcount]').textContent = `${sel}/${g.files.length}`;
      gbox.checked = sel === g.files.length && sel > 0;
      gbox.indeterminate = sel > 0 && sel < g.files.length;
      document.getElementById('wsSelCount').textContent =
        ws.selected.size ? `Выбрано файлов: ${ws.selected.size}` : '';
      wsSyncBuildBtn();
    };
  });
}

// ── Поиск частиц ───────────────────────────────────────────────────
// Сервер возвращает { groups (топ-50 семейств), totalGroups, totalFiles }.
function wsCountNote() {
  if (ws.total > ws.groups.length)
    return `Найдено семейств: ${ws.total} (файлов: ${ws.fileTotal}), показаны первые ${ws.groups.length}. Уточните запрос.`;
  return ws.total > 0 ? `Найдено семейств: ${ws.total} (файлов: ${ws.fileTotal})` : '';
}
async function wsSearch() {
  const query = document.getElementById('wsQuery').value.trim();
  if (!query || ws.searching) return;
  const btn   = document.getElementById('wsSearchBtn');
  ws.searching = true;
  btn.disabled = true; btn.textContent = 'Поиск…';
  document.getElementById('wsResults').innerHTML = '<div class="ws-empty">Сканирование pak01_dir.vpk…</div>';
  try {
    const gamePath = typeof state !== 'undefined' ? state.settings?.gamePath : undefined;
    const res = await window.workshop.listParticles(gamePath, query);
    ws.groups = res.groups || [];
    ws.total = res.totalGroups ?? ws.groups.length;
    ws.fileTotal = res.totalFiles ?? ws.groups.reduce((n, g) => n + g.files.length, 0);
    ws.note = wsCountNote();
    // Фолбэк по токенам теперь делает сервер по закэшированному листингу
    // (без повторных сканов pak01) и возвращает самый специфичный токен:
    // 'burning' даёт 221 ambient-файл, а 'chaos' — кучнее.
    if (!ws.groups.length && res.fallbackToken) {
      ws.note = `По «${query}» точных совпадений нет — показаны совпадения по «${res.fallbackToken}» (самый точный токен). Уточните выбор вручную. ` + wsCountNote();
    }
    ws.selected.clear();
    document.getElementById('wsSelCount').textContent = '';
    wsRenderResults();
  } catch (e) {
    document.getElementById('wsResults').innerHTML =
      `<div class="ws-empty ws-err">${escapeHtml(e.message || String(e))}</div>`;
  } finally {
    ws.searching = false;
    // Пересчитываем доступность через статус, а не включаем вслепую:
    // без VRF/флагов/pak01 кнопка должна остаться disabled.
    if (ws.status) wsRenderStatus(ws.status); else btn.disabled = false;
    btn.textContent = 'Найти';
  }
}

// ── Скачать VRF ────────────────────────────────────────────────────
async function wsDownloadVrf() {
  const btn = document.getElementById('wsDlVrf');
  btn.disabled = true; btn.textContent = 'Скачивание…';
  wsClearLog();
  window.workshop.onProgress(wsLog);
  try {
    await window.workshop.downloadTool();
    const gamePath = typeof state !== 'undefined' ? state.settings?.gamePath : undefined;
    wsRenderStatus(await window.workshop.toolStatus(gamePath));
  } catch (e) {
    wsLog(`❌ Ошибка: ${e.message || e}`);
  } finally {
    window.workshop.offProgress();
    btn.disabled = false; btn.textContent = 'Скачать VRF (~55 MB)';
  }
}

// ── Генерация VPK ──────────────────────────────────────────────────
async function wsBuild() {
  const modName = document.getElementById('wsModName').value.trim();
  if (!modName || ws.selected.size === 0 || ws.building) return;
  // Префлайт процессов ДО старта: сборка пишет в папки Dota, запущенные
  // Dota 2 / Steam дадут файловые блокировки. Не стартуем — показываем бокс.
  const rt = await window.workshop.preflight().catch(() => ({ dota: false, steam: false, unknown: true }));
  if (rt.dota || rt.steam || rt.unknown) {
    // Авто-режим включён — main сам закроет процессы и перезапустит Steam,
    // идём дальше. Выключен — показываем бокс с кнопками закрытия.
    const autoClose = typeof state !== 'undefined' ? state.settings?.autoCloseSteam !== false : true;
    if (!autoClose) {
      wsShowPreflight(rt);
      wsLog('⏸ Сборка приостановлена: закройте Dota 2 / Steam (кнопки ниже), затем сборка продолжится сама');
      return;
    }
    wsLog('⏳ Steam/Dota запущены — закрываю автоматически, потом перезапущу Steam');
  }
  ws.building = true; wsSyncBuildBtn();
  const targetHue = hexToHue(document.getElementById('wsColor').value);
  const gamePath  = typeof state !== 'undefined' ? state.settings?.gamePath : undefined;
  // Дедуп сборок: те же исходники + тот же оттенок = тот же результат.
  // Спрашиваем, а не молча плодим одинаковые VPK.
  const dup = await window.workshop.findDuplicate([...ws.selected], targetHue).catch(() => null);
  if (dup && !await confirmStyled(`«${dup.name}» уже собран с тем же цветом. Собрать ещё раз?`, { title: 'Повторная сборка', okText: 'Собрать', danger: false })) {
    ws.building = false; wsSyncBuildBtn();
    wsLog('⏸ Сборка отменена — дубль уже есть в каталоге');
    return;
  }
  wsClearLog();
  wsLog(`Старт: «${modName}», файлов: ${ws.selected.size}, оттенок: ${Math.round(targetHue * 360)}°`);
  window.workshop.onProgress(wsLog);
  try {
    const result = await window.workshop.build({
      modName,
      particlePaths: [...ws.selected],
      targetHue,
      gamePath,
    });
    wsLog(`✅ VPK создан: ${result.vpkPath}`);
    wsLog(`   Файлов: ${result.fileCount}  Размер: ${(result.sizeBytes / 1024).toFixed(0)} KB`);
    if (typeof playChime === 'function') playChime('ok');
    // Перезагружаем каталог чтобы новый мод появился сразу
    if (typeof boot === 'function') {
      const catalog = await window.mods.catalog();
      if (typeof state !== 'undefined') {
        state.mods = catalog.mods;
        state.catalogMode = catalog.mode;
        await refreshCached();
        render();
      }
    }
    if (typeof toast === 'function') toast(`✅ Мод «${modName}» создан — добавлен в каталог`);
  } catch (e) {
    wsLog(`❌ Ошибка: ${e.message || e}`);
    if (typeof playChime === 'function') playChime('err');
    if (typeof toast === 'function') toast(e.message || 'Ошибка мастерской', true);
  } finally {
    window.workshop.offProgress();
    ws.building = false; wsSyncBuildBtn();
  }
}

// ── Префлайт-бокс: закрыть Dota 2 / Steam перед сборкой ────────────
const WS_PF_LABEL = { dota: 'Dota 2', steam: 'Steam', unknown: 'Steam/Dota (статус неизвестен)' };
function wsBusyList(rt) {
  const busy = ['dota', 'steam'].filter(k => rt && rt[k]);
  // Fail-closed: tasklist недоступен — считаем заблокированным,
  // main ответит понятной ошибкой вместо записи в залоченные файлы.
  if (rt && rt.unknown && !busy.length) busy.push('unknown');
  return busy;
}
function wsShowPreflight(rt) {
  const busy = wsBusyList(rt);
  const el = document.getElementById('wsPreflight');
  el.classList.remove('hidden');
  el.innerHTML =
    `<p>⏸ Перед сборкой закройте: <b>${busy.map(k => WS_PF_LABEL[k]).join(' и ')}</b> — ` +
    'иначе файлы в папках Dota заблокированы и компиляция упадёт.</p>' +
    '<div class="ws-pf-btns">' +
    busy.map(k => `<button type="button" class="soft-button" data-close="${k}">Закрыть ${WS_PF_LABEL[k]}</button>`).join('') +
    '<button type="button" class="soft-button" data-recheck="1">Я закрыл — проверить снова</button></div>';
}
function wsHidePreflight() {
  const el = document.getElementById('wsPreflight');
  el.classList.add('hidden');
  el.innerHTML = '';
}
async function wsRecheckPreflight() {
  const rt = await window.workshop.preflight().catch(() => ({ dota: false, steam: false }));
  if (wsBusyList(rt).length) { wsShowPreflight(rt); return false; }
  wsHidePreflight();
  return true;
}

// ── Живой статус: процессы могут закрыть вручную мимо наших кнопок —
// опрашиваем tool-status каждые 5 с, пока диалог открыт, и обновляем
// предупреждение + префлайт-бокс без переоткрытия диалога.
async function wsRefreshStatusQuiet() {
  if (ws.building || ws.searching) return;
  if (!document.getElementById('workshopDialog').open) return;
  try {
    const gamePath = typeof state !== 'undefined' ? state.settings?.gamePath : undefined;
    const status = await window.workshop.toolStatus(gamePath);
    wsRenderStatus(status);
    // Префлайт-бокс висел, а процессы уже закрыты вручную — снять его
    if (!document.getElementById('wsPreflight').classList.contains('hidden')) {
      if (wsBusyList(status.runtime).length) wsShowPreflight(status.runtime);
      else { wsHidePreflight(); wsLog('✅ Steam/Dota закрыты — можно собирать'); }
    }
  } catch { /* тихий опрос — ошибки не шумим, следующий тик повторит */ }
}

// ── Открытие диалога ────────────────────────────────────────────────
async function openWorkshop() {
  wsClearLog();
  wsHidePreflight();
  ws.groups = [];
  ws.total = 0;
  ws.fileTotal = 0;
  ws.note = '';
  ws.selected.clear();
  document.getElementById('wsResults').innerHTML = '';
  document.getElementById('wsSelCount').textContent = '';
  document.getElementById('wsModName').value = '';
  document.getElementById('wsQuery').value = '';
  document.getElementById('wsStatus').textContent = 'Проверка инструментов…';
  document.getElementById('workshopDialog').showModal();
  try {
    const gamePath = typeof state !== 'undefined' ? state.settings?.gamePath : undefined;
    wsRenderStatus(await window.workshop.toolStatus(gamePath));
  } catch (e) {
    document.getElementById('wsStatus').textContent = `Ошибка: ${e.message}`;
  }
  clearInterval(ws.statusTimer);
  ws.statusTimer = setInterval(wsRefreshStatusQuiet, 5000);
}

// ── Привязка событий (вызывается один раз при загрузке) ────────────
function initWorkshop() {
  document.getElementById('workshopButton').onclick = openWorkshop;
  // Диалог закрыли — останавливаем живой опрос (иначе тикает в фоне)
  document.getElementById('workshopDialog').addEventListener('close', () => {
    clearInterval(ws.statusTimer); ws.statusTimer = null;
  });
  // Esc во время сборки: method=dialog закроет окно вместе с логом и
  // прогрессом. Блокируем, сборка в main всё равно добежит.
  document.getElementById('workshopDialog').addEventListener('cancel', e => {
    if (ws.building) { e.preventDefault(); wsLog('⏳ Сборка идёт — дождитесь окончания, иначе потеряете лог'); }
  });
  document.getElementById('wsDlVrf').onclick        = wsDownloadVrf;
  document.getElementById('wsSearchBtn').onclick    = wsSearch;
  document.getElementById('wsBuildBtn').onclick     = wsBuild;
  document.getElementById('wsModName').oninput      = wsSyncBuildBtn;
  document.getElementById('wsQuery').addEventListener('keydown', e => {
    // Форма диалога method="dialog": Enter в поле = неявный сабмит = диалог
    // закрывается. Давим дефолт, поиск запускаем сами.
    if (e.key === 'Enter') { e.preventDefault(); wsSearch(); }
  });
  // То же для названия мода: Enter не должен закрывать мастерскую
  document.getElementById('wsModName').addEventListener('keydown', e => {
    if (e.key === 'Enter') e.preventDefault();
  });
  // Внешние ссылки (Steam DLC, .NET) открываем через main (shell.openExternal),
  // target=_blank в Electron для этого не подходит.
  document.getElementById('wsStatus').addEventListener('click', e => {
    const h = e.target.closest('[data-vrfhelp]');
    if (h) { e.preventDefault(); wsShowVrfHelp(); return; }
    const a = e.target.closest('[data-ext]');
    if (a) {
      e.preventDefault();
      window.workshop.openUrl(a.dataset.ext).catch(err => wsLog(`❌ Не удалось открыть ссылку: ${err.message || err}`));
    }
  });
  document.getElementById('wsSort').onchange = e => { ws.sortMode = e.target.value; wsRenderResults(); };
  // Кнопки префлайт-бокса (делегирование — бокс перерисовывается)
  document.getElementById('wsPreflight').addEventListener('click', async e => {
    const btn = e.target.closest('button');
    if (!btn || btn.disabled) return;
    if (btn.dataset.close) {
      const label = WS_PF_LABEL[btn.dataset.close] || btn.dataset.close;
      btn.disabled = true; btn.textContent = 'Закрытие…';
      try {
        await window.workshop.closeApp(btn.dataset.close);
        wsLog(`✅ ${label} закрыт`);
      } catch (err) {
        wsLog(`❌ Не удалось закрыть ${label}: ${err.message || err}`);
      }
      if (await wsRecheckPreflight()) { wsLog('▶ Продолжаю сборку…'); wsBuild(); }
    } else if (btn.dataset.recheck) {
      if (await wsRecheckPreflight()) { wsLog('▶ Продолжаю сборку…'); wsBuild(); }
      else wsLog('⏸ Всё ещё запущено — закройте процессы выше');
    }
  });
  wsRenderHints();
}
initWorkshop();
