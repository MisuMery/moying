// 表情包安全：file 字段只认 stickers 目录内的纯文件名。
//
// 这个测试必须住在「先设 MOYING_DATA_DIR 再 import」的文件里：
// stickers.js 的模块级路径来自 config.js 的 DATA_DIR，而 config.js 一旦被任何
// 静态 import 链提前载入（如 validator.js → card.js → config.js），环境变量就改了
// 也没用——测试会直接写脏真实的 data/stickers.json（2026-10-25 审查实证）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moying-stickers-'));
process.env.MOYING_DATA_DIR = tmp;

const { StickerStore } = await import('../src/features/stickers.js');

test('安全: 表情包的 file 字段只认 stickers 目录内的文件名', () => {
  const store = new StickerStore();
  // 绝对路径 / 穿越 / 怪扩展都必须被拒
  const bad = store.add({ file: '/etc/passwd', desc: 'x' });
  assert.ok(!bad.file, '绝对路径必须被清空');
  const bad2 = store.add({ file: '../../config.json', desc: 'x' });
  assert.ok(!bad2.file, '穿越路径必须被清空');
  const bad3 = store.add({ file: 'evil.sh', desc: 'x' });
  assert.ok(!bad3.file, '非图片扩展名必须被清空');
  assert.equal(store.absolutePath({ file: '/etc/passwd' }), null, 'absolutePath 也不认绝对路径');
  assert.equal(store.absolutePath({ file: '../a.png' }), null, 'absolutePath 不认穿越');
  // 落盘的只该是临时目录，不该碰真实 data/
  assert.ok(fs.existsSync(path.join(tmp, 'stickers.json')), '应写在临时 DATA_DIR 里');
});

test('安全: 备份恢复拒绝含软链接的包，且坏包给干净错误', async () => {
  const { inspectArchive } = await import('../src/backup.js');
  const { execFileSync } = await import('node:child_process');

  // ① 含软链接的包：解包时可能被"穿过去"写到 data/ 外面
  // （注意：不能加 -h，那是"打解引用后的内容"，就测不到链接条目了）
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'moying-link-'));
  fs.writeFileSync(path.join(d, 'character.json'), '{}');
  fs.symlinkSync('/etc/hostname', path.join(d, 'evil.txt'));
  const linked = path.join(d, 'linked.tar.gz');
  execFileSync('tar', ['-czf', linked, '-C', d, 'character.json', 'evil.txt']);
  const info = inspectArchive(linked);
  assert.equal(info.ok, false, '含软链接的包必须拒绝');
  assert.match(info.error ?? '', /非普通条目/, `应提示非普通条目，实际: ${info.error}`);

  // ② 不是 tar.gz 的包：干净的错误，而不是把 execFileSync 的裸错误冒出去
  const junk = path.join(d, 'junk.tar.gz');
  fs.writeFileSync(junk, 'this is not a tarball');
  const info2 = inspectArchive(junk);
  assert.equal(info2.ok, false);
  assert.match(info2.error ?? '', /无法读取/, `坏包应给干净错误，实际: ${info2.error}`);

  // ③ 正常包仍然通过（不误伤）
  const clean = path.join(d, 'clean.tar.gz');
  execFileSync('tar', ['-czf', clean, '-C', d, 'character.json']);
  const info3 = inspectArchive(clean);
  assert.equal(info3.ok, true, '正常包不该被误伤');
  assert.ok(info3.contains.includes('character.json'));
});

test('安全: 配置合并跳过 __proto__ 等危险键', async () => {
  const { saveConfig, loadConfig } = await import('../src/config.js');
  // JSON.parse 才会产出 own property「__proto__」（对象字面量不会），
  // 这正是磁盘 config.json / API 请求体最可能的注入形态
  const evil = JSON.parse('{"api":{"chat":{"apiKey":"k1"}},"__proto__":{"polluted":"yes"}}');
  const merged = saveConfig(evil);
  assert.equal(({}).polluted, undefined, 'Object.prototype 不该被污染');
  assert.equal(Object.getPrototypeOf(merged), Object.prototype, 'merged 的原型不该被换掉');
  assert.equal(merged.api.chat.apiKey, 'k1', '正常字段照样合并');
  // 落盘后重新读，也不该带出危险键
  const reloaded = loadConfig();
  assert.equal(({}).polluted, undefined, '重读后 Object.prototype 依旧干净');
});
