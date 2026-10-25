// 备份：把 data/ 打包成一个可下载的文件。
//
// 迁服务器、换机器、或者改配置改崩了要回滚，都靠它。
// 打出来的是 tar.gz（GNU tar + gzip），任何系统都能解；Windows 用 7-Zip / WinRAR 也能解。
// 注意：备份里含 config.json（API key、OneBot token），下载后别随手传公网。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DATA_DIR } from './config.js';

export const BACKUP_DIR = path.join(DATA_DIR, 'backups');

export function ensureBackupDir() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  return BACKUP_DIR;
}

export function backupName(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `moying-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
    + `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}.tar.gz`;
}

/** 打一个包，返回 { file, path, size } */
export function createBackup(now = Date.now()) {
  ensureBackupDir();
  const file = backupName(now);
  const out = path.join(BACKUP_DIR, file);
  // -C 进 data 目录，只打包内容（不含 backups 自身，避免套娃）
  execFileSync('tar', ['-czf', out, '--exclude=./backups', '-C', DATA_DIR, '.'], { stdio: 'pipe' });
  const size = fs.statSync(out).size;
  return { file, path: out, size };
}

/** 列出已有备份（新的在前） */
export function listBackups() {
  try {
    ensureBackupDir();
    return fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith('.tar.gz'))
      .map((f) => {
        const st = fs.statSync(path.join(BACKUP_DIR, f));
        return { file: f, size: st.size, at: st.mtime.toISOString() };
      })
      .sort((a, b) => (a.at < b.at ? 1 : -1));
  } catch {
    return [];
  }
}

/** 取某个备份的绝对路径（做了防目录穿越校验） */
export function backupPath(file) {
  const name = path.basename(String(file ?? ''));
  if (!name.endsWith('.tar.gz')) return null;
  const full = path.join(BACKUP_DIR, name);
  // 必须是 BACKUP_DIR 的直接子文件：basename 已剥掉目录，这里再兜底
  // （startsWith 的前缀漏洞：backups-evil 这种兄弟目录也能以 backups 开头命中）
  if (full !== path.join(BACKUP_DIR, name) || !full.startsWith(BACKUP_DIR + path.sep)) return null;
  return fs.existsSync(full) && fs.statSync(full).isFile() ? full : null;
}

/** 存一个刚上传上来的包（名字加 upload- 前缀，避免和本地备份混淆） */
export function saveUploaded(buf, origName = '') {
  ensureBackupDir();
  const safe = path.basename(String(origName ?? '')).replace(/[^\w.\-]/g, '').slice(0, 80);
  const file = `upload-${Date.now()}-${safe || 'data.tar.gz'}`;
  const full = path.join(BACKUP_DIR, file);
  fs.writeFileSync(full, buf);
  return { file, path: full, size: fs.statSync(full).size };
}

/** 校验一个包能不能用来恢复：至少要有配置或事件数据 */
export function inspectArchive(full) {
  let listing;
  try {
    listing = execFileSync('tar', ['-tvzf', full], { stdio: 'pipe' }).toString('utf8');
  } catch {
    // 不是有效的 tar.gz：给干净理由，别让 execFileSync 的裸错误冒到 500
    return { ok: false, files: 0, contains: [], dangerous: [], error: '无法读取这个包（可能不是有效的 tar.gz）' };
  }
  const lines = listing.split('\n').map((x) => x.trim()).filter(Boolean);
  // zip-slip：包里若含 ../ 或绝对路径，解开会写到 data/ 外面去，直接拒
  const dangerous = lines.filter((n) => n.split('->')[0].trim().split(/\s+/).pop().startsWith('/')
    || n.split('->')[0].trim().split(/\s+/).pop().split('/').includes('..'));
  if (dangerous.length) {
    return { ok: false, files: lines.length, contains: [], dangerous: dangerous.slice(0, 5) };
  }
  // 链接类条目（软链接/硬链接/设备/FIFO）：解包时可能被"穿过去"写到 data/ 外面
  //（如包内先放 evil -> /etc，再放 evil/passwd）。data/ 里只该有普通文件和目录。
  const weirdTypes = lines.filter((n) => {
    const flag = n[0];
    return flag !== undefined && flag !== '-' && flag !== 'd';
  });
  if (weirdTypes.length) {
    return {
      ok: false, files: lines.length, contains: [], dangerous: [],
      error: `这个包含有非普通条目（软链接/硬链接/设备等，如「${weirdTypes[0].slice(0, 60)}」），拒绝恢复`,
    };
  }
  const names = lines.map((n) => n.split('->')[0].trim().split(/\s+/).pop());
  const has = (n) => names.some((x) => x === `./${n}` || x === n || x.endsWith(`/${n}`));
  const known = ['character.json', 'cast.json', 'user.json', 'world.json', 'relationship.json', 'events.jsonl', 'config.json'];
  const found = known.filter(has);
  return { ok: found.length > 0, files: lines.length, contains: found };
}

/**
 * 用备份覆盖当前 data/。
 * 顺序：① 先给现状打一个安全包（万一恢复错了还能回退）
 *       ② 再解开覆盖 ③ 返回新打的安全包名，方便提示用户
 */
export function restoreBackup(file) {
  const full = backupPath(file);
  if (!full) return { ok: false, error: '备份不存在' };
  const info = inspectArchive(full);
  if (!info.ok) {
    return info.dangerous?.length
      ? { ok: false, error: `这个包里有越界路径（${info.dangerous.join('、')}），拒绝恢复` }
      : { ok: false, error: info.error ?? '这个包里没有可识别的摹影数据' };
  }

  const safety = createBackup();
  execFileSync('tar', ['-xzf', full, '-C', DATA_DIR], { stdio: 'pipe' });
  return { ok: true, safety: safety.file, contains: info.contains, files: info.files };
}

export function removeBackup(file) {
  const full = backupPath(file);
  if (!full) return false;
  fs.unlinkSync(full);
  return true;
}
