// 主动联系：她会不会在过自己日子的时候，突然想给他发一句。
//
// HDS 里这属于 Urge/Agency —— 与「回复意愿」是两件事：
//   回复意愿 = 他发了消息，她想不想回（turn/willingness.js）
//   主动动机 = 没人找她，她自己想不想找他（本文件）
// 两条路分开，才不会把「她主动找他」和「她敷衍回他」混成一个概率。

import { localHour } from '../world/time.js';

export const URGE_MOTIVES = {
  share: '想把刚刚发生在自己这边的一件小事说给他听',
  hook: '想起他之前说过的一句话，想拿这个把他拉回来（不追问结果）',
  care: '到了某个点，想叮嘱他一句（早点睡、记得吃饭）',
  mood: '自己这边有点低落，想找他说一句，但不打算说破',
  thought: '看到什么就想到他了，想顺口提一句',
};

const STAGE_BASE = {
  stranger: 0.05,
  distant: 0.22,
  familiar: 0.42,
  trusting: 0.6,
  attached: 0.75,
};

export const URGE_DEFAULT = {
  enabled: true,
  // 主动找过他之后，隔多久才会再想找他（分钟）
  cooldownMinutes: 45,
  // 多久没联系会开始想他（分钟）
  missAfterMinutes: 360,
  busyFactor: 0.45,
  quietHoursFactor: 0.3,
  relaxBonus: 0.15,
  newsBonus: 0.15,
  missBonus: 0.2,
};

export function resolveUrge(raw = {}) {
  const out = { ...URGE_DEFAULT };
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/** 当前钟点是否属于「放松时段」（晚上十点后到凌晨一点前） */
export function isRelaxHour(hour) {
  const h = Number(hour);
  return h >= 22 || h < 1;
}

/**
 * 判定这一刻她有没有主动联系他的念头。
 * @param {object} opts
 * @param {boolean} opts.asleep      是不是在睡觉
 * @param {boolean} opts.busy        是不是在忙（上班/通勤）
 * @param {number}  opts.minutesSince 距上次和他说话过了多少分钟（null=从没说过）
 * @param {string}  opts.stageId     当前感情阶段
 * @param {boolean} opts.hasNews     这一轮她这边有没有新发生的事可以讲
 * @param {number}  opts.hour        当前钟点
 * @param {Function} opts.rand       随机源
 */
export function evaluateUrge(opts = {}) {
  const cfg = resolveUrge(opts.cfg);
  const rand = opts.rand ?? Math.random;
  const asleep = Boolean(opts.asleep);
  const busy = Boolean(opts.busy);
  const hour = opts.hour ?? localHour(Date.now());
  const stageId = String(opts.stageId ?? 'distant');
  const since = opts.minutesSince === null || opts.minutesSince === undefined
    ? null : Number(opts.minutesSince);

  if (!cfg.enabled) return { want: false, probability: 0, motive: null, text: '', reason: '主动联系已关闭' };
  if (asleep) return { want: false, probability: 0, motive: null, text: '', reason: '睡着了' };

  // 刚说过话：还不到再主动找他的时候
  if (since !== null && since < cfg.cooldownMinutes) {
    return {
      want: false, probability: 0, motive: null, text: '',
      reason: `刚说过话（${Math.round(since)} 分钟前），还在冷却里`,
    };
  }

  let p = STAGE_BASE[stageId] ?? STAGE_BASE.distant;
  const parts = [`关系阶段 ${stageId} 基准 ${p.toFixed(2)}`];

  if (busy) { p *= cfg.busyFactor; parts.push(`在忙 ×${cfg.busyFactor}`); }
  if (hour >= 1 && hour < 7) { p *= cfg.quietHoursFactor; parts.push(`凌晨 ×${cfg.quietHoursFactor}`); }
  if (isRelaxHour(hour)) { p += cfg.relaxBonus; parts.push(`放松时段 +${cfg.relaxBonus}`); }
  if (opts.hasNews) { p += cfg.newsBonus; parts.push(`有新鲜事 +${cfg.newsBonus}`); }
  if (since === null || since >= cfg.missAfterMinutes) {
    p += cfg.missBonus; parts.push(`许久没联系 +${cfg.missBonus}`);
  }

  p = Math.max(0, Math.min(0.95, p));
  const want = rand() < p;
  const motive = want ? pickMotive({ hour, hasNews: Boolean(opts.hasNews), since, rand }) : null;

  return {
    want,
    probability: Number(p.toFixed(3)),
    motive,
    text: motive ? URGE_MOTIVES[motive] : '',
    reason: parts.join('，'),
    cooldownMinutes: cfg.cooldownMinutes,
  };
}

function pickMotive({ hour, hasNews, since, rand }) {
  const pool = [];
  if (hasNews) pool.push('share', 'share', 'thought');
  if (hour >= 21 || hour < 1) pool.push('care', 'care');
  if (since === null || since >= 360) pool.push('hook', 'mood');
  pool.push('thought', 'share');
  return pool[Math.floor(rand() * pool.length)] ?? 'thought';
}
