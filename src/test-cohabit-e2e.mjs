// 端到端干跑：复现 2026-10-29 17:45 那轮——
// 她和陈哥下班路上聊「回去看看家里还有点菜 / 买点熟菜省得开火」，
// 同一时刻他发来「要你的安慰我才能好🥺」。
// 修复前她回「那快开完回来吃饭」（把异地当成同住）。
// 这里只跑对话阶段，不落库、不发送，跑两遍看稳定性。
import { DialogueNarrator } from './narrator/dialogue.js';
import { loadPersona, buildRegistry } from './persona/card.js';
import { callLLM } from './llm/gateway.js';
import { ImpressionStore } from './persona/impression.js';
import { checkFabricated } from './narrator/dialogue.js';

const persona = loadPersona();
const reg = buildRegistry(persona);
let imp = null;
try { imp = new ImpressionStore(); } catch { imp = null; }

const d = new DialogueNarrator({
  store: { loadEvents: () => [] },
  registry: reg,
  persona,
  impressions: imp ?? { render: () => '' },
  timeline: null,
  llm: callLLM,
});

const worldSummary = [
  '>>> 现在 2026-10-29 周四 17:45',
  '当前事实: 她在回家路上（地铁通道），陈哥同行。',
  '今天：下午一直在改甲方的图；六点本该下班，被拉去开了个短会；现在和陈哥一起走回去，路上在说晚饭。',
].join('\n');

const narration = [
  '陈哥还在絮叨，说下班回去路上顺便看看有没有卖熟菜的摊子，省得开火。她「嗯嗯」应着，眼睛却一直黏在屏幕上。',
  '通道尽头拐弯的地方信号断了一下，那个小圆圈在顶上转，她就把手机举高，走了两步，又回来。',
  '他的两条消息挨着摆在那儿，一条说刚说完不开会就被叫去开，一条说在食堂刚坐下扒了两口饭又被拎走。',
].join('\n');

const recent = [
  '[她] 好惨哦',
  '[他] 就是嘛，太过份了💢',
  '[他] 要你的安慰我才能好🥺',
];

const trigger = '<此刻触发>他刚发来：「要你的安慰我才能好🥺」\n请继续你的生活，并决定要不要回复、回复什么。';

const stage = { id: 'attached', name: '亲密', maxUtterances: 3, maxChars: 60 };

let bad = 0;
for (let round = 1; round <= 2; round += 1) {
  const res = await d.run({
    worldSummary,
    narration,
    trigger,
    userId: '1513971767',
    now: Date.now(),
    recentSays: ['饭都没吃好', '你们公司真是', '好惨哦', '你多大了还撒娇', '行吧'],
    recentConversation: recent,
    pastAnchors: [{ label: '今天 17:43', text: '要你的安慰我才能好🥺' }],
    stage,
    contact: null,
    canMessageUser: true,
    maxRevision: 1,
  });
  const texts = (res.utterances ?? []).map((u) => u.content);
  const hits = checkFabricated(texts, [{ label: '今天 17:43', text: '要你的安慰我才能好🥺' }], true);
  console.log(`\n=== 第 ${round} 轮 ===`);
  for (const u of res.utterances ?? []) console.log(`  ${u.addresseeId}｜${u.content}`);
  console.log(`  重写次数: ${res.revisions ?? 0}`);
  if (hits.length) {
    bad += 1;
    console.log(`  ✗ 仍有越界: ${hits.map((h) => `${h.kind}:${h.text}`).join(' / ')}`);
  } else {
    console.log('  ✓ 无同居/同城/虚构过去');
  }
  if (!texts.length) { bad += 1; console.log('  ✗ 一个字都没说'); }
}

console.log(bad ? `\n结果: ${bad} 处问题` : '\n结果: 全部通过');
