// 文本安全：不让「半个 emoji」漏进请求体或落进数据。
//
// 事故（2026-10-30 19:39 起，回复与自动推进全部停摆）：
// 他的消息「…我就不喜欢你20秒🥺」长度 25 个 code unit，时间轴按 24 截断，
// 正好切在 emoji 的高低位代理之间，留下孤立高代理 \ud83e。prompt 里带上它之后，
// JSON.stringify 会输出字面 "\ud83e"，DeepSeek 网关解析请求体时报
// `unexpected end of hex escape` → story 路由整条 HTTP 400。而且是永久性的：
// 那条消息始终在最近上下文窗口里，每请求一次就带一次坏字符，谁也发不出去。
//
// 两条纪律：
// ① 凡截断文本，用 cut() / tail()（按代理对边界切），别直接用 slice；
// ② 发送前统一 toWellFormed() 兜底：任何来源的孤立代理一律变 U+FFFD，
//    宁可显示一个问号，也不能把整条链路打死。

const REPLACEMENT = '\uFFFD';

function isHigh(c) { return c >= 0xd800 && c <= 0xdbff; }
function isLow(c) { return c >= 0xdc00 && c <= 0xdfff; }

/**
 * 把孤立代理替换成 U+FFFD（等价 String.prototype.toWellFormed，自带降级实现）。
 * @param {string} s
 * @returns {string}
 */
export function toWellFormed(s) {
  const str = String(s ?? '');
  if (typeof str.toWellFormed === 'function') return str.toWellFormed();
  let out = '';
  for (let i = 0; i < str.length; i += 1) {
    const c = str.charCodeAt(i);
    if (isHigh(c)) {
      const d = str.charCodeAt(i + 1);
      if (isLow(d)) { out += str[i] + str[i + 1]; i += 1; } else out += REPLACEMENT;
    } else if (isLow(c)) {
      out += REPLACEMENT;
    } else {
      out += str[i];
    }
  }
  return out;
}

/**
 * 从头截断，绝不在代理对中间下刀（上限按 code unit 算，少一个字符也不算错）。
 * @param {string} s
 * @param {number} max 最大 code unit 数
 * @param {string} [ellipsis] 截断后追加的省略号
 * @returns {string}
 */
export function cut(s, max, ellipsis = '') {
  const str = String(s ?? '');
  const n = Math.max(0, Math.floor(Number(max) || 0));
  if (str.length <= n) return str;
  let end = n;
  if (end > 0 && isHigh(str.charCodeAt(end - 1))) end -= 1; // 别把 emoji 劈成两半
  return str.slice(0, end) + ellipsis;
}

/**
 * 从尾部截断（比如「上一段停在这里」只取最后 140 字），起点也不能落在代理对里。
 * @param {string} s
 * @param {number} max
 * @returns {string}
 */
export function tail(s, max) {
  const str = String(s ?? '');
  const n = Math.max(0, Math.floor(Number(max) || 0));
  if (str.length <= n) return str;
  let start = str.length - n;
  if (isLow(str.charCodeAt(start))) start += 1; // 起点是低位代理 → 这个 emoji 只剩一半，丢掉
  return str.slice(start);
}

/**
 * 深层清洗任意 JSON 值里的字符串（请求体发送前兜底用）。
 * @param {any} v
 * @returns {any}
 */
export function wellFormedDeep(v) {
  if (typeof v === 'string') return toWellFormed(v);
  if (Array.isArray(v)) return v.map(wellFormedDeep);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = wellFormedDeep(val);
    return out;
  }
  return v;
}
