// 话语归属：一条 say 事件到底是「谁对谁说」。
//
// 2026-10-29 审计（用户反馈「A 的事被套到 B 身上」）：
// 821 条 say 事件里，actors 同时被当成三种东西用——
//   ('self',)            335 条：有时是自言自语，有时是她说了话但对象没标
//   ('self','c:linxia')   28 条：既有「她对林夏说」，也有「林夏对她说」
//   ('c:linxia','self')        同上一回事，顺序还不固定
// 读取端（每日记忆 / 会话上下文 / 重复检测）只能猜，于是
// 「林夏问她怎么回来了」被记成「她说了：林夏问她怎么回来了」，
// 进到对话上下文里就成了她的经历，再往外一引就成了「我们说好的」。
//
// 现在把 speaker / to 变成显式字段；存量事件按文本与 actors 推断，
// 新事件由世界阶段直接给出。

/** 从一句话的开头判断是谁在说（文本以角色名起手 = 那个角色在说/做） */
import { cut } from '../text-safe.js';
function startsWithName(text, name) {
  if (!name) return false;
  return text.startsWith(name);
}

function nameOfActor(id, nameOf) {
  if (id === 'self') return '她';
  if (String(id).startsWith('u:')) return '他';
  return nameOf ? nameOf(id) : id;
}

/**
 * 解析话语归属。
 * @returns {{speaker:string, to:string|null, inferred:boolean}}
 *   speaker: 'self' | 'c:xxx' | 'u:xxx'
 *   to:      收件人 id、'self'、或 null（没说给谁/自言自语）
 */
export function resolveSpeech(e, { nameOf = (id) => id } = {}) {
  const explicitSpeaker = e?.speaker ? String(e.speaker) : null;
  const explicitTo = e?.to ? String(e.to) : null;
  if (explicitSpeaker) {
    return { speaker: explicitSpeaker, to: explicitTo, inferred: false };
  }

  const actors = Array.isArray(e?.actors) ? e.actors.map(String) : [];
  const text = String(e?.summary ?? e?.prose ?? '').trim();
  const others = actors.filter((a) => a !== 'self');
  const user = others.find((a) => a.startsWith('u:'));
  const cast = others.filter((a) => a.startsWith('c:'));

  // 她和他（真实用户）对话：唯一确定的一种
  if (user) return { speaker: 'self', to: user, inferred: true };

  if (cast.length) {
    // 文本以某个在场角色起手 → 是那个角色在说（「林夏问她怎么回来了」）
    const opener = cast.find((id) => startsWithName(text, nameOfActor(id, nameOf)));
    if (opener) return { speaker: opener, to: 'self', inferred: true };
    // 否则是她对这个角色说（「问林夏明天早会几点」）
    return { speaker: 'self', to: cast[0], inferred: true };
  }

  // 只有 self：自言自语，或对象没写清
  return { speaker: 'self', to: null, inferred: true };
}

/** 真实用户 id（to 形如 u:123456） */
export function isToUser(to) {
  return typeof to === 'string' && to.startsWith('u:');
}

/** 她真正发出去的话：她说的 + 收件人是真实用户 */
export function isHerSayToUser(e, opts) {
  // 必须先是 say 事件。少了这一行，一条「他发来：嗯呐，那你去洗澡吧」的 world 事件
  // 会被解析成「她对他说的」——因为 actors 里就他一个，推断规则会把说话人填成 self。
  // 结果他的原话出现在她的「最近说过的话」里，重复检测把自己的回话判成重复。
  if (e?.kind && e.kind !== 'say') return false;
  const { speaker, to } = resolveSpeech(e, opts);
  return speaker === 'self' && isToUser(to);
}

function clip(s, n = 34) {
  return cut(String(s ?? '').replace(/\s+/g, ' ').trim(), n, '…');
}

const VERB_PREFIX = /^(又|就|还|才)?(说|问|答|道|喊|回|讲|念叨|提醒|嘱咐)(了|着)?(一句|句)?[，,：:]?/;

/**
 * 去掉 summary 里自带的主语/动词前缀——
 * 「陈哥看她脸色白，让她把咖啡喝了」在加了归属后不该再念一遍「陈哥对她说：陈哥…」。
 */
function stripPrefix(text, speakerName) {
  let t = String(text ?? '').trim();
  if (speakerName) {
    const name = speakerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`^${name}`), '').trim();
  }
  const stripped = t.replace(VERB_PREFIX, '').trim();
  if (stripped.length >= 2) t = stripped;
  return t || String(text ?? '').trim();
}

/**
 * 渲染成一句带归属的话，供每日记忆 / 时间轴使用。
 * 「她对林夏说：…」/「林夏说：…」/「她自言自语：…」
 */
export function renderSpeechLine(e, { nameOf = (id) => id, maxLen = 34 } = {}) {
  const { speaker, to } = resolveSpeech(e, { nameOf });
  const raw = e?.summary ?? e?.prose ?? '';
  const speakerName = speaker === 'self' ? '她' : nameOfActor(speaker, nameOf);
  const text = clip(stripPrefix(raw, speakerName), maxLen);
  if (!text) return '';
  if (speaker === 'self') {
    if (!to) return `她自言自语：${text}`;
    return `她对${nameOfActor(to, nameOf)}说：${text}`;
  }
  if (to === 'self') return `${nameOfActor(speaker, nameOf)}对她说：${text}`;
  if (to) return `${nameOfActor(speaker, nameOf)}对${nameOfActor(to, nameOf)}说：${text}`;
  return `${nameOfActor(speaker, nameOf)}说：${text}`;
}
