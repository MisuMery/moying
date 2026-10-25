// 收件箱：把短时间内的连续消息合并成一个回合。
//
// 「不是每一条都回」的主力在这里 —— 真人不会你发一条我回一条，
// 通常是看到好几条、想一会儿，再一起回。HDS 也是这么做的（同一关系分支的
// 连续消息在短时间内合并）。合并窗口由 willingness 算出的反应延迟决定：
// 清醒时十几秒，忙的时候一两分钟，睡着就压根不排。

export class Inbox {
  /**
   * @param {(userId:string, messages:Array) => void} onFlush 到点后触发一次回合
   */
  constructor({ onFlush }) {
    this.onFlush = onFlush;
    /** @type {Map<string, {messages:Array, timer:Timeout|null, deadline:number}>} */
    this.buffers = new Map();
  }

  /**
   * 投入一条消息。第一条决定 deadline；后续消息只累积，不再延后 deadline
   * （否则对方一直说就永远不回，会饿死）。
   */
  push(userId, message, delayMs = 15000) {
    const key = String(userId);
    let b = this.buffers.get(key);
    if (!b) {
      b = { messages: [], timer: null, deadline: 0 };
      this.buffers.set(key, b);
    }
    b.messages.push(message);
    if (b.timer) return { merged: true, count: b.messages.length, deadline: b.deadline };

    const wait = Math.max(0, Math.min(delayMs, 10 * 60 * 1000));
    b.deadline = Date.now() + wait;
    b.timer = setTimeout(() => this.flush(key), wait);
    if (typeof b.timer?.unref === 'function') b.timer.unref();
    return { merged: false, count: b.messages.length, deadline: b.deadline };
  }

  flush(userId) {
    const key = String(userId);
    const b = this.buffers.get(key);
    if (!b) return null;
    const messages = b.messages;
    this.buffers.delete(key);
    if (b.timer) clearTimeout(b.timer);
    if (!messages.length) return null;
    // 返回 Promise，调用方可以 await 到这个回合真正跑完
    return Promise.resolve()
      .then(() => this.onFlush(key, messages))
      .catch((error) => console.error('[inbox] flush 出错:', error?.message ?? error))
      .then(() => messages);
  }

  /** 控制台查看用：还有谁的消息在排队 */
  pending() {
    return [...this.buffers.entries()].map(([userId, b]) => ({
      userId,
      count: b.messages.length,
      deadline: new Date(b.deadline).toISOString(),
      waitMs: Math.max(0, b.deadline - Date.now()),
    }));
  }
}
