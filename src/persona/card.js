// 角色卡：结构化加载与提示词渲染。
//
// HDS 把整份 setting 当成一整块文本前插，模型要么全看要么看不到，
// 而且「对当前用户的印象」这种最该高权重的内容被挤到了后面。这里拆成：
//   恒定注入（永不裁剪）：身份、说话规则、红线
//   按需检索：traits 按与当前上下文的相关性取前 k 条

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, loadConfig } from '../config.js';
import { ActorRegistry, createFictional, createSelf } from '../cast/actors.js';
import { resolveRelationStage, effectiveRedlines } from './relationship.js';

export const PERSONA_PATH = path.join(DATA_DIR, 'persona.json');
// 开源友好：角色本体、配角、用户三者分开存放，方便别人替换其中任意一块
export const CHARACTER_PATH = path.join(DATA_DIR, 'character.json');
export const CAST_PATH = path.join(DATA_DIR, 'cast.json');
export const USER_PATH = path.join(DATA_DIR, 'user.json');

function readJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(file, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

/** 角色本体（身份 / 性格 / 说话方式 / 红线） */
export function loadCharacter() {
  return readJSON(CHARACTER_PATH) ?? readJSON(PERSONA_PATH);
}

export function saveCharacter(value) {
  writeJSON(CHARACTER_PATH, value);
  invalidatePersona();
  return value;
}

/** 其他角色卡（参考 HDS 单独维护，和主角设定解耦） */
export function loadCast() {
  const raw = readJSON(CAST_PATH);
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.cast)) return raw.cast;
  return readJSON(PERSONA_PATH)?.cast ?? [];
}

export function saveCast(value) {
  writeJSON(CAST_PATH, { cast: Array.isArray(value) ? value : (value?.cast ?? []) });
  invalidatePersona();
  return loadCast();
}

/** 用户是谁 + 初始关系 */
export function loadUser() {
  return readJSON(USER_PATH, {}) ?? {};
}

export function saveUser(value) {
  writeJSON(USER_PATH, value);
  return value;
}

let cached = null;

/** 合并视图：把三块拼成运行时用的 persona（兼容既有调用方） */
export function loadPersona() {
  if (cached) return cached;
  const character = loadCharacter();
  if (!character) return null;
  cached = { ...character, cast: loadCast() };
  return cached;
}

export function invalidatePersona() {
  cached = null;
}

export function savePersona(patch) {
  // 写回角色本体；cast 单独走 saveCast
  const current = loadCharacter() ?? {};
  const next = { ...current, ...patch };
  if (Array.isArray(patch?.cast)) {
    saveCast(patch.cast);
    delete next.cast;
  }
  writeJSON(CHARACTER_PATH, next);
  invalidatePersona();
  return next;
}

/** 用当前上下文的关键词给 traits 打分，取最相关的 k 条 */
export function retrieveTraits(persona, contextText = '', k = 6) {
  const traits = persona?.traits ?? [];
  if (!contextText) return traits.slice(0, k);
  const scored = traits.map((t) => {
    const text = `${t.key ?? ''} ${t.text ?? ''}`;
    // 极简相关性：上下文里出现的双字词命中数
    let score = t.weight ?? 1;
    for (const gram of bigrams(contextText)) {
      if (text.includes(gram)) score += 1;
    }
    return { t, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((s) => s.t);
}

function bigrams(text) {
  const s = String(text ?? '').replace(/\s+/g, '');
  const out = [];
  for (let i = 0; i + 2 <= s.length && out.length < 200; i += 1) out.push(s.slice(i, i + 2));
  return out;
}

/** 恒定注入的身份块（永不裁剪） */
export function renderIdentity(persona) {
  const id = persona?.identity ?? {};
  return [
    `你是 ${id.name ?? ''}，${id.age ?? ''}岁，${id.job ?? ''}，${id.city ?? ''}。`,
    (id.appearance ?? []).length ? `外貌气质：${id.appearance.join('；')}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * 按亲密度选说话阶段：关系越近话才越多。
 * 当前（亲密度低）走「疏离期」，严格对齐 HDS 最近实测的习惯（平均 3.7 字、一轮 1.7 条）。
 */
/**
 * 当前说话档位：取自关系配置（字数/条数随亲疏变化），不再写在角色卡里。
 * 返回 { id, name, desc, maxChars, hardMaxChars, maxBubbles, maxTotalChars, ... }
 */
export function resolveStage(persona, impression) {
  const stage = resolveRelationStage(impression);
  if (!stage) return null;
  return { ...stage, ...(stage.speech ?? {}) };
}

/** 说话规则块（恒定注入，句号规则在这里以「规则」形式出现，但真正执行靠 style/enforceStyle） */
/** 口头禅的关系分层：越往后越亲密，只有到了那份上才解锁 */
export const CATCHPHRASE_TIERS = [
  { id: 'any', label: '任何关系' },
  { id: 'warm', label: '熟了以后' },
  { id: 'intimate', label: '很亲近才用' },
];

const BUCKET_LABEL = {
  agree: '承接/认同', hesitate: '迟疑/缓冲', yield: '认输/收尾', ask: '反问/接话',
  rebut: '温和反驳', cheer: '鼓励/兜底', laugh: '笑', open: '开启话题',
  guilty: '理亏/被拆穿', happy: '开心',
};

/** 当前这个阶段解锁了哪几层口头禅 */
export function catchphraseTiersFor(stage) {
  const t = stage?.catchphraseTiers;
  return Array.isArray(t) && t.length ? t : ['any'];
}

/**
 * 口头禅按关系分层渲染：解锁的可用，没解锁的明确列为「现在还不会用」。
 * 这样「嘿嘿~」「哎呀」这类亲密档的话不会被拿去对不熟的人说。
 */
export function renderCatchphrases(persona, stage = null) {
  const raw = persona?.speech?.catchphrases ?? {};
  // 兼容旧结构（不分层）：整包当作 any
  const grouped = CATCHPHRASE_TIERS.some((t) => raw[t.id] && typeof raw[t.id] === 'object')
    ? raw
    : { any: raw };
  const allowed = new Set(catchphraseTiersFor(stage));
  const usable = [];
  const locked = [];
  for (const tier of CATCHPHRASE_TIERS) {
    const bucket = grouped[tier.id];
    if (!bucket || typeof bucket !== 'object') continue;
    const entries = Object.entries(bucket).filter(([, v]) => Array.isArray(v) && v.length);
    if (!entries.length) continue;
    if (allowed.has(tier.id)) {
      for (const [k, v] of entries) {
        usable.push(`- ${tier.label}·${BUCKET_LABEL[k] ?? k}：${v.join('、')}`);
      }
    } else {
      const all = entries.flatMap(([, v]) => v);
      locked.push(`- [${tier.label}] 现在还不到这份上，不要用：${all.join('、')}`);
    }
  }
  const lines = [];
  if (usable.length) lines.push('', '口头禅（分场景选用）：', ...usable);
  if (locked.length) lines.push('', '还不到份上的话（现在说了就不像她）：', ...locked);
  if (persona?.speech?.catchphraseNote) lines.push('', `- ${persona.speech.catchphraseNote}`);
  return lines;
}

export function renderSpeechRules(persona, stage = null, hour = null) {
  const s = persona?.speech ?? {};
  const cp = s.catchphrases ?? {};
  // 按时段选语气：夜里话匣子打开，上班时段敷衍
  let timeTone = '';
  if (hour !== null && hour !== undefined) {
    const h = Number(hour);
    if (h >= 22 || h < 6) timeTone = s.nightTone ?? '';
    else if (h >= 9 && h < 18) timeTone = s.daytimeTone ?? '';
  }
  const maxChars = stage?.maxChars ?? s.maxChars ?? 15;
  const hardMaxChars = stage?.hardMaxChars ?? s.hardMaxChars ?? 40;
  const maxBubbles = stage?.maxBubbles ?? s.maxBubbles ?? 3;
  const lines = [
    '说话的前提：你正拿着手机随手打字回一句，不是在写东西。',
    '',
    stage ? `<当前说话阶段：${stage.name}（${stage.when}）>` : '',
    stage?.note ? stage.note : '',
    stage ? '</当前说话阶段>' : '',
    '',
    '说话规则：',
    `- 句式短：常态单条 1~${maxChars} 字，上限 ${hardMaxChars} 字，不得超过 ${s.maxLines ?? 3} 行`,
    `- 一次最多发 ${maxBubbles} 条${stage?.maxTotalChars ? `，整轮加起来不超过 ${stage.maxTotalChars} 字` : ''}；想到哪说到哪，打到一半就发出去`,
    '- 句尾一律不加句号（这是即时通讯口语习惯，不是书面语）',
    `- 可用结尾：${(s.allowedTerminal ?? []).map((x) => (x === '' ? '什么都不加' : x)).join('、')}`,
    s.typoRepair ? `- 打错字会补一句「${s.typoRepair}」` : '',
  ];
  // 口头禅：按关系分层，未解锁的明确列为不可用
  lines.push(...renderCatchphrases(persona, stage));

  // 方言
  if (s.dialect?.words?.length) {
    lines.push('', `- 方言（${s.dialect.density ?? '偶尔'}）：${s.dialect.words.join('、')}`);
  }
  // 称呼
  if (s.address) {
    const a = s.address;
    const parts = [];
    if (a.toUser?.length) parts.push(`称呼对方只用「${a.toUser.join('')}」`);
    if (a.joking?.length) parts.push(`玩笑时可叫「${a.joking.join('」「')}」`);
    if (a.selfJoking?.length) parts.push(`玩梗时自称「${a.selfJoking.join('」「')}」`);
    if (a.forbidden?.length) parts.push(`禁用称呼：${a.forbidden.join('、')}`);
    if (parts.length) lines.push('', `- ${parts.join('；')}`);
  }
  // 表情
  if (s.emoji?.note) lines.push('', `- 表情：${s.emoji.note}`);
  // 当代口语白名单
  if (s.modernSlang?.whitelist?.length) {
    lines.push('', `- 当代口语白名单（白名单外一律不用）：${s.modernSlang.whitelist.join('、')}`);
  }
  // 语气强弱
  if (s.toneStrength) lines.push('', `- 语气：${s.toneStrength}`);
  if (timeTone) lines.push('', `- 此时此刻的语气：${timeTone}`);
  return lines.filter(Boolean).join('\n');
}

/** 叙事风格块（对应 HDS 的 setting.style + model.stylePrompt，自定义后可即时生效） */
/** 叙事风格：散文要写成什么样（写 narration 时必须遵守，篇幅会被程序校验） */
export function renderNarrative(persona) {
  const n = persona?.narrative;
  if (!n) return '';
  const len = n.length ?? {};
  const lines = ['<叙事风格（写 narration 时必须遵守）>'];
  if (n.genre) lines.push(`故事风格：${n.genre}`);
  if (n.viewpoint) lines.push(`视角：${n.viewpoint}`);
  if (len.min || len.max) {
    lines.push(`篇幅：每段 ${len.min ?? 400}~${len.max ?? 800} 字，可以多段${len.note ? `（${len.note}）` : ''}`);
  }
  if (Array.isArray(n.craft) && n.craft.length) {
    lines.push('写法：', ...n.craft.map((x) => `- ${x}`));
  }
  if (n.withMessage) lines.push(`涉及消息时：${n.withMessage}`);
  if (Array.isArray(n.avoid) && n.avoid.length) {
    lines.push('禁止：', ...n.avoid.map((x) => `- ${x}`));
  }
  lines.push('</叙事风格>');
  return lines.join('\n');
}

/** 叙事篇幅要求（程序据此校验，不够就打回重写） */
export function narrativeLength(persona) {
  const len = persona?.narrative?.length ?? {};
  return { min: Number(len.min) || 400, max: Number(len.max) || 900 };
}

/**
 * 上班日程：哪几天上班、几点到几点。
 * 休息日在家刷手机不算「忙」——之前一律按 9:00~18:00 算忙，
 * 于是周末她明明在家，也会被 busy 因子压低回复概率。
 */
export function workSchedule(persona) {
  const sc = persona?.rhythm?.schedule ?? {};
  const days = Array.isArray(sc.workdays) && sc.workdays.length ? sc.workdays : [1, 2, 3, 4, 5];
  const parse = (v, dflt) => {
    const m = String(v ?? '').match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
    return m ? Number(m[1]) + Number(m[2]) / 60 : dflt;
  };
  return {
    workdays: days.map(Number),
    from: parse(sc.workFrom, 9.5),
    to: parse(sc.workTo, 18.5),
    commuteMinutes: Number(sc.commuteMinutes) || 0,
    note: sc.note ?? '',
  };
}

/** 带小数的钟点（13:30 → 13.5），时区跟着配置走 */
export function hourFloat(now = Date.now(), tz = null) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz ?? (loadConfig()?.story?.timezone ?? 'Asia/Shanghai'),
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(now));
  const get = (t) => Number(parts.find((x) => x.type === t)?.value ?? 0);
  return get('hour') + get('minute') / 60;
}


/** 接住说话的方式（V3 里最核心的对话对齐项，恒定注入） */
export function renderResponsePatterns(persona) {
  const list = persona?.speech?.responsePatterns ?? [];
  if (!list.length) return '';
  return ['接住说话的方式（按出现频率排列，优先选上面的，不要每次都「正常作答」）：',
    ...list.map((x, i) => `${i + 1}）${x}`)].join('\n');
}

/** 拿不准时的模糊回应规则（优先级从高到低） */
export function renderVagueness(persona) {
  const list = persona?.speech?.vagueness ?? [];
  if (!list.length) return '';
  return ['遇到不了解、拿不准的信息时（按优先级从高到低，绝不允许为了答上来而硬编）：',
    ...list.map((x, i) => `${i + 1}. ${x}`)].join('\n');
}

/** 关系锚点已迁到 relationship.json（在「用户与关系」里改），此处不再从角色卡读 */
export function renderRelationshipAnchor() {
  return '';
}

/** 知识边界 */
export function renderKnowledgeBoundary(persona) {
  return persona?.knowledgeBoundary ? `<知识边界>\n${persona.knowledgeBoundary}\n</知识边界>` : '';
}

/**
 * 红线（恒定注入）。传了 stage 就用「当前阶段生效版」：
 * 角色卡红线减去本阶段解除的，再加上本阶段新增的。
 */
export function renderRedlines(persona, stage = null) {
  const lines = stage ? effectiveRedlines(persona, stage) : (persona?.redlines ?? []);
  if (!lines.length) return '';
  return `红线（当前阶段下不得违反）：\n${lines.map((x) => `- ${x}`).join('\n')}`;
}

/** 配角块：明确列出哪些是故事内人物，以及他们不可能收到消息 */
export function renderCast(persona) {
  const cast = persona?.cast ?? [];
  if (!cast.length) return '';
  return [
    '故事内人物（他们只活在叙事里，你发给他们的任何话都只会写进剧本，不会真的发出去）：',
    ...cast.map((c) => `- ${c.displayName}（${c.relation}）：${String(c.notes ?? '').slice(0, 120)}`),
  ].join('\n');
}

/** 由角色卡构建 Actor 注册表（虚构角色 + 主角本人） */
export function buildRegistry(persona, { selfId = '' } = {}) {
  const reg = new ActorRegistry();
  reg.register(createSelf({ userId: selfId, displayName: persona?.identity?.name ?? '' }));
  for (const c of persona?.cast ?? []) {
    reg.register(createFictional({
      id: c.id,
      displayName: c.displayName,
      relation: c.relation,
      notes: c.notes,
      presence: c.presence ?? null,
    }));
  }
  return reg;
}
