// 旧剧情 → 新引擎冷启动数据。
//
// 用法：node src/migration/export.js <旧 koishi.db> [输出目录]
// 产出：
//   timeline.jsonl  —— 世界事件序列（已应用 retcon 修正，prose 作为渲染文本保留）
//   impressions.json—— 对用户的初始印象（按剧情进度给定，不是从零开始）
//   audit.json      —— 被 retcon 的条目清单，可回溯为什么删
//
// retcon 规则写在 data/retcon.json，形如：
//   { "drop": [1435, 1439], "note": { "1435": "把生日局出门提前到 15:11，与主线 18:06 出门重复" } }

import sqlite3 from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DB = process.argv[2];
const OUT_DIR = process.argv[3] || path.join('data');

if (!DB) {
  console.error('用法：node src/migration/export.js <旧 koishi.db> [输出目录]');
  process.exit(1);
}
const RETCON_PATH = path.join(OUT_DIR, 'retcon.json');

const MOVE_RULES = [
  { to: 'transit', label: '出门/在路上', re: /(拉开门|走了出去|出门|下楼|楼道|走在路上|车厢里|车上)/ },
  { to: 'home', label: '回家', re: /(回到房间|回到家|到家了|进屋|推门进)/ },
  { to: 'outside_social', label: '到达聚会地点', re: /(推开车门|车子在.*门口停稳|走进去|推开门走进)/ },
  { to: 'office', label: '到公司', re: /(到工位|到(了)?公司|走进公司)/ },
];

function stripQuoted(text) {
  return String(text ?? '').replace(/[“"][^”"\n]{1,200}?[”"]/g, (m) => '　'.repeat(m.length));
}

function detectMove(text) {
  const clean = stripQuoted(text);
  for (const r of MOVE_RULES) {
    if (r.re.test(clean)) return r;
  }
  return null;
}

function main() {
  const retcon = fs.existsSync(RETCON_PATH) ? JSON.parse(fs.readFileSync(RETCON_PATH, 'utf8')) : { drop: [], note: {} };
  const drop = new Set((retcon.drop ?? []).map(Number));

  const db = new sqlite3.DatabaseSync(DB, { readOnly: true });
  const rows = db.prepare('SELECT id, kind, content, occurredAt FROM interlude_script_entry ORDER BY occurredAt ASC, id ASC').all();
  db.close();

  const events = [];
  const dropped = [];
  const kinds = { user: 0, character: 0, script: 0, world: 0 };

  for (const r of rows) {
    if (drop.has(Number(r.id))) {
      dropped.push({ id: r.id, at: new Date(r.occurredAt).toISOString(), reason: retcon.note?.[String(r.id)] ?? '标记为需要剔除的矛盾条目' });
      continue;
    }
    const at = new Date(r.occurredAt).toISOString();
    const content = String(r.content ?? '');

    if (r.kind === 'user-message') {
      kinds.user += 1;
      events.push({ at, kind: 'world', actors: ['u:10001'], summary: `收到消息：${content.slice(0, 30)}`, prose: content, source: 'user' });
      continue;
    }
    if (r.kind === 'character-message' || r.kind === 'character-group-message') {
      kinds.character += 1;
      events.push({ at, kind: 'say', actors: ['self'], summary: content.slice(0, 30), prose: content, source: 'narrator' });
      continue;
    }
    if (r.kind === 'script') {
      kinds.script += 1;
      // 重要：不自动从散文推断位移。
      // 这正是旧系统的病根 —— 从 prose 猜「她出门了」猜不准（实测 13 条里有 10 条是假的，
      // 她明明在家睡觉也被判成在路上）。迁移只带内容，位移由新引擎自己记录。
      events.push({
        at,
        kind: 'act',
        place: retcon.seedPlace ?? 'home',
        summary: content.replace(/\s+/g, ' ').slice(0, 30),
        prose: content,
        source: 'narrator',
      });
      continue;
    }
    kinds.world += 1;
    events.push({ at, kind: 'world', summary: content.replace(/\s+/g, ' ').slice(0, 30), prose: content, source: 'seed' });
  }

  // 时间线必须单调
  const sorted = events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const timelinePath = path.join(OUT_DIR, 'timeline.jsonl');
  fs.writeFileSync(timelinePath, `${sorted.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');

  const impressionsPath = path.join(OUT_DIR, 'impressions.json');
  if (!fs.existsSync(impressionsPath)) {
    // 剧情已经走到「你，喜欢过我吗 / 不知道」这一步，印象不能从零开始
    fs.writeFileSync(impressionsPath, JSON.stringify({
      '10001': {
        userId: '10001',
        facets: { trust: 1, warmth: 1, annoyance: 0, intimacy: 1, interest: 1 },
        notes: [
          { text: '好久没联系的老同学/网友，最近才重新搭上话', evidenceEntryId: null, at: new Date().toISOString() },
          { text: '会记得她加班、关心她有没有好好吃饭', evidenceEntryId: null, at: new Date().toISOString() },
        ],
        updatedAt: new Date().toISOString(),
      },
    }, null, 2), 'utf8');
  }

  fs.writeFileSync(path.join(OUT_DIR, 'audit.json'), JSON.stringify({
    scanned: rows.length,
    kept: sorted.length,
    dropped,
    kinds,
    generatedAt: new Date().toISOString(),
  }, null, 2), 'utf8');

  console.log(`扫描 ${rows.length} 条，保留 ${sorted.length} 条，剔除 ${dropped.length} 条`);
  console.log(`  script ${kinds.script} / 她说 ${kinds.character} / 用户 ${kinds.user} / 其他 ${kinds.world}`);
  console.log(`输出: ${timelinePath}`);
}

main();
