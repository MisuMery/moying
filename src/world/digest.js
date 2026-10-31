// 每日记忆：她记得今天做过什么、昨天聊过什么。
//
// 为什么需要它（2026-10-28 架构审计）：
//   模型此前只看得到「最近 8 条事件」和「60 分钟内的对话」，跨过半天就断片——
//   上午做的事下午就忘了，昨天说过的话今天提不起来。真人是不会这样的：
//   她一整天都带着「今天已经发生过的事」在过，也能随口提起「昨天那件事」。
//   没有这层，故事就只是一串互不相干的片段，这也是「上下不连贯」的深层原因之一。
//
// 做法很轻：不额外调模型，直接从时间轴按天把事实归档成摘要，
// 再注入世界阶段与对话阶段的提示里。

import { cut } from '../text-safe.js';
import { toMs } from './time.js';
import { renderSpeechLine } from './speech.js';

/** 取北京时间的日期键 YYYY-MM-DD */
function dayKey(ms, tz = 'Asia/Shanghai') {
  try {
    const s = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(ms));
    return s; // en-CA 输出 YYYY-MM-DD
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

const KEEP_DAYS = 2;      // 只用得到「今天」与「昨天」
// 2026-10-29：14 → 8。一天记 14 条里有一半是「看他的消息、删改后回了一句」这类占位，
// 把真正有用的事（去了哪儿、买了什么）稀释掉了。少而准比多而杂有用。
const PER_DAY = 8;        // 每天最多记多少条
const SUMMARY_LEN = 34;   // 每条摘要截断长度

/**
 * 从事件流构建每日记忆。
 * @param {Array} events
 * @param {number} now
 * @param {{nameOf?:(id:string)=>string, includeSays?:boolean}} opts
 *   nameOf 用来把 c:linxia 渲染成「林夏」；
 *   includeSays=false 时只归档「她自己做过的事」（act/move/world），不记任何台词。
 *   对话阶段必须关掉：台词属于生活线，混进聊天阶段就会被当成回复素材抄走
 *   （2026-10-29 线上：他问「还没喝的嘛」，她回「林夏问我要不要开汽水[表情:困]」）。
 * @returns {{today:string, yesterday:string, days:Record<string,string[]>}}
 */
export function buildDailyDigest(events, now = Date.now(), opts = {}) {
  const nameOf = opts.nameOf ?? ((id) => id);
  const includeSays = opts.includeSays !== false;
  const todayKey = dayKey(now);
  const yKey = dayKey(now - 86400000);

  const buckets = new Map();
  for (const e of events ?? []) {
    const t = toMs(e?.at);
    if (!Number.isFinite(t)) continue;
    const kind = String(e?.kind ?? '');
    if (!['act', 'say', 'world', 'move'].includes(kind)) continue;
    // includeSays=false 是「只记她做过的事」：台词不记，他发来的消息也不记——
    // 那些属于聊天线，对话阶段另有「聊天窗口」块。以前没剔，生活层里一半是
    // 「他发来：…」，等于把聊天记录又抄了一遍，两层还是糊在一起。
    if (!includeSays && (kind === 'say' || (kind === 'world' && e.source === 'user'))) continue;
    const k = dayKey(t);
    if (!buckets.has(k)) buckets.set(k, []);

    let text = '';
    if (kind === 'move') {
      text = `${e.from ?? '?'}→${e.to ?? '?'}${e.summary ? `（${e.summary}）` : ''}`;
    } else if (kind === 'say') {
      // 必须带归属：「她对林夏说」「林夏对她说」「她对他说」。
      // 以前一律写成「说了：…」，把配角问的话记成了她说过的话——
      // 这就是「A 的事被套到 B 身上」在记忆层的来源。
      text = renderSpeechLine(e, { nameOf, maxLen: SUMMARY_LEN });
    } else if (kind === 'world' && e.source === 'user') {
      text = `他发来：${clip(e.prose ?? e.summary ?? '')}`;
    } else {
      text = clip(e.summary ?? e.prose ?? '');
    }
    if (text) buckets.get(k).push(text);
  }

  // 每天内部去重、限量；只保留最近几天
  const days = {};
  const keys = [...buckets.keys()].sort().slice(-KEEP_DAYS);
  for (const k of keys) {
    const seen = new Set();
    const out = [];
    const list = buckets.get(k) ?? [];
    for (let i = list.length - 1; i >= 0; i -= 1) { // 从最近的往前取
      const t = list[i];
      const norm = t.replace(/[\s，。、；：！？…"“”「」（）()]+/g, '');
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.unshift(t);
      if (out.length >= PER_DAY) break;
    }
    days[k] = out;
  }

  return { today: todayKey, yesterday: yKey, days };
}

function clip(s, n = SUMMARY_LEN) {
  // cut：按代理对边界截断，别把 emoji 劈成半个（半个代理项会让上游解析 400）
  return cut(String(s ?? '').replace(/\s+/g, ' ').trim(), n, '…');
}

/** 渲染成提示块：今天的在前，昨天的在后 */
export function renderDigest(digest, opts = {}) {
  if (!digest) return '';
  const { today, yesterday, days } = digest;
  // 对话阶段用「她做过的事」——明确写成动作，避免被读成「她说过这些话」
  const todayTitle = opts.actsOnly
    ? '<今天到目前为止（她自己做过的事，不是对话记录）>'
    : '<今天到目前为止（她自己记得的）>';
  const yTitle = opts.actsOnly
    ? '<昨天（她做过的事）>'
    : '<昨天（她还记得的事；这是她自己的记忆，不等于和他约好过什么）>';
  const parts = [];
  const t = days?.[today] ?? [];
  const y = days?.[yesterday] ?? [];
  if (t.length) {
    parts.push(todayTitle, ...t.map((x) => `- ${x}`), '</今天到目前为止>');
  }
  if (y.length) {
    parts.push('', yTitle, ...y.map((x) => `- ${x}`), '</昨天>');
  }
  return parts.join('\n');
}
