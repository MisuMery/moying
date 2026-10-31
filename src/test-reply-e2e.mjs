// 端到端干跑：复现 2026-10-29 11:48（她在公司、刚跟陈哥吃完便利店饭团、
// 他连问三条）那一轮，看修复后：
//   1) 对话阶段还把不把台词写成「对陈哥说」；
//   2) requireReply 有没有真的产出给他的回复。
// 只跑对话阶段，不落库、不发送。
import { DialogueNarrator } from './narrator/dialogue.js';
import { loadPersona, buildRegistry } from './persona/card.js';
import { callLLM } from './llm/gateway.js';
import { ImpressionStore } from './persona/impression.js';

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
  '>>> 现在 2026-10-29 周四 11:55',
  '当前事实: 她在公司工位，和陈哥、阿哲在同一层。',
  '今天：上午改甲方两份稿；中午楼下排到四十多号，改去便利店买饭团鸡蛋；陈哥顺手把她那份也付了，现在刚上楼回工位。',
].join('\n');

const cases = [
  {
    name: '他追问昨晚 + 着凉（11:48 原场景）',
    trigger: '<此刻触发>他连着发了几条：\n1. 你还没有回我昨晚的消息呢\n2. 真的着凉了吗？\n（这几条是一起看到的，不要一条一条分别回，像真人那样一次说清楚就好）',
    recent: ['[她] 陈哥请的[表情:酷]', '[他] hhhhhhh，那好吧', '[他] 你还没有回我昨晚的消息呢', '[他] 真的着凉了吗？'],
    anchors: [{ label: '昨天 21:03', text: '那不多夸夸我' }],
  },
  {
    name: '他在上班时随口一问',
    trigger: '<此刻触发>他发来一条消息：「忙完没」\n请继续你的生活，并决定要不要回复、回复什么。',
    recent: ['[她] 在便利店买吃的', '[他] 忙完没'],
    anchors: [],
  },
];

let bad = 0;
for (const c of cases) {
  const res = await d.run({
    worldSummary,
    narration: '陈哥回工位问她电脑开没开，她答开了，边站着啃饭团。她把袋子搁在桌角，指腹在提手勒出的红印上按了两下，才去碰鼠标。',
    trigger: c.trigger,
    userId: '1513971767',
    now: Date.now(),
    recentSays: ['陈哥请的'],
    recentConversation: c.recent,
    pastAnchors: c.anchors,
    stage: { id: 'attached', name: '亲密', maxUtterances: 3, maxChars: 60 },
    contact: null,
    canMessageUser: true,
    maxRevision: 1,
    requireReply: true,
  });
  const uts = res.utterances ?? [];
  const toCast = uts.filter((u) => String(u.addresseeId ?? '').startsWith('c:'));
  const toUser = uts.filter((u) => String(u.addresseeId ?? '').startsWith('u:'));
  const pass = toUser.length > 0 && toCast.length === 0;
  if (!pass) bad += 1;
  console.log(`\n[${pass ? 'PASS' : 'FAIL'}] ${c.name}`);
  console.log('  utterances:', uts.map((u) => `${u.addresseeId}｜${u.content}`).join(' || ') || '(空)');
  console.log(`  发给他的 ${toUser.length} 条 / 发给故事的 ${toCast.length} 条 / 重写 ${res.revisions} 次`);
}
console.log(`\n结果: ${cases.length - bad} 通过 / ${bad} 失败`);
