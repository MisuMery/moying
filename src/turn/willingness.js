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
    // 忙碌只压「回得快不快」，不该压掉一半的回复。0.55 时上班时段每两条就掉一条，
    // 连着三条都没回（2026-10-29 11:46~11:48 线上），他那边看到的就是"人没了"。
    // 忙的体感交给 busyDelayMs（两分多钟才回），回复本身保持高频。
    busyFactor: 0.85,
    minDelayMs: 8000,          // 最快也要 8 秒才回（看到消息 + 打字）
    maxDelayMs: 25000,         // 看到消息/打字的区间上限（原 45s 太长，隔 40 秒才冒一句像没看见）
    delayCurve: 2,             // >1 即偏向「很快就回」，1 为均匀的旧行为
    engagedWindowSeconds: 90,  // 她上一句说完 90 秒内算「还在聊」
    engagedFactor: 0.4,        // 还在聊时延迟再压一刀
    engagedMinProbability: 0.9,// 还在聊时几乎必回
    busyExtraMs: 25000,        // 忙的时候额外多等多久（原为硬编码 +60s：上班最短要 68 秒才回）
    busyDelayMs: 150000,       // 忙的时候的绝对上限
    nightDelayMs: 90000,
    // 收尾应答（嗯 / 嗯呐 / 好的 / 收到）＝话题已经结束，基本就该停在这里。
    // 0.12 时平均每八次还会冒出「嗯 / 在改图」这种多余的一句，把收掉的话题又续上。
    topicEndAckFactor: 0.02,
    topicEndClosingFactor: 0.5,  // 道别/收尾（晚安/拜拜/先这样）→ 一半概率回一句
  },
  quiet: { // 更冷淡：阈值高、扣分重
    threshold: 0.45, replyCost: 0.75, probabilityAmplifier: 1.8, nightFactor: 0.4, busyFactor: 0.7,
  },
  warm: { // 更热络：阈值低、扣分轻
    threshold: 0.15, replyCost: 0.3, probabilityAmplifier: 3.0, nightFactor: 0.8, busyFactor: 0.92,
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
/**
 * 判断他这句话是不是「话题已经收尾」，用于决定要不要回。
 * - 'ack'：纯应答（嗯 / 好的 / 收到 / 谢谢…）——话题基本结束，大多不用回
 * - 'closing'：道别/收尾（晚安 / 拜拜 / 先这样 / 我去忙…）——可回一句，也可不回
 * - null：还有内容 / 是问句 → 正常判断
 * 只做保守的规则判断，不花 LLM；问句一律不算收尾。
 */
/** 亲昵称呼/话语：这类话在亲近的人之间"没看见"可以，"看见了不理"不合理 */
const INTIMATE_RE = /宝贝|亲爱的|媳妇|老婆|老公|想你|爱你|抱抱|亲亲|摸摸头|小傻瓜|小笨蛋|丽儿/;

const ACK_CORE = new Set([
  '嗯', '哦', '喔', '好', '行', '可以', '明白', '懂', '知道了', '收到', '知道',
  'ok', 'okay', '谢谢', '谢', '辛苦', '没事',
]);

/** 语气词尾巴：嗯呐 / 好的呀 / 知道啦 / 行吧 → 归约到核心词 */
const FILLER_TAIL = /[呐呢啊呀哦噢喔哈啦了嘛咯呗哟嗷欸诶嘿嘻的哇嘞嗒]+$/;

function stripFiller(bare) {
  let core = bare;
  // 尾巴可能叠几层（"好嘞呀"），最多剥三层
  for (let i = 0; i < 3; i += 1) {
    const next = core.replace(FILLER_TAIL, '');
    if (next === core) break;
    core = next;
  }
  // 叠字归一：嗯嗯嗯 → 嗯
  return core.replace(/^(.)\1+$/, '$1');
}

export function detectTopicEnd(rawText) {
  const t = String(rawText ?? '').trim();
  if (!t) return null;
  if (/[？?]/.test(t)) return null; // 问句不算收尾
  const bare = t.replace(/[，,、。.!！~～…：:；;\s]+/g, ''); // 去掉标点/空格，便于命中"收到，谢谢"之类
  const ACK = [
    '嗯', '嗯嗯', '嗯呢', '哦', '哦哦', '喔', '好的', '好', '行', '收到', '知道了', '好嘞', '好滴',
    'ok', 'okay', '好吧', '那好', '行吧', '没事', '谢谢', '谢啦', '辛苦了', '晓得了',
    '收到谢谢', '好的谢谢', '嗯嗯好的', '好谢谢', '行谢谢',
  ];
  if (ACK.includes(bare) || ACK.includes(bare.toLowerCase())) return 'ack';
  // 精确表匹配不到的变体：剥掉语气词尾巴再看是不是纯应答。
  // 2026-10-29 15:41 线上：她刚说「忙完再说」，他回「嗯呐」，系统认不出来，
  // 两分钟后她又补了「嗯 / 在改图」，把已经收掉的话题重新续上。
  const core = stripFiller(bare).toLowerCase();
  if (core && [...bare].length <= 4 && ACK_CORE.has(core)) return 'ack';
  if ([...bare].length <= 16) {
    const CLOSE = [
      '晚安', '好梦', '拜拜', '再见', '886', '先这样', '先不聊', '不聊了', '不打扰', '你忙', '去忙', '忙去',
      '先睡', '睡了', '休息了', '早点睡', '溜了', '撤了', '下线', '我先去', '去吃饭', '去洗澡',
      '回头聊', '明天聊', '改天聊', '下次聊',
    ];
    if (CLOSE.some((k) => bare === k || bare.includes(k))) return 'closing';
  }
  return null;
}

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

  // 4) 概率
  let probability = Math.max(0, Math.min(1, (score - cfg.threshold) * (cfg.probabilityAmplifier ?? 2.5) * factor));
  // 问句/急事：即便在睡觉也留一线（真有事会醒）
  if (urgent && sleeping) probability = Math.max(probability, 0.25);
  if (/[？?]/.test(text) && !sleeping) probability = Math.max(probability, 0.8);

  // 「还在聊」：她上一句刚说完不久——手机还在手里、屏幕还亮着，
  // 对方秒回时她自然也回得快。但睡觉时不成立（她已经睡着，不会因为 90 秒前回过就醒着聊）。
  const sinceOwn = Number(input.secondsSinceOwnSay);
  const engaged = Number.isFinite(sinceOwn) && sinceOwn >= 0
    && sinceOwn < (cfg.engagedWindowSeconds ?? 90);
  if (engaged && !sleeping) probability = Math.max(probability, cfg.engagedMinProbability ?? 0.9);

  // 忙碌作为「最终折扣」：放在所有保底（问句 0.8 / 秒回 0.9）之后再做乘法。
  // 否则连续聊天把 score 顶满、或问句/秒回保底，会把 busyFactor 彻底冲垮，变成
  // 「上班再忙也每条必回」。乘在最后，忙碌才真正压得住（2026-10-27 线上反馈）。
  if (busy && !sleeping) {
    probability *= cfg.busyFactor ?? 0.55;
    if (reason === 'normal') reason = 'busy';
  }

  // 话题收尾：他只是回了个「嗯/好的/收到」，或道别「晚安/拜拜/先这样」——
  // 话题已经结束，没必要硬回（即使她闲、即使刚聊过、"还在聊"保底也要让位）。
  const topicEnd = detectTopicEnd(text);
  if (topicEnd === 'ack') {
    probability *= cfg.topicEndAckFactor ?? 0.02;
    // 原因要盖过 busy：日志里看到「topic_end」才知道她是因为收尾没回，
    // 而不是又被忙碌折扣吃掉一条
    if (!sleeping) reason = 'topic_end';
  } else if (topicEnd === 'closing') {
    probability *= cfg.topicEndClosingFactor ?? 0.5;
    if (!sleeping) reason = 'topic_closing';
  }

  // 亲密度：关系越近，"看到了却不回"越不像她。closeness 由当前关系阶段映射
  // （stranger=0 … attached=1）。以前这里只看累积条数和随机数——attached 阶段
  // 也可能把一条亲昵消息当骰子丢掉（2026-10-29 22:41："该睡觉了哦宝贝" p=0.875 抽空）。
  const close = Math.max(0, Math.min(1, Number(input.closeness ?? 0.5)));
  const intimate = INTIMATE_RE.test(text);

  // 普通消息：保底随亲密度升高。attached(1.0) → 0.98（2% 不回）；distant(0.25) → 0.88。
  if (!sleeping && !topicEnd) {
    probability = Math.max(probability, 0.85 + 0.13 * close);
  }
  // 带亲昵称呼的消息（宝贝/想你/抱抱…）：即便只是应答或道别，也几乎必回——
  // 这种话在亲近的人之间，"没看见"可以，"看见了不理"不合理。attached(1.0) → 0.999。
  if (!sleeping && intimate) {
    probability = Math.max(probability, 0.92 + 0.079 * close);
  }

  // 连续被忽略的补偿：真人不会连着几条都当没看见。
  // 忙可以让她慢、让她只回一个「嗯」，但不能整个人消失——前两条已经错过了，
  // 这一条就回（只有真睡着、或他只是在收尾时才让位）。
  const ignored = Number(input.consecutiveIgnored ?? 0);
  if (ignored >= 2 && !sleeping && !topicEnd) {
    probability = Math.max(probability, 0.95);
    if (reason === 'busy') reason = 'busy_catchup';
  }

  const shouldReply = random() < probability;

  // 5) 反应延迟：状态越不在线，隔越久。
  // 真人的节奏不是均匀分布——大多数时候很快就看到并回复，偶尔走神/忙才慢。
  // 均匀采样会让「等 40 秒」和「等 10 秒」一样常见，delayCurve 把分布压向快的一端
  // （1=均匀，2=偏快，3=很偏快）。
  const curve = Math.max(1, Number(cfg.delayCurve ?? 2));
  let delayMs = cfg.minDelayMs + Math.pow(random(), curve) * (cfg.maxDelayMs - cfg.minDelayMs);
  if (sleeping) delayMs = cfg.maxDelayMs;
  else if (busy) delayMs = Math.min(cfg.busyDelayMs, delayMs + (cfg.busyExtraMs ?? 25000));
  else if (night) delayMs = Math.min(cfg.nightDelayMs, delayMs + 30000);
  // 还在聊：按倍率再压一刀
  if (engaged) delayMs = Math.round(delayMs * (cfg.engagedFactor ?? 0.4));

  return {
    shouldReply,
    probability: Number(probability.toFixed(3)),
    reason,
    topicEnd,
    score: shouldReply ? Math.max(0, score - cfg.replyCost) : score,
    rawScore: score,
    delayMs: Math.round(delayMs),
    asleep: sleeping,
  };
}
