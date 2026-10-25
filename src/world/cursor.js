// 演化游标：故事推进到哪一刻了。
//
// 时间边界的全部秘密就在这一个对象里：每轮的演化窗口是 [cursorAt, now]。
// 模型只能在这个窗口里安排事情——
//   · 可以「提前做」：窗口内的任何时刻都行（下午一点说「待会儿要去办件事」，
//     只要那件事落在窗口之内或作为计划登记）；
//   · 不能「跳时间」：下午两点绝不允许写出「现在是下午四点，所以做了这件事」，
//     因为 16:00 超出了窗口上界 now，会被 R1 直接拦掉。
// 未来（> now）的事只能作为计划登记，不参与状态推导，也不会写进时间轴。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

const CURSOR_PATH = path.join(DATA_DIR, 'cursor.json');

export class StoryCursor {
  constructor(fallbackFrom = null) {
    /** @type {number|null} */
    this.at = this.#load() ?? fallbackFrom;
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(CURSOR_PATH, 'utf8'));
      const t = Number(raw?.at ?? raw);
      return Number.isFinite(t) ? t : null;
    } catch {
      return null;
    }
  }

  #save() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CURSOR_PATH, JSON.stringify({ at: this.at, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  }

  /** 上次推进到的时刻；没有就返回 null（冷启动由调用方决定起点） */
  get() {
    return this.at;
  }

  /** 推进游标到 now（只前进，不后退） */
  advance(now = Date.now()) {
    if (this.at === null || now > this.at) {
      this.at = now;
      this.#save();
    }
    return this.at;
  }

  /** 重置到某个时刻（控制台手动干预用） */
  reset(at) {
    this.at = Number(at) || null;
    this.#save();
    return this.at;
  }

  /**
   * 本轮演化窗口。
   * @param {number} now
   * @returns {{from:number, to:number, spanMinutes:number, fromISO:string, toISO:string}}
   */
  window(now = Date.now(), maxSpanMinutes = 180) {
    const from = this.at ?? now;
    // 窗口上界就是 now —— 这是「不能跳到未来」的硬边界
    const to = now;
    const span = Math.max(0, Math.round((to - from) / 60000));
    return {
      from,
      to,
      spanMinutes: Math.min(span, maxSpanMinutes * 24),
      fromISO: new Date(from).toISOString(),
      toISO: new Date(to).toISOString(),
    };
  }

  /** 给提示词看的窗口说明 */
  renderWindow(now = Date.now()) {
    const w = this.window(now);
    const fmt = (ms) => new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(ms));
    if (w.spanMinutes <= 0) {
      return `<本轮演化窗口>现在就是 ${fmt(w.to)}（没有需要补写的时间段）。` +
        '\n你可以写此刻正在发生的事，也可以登记之后的计划（计划不算已发生）。</本轮演化窗口>';
    }
    return [
      '<本轮演化窗口>',
      `需要补写的是 ${fmt(w.from)} → ${fmt(w.to)} 这 ${w.spanMinutes} 分钟里发生的事。`,
      '规则：',
      `- 事件的 at 必须落在这个区间内，最早不早于 ${fmt(w.from)}，最晚不晚于 ${fmt(w.to)}（现在）。`,
      '- 可以提前做区间内晚些时候的事，但绝不允许把「现在」写成更晚的时刻。',
      '- 区间以外（更晚）的安排只能作为计划登记，不算已发生。',
      '</本轮演化窗口>',
    ].join('\n');
  }
}
