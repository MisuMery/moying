// 控制台后端：状态只读查询 + 配置/角色卡可写 + 连接测试 + 手动干预。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig, invalidateConfig, ROOT } from '../config.js';
import {
  loadPersona, savePersona, invalidatePersona,
  loadCharacter, saveCharacter, loadCast, saveCast, loadUser, saveUser,
} from '../persona/card.js';
import { stageList, applyStage, currentStageId } from '../persona/stages.js';
import { evolveStageContent } from '../persona/evolve.js';
import { createBackup, listBackups, backupPath, removeBackup, saveUploaded, restoreBackup } from '../backup.js';
import { loadRelationship, saveRelationship, loadTemplate } from '../persona/relationship.js';
import { testRoute, isRouteReady, callLLM } from '../llm/gateway.js';
import { StickerStore } from '../features/stickers.js';
import { buildCharacterImportPrompt, validateCharacterDraft } from '../persona/import.js';
import { loadWorld, saveWorld, resolveWorld } from '../world/world.js';
import { selectRange, renderStoryMarkdown, renderStoryJson } from '../export/story.js';
import { renderWorldBlock, nameResolver } from '../world/view.js';
import { fmtDate, fmtClock } from '../world/time.js';
import { PLACE_LABEL } from '../world/state.js';

const WEB_DIR = path.join(ROOT, 'web');

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

function maskKey(v) {
  const s = String(v ?? '');
  if (!s) return '';
  return s.length <= 8 ? '****' : `${s.slice(0, 4)}****${s.slice(-4)}`;
}

/** 读原始二进制（上传备份用），带大小上限 */
function readRaw(req, maxBytes = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('文件过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const ct = String(req.headers['content-type'] ?? '');
      if (ct.includes('application/x-www-form-urlencoded')) {
        // 登录表单：既给解析后的字段，也留原文备用
        resolve({ raw: text, ...Object.fromEntries(new URLSearchParams(text)) });
        return;
      }
      try {
        resolve(text.trim() ? JSON.parse(text) : {});
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(WEB_DIR, rel);
  // 必须是 WEB_DIR 之内的文件：单纯 startsWith(WEB_DIR) 有前缀漏洞
  // （兄弟目录 web-evil/x 也以 web 开头），必须带上路径分隔符
  if (file !== WEB_DIR && !file.startsWith(WEB_DIR + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(file);
    const type = ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.js' ? 'text/javascript; charset=utf-8'
        : ext === '.css' ? 'text/css; charset=utf-8'
          : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'content-length': data.length });
    res.end(data);
  });
}

/** 从 cookie 里取令牌 */
function cookieToken(req) {
  const raw = String(req.headers.cookie ?? '');
  const hit = raw.split(';').map((s) => s.trim()).find((s) => s.startsWith('moying_token='));
  return hit ? decodeURIComponent(hit.slice('moying_token='.length)) : '';
}

function configuredToken() {
  return String(loadConfig()?.console?.token ?? '');
}

/** 请求是否来自本机 */
function isLoopback(req) {
  const ip = String(req.socket?.remoteAddress ?? '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.startsWith('::ffff:127.');
}

/**
 * 没配令牌时**只允许本机**访问；一旦服务绑到 0.0.0.0（部署脚本的默认），
 * 远程请求没有令牌一律拒绝——否则「忘了设令牌」就等于把控制台敞开在公网。
 */
function isAuthorized(req) {
  const want = configuredToken();
  if (!want) return isLoopback(req);
  const got = cookieToken(req);
  if (got && got === want) return true;
  const auth = String(req.headers.authorization ?? '');
  return auth === `Bearer ${want}`;
}

// 登录防爆破：同一 IP 连续失败 LOGIN_MAX_FAILS 次，锁定 LOGIN_LOCK_MS。
// 纯内存计数（重启即忘）——控制台是单人管理面，不需要持久化。
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const loginAttempts = new Map(); // ip → { fails, lockedUntil }

function loginLockLeft(ip) {
  const rec = loginAttempts.get(ip);
  return rec?.lockedUntil > Date.now() ? rec.lockedUntil - Date.now() : 0;
}

function recordLoginFail(ip) {
  const rec = loginAttempts.get(ip) ?? { fails: 0, lockedUntil: 0 };
  rec.fails += 1;
  if (rec.fails >= LOGIN_MAX_FAILS) {
    rec.lockedUntil = Date.now() + LOGIN_LOCK_MS;
    rec.fails = 0;
  }
  loginAttempts.set(ip, rec);
  if (loginAttempts.size > 1000) loginAttempts.clear(); // 防内存膨胀：满了整体重置
}

function clearLoginFail(ip) { loginAttempts.delete(ip); }

const LOGIN_PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>控制台登录</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1115;color:#e6e9ef;font:14px system-ui,"PingFang SC",sans-serif}
.box{background:#171a21;border:1px solid #252a34;border-radius:10px;padding:24px 28px;width:320px}
h1{margin:0 0 14px;font-size:16px;color:#7cc4ff}input{width:100%;background:#0d1016;border:1px solid #252a34;color:#e6e9ef;border-radius:6px;padding:8px 10px;font:inherit;margin-bottom:12px}
button{width:100%;background:#7cc4ff;color:#08121c;border:0;padding:8px;border-radius:6px;font-weight:600;cursor:pointer}
.err{color:#f2777a;font-size:12px;min-height:16px}</style></head><body>
<form class="box" method="post" action="/api/login"><h1>摹影 · 控制台</h1>
<input name="token" type="password" placeholder="访问令牌" autofocus>
<button type="submit">进入</button><div class="err">$ERR$</div></form></body></html>`;

export function startConsole({ port, engine, client, store, registry, impressions }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const p = url.pathname;

    try {
      // 健康检查不设防：部署脚本与容器编排靠它判断服务起来了没
      if (p === '/api/ping') {
        json(res, 200, { ok: true, service: 'moying', connected: Boolean(client?.connected) });
        return;
      }
      // 登录入口本身不设防（但受防爆破 throttle 保护）
      if (p === '/api/login' && req.method === 'POST') {
        const ip = String(req.socket?.remoteAddress ?? '');
        const lockLeft = loginLockLeft(ip);
        if (lockLeft > 0) {
          res.writeHead(429, { 'content-type': 'text/html; charset=utf-8' });
          res.end(LOGIN_PAGE.replace('$ERR$', `失败次数过多，请 ${Math.ceil(lockLeft / 60000)} 分钟后再试`));
          return;
        }
        const body = await readBody(req).catch(() => ({}));
        const form = new URLSearchParams(String(body?.raw ?? ''));
        const token = String(body?.token ?? form.get('token') ?? '');
        if (configuredToken() && token === configuredToken()) {
          clearLoginFail(ip);
          res.writeHead(302, {
            'set-cookie': `moying_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
            location: '/',
          });
          res.end();
        } else {
          recordLoginFail(ip);
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
          res.end(LOGIN_PAGE.replace('$ERR$', '令牌不对'));
        }
        return;
      }

      if (!isAuthorized(req)) {
        if (p.startsWith('/api/')) return json(res, 401, { error: 'unauthorized' });
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
        res.end(LOGIN_PAGE.replace('$ERR$', ''));
        return;
      }

      // 表情图片（控制台缩略图用）
      if (p.startsWith('/api/sticker-file/') && req.method === 'GET') {
        const file = decodeURIComponent(p.slice('/api/sticker-file/'.length));
        const entry = new StickerStore().all().find((s) => s.file === file);
        const abs = entry ? new StickerStore().absolutePath(entry) : null;
        if (!abs) { res.writeHead(404); res.end('not found'); return; }
        const data = fs.readFileSync(abs);
        const ext = path.extname(abs).toLowerCase();
        const type = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.gif' ? 'image/gif' : 'image/png';
        res.writeHead(200, { 'content-type': type, 'content-length': data.length, 'cache-control': 'max-age=86400' });
        res.end(data);
        return;
      }

      // 静态页面
      if (req.method === 'GET' && !p.startsWith('/api/')) {
        serveStatic(req, res, p);
        return;
      }

      // ---- 状态 ----
      if (p === '/api/state' && req.method === 'GET') {
        const now = Date.now();
        const timeline = engine.timeline;
        const events = store.loadEvents();
        json(res, 200, {
          now: new Date(now).toISOString(),
          date: fmtDate(now),
          clock: fmtClock(now),
          place: timeline.currentPlace(now),
          placeLabel: PLACE_LABEL[timeline.currentPlace(now)] ?? '',
          companions: timeline.companionsAt(now),
          worldBlock: renderWorldBlock(timeline, now, { resolveName: nameResolver(registry) }),
          eventCount: events.length,
          recentEvents: events.slice(-20).reverse().map((e) => ({
            id: e.id, at: e.at, kind: e.kind, place: e.place ?? e.to ?? '', summary: e.summary ?? '', source: e.source,
          })),
          connected: Boolean(client?.connected),
          selfId: client?.selfId ?? loadConfig().selfId ?? '',
          todayEvents: timeline.eventsOnDate(fmtDate(now)).length,
          // 回复门控状态
          queue: engine?.inbox?.pending?.() ?? [],
          rate: engine?.rate?.snapshot?.() ?? null,
          busy: engine?.isBusy?.(now) ?? false,
          willingness: [...(engine?.willingness ?? [])].map(([userId, s]) => ({
            userId,
            score: Number((s?.score ?? 0).toFixed(2)),
            updatedAt: s?.updatedAt ? new Date(s.updatedAt).toISOString() : null,
          })),
        });
        return;
      }

      if (p === '/api/ledger' && req.method === 'GET') {
        const all = store.loadLedger();
        json(res, 200, { total: all.length, recent: all.slice(-50).reverse() });
        return;
      }

      if (p === '/api/turns' && req.method === 'GET') {
        const all = store.turns.load();
        json(res, 200, { total: all.length, recent: all.slice(-20).reverse() });
        return;
      }

      if (p === '/api/impressions' && req.method === 'GET') {
        json(res, 200, impressions.toJSON());
        return;
      }

      // ---- 配置 ----
      if (p === '/api/config' && req.method === 'GET') {
        const cfg = loadConfig();
        const safe = JSON.parse(JSON.stringify(cfg));
        for (const k of Object.keys(safe.api ?? {})) {
          // 配置可能被手改坏（某路由写成了字符串）：掩码只对对象生效，别让一个坏字段
          // 把整个 /api/config 打成 500（控制台首页全靠它）
          if (safe.api[k] && typeof safe.api[k] === 'object' && !Array.isArray(safe.api[k])) {
            safe.api[k].apiKey = maskKey(safe.api[k].apiKey);
          }
        }
        json(res, 200, { config: safe, ready: Object.fromEntries(['chat', 'story', 'vision'].map((r) => [r, isRouteReady(r)])) });
        return;
      }

      if (p === '/api/config' && req.method === 'POST') {
        const body = await readBody(req);
        const patch = body?.config ?? body ?? {};
        // 前端回传掩码时不覆盖真实 key
        for (const role of Object.keys(patch?.api ?? {})) {
          if (String(patch.api[role]?.apiKey ?? '').includes('****')) delete patch.api[role].apiKey;
        }
        const next = saveConfig(patch);
        invalidateConfig();
        json(res, 200, { ok: true, config: next });
        return;
      }

      if (p === '/api/test' && req.method === 'POST') {
        const body = await readBody(req);
        const role = String(body?.role ?? 'story');
        const result = await testRoute(role);
        json(res, 200, result);
        return;
      }

      // ---- 角色卡 ----
      if (p === '/api/persona' && req.method === 'GET') {
        json(res, 200, { persona: loadPersona() });
        return;
      }

      if (p === '/api/persona' && req.method === 'POST') {
        const body = await readBody(req);
        const next = savePersona(body?.persona ?? body ?? {});
        invalidatePersona();
        json(res, 200, { ok: true, persona: next });
        return;
      }

      // ---- 手动干预 ----
      if (p === '/api/advance' && req.method === 'POST') {
        const result = await engine.runAutoAdvance({ now: Date.now() });
        json(res, 200, {
          ok: true,
          events: result.committed?.length ?? 0,
          sent: result.delivery?.sent?.length ?? 0,
          blocked: result.delivery?.blocked?.length ?? 0,
          violations: result.violations ?? [],
          autoCorrected: result.autoCorrected ?? [],
        });
        return;
      }

      if (p === '/api/cast' && req.method === 'GET') {
        json(res, 200, { actors: registry.toJSON(), cast: loadCast() });
        return;
      }

      // ---- 角色本体（开源友好：可整体替换） ----
      if (p === '/api/character' && req.method === 'GET') {
        json(res, 200, { character: loadCharacter() });
        return;
      }
      if (p === '/api/character' && req.method === 'POST') {
        const body = await readBody(req);
        const next = saveCharacter(body?.character ?? body ?? {});
        invalidatePersona();
        json(res, 200, { ok: true, character: next });
        return;
      }

      // ---- 配角卡 ----
      if (p === '/api/cast' && req.method === 'POST') {
        const body = await readBody(req);
        const next = saveCast(body?.cast ?? body ?? []);
        invalidatePersona();
        json(res, 200, { ok: true, cast: next });
        return;
      }

      // ---- 用户是谁 + 初始关系 ----
      if (p === '/api/user' && req.method === 'GET') {
        json(res, 200, { user: loadUser() });
        return;
      }
      if (p === '/api/user' && req.method === 'POST') {
        const body = await readBody(req);
        const next = saveUser(body?.user ?? body ?? {});
        json(res, 200, { ok: true, user: next });
        return;
      }

      // ---- 关系（锚点 / 来历 / 各阶段能说什么） ----
      if (p === '/api/relationship' && req.method === 'GET') {
        json(res, 200, { relationship: loadRelationship() });
        return;
      }
      if (p === '/api/relationship' && req.method === 'POST') {
        const body = await readBody(req);
        const next = saveRelationship(body?.relationship ?? body ?? {});
        json(res, 200, { ok: true, relationship: next });
        return;
      }

      // ---- 关系演化：让世界 AI 按剧情改写某个阶段的相处方式 ----
      if (p === '/api/relationship/evolve' && req.method === 'POST') {
        const body = await readBody(req);
        const facts = String(body?.recentFacts ?? '') || (engine?.recentFacts ? engine.recentFacts() : '');
        const r = await evolveStageContent({
          stageId: body?.stage ?? null,
          persona: engine?.persona ?? null,
          recentFacts: facts,
          force: true, // 控制台点按钮 = 显式要求重写
        });
        json(res, 200, { ok: Boolean(r?.ok), ...r });
        return;
      }

      // ---- 通用模板：重置成「只填初始相处方式，其余交给 AI 演化」的空模板 ----
      if (p === '/api/relationship/template' && req.method === 'GET') {
        json(res, 200, { template: loadTemplate() });
        return;
      }
      if (p === '/api/relationship/reset' && req.method === 'POST') {
        const body = await readBody(req);
        const tpl = loadTemplate();
        const next = {
          ...tpl,
          ...(body?.keep ? {
            kind: loadRelationship().kind ?? '',
            anchor: loadRelationship().anchor ?? '',
            history: loadRelationship().history ?? '',
            initialMode: loadRelationship().initialMode ?? tpl.initialMode,
          } : {}),
        };
        delete next._note;
        saveRelationship(next);
        json(res, 200, { ok: true, relationship: next });
        return;
      }

      // ---- 备份：打包 data/ 供下载（迁服务器 / 回滚用） ----
      if (p === '/api/backups' && req.method === 'GET') {
        json(res, 200, { backups: listBackups() });
        return;
      }
      if (p === '/api/backup' && req.method === 'POST') {
        const made = createBackup();
        json(res, 200, { ok: true, ...made, backups: listBackups() });
        return;
      }
      if (p === '/api/backup/download' && req.method === 'GET') {
        const full = backupPath(url.searchParams.get('file'));
        if (!full) return json(res, 404, { error: '备份不存在' });
        const name = path.basename(full);
        res.writeHead(200, {
          'content-type': 'application/gzip',
          'content-disposition': `attachment; filename="${name}"`,
          'content-length': fs.statSync(full).size,
        });
        fs.createReadStream(full).pipe(res);
        return;
      }
      if (p === '/api/backup/remove' && req.method === 'POST') {
        const body = await readBody(req);
        json(res, 200, { ok: removeBackup(body?.file), backups: listBackups() });
        return;
      }
      // 上传一个备份包（二进制直传，前端把 File 当 body 发过来）
      if (p === '/api/backup/upload' && req.method === 'POST') {
        const buf = await readRaw(req, 256 * 1024 * 1024);
        if (!buf?.length) return json(res, 400, { error: '空文件' });
        const saved = saveUploaded(buf, url.searchParams.get('name') ?? '');
        json(res, 200, { ok: true, ...saved, backups: listBackups() });
        return;
      }
      // 恢复：先给现状打安全包，再覆盖，最后热重载
      if (p === '/api/backup/restore' && req.method === 'POST') {
        const body = await readBody(req);
        const r = restoreBackup(body?.file);
        if (!r?.ok) return json(res, 400, { error: r?.error ?? '恢复失败' });
        const reloaded = engine?.reloadData?.() ?? null;
        json(res, 200, { ok: true, ...r, reloaded, backups: listBackups() });
        return;
      }

      // ---- 感情阶段：列表 / 一键切换 ----
      if (p === '/api/stages' && req.method === 'GET') {
        const user = loadUser();
        const primary = user?.userId ?? registry.byKind('real_user')[0]?.userId ?? '';
        const imp = primary ? impressions.get(primary) : {};
        json(res, 200, {
          stages: stageList(),
          current: primary ? currentStageId(imp) : null,
          explicit: imp?.stage ?? null,
          initial: user?.initialRelationship?.stage ?? null,
          userId: primary,
          facets: imp?.facets ?? null,
        });
        return;
      }
      if (p === '/api/stage' && req.method === 'POST') {
        const body = await readBody(req);
        const userId = String(body?.userId ?? loadUser()?.userId ?? registry.byKind('real_user')[0]?.userId ?? '');
        if (!userId) return json(res, 400, { ok: false, error: '没有可设置的用户' });
        const next = applyStage(impressions, userId, String(body?.stage ?? ''));
        json(res, 200, { ok: true, userId, stage: next.stage, facets: next.facets });
        return;
      }

      // ---- 角色卡 AI 导入：必须先配好 story 路由 ----
      if (p === '/api/character/import' && req.method === 'POST') {
        if (!isRouteReady('story')) {
          return json(res, 400, { ok: false, error: '请先在「API 配置」里配好 story（世界故事）路由并测试通过' });
        }
        const body = await readBody(req);
        const raw = String(body?.text ?? '').trim();
        if (!raw) return json(res, 400, { ok: false, error: '原始角色卡文本为空' });
        const messages = buildCharacterImportPrompt(raw);
        const { json: draft } = await callLLM('story', messages, { jsonMode: true, timeoutMs: 120000 });
        const errors = validateCharacterDraft(draft);
        if (errors.length) return json(res, 200, { ok: false, errors, draft });
        if (body?.apply) {
          const next = saveCharacter(draft);
          invalidatePersona();
          return json(res, 200, { ok: true, applied: true, character: next });
        }
        return json(res, 200, { ok: true, preview: true, draft });
      }

      // ---- 表情包 ----
      if (p === '/api/stickers' && req.method === 'GET') {
        const store = new StickerStore();
        json(res, 200, { stickers: store.all(), visionReady: isRouteReady('vision') });
        return;
      }
      if (p === '/api/stickers' && req.method === 'POST') {
        const body = await readBody(req);
        const store = new StickerStore();
        const entry = store.add({
          dataBase64: body?.dataBase64,
          mime: body?.mime,
          file: body?.file,
          desc: body?.desc ?? '',
          tags: body?.tags ?? [],
          source: body?.source ?? 'console',
        });
        json(res, 200, { ok: true, sticker: entry });
        return;
      }
      if (p === '/api/stickers/annotate' && req.method === 'POST') {
        const body = await readBody(req);
        const store = new StickerStore();
        const entry = store.get(String(body?.id ?? ''));
        if (!entry) return json(res, 404, { ok: false, error: '找不到这个表情' });
        if (!isRouteReady('vision')) return json(res, 400, { ok: false, error: '请先在「API 配置」里配好 vision（识图）路由' });
        const abs = store.absolutePath(entry);
        if (!abs) return json(res, 400, { ok: false, error: '图片文件不存在' });
        const b64 = fs.readFileSync(abs).toString('base64');
        const mime = abs.endsWith('.jpg') || abs.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
        const { json: out } = await callLLM('vision', [{
          role: 'user',
          content: '看这张表情包，用中文输出 JSON：{"desc":"画的是什么、适合在什么场合发（一句话，不超过40字）","tags":["情绪或场景标签，3-6个"]}',
        }], { jsonMode: true, images: [`data:${mime};base64,${b64}`] });
        const updated = store.annotate(entry.id, {
          desc: out?.desc ?? '',
          tags: Array.isArray(out?.tags) ? out.tags : [],
        });
        json(res, 200, { ok: true, sticker: updated });
        return;
      }
      if (p === '/api/stickers/remove' && req.method === 'POST') {
        const body = await readBody(req);
        const store = new StickerStore();
        const ok = store.remove(String(body?.id ?? ''));
        json(res, 200, { ok });
        return;
      }

      // ---- 世界设定 ----
      if (p === '/api/world' && req.method === 'GET') {
        const world = loadWorld();
        json(res, 200, { world, resolved: resolveWorld(world, Date.now()) });
        return;
      }
      if (p === '/api/world' && req.method === 'POST') {
        const body = await readBody(req);
        const next = saveWorld(body?.world ?? body ?? {});
        json(res, 200, { ok: true, world: next });
        return;
      }

      // ---- 世界事件播种 ----
      if (p === '/api/seeded' && req.method === 'GET') {
        const all = engine?.seeder?.all?.() ?? [];
        json(res, 200, { events: all.slice(-30).reverse(), total: all.length });
        return;
      }
      if (p === '/api/seed' && req.method === 'POST') {
        if (!engine?.seeder) return json(res, 400, { ok: false, error: '播种器未就绪' });
        const r = await engine.seeder.sweep({});
        const injected = engine.seeder.drainDue({});
        json(res, 200, { ok: true, ...r, injected: injected.map((s) => s.summary) });
        return;
      }

      // ---- 演化游标 ----
      if (p === '/api/cursor' && req.method === 'GET') {
        const at = engine?.cursor?.get?.() ?? null;
        json(res, 200, {
          at: at ? new Date(at).toISOString() : null,
          window: engine?.cursor?.renderWindow?.(Date.now()) ?? '',
        });
        return;
      }
      if (p === '/api/cursor' && req.method === 'POST') {
        const body = await readBody(req);
        const at = body?.at ? Date.parse(body.at) : Date.now();
        engine?.cursor?.reset?.(Number.isFinite(at) ? at : Date.now());
        json(res, 200, { ok: true, at: engine?.cursor?.get?.() ?? null });
        return;
      }

      // ---- 故事导出 ----
      if (p === '/api/export' && req.method === 'GET') {
        const fmt = String(url.searchParams.get('format') ?? 'markdown');
        const from = url.searchParams.get('from') || null;
        const to = url.searchParams.get('to') || null;
        const events = selectRange(store.loadEvents(), { from, to });
        if (fmt === 'json') {
          json(res, 200, renderStoryJson(events, { from, to }));
          return;
        }
        const md = renderStoryMarkdown(events, { from, to, title: '故事导出' });
        const buf = Buffer.from(md, 'utf8');
        const name = `story-${(from ?? 'all').slice(0, 10)}-${(to ?? 'now').slice(0, 10)}.md`;
        res.writeHead(200, {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': `attachment; filename="${name}"`,
          'content-length': buf.length,
        });
        res.end(buf);
        return;
      }

      json(res, 404, { error: 'not found' });
    } catch (error) {
      json(res, 500, { error: String(error?.message ?? error) });
    }
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[控制台] 监听 ${port}`);
  });
  return server;
}
