// 一次性数据迁移：清洗历史事件里的 actors 与 remote 标记。
//
// 背景：早期版本的模型会把「主角」直接写进 actors（应为 self），
// 用户消息事件也没标 remote —— 于是时间轴把「他发来一条消息」
// 推导成「他此刻坐在她旁边」。幂等，可重复跑。
//
// 用法：node scripts/migrate-actors.js [--apply]（不带 --apply 只预览）

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../src/config.js';
import { loadPersona, buildRegistry } from '../src/persona/card.js';

const APPLY = process.argv.includes('--apply');
const EVENTS = path.join(DATA_DIR, 'events.jsonl');

const persona = loadPersona();
const registry = buildRegistry(persona, { selfId: '10001' });

function normalizeActors(actors) {
  const out = [];
  for (const raw of Array.isArray(actors) ? actors : []) {
    const a = String(raw ?? '').trim();
    if (!a) continue;
    if (a === 'self') { out.push('self'); continue; }
    if (registry.get(a)) { out.push(a); continue; }
    const hit = registry.findByName?.(a);
    if (hit) out.push(hit.id);
  }
  return [...new Set(out)];
}

const rows = fs.readFileSync(EVENTS, 'utf8').split('\n').filter(Boolean).map((line) => {
  const e = JSON.parse(line);
  const before = JSON.stringify(e);
  // 1) 只有「收到消息」这种事件才是远程互动。
  //    注意 source==='user' 只说明这个回合由他的消息触发，
  //    回合里她自己的行为（act/narration）不是远程互动。
  const isHisMessage = e.source === 'user' && e.kind === 'world';
  if (isHisMessage) e.remote = true;
  else if (e.remote && e.source === 'user') delete e.remote;
  // 2) actors 归一
  const actors = normalizeActors(e.actors);
  if (actors.join(',') !== (e.actors ?? []).join(',')) e.actors = actors;
  return { e, changed: JSON.stringify(e) !== before };
});

const changed = rows.filter((r) => r.changed);
console.log(`共 ${rows.length} 条，需修正 ${changed.length} 条`);
for (const { e } of changed.slice(0, 20)) {
  console.log('  ', String(e.at).slice(0, 16), e.kind, '|', JSON.stringify(e.actors), e.remote ? '(远程)' : '');
}
if (!APPLY) {
  console.log('预览模式，加 --apply 才写入');
} else {
  fs.copyFileSync(EVENTS, `${EVENTS}.bak-${Date.now()}`);
  fs.writeFileSync(EVENTS, rows.map((r) => JSON.stringify(r.e)).join('\n') + '\n', 'utf8');
  console.log('已写入（原文件已备份）');
}
