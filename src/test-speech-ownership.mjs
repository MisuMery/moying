// 验证：话语归属（谁对谁说）与「A 的事不能套到 B 身上」
import { resolveSpeech, renderSpeechLine, isHerSayToUser } from './world/speech.js';
import { buildDailyDigest, renderDigest } from './world/digest.js';
import { validateDrafts, Severity } from './world/validator.js';
import { Timeline, Place, EventKind } from './world/state.js';
import { DialogueNarrator, renderCastOwnership } from './narrator/dialogue.js';
import { loadPersona, buildRegistry } from './persona/card.js';

let pass = 0; let fail = 0;
const ok = (n, c) => { if (c) { pass += 1; console.log(`  ✓ ${n}`); } else { fail += 1; console.log(`  ✗ ${n}`); } };
const nameOf = (id) => ({ 'c:linxia': '林夏', 'c:chenge': '陈哥' }[id] ?? id);

console.log('--- 1. 存量事件推断（821 条的老数据） ---');
{
  const a = resolveSpeech({ kind: 'say', actors: ['self', 'u:1513971767'], summary: '嗯' });
  ok('她说给他 → to=u:', a.speaker === 'self' && a.to === 'u:1513971767');

  const b = resolveSpeech({ kind: 'say', actors: ['c:linxia', 'self'], summary: '林夏问她怎么回来了、地铁那边出什么事了' }, { nameOf });
  ok('林夏问的 → speaker=林夏', b.speaker === 'c:linxia' && b.to === 'self');

  const c = resolveSpeech({ kind: 'say', actors: ['c:linxia', 'self'], summary: '问林夏明天早会几点' }, { nameOf });
  ok('她问林夏 → speaker=self, to=c:linxia', c.speaker === 'self' && c.to === 'c:linxia');

  const d = resolveSpeech({ kind: 'say', actors: ['self'], summary: '……' }, { nameOf });
  ok('只有 self → 自言自语', d.speaker === 'self' && d.to === null);

  const e = resolveSpeech({ kind: 'say', speaker: 'c:chenge', to: 'self', actors: ['self', 'c:chenge'], summary: '陈哥说随便应付一下' }, { nameOf });
  ok('显式 speaker 优先', e.speaker === 'c:chenge' && e.to === 'self');
}

console.log('--- 2. 渲染必须带归属 ---');
{
  const line = renderSpeechLine({ actors: ['c:linxia', 'self'], summary: '林夏问她怎么回来了' }, { nameOf });
  ok('配角说的标成「林夏对她说」', line.startsWith('林夏对她说：'));
  const line2 = renderSpeechLine({ actors: ['c:linxia', 'self'], summary: '问林夏明天早会几点' }, { nameOf });
  ok('她说的标成「她对林夏说」', line2.startsWith('她对林夏说：'));
  const line3 = renderSpeechLine({ actors: ['self'], summary: '算了' }, { nameOf });
  ok('自言自语单独标', line3.startsWith('她自言自语：'));
}

console.log('--- 3. 每日记忆不再把她/配角混在一起 ---');
{
  const now = Date.now();
  const at = new Date(now - 3600000).toISOString();
  const events = [
    { at, kind: 'say', actors: ['c:linxia', 'self'], summary: '林夏问她怎么回来了' },
    { at, kind: 'say', actors: ['self', 'c:linxia'], summary: '她说有点不舒服' },
    { at, kind: 'say', actors: ['self', 'u:1513971767'], summary: '嗯' },
  ];
  const dg = buildDailyDigest(events, now, { nameOf });
  const text = renderDigest(dg);
  ok('不再出现无主「说了：」', !text.includes('说了：'));
  ok('含「林夏对她说」', text.includes('林夏对她说'));
  ok('含「她对林夏说」', text.includes('她对林夏说'));
}

console.log('--- 4. 校验：say 必须写说话人 ---');
{
  const tl = new Timeline([], Place.HOME);
  const now = Date.now();
  const evs = [{ at: new Date(now - 60000).toISOString(), kind: EventKind.SAY, place: 'home', actors: ['self'], summary: '嗯' }];
  const v = validateDrafts(evs, tl, { now, registry: buildRegistry(loadPersona()) });
  ok('缺 speaker 报 R11 硬错误', v.violations.some((x) => x.rule === 'R11' && x.severity === Severity.HARD));

  const evs2 = [{ at: new Date(now - 60000).toISOString(), kind: EventKind.SAY, place: 'home', speaker: 'self', to: 'c:linxia', actors: ['self'], summary: '嗯' }];
  const v2 = validateDrafts(evs2, tl, { now, registry: buildRegistry(loadPersona()) });
  ok('写了 speaker 就不报 R11', !v2.violations.some((x) => x.rule === 'R11'));
}

console.log('--- 5. 对话提示里的「谁是谁」 ---');
{
  const p = loadPersona();
  const block = renderCastOwnership(p, '1513971767');
  ok('列出林夏/陈哥', block.includes('林夏') && block.includes('陈哥'));
  ok('明确「他们的事不能算成你和他」', block.includes('都不能说成「你和他」之间发生过'));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
