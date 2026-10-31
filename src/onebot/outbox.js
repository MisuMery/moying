// 出站队列：串行发送 + 文体强制 + 归属守卫 + 逐条记账。
//
// 一条气泡从模型产出到真正发出，必须依次过四关：
//   1. enforceStyle —— 文体（句号/长度/感叹号）
//   2. OutboundGuard —— 发给谁（虚构角色在此被拦下）
//   3. 串行发送 —— 保持顺序，模拟打字间隔
//   4. ledger —— 记账（发出/失败/被拦都可回溯）

import fs from 'node:fs';
import path from 'node:path';
import { OutboundGuard } from '../cast/guard.js';
import { enforceStyle } from '../style/enforce.js';
import { faceIdByName } from './face-catalog.js';

// 她在话里写 [贴纸:id] 时，把这张表情包真的发出去
const STICKER_PATTERN = /\[\s*贴纸\s*[:：]\s*([^\]]{1,40}?)\s*\]/;

// 兼容三种写法：
//   [表情:微笑]                      —— 我们约定的内部标记（名字查编号）
//   [表情：呲牙]                     —— 模型从旧日志里学来的方括号写法（V3 禁止输出，收到就转掉）
//   [QQ 原生表情：胖三斤（ID: 300）] —— 导出行情里带编号的写法（直接用编号）
// 名字部分用贪婪匹配，否则「胖三斤」只会取到一个「胖」
const FACE_PATTERN = /\[(?:QQ\s*原生表情|表情|face)[：:]\s*([^\]（(]{1,12})(?:\s*[（(]\s*ID[：:]\s*(\d+)\s*[)）])?\s*\]/g;

// 模型常照着「来信渲染」的格式写裸方括号，如 [笑哭]、[QQ表情355耶]。
// 这些既不是显式标记、也没有 ID，以前会被原样当文字发出去（线上「还发[笑哭]」）。
// 这条负责把它们也认出来：有编号用编号；有名字查表情表；查不到再看常见表情的中文名→emoji 兜底。
const BARE_FACE_PATTERN = /\[\s*(?:QQ\s*表情\s*(\d+)[^\]]*|([^\[\]：:]{1,12}))\s*\]/g;

// 常见 QQ 表情中文名 → Unicode emoji（表情目录查不到时兜底，保证至少能发出一个真 emoji）。
// 注意：这里刻意不放 😅🙂😏🙄 这类"让人不舒服/阴阳"的表情；需要时用真实 QQ 表情段。
const FACE_EMOJI = {
  笑哭: '😂', 破涕为笑: '😂', 流泪: '😢', 大哭: '😭', 允悲: '😭',
  憨笑: '😄', 呲牙: '😁', 偷笑: '🤭',
  捂脸: '🤦', 打脸: '😳', 害羞: '😳', 惊讶: '😲', 疑问: '❓',
  委屈: '🥺', 亲亲: '😘', 色: '😍', 酷: '😎',
  发怒: '😠', 抓狂: '😫', 睡: '😴', 困: '😪', 晕: '😵',
  吐: '🤮', 嘘: '🤫', 思考: '🤔', 赞: '👍', 鼓掌: '👏',
  比心: '🫶', 爱心: '❤️', 心碎: '💔', 狗头: '🐶', 吃瓜: '🍉', 加油: '💪',
  抱抱: '🤗', 握手: '🤝', 让我看看: '👀', 耶: '✌️', 敲敲: '🔨',
};

// 禁用表情：这些在中文聊天里容易被读成敷衍、阴阳怪气、让人不舒服（用户 2026-10-27 点名 😅）。
// 可在人设 speech.emoji.avoid 里覆盖，这里给一份默认清单兜底。
export const DEFAULT_EMOJI_AVOID = [
  // 敷衍 / 阴阳怪气（2026-10-27 用户点名 😅）
  '😅', '🙃', '🙂', '😬', '😐', '😑', '🙄', '💦', '🫠', '🤡', '😏',
  // 老掉牙的卖萌 / 做作（2026-10-28 用户点名「捂嘴笑之类」）：捂嘴笑、假笑、可爱脸
  '🤭', '😊', '☺️', '☺',
];

/** 从纯文本里剔除被禁用的表情字符（只动文字，表情段/贴纸段不受影响）。 */
export function stripBannedEmoji(text, avoid = DEFAULT_EMOJI_AVOID) {
  let out = String(text ?? '');
  if (!avoid || !avoid.length) return out;
  for (const e of avoid) {
    if (e) out = out.split(e).join('');
  }
  return out;
}

/** 过滤整条消息里的禁用表情：只清 text 段，剔空后若一条不剩就补「嗯」。 */
export function sanitizeSegments(segments, avoid = DEFAULT_EMOJI_AVOID) {
  const out = [];
  for (const s of segments ?? []) {
    if (s?.type === 'text') {
      const t = stripBannedEmoji(s.data?.text, avoid);
      if (String(t ?? '').trim()) out.push({ type: 'text', data: { text: t } });
    } else if (s) {
      out.push(s);
    }
  }
  return out.length ? out : [{ type: 'text', data: { text: '嗯' } }];
}

// Unicode 表情 → QQ 自带表情名。
// 用户要求（2026-10-28）：**能用 QQ 自带表情就不要用 emoji**——QQ 表情是矢量图、
// 在手机和电脑上观感一致，emoji 在不同设备上长得不一样，还会显得"不是人在打字"。
// 这里覆盖日常情绪那一批；只映射到**数字编号**的表情（协议端最稳），
// 映射不到的 emoji 原样保留，绝不硬转成看不懂的东西。
// 注意：刻意不含 😅🙂🙃😏🙄 这类"阴阳脸"——它们属于禁用清单，会被直接剔掉，不该转成表情。
const EMOJI_FACE = {
  '😂': '笑哭', '🤣': '笑哭',
  '😁': '笑哭', '😃': '笑哭', '😄': '笑哭', // 笑脸统一走笑哭（呲牙/憨笑已禁）
  '😭': '大哭', '😢': '流泪', '🥲': '流泪',
  '🥺': '委屈', '😔': '难过', '😞': '难过',

  '😴': '睡', '😪': '困', '🥱': '哈欠',
  '😲': '惊讶', '😮': '惊讶',
  '😠': '发怒', '😡': '发怒',
  '😫': '抓狂', '😖': '抓狂',
  '🤗': '拥抱', '🤝': '握手',
  '👍': '赞', '👎': '踩', '👏': '鼓掌',
  '❤️': '爱心', '❤': '爱心', '💔': '心碎', '💕': '爱情',
  '🍉': '吃瓜', '🍰': '蛋糕', '🎂': '蛋糕', '☕': '咖啡', '🌹': '玫瑰',
  '🐶': 'doge', '🐷': '猪头', '👻': '幽灵', '💀': '骷髅',
  '✌️': '胜利', '✌': '胜利', '🙏': '抱拳', '👊': '拳头',
  '🤔': '托腮', '😵': '晕', '🤮': '吐', '🤫': '嘘',
  '😎': '酷', '😌': '悠闲', '🙂‍↔️': '无奈',
  '🎉': '鞭炮', '💪': '奋斗', '🍵': '茶', '🌞': '太阳', '🌙': '月亮',
};

const EMOJI_KEYS = Object.keys(EMOJI_FACE).sort((a, b) => b.length - a.length);

/**
 * 把纯文本里的 emoji 换成 QQ 原生表情段；转不了的保留原 emoji。
 * 按"最长匹配优先"处理多码点 emoji（如 ❤️ = ❤ + 变体选择符）。
 */
export function textWithEmojiFaces(text) {
  const raw = String(text ?? '');
  if (!raw) return [];
  const out = [];
  let rest = raw;
  while (rest) {
    let hitIdx = -1;
    let hitKey = '';
    for (const k of EMOJI_KEYS) {
      const i = rest.indexOf(k);
      if (i < 0) continue;
      if (hitIdx < 0 || i < hitIdx || (i === hitIdx && k.length > hitKey.length)) {
        hitIdx = i;
        hitKey = k;
      }
    }
    if (hitIdx < 0) {
      out.push({ type: 'text', data: { text: rest } });
      break;
    }
    if (hitIdx > 0) out.push({ type: 'text', data: { text: rest.slice(0, hitIdx) } });
    const name = EMOJI_FACE[hitKey];
    const id = faceIdByName(name);
    const usable = id !== null && id !== undefined && /^\d+$/.test(String(id)) && !isBannedFaceName(name);
    if (usable) out.push({ type: 'face', data: { id: String(id) } });
    else out.push({ type: 'text', data: { text: hitKey } }); // 目录里没有就保留 emoji，别丢
    rest = rest.slice(hitIdx + hitKey.length);
  }
  return out;
}

/** 名字 → 表情段；查不到表情表就退回 emoji 文字；都没有返回 null（保持原样，不硬转）。 */
function faceOrEmoji(name) {
  // 禁用表情名（微笑/流汗/白眼…这类经典"阴阳脸"）：先于表情表判断，直接产出空文本，后面会被过滤掉。
  if (isBannedFaceName(name)) return { type: 'text', data: { text: '' } };
  const id = faceIdByName(name);
  if (id !== null && id !== undefined) return { type: 'face', data: { id: String(id) } };
  const em = FACE_EMOJI[name];
  if (em) return { type: 'text', data: { text: em } };
  return null;
}

// 禁用的 QQ 表情名：与上面 emoji 黑名单对应，都是容易被读成敷衍/阴阳/让人不舒服的。
const BANNED_FACE_NAMES = new Set([
  // 敷衍 / 阴阳怪气（2026-10-27）
  '流汗', '冷汗', '微笑', '尴尬', '无语', '白眼', '坏笑', '冷笑', '机智', '阴险', '汗',
  // 老掉牙的卖萌 / 做作（2026-10-28 用户点名「捂嘴笑之类」）
  '偷笑', '害羞', '调皮', '可爱', '憨笑', '呲牙', '卖萌', '得意', '可怜', '斜眼笑',
]);
export function isBannedFaceName(name) {
  return BANNED_FACE_NAMES.has(String(name ?? '').trim());
}

/** 把一段纯文本里的裸方括号表情切开（无表情则原样返回一段 text）。 */
function splitBareFaces(text) {
  const raw = String(text ?? '');
  if (!raw) return [];
  const out = [];
  let last = 0;
  for (const m of raw.matchAll(BARE_FACE_PATTERN)) {
    const idRaw = m[1];
    const name = m[2]?.trim();
    let seg = null;
    if (idRaw) seg = { type: 'face', data: { id: String(Number(idRaw)) } };
    else if (name) seg = faceOrEmoji(name);
    if (!seg) continue; // 不是表情（比如 [重要]），原样保留
    if (m.index > last) out.push({ type: 'text', data: { text: raw.slice(last, m.index) } });
    out.push(seg);
    last = m.index + m[0].length;
  }
  if (!out.length) return [{ type: 'text', data: { text: raw } }];
  if (last < raw.length) out.push({ type: 'text', data: { text: raw.slice(last) } });
  return out;
}

/**
 * 把文本里的表情标记转成 OneBot 消息段。
 * 先处理显式标记（[表情:x] / [QQ原生表情:x(ID:n)]），再扫一遍裸方括号（[笑哭]、[QQ表情355耶]）。
 * 优先编号 → 名字查表 → 常见 emoji 兜底；都没有就保留原文，绝不把 [贴纸:x] 之类漏成方括号。
 */
export function buildSegments(text) {
  const raw = String(text ?? '');
  const base = [];
  let last = 0;
  for (const m of raw.matchAll(FACE_PATTERN)) {
    if (m.index > last) {
      const plain = raw.slice(last, m.index);
      if (plain) base.push({ type: 'text', data: { text: plain } });
    }
    const byId = m[2];
    const byName = m[1]?.trim();
    let seg = byId ? { type: 'face', data: { id: String(Number(byId)) } } : null;
    if (!seg && byName) seg = faceOrEmoji(byName);
    if (seg) base.push(seg);
    else if (byName) base.push({ type: 'text', data: { text: byName } }); // 查不到名字，至少不留方括号
    last = m.index + m[0].length;
  }
  if (last < raw.length) {
    const tail = raw.slice(last);
    if (tail) base.push({ type: 'text', data: { text: tail } });
  }
  if (!base.length && raw) base.push({ type: 'text', data: { text: raw } });

  // 第二遍：把 text 段里的裸方括号表情切开
  const segments = [];
  for (const s of base) {
    if (s.type === 'text') segments.push(...splitBareFaces(s.data.text));
    else segments.push(s);
  }

  // 第三遍：文字里剩下的 emoji 字符 → QQ 自带表情段（能用 QQ 表情就不用 emoji）
  const withFaces = [];
  for (const s of segments) {
    if (s.type === 'text') withFaces.push(...textWithEmojiFaces(s.data.text));
    else withFaces.push(s);
  }
  return withFaces.length ? withFaces : [{ type: 'text', data: { text: raw } }];
}

export class Outbox {
  /**
   * @param {{client:object, registry:object, store:object, speech?:object, minGapMs?:number}} deps
   */
  constructor({ client, registry, store, speech = {}, minGapMs = 1200, rate = null, stickers = null }) {
    this.client = client;
    this.store = store;
    this.speech = speech;
    // 禁用表情：优先用人设 speech.emoji.avoid，没有就用默认清单（😅 这类会让人不舒服的）
    this.emojiAvoid = Array.isArray(speech?.emoji?.avoid) ? speech.emoji.avoid : DEFAULT_EMOJI_AVOID;
    this.minGapMs = minGapMs;
    this.rate = rate;   // 字数/条数限流（RateLimiter），不传则不限
    this.stickers = stickers; // StickerStore，不传则 [贴纸:id] 会退化成文字
    this.guard = new OutboundGuard({
      registry,
      ledger: { record: (e) => store.recordLedger({ ...e, stage: 'guard' }) },
    });
    this.queue = Promise.resolve();
  }

  /**
   * 投递一组话语。
   * @param {Array<{id?:string, addresseeId:string, content:string}>} utterances
   * @param {{source?:string, entryId?:string}} ctx
   */
  async deliver(utterances, ctx = {}) {
    // 先按收件人分组做文体强制（拆条后仍保持顺序）
    const stage = ctx.stage ?? this.stage ?? null;
    const prepared = [];
    for (const u of utterances ?? []) {
      const styled = enforceStyle([u.content ?? ''], this.speech, stage);
      for (const piece of styled) {
        prepared.push({ id: u.id, addresseeId: u.addresseeId, content: piece, original: u.content });
      }
    }

    const { deliverable: authorized, blocked } = this.guard.authorizeAll(prepared);

    // 没有主动联系念头时，连发给真实用户的话也要拦——她是想过但没打算找他，不是忘了回
    const deliverable = [];
    if (ctx.allowRealUser === false) {
      for (const item of authorized) {
        const kind = item.actor?.kind ?? '';
        const isReal = kind === 'real_user' || kind === 'real_group';
        if (isReal) {
          blocked.push({
            ...item,
            reason: ctx.blockReason || '这一刻没有主动联系他的念头',
          });
          this.store.recordLedger({
            stage: 'urge', status: 'blocked', addresseeId: item.utterance?.addresseeId ?? '',
            content: item.utterance?.content ?? '',
            reason: ctx.blockReason || '这一刻没有主动联系他的念头', source: ctx.source ?? '',
          });
        } else {
          deliverable.push(item);
        }
      }
    } else {
      deliverable.push(...authorized);
    }

    // 串行发送
    const sent = [];
    const throttled = [];
    for (let i = 0; i < deliverable.length; i += 1) {
      const item = deliverable[i];
      const { endpoint, actor } = item;
      const kind = endpoint.transport === 'onebot_group' ? 'group' : 'private';
      // let：下面找不到表情包时要剥掉 [贴纸:id] 标记做退化处理。
      // （2026-10-25 修：原来是 const，退化时赋值直接抛 Assignment to constant
      //  variable，被外层 catch 记成 failed——整条消息被吞掉，既没发图也没发文字）
      let content = item.utterance.content;
      try {
        // 两条之间至少隔 1 秒：真人打字再快也有手速上限，秒发两三条很假
        if (i > 0 && this.minGapMs > 0) {
          await new Promise((r) => setTimeout(r, Math.max(1000, this.minGapMs) + Math.random() * 800));
        }
        // 限流：一分钟发太多就等一等，等太久就放弃这条
        if (this.rate) {
          const gate = this.rate.check(content);
          if (!gate.ok) {
            if (gate.waitMs >= (this.rate.cfg?.maxWaitMs ?? 150000)) {
              throttled.push({ content, reason: gate.reason, waitMs: gate.waitMs });
              this.store.recordLedger({
                stage: 'rate', status: 'throttled_dropped', addresseeId: item.utterance.addresseeId,
                content, reason: `${gate.reason}（需等 ${Math.round(gate.waitMs / 1000)}s，已放弃）`, source: ctx.source ?? '',
              });
              continue;
            }
            await new Promise((r) => setTimeout(r, gate.waitMs));
          }
        }
        // [贴纸:id] → 真的把那张表情包发出去：和剥掉标记后的文字组成同一条消息
        // （2026-10-25 修：原来图发出去后就 continue 了，话里的文字被一起丢掉）
        let stickerSeg = null;
        let stickerId = null;
        const stickerHit = String(content ?? '').match(STICKER_PATTERN);
        if (stickerHit) {
          const hit = this.#stickerSegment(stickerHit[1]);
          if (hit) {
            stickerSeg = hit.segment;
            stickerId = hit.id;
            // 文字里剥掉标记：只剩图就光发图，有文字就文字+图一起发
            content = String(content).replace(STICKER_PATTERN, '').trim();
          } else {
            // 找不到这张图就退化成普通文本，别把 [贴纸:xxx] 原文发出去
            content = String(content).replace(STICKER_PATTERN, '').trim() || '嗯';
          }
        }

        // 过滤禁用表情（😅 之类会让人不舒服的）：只剔文字里的表情字符，不动表情段/贴纸段。
        // 剔完若整条只剩空文字，就补一个「嗯」，避免发出空白气泡。
        const baseSegments = stickerSeg ? [...buildSegments(content), stickerSeg] : buildSegments(content);
        const segments = sanitizeSegments(baseSegments, this.emojiAvoid);
        const res = await this.client.sendSegments(kind, endpoint.targetId, segments, undefined, stickerSeg ? { timeoutMs: 60000 } : undefined);
        if (this.rate) this.rate.consume(content);
        const messageId = res?.message_id ?? null;
        sent.push({
          utteranceId: item.utterance.id, addresseeId: item.utterance.addresseeId,
          content: item.utterance.content, messageId, ...(stickerId ? { stickerId } : {}),
        });
        this.store.recordLedger({
          stage: 'send',
          status: 'sent',
          utteranceId: item.utterance.id ?? null,
          addresseeId: item.utterance.addresseeId,
          addresseeName: actor?.displayName ?? '',
          content: stickerId ? `[表情包 ${stickerId}] ${item.utterance.content}` : item.utterance.content,
          messageId,
          ...(stickerId ? { stickerId } : {}),
          source: ctx.source ?? '',
        });
      } catch (error) {
        this.store.recordLedger({
          stage: 'send',
          status: 'failed',
          utteranceId: item.utterance.id ?? null,
          addresseeId: item.utterance.addresseeId,
          content: item.utterance.content,
          error: String(error?.message ?? error).slice(0, 200),
          source: ctx.source ?? '',
        });
      }
    }

    return { sent, blocked, prepared, throttled };
  }

  /**
   * 取一张表情包的消息段（图片段）。找不到/读不动返回 null，让调用方退化成文本。
   * 只构造段、不发送：文字和图要由 deliver 组成同一条消息发出去
   * （2026-10-25 修：原来这里单独发图然后 continue，话里的文字被丢；且找不到图时
   *  外层对 const 赋值直接抛错，整条消息被吞成 failed）。
   */
  #stickerSegment(stickerId) {
    if (!this.stickers) return null;
    const entry = this.stickers.get(String(stickerId ?? '').trim());
    if (!entry) return null;
    const abs = this.stickers.absolutePath(entry);
    if (!abs) return null;
    try {
      const b64 = fs.readFileSync(abs).toString('base64');
      const ext = path.extname(abs).toLowerCase();
      const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.gif' ? 'image/gif' : 'image/png';
      return { id: entry.id, segment: { type: 'image', data: { file: `base64://${b64}` } } };
    } catch {
      return null;
    }
  }
}
