#!/usr/bin/env node
// 初始化 data/：把 templates/ 里的标准格式模板复制成可编辑的配置。
// 已存在的文件不会被覆盖（除非加 --force）。
//
//   node scripts/init-data.js            # 缺哪个补哪个
//   node scripts/init-data.js --force    # 全部用模板覆盖（会丢掉现有配置，慎用）

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../src/config.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const TPL = path.join(ROOT, 'templates');
const FORCE = process.argv.includes('--force');

const MAP = {
  'character.template.json': 'character.json',
  'cast.template.json': 'cast.json',
  'user.template.json': 'user.json',
  'world.template.json': 'world.json',
  'relationship.template.json': 'relationship.json',
};

fs.mkdirSync(DATA_DIR, { recursive: true });

let made = 0;
for (const [from, to] of Object.entries(MAP)) {
  const src = path.join(TPL, from);
  const dst = path.join(DATA_DIR, to);
  if (!fs.existsSync(src)) { console.log(`跳过：模板不存在 ${from}`); continue; }
  if (fs.existsSync(dst) && !FORCE) { console.log(`已存在，保留：${to}`); continue; }
  fs.copyFileSync(src, dst);
  console.log(`已生成：${to}`);
  made += 1;
}

// 数据文件（运行时生成，不需要模板）
for (const f of ['events.jsonl', 'ledger.jsonl', 'turns.jsonl']) {
  const dst = path.join(DATA_DIR, f);
  if (!fs.existsSync(dst)) { fs.writeFileSync(dst, '', 'utf8'); console.log(`已创建空文件：${f}`); }
}
fs.mkdirSync(path.join(DATA_DIR, 'stickers'), { recursive: true });

console.log(made ? `\n完成：data/ 已就绪（${DATA_DIR}）` : '\n没有需要生成的文件');
console.log('接下来：编辑 data/*.json，再配 data/config.json 里的三套 API 与 OneBot 地址，然后启动。');
