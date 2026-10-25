// 世界时间轴：唯一可校验的真相来源。
//
// HDS 里散文（prose）是唯一真相，于是「她此刻在家」这种事实只存在于句子里，
// 无法被程序校验 —— 16:23 出了门，18:27 模型照样能再写一次「她出门」。
// 这里反过来：prose 只是 WorldEvent 的渲染产物，状态由 move 事件序列派生。

import { toMs, fmtDate } from './time.js';

export const Place = {
  HOME: 'home',
  OFFICE: 'office',
  TRANSIT: 'transit',
  OUTSIDE: 'outside_social',
  OTHER: 'other',
};

export const PLACE_LABEL = {
  [Place.HOME]: '在家',
  [Place.OFFICE]: '公司',
  [Place.TRANSIT]: '路上',
  [Place.OUTSIDE]: '外面',
  [Place.OTHER]: '别处',
};

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
    this.events = [...events].sort((a, b) => toMs(a.at) - toMs(b.at));
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
    const intervals = [];
    let cur = { place: this.startPlace, from: Number.NEGATIVE_INFINITY, to: null };
    for (const e of this.events) {
      if (e.kind !== EventKind.MOVE) continue;
      const at = toMs(e.at);
      if (!Number.isFinite(at)) continue;
      const to = e.to ?? e.place;
      if (!to) continue;
      cur.to = at;
      intervals.push(cur);
      cur = { place: to, from: at, to: null };
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
    this.events.sort((a, b) => toMs(a.at) - toMs(b.at));
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
