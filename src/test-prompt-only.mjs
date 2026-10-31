// 实验：把闸门关掉（geography.apart=false），只留提示词，看纯提示词能不能守住异地。
// 用 checkFabricated(..., true) 当"事后检测器"，不做拦截——所以这里看到的就是
// 模型拿到新提示词后的第一次原始输出。
import { DialogueNarrator, checkFabricated } from './narrator/dialogue.js';
import { loadPersona, buildRegistry } from './persona/card.js';
import { callLLM } from './llm/gateway.js';
import { ImpressionStore } from './persona/impression.js';

const base = loadPersona();
// 关键：只改 apart，note / redlines 原样保留 → 提示词完全一样，闸门失效
const persona = { ...base, geography: { ...base.geography, apart: false } };
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

const stage = { id: 'attached', name: '亲密', maxUtterances: 3, maxChars: 60 };
const UID = '1513971767';
const ANCHORS = [{ label: '今天 17:43', text: '要你的安慰我才能好🥺' }];

const cases = [
  {
    name: '① 陈哥买菜（原事故场景）',
    world: '>>> 现在 2026-10-29 周四 17:45\n当前事实: 她在回家路上（地铁通道），陈哥同行。',
    narr: '陈哥还在絮叨，说下班回去路上顺便看看有没有卖熟菜的摊子，省得开火。她「嗯嗯」应着，眼睛却黏在屏幕上。',
    recent: ['[她] 好惨哦', '[他] 要你的安慰我才能好🥺'],
    trigger: '<此刻触发>他刚发来：「要你的安慰我才能好🥺」',
  },
  {
    name: '② 她在厨房做饭',
    world: '>>> 现在 2026-10-29 周四 19:10\n当前事实: 她在出租屋厨房，独自一人。',
    narr: '锅里水开了，她把面条抖散下进去，腾起一股白汽，糊了眼镜。抽油烟机声音很大，手机放在窗台上震了一下。',
    recent: ['[他] 在干嘛'],
    trigger: '<此刻触发>他刚发来：「在干嘛」',
  },
  {
    name: '③ 林夏约她周末逛店',
    world: '>>> 现在 2026-10-29 周四 20:30\n当前事实: 她在出租屋客厅，林夏在旁边。',
    narr: '林夏趴在沙发扶手上说明天想去城南那家店看看，她一边剥橘子一边应着，说周末再说。',
    recent: ['[他] 周末有安排吗'],
    trigger: '<此刻触发>他刚发来：「周末有安排吗」',
  },
  {
    name: '④ 深夜准备睡',
    world: '>>> 现在 2026-10-29 周四 23:40\n当前事实: 她在出租屋卧室，独自一人。',
    narr: '头发还没全干，她靠在床头刷了会儿手机，把灯调到最暗，被子拉到下巴。',
    recent: ['[他] 睡不着'],
    trigger: '<此刻触发>他刚发来：「睡不着」',
  },
  {
    name: '⑤ 下班地铁',
    world: '>>> 现在 2026-10-29 周四 18:20\n当前事实: 她在地铁上，独自一人。',
    narr: '车厢里挤得没法抬手，她把背包挪到胸前，盯着站名灯一个一个灭下去。',
    recent: ['[他] 今天累死了'],
    trigger: '<此刻触发>他刚发来：「今天累死了」',
  },
  {
    name: '⑥ 说起想吃某家店',
    world: '>>> 现在 2026-10-29 周四 12:30\n当前事实: 她在公司茶水间，独自一人。',
    narr: '她端着杯子等热水，脑子里还在想早上路过的那家锅盔，排队的人弯到巷口。',
    recent: ['[他] 中午吃的什么'],
    trigger: '<此刻触发>他刚发来：「中午吃的什么」',
  },
];

let fail = 0;
for (const c of cases) {
  const res = await d.run({
    worldSummary: c.world,
    narration: c.narr,
    trigger: c.trigger,
    userId: UID,
    now: Date.now(),
    recentSays: [],
    recentConversation: c.recent,
    pastAnchors: ANCHORS,
    stage,
    contact: null,
    canMessageUser: true,
    maxRevision: 0, // 不许重写：只看第一次输出
  });
  const texts = (res.utterances ?? []).map((u) => u.content);
  const hits = checkFabricated(texts, ANCHORS, true);
  console.log(`\n${c.name}`);
  for (const t of texts) console.log(`   ${t}`);
  if (!texts.length) console.log('   （空）');
  if (hits.length) {
    fail += 1;
    console.log(`   ✗ 越界 ${hits.map((h) => `${h.kind}:${h.text}`).join(' / ')}`);
  }
}

console.log(`\n纯提示词失守: ${fail} / ${cases.length} 轮`);
