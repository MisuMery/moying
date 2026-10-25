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

/**
 * 把文本里的表情标记转成 OneBot 消息段。
 * 优先用编号（带 ID 的写法），否则按名字查表；查不到就退化成文字，绝不把方括号原文发给用户。
 */
export function buildSegments(text) {
  const segments = [];
  let last = 0;
  const raw = String(text ?? '');
  for (const m of raw.matchAll(FACE_PATTERN)) {
    if (m.index > last) {
      const plain = raw.slice(last, m.index);
      if (plain) segments.push({ type: 'text', data: { text: plain } });
    }
    const byId = m[2];
    const byName = m[1]?.trim();
    let id = byId ? String(Number(byId)) : null;
    if (!id && byName) {
      const looked = faceIdByName(byName);
      if (looked !== null && looked !== undefined) id = String(looked);
    }
    if (id) segments.push({ type: 'face', data: { id } });
    else if (byName) segments.push({ type: 'text', data: { text: byName } }); // 退化成名字，也不留方括号
    last = m.index + m[0].length;
  }
  if (last < raw.length) {
    const tail = raw.slice(last);
    if (tail) segments.push({ type: 'text', data: { text: tail } });
  }
  if (!segments.length && raw) segments.push({ type: 'text', data: { text: raw } });
  return segments;
}

export class Outbox {
  /**
   * @param {{client:object, registry:object, store:object, speech?:object, minGapMs?:number}} deps
   */
  constructor({ client, registry, store, speech = {}, minGapMs = 1200, rate = null, stickers = null }) {
    this.client = client;
    this.store = store;
    this.speech = speech;
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

        const segments = stickerSeg ? [...buildSegments(content), stickerSeg] : buildSegments(content);
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
