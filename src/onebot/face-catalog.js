// QQ 系统表情目录：离线导出表（export-face-names.sh → data/face-names.json 的 bySid）
// 与协议端在线目录（fetch_sys_faces）合并后共用。
//
// 两处消费：① 来信渲染 [QQ表情N 名字]（onebot.js 的 segmentsToText）；
// ② send_face 的中文名 → 编号（tools-core.js 的 faceLookup）。
// 离线表是某次导出的快照，新表情只有线上有 —— 每个进程首次建联成功后拉一次在线目录补缺
// （只补离线表没有的编号：已有编号保持原名字，避免同一条来信的渲染口径随连接时机漂移）。
import fs from 'node:fs';
import path from 'node:path';

let bySid = null;      // { sid: name }
let nameIndex = null;  // Map(name -> sid)，同名时优先编号更小的经典表情（0~103 那批）
let onlineAttempted = false;

function dataDir() {
  return process.env.QQ_AGENT_DATA_DIR || path.join(process.cwd(), 'data');
}

function rebuildNameIndex() {
  const index = new Map();
  for (const [sid, name] of Object.entries(bySid || {})) {
    const key = String(name ?? '').trim();
    if (!key) continue;
    const prev = index.get(key);
    const num = Number(sid);
    if (prev === undefined || (Number.isFinite(num) && num < Number(prev))) index.set(key, sid);
  }
  nameIndex = index;
}

function ensureOffline() {
  if (bySid) return;
  bySid = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir(), 'face-names.json'), 'utf8'));
    if (parsed?.bySid && typeof parsed.bySid === 'object') bySid = { ...parsed.bySid };
  } catch { /* 没有离线表：等在线目录；两个都没有时只认编号 */ }
  rebuildNameIndex();
}

/** 编号 → 名字（来信渲染用）；查不到返回空串。sid 也可能是 Unicode 表情字符串。 */
export function faceNameOf(id) {
  ensureOffline();
  return bySid[String(id ?? '')] || '';
}

/** 名字 → 编号（send_face 用）；查不到返回 null。 */
export function faceIdByName(name) {
  ensureOffline();
  const key = String(name ?? '').trim();
  return nameIndex.has(key) ? nameIndex.get(key) : null;
}

/** 目录里全部名字（找不到时给"你是不是想发"的提示用）。 */
export function faceNameList() {
  ensureOffline();
  return [...(nameIndex?.keys() ?? [])];
}

/**
 * 拉一次协议端在线目录并补缺（q_sid → q_des）。每个进程只试一次，失败静默：
 * 离线表该有的都有，在线只是为了新表情。返回是否补到了新条目（供日志/测试）。
 */
export async function refreshFaceCatalog(client) {
  if (onlineAttempted) return false;
  onlineAttempted = true;
  try {
    const res = await client.call('fetch_sys_faces', {}, 20000);
    ensureOffline();
    let added = 0;
    for (const pack of (Array.isArray(res?.packs) ? res.packs : [])) {
      for (const emoji of (pack?.emojis ?? [])) {
        const sid = String(emoji?.q_sid ?? '').trim();
        const name = String(emoji?.q_des ?? '').trim().replace(/^\//, '');
        if (!sid || !name || bySid[sid]) continue;
        bySid[sid] = name;
        added += 1;
      }
    }
    if (added > 0) rebuildNameIndex();
    return added > 0;
  } catch {
    return false;
  }
}

/** 仅供测试：重置模块缓存（每个用例一份干净状态）。 */
export function resetFaceCatalogForTest() {
  bySid = null;
  nameIndex = null;
  onlineAttempted = false;
}
