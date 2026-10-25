// 发送限流：每分钟最多发多少字。
//
// V3 角色卡给了自然上限：常态单条 ≤15 字、一轮连发 2~4 条，也就是一分钟大约 30~60 字。
// 这里用滑动窗口把它变成硬约束 —— 超了就等到有额度再发，而不是一口气刷屏。

export const DEFAULT_RATE = {
  maxCharsPerMinute: 40,
  maxMessagesPerMinute: 6,
  windowMs: 60000,
  maxWaitMs: 150000, // 等超过 2.5 分钟就放弃这条，避免积压成一坨突然全发出来
};

export class RateLimiter {
  constructor(opts = {}) {
    this.cfg = { ...DEFAULT_RATE, ...opts };
    /** @type {Array<{at:number, chars:number}>} */
    this.records = [];
  }

  prune(now = Date.now()) {
    const cutoff = now - this.cfg.windowMs;
    this.records = this.records.filter((r) => r.at > cutoff);
  }

  usage(now = Date.now()) {
    this.prune(now);
    return {
      chars: this.records.reduce((s, r) => s + r.chars, 0),
      messages: this.records.length,
    };
  }

  /**
   * 这条消息现在能不能发。
   * @param {string|number} chars 字数或文本
   * @returns {{ok:boolean, waitMs:number, reason?:string, usage:object}}
   */
  check(chars, now = Date.now()) {
    const n = typeof chars === 'string' ? [...chars].length : Number(chars) || 0;
    this.prune(now);
    const used = this.usage(now);
    const overChars = used.chars + n > this.cfg.maxCharsPerMinute;
    const overCount = used.messages + 1 > this.cfg.maxMessagesPerMinute;
    if (!overChars && !overCount) return { ok: true, waitMs: 0, usage: used };

    // 需要等多久：等到窗口里最老的那几条过期，腾出额度
    const sorted = [...this.records].sort((a, b) => a.at - b.at);
    let freedChars = 0;
    let freedCount = 0;
    let waitMs = this.cfg.windowMs;
    for (const r of sorted) {
      freedChars += r.chars;
      freedCount += 1;
      const need = this.cfg.windowMs - (now - r.at);
      if (used.chars - freedChars + n <= this.cfg.maxCharsPerMinute
        && used.messages - freedCount + 1 <= this.cfg.maxMessagesPerMinute) {
        waitMs = Math.max(0, need);
        break;
      }
    }
    return {
      ok: false,
      waitMs: Math.min(waitMs, this.cfg.maxWaitMs),
      reason: overCount ? 'message-rate' : 'char-rate',
      usage: used,
    };
  }

  /** 实际发送后记账 */
  consume(chars, now = Date.now()) {
    const n = typeof chars === 'string' ? [...chars].length : Number(chars) || 0;
    this.prune(now);
    this.records.push({ at: now, chars: n });
  }

  snapshot(now = Date.now()) {
    const u = this.usage(now);
    return {
      chars: `${u.chars}/${this.cfg.maxCharsPerMinute}`,
      messages: `${u.messages}/${this.cfg.maxMessagesPerMinute}`,
      maxCharsPerMinute: this.cfg.maxCharsPerMinute,
      maxMessagesPerMinute: this.cfg.maxMessagesPerMinute,
    };
  }
}
