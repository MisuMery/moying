// 验证：同住边界（只有林夏合租，陈哥只是同事）
import { validateDrafts, Severity } from './world/validator.js';
import { Timeline, Place, EventKind } from './world/state.js';
import { renderCastOwnership } from './narrator/dialogue.js';
import { loadPersona, buildRegistry, renderGeography, renderCast, renderLivingRules } from './persona/card.js';

let pass = 0; let fail = 0;
const ok = (n, c, e = '') => { if (c) { pass += 1; console.log(`  ✓ ${n}`); } else { fail += 1; console.log(`  ✗ ${n} ${e}`); } };

const persona = loadPersona();
const reg = buildRegistry(persona);
const now = Date.now();
const at = new Date(now - 60000).toISOString();
const tl = new Timeline([], Place.HOME);

const run = (ev) => validateDrafts([{ at, ...ev }], tl, { now, registry: reg });

console.log('--- 1. R12：陈哥不能出现在住处 ---');
{
  const v = run({ kind: EventKind.ACT, place: 'home', actors: ['self', 'c:chenge'], summary: '陈哥坐沙发上等她做饭' });
  const r12 = v.violations.filter((x) => x.rule === 'R12');
  ok('陈哥在 home 报 R12', r12.length === 1, JSON.stringify(v.violations.map((x) => x.rule)));
  ok('R12 是硬错误（会触发重写）', r12[0]?.severity === Severity.HARD, r12[0]?.severity);
  ok('提示文案说清「只是同事」', /同事/.test(r12[0]?.message ?? ''), r12[0]?.message);
}
{
  const v = run({ kind: EventKind.ACT, place: 'home', actors: ['self', 'c:linxia'], summary: '林夏在厨房煮面' });
  ok('林夏在 home 不报 R12', !v.violations.some((x) => x.rule === 'R12'), JSON.stringify(v.violations.map((x) => x.rule)));
}
{
  const v = run({ kind: EventKind.SAY, place: 'home', actors: ['self', 'c:chenge'], remote: true, speaker: 'c:chenge', to: 'self', summary: '陈哥发消息说明天早会' });
  ok('陈哥远程联系（remote）不报 R12', !v.violations.some((x) => x.rule === 'R12'), JSON.stringify(v.violations.map((x) => x.rule)));
}
{
  const v = run({ kind: EventKind.MOVE, to: 'home', from: 'transit', actors: ['self', 'c:chenge'], summary: '两人一起回她住处' });
  ok('move 到 home 带陈哥也报 R12', v.violations.some((x) => x.rule === 'R12'));
}
{
  const v = run({ kind: EventKind.ACT, place: 'food', actors: ['self', 'c:chenge'], summary: '两人在面馆吃面' });
  ok('陈哥在 food 不报 R12（同路吃饭合法）', !v.violations.some((x) => x.rule === 'R12'));
}

console.log('--- 2. 同住关系由 cast.presence 生成（不是手写的名字） ---');
{
  const lr = renderLivingRules(persona);
  ok('生成「跟你住在一起：林夏」', /跟你住在一起：林夏/.test(lr), lr.slice(0, 80));
  ok('陈哥被列为不住这儿', /陈哥不住你那儿/.test(lr));
  ok('写明到路口各走各的', /各走各的/.test(lr));
  ok('写明不许把他叫回家', /回来吃饭/.test(lr));
  ok('远程角色不会被说成不住这儿', !/张父张母不住你那儿/.test(lr));
  const castText = renderCast(persona);
  ok('renderCast 输出活动范围', /会出现在：/.test(castText), castText.slice(0, 60));
  ok('远程角色标为只能远程联系', /只能远程联系/.test(castText));
  ok('设定不再被截断到 120 字（留灯留粥）', castText.includes('留灯留粥'));
  const o = renderCastOwnership(persona, '1513971767');
  ok('归属块第 4 条指向「谁住在你那儿」', /谁住在你那儿/.test(o));
  ok('归属块不再手写「只有林夏」', !/跟你住在一起的只有林夏/.test(o));
  ok('地理块不再手写同住名单', !/跟你合租的只有林夏/.test(renderGeography(persona)));
}

console.log('--- 2b. 改数据即生效：把陈哥的地点加进 home ---');
{
  const patched = {
    ...persona,
    cast: persona.cast.map((c) => (c.id === 'chenge'
      ? { ...c, presence: { ...c.presence, places: [...c.presence.places, 'home'] } }
      : c)),
  };
  const lr = renderLivingRules(patched);
  ok('陈哥进同住名单', /跟你住在一起：.*林夏.*陈哥|跟你住在一起：.*陈哥/.test(lr), lr.slice(0, 100));
  ok('陈哥不再被列为「不住这儿」', !/陈哥不住你那儿/.test(lr));
  const back = renderLivingRules(persona);
  ok('改回后恢复原状', /陈哥不住你那儿/.test(back));
}

console.log('--- 3. 配角设定文件 ---');
{
  const cast = persona.cast ?? [];
  const lin = cast.find((c) => c.id === 'linxia');
  const chen = cast.find((c) => c.id === 'chenge');
  ok('林夏标为唯一同住人', /唯一的同住人/.test(lin?.notes ?? ''));
  ok('陈哥标注不住她那儿', /他不住张丽那儿/.test(chen?.notes ?? ''));
  ok('陈哥 presence 不含 home', !(chen?.presence?.places ?? []).includes('home'), JSON.stringify(chen?.presence?.places));
  ok('林夏 presence 含 home', (lin?.presence?.places ?? []).includes('home'));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
