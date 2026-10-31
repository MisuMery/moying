// 只读验收：让世界阶段真实生成一段，看 say 事件有没有带 speaker / to
import fs from 'node:fs';
import { Narrator } from './narrator/narrator.js';
import { Timeline, Place, EventKind } from './world/state.js';
import { loadPersona, buildRegistry } from './persona/card.js';
import { callLLM } from './llm/gateway.js';

const events = fs.readFileSync('/app/data/events.jsonl', 'utf8')
  .split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

const persona = loadPersona();
const registry = buildRegistry(persona);
const tl = new Timeline(events, Place.HOME);
const now = Date.now();

const n = new Narrator({
  store: { loadEvents: () => events },
  registry,
  persona,
  impressions: { render: () => '' },
  timeline: tl,
  llm: callLLM,
});

const r = await n.run({
  trigger: '<此刻触发>现在是你自己的时间，没有新消息。\n请按她自己的兴趣、作息和当前钟点，继续她正在过的生活，把这一段写足、写具体。',
  userId: '1513971767',
  now,
  source: 'auto',
  maxRevision: 1,
});

console.log('修正:', (r.autoCorrected ?? []).length, '| 事件:', (r.events ?? []).length);
for (const e of r.events ?? []) {
  if (e.kind === EventKind.SAY) {
    console.log(`  [SAY] speaker=${e.speaker ?? '(缺)'} to=${e.to ?? '(空)'} | ${e.summary}`);
  } else {
    console.log(`  [${String(e.kind).toUpperCase()}] ${e.summary}`);
  }
}
