// 识图：把用户发来的图片真正「看」一遍。
//
// 之前的问题：入站图片只渲染成 `[图片]` 占位符，vision 路由从来没被调用过，
// 模型只能拿着上下文瞎编（正在聊「种的萝卜」，就把一张递玫瑰的表情包说成稻草人）。
//
// 流程：OneBot 图片段拿 url → 下载成 base64 → vision 路由出「一行描述」→
// 描述跟着消息走进触发器与时间轴。看不清就如实说看不清，绝不替模型编。

import { callLLM, isRouteReady } from '../llm/gateway.js';
import { readBytesBounded } from '../http-body.js';

const MAX_IMAGES = 3;

/**
 * 识图提示词：先判定图片「类型」，再说清「是什么 + 表达什么含义」。
 * 旧版只让模型「客观描述画面」，还写死「这多半是表情包」、禁止谈意图——
 * 结果表情包和照片分不开，也读不出梗和情绪（2026-10-27 用户反馈）。
 */
export const VISION_PROMPT = [
  '你在帮一个聊天 AI 读懂对方发来的这张图片。先判断它是什么类型，再说清它是什么、表达了什么含义。',
  '',
  '严格按一行输出（不要换行、不要多余解释）：',
  '类型：<表情包/梗图 | 照片 | 截图 | 手绘/插画 | 文字图/文档 | 其他>；内容：<画面里是什么、谁在做什么、什么场景>；含义：<这张图本身传达的情绪或意思，如：撒娇、无语、嘲讽、开心、求安慰、炫耀、赞同、敷衍等；若是照片则写氛围与重点>；文字：<图上的字原样引出，没有就写 无>',
  '',
  '要求：',
  '- 「含义」说的是这张图本身表达什么，不是猜对方为什么发它。',
  '- 表情包/梗图必须点出它的「梗」和情绪，不能只写画了什么。',
  '- 看不清就如实写「看不清」，不要编。',
  '- 总共不超过 100 字。',
].join('\n');

/** SSRF 防线：图片地址是消息里带来的，不能拿它去摸内网与云元数据接口。
 *  导出供测试：初始 URL 与重定向后的最终 URL 都必须过这一关。 */
export function isPublicHttpUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const h = u.hostname;
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
  // IPv4 私网 / 环回 / 链路本地 / 云元数据
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0 || a >= 224) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false; // 169.254.169.254 = 云元数据
  }
  // IPv6 环回与本地
  if (/^(::1|\[::1\])$/.test(h) || /^f[cd]/i.test(h)) return false;
  return true;
}
const DOWNLOAD_TIMEOUT_MS = 20000;
const MAX_BYTES = 20 * 1024 * 1024;

/** 从图片条目里找可用的下载地址（兼容 OneBot 段与引擎展平后的 {url,file}） */
function pickUrl(img) {
  const d = img?.data ?? img ?? {};
  for (const k of ['url', 'file']) {
    const v = String(d[k] ?? '').trim();
    if (/^https?:\/\//i.test(v)) return v;
  }
  return '';
}

/** 下载图片转 base64（QQ 图床的链接一般直接 GET 就行；失败返回 null，不抛） */
async function downloadAsDataUrl(url, { allowPrivateUrls = false } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: {
        // QQ 图床对 UA 不敏感，但带上更像浏览器，减少被拒的概率
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
        referer: 'https://qq.com/',
      },
    });
    if (!res.ok) return null;
    // fetch 默认自动跟随重定向：初始 URL 过了 SSRF 检查，也可能被 302 带到内网。
    // res.url 是重定向后的最终地址，必须复检（2026-10-25 审查补漏）。
    if (!allowPrivateUrls && !isPublicHttpUrl(res.url)) return null;
    const type = String(res.headers.get('content-type') ?? 'image/jpeg').split(';')[0];
    if (!type.startsWith('image/')) return null;
    // 有界读：边读边计数，超限立刻取消——先把整个 body 读进来再判长度，
    // 上限就形同虚设（http-body.js 的纪律；这里原来是裸 arrayBuffer()）
    const buf = await readBytesBounded(res, MAX_BYTES);
    if (buf.length === 0) return null;
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 段里没有 url 时，退回协议端的 get_image API */
async function urlViaApi(client, file) {
  if (!client?.call || !file) return null;
  try {
    const r = await client.call('get_image', { file }, 15000);
    const u = String(r?.url ?? r?.data?.url ?? '');
    return /^https?:\/\//i.test(u) ? u : null;
  } catch {
    return null;
  }
}

/** 视觉调用带重试：429（限流）/5xx/网络错误是常见瞬时故障，
 *  不重试的话这条消息就彻底"识图失败"了（2026-10-27 线上遇到 GLM 429）。 */
async function callVisionWithRetry(llm, messages, opts, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i += 1) {
    try {
      return await llm('vision', messages, opts);
    } catch (e) {
      lastErr = e;
      const st = Number(e?.status);
      const retryable = st === 429 || (st >= 500 && st < 600) || !Number.isFinite(st);
      if (!retryable || i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

/**
 * 把一组图片段变成「一行描述」。
 * @param {Array<{url?:string,file?:string}>} images
 * @param {{client?:object}} opts
 * @returns {Promise<Array<{ok:boolean, note:string}>>} 与入参一一对应
 */
export async function describeImages(images = [], { client = null, llm = callLLM, allowPrivateUrls = false } = {}) {
  const results = [];
  if (!images.length) return results;
  // 没配 vision 路由就不硬来：如实标注「没看」，别让模型自由发挥
  if (!isRouteReady('vision')) {
    return images.map(() => ({ ok: false, note: '（视觉模型未配置，这张图我还没看）' }));
  }
  const capped = images.slice(0, MAX_IMAGES);
  for (const img of capped) {
    let url = pickUrl(img);
    if (!url && img.file) url = await urlViaApi(client, img.file);
    if (url && !allowPrivateUrls && !isPublicHttpUrl(url)) {
      results.push({ ok: false, note: '（这张图不允许访问）' });
      continue;
    }
    const dataUrl = url ? await downloadAsDataUrl(url, { allowPrivateUrls }) : null;
    if (!dataUrl) {
      results.push({ ok: false, note: '（图片没能下载下来，我看不清这张）' });
      continue;
    }
    try {
      const { content } = await callVisionWithRetry(llm, [
        { role: 'user', content: VISION_PROMPT },
        { role: 'user', content: '这张图：' },
      ], { images: [dataUrl], maxTokens: 220, temperature: 0.2, timeoutMs: 45000 });
      const note = String(content ?? '').trim().replace(/\s+/g, ' ');
      results.push({ ok: Boolean(note), note: note || '（视觉模型没给出描述）', dataUrl });
    } catch (error) {
      results.push({ ok: false, note: `（识图失败：${String(error?.message ?? error).slice(0, 80)}）` });
    }
  }
  // 超出上限的图只记数量
  for (let i = capped.length; i < images.length; i += 1) {
    results.push({ ok: false, note: `（还有 ${images.length - capped.length} 张图没看）` });
  }
  return results;
}
