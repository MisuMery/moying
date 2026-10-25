// 世界事件播种器：让她的世界自己会动。
//
// 参考 HDS 的 world-seeder，核心是「持证的事实源」：主模型被禁止凭空虚构外部事件，
// 但 seeder 生成的事件一旦落账，主模型就获得了书写它的合法性。
// 于是没人发消息时，楼下会装修、会转雨、快递会到——世界不再是静止的。
//
// 与 HDS 一致的三条硬边界：
//   1. 只写世界对她做了什么，**不写她的行动、想法、决定**（那是叙事的领地）；
//   2. **绝不生成联系动机**（「她想找他聊聊」属于 Urge/Agency，不是 seeder）；
//   3. **绝不牵涉当前对话的参与者**（不许出现「他发来消息」「他来找她」——
//      那是真实事件通道，只能由真实入站消息产生）。
//
// 时间边界：事件时刻必须落在演化窗口 [cursorAt, now] 内；更远的只能作为远期种子
// 存起来（status=due），到点再注入。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { callLLM } from '../llm/gateway.js';
import { loadWorld, seedTopics, seedDensity, renderWorldSetting, renderStoryRequirement } from './world.js';
import { loadCharacter } from '../persona/card.js';
import { renderWorldBlock, nameResolver } from './view.js';
import { similarity } from '../narrator/repeat.js';

const FILE = path.join(DATA_DIR, 'seeded_events.json');

export const IMPORTANCE = ['low', 'medium', 'high'];

const SEEDER_SYSTEM = `你是「世界事件生成器」。你为一个持续演进的故事世界提供**外部事实**。

你写的每一条都是已经发生的客观事实，宿主会把它记进世界账本，之后主角才可以据此书写。
严格遵守以下边界（违反即作废）：

1. 只写**外部世界**发生的事：天气、社区、交通、工作通知、熟人的动静、街上的偶遇。
2. **不写主角**：不写她做了什么、说了什么、想了什么、决定了什么。
3. **不写联系动机**：不许出现「她想联系谁」「她拿起手机想发消息」这类内容。
4. **绝不牵涉当前对话的参与者**：不许出现「他」「对方」「网友」「老同学」发消息、打电话、来找她——
   真实联系只能来自真实入站消息。
5. 时间必须落在给定的演化窗口内；更远的安排写成 horizon=long 的远期种子（给出 dueAt）。
6. 语义去重：不要重复已有事件说过的事。

只输出 JSON：
{
  "events": [
    {
      "at": "2026-10-25T14:10:00+08:00",
      "importance": "low | medium | high",
      "horizon": "now | short | long",
      "summary": "一句话事实（≤30字，只陈述发生了什么）",
      "detail": "两到三句的具体描写（可选）",
      "dueAt": "仅 horizon=long 需要：到期时刻"
    }
  ]
}

数量控制：一次最多 2 条；低重要性的小质感事件为主，高重要性（关系/转折）要克制。`;

/** 参与者相关词：seeder 生成的内容里出现这些就整条作废 */
const PARTICIPANT_WORDS = ['他发来', '他打来', '他来找', '他约她', '对方发', '网友', '老同学发', '他给她发', '他问她', '他突然'];

export class WorldSeeder {
  constructor({ timeline, cursor, store, registry = null, llm = callLLM }) {
    this.timeline = timeline;
    this.cursor = cursor;
    this.store = store;
    this.registry = registry;
    this.llm = llm;
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      return { events: Array.isArray(raw) ? raw : (raw?.events ?? []) };
    } catch {
      return { events: [] };
    }
  }

  #save(data) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
  }

  all() {
    return this.#load().events;
  }

  /** 最近 24 小时已经播了多少条（密度控制） */
  #recentCount(now, hours = 24) {
    const since = now - hours * 3600_000;
    return this.all().filter((e) => {
      const t = Date.parse(e.at ?? e.dueAt ?? '');
      return Number.isFinite(t) && t >= since;
    }).length;
  }

  /**
   * 一次播种扫描。
   * @param {{now?:number, max?:number}} opts
   */
  async sweep({ now = Date.now(), max = 2 } = {}) {
    const world = loadWorld();
    const density = seedDensity(world);
    const already = this.#recentCount(now);
    if (already >= density.perDayMax) {
      return { skipped: '今日播种已达上限', count: 0, added: [] };
    }
    const room = Math.min(max, density.singleMax ?? max, density.perDayMax - already);
    if (room <= 0) return { skipped: '今日播种已达上限', count: 0, added: [] };

    const win = this.cursor.window(now);
    const recent = this.timeline.events.slice(-24)
      .map((e) => `- ${e.summary ?? ''}`).filter((s) => s.trim() !== '-').join('\n');

    const userParts = [
      renderWorldSetting(world),
      '',
      renderStoryRequirement(world),
      '',
      renderWorldBlock(this.timeline, now, this.registry ? { resolveName: nameResolver(this.registry) } : {}),
      '',
      this.#characterFacts(),
      '',
      this.cursor.renderWindow(now),
      '',
      '<可参考的外部事件主题>', ...seedTopics(world).map((t) => `- ${t}`), '</可参考的外部事件主题>',
      '',
      '<最近已经发生过的事（不要重复）>', recent || '（暂无）', '</最近已经发生过的事>',
      '',
      `请生成 1~${room} 条外部事件。`,
    ].join('\n');

    let draft;
    try {
      const { json } = await this.llm('story', [
        { role: 'system', content: SEEDER_SYSTEM },
        { role: 'user', content: userParts },
      ], { jsonMode: true, temperature: 0.9 });
      draft = json;
    } catch (error) {
      return { error: String(error?.message ?? error), count: 0, added: [] };
    }

    const added = [];
    const rejected = [];
    const data = this.#load();
    for (const e of (draft?.events ?? []).slice(0, room)) {
      const verdict = this.#vet(e, now, win);
      if (!verdict.ok) { rejected.push({ summary: e?.summary, reason: verdict.reason }); continue; }
      const rec = {
        id: `cev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        at: verdict.at,
        dueAt: e.horizon === 'long' ? (e.dueAt ?? null) : null,
        importance: IMPORTANCE.includes(e.importance) ? e.importance : 'low',
        horizon: e.horizon === 'long' ? 'long' : 'now',
        summary: String(e.summary ?? '').slice(0, 60),
        detail: String(e.detail ?? '').slice(0, 400),
        status: e.horizon === 'long' ? 'scheduled' : 'pending',
        createdAt: new Date(now).toISOString(),
      };
      data.events.push(rec);
      added.push(rec);
    }
    if (added.length) this.#save(data);
    return { count: added.length, added, rejected };
  }

  /** 主角身上与时间有关的事实（生日之类），临近时可以自然兑现 */
  #characterFacts() {
    try {
      const ch = loadCharacter();
      const b = ch?.identity?.birthday;
      if (!b) return '';
      const parts = [];
      parts.push(`<主角的日子>生日：${b.solar ?? ''}${b.lunar ? `（农历${b.lunar}）` : ''}`);
      if (b.note) parts.push(b.note);
      parts.push('</主角的日子>');
      return parts.join('\n');
    } catch {
      return '';
    }
  }

  /** 单条事件的准入检查：时间边界 / 参与者 / 去重 */
  #vet(e, now, win) {
    const summary = String(e?.summary ?? '').trim();
    if (!summary) return { ok: false, reason: '没有内容' };

    // ① 参与者隔离（seeder 不许碰真实联系人）
    const blob = `${summary} ${String(e?.detail ?? '')}`;
    for (const w of PARTICIPANT_WORDS) {
      if (blob.includes(w)) return { ok: false, reason: `牵涉了对话参与者（命中「${w}」）` };
    }

    // ② 时间边界：now/short 必须落在 [cursor, now]；long 必须有 dueAt 且在未来
    const at = Date.parse(e?.at ?? '');
    if (e?.horizon === 'long') {
      const due = Date.parse(e?.dueAt ?? '');
      if (!Number.isFinite(due) || due <= now) return { ok: false, reason: '远期种子缺少有效的未来到期时间' };
      return { ok: true, at: e.dueAt };
    }
    if (!Number.isFinite(at)) return { ok: false, reason: '时间无法解析' };
    if (at > now) return { ok: false, reason: '事件时刻超过了现在（不许跳到未来）' };
    if (at < win.from - 60_000) return { ok: false, reason: '事件时刻早于上次推进的游标' };
    return { ok: true, at: e.at };
  }

  /**
   * 到期排水：把该发生的播种事件写进世界时间轴。
   * 过期的（停机太久、错过了发生时刻）标记 expired 丢弃，
   * 不再以旧时刻回灌——时间轴里塞一条「三小时前的割草机响」只会污染当下。
   */
  drainDue({ now = Date.now(), maxAgeMs = 2 * 3600_000 } = {}) {
    const data = this.#load();
    const injected = [];
    let dirty = false;
    for (const e of data.events) {
      if (e.status === 'injected') continue;
      const due = Date.parse(e.at ?? e.dueAt ?? '');
      if (!Number.isFinite(due) || due > now) continue;
      if (now - due > maxAgeMs) {
        e.status = 'expired';
        dirty = true;
        continue;
      }
      const rec = {
        at: new Date(due).toISOString(),
        kind: 'world',
        place: this.timeline.currentPlace(due),
        actors: [],
        summary: e.summary,
        prose: e.detail || e.summary,
        source: 'world-seeder',
        importance: e.importance,
      };
      const saved = this.store.appendEvent(rec);
      this.timeline.commit([saved]);
      e.status = 'injected';
      e.injectedAt = new Date(now).toISOString();
      dirty = true;
      injected.push(rec);
    }
    if (dirty) this.#save(data);
    return injected;
  }
}
