// 端到端干跑：复现「晚上旧书摊还去不 → 啊？我吗？ → 上周说的」这一轮，
// 看修复后她还会不会编出根本不存在的约定。只调用对话阶段，不发送任何消息。
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

const cases = [
  {
    name: '他追问「上周说的什么」',
    trigger: '<此刻触发>他发来一条消息：「上周说的什么？」\n请继续你的生活，并决定要不要回复、回复什么。',
    recent: ['[她] 晚上旧书摊还去不', '[他] 啊？我吗？', '[他] 上周说的什么？'],
    anchors: [],
  },
  {
    name: '日常关心（不该提任何过去）',
    trigger: '<此刻触发>他发来一条消息：「今天冷不冷，有没有加衣服」\n请继续你的生活，并决定要不要回复、回复什么。',
    recent: ['[他] 今天冷不冷，有没有加衣服'],
    anchors: [],
  },
  {
    name: '有真实原话可引用时',
    trigger: '<此刻触发>他发来一条消息：「在忙吗」\n请继续你的生活，并决定要不要回复、回复什么。',
    recent: ['[他] 在忙吗'],
    anchors: [{ label: '昨天 21:03', text: '那不多夸夸我' }],
  },
];

for (const c of cases) {
  const res = await d.run({
    worldSummary: '>>> 现在 2026-10-29 周四 10:30\n当前事实: 她在地铁上，独自一人。',
    trigger: c.trigger,
    userId: '1513971767',
    now: Date.now(),
    recentSays: ['晚上旧书摊还去不'],
    recentConversation: c.recent,
    pastAnchors: c.anchors,
    contact: { want: true, motive: null, text: '他刚发了消息' },
    canMessageUser: true,
    requireReply: true,
  });
  console.log(`\n[${c.name}] 重写=${res.revisions}`);
  for (const u of res.utterances) console.log('   →', u.content);
}
