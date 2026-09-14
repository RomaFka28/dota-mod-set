// Тесты группировки эффектов на РЕАЛЬНОМ коде из src/workshop.js (блок по маркерам).
// Запуск: npm test   (или: node src/grouping.test.js)
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, 'workshop.js'), 'utf8');
const start = src.indexOf('// ── GROUP-BLOCK-START ──');
const end = src.indexOf('// ── GROUP-BLOCK-END ──');
if (start < 0 || end < 0 || end < start) throw new Error('блок групп не найден в workshop.js');
eval('(function(){' + src.slice(start, end) + ';globalThis.__group = { effectGroupKey, prettyGroupName };})()');
const { effectGroupKey, prettyGroupName } = globalThis.__group;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
};
const D = 'particles/units/heroes/hero_lina/';

ok('variants-merge',
  effectGroupKey(D + 'lina_spell_laguna_blade.vpcf_c') === effectGroupKey(D + 'lina_spell_laguna_blade_b.vpcf_c') &&
  effectGroupKey(D + 'lina_spell_laguna_blade_b.vpcf_c') === effectGroupKey(D + 'lina_spell_laguna_blade_c.vpcf_c'));
ok('digit-variants-merge',
  effectGroupKey('x/ui_lina_fireball_c0.vpcf_c') === effectGroupKey('x/ui_lina_fireball_d3.vpcf_c'));
ok('impact-separate',
  effectGroupKey(D + 'lina_spell_laguna_blade_impact.vpcf_c') !== effectGroupKey(D + 'lina_spell_laguna_blade_b.vpcf_c'));
ok('cast-separate',
  effectGroupKey(D + 'lina_spell_laguna_blade_cast.vpcf_c') !== effectGroupKey(D + 'lina_spell_laguna_blade.vpcf_c'));
ok('bomb-intact', effectGroupKey('x/icefire_bomb.vpcf_c') === 'x/icefire_bomb');
ok('mid-variants-merge',
  effectGroupKey('m/morphling_adaptive_strike_b_ethereal.vpcf_c') === effectGroupKey('m/morphling_adaptive_strike_ethereal.vpcf_c') &&
  effectGroupKey('m/morphling_adaptive_strike_c_ethereal.vpcf_c') === effectGroupKey('m/morphling_adaptive_strike_ethereal.vpcf_c'));
ok('mid-single-letter-merges-base',
  effectGroupKey('p/pudge_arcana_dismember_hook_a_ethereal.vpcf_c') === effectGroupKey('p/pudge_arcana_dismember_hook_ethereal.vpcf_c'));
ok('burst-a-merges-base',
  effectGroupKey('i/ethereal_blade_owner_burst_a.vpcf_c') === effectGroupKey('i/ethereal_blade_owner_burst.vpcf_c'));
ok('letter-i-stripped',
  effectGroupKey('m/morphling_adaptive_strike_i_ethereal.vpcf_c') === effectGroupKey('m/morphling_adaptive_strike_ethereal.vpcf_c'));
ok('plain-intact', effectGroupKey(D + 'lina_spell_laguna_blade.vpcf_c') === D + 'lina_spell_laguna_blade');
ok('dir-matters',
  effectGroupKey('a/laguna_b.vpcf_c') !== effectGroupKey('b/laguna_b.vpcf_c'));
ok('backslash', effectGroupKey('a\\laguna_b.vpcf_c') === 'a/laguna');
ok('no-ext-ok', effectGroupKey('a/laguna_b') === 'a/laguna');
ok('pretty', prettyGroupName(D + 'lina_spell_laguna_blade') === 'lina spell laguna blade');
// TI-теги версий выкидываются из папки и имени, семейства сливаются
ok('ti-dir-merges',
  effectGroupKey('particles/econ/items/ursa/ursa_ti10/ursa_ti10_enrage_head.vpcf_c') ===
  effectGroupKey('particles/econ/items/ursa/ursa_ti9/ursa_ti9_enrage_head.vpcf_c'));
ok('ti-name-stripped', effectGroupKey('m/morphling_adaptive_strike_ti8_ethereal.vpcf_c') === effectGroupKey('m/morphling_adaptive_strike_ethereal.vpcf_c'));
ok('titan-intact', effectGroupKey(D + 'tidehunter_titan_anchor.vpcf_c') === D + 'tidehunter_titan_anchor');
ok('titan-kept', effectGroupKey(D + 'titan_slayer_blade.vpcf_c') === D + 'titan_slayer_blade');
// Теги Collector's Cache режутся как TI-теги (и в папке, и в имени)
ok('cc-dir-merges',
  effectGroupKey('w/warlock_cc2024_burning_puppet/warlock_cc2024_burning_puppet_fire.vpcf_c') ===
  effectGroupKey('w/warlock_burning_puppet/warlock_burning_puppet_fire.vpcf_c'));
ok('cc-name-stripped',
  effectGroupKey('w/puppet_cc2024_fire.vpcf_c') === effectGroupKey('w/puppet_fire.vpcf_c'));
// Каскад слоёв: group/fire/dark/small схлопываются в базу
ok('tail-cascade-merge',
  effectGroupKey(D + 'puppet_head_fire_group.vpcf_c') === effectGroupKey(D + 'puppet_head_fire_dark.vpcf_c') &&
  effectGroupKey(D + 'puppet_head_fire_dark.vpcf_c') === effectGroupKey(D + 'puppet.vpcf_c'));
ok('tail-small-chain',
  effectGroupKey(D + 'golem_bottom_glow_small.vpcf_c') === effectGroupKey(D + 'golem.vpcf_c'));
ok('tail-alt-merge',
  effectGroupKey(D + 'puppet_embers_alt.vpcf_c') === effectGroupKey(D + 'puppet.vpcf_c'));
// Годы-имморталки режутся как TI/CC-теги (и в папке, и в имени)
ok('year-dir-merges',
  effectGroupKey('w/huskar_2021_immortal/huskar_2021_immortal_burning_spear.vpcf_c') ===
  effectGroupKey('w/huskar_immortal/huskar_immortal_burning_spear.vpcf_c'));
ok('year-name-stripped',
  effectGroupKey(D + 'leaves_fallrewardline_2025.vpcf_c') === effectGroupKey(D + 'leaves_fallrewardline.vpcf_c'));
// Кромка в хвосте — часть того же предмета, сливается с базой…
ok('tail-edge-merge',
  effectGroupKey(D + 'burning_god_edge.vpcf_c') === effectGroupKey(D + 'burning_god.vpcf_c'));
// …а blade цел везде: клинок — ядро эффекта (laguna_blade, titan_slayer_blade)
ok('tail-blade-kept',
  effectGroupKey(D + 'burning_god_blade.vpcf_c') === D + 'burning_god_blade');
// laguna_blade цел: отделен геймплейным словом impact и не слипнется
ok('tail-blade-mid-kept',
  effectGroupKey(D + 'lina_spell_laguna_blade_impact.vpcf_c') !== effectGroupKey(D + 'lina_spell_laguna_blade.vpcf_c'));
// eclipse — название ульты, не слой: остаётся отдельным семейством
ok('tail-eclipse-kept',
  effectGroupKey(D + 'shadow_ambient_eclipse.vpcf_c') !== effectGroupKey(D + 'shadow_ambient.vpcf_c'));
// Хвостовые слои одного эффекта сливаются в базовое семейство
ok('tail-layers-merge',
  effectGroupKey(D + 'mount_ambient_bloom.vpcf_c') === effectGroupKey(D + 'mount_ambient_ember.vpcf_c') &&
  effectGroupKey(D + 'mount_ambient_ember.vpcf_c') === effectGroupKey(D + 'mount_ambient.vpcf_c'));
ok('tail-chain-merge',
  effectGroupKey(D + 'shadow_ambient_rays_hot.vpcf_c') === effectGroupKey(D + 'shadow_ambient.vpcf_c'));
ok('tail-positional-merge',
  effectGroupKey(D + 'bomber_lower.vpcf_c') === effectGroupKey(D + 'bomber_mouth.vpcf_c') &&
  effectGroupKey(D + 'bomber_mouth.vpcf_c') === effectGroupKey(D + 'bomber.vpcf_c'));
ok('tail-digit-merge',
  effectGroupKey(D + 'weapon_blade1_fx.vpcf_c') === effectGroupKey(D + 'weapon_blade4_fx.vpcf_c'));
// Геймплейно-разные слова не режем: debuff — отдельное семейство,
// но его слои (light) сливаются в него же
ok('tail-debuff-kept',
  effectGroupKey(D + 'w_spear_debuff.vpcf_c') !== effectGroupKey(D + 'w_spear.vpcf_c') &&
  effectGroupKey(D + 'w_spear_debuff_light.vpcf_c') === effectGroupKey(D + 'w_spear_debuff.vpcf_c'));
// Одиночное имя-слой не схлопывается в пустоту
ok('tail-base-intact',
  effectGroupKey(D + 'smoke.vpcf_c') === D + 'smoke' &&
  effectGroupKey(D + 'fire.vpcf_c') === D + 'fire');

// Зеркало в main.js обязано совпадать побайтово (иначе сервер группирует
// иначе, чем тесты проверяют). Сравниваем тела функций по балансу скобок.
function fnBody(code, name) {
  const i = code.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('функция ' + name + ' не найдена');
  let depth = 0, j = code.indexOf('{', i);
  for (; j < code.length; j++) {
    if (code[j] === '{') depth++;
    else if (code[j] === '}') { depth--; if (!depth) break; }
  }
  return code.slice(i, j + 1).replace('function ' + name + '(', 'function F(');
}
const mainSrc = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const normFn = t => t.replace(/GROUP_TAIL_DROP_MAIN/g, 'S').replace(/GROUP_TAIL_DROP/g, 'S');
ok('mirror-sync', normFn(fnBody(mainSrc, 'effectGroupKeyMain')) === normFn(fnBody(src, 'effectGroupKey')));
// Списки хвостовых слоёв тоже обязаны совпадать (иначе сервер группирует иначе)
{
  const grab = (code, name) => {
    const i = code.indexOf('const ' + name + ' = new Set([');
    if (i < 0) throw new Error('сет ' + name + ' не найден');
    return code.slice(i, code.indexOf(']);', i));
  };
  const norm = t => t.replace(/GROUP_TAIL_DROP_MAIN/g, 'S').replace(/GROUP_TAIL_DROP/g, 'S').replace(/\s+/g, '');
  ok('mirror-tail-sync', norm(grab(mainSrc, 'GROUP_TAIL_DROP_MAIN')) === norm(grab(src, 'GROUP_TAIL_DROP')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
