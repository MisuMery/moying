// LLM 网关：chat / story / vision 三套独立配置，互不干扰。
// 每个路由各自持有 baseUrl / apiKey / model，改一个不影响另外两个。
import { loadConfig } from '../config.js';
import { readJsonBounded, readTextBounded } from '../http-body.js';

export const ROLES = ['chat', 'story', 'vision'];

export class LLMError extends Error {
  constructor(message, { role, status, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'LLMError';
    this.role = role;
    this.status = status ?? null;
  }
}

function endpoint(baseUrl) {
  // 统一补 /chat/completions，兼容用户填根地址或完整地址
  const b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  if (/\/chat\/completions$/.test(b)) return b;
  if (/\/v\d+$/.test(b)) return `${b}/chat/completions`;
  if (/\/v\d+\/?$/.test(b)) return `${b.replace(/\/+$/, '')}/chat/completions`;
  return `${b}/v1/chat/completions`;
}

/** 取出某路由的完整参数（含用户可能在控制台改过的值） */
export function routeConfig(role) {
  const cfg = loadConfig();
  const r = cfg?.api?.[role];
  if (!r) throw new LLMError(`未知的模型路由: ${role}`, { role });
  return r;
}

export function isRouteReady(role) {
  try {
    const r = routeConfig(role);
    return Boolean(r.baseUrl && r.apiKey && r.model);
  } catch {
    return false;
  }
}

/**
 * 发一次对话请求。
 * @param {'chat'|'story'|'vision'} role 路由
 * @param {Array<{role:string,content:any}>} messages OpenAI 格式消息
 * @param {{jsonMode?:boolean, images?:string[], temperature?:number, maxTokens?:number, signal?:AbortSignal, timeoutMs?:number}} opts
 * @returns {Promise<{content:string, json?:any, usage?:any}>}
 */
export async function callLLM(role, messages, opts = {}) {
  const r = routeConfig(role);
  const url = endpoint(r.baseUrl);
  if (!url || !r.apiKey) {
    throw new LLMError(`路由 ${role} 未配置（缺 baseUrl 或 apiKey）`, { role });
  }

  // 视觉路由：把图片作为 image_url 内容块附加到最后一条用户消息
  const finalMessages = messages.map((m) => ({ ...m }));
  if (opts.images?.length && finalMessages.length) {
    const last = finalMessages[finalMessages.length - 1];
    if (last.role === 'user') {
      const textPart = typeof last.content === 'string' ? { type: 'text', text: last.content } : last.content;
      last.content = [
        ...(Array.isArray(textPart) ? textPart : [textPart]),
        ...opts.images.map((src) => ({ type: 'image_url', image_url: { url: src } })),
      ];
    }
  }

  const body = {
    model: r.model,
    messages: finalMessages,
    temperature: opts.temperature ?? r.temperature,
    max_tokens: opts.maxTokens ?? r.maxTokens,
    stream: false,
  };
  if (opts.jsonMode) body.response_format = { type: 'json_object' };

  const timeoutMs = opts.timeoutMs ?? r.timeoutMs ?? 60000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener?.('abort', onAbort);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${r.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      // 错误响应体同样有界读（64KB 足够看理由）：上游返回超大错误页时，
      // 无上限的 res.text() 能把常驻进程读爆（http-body.js 的纪律）
      const detail = await readTextBounded(res, 64 * 1024).catch(() => '');
      throw new LLMError(`路由 ${role} HTTP ${res.status}: ${String(detail).slice(0, 300)}`, { role, status: res.status });
    }
    // 有界读（8MB）：模型响应正常也就几十 KB，上游畸形/恶意超大响应不该有机会
    // 把进程读爆（2026-10-25 审查补漏：这里原来是裸的 res.json()）
    let data;
    try {
      data = await readJsonBounded(res, 8 * 1024 * 1024);
    } catch (cause) {
      throw new LLMError(
        cause?.code === 'BODY_TOO_LARGE' ? `路由 ${role} 响应过大（超过 8MB 上限）` : `路由 ${role} 返回了无法解析的响应`,
        { role, status: res.status, cause },
      );
    }
    const content = data?.choices?.[0]?.message?.content ?? '';
    let json;
    if (opts.jsonMode) {
      json = parseJsonLoose(content);
    }
    return { content, json, usage: data?.usage };
  } catch (error) {
    if (error instanceof LLMError) throw error;
    const aborted = error?.name === 'AbortError';
    throw new LLMError(`路由 ${role} ${aborted ? `超时(${timeoutMs}ms)` : '请求失败'}: ${error?.message ?? error}`, { role });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener?.('abort', onAbort);
  }
}

/** 模型常被 ```json 包裹或前后带废话，做一次宽容解析 */
export function parseJsonLoose(text) {
  const raw = String(text ?? '').trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    // 退而求其次：截取第一个 { 到最后一个 }
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch { /* fallthrough */ }
    }
    throw new LLMError(`模型返回不是合法 JSON: ${raw.slice(0, 200)}`);
  }
}

/** 控制台「测试连接」用：发一句最短的话，返回是否通 */
export async function testRoute(role) {
  if (!isRouteReady(role)) return { ok: false, error: `路由 ${role} 未配置完整` };
  const started = Date.now();
  try {
    const { content } = await callLLM(role, [{ role: 'user', content: '回复两个字：收到' }], { maxTokens: 16, timeoutMs: 20000 });
    return { ok: true, ms: Date.now() - started, sample: String(content).slice(0, 40) };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}
