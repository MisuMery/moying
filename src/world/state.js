// 世界时间轴：唯一可校验的真相来源。
//
// HDS 里散文（prose）是唯一真相，于是「她此刻在家」这种事实只存在于句子里，
// 无法被程序校验 —— 16:23 出了门，18:27 模型照样能再写一次「她出门」。
// 这里反过来：prose 只是 WorldEvent 的渲染产物，状态由 move 事件序列派生。

import { toMs, fmtDate, sortEventsByTime } from './time.js';

/**
 * 地点枚举。
 * 之前只有 home/office/transit/outside_social/other 五个，模型根本没有词可以表达
 * 真实城市生活，于是她的世界被压成「家 ↔ 公司」两点一线（线上证据：全部历史 move
 * 目的地只出现过 home/office/outside_social/other 四个值，近 24h 只有 home→office→home）。
 * 这里补上真实都市里她真的会去的场所，让「外出」有内容、能被时间轴校验和渲染。
 */
export const Place = {
  HOME: 'home',
  OFFICE: 'office',
  TRANSIT: 'transit',
  PARK: 'park',
  MALL: 'mall',
  MARKET: 'market',
  FOOD: 'food',
  ERRAND: 'errand',
  OUTSIDE: 'outside_social',
  OTHER: 'other',
};

export const PLACE_LABEL = {
  [Place.HOME]: '在家',
  [Place.OFFICE]: '公司',
  [Place.TRANSIT]: '路上',
  [Place.PARK]: '公园/江边',
  [Place.MALL]: '商场/商圈',
  [Place.MARKET]: '超市/菜场',
  [Place.FOOD]: '餐馆/小吃店',
  [Place.ERRAND]: '办事（银行/快递/物业等）',
  [Place.OUTSIDE]: '外面（和熟人聚会）',
  [Place.OTHER]: '别处',
};

/** 注入提示词的地点词表：告诉模型 move 的 to / 事件的 place 可以填哪些值 */
export const PLACE_VOCAB = [
  `${Place.HOME}＝家、住处`,
  `${Place.OFFICE}＝公司、办公室（含会议室、工位、茶水间）`,
  `${Place.TRANSIT}＝路上（地铁、公交、骑车、步行途中）`,
  `${Place.PARK}＝公园、江边、广场、小区花园（散步、坐着发呆、遛弯）`,
  `${Place.MALL}＝商场、商业街、步行街、服装店（逛街、买东西、闲逛）`,
  `${Place.MARKET}＝超市、菜市场、便利店、水果店（买菜、买日用品、囤零食）`,
  `${Place.FOOD}＝餐馆、小吃店、面馆、奶茶店、外卖自取（吃饭、喝东西）`,
  `${Place.ERRAND}＝办事：银行、快递驿站、医院、诊所、物业、政务大厅、修手机`,
  `${Place.OUTSIDE}＝和熟人在一起：同事聚餐、朋友约饭、和室友出门`,
  `${Place.OTHER}＝以上都不合适的别处`,
].join('\n');

/** 她是否还在外面（不在家） */
export function isAway(place) {
  return place != null && place !== Place.HOME;
}

export const EventKind = {
  MOVE: 'move',
  ACT: 'act',
  SAY: 'say',
  WORLD: 'world',
  // 散文：给人读的完整叙事。不参与任何状态推导，状态只认上面四类结构化事件
  NARRATION: 'narration',
};

export class Timeline {
  /**
   * @param {Array} events 已提交的世界事件（按 at 升序）
   * @param {string} startPlace 故事起点所在地点
   */
  constructor(events = [], startPlace = Place.HOME) {
    // 排序规则与存储层同一份（sortEventsByTime）：同时间戳保持写入顺序，坏时间排末尾
    this.events = sortEventsByTime(events);
    this.startPlace = startPlace;
  }

  /** 最后一条已提交事件的时间（毫秒），没有则为 null */
  lastAt() {
    for (let i = this.events.length - 1; i >= 0; i -= 1) {
      const t = toMs(this.events[i].at);
      if (Number.isFinite(t)) return t;
    }
    return null;
  }

  lastEvent() {
    return this.events[this.events.length - 1] ?? null;
  }

  /**
   * 由 move 序列派生的地点占用区间。
   * @returns {Array<{place:string, from:number, to:number|null}>}
   */
  occupancy() {
    // move 在这个引擎里**就是她的位移**（同行的其他人写在 actors 里），
    // 其他角色的移动用 act 表达 —— 所以这里不需要再按 actors 过滤。
    //
    // 2026-10-30：move 现在可以带 arriveAt（出发时刻 + 路程时长）。
    // 从出发到到达之间她**在路上**（transit），不是已经到了——
    // 否则「07:44 上车、07:48 到站」这种瞬移在状态层就成立了，拦都拦不住。
    const intervals = [];
    let cur = { place: this.startPlace, from: Number.NEGATIVE_INFINITY, to: null };
    let lastEnd = Number.NEGATIVE_INFINITY;
    for (const e of this.events) {
      if (e.kind !== EventKind.MOVE) continue;
      const dep = toMs(e.at);
      if (!Number.isFinite(dep)) continue;
      const to = e.to ?? e.place;
      if (!to) continue;
      let arr = toMs(e.arriveAt);
      // 没有 arriveAt 的历史事件按瞬时位移处理，行为与改动前一致
      if (!Number.isFinite(arr) || arr < dep) arr = dep;
      const start = Math.max(dep, lastEnd);

      cur.to = start;
      intervals.push(cur);
      if (arr > start) {
        // 途中：地点是 transit，但带着这段行程的 id，方便查出「还有多久、到哪一段了」
        intervals.push({ place: Place.TRANSIT, from: start, to: arr, journeyId: e.id ?? null, headingTo: to });
      }
      cur = { place: to, from: Math.max(arr, start), to: null };
      lastEnd = Math.max(arr, start);
    }
    intervals.push(cur);
    return intervals;
  }

  /** 某时刻她在哪；早于所有记录则返回起点 */
  placeAt(ms) {
    const iv = this.occupancy();
    for (const seg of iv) {
      if (ms >= seg.from && (seg.to === null || ms < seg.to)) return seg.place;
    }
    return this.startPlace;
  }

  /** 当前所在地点 */
  currentPlace(now = Date.now()) {
    return this.placeAt(now);
  }

  /**
   * 此刻是否在途中。在途时返回这段行程，否则 null。
   * @returns {{move:object, to:string, mode:string, departAt:number, arriveAt:number, remainMin:number}|null}
   */
  journeyAt(ms = Date.now()) {
    let last = null;
    for (const e of this.events) {
      if (e.kind !== EventKind.MOVE) continue;
      const dep = toMs(e.at);
      if (!Number.isFinite(dep)) continue;
      if (dep > ms) break;
      last = e;
    }
    if (!last) return null;
    const dep = toMs(last.at);
    const arr = toMs(last.arriveAt);
    if (!Number.isFinite(arr) || ms >= arr) return null;
    return {
      move: last,
      to: last.to ?? last.place,
      mode: last.mode ?? null,
      departAt: dep,
      arriveAt: arr,
      remainMin: Math.max(1, Math.ceil((arr - ms) / 60000)),
    };
  }

  /**
   * 此刻她身边有谁。
   *
   * 每个角色的位置由**他自己参与的物理事件**逐条断言：
   *   - move → 他去了 to
   *   - act  → 他在那个地点做事
   * 「收到消息」是远程互动，不断言任何人的位置——否则他发一条消息，
   * 就会被推导成「他此刻坐在她旁边」。她自己做事（actors 只有 self）
   * 也不会把别人从房间里抹掉：室友在厨房削水果，不因她刷手机而消失。
   */
  companionsAt(ms) {
    const PRESENCE_KINDS = new Set([EventKind.MOVE, EventKind.ACT]);
    const placeByActor = new Map();
    for (const e of this.events) {
      const at = toMs(e.at);
      if (!Number.isFinite(at) || at > ms) break;
      if (!PRESENCE_KINDS.has(e.kind)) continue;
      if (e.remote) continue; // 远程同框不算同在
      const place = e.kind === EventKind.MOVE
        ? (e.to ?? e.place)
        : (e.place ?? this.placeAt(at));
      if (!place) continue;
      for (const a of Array.isArray(e.actors) ? e.actors : []) {
        if (a === 'self') continue;
        placeByActor.set(a, place);
      }
    }
    const here = this.currentPlace(ms);
    return [...placeByActor.entries()]
      .filter(([, p]) => p === here)
      .map(([a]) => a)
      .sort();
  }

  /** 追加已校验事件 */
  commit(events) {
    for (const e of events) this.events.push(e);
    // 与构造同一套排序：新事件的时间可能早于末尾（合并批次、补记的 act），
    // 单纯 push 会破坏升序，后面 lastEvent()/最近 N 条就取错。
    this.events = sortEventsByTime(this.events);
    return this;
  }

  /**
   * 某一天的全部事件。
   * 不能拿 at 字符串的前 10 位来比：引擎自己写的事件是 UTC（…Z），
   * 北京时间凌晨 0~8 点的那些会被算到前一天去——而她偏偏是个夜猫子，
   * 漏掉的正好是最该看见的那一段。一律换算成本地日期再比。
   */
  eventsOnDate(dateStr) {
    return this.events.filter((e) => {
      const ms = toMs(e?.at);
      return Number.isFinite(ms) && fmtDate(ms) === dateStr;
    });
  }
}
