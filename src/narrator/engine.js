// 回合编排：用户消息回合与自动推进回合走**完全相同**的提交路径。
//
// HDS 把自动推进当成另一条代码路径，于是独立生活里写出的内容不受同一套约束，
// 「在忙吗」那种幻觉消息就是这么进来的。这里没有第二条路：两种回合都产出
// WorldEvent，都过 validateDrafts，都过 OutboundGuard。

import { Narrator } from './narrator.js';
import { DialogueNarrator } from './dialogue.js';
import { Timeline, EventKind, Place } from '../world/state.js';
import { toISO, localHour, localWeekday, toMs } from '../world/time.js';
import { renderWorldBlock, nameResolver } from '../world/view.js';
import { Outbox } from '../onebot/outbox.js';
import { styleLint } from '../style/enforce.js';
import { createRealUser } from '../cast/actors.js';
import { Inbox } from '../turn/inbox.js';
import { evaluateWillingness, resolveWillingness } from '../turn/willingness.js';
import { evaluateUrge } from '../turn/urge.js';
import { RateLimiter } from '../turn/ratelimit.js';
import { resolveStage, workSchedule, hourFloat, loadPersona, invalidatePersona } from '../persona/card.js';
import { maybeAdvanceStage, loadRelationship } from '../persona/relationship.js';
import { evolveStageContent, ensureStageContent } from '../persona/evolve.js';
import { StickerStore } from '../features/stickers.js';
import { describeImages } from '../vision/describe.js';
import { StoryCursor } from '../world/cursor.js';
import { WorldSeeder } from '../world/seeder.js';
import { renderWorldSetting, renderStoryRequirement } from '../world/world.js';
import { loadConfig, invalidateConfig } from '../config.js';
import { sleepState } from '../world/validator.js';

export class Engine {
  constructor({ client, store, persona, registry, impressions, config, llm = null, allowPrivateImageUrls = false }) {
    this.client = client;
    this.store = store;
    this.persona = persona;
    this.registry = registry;
    this.impressions = impressions;
    this.config = config;
    this.llm = llm; // 测试可注入；生产为空，走真实网关
    this.allowPrivateImageUrls = allowPrivateImageUrls; // 测试本地图床用；生产必须 false（SSRF 防线）

    // 时间轴由已落库的事件重建（冷启动直接 replay）
    this.timeline = new Timeline(store.loadEvents(), Place.HOME);

    // 演化游标：故事推进到哪一刻。冷启动用最后一条事件的时间作为起点
    const lastAt = this.timeline.lastAt();
    this.cursor = new StoryCursor(lastAt);
    this.seeder = new WorldSeeder({
      timeline: this.timeline, cursor: this.cursor, store, registry,
      ...(llm ? { llm } : {}),
    });

    this.narrator = new Narrator({
      store, registry, persona, impressions, timeline: this.timeline, ...(llm ? { llm } : {}),
    });
    // 对话阶段独立，用 chat 路由；世界阶段用 story 路由
    this.dialogue = new DialogueNarrator({
      store, registry, persona, impressions, timeline: this.timeline, stickers: this.stickers, ...(llm ? { llm } : {}),
    });
    // 回复门控：意愿分数 / 字数限流 / 连续消息合并
    this.willingnessCfg = resolveWillingness(config?.reply ?? {}, config?.reply?.preset ?? 'normal');
    /** @type {Map<string, {score:number, updatedAt:number}>} */
    this.willingness = new Map();
    this.rate = new RateLimiter(config?.rate ?? {});

    this.stickers = new StickerStore();
    this.outbox = new Outbox({
      client, registry, store, speech: persona?.speech ?? {}, rate: this.rate, stickers: this.stickers,
    });

    this.inbox = new Inbox({
      // 返回 Promise，便于调用方（与测试）等待这一轮真正跑完
      onFlush: (userId, messages) => this.#flushUser(userId, messages)
        .catch((e) => console.error('[flush] 回合失败:', e?.message ?? e)),
    });

    // 回合互斥：自动推进的定时器与用户消息的 flush 可能同时触发，
    // 两个回合并发会互踩游标、把时间轴写穿（模型还会被两份提示词交叉轰炸）。
    // 所有会写世界的操作（回合、热重载）都排队串行执行。
    this.turnQueue = Promise.resolve();
  }

  /** 串行执行：同一时刻最多一个回合在写世界状态 */
  #serialize(task) {
    const run = this.turnQueue.then(task, task);
    // 队列只保留错误不影响后续；调用方拿到的 promise 仍会抛
    this.turnQueue = run.catch(() => {});
    return run;
  }

  /** 按亲密度选当前说话阶段（关系越近话才越多） */
  currentStage(userId) {
    return resolveStage(this.persona, this.impressions.get(userId));
  }

  /**
   * 她现在忙不忙。
   * 只有「真的在公司 / 在路上」或者「工作日的班段内」才算忙；
   * 休息日在家不算忙——否则周末她明明窝在沙发上，也会被当成在上班。
   */
  isBusy(now = Date.now()) {
    const place = this.timeline.currentPlace(now);
    if (place === Place.OFFICE || place === Place.TRANSIT) return true;
    return this.isWorkHour(now);
  }

  /** 这一刻是否落在上班时段（含通勤缓冲） */
  isWorkHour(now = Date.now()) {
    const sc = workSchedule(this.persona);
    const wd = localWeekday(now); // 0=周日
    if (!sc.workdays.includes(wd)) return false;
    const h = hourFloat(now);
    const pad = (sc.commuteMinutes || 0) / 60;
    return h >= sc.from - pad && h < sc.to + pad;
  }

  /** 注册/确保真实用户在册 */
  ensureUser(userId, displayName = '') {
    if (!this.registry.get(`u:${userId}`)) {
      this.registry.register(createRealUser({ userId, displayName }));
    }
    return this.registry.get(`u:${userId}`);
  }

  /**
   * 处理一条用户消息。
   * @param {{userId:string, text:string, displayName?:string, messageId?:string|number, now?:number,
   *          images?:Array<{url?:string,file?:string}>}} msg
   */
  async handleUserMessage({ userId, text, displayName = '', messageId = null, now = Date.now(), images = [] }) {
    this.ensureUser(userId, displayName);

    // 图片先真正「看」一遍：描述会写进事件与触发器。
    // 看不清就如实标注，绝不把占位符留给模型自由发挥。
    let imageNotes = [];
    if (Array.isArray(images) && images.length) {
      const results = await describeImages(images, {
        client: this.client,
        allowPrivateUrls: this.allowPrivateImageUrls,
        ...(this.llm ? { llm: this.llm } : {}),
      });
      imageNotes = results.map((r) => r.note);
      console.log(`  [识图] ${images.length} 张 → ${imageNotes[0]?.slice(0, 40) ?? ''}`);
    }

    // 用户消息本身也是世界事件（真实外部事件，先落库）。
    // remote: true —— 他是隔着屏幕来的，不是推门进来的，绝不能据此推导「他在她身边」
    // 整段（含 nextId 取号）都排队：自动推进的回合可能正在跑（它会读时间轴快照做校验），
    // 队列外直接 commit 会让两边互踩；取号在队列外还会给并发消息发出重复 id
    // （2026-10-25 审查补漏）。
    let incoming = null;
    await this.#serialize(() => {
      incoming = {
        id: this.store.nextId('e'),
        at: toISO(now),
        kind: EventKind.WORLD,
        place: this.timeline.currentPlace(now),
        actors: [`u:${userId}`],
        remote: true,
        summary: imageNotes.length
          ? `收到消息：${String(text ?? '').slice(0, 24)}［图：${imageNotes.join('；').slice(0, 40)}］`
          : `收到消息：${String(text ?? '').slice(0, 30)}`,
        prose: String(text ?? ''),
        imageNotes,
        source: 'user',
      };
      this.store.appendEvent(incoming);
      this.timeline.commit([incoming]);
    });

    // 意愿门控：她想不想回、以及要过多久才回
    const hour = localHour(now);
    const busy = this.isBusy(now);
    const prev = this.willingness.get(userId) ?? {};
    const verdict = evaluateWillingness(prev, { now, text, hour, busy }, this.willingnessCfg);
    this.willingness.set(userId, { score: verdict.score, updatedAt: now });

    if (!verdict.shouldReply) {
      // 不回：这是正常的真人行为（忙、困、没看到），记账可回溯
      this.store.recordLedger({
        stage: 'gate',
        // 不是「发送失败」，是她这回没回：真人就是这样，忙、困、没看到
        status: 'not_replied',
        direction: 'in',
        addresseeId: `u:${userId}`,
        content: String(text ?? '').slice(0, 60),
        reason: `她没回（${verdict.reason}，p=${verdict.probability}）`,
        source: 'user',
      });
      return { replied: false, reason: verdict.reason, probability: verdict.probability, asleep: verdict.asleep };
    }

    // 会回，但先攒一攒：连续几条消息合并成一个回合再一起回
    const pushed = this.inbox.push(userId, { text, messageId, at: now, imageNotes }, verdict.delayMs);
    return {
      replied: 'scheduled',
      delayMs: verdict.delayMs,
      queued: pushed.count,
      merged: pushed.merged,
      probability: verdict.probability,
      reason: verdict.reason,
    };
  }

  /** 缓冲到点：把这一批消息合成一个回合（排队，避免与其他回合并发） */
  #flushUser(userId, messages) {
    return this.#serialize(() => this.#doFlushUser(userId, messages));
  }

  async #doFlushUser(userId, messages) {
    const texts = messages.map((m) => String(m.text ?? ''));
    // 随消息一起来的图片：把「真正看过」的描述交给对话阶段，别让它猜
    const imgLines = messages.flatMap((m) => (m.imageNotes ?? []).map((n) => `[图片：${n}]`));
    const imgBlock = imgLines.length
      ? `\n随消息发来的图片（你已经看过了）：\n${imgLines.map((x) => `- ${x}`).join('\n')}\n`
      : '';
    const trigger = texts.length === 1
      ? `<此刻触发>他发来一条消息：「${texts[0]}」\n${imgBlock}请继续你的生活，并决定要不要回复、回复什么。`
      : `<此刻触发>他连着发了几条：\n${texts.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n${imgBlock}` +
        `（这几条是一起看到的，不要一条一条分别回，像真人那样一次说清楚就好）`;

    return this.#runTurn({ trigger, userId, now: Date.now(), source: 'user' });
  }

  /** 自动推进（独立生活）：没有用户消息，只是时间到了 */
  async runAutoAdvance({ now = Date.now(), userId } = {}) {
    const target = userId ?? this.#primaryUserId();
    if (!target) return { skipped: '没有可推进的对象' };

    // 排队：和用户回合串行，绝不并发写世界。
    // 注意到期播种（drainDue → store.appendEvent + timeline.commit）也是写世界，
    // 必须整个放进队列里执行——放在队列外的话，它和用户回合仍会互踩时间轴
    // （2026-10-25 审查补漏：串行队列只包了 #runTurn，漏了它前面的排水）。
    return this.#serialize(async () => {
      // 到期播种先落账，这样「她这边有没有新鲜事」能如实喂给主动动机判定
      const seeded = this.seeder.drainDue({ now });
      for (const s of seeded) console.log('  [世界事件]', s.summary);

      const sleep = sleepState(this.persona, now);
      const hour = localHour(now);
      const stage = this.currentStage(target);
      const urge = evaluateUrge({
        cfg: this.config?.urge,
        asleep: sleep.asleep,
        busy: this.isBusy(now),
        hour,
        minutesSince: this.#minutesSinceContact(target, now),
        stageId: stage?.id,
        hasNews: (seeded?.length ?? 0) > 0,
      });

      let trigger;
      if (sleep.asleep) {
        trigger = [
          `<此刻触发>现在是夜里 ${hour} 点前后，她在睡觉（作息：${sleep.note}）。`,
          '只写睡眠中极细微的事：翻了个身、半醒时听见窗外的声音、梦的碎片、把被子往上拉了拉，然后继续睡。',
          '绝不写起床、洗漱、出门、上班、做早饭——那些是别的时刻才会发生的事，写进去就是时间错乱。',
          '这一拍本来就没多少事，叙事写 120 字以上即可，不要为了凑字数去编清醒时的活动。',
        ].join('\n');
      } else {
        trigger = [
          '<此刻触发>现在是你自己的时间，没有新消息。',
          '请继续你正在过的生活（在家打游戏、发呆、洗漱、准备睡，或任何符合当下时间与作息的事），把这一段写足、写具体。',
        ].join('\n');
      }

      return this.#runTurn({
        trigger, userId: target, now, source: 'auto', seeded, urge,
        allowRealUser: urge.want,
      });
    });
  }

  /** 距上次和他说话过了多少分钟（没有则为 null） */
  #minutesSinceContact(userId, now = Date.now()) {
    const events = this.store.loadEvents();
    let lastAt = null;
    for (const e of events) {
      const isSay = e.kind === EventKind.SAY && (e.actors ?? []).includes(`u:${userId}`);
      const isFromHim = e.source === 'user';
      if (!isSay && !isFromHim) continue;
      const t = toMs(e.at);
      if (Number.isFinite(t)) lastAt = lastAt === null ? t : Math.max(lastAt, t);
    }
    if (lastAt === null) return null;
    return Math.max(0, (now - lastAt) / 60000);
  }

  async #runTurn({ trigger, userId, now, source, messageId = null, seeded = null, urge = null, allowRealUser = true }) {
    let stage = this.currentStage(userId);

    // 当前阶段还没有相处方式（新装的、或刚重置成通用模板）→ 先让世界 AI 演化一份
    if (this.relationshipCfg().autoEvolve !== false) {
      const seeded = await ensureStageContent({
        stageId: stage?.id,
        persona: this.persona,
        recentFacts: this.#recentFacts(),
        ...(this.llm ? { llm: this.llm } : {}),
      });
      if (seeded?.ok) {
        console.log(`  [关系演化] ${seeded.stageId} 相处方式已生成（${seeded.reason}）`);
        stage = this.currentStage(userId);
      }
    }

    // 到期播种事件先落账：主模型这才有书写这些外部事实的合法性
    const due = seeded ?? this.seeder.drainDue({ now });
    for (const s of due) console.log('  [世界事件]', s.summary);

    // 主动动机：没到份上就不许给他发消息（用户回合永远允许——人家都开口了）
    const contact = source === 'auto'
      ? (urge ?? { want: allowRealUser, motive: null, text: '' })
      : { want: true, motive: null, text: '他刚发了消息' };
    const canMessageUser = source === 'user' || contact.want;
    if (source === 'auto') {
      console.log(
        `  [主动] ${contact.want ? `想联系（${contact.motive}：${contact.text}）` : `不想联系（${contact.reason}）`}`
        + ` p=${contact.probability ?? 0}`,
      );
    }

    // ---- 阶段一：世界（story 路由）——判定发生了什么，不写她说了什么 ----
    const world = await this.narrator.run({
      trigger, userId, now, source, stage,
      windowText: this.cursor.renderWindow(now),
      worldText: [renderWorldSetting(), '', renderStoryRequirement()].join('\n'),
      maxRevision: this.config?.story?.maxRevision ?? 2,
    });

    // 提交世界事件（已过矛盾校验，或已强制修正）
    const committed = [];
    for (const e of world.events ?? []) {
      const rec = this.store.appendEvent({ ...e, source: e.source ?? source });
      committed.push(rec);
    }
    if (committed.length) this.timeline.commit(committed);

    // 散文是正片，必须落进时间轴——不然导出来的故事只剩干巴巴的摘要
    let narrationEvent = null;
    if (world.narration) {
      narrationEvent = this.store.appendEvent({
        at: toISO(now),
        kind: EventKind.NARRATION,
        place: this.timeline.currentPlace(now),
        actors: ['self'],
        summary: world.narration.slice(0, 60),
        prose: world.narration,
        source,
      });
      committed.push(narrationEvent);
    }

    // ---- 阶段二：对话（chat 路由）——基于已经确认无矛盾的状态说话 ----
    const recentSays = this.#recentSays();
    const dialogue = await this.dialogue.run({
      worldSummary: this.#worldSummary(committed, now),
      narration: world.narration,
      trigger,
      userId,
      now,
      recentSays,
      recentUserSays: this.#recentUserSays(),
      stage,
      contact,
      canMessageUser,
      maxRevision: 1,
    });

    // 出站（守卫拦下发往虚构角色的话；没到主动联系的时候，连真实用户也不发）
    const lint = styleLint(dialogue.utterances.map((u) => u.content), this.persona?.speech ?? {});
    const delivery = await this.outbox.deliver(dialogue.utterances, {
      source, entryId: committed[0]?.id ?? null, stage, allowRealUser: canMessageUser,
      blockReason: source === 'auto' ? `这一刻没有主动联系他的念头（${contact.reason ?? ''}）` : '',
    });

    // 她说出口的话也要进时间轴，否则下一轮没法做重复检测
    const said = [];
    for (const s of delivery.sent ?? []) {
      const rec = this.store.appendEvent({
        at: toISO(Date.now()),
        kind: EventKind.SAY,
        place: this.timeline.currentPlace(Date.now()),
        actors: ['self', s.addresseeId].filter(Boolean),
        summary: s.content.slice(0, 30),
        prose: s.content,
        source,
      });
      said.push(rec);
    }
    if (said.length) this.timeline.commit(said);

    // 印象增量（对话之后才更新）
    if (dialogue.impressionDelta) {
      this.impressions.applyDelta(userId, dialogue.impressionDelta, {
        entryId: said[0]?.id ?? committed[0]?.id ?? null,
        at: toISO(now),
      });
    }

    // 关系会随故事发展自然走近：分数够了就往前进一档（只会前进，不会自动倒退）
    const advanced = maybeAdvanceStage(this.impressions, userId);
    if (advanced) {
      console.log(`  [关系] ${advanced.from} → ${advanced.to}（感情态度随故事演进）`);
      // 关系走近了一档，相处方式也要跟着演化——由世界模型按最近发生的事重写，
      // 而不是沿用上一档的条款（上一档的「不表白」之类必须被改写掉）
      if (this.relationshipCfg().autoEvolve !== false) {
        const evolved = await evolveStageContent({
          stageId: advanced.to,
          persona: this.persona,
          recentFacts: this.#recentFacts(),
          ...(this.llm ? { llm: this.llm } : {}),
        });
        if (evolved?.ok) {
          console.log(`  [关系演化] ${evolved.stageId} 相处方式已按剧情重写（${evolved.reason}）`);
        } else if (evolved) {
          console.log(`  [关系演化] 未改写：${evolved.reason}`);
        }
      }
    }

    console.log(
      `[回合:${source}] 阶段一 事件 ${committed.length}（重写${world.revisions}${world.autoCorrected?.length ? ` 修正${world.autoCorrected.length}` : ''}）` +
      ` / 阶段二 发送 ${delivery.sent.length} 拦截 ${delivery.blocked.length}` +
      ` 去重 ${dialogue.repeats.length} / 限流 ${delivery.throttled?.length ?? 0}` +
      (lint?.score !== undefined ? ` / 文体 ${lint.score}分` : ''),
    );
    for (const v of world.violations ?? []) console.log('  [校验]', v.rule, v.message);
    for (const r of dialogue.repeats ?? []) console.log('  [去重]', r.content, '≈', r.matched);

    // 推进演化游标：下一轮从这里开始，绝不回退也不越过 now
    this.cursor.advance(Date.now());

    // 回合留痕
    this.store.recordTurn({
      source,
      userId,
      stage: stage?.id ?? null,
      seeded: due.map((s) => s.summary),
      contact: source === 'auto'
        ? { want: contact.want, motive: contact.motive, reason: contact.reason, probability: contact.probability }
        : { want: true, motive: 'reply', reason: '他发了消息' },
      narration: world.narration,
      events: committed.map((e) => e.id),
      delivered: delivery.sent,
      blocked: delivery.blocked,
      repeats: dialogue.repeats,
      violations: world.violations,
      revisions: world.revisions,
      autoCorrected: world.autoCorrected,
      lint,
    });

    return { ...world, dialogue, committed, said, delivery, lint, stage, contact, urge };
  }

  /**
   * 数据被外部换掉后（比如从备份恢复）重新装载，不用重启进程。
   * 缓存清掉、时间轴与游标按新事件重建。
   */
  reloadData() {
    return this.#serialize(() => this.#doReloadData());
  }

  #doReloadData() {
    invalidatePersona();
    invalidateConfig();
    this.persona = loadPersona();
    this.config = loadConfig();
    const events = this.store.loadEvents();
    this.timeline = new Timeline(events, Place.HOME);
    this.cursor = new StoryCursor(this.timeline.lastAt());
    // 各模块持有的是 timeline / cursor 的引用，一起换掉
    this.narrator.timeline = this.timeline;
    this.dialogue.timeline = this.timeline;
    this.seeder.timeline = this.timeline;
    this.seeder.cursor = this.cursor;
    this.narrator.persona = this.persona;
    this.dialogue.persona = this.persona;
    this.willingnessCfg = resolveWillingness(this.config?.reply ?? {}, this.config?.reply?.preset ?? 'normal');
    this.outbox.speech = this.persona?.speech ?? {};
    return { events: events.length, place: this.timeline.currentPlace(Date.now()) };
  }

  /** 关系配置（autoEvolve 决定是否让世界 AI 改写相处方式） */
  relationshipCfg() {
    return loadRelationship();
  }

  /** 最近真实发生过的事（关系演化的依据；控制台也能取用） */
  recentFacts(limit = 22) {
    return this.#recentFacts(limit);
  }

  #recentFacts(limit = 22) {
    return this.store.loadEvents()
      .slice(-limit)
      .map((e) => `- ${String(e.summary ?? e.prose ?? '').replace(/\s+/g, ' ').slice(0, 40)}`)
      .filter((x) => x.trim() !== '-')
      .join('\n');
  }

  /** 本轮世界状态摘要（给对话阶段看，已经过矛盾校验） */
  #worldSummary(committed, now) {
    const block = renderWorldBlock(this.timeline, now, { resolveName: nameResolver(this.registry) });
    const news = (committed ?? []).map((e) => `- ${e.summary ?? ''}`).filter((s) => s.trim() !== '-').join('\n');
    return `${block}\n\n<本轮刚发生的>\n${news || '（没有新的事）'}\n</本轮刚发生的>`;
  }

  /** 她最近说过的话（重复检测用） */
  #recentSays(limit = 40) {
    return this.store.loadEvents()
      .filter((e) => e.kind === EventKind.SAY)
      .slice(-limit)
      .map((e) => String(e.prose ?? e.summary ?? '').trim())
      .filter(Boolean);
  }

  /** 对方最近说的话：只有「收到消息」这种事件才是他说的话 */
  #recentUserSays(limit = 6) {
    return this.store.loadEvents()
      .filter((e) => e.source === 'user' && e.kind === EventKind.WORLD)
      .slice(-limit)
      .map((e) => String(e.prose ?? e.summary ?? '').trim())
      .filter(Boolean);
  }

  #primaryUserId() {
    const u = this.registry.byKind('real_user')[0];
    return u?.userId ?? null;
  }
}
