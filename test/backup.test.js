// 备份与恢复：打包 → 校验 → 覆盖 → 热重载，整条链路。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moying-backup-'));
process.env.MOYING_DATA_DIR = tmp;
// 先放点「现有数据」，模拟一个已经跑起来的实例
fs.writeFileSync(path.join(tmp, 'character.json'), JSON.stringify({ identity: { name: '旧角色' } }));
fs.writeFileSync(path.join(tmp, 'events.jsonl'), JSON.stringify({ at: '2026-10-25T10:00:00+08:00', kind: 'act' }) + '\n');

const { createBackup, listBackups, backupPath, removeBackup, saveUploaded, inspectArchive, restoreBackup } =
  await import('../src/backup.js');

test('备份: 打包后能列出、能取到路径', () => {
  const made = createBackup();
  assert.ok(made.file.endsWith('.tar.gz'));
  assert.ok(made.size > 0);
  assert.ok(fs.existsSync(backupPath(made.file)), '应能取到绝对路径');
  assert.ok(listBackups().some((b) => b.file === made.file));
  removeBackup(made.file);
});

test('备份: 路径做了防穿越校验', () => {
  assert.equal(backupPath('../../etc/passwd'), null);
  assert.equal(backupPath('evil.txt'), null, '非备份文件不接受');
  assert.equal(backupPath('不存在的.tar.gz'), null);
});

test('恢复: 上传的包能被识别，并覆盖当前数据', () => {
  // 造一个「新数据」的包，模拟从另一台机器下载的备份
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'moying-src-'));
  fs.writeFileSync(path.join(src, 'character.json'), JSON.stringify({ identity: { name: '新角色' } }));
  fs.writeFileSync(path.join(src, 'events.jsonl'), '');
  // 用系统 tar 打出来，再当上传文件塞进去
  const tarball = path.join(src, 'pack.tar.gz');
  // eslint-disable-next-line no-undef
  execFileSync('tar', ['-czf', tarball, '-C', src, 'character.json', 'events.jsonl']);
  const buf = fs.readFileSync(tarball);

  const saved = saveUploaded(buf, 'pack.tar.gz');
  assert.ok(saved.file.startsWith('upload-'), '上传的包要有 upload- 前缀，避免和本地备份混淆');

  const info = inspectArchive(saved.path);
  assert.equal(info.ok, true, '应能被识别为摹影数据');
  assert.ok(info.contains.includes('character.json'));

  const r = restoreBackup(saved.file);
  assert.equal(r.ok, true);
  assert.ok(r.safety, '恢复前必须先打安全包');
  // 数据确实被换掉了
  const now = JSON.parse(fs.readFileSync(path.join(tmp, 'character.json'), 'utf8'));
  assert.equal(now.identity.name, '新角色');
  // 安全包还在，能退回去
  assert.ok(fs.existsSync(backupPath(r.safety)));
});

test('恢复: 不是摹影的包会被拒绝，不会动数据', () => {
  const junk = path.join(tmp, 'junk.tar.gz');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'moying-junk-'));
  fs.writeFileSync(path.join(d, 'readme.txt'), 'hello');
  // eslint-disable-next-line no-undef
  execFileSync('tar', ['-czf', junk, '-C', d, 'readme.txt']);
  const saved = saveUploaded(fs.readFileSync(junk), 'junk.tar.gz');
  const r = restoreBackup(saved.file);
  assert.equal(r.ok, false);
  assert.match(r.error, /没有可识别/);
  // 数据没被动过
  const now = JSON.parse(fs.readFileSync(path.join(tmp, 'character.json'), 'utf8'));
  assert.equal(now.identity.name, '新角色');
});

test('恢复: 含越界路径的包会被拒绝（zip-slip）', () => {
  const evil = path.join(tmp, 'evil.tar.gz');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'moying-evil-'));
  fs.writeFileSync(path.join(d, 'character.json'), '{}');
  // 手工塞一条 ../ 的路径进去
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'moying-stage-'));
  fs.writeFileSync(path.join(staging, 'character.json'), '{}');
  fs.mkdirSync(path.join(staging, 'up'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'up', 'pwned.txt'), 'x');
  execFileSync('tar', ['-czf', evil, '-C', staging, 'character.json', 'up']);
  // 把 up 改名成 .. 的等价物：直接构造一个带 ../ 的包
  const evil2 = path.join(tmp, 'evil2.tar.gz');
  fs.mkdirSync(path.join(staging, 'x'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'x', 'y.txt'), 'x');
  execFileSync('tar', ['-czf', evil2, '-C', staging, '--transform=s|x|../../escape|', 'x/y.txt']).valueOf?.();
  const saved = saveUploaded(fs.readFileSync(evil2), 'evil2.tar.gz');
  const r = restoreBackup(saved.file);
  assert.equal(r.ok, false, '越界路径必须拒绝');
  assert.match(r.error ?? '', /越界|没有可识别/);
});
