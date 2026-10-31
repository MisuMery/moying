// 牵挂：她在没有对话的时候，会不会自己想起他。
//
// 为什么需要这一层（2026-10-28 架构审计）：
//   原本的主动性只有一个「阶段基准概率 + 冷却」的门——判据是「距上次说话过了多久」。
//   实测 6 天 234 次自动推进只主动发了 16 次（6.8%），远达不到「她像真人一样会主动找我」。
//   根因不是概率低，而是**冷却被他发来的消息不断重置**：他一聊天，她就永远在冷却里，
//   于是主动行为几乎只在他不说话的长夜里才可能发生——这恰恰不自然。
//
// 真人不是这样：联系过后牵挂会淡一些，但**时间一长又会慢慢涌上来**，
// 而且不是「有没有说过话」的开关，是一个连续量。这里把它做成一等状态：
//   · 没人说话时随时间上升（越久升得越快）；
//   · 说过话就回落（他找她 → 回落大半；她主动找过 → 基本清空）；
//   · 睡觉时不累积（她没在想事情）。
// 主动判定的概率由这个连续量调制，于是「刚聊完不太会立刻又找他，
// 但过几个小时她自己就想起来了」——这才是活人的行为。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

const FILE = path.join(DATA_DIR, 'longing.json');

export const LONGING_DEFAULT = {
  /** 每小时自然涌上来的牵挂（0~1 刻度） */
  risePerHour: 0.09,
  /** 久未联系（超过 missAfterMinutes）后，涌上来的速度翻倍 */
  missMultiplier: 2,
  /** 他找过她 / 她回过他之后，牵挂保留多少（0.25 = 掉到四分之一） */
  afterContactKeep: 0.25,
  /** 她主动找过他之后，牵挂保留多少 */
  afterOwnKeep: 0.05,
  max: 1,
};

export function resolveLonging(raw = {}) {
  return { ...LONGING_DEFAULT, ...(raw ?? {}) };
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export class LongingStore {
  constructor(raw = {}) {
    this.cfg = resolveLonging(raw);
    this.data = this.#load();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  }

  #save() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(this.data, null, 2), 'utf8');
  }

  get(userId) {
    const key = String(userId);
    const cur = this.data[key];
    if (!cur) {
      return { value: 0, updatedAt: null, lastContactAt: null, lastOwnAt: null };
    }
    return {
      value: clamp01(cur.value ?? 0),
      updatedAt: cur.updatedAt ?? null,
      lastContactAt: cur.lastContactAt ?? null,
      lastOwnAt: cur.lastOwnAt ?? null,
    };
  }

  #write(userId, patch) {
    const key = String(userId);
    this.data[key] = { ...this.get(userId), ...patch };
    this.#save();
    return this.data[key];
  }

  #ms(iso) {
    if (!iso) return null;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : null;
  }

  /**
   * 按真实流逝的时间推进牵挂。
   * @param {boolean} opts.asleep 睡觉时不累积（她没在想事情）
   * @param {number} opts.missAfterMinutes 超过这个时长算「久未联系」，加速累积
   */
  tick(userId, { now = Date.now(), asleep = false, missAfterMinutes = 360 } = {}) {
    const cur = this.get(userId);
    const last = this.#ms(cur.updatedAt);
    const sinceMs = last === null ? 0 : Math.max(0, now - last);
    const hours = sinceMs / 3600000;

    let value = clamp01(cur.value);
    if (!asleep && hours > 0) {
      const lastContact = this.#ms(cur.lastContactAt);
      const missMinutes = lastContact === null ? Infinity : (now - lastContact) / 60000;
      const mult = (lastContact === null || missMinutes >= missAfterMinutes) ? this.cfg.missMultiplier : 1;
      value = clamp01(value + hours * this.cfg.risePerHour * mult);
    }
    return this.#write(userId, { value, updatedAt: new Date(now).toISOString() });
  }

  /** 有过对话（他找她、或她回他）：牵挂回落大半 */
  markContact(userId, now = Date.now()) {
    const cur = this.get(userId);
    return this.#write(userId, {
      value: clamp01(cur.value * this.cfg.afterContactKeep),
      updatedAt: new Date(now).toISOString(),
      lastContactAt: new Date(now).toISOString(),
    });
  }

  /** 她主动找过他：牵挂基本清空（刚说完了） */
  markOwn(userId, now = Date.now()) {
    const cur = this.get(userId);
    return this.#write(userId, {
      value: clamp01(cur.value * this.cfg.afterOwnKeep),
      updatedAt: new Date(now).toISOString(),
      lastContactAt: new Date(now).toISOString(),
      lastOwnAt: new Date(now).toISOString(),
    });
  }

  /** 距上次「任何对话」多少分钟（没有则 null） */
  minutesSinceContact(userId, now = Date.now()) {
    const t = this.#ms(this.get(userId).lastContactAt);
    return t === null ? null : Math.max(0, (now - t) / 60000);
  }

  /** 距上次「她主动」多少分钟（没有则 null） */
  minutesSinceOwn(userId, now = Date.now()) {
    const t = this.#ms(this.get(userId).lastOwnAt);
    return t === null ? null : Math.max(0, (now - t) / 60000);
  }

  toJSON() {
    return this.data;
  }
}
