// 时间轴视图：把结构化世界状态渲染给模型看。
//
// 这一块是「固定注入」的，不参与任何字符预算裁剪 —— HDS 的当日早段就是被
// 12000 字符预算挤出去的，模型看不到下午已经出过门，于是傍晚又写了一次「出门」。
// 这里全天 30 条也只要约 2KB，让它永远在场。

import { fmtClock, fmtDate } from './time.js';
import { Place, PLACE_LABEL, EventKind } from './state.js';

/** 当前地点下的禁止动作提示（直接告诉模型不能写什么） */
const FORBIDDEN_BY_PLACE = {
  [Place.HOME]: '她已经在家：不得写「回家/到家/进门/回到住处」，要外出请写 move 从 home 出发',
  [Place.OFFICE]: '她在公司：不得写「去公司/到公司/上班路上」，要离开请写 move 从 office 出发',
  [Place.TRANSIT]: '她在路上：不得写「出门/下楼/出发」，应写到达后的 move',
  [Place.OUTSIDE]: '她在外面：不得写「出门/下楼/离开家」（她已经出过门了），回家需显式写 move → home',
  [Place.OTHER]: '她不在家也不在公司：移动请写显式 move',
};

/** 由注册表造一个 id → 展示名 的解析器（c:roommate → 室友） */
export function nameResolver(registry) {
  return (id) => registry?.get?.(id)?.displayName ?? id;
}

/**
 * 渲染当日时间轴。
 * @param {import('./state.js').Timeline} timeline
 * @param {number} now 当前毫秒
 * @param {{maxLines?:number, resolveName?:(id:string)=>string}} opts
 */
export function renderDayTimeline(timeline, now, opts = {}) {
  const maxLines = opts.maxLines ?? 40;
  const nameOf = opts.resolveName ?? ((x) => x);
  const dateStr = fmtDate(now);
  const lines = [`[当日时间轴 ${dateStr}]`];

  // 地点占用段（由 move 派生，不是从散文里猜的）
  const segs = timeline.occupancy().filter((s) => {
    const from = s.from === Number.NEGATIVE_INFINITY ? now - 864e5 : s.from;
    return fmtDate(from) === dateStr || (s.to === null);
  });
  for (const s of segs) {
    const fromLabel = s.from === Number.NEGATIVE_INFINITY ? '??:??' : fmtClock(s.from);
    const toLabel = s.to === null ? '现在' : fmtClock(s.to);
    lines.push(`${fromLabel}-${toLabel}  ${PLACE_LABEL[s.place] ?? s.place}`);
  }

  // 当天的关键事件（一行式，带活动与在场人物）
  const dayEvents = timeline.eventsOnDate(dateStr)
    .filter((e) => e.kind !== EventKind.SAY)
    .slice(-maxLines);
  for (const e of dayEvents) {
    const clock = fmtClock(toMsSafe(e.at));
    const place = e.kind === EventKind.MOVE
      ? `MOVE → ${PLACE_LABEL[e.to ?? e.place] ?? (e.to ?? e.place)}`
      : PLACE_LABEL[e.place] ?? '';
    const act = String(e.summary ?? e.prose ?? '').replace(/\s+/g, ' ').slice(0, 24);
    // 远程互动要标明，不然「收到消息 · [u:xxx]」会被读成「他来了」；
    // 她自己（self）不进名单——她做什么她自己知道，不用每行都写一遍
    const others = (Array.isArray(e.actors) ? e.actors : []).filter((a) => a !== 'self');
    const who = e.remote
      ? ' · (远程)'
      : (others.length ? ` · [${others.map(nameOf).join('、')}]` : '');
    lines.push(`${clock}  ${place}${act ? ` · ${act}` : ''}${who}`);
  }

  return lines.join('\n');
}

/** 当前事实块：她在哪、和谁、不能写什么 */
export function renderCurrentFacts(timeline, now, opts = {}) {
  const nameOf = opts.resolveName ?? ((x) => x);
  const place = timeline.currentPlace(now);
  const companions = timeline.companionsAt(now).map(nameOf);
  const last = timeline.lastEvent();
  const lines = [
    `>>> 现在 ${fmtClock(now)}`,
    `当前事实: 她${PLACE_LABEL[place] ?? place}${companions.length ? `，和 ${companions.join('、')} 在一起` : '，独自一人'}。`,
    FORBIDDEN_BY_PLACE[place] ?? '',
    last ? `最近一件事: ${String(last.summary ?? last.prose ?? '').replace(/\s+/g, ' ').slice(0, 40)}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

/** 时间轴 + 当前事实，合成注入块 */
export function renderWorldBlock(timeline, now, opts = {}) {
  return `${renderDayTimeline(timeline, now, opts)}\n${renderCurrentFacts(timeline, now, opts)}`;
}

function toMsSafe(v) {
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : Date.now();
}
