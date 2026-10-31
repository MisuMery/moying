// 故事导出：把一段时间内发生的事整理成能读的文档。
//
// 独立于运行时逻辑重写的一份渲染器：只按时间顺序读事件，不重放、不改写。
// 支持 Markdown（给人读）与 JSON（给程序读）。

import { fmtClock, fmtDate, toMs } from '../world/time.js';
import { PLACE_LABEL } from '../world/state.js';

const KIND_VIEW = {
  // 散文是正片：完整叙事单独一类，状态类事件只留摘要，避免重复占篇幅
  narration: { icon: '📖', label: '叙事', full: true },
  act: { icon: '·', label: '状态' },
  move: { icon: '·', label: '状态' },
  say: { icon: '💬', label: '她说' },
  world: { icon: '🌍', label: '世界' },
};

/**
 * 取某个时间区间内的事件。
 * @param {Array} events store.loadEvents() 的结果
 * @param {{from?:number|string, to?:number|string}} range
 */
export function selectRange(events, { from, to } = {}) {
  const f = from === undefined || from === null || from === '' ? Number.NEGATIVE_INFINITY : toMs(from);
  const t = to === undefined || to === null || to === '' ? Number.POSITIVE_INFINITY : toMs(to);
  return events
    .map((e) => ({ e, at: toMs(e.at) }))
    .filter((x) => Number.isFinite(x.at) && x.at >= f && x.at <= t)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.e);
}

/**
 * 这条事件该显示成谁说的话/做的事。
 * 教训（2026-10-25 线上导出）：原先按 `source === 'user'` 判定「对方」，
 * 但用户回合产出的叙事、她说的话、她的动作 source 全是 user，于是整篇
 * 导出全是「🧑 对方」。判定必须按 kind + actors + remote，与 source 无关：
 * source 只记录「哪个源触发的回合」，不记录「这话是谁说的」。
 *
 * @param {object} e 事件
 * @param {Record<string,string>} names actor id → 显示名（控制台传入，缺失时退回 id）
 */
export function resolveView(e, names = {}) {
  const label = (id) => names[id] ?? String(id).replace(/^[uc]:/, '');
  const actors = Array.isArray(e.actors) ? e.actors : [];

  // 对方发来的私聊消息：world 事件带 remote 标记
  if (e.kind === 'world' && e.remote) return { icon: '🧑', label: '对方' };
  if (e.kind === 'world') return KIND_VIEW.world;

  if (e.kind === 'say') {
    // say 的 actors 永远是 ['self', ...收件人]——所有 say 都是她说出口的话，
    // 区别只在说给谁
    const cast = actors.filter((a) => a.startsWith('c:'));
    if (cast.length) return { icon: '💬', label: `她对${cast.map(label).join('、')}说` };
    return { icon: '💬', label: '她说' };
  }

  return KIND_VIEW[e.kind] ?? { icon: '⚙️', label: e.kind ?? '' };
}

/** 渲染成 Markdown */
export function renderStoryMarkdown(events, { from, to, title = '故事导出', names = {} } = {}) {
  const L = [];
  const first = events[0];
  const last = events[events.length - 1];
  const now = Date.now();

  L.push(`# ${title}`);
  L.push('');
  const rangeLine = (a, b) => {
    if (!a && !b) return '（全部）';
    const fm = a ? fmtDate(toMs(a)) : '';
    const tm = b ? fmtDate(toMs(b)) : fm;
    return `${fm} ${a ? fmtClock(toMs(a)) : ''} → ${tm} ${b ? fmtClock(toMs(b)) : ''}`.trim();
  };
  L.push(`> 范围：${rangeLine(from ?? first?.at, to ?? last?.at)}（UTC+8）  `);
  L.push(`> 条目：${events.length} 条  `);
  L.push(`> 导出时间：${fmtDate(now)} ${fmtClock(now)}`);
  L.push('');
  L.push('**阅读图例**：📖 叙事（完整散文）· 💬 她说出口的话（含说给谁）· 🧑 对方的消息 · 🌍 世界事件 · · 状态（只记录事实，不展开）');
  L.push('');
  L.push('---');
  L.push('');

  let lastDate = '';
  for (const e of events) {
    const at = toMs(e.at);
    const date = fmtDate(at);
    if (date !== lastDate) {
      L.push('', `## ${date}`, '');
      lastDate = date;
    }
    const clock = fmtClock(at);
    const view = resolveView(e, names);
    const place = e.place ? PLACE_LABEL[e.place] ?? e.place : '';

    if (view.icon === '📖') {
      L.push(`**${clock}** ${view.icon} ${place ? `（${place}）` : ''}`);
      L.push('');
      L.push('> ' + String(e.prose ?? e.summary ?? '').replace(/\n/g, '\n> '));
      L.push('');
    } else {
      const text = String(e.prose ?? e.summary ?? '').replace(/\n/g, ' ').trim();
      L.push(`**${clock}** ${view.icon} **${view.label}**：${text}`);
      L.push('');
    }
  }

  if (!events.length) L.push('（这个时间范围内没有任何记录）');
  return L.join('\n');
}

/** 渲染成 JSON（结构化，便于二次处理） */
export function renderStoryJson(events, meta = {}) {
  return {
    meta: { exportedAt: new Date().toISOString(), count: events.length, ...meta },
    events: events.map((e) => ({
      at: e.at,
      kind: e.kind,
      source: e.source ?? null,
      place: e.place ?? null,
      actors: e.actors ?? [],
      summary: e.summary ?? null,
      prose: e.prose ?? null,
      importance: e.importance ?? null,
    })),
  };
}
