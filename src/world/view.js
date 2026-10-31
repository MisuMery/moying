// 时间轴视图：把结构化世界状态渲染给模型看。
//
// 这一块是「固定注入」的，不参与任何字符预算裁剪 —— HDS 的当日早段就是被
// 12000 字符预算挤出去的，模型看不到下午已经出过门，于是傍晚又写了一次「出门」。
// 这里全天 30 条也只要约 2KB，让它永远在场。

import { cut } from '../text-safe.js';
import { fmtClock, fmtDate, localWeekday } from './time.js';
import { Place, PLACE_LABEL, EventKind } from './state.js';
import { renderSpeechLine } from './speech.js';
import { phaseAt, modeSpec } from './travel.js';

const WEEKDAY_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 当前地点下的禁止动作提示（直接告诉模型不能写什么） */
const FORBIDDEN_BY_PLACE = {
  [Place.HOME]: '她已经在家：不得写「回家/到家/进门/回到住处」，要外出请写 move 从 home 出发',
  [Place.OFFICE]: '她在公司：不得写「去公司/到公司/上班路上」，要离开请写 move 从 office 出发',
  [Place.TRANSIT]: '她在路上（通勤还没走完）：先写地铁/公交/骑车/步行途中的细节，别急着写「到了/进公司/到家」；只有真的到站了才写抵达的 move',
  [Place.OUTSIDE]: '她在外面：不得写「出门/下楼/离开家」（她已经出过门了），回家需显式写 move → home',
  [Place.PARK]: '她在公园/江边：不得写「出门/下楼/到公司」；要换个地方（回家、吃饭、逛商场）请写显式 move',
  [Place.MALL]: '她在商场/商圈：不得写「出门/下楼/到公司」；要离开请写显式 move（如 → home 或 → food）',
  [Place.MARKET]: '她在超市/菜场：不得写「出门/下楼/到公司」；买完要离开请写显式 move',
  [Place.FOOD]: '她在餐馆/小吃店：不得写「出门/下楼/到公司」；吃完要离开请写显式 move',
  [Place.ERRAND]: '她在办事（银行/快递/物业等）：不得写「出门/下楼/到公司」；办完要离开请写显式 move',
  [Place.OTHER]: '她不在家也不在公司：移动请写显式 move',
};

/** 由注册表造一个 id → 展示名 的解析器（c:roommate → 室友） */
export function nameResolver(registry) {
  return (id) => registry?.get?.(id)?.displayName ?? id;
}

/** 属于「聊天线」的事件：台词，以及他远程发来的消息。
 *  对话阶段的时间轴/事实块都要把这些剔掉——聊天窗口块里有原文，这里再出现一次就是两份对话记录。 */
function isChatLine(e) {
  if (e?.kind === EventKind.SAY) return true;
  return Boolean(e?.remote) && e?.source === 'user';
}

/**
 * 渲染当日时间轴。
 * @param {import('./state.js').Timeline} timeline
 * @param {number} now 当前毫秒
 * @param {{maxLines?:number, resolveName?:(id:string)=>string, includeSays?:boolean}} opts
 *   includeSays=false 时不列任何 SAY（台词）。对话阶段必须关掉——
 *   2026-10-29 线上：这一块把「林夏对她说：要不要再开一罐汽水」摆在她眼前，
 *   聊天模型把它当成「我该发出去的消息」，于是用户收到一句「林夏问我要不要开汽水」。
 *   台词属于生活线，对话阶段只需要动作线 + 聊天窗口。
 */
export function renderDayTimeline(timeline, now, opts = {}) {
  const includeSays = opts.includeSays !== false;
  // compact：对话阶段用。只给「最近这一小段」，不铺全天流水账。
  // 2026-10-29：对话阶段原来拿到全天 20 行地点段 + 30 行事件（约 2KB），
  // 里面八成是上午的通勤和她自己的琐事，真正相关的只有最后几行。
  // 弱模型在这么多噪音里抓不住「他刚说了什么」，答非所问大半来自这里。
  const compact = opts.compact === true;
  const maxLines = compact ? (opts.maxLines ?? 8) : (opts.maxLines ?? 40);
  const nameOf = opts.resolveName ?? ((x) => x);
  const dateStr = fmtDate(now);
  const lines = [`[当日时间轴 ${dateStr}]`];

  // 地点占用段（由 move 派生，不是从散文里猜的）——compact 时省掉：
  // 「07:55-08:08 路上」这种对她要说的话没有任何影响，只有「现在在哪」有用，那在下面的事实块里。
  if (!compact) {
    const segs = timeline.occupancy().filter((s) => {
      const from = s.from === Number.NEGATIVE_INFINITY ? now - 864e5 : s.from;
      return fmtDate(from) === dateStr || (s.to === null);
    });
    for (const s of segs) {
      const fromLabel = s.from === Number.NEGATIVE_INFINITY ? '??:??' : fmtClock(s.from);
      const toLabel = s.to === null ? '现在' : fmtClock(s.to);
      lines.push(`${fromLabel}-${toLabel}  ${PLACE_LABEL[s.place] ?? s.place}`);
    }
  }

  // 当天的关键事件（一行式，带活动与在场人物）。
  // 2026-10-29：把 SAY 也纳进来，但**必须带归属**（「林夏对她说」「她对林夏说」）——
  // 以前 SAY 全被丢掉，模型只看得到事件摘要，分不清谁跟谁说过什么，
  // 于是把配角的话当自己的经历，甚至算到用户头上。
  const dayAll = timeline.eventsOnDate(dateStr);
  // 台词只取最近 12 条：全天几十句 SAY 会在 maxLines 里把动作线挤没。
  // 2026-10-29 线上：这里写成 `includeSays ? true : ...`，恒真 → dayAll 已含全部 SAY，
  // 后面又拼了一次 saysTail，于是每句台词都被渲染两遍（「你也早点睡」「晚安」各出现两次）。
  // 判断必须落在「是不是 SAY」上，拼回来的那一份才不会有重叠。
  const saysTail = includeSays ? dayAll.filter((e) => e.kind === EventKind.SAY).slice(-12) : [];
  // includeSays=false 时连「收到消息：…」一起剔：那是聊天线，下面「聊天窗口」块有完整记录。
  // 留着的话她眼前会同时出现两份聊天记录（一份是摘要、一份是原文），还在两个不同的块里。
  const keepOther = (e) => (includeSays ? e.kind !== EventKind.SAY : !isChatLine(e));
  const dayEvents = [...dayAll.filter(keepOther), ...saysTail]
    .sort((a, b) => toMsSafe(a.at) - toMsSafe(b.at))
    .slice(-maxLines);
  for (const e of dayEvents) {
    const clock = fmtClock(toMsSafe(e.at));
    if (e.kind === EventKind.SAY) {
      const line = renderSpeechLine(e, { nameOf, maxLen: 22 });
      if (line) lines.push(`${clock}  ${line}`);
      continue;
    }
    const place = e.kind === EventKind.MOVE
      ? `MOVE → ${PLACE_LABEL[e.to ?? e.place] ?? (e.to ?? e.place)}`
      : PLACE_LABEL[e.place] ?? '';
    const act = cut(String(e.summary ?? e.prose ?? '').replace(/\s+/g, ' '), 24);
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
  // 同样受 includeSays 控制：「最近一件事」如果是一条台词或他发来的消息，
  // 聊天阶段会把它当消息素材抄走（2026-10-29：她回「林夏问我要不要开汽水」）
  let last = timeline.lastEvent();
  if (opts.includeSays === false && last && isChatLine(last)) {
    const all = timeline.eventsOnDate ? timeline.eventsOnDate(fmtDate(now)) : [];
    last = [...all].reverse().find((e) => !isChatLine(e)) ?? null;
  }
  const act = typeof timeline.activityAt === 'function' ? timeline.activityAt(now) : null;
  // 正在做某件事时，地点以那件事自己声明的地点为准：时间轴上她可能还停在 other
  // （这一批没写 move），但事件说了在商场——「她在别处」+「在商场还有 10 分钟」两行
  // 自相矛盾，模型只会挑一句信，然后写歪。
  const shownPlace = act?.place ?? place;
  const lines = [
    // 带上「几号 + 星期几」：模型没有日历，只给 09:56 它会自己推日期，
    // 于是把「昨天说的」说成「上周说的」（2026-10-29 线上事故）。锚点给足，就不会瞎算。
    `>>> 现在 ${fmtDate(now)} ${WEEKDAY_LABEL[localWeekday(now)] ?? ''} ${fmtClock(now)}`,
    `当前事实: 她在${PLACE_LABEL[shownPlace] ?? shownPlace}${companions.length ? `，和 ${companions.join('、')} 在一起` : '，独自一人'}。`,
    renderJourney(timeline, now),
    renderActivity(act),
    FORBIDDEN_BY_PLACE[shownPlace] ?? '',
    last ? `最近一件事: ${cut(String(last.summary ?? last.prose ?? '').replace(/\s+/g, ' '), 40)}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

/**
 * 在途时写清「到哪了、还要多久」。
 * 这段是程序算出来的事实，模型没法否认——它能说「还有三站」，但说不了「我到了」。
 */
function renderJourney(timeline, now) {
  const j = typeof timeline.journeyAt === 'function' ? timeline.journeyAt(now) : null;
  if (!j) return '';
  const rawLabel = String(PLACE_LABEL[j.to] ?? j.to);
  const label = rawLabel.split('/')[0].replace(/（[^）]*）/g, '').trim() || rawLabel;
  const mode = modeSpec(j.mode)?.label ?? '';
  const leg = j.move?.legs?.length ? phaseAt(j.move, now) : null;
  const where = leg?.label ? `，${leg.label}` : '';
  return `她正在去${label}的路上${mode ? `（${mode}）` : ''}${where}，还要约 ${j.remainMin} 分钟才到，`
    + `${fmtClock(j.arriveAt)} 才到${label}——这期间她只在路上：`
    + `可以说还有几站、快到了、再走几分钟；不能说已经到了、下车了、进${label}、站在${label}门口。`
    + `这会儿要是给他发消息，也只能说在路上，说「到了」会被打回重写。`;
}

/**
 * 正在做某件持续动作时，写清「这件事还要做多久」。
 * 与 renderJourney 同一思路：这是程序按 span 算出的事实，模型不能提前宣称做完。
 * @param {{activity:string, place:string, remainMin:number}|null} a
 */
function renderActivity(a) {
  if (!a) return '';
  // summary 常是一整句（「两人在商场里慢慢逛，林夏看衣服，她在旁边站着」），
  // 直接接在「她正在」后面会读成「她正在两人在商场里慢慢逛」。取第一个分句、剥掉主语前缀。
  const raw = String(a.activity ?? '做事');
  let label = raw.split(/[，,。；;]/)[0].trim().replace(/^(两人|她们|他们|她|他|我)在?/, '').trim();
  if (!label) label = raw.slice(0, 14);
  const placeLabel = String(PLACE_LABEL[a.place] ?? a.place ?? '');
  const where = placeLabel ? `（在${placeLabel}，还有 ${a.remainMin} 分钟才完）` : `（还有 ${a.remainMin} 分钟才完）`;
  return `她正在${label}${where}——`
    + `这期间她就在做这件事：可以说还在试、还在挑、喝了一半、排队等着；`
    + `不能说已经试完了、买好了、喝完了、排到了、结账了——做没做完由时间算，时间没到就还在做。`
    + `这会儿要给他发消息，也只能说正在做这件事，说「做完了」会被打回重写。`;
}

/** 时间轴 + 当前事实，合成注入块 */
export function renderWorldBlock(timeline, now, opts = {}) {
  return `${renderDayTimeline(timeline, now, opts)}\n${renderCurrentFacts(timeline, now, opts)}`;
}

function toMsSafe(v) {
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : Date.now();
}
