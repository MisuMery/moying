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
        '\n这一拍里只够发生一瞬间的事：一句话、一个眼神、一个动作。' +
        '\n要做的长事（试衣服、做饭、通勤、洗澡）得从这里**开始**，不能在这里做完——做完是下一轮的事。' +
        '\n更晚的安排只能作为计划登记（计划不算已发生）。</本轮演化窗口>';
    }
    return [
      '<本轮演化窗口>',
      `需要补写的是 ${fmt(w.from)} → ${fmt(w.to)} 这 ${w.spanMinutes} 分钟里发生的事。`,
      `**这 ${w.spanMinutes} 分钟是全部时间预算**：所有事件的 durationMinutes 加起来不能超过它。`,
      '规则：',
      '- 事件的具体时刻由程序排定，你不用写钟点；你只要保证「这些事的总时长装得进这个窗口」。',
      '- 装不下的事就别写。8 分钟里装不下「逛商场＋试三件衣服＋排队买奶茶」，那是半小时起步——',
      '  硬写进来，程序只能按比例压缩，人物就显得在赶场，读者一眼看出来。',
      '- 想让她做长事，就只写这件事的开头，剩下的留给下一轮；时间会自己往前走。',
      '- 区间以外（更晚）的安排只能作为计划登记，不算已发生。',
      '</本轮演化窗口>',
    ].join('\n');
  }
}
