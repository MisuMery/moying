// 回复意愿门控：不是每一条消息都要回。
//
// 参考 HDS 的 group-willingness：本地分数 + 半衰期衰减 + 阈值概率 + 回复成本扣分，
// 再叠加她的作息状态（睡觉/深夜/忙碌）做调制。区别在于这是私聊：
// 正常状态下大概率回（不回会很奇怪），真正要避免的是「你连发三条，她回三次」——
// 那个由 turn/inbox 的合并缓冲解决，这里负责「想不想回」和「多久之后回」。

export const WILLINGNESS_PRESETS = {
  normal: {
    enabled: true,
    baseGain: 0.6,             // 每条消息累积的意愿
    threshold: 0.25,           // 低于阈值不考虑回复
    probabilityAmplifier: 2.5, // 超出阈值后换算成概率的放大系数
    replyCost: 0.5,            // 回复一次扣多少（让连续回复变难）
    decayHalfLifeSeconds: 240, // 意愿半衰期
    maxScore: 2,
    questionGain: 0.25,        // 问句加分（别人问了不回很奇怪）
    keywordGain: 0.3,          // 急事/点名关键词加分
    urgentKeywords: ['在吗', '在么', '急', '有事', '快点', '怎么了', '出了', '重要'],
    sleepHours: [1, 7],        // 凌晨 1–7 点在睡
    nightHours: [23, 1],       // 23 点–次日 1 点犯困
    sleepFactor: 0.05,         // 睡觉时几乎不回
    nightFactor: 0.6,          // 深夜意愿打折
    busyFactor: 0.55,          // 忙碌时打折
    minDelayMs: 8000,          // 最快也要 8 秒才回（看到消息 + 打字）
    maxDelayMs: 45000,
    busyDelayMs: 150000,       // 忙的时候两分多钟才回
    nightDelayMs: 90000,
  },
  quiet: { // 更冷淡：阈值高、扣分重
    threshold: 0.45, replyCost: 0.75, probabilityAmplifier: 1.8, nightFactor: 0.4, busyFactor: 0.4,
  },
  warm: { // 更热络：阈值低、扣分轻
    threshold: 0.15, replyCost: 0.3, probabilityAmplifier: 3.0, nightFactor: 0.8, busyFactor: 0.75,
  },
};

export function resolveWillingness(raw = {}, preset = 'normal') {
  const base = { ...WILLINGNESS_PRESETS.normal, ...(WILLINGNESS_PRESETS[preset] ?? {}) };
  // 配置里留空（null/undefined）的项表示「用 preset 的值」，不要拿 null 去覆盖
  const patch = Object.fromEntries(
    Object.entries(raw ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== ''),
  );
  return { ...base, ...patch };
}

function inHourRange(hour, [from, to]) {
  return from <= to ? (hour >= from && hour < to) : (hour >= from || hour < to);
}

/**
 * @param {{score?:number, updatedAt?:number}} state 上一轮留下的意愿状态
 * @param {{now:number, text:string, hour:number, busy?:boolean, place?:string}} input
 * @param {object} config
 * @param {() => number} random
 */
export function evaluateWillingness(state = {}, input, config, random = Math.random) {
  const cfg = config;
  const now = input.now;
  if (!cfg.enabled) {
    return { shouldReply: true, probability: 1, reason: 'disabled', score: cfg.maxScore, delayMs: cfg.minDelayMs };
  }

  // 1) 衰减：隔得越久，之前累积的意愿越少
  let score = Number(state.score ?? 0);
  const last = Number(state.updatedAt ?? now);
  const elapsed = Math.max(0, (now - last) / 1000);
  if (Number.isFinite(score) && elapsed > 0) {
    score *= Math.pow(0.5, elapsed / (cfg.decayHalfLifeSeconds || 240));
  }

  // 2) 加分
  const text = String(input.text ?? '');
  let gain = cfg.baseGain;
  if (/[？?]/.test(text)) gain += cfg.questionGain ?? 0;
  const urgent = (cfg.urgentKeywords ?? []).some((k) => text.includes(k));
  if (urgent) gain += cfg.keywordGain ?? 0;
  score = Math.min(cfg.maxScore, score + gain);

  // 3) 状态因子
  const hour = input.hour;
  const sleeping = inHourRange(hour, cfg.sleepHours ?? [1, 7]);
  const night = !sleeping && inHourRange(hour, cfg.nightHours ?? [23, 1]);
  const busy = Boolean(input.busy);

  let factor = 1;
  let reason = 'normal';
  if (sleeping) { factor = cfg.sleepFactor ?? 0.05; reason = 'asleep'; }
  else if (night) { factor = cfg.nightFactor ?? 0.6; reason = 'night'; }
  if (busy && !sleeping) { factor *= cfg.busyFactor ?? 0.55; reason = busy ? (reason === 'normal' ? 'busy' : reason) : reason; }

  // 4) 概率
  let probability = Math.max(0, Math.min(1, (score - cfg.threshold) * (cfg.probabilityAmplifier ?? 2.5) * factor));
  // 问句/急事：即便在睡觉也留一线（真有事会醒）
  if (urgent && sleeping) probability = Math.max(probability, 0.25);
  if (/[？?]/.test(text) && !sleeping) probability = Math.max(probability, 0.8);

  const shouldReply = random() < probability;

  // 5) 反应延迟：状态越不在线，隔越久
  let delayMs = cfg.minDelayMs + Math.random() * (cfg.maxDelayMs - cfg.minDelayMs);
  if (sleeping) delayMs = cfg.maxDelayMs;
  else if (busy) delayMs = Math.min(cfg.busyDelayMs, delayMs + 60000);
  else if (night) delayMs = Math.min(cfg.nightDelayMs, delayMs + 30000);

  return {
    shouldReply,
    probability: Number(probability.toFixed(3)),
    reason,
    score: shouldReply ? Math.max(0, score - cfg.replyCost) : score,
    rawScore: score,
    delayMs: Math.round(delayMs),
    asleep: sleeping,
  };
}
