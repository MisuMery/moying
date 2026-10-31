// 收件箱：把短时间内的连续消息合并成一个回合。
//
// 「不是每一条都回」的主力在这里 —— 真人不会你发一条我回一条，
// 通常是看到好几条、想一会儿，再一起回。HDS 也是这么做的（同一关系分支的
// 连续消息在短时间内合并）。合并窗口由 willingness 算出的反应延迟决定：
// 清醒时十几秒，忙的时候一两分钟，睡着就压根不排。

export class Inbox {
  /**
   * @param {(userId:string, messages:Array) => void} onFlush 到点后触发一次回合
   * @param {number} maxAttempts 单个批次最多尝试几次回合（含首次），失败才放弃
   * @param {number} retryDelayMs 回合跑挂后多久重试
   * @param {number} settleMs 他还在发时，静默多久算这一串说完了
   * @param {number} maxWaitMs 顺延的上限：从他第一条算起，最多让她等这么久
   */
  constructor({
    onFlush, maxAttempts = 3, retryDelayMs = 20000, settleMs = 12000, maxWaitMs = 180000,
  }) {
    this.onFlush = onFlush;
    this.maxAttempts = Math.max(1, Number(maxAttempts) || 1);
    this.retryDelayMs = Math.max(100, Number(retryDelayMs) || 1000);
    this.settleMs = Math.max(0, Number(settleMs) || 0);
    this.maxWaitMs = Math.max(this.settleMs, Number(maxWaitMs) || 180000);
    /** @type {Map<string, {messages:Array, timer:Timeout|null, deadline:number, firstDeadline:number, attempts:number, retrying?:boolean}>} */
    this.buffers = new Map();
  }

  /**
   * 投入一条消息。
   *
   * 第一条定下"最早可以回"的时刻（deadline，由意愿门控算出的反应延迟决定）。
   * 之后他如果还在连着发，就把这次回合往后顺一顺——他话没说完就插一句，
   * 等于把"我还在打字"当成"他说完了"，读起来像抢话。
   *
   * 但顺延必须有天花板：从他第一条算起最多等 maxWaitMs（默认 3 分钟），
   * 否则他一直一句一句发，她就永远不回（饿死）。
   *
   * 已算出 79 秒的那次也一样：11:44 定 79s，11:45 又来一条也不延到 79+N，
   * 只在"他当时还在说"时把 deadline 推到「现在 + settleMs」，且不超过天花板。
   */
  push(userId, message, delayMs = 15000) {
    const key = String(userId);
    let b = this.buffers.get(key);
    if (!b) {
      b = { messages: [], timer: null, deadline: 0, firstDeadline: 0, attempts: 0 };
      this.buffers.set(key, b);
    }
    b.messages.push(message);
    const now = Date.now();

    // 失败重试中的批次：只累积，不要动那个重试定时器
    if (b.timer && b.retrying) {
      return { merged: true, count: b.messages.length, deadline: b.deadline, delayMs: Math.max(0, b.deadline - now) };
    }

    if (b.timer) {
      // 他还在发：等到「这一串静下来」再回，但不越过天花板
      const target = Math.min(now + this.settleMs, b.firstDeadline + this.maxWaitMs);
      if (target > b.deadline) {
        clearTimeout(b.timer);
        b.deadline = target;
        b.timer = setTimeout(() => this.flush(key), Math.max(0, target - now));
        if (typeof b.timer?.unref === 'function') b.timer.unref();
      }
      return { merged: true, count: b.messages.length, deadline: b.deadline, delayMs: Math.max(0, b.deadline - now) };
    }

    const wait = Math.max(0, Math.min(delayMs, 10 * 60 * 1000));
    b.firstDeadline = now + wait;
    b.deadline = b.firstDeadline;
    b.timer = setTimeout(() => this.flush(key), wait);
    if (typeof b.timer?.unref === 'function') b.timer.unref();
    return { merged: false, count: b.messages.length, deadline: b.deadline, delayMs: wait };
  }

  flush(userId) {
    const key = String(userId);
    const b = this.buffers.get(key);
    if (!b) return null;
    const messages = b.messages;
    this.buffers.delete(key);
    if (b.timer) clearTimeout(b.timer);
    if (!messages.length) return null;
    const attempt = (b.attempts ?? 0) + 1;
    // 返回 Promise，调用方可以 await 到这个回合真正跑完
    return Promise.resolve()
      .then(() => this.onFlush(key, messages))
      .catch((error) => {
        console.error('[inbox] flush 出错:', error?.message ?? error);
        // 回合跑挂（LLM 超时、路由抖动）：消息放回缓冲区择期重试，
        // 绝不静默丢弃——沉默丢单在她那边就是「已读不回」
        this.#requeue(key, messages, attempt, error);
      })
      .then(() => messages);
  }

  /** 回合失败后的补救：原样放回队首，排一次重试；次数用尽才明确记账放弃 */
  #requeue(key, messages, attempt, error) {
    if (attempt >= this.maxAttempts) {
      console.error(
        `[inbox] 第 ${attempt} 次回合仍失败，这批消息暂时无法回复：`,
        messages.map((m) => String(m?.text ?? '').slice(0, 30)).join(' / '),
        '|', error?.message ?? error,
      );
      return;
    }
    let b = this.buffers.get(key);
    if (!b) {
      b = { messages: [], timer: null, deadline: 0, firstDeadline: 0, attempts: 0 };
      this.buffers.set(key, b);
    }
    // 放回队首：后来进来的消息排在后面，保持时间顺序
    b.messages = [...messages, ...b.messages];
    b.attempts = attempt;
    // 已有排队中的定时器就不动它：让即将到来的 flush 连老消息一起处理
    if (!b.timer) {
      b.deadline = Date.now() + this.retryDelayMs;
      b.firstDeadline = b.deadline;
      // 标记：这是重试定时器，不是「等他打完字」的缓冲——
      // 期间他再发消息只累积进来，不要顺延（否则重试会被一直推后）
      b.retrying = true;
      b.timer = setTimeout(() => this.flush(key), this.retryDelayMs);
      if (typeof b.timer?.unref === 'function') b.timer.unref();
    }
    const retryIn = this.retryDelayMs >= 1000
      ? `${Math.round(this.retryDelayMs / 1000)}s`
      : `${this.retryDelayMs}ms`;
    console.log(
      `[inbox] 回合失败（${error?.message ?? error}），${retryIn}后重试`
      + `（第 ${attempt}/${this.maxAttempts} 次）`,
    );
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
