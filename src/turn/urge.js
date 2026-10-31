// 主动联系：她会不会在过自己日子的时候，突然想给他发一句。
//
// HDS 里这属于 Urge/Agency —— 与「回复意愿」是两件事：
//   回复意愿 = 他发了消息，她想不想回（turn/willingness.js）
//   主动动机 = 没人找她，她自己想不想找他（本文件）
// 两条路分开，才不会把「她主动找他」和「她敷衍回他」混成一个概率。
//
// 2026-10-28 重写：原先的判据是「距上次说话过了多久 + 冷却」，实测她几乎不主动
// （234 次自动推进只主动 16 次）——因为冷却被他发来的消息不断重置，他一聊她就永远
// 在冷却里。现在改由「牵挂度」(turn/longing.js) 驱动：
//   概率 = 阶段基准 × 牵挂度增益 × 时机因子
// 牵挂随时间自己涌上来，联系过后回落，于是「刚聊完不急着找，过几小时她自己想起来」。

import { localHour } from '../world/time.js';

// 动机文案决定「她主动讲什么」的取材范围。
// 教训（2026-10-25 线上观察）：原先 share/thought 都默认取材「此刻手上正在做的事」
// （「刚刚发生的一件小事」「看到什么」），而她晚上习惯躺着打游戏，
// 于是主动消息几乎全是游戏进度——她的生活明明还有做饭、工作、追剧、室友这些。
// 现在每种动机都点明素材可以来自：手上做的、今天做过的、接下来要做的、
// 刚想起的念头、身体上的感受——并提醒换一换，别连着讲同一件事。
// 2026-10-29：hook / recall 只在「本轮真的把他说过的原话摆出来了」时才允许抽中。
// 线上事故：这两个动机要求她引用「他之前说过的某句话」，但触发时根本没给她任何原话，
// 模型只能现编——于是有了「上周说的」这种不存在的约定。没有素材就不抽这两个动机。
export const URGE_MOTIVES = {
  share: '想把自己这边的一件小事说给他听——可以是手上正在做的，也可以是今天做过的、接下来要做的，别总是同一件事',
  hook: '想起他之前说过的某一句具体的话（只能用下面列出来的原话，不许编），拿它把他拉回来（不追问结果）',
  care: '到了某个点，想叮嘱他一句（早点睡、记得吃饭）',
  mood: '自己这边有点低落，想找他说一句，但不打算说破',
  thought: '生活里碰到点什么就想到他了，想顺口提一句（按她自己的兴趣和生活来，别跟上次撞同一件事）',
  plan: '想到接下来要做的一件事，顺口说给他听（明天的安排、想去的地方、想吃的某样东西）',
  recall: '想起之前和他聊过的某个片段（只能是下面列出来的原话），想顺着那句话再说一句',
  miss: '就是有点想他了，没什么具体的事，也想发一句（可以很碎：在干嘛、睡没睡、看到什么想到他）',
};

const STAGE_BASE = {
  stranger: 0.04,
  distant: 0.2,
  familiar: 0.4,
  trusting: 0.58,
  attached: 0.72,
};

export const URGE_DEFAULT = {
  enabled: true,
  // 她主动找过他之后，隔多久才会再想主动找（分钟）。
  // 注意：这是「她自己主动」的冷却，**不是**「任何对话」的冷却——
  // 旧版把两者混为一谈，导致他一发消息就把她的主动性锁死。
  cooldownMinutes: 60,
  // 刚有过对话（不论谁先）的短时间内不再主动冒出来（她刚说完话，不会立刻又找他）
  minContactGapMinutes: 8,
  // 多久没联系算「久未联系」（分钟）：牵挂会加速涌上来，并额外加成
  missAfterMinutes: 240,
  // 牵挂为 0 时仍保留的最低意愿比例（她不是机器人，想不想找他不完全由牵挂决定）
  longingFloor: 0.35,
  busyFactor: 0.5,
  quietHoursFactor: 0.3,
  relaxBonus: 0.15,
  newsBonus: 0.18,
  missBonus: 0.15,
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
 * @param {boolean} opts.asleep        是不是在睡觉
 * @param {boolean} opts.busy         是不是在忙（上班/通勤）
 * @param {number}  opts.longing      牵挂度 0~1（见 turn/longing.js）
 * @param {number}  opts.minutesSinceContact 距上次任何对话多少分钟（null=从没有过）
 * @param {number}  opts.minutesSinceOwn     距上次她主动多少分钟（null=从没主动过）
 * @param {string}  opts.stageId      当前感情阶段
 * @param {boolean} opts.hasNews      这一轮她这边有没有新发生的事可以讲
 * @param {number}  opts.hour         当前钟点
 * @param {Function} opts.rand        随机源
 */
export function evaluateUrge(opts = {}) {
  const cfg = resolveUrge(opts.cfg);
  const rand = opts.rand ?? Math.random;
  const asleep = Boolean(opts.asleep);
  const busy = Boolean(opts.busy);
  const hour = opts.hour ?? localHour(Date.now());
  const stageId = String(opts.stageId ?? 'distant');
  const longing = Math.min(1, Math.max(0, Number(opts.longing) || 0));
  const sinceContact = numOrNull(opts.minutesSinceContact);
  const sinceOwn = numOrNull(opts.minutesSinceOwn);
  // 「他说过的原话」清单：hook / recall 这两个动机的唯一合法素材来源。
  // 清单空着（他从来没留下什么、或已经太久远）就不许抽中它们，否则她只能编。
  const hasHisWords = Array.isArray(opts.hisWords) ? opts.hisWords.length > 0 : Boolean(opts.hasHisWords);

  if (!cfg.enabled) return { want: false, probability: 0, motive: null, text: '', reason: '主动联系已关闭', longing };
  if (asleep) return { want: false, probability: 0, motive: null, text: '', reason: '睡着了', longing };

  // 她刚主动找过：还在冷却里（这条只拦「她自己主动」，不拦他发消息）
  if (sinceOwn !== null && sinceOwn < cfg.cooldownMinutes) {
    return {
      want: false, probability: 0, motive: null, text: '', longing,
      reason: `刚主动找过他（${Math.round(sinceOwn)} 分钟前），还在冷却里`,
    };
  }
  // 刚刚还在对话：她刚说完话，不急着再冒一句
  if (sinceContact !== null && sinceContact < cfg.minContactGapMinutes) {
    return {
      want: false, probability: 0, motive: null, text: '', longing,
      reason: `刚刚还在聊（${Math.round(sinceContact)} 分钟前）`,
    };
  }

  let p = STAGE_BASE[stageId] ?? STAGE_BASE.distant;
  const parts = [`阶段 ${stageId} 基准 ${p.toFixed(2)}`];

  // 牵挂度调制：完全不想他时也有底噪，牵挂满时接近满值
  const gain = cfg.longingFloor + (1 - cfg.longingFloor) * longing;
  p *= gain;
  parts.push(`牵挂 ${longing.toFixed(2)} ×${gain.toFixed(2)}`);

  if (busy) { p *= cfg.busyFactor; parts.push(`在忙 ×${cfg.busyFactor}`); }
  if (hour >= 1 && hour < 7) { p *= cfg.quietHoursFactor; parts.push(`凌晨 ×${cfg.quietHoursFactor}`); }
  if (isRelaxHour(hour)) { p += cfg.relaxBonus; parts.push(`放松时段 +${cfg.relaxBonus}`); }
  if (opts.hasNews) { p += cfg.newsBonus; parts.push(`有新鲜事 +${cfg.newsBonus}`); }
  if (sinceContact === null || sinceContact >= cfg.missAfterMinutes) {
    p += cfg.missBonus; parts.push(`许久没联系 +${cfg.missBonus}`);
  }

  p = Math.max(0, Math.min(0.95, p));
  const want = rand() < p;
  const motive = want
    ? pickMotive({ hour, hasNews: Boolean(opts.hasNews), sinceContact, longing, hasHisWords, rand })
    : null;

  return {
    want,
    probability: Number(p.toFixed(3)),
    motive,
    text: motive ? URGE_MOTIVES[motive] : '',
    reason: parts.join('，'),
    longing: Number(longing.toFixed(3)),
    cooldownMinutes: cfg.cooldownMinutes,
    hasHisWords,
  };
}

function numOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickMotive({ hour, hasNews, sinceContact, longing, hasHisWords, rand }) {
  const pool = [];
  if (hasNews) pool.push('share', 'thought');
  if (hour >= 21 || hour < 1) pool.push('care');
  // 只有手里真的有他说过的原话，才允许「引用他说过的话」这类动机
  if ((sinceContact === null || sinceContact >= 360) && hasHisWords) pool.push('hook', 'mood');
  // 牵挂越高，越可能是「没什么事就是想他了」——这种最像真人，不一定要有由头
  if (longing >= 0.6) pool.push('miss', 'miss');
  // 取材于「她整个生活」的动机始终在池子里，避免话题只剩眼下正在做的事
  pool.push('share', 'thought', 'plan');
  if (hasHisWords) pool.push('recall');
  return pool[Math.floor(rand() * pool.length)] ?? 'thought';
}
