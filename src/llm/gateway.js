// LLM 网关：chat / story / vision 三套独立配置，互不干扰。
// 每个路由各自持有 baseUrl / apiKey / model，改一个不影响另外两个。
import { loadConfig } from '../config.js';
import { readJsonBounded, readTextBounded } from '../http-body.js';
import { wellFormedDeep } from '../text-safe.js';

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
 * 发一次对话请求（带 jsonMode 的空响应重试）。
 *
 * 上游偶发返回空 content（2026-10-29 11:48、13:03 各一次，都是 jsonMode 的回合）。
 * 空响应一律重试：第一次沿用 response_format: json_object，第二次去掉它
 * （个别上游对 json_object + 长提示词会返回空/截断，去掉反而正常）。
 * 仍然拿不到 JSON 才抛错，交给上层（Inbox 会把他的消息放回队列再试）。
 *
 * @param {'chat'|'story'|'vision'} role 路由
 * @param {Array<{role:string,content:any}>} messages OpenAI 格式消息
 * @param {{jsonMode?:boolean, images?:string[], temperature?:number, maxTokens?:number, signal?:AbortSignal, timeoutMs?:number, retries?:number}} opts
 * @returns {Promise<{content:string, json?:any, usage?:any}>}
 */
export async function callLLM(role, messages, opts = {}) {
  const wantsJson = Boolean(opts.jsonMode);
  const attempts = wantsJson ? Math.max(1, Number(opts.retries ?? 2)) : 1;
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    // 第二次起不再强制 JSON 格式，只靠宽容解析兜底
    const useJsonFormat = wantsJson && i === 0;
    let out;
    try {
      // 第 2 次起顺便把「思考模式」关掉：开着 thinking 时有些模型会把正文全写进
      // reasoning_content，content 只剩空白，JSON 永远拿不到（见 callOnce 里的说明）。
      out = await callOnce(role, messages, { ...opts, jsonMode: useJsonFormat, noThinking: i > 0 });
    } catch (error) {
      // 只有「内容不可用」值得重试；HTTP 失败、超时、未配置一律直接抛，别把等待翻倍
      const retriable = error instanceof LLMError && /不是合法 JSON/.test(error.message);
      if (!retriable || i + 1 >= attempts) throw error;
      console.warn(`[LLM] ${role} 第 ${i + 1}/${attempts} 次内容不可用（${error.message.slice(0, 60)}），重试`);
      continue;
    }
    if (!wantsJson) return out;
    const usable = out.json && typeof out.json === 'object' && Object.keys(out.json).length > 0;
    if (usable) {
      if (i > 0) console.warn(`[LLM] ${role} 第 ${i + 1} 次重试成功（前一次返回不可用）`);
      return out;
    }
    last = out;
    console.warn(`[LLM] ${role} 第 ${i + 1}/${attempts} 次返回${String(out.content ?? '').trim() ? '无法解析的 JSON' : '空内容'}，${i + 1 < attempts ? '重试' : '放弃'}`);
  }
  throw new LLMError(
    `路由 ${role} 连续 ${attempts} 次没有给出可用的 JSON（最后一次 content 长度 ${String(last?.content ?? '').length}）`,
    { role },
  );
}

/** 实际发一次 HTTP 请求 */
async function callOnce(role, messages, opts = {}) {
  const r = routeConfig(role);
  const url = endpoint(r.baseUrl);
  if (!url || !r.apiKey) {
    throw new LLMError(`路由 ${role} 未配置（缺 baseUrl 或 apiKey）`, { role });
  }

  // 视觉路由：把图片作为 image_url 内容块附加到最后一条用户消息
  //
  // content 先过一遍 wellFormedDeep（2026-10-30 事故）：prompt 里只要有半个 emoji
  // （被 slice 劈开留下的孤立代理），JSON.stringify 就会写出字面 "\ud83e"，
  // DeepSeek 侧解析请求体直接 400「unexpected end of hex escape」，而且那条消息
  // 一直留在上下文里，每回合重发同一个坏字符 —— 回复和自动推进会一起永久停摆。
  // 这里是最外层兜底：任何来源、任何拼装路径漏出来的坏字符，发送前一律洗掉。
  const finalMessages = messages.map((m) => ({ ...m, content: wellFormedDeep(m.content) }));
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

  // 思考模式（2026-10-30 22:31 事故）：api.deepseek.com 的 flash 模型开着 thinking 时，
  // 整段叙事会被写进 reasoning_content，content 只剩几十上百个空白字符，
  // finish_reason 却是 stop —— 解析器只能判定「空响应」，连续两轮就整条路由失败。
  // 处理：配置里显式写 thinking: "disabled" 就常态关闭；没写也在重试轮强制关一次兜底。
  // 只在 DeepSeek 系地址上加这个字段，别的厂商（siliconflow / 阿里云）认不认它另说，
  // 乱发字段会被判 400。
  const deepseekFamily = /deepseek/i.test(String(r.baseUrl ?? '')) || r.thinking != null;
  if (deepseekFamily) {
    const want = r.thinking ?? (opts.noThinking ? 'disabled' : null);
    if (want) body.thinking = { type: String(want) };
  }

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
    } else if (String(content).trim()) {
      // 非强制模式也试着解析：重试轮次就是靠这个判断"这次给的到底是不是 JSON"
      try { json = parseJsonLoose(content); } catch { json = undefined; }
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
