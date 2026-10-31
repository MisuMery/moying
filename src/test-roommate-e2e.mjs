// 只读验收：让世界阶段真实生成「下班和陈哥同路」这一段，
// 看它会不会又把两人写成一回家；同时用校验器扫一遍有没有 R12。
import fs from 'node:fs';
import { Narrator } from './narrator/narrator.js';
import { Timeline, Place } from './world/state.js';
import { validateDrafts } from './world/validator.js';
import { loadPersona, buildRegistry } from './persona/card.js';
import { callLLM } from './llm/gateway.js';

const events = fs.readFileSync('/app/data/events.jsonl', 'utf8')
  .split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

const persona = loadPersona();
const registry = buildRegistry(persona);
const now = Date.now();

const triggers = [
  '<此刻触发>刚下班，她和陈哥一起出了楼门，同路往地铁口走。请写这一段（不用写他发消息的事）。',
  '<此刻触发>她和陈哥走到路口，该分开了。请写这一段。',
];

const BAD = /(一起回去|回去下饭|回她那儿|去她家|住一起|两人回家|一块儿回去|带回我家)/;

for (let i = 0; i < triggers.length; i += 1) {
  const tl = new Timeline(events, Place.TRANSIT);
  const n = new Narrator({
    store: { loadEvents: () => events },
    registry,
    persona,
    impressions: { render: () => '' },
    timeline: tl,
    llm: callLLM,
  });
  const r = await n.run({ trigger: triggers[i], userId: '1513971767', now, source: 'auto' });
  const drafts = r.events ?? r.drafts ?? [];
  const text = drafts.map((e) => `${e.summary ?? ''} ${e.prose ?? ''}`).join(' ');
  console.log(`\n=== 场景 ${i + 1}：${drafts.length} 条事件 ===`);
  for (const e of drafts) {
    console.log(`  [${e.kind}] ${(e.summary ?? '').slice(0, 70)}`);
  }
  console.log(`  叙事: ${(r.narration ?? '').slice(0, 120)}…`);
  const hit = BAD.exec(text);
  console.log(hit ? `  ✗ 命中同住句式「${hit[0]}」` : '  ✓ 无同住句式');

  const v = validateDrafts(drafts, tl, { now, registry });
  const r12 = v.violations.filter((x) => x.rule === 'R12');
  console.log(r12.length ? `  ✗ R12×${r12.length}：${r12.map((x) => x.message).join(' / ')}` : '  ✓ 无 R12');
}
