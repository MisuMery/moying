// 回合编排：用户消息回合与自动推进回合走**完全相同**的提交路径。
//
// HDS 把自动推进当成另一条代码路径，于是独立生活里写出的内容不受同一套约束，
// 「在忙吗」那种幻觉消息就是这么进来的。这里没有第二条路：两种回合都产出
// WorldEvent，都过 validateDrafts，都过 OutboundGuard。

import { cut } from '../text-safe.js';
import { Narrator } from './narrator.js';
import { commuteStep } from './commute.js';
import { DialogueNarrator } from './dialogue.js';
import { Timeline, EventKind, Place, isAway, PLACE_LABEL } from '../world/state.js';
import { toISO, localHour, localWeekday, toMs, fmtDate } from '../world/time.js';
import { renderWorldBlock, nameResolver } from '../world/view.js';
import { Outbox } from '../onebot/outbox.js';
import { styleLint } from '../style/enforce.js';
import { createRealUser } from '../cast/actors.js';
import { Inbox } from '../turn/inbox.js';
import { evaluateWillingness, resolveWillingness } from '../turn/willingness.js';
import { evaluateUrge } from '../turn/urge.js';
import { LongingStore } from '../turn/longing.js';
import { RateLimiter } from '../turn/ratelimit.js';
import { resolveStage, workSchedule, hourFloat, loadPersona, invalidatePersona } from '../persona/card.js';
import { maybeAdvanceStage, loadRelationship } from '../persona/relationship.js';
import { evolveStageContent, ensureStageContent } from '../persona/evolve.js';
import { StickerStore } from '../features/stickers.js';
import { describeImages } from '../vision/describe.js';
import crypto from 'node:crypto';
import { StoryCursor } from '../world/cursor.js';
import { WorldSeeder } from '../world/seeder.js';
import { renderWorldSetting, renderStoryRequirement } from '../world/world.js';
import { buildDailyDigest, renderDigest } from '../world/digest.js';
import { isHerSayToUser } from '../world/speech.js';
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

    // 牵挂：她有多想他。随时间自己涌上来，联系过后回落，主动判定由它调制
    // （见 turn/longing.js——原先只看「距上次说话多久」，她几乎从不主动）
    this.longing = new LongingStore(config?.longing ?? {});
    this.stickers = new StickerStore();
    this.outbox = new Outbox({
      client, registry, store, speech: persona?.speech ?? {}, rate: this.rate, stickers: this.stickers,
    });

    this.inbox = new Inbox({
      // 返回 Promise，便于调用方（与测试）等待这一轮真正跑完。
      // 这里只记录、必须重新抛出：Inbox 靠这个错误把消息放回队列重试。
      // 之前 .catch 吞成 resolved，inbox 的 requeue 永远不触发 ——
      // 2026-10-29 11:48 他发的「真的着凉了吗？」就卡在这条路径上：
      // 模型返回空 JSON → 回合抛错 → 错误被吞 → 消息彻底消失，没有重试也没有回复。
      onFlush: (userId, messages) => this.#flushUser(userId, messages)
        .catch((e) => {
          console.error('[flush] 回合失败:', e?.message ?? e);
          throw e;
        }),
    });

    // 回合互斥：自动推进的定时器与用户消息的 flush 可能同时触发，
    // 两个回合并发会互踩游标、把时间轴写穿（模型还会被两份提示词交叉轰炸）。
    // 所有会写世界的操作（回合、热重载）都排队串行执行。
    this.turnQueue = Promise.resolve();

    // 幂等：记住近期处理过的消息 id，拦掉 OneBot 重投的重复消息
    this.seenMessageIds = new Set();
    this._turnSeq = 0;
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
   * 关系阶段 → 亲密度 0~1（stranger=0 … attached=1）。
   * 门控用它决定"看到了要不要回"：依赖阶段的一条亲昵消息，不该被随机骰子丢掉。
   */
  #stageCloseness(userId) {
    const stage = this.currentStage(userId);
    const stages = this.relationshipCfg().stages ?? [];
    const idx = stages.findIndex((s) => s.id === String(stage?.id ?? ''));
    if (idx < 0 || stages.length < 2) return 0.5;
    return idx / (stages.length - 1);
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

  /**
   * 位置根因修复：班表驱动位置。
   * 工作日「应在公司/通勤」的窗口：上班前（含出门准备与通勤）+ 上班中 + 下班通勤缓冲。
   */
  #shouldBeAtOffice(now = Date.now()) {
    const sc = workSchedule(this.persona);
    const wd = localWeekday(now);
    if (!sc.workdays.includes(wd)) return false;
    const commuteH = (sc.commuteMinutes || 0) / 60;
    const h = hourFloat(now);
    return h >= sc.from - commuteH - 1 && h < sc.to + commuteH;
  }

  /**
   * 下班/非工作时段「该回家了」：与 #shouldBeAtOffice 对称的另一半。
   * 缺了这一段，她早上被同步到公司后就再也不会离开——下班后仍判在 office，
   * isBusy 恒真，晚上既不愿回消息，故事也卡在公司里出不来（2026-10-26 线上：
   * 20:34 他发消息被判「在忙」，p=0.48 不回，故事停在办公室）。
   * 规则：工作日过了下班+通勤缓冲，或非工作日（周末/节假日）——只要人还在公司/通勤，就该回家。
   */
  #shouldHeadHome(now = Date.now()) {
    const sc = workSchedule(this.persona);
    const wd = localWeekday(now);
    const h = hourFloat(now);
    const place = this.timeline.currentPlace(now);
    if (!isAway(place)) return false; // 已经在家

    // ① 深夜/凌晨：不管人在哪（公司、公园、商场、餐馆、办事……）都必须回家。
    // 这条必须放在最前面——否则「公司」分支会先 return，凌晨仍判「不该回家」，
    // 她就会像当初那个 bug 一样被钉在公司/外面过夜。
    if (h >= 23 || h < 7) return true;

    // ② 公司/通勤路上：下班（或根本不是工作日）就该回家
    if (place === Place.OFFICE || place === Place.TRANSIT) {
      if (!sc.workdays.includes(wd)) return true; // 非工作日还待在公司 = 遗留状态，送回家
      const commuteH = (sc.commuteMinutes || 0) / 60;
      return h >= sc.to + commuteH; // 工作日：下班（含通勤缓冲）之后
    }

    // ③ 其他外出地点（公园/商场/超市/餐馆/办事/聚会）：白天和傍晚不打断，交给叙事自己收尾
    return false;
  }

  /**
   * 按班表双向同步她的位置（只改时间轴，不花 LLM）。
   * - 该上班（工作日班段）且仍在家、无病假居家例外 → home→office
   * - 该下班（工作日下班后 / 非工作日）且仍滞留公司/通勤 → office|transit→home
   * 关键：既要在回合里调用，也要在「用户消息进门控之前」调用——否则 gate 用的是
   * 上一条回合留下的旧位置，晚上会一直判「在忙」而不回。
   */
  /** 落一条系统位移事件（只改时间轴，不花 LLM） */
  #commitMove(now, from, to, summary) {
    const moveEvt = {
      at: toISO(now), kind: EventKind.MOVE, from, to,
      actors: ['self'], summary, source: 'system',
    };
    this.store.appendEvent(moveEvt);
    this.timeline.commit([moveEvt]);
    console.log(`  [位置同步] ${from}→${to}（${summary}）`);
  }

  /**
   * 自动收藏他发来的表情包：识别结果为「表情包/梗图」的图片，存进她的表情库。
   * 去重（按图片内容 hash）+ 总量上限 300 + 每条消息最多收 2 张，避免刷屏式囤积。
   */
  #collectStickers(results = []) {
    try {
      const store = this.stickers;
      if (!store) return;
      const existing = store.all();
      if (existing.length >= 300) return;
      const hashes = new Set(existing.map((s) => s.hash).filter(Boolean));
      let collected = 0;
      for (const r of results) {
        if (collected >= 2) break;
        const dataUrl = r?.dataUrl;
        if (!dataUrl || !/表情包|梗图/.test(String(r.note ?? ''))) continue;
        const hash = crypto.createHash('sha1').update(dataUrl).digest('hex').slice(0, 16);
        if (hashes.has(hash)) continue;
        const mime = String(dataUrl).slice(5, String(dataUrl).indexOf(';')) || 'image/png';
        store.add({
          dataBase64: dataUrl,
          mime,
          desc: String(r.note).slice(0, 80),
          tags: ['自动收藏'],
          source: 'auto',
          hash,
        });
        hashes.add(hash);
        collected += 1;
      }
      if (collected) console.log(`  [收藏表情] 新增 ${collected} 张`);
    } catch (e) {
      console.log(`  [收藏表情] 失败：${String(e?.message ?? e).slice(0, 60)}`);
    }
  }

  /**
   * 按班表同步她的位置（只改时间轴，不花 LLM）。
   *
   * 通勤必须是**两步**：家 → 路上 → 公司（或 公司 → 路上 → 家），中间要有真实耗时，
   * 且「到达」必须在进入 transit 满 commuteMinutes 之后才允许。
   * 之前的实现一步 home→office 直接落死，导致「一出门就到公司」，世界阶段还会写出
   * 「出门去公司 / 出地铁站」和「已到公司」互相打架（2026-10-26 09:38 线上实例）。
   *
   * 关键：既要在回合里调用，也要在「用户消息进门控之前」调用，否则 gate 用的是旧位置。
   */
  #syncPlace(now = Date.now()) {
    const sc = workSchedule(this.persona);
    const place = this.timeline.currentPlace(now);
    const occ = this.timeline.occupancy();
    const cur = occ[occ.length - 1];
    const enteredAt = cur && Number.isFinite(cur.from) ? cur.from : now;

    const step = commuteStep({
      place,
      h: hourFloat(now),
      isWorkday: sc.workdays.includes(localWeekday(now)),
      sc,
      enteredHour: hourFloat(enteredAt),
      sinceEnter: now - enteredAt,
      homeException: this.#homeExceptionActive(now),
    });
    if (step) this.#commitMove(now, step.from, step.to, step.summary);
  }

  /**
   * 当天是否存在「她因故在家」的既定事实：生病/请假/临时居家办公。
   * 只扫当天的故事内事件（排除远端来信 e.remote），命中明确关键词才认定——
   * 避免把普通居家、别人一句「小心感冒」、或昨天的休息日叙事误判成例外。
   * 命中则不动她（保留病假/居家等合法情形）；未命中才由引擎把她同步到公司。
   */
  #homeExceptionActive(now = Date.now()) {
    const today = fmtDate(now);
    const keywords = ['请假', '病假', '发烧', '生病', '感冒', '居家办公', '生理期', '调休', '休班', '卧床'];
    const events = this.store.loadEvents().filter((e) => {
      if (e.remote) return false; // 远端来信（他说的话）不算「她在家」的既定事实
      const t = toMs(e.at);
      return Number.isFinite(t) && fmtDate(t) === today;
    });
    for (const e of events) {
      const text = `${e.summary ?? ''} ${e.prose ?? ''}`;
      if (keywords.some((k) => text.includes(k))) return true;
    }
    return false;
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

    // 幂等去重：OneBot 断线重连 / 重投会把同一条消息再发一次（messageId 相同）。
    // 在识图与落库之前拦掉——否则会触发重复回合、重复回复，还白调一次 vision/LLM。
    if (messageId != null) {
      const mid = String(messageId);
      if (this.seenMessageIds.has(mid)) {
        console.log(`[去重] 跳过重复消息 messageId=${mid}`);
        return { replied: false, reason: 'duplicate', probability: 0 };
      }
    }

    // 图片先真正「看」一遍：描述会写进事件与触发器。
    // 看不清就如实标注，绝不把占位符留给模型自由发挥。
    let imageNotes = [];
    let imageResults = [];
    if (Array.isArray(images) && images.length) {
      const results = await describeImages(images, {
        client: this.client,
        allowPrivateUrls: this.allowPrivateImageUrls,
        ...(this.llm ? { llm: this.llm } : {}),
      });
      imageResults = results;
      imageNotes = results.map((r) => r.note);
      console.log(`  [识图] ${images.length} 张 → ${imageNotes[0]?.slice(0, 40) ?? ''}`);
    }
    // 自动收藏：他发来的图被识别成「表情包/梗图」就存进她的表情库（去重 + 总量上限）。
    // 收藏后 renderForPrompt 才会把清单交给对话模型，她才用得上 [贴纸:id]。
    this.#collectStickers(imageResults);

    // 用户消息本身也是世界事件（真实外部事件，先落库）。
    // remote: true —— 他是隔着屏幕来的，不是推门进来的，绝不能据此推导「他在她身边」
    // 整段（含 nextId 取号）都排队：自动推进的回合可能正在跑（它会读时间轴快照做校验），
    // 队列外直接 commit 会让两边互踩；取号在队列外还会给并发消息发出重复 id
    // （2026-10-25 审查补漏）。
    let incoming = null;
    let duplicate = false;
    await this.#serialize(() => {
      // 权威判重：必须与「记已见 + 落库」在同一个串行区里原子完成。
      // 之前的检查在队列外——三条重投几乎同时到（间隔 81ms），都在对方记账之前通过了
      // 检查，结果同一条消息被存了 3 次（2026-10-27 线上：同一条 mid 被存了 3 次）。
      if (messageId != null) {
        const mid = String(messageId);
        if (this.seenMessageIds.has(mid)) {
          duplicate = true;
          return;
        }
        this.seenMessageIds.add(mid);
        // 超过上限按 FIFO 丢弃最旧的，避免长运行内存无限增长
        if (this.seenMessageIds.size > 2000) {
          const oldest = this.seenMessageIds.values().next().value;
          if (oldest !== undefined) this.seenMessageIds.delete(oldest);
        }
      }
      // 先按班表把她的位置同步到当下（该上班→公司 / 该下班→家），再落这条来信。
      // 这样门控里的 isBusy 用的是最新位置，也不会出现「晚上她明明该在家却被判在办公室忙」。
      this.#syncPlace(now);
      incoming = {
        id: this.store.nextId('e'),
        at: toISO(now),
        kind: EventKind.WORLD,
        place: this.timeline.currentPlace(now),
        actors: [`u:${userId}`],
        remote: true,
        summary: imageNotes.length
          ? `收到消息：${cut(String(text ?? ''), 24)}［图：${cut(imageNotes.join('；'), 40)}］`
          : `收到消息：${cut(String(text ?? ''), 30)}`,
        prose: String(text ?? ''),
        imageNotes,
        messageId: messageId ?? null,
        source: 'user',
      };
      this.store.appendEvent(incoming);
      this.timeline.commit([incoming]);
    });
    if (duplicate) {
      console.log(`[去重] 跳过重复消息 messageId=${messageId}`);
      return { replied: false, reason: 'duplicate', probability: 0 };
    }

    // 意愿门控：她想不想回、以及要过多久才回
    const hour = localHour(now);
    const busy = this.isBusy(now);
    const prev = this.willingness.get(userId) ?? {};
    // 亲密度：以前门控只看累积条数和随机数，attached（依赖）阶段的一条
    // "该睡觉了哦宝贝"也可能被 12.5% 的骰子丢掉。现在按关系阶段把亲密度喂进去。
    const closeness = this.#stageCloseness(userId);
    const verdict = evaluateWillingness(
      prev,
      {
        now, text, hour, busy,
        closeness,
        secondsSinceOwnSay: this.#secondsSinceOwnSay(now),
        // 连续被忽略几次：忙可以少回，但不能连着几条当没看见（见 willingness.js 的补偿）
        consecutiveIgnored: Number(prev.ignored ?? 0),
      },
      this.willingnessCfg,
    );
    this.willingness.set(userId, {
      score: verdict.score,
      updatedAt: now,
      ignored: verdict.shouldReply ? 0 : Number(prev.ignored ?? 0) + 1,
    });

    if (!verdict.shouldReply) {
      // 不回：这是正常的真人行为（忙、困、没看到），记账可回溯
      this.store.recordLedger({
        stage: 'gate',
        // 不是「发送失败」，是她这回没回：真人就是这样，忙、困、没看到
        status: 'not_replied',
        direction: 'in',
        addresseeId: `u:${userId}`,
        content: cut(String(text ?? ''), 60),
        reason: `她没回（${verdict.reason}，p=${verdict.probability}）`,
        source: 'user',
      });
      return { replied: false, reason: verdict.reason, probability: verdict.probability, asleep: verdict.asleep };
    }

    // 他找过她了：牵挂回落大半（她这会儿不用再惦记着主动找他）
    this.longing.markContact(userId, now);

    // 会回，但先攒一攒：连续几条消息合并成一个回合再一起回
    const pushed = this.inbox.push(userId, { text, messageId, at: now, imageNotes }, verdict.delayMs);
    return {
      replied: 'scheduled',
      // 用缓冲区的实际剩余时间：他还在连着发时这一串会被顺延，日志要跟上真实等待
      delayMs: pushed.delayMs ?? verdict.delayMs,
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
      ? `\n他发来的图片（你已经亲眼看过，下面是图片的真实内容）：\n${imgLines.map((x) => `- ${x}`).join('\n')}\n`
        + '回复时要自然地接住这张图本身（它画的是什么、想表达什么意思），别无视它，也别编造图里没有的东西。\n'
      : '';
    const trigger = texts.length === 1
      ? `<此刻触发>他发来一条消息：「${texts[0]}」\n${imgBlock}请继续你的生活，并决定要不要回复、回复什么。`
      : `<此刻触发>他连着发了几条：\n${texts.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n${imgBlock}` +
        `（这几条是一起看到的，不要一条一条分别回，像真人那样一次说清楚就好）`;

    return this.#runTurn({ trigger, userId, now: Date.now(), source: 'user' });
  }

  /**
   * 立刻回一条（控制台补发/演练用）。
   *
   * 与正常收消息的区别只有一处：**不新增「收到消息」事件**。他的原话早就在时间轴上
   * （当时因为没看到/赌气/忙而没回，过后补上），再写一条只会让世界层看到两条一模一样
   * 的消息。其余全走生产同一条路：同一个对话阶段、同样的话语归属、同样的拦截与限流。
   */
  async forceReply({ userId, text } = {}) {
    const target = userId ?? this.#primaryUserId();
    if (!target) return { skipped: '没有可回复的对象' };
    const said = String(text ?? '').trim();
    if (!said) return { skipped: '没有要回的内容' };
    return this.#flushUser(target, [{ text: said, at: Date.now() }]);
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
      // 牵挂先按真实流逝推进（睡觉时不累积），再拿它去判主动——
      // 这样「他一发消息就把她的主动性锁死」不再成立
      const busyNow = this.isBusy(now);
      const urgeCfg = this.config?.urge ?? {};
      const lg = this.longing.tick(target, {
        now,
        asleep: sleep.asleep,
        missAfterMinutes: urgeCfg.missAfterMinutes ?? 240,
      });
      // 他说过的原话：既是 urge 抽 hook/recall 的前置条件，也要原样摆给她
      const hisWords = this.#hisWords(8, now);
      const urge = evaluateUrge({
        cfg: urgeCfg,
        asleep: sleep.asleep,
        busy: busyNow,
        hour,
        longing: lg.value,
        minutesSinceContact: this.#minutesSinceContact(target, now),
        minutesSinceOwn: this.longing.minutesSinceOwn(target, now),
        stageId: stage?.id,
        hasNews: (seeded?.length ?? 0) > 0,
        // 他要引用「你说过的」，就得先真的把原话摆出来（见 #hisWords）
        hisWords,
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
          // 时间轴里可能躺着一条他发来、她还没回的消息。这一拍只推进生活，不许顺手"回掉"——
          // 回不回由门控和对话阶段决定（2026-10-29 22:41 线上：门控判了不回，两分钟后 auto 推进
          // 却写"她删改几次后回了过去"，他手机上一条都没有）。
          '若时间轴里有他发来、你还没回的消息：这一拍可以写你看到了、拿起来看了一眼、想回又放下，'
            + '但绝不许写你已经回了过去、发了出去——那是对话阶段才决定的事，这里写了就发不出去。',
          // 这里原先写死了「在家打游戏、发呆、洗漱、准备睡」当例子——
          // 模型于是反复写打游戏（2026-10-25 线上观察：主动消息七成都是游戏进度）。
          // 现在只给原则，素材交给角色卡里的兴趣与作息。
          '请按她自己的兴趣、作息和当前钟点，继续她正在过的生活，把这一段写足、写具体。',
          '取材从她整个生活里来：手上正在做的、今天已经做过的、接下来要做的、忽然想起的念头、身体上的感受都算；不要总是同一件事。',
          // 上班时段本来就没那么多可讲的事。以前不论什么时刻都要求写足 500~900 字，
          // 模型只能靠铺陈细节凑数——那是「叙事复读」的一大来源（同一盏落地灯写十几遍）。
          busyNow
            ? '（她这会儿在上班/路上：这一拍多半只是工作里的一小段，写 200~350 字就够，不要为了凑篇幅去编大段描写。）'
            : '',
        ].filter(Boolean).join('\n');
      }

      // 她想主动找他时，把动机也告诉世界阶段——否则叙事里她在发呆，
      // 下一段对话却突然冒出一句「在干嘛」，故事和消息对不上。
      // 只写她怎么想到他、拿起手机、犹豫打字的过程，那句话本身仍由对话阶段产出。
      if (urge.want && urge.text && !sleep.asleep) {
        trigger += `\n（她这会儿自己想给他发一句：${urge.text}。`
          + '叙事里可以写她怎么想到他、怎么拿起手机、怎么犹豫打字——但那句话本身不许写出来。'
          + '她要说的必须是**具体的一件事**：哪句话、哪样东西、哪个时刻。'
          + '绝不许笼统地说「昨天的事」「之前聊的那个」「那件事」——那种空话他接不住，下一轮也没法接。）';
        // 给她手边摆几件「真的发生过、可以说」的具体事。
        // 2026-10-28 早上的教训：只说「要具体」没用——她真的没有素材，就编出
        // 「昨天说的事 我都记得」这种空话，他一追问就接不住，只能回「嗯/刚醒」。
        const dg = buildDailyDigest(this.store.loadEvents(), now, { nameOf: nameResolver(this.registry) });
        const picks = [
          ...(dg?.days?.[dg.today] ?? []).slice(-5),
          ...(dg?.days?.[dg.yesterday] ?? []).slice(-4),
        ].filter((x) => x && !x.startsWith('她对他')).slice(-6);
        if (picks.length) {
          trigger += `\n她手上真能说的具体事（挑一件说，别编空话）：\n${picks.map((x) => `- ${x}`).join('\n')}`;
        }
        // 主动引用「他说过的话」时，把原话原样摆出来——这是他唯一可引用的过去。
        // 没有清单就不许引用，避免又编出「上周说的」这种不存在的约定。
        if (['hook', 'recall'].includes(urge.motive)) {
          trigger += hisWords.length
            ? `\n他说过的话（**只有这些是真的**，要引用就从句子里挑一句具体的；没列在这里的，一句都不许说成他说过，更不许说成「说好的」「约好的」）：\n`
              + hisWords.map((w) => `- [${w.label}] 「${w.text}」`).join('\n')
            : '\n（他最近没留下什么可引用的话——不要提「你之前说的」「我们约好的」这类过去，换个由头说。）';
        }
      }

      const res = await this.#runTurn({
        trigger, userId: target, now, source: 'auto', seeded, urge,
        allowRealUser: urge.want,
      });
      // 真的发出去了才算「她主动找过他」：牵挂清空，冷却开始计时。
      // 被限流/没生成出来时不算，下一次机会还在。
      if ((res?.delivery?.sent?.length ?? 0) > 0) {
        this.longing.markOwn(target, now);
        console.log(`  [主动] 已发出（${urge.motive ?? '主动'}），牵挂归零`);
      }
      return res;
    });
  }

  /** 距上次和他说话过了多少分钟（没有则为 null） */
  /**
   * 她上一次开口到现在过了多少秒——用来判断「还在聊」：
   * 她刚说过话时，对方秒回她也应该回得快，而不是像重新建立联系那样慢慢来。
   */
  #secondsSinceOwnSay(now = Date.now()) {
    let last = null;
    for (const e of this.store.loadEvents()) {
      if (e.kind !== EventKind.SAY) continue;
      if (!Array.isArray(e.actors) || !e.actors.includes('self')) continue;
      const t = toMs(e.at);
      if (Number.isFinite(t)) last = last === null ? t : Math.max(last, t);
    }
    return last === null ? null : Math.max(0, (now - last) / 1000);
  }

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

  /**
   * 行程到期落账：arriveAt 一过就补一条「到了」的事实。
   * 出发由模型发起、到达由程序决定——这样它写得了「刚上车」，写不了「我到公司了」。
   */
  #settleJourneys(now = Date.now()) {
    const events = this.store.loadEvents();
    let last = null;
    for (const e of events) if (e.kind === EventKind.MOVE) last = e;
    if (!last?.id) return;
    const arr = toMs(last.arriveAt);
    if (!Number.isFinite(arr) || arr > now) return;
    const idx = events.lastIndexOf(last);
    // 之后又有新的出发（换乘/改道），这段不补，交给新行程
    if (idx >= 0 && events.slice(idx + 1).some((e) => e.kind === EventKind.MOVE)) return;
    // 已结算过
    if (events.some((e) => e.settlesMoveId === last.id)) return;

    const to = last.to ?? last.place;
    if (!to) return;
    const rec = this.store.appendEvent({
      at: toISO(arr),
      kind: EventKind.ACT,
      place: to,
      actors: [],
      summary: `到了${PLACE_LABEL[to] ?? to}`,
      prose: '',
      source: 'auto',
      settlesMoveId: last.id,
    });
    this.timeline.commit([rec]);
    console.log(`  [行程] ${last.mode ?? ''} ${last.minutes ?? '?'} 分钟，已到${PLACE_LABEL[to] ?? to}`);
  }

  async #runTurn({ trigger, userId, now, source, messageId = null, seeded = null, urge = null, allowRealUser = true }) {
    const turnId = (++this._turnSeq).toString(36).toUpperCase().padStart(4, '0');
    let stage = this.currentStage(userId);

    // 行程结算：到点了就把「抵达」落成事实。
    // 不这么做的话，模型一忘写 move，她就永远卡在「路上」——而它并没有义务记得。
    this.#settleJourneys(now);

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

    // ---- 位置根因修复：班表驱动位置（双向：上班去公司 / 下班回家）----
    // 让「当前事实块」显示她此刻真实所在地，模型据此续写；病/假居家等例外由 #syncPlace 内部保留。
    this.#syncPlace(now);

    // ---- 阶段一：世界（story 路由）——判定发生了什么，不写她说了什么 ----
    const world = await this.narrator.run({
      trigger, userId, now, source, stage,
      windowText: this.cursor.renderWindow(now),
      // 窗口分钟数一并给到叙事篇幅校验：窗口短就不逼着凑字数，
      // 否则模型为了填满 400 字只能往这段时间里硬塞事件（时间压缩的发动机）
      windowMinutes: this.cursor.window(now).spanMinutes,
      // 每日记忆：让她记得今天做过什么、昨天聊过什么（此前跨半天就断片）
      worldText: [renderWorldSetting(), '', renderStoryRequirement(), '',
        renderDigest(buildDailyDigest(this.store.loadEvents(), now, { nameOf: nameResolver(this.registry) }))].filter(Boolean).join('\n'),
      maxRevision: this.config?.story?.maxRevision ?? 2,
    });

    // 提交世界事件（已过矛盾校验，或已强制修正）
    const committed = [];
    for (const e of world.events ?? []) {
      const rec = this.store.appendEvent({ ...e, source: e.source ?? source });
      committed.push(rec);
    }
    if (committed.length) this.timeline.commit(committed);
    // T（时间锚定）是无条件执行的，每条事件都会命中一次——把它算进「修正」会让日志永远
    // 「修正=事件数」，真正的时间倒流 / 地点矛盾被淹在里面看不见。分开计数。
    const corrAll = world.autoCorrected ?? [];
    const timeOnly = corrAll.filter((c) => c.rule === 'T').length;
    const realFix = corrAll.length - timeOnly;
    console.log(`[T:${turnId}] 阶段一·世界 事件=${committed.length} 散文=${world.narration ? '有' : '无'} 修正=${realFix}（另有 ${timeOnly} 条时间锚定）`);

    // 散文是正片，必须落进时间轴——不然导出来的故事只剩干巴巴的摘要
    let narrationEvent = null;
    if (world.narration) {
      narrationEvent = this.store.appendEvent({
        at: toISO(now),
        kind: EventKind.NARRATION,
        place: this.timeline.currentPlace(now),
        actors: ['self'],
        summary: cut(world.narration, 60),
        prose: world.narration,
        source,
      });
      committed.push(narrationEvent);
    }

    // ---- 阶段二：对话（chat 路由）——基于已经确认无矛盾的状态说话 ----
    const recentSays = this.#recentSays();
    // 对话阶段的「过去锚点」：他真实说过的原话。她要是提「上次你说的」，只能来自这里。
    const pastAnchors = this.#hisWords(10, now);
    const dialogue = await this.dialogue.run({
      worldSummary: [this.#worldSummary(committed, now), this.#digestText(now)].filter(Boolean).join('\n'),
      narration: world.narration,
      trigger,
      userId,
      now,
      recentSays,
      recentConversation: this.#recentConversation(now),
      pastAnchors,
      stage,
      contact,
      canMessageUser,
      maxRevision: 1,
      // 他直接发来的私聊消息（意愿门控已判定她要回）：阶段二必须产出回复，
      // 杜绝「叙事说她回了、QQ 上却没发」的断聊（2026-10-26 线上：11:35 他发消息后 0 发送）。
      requireReply: source === 'user',
    });
    console.log(`[T:${turnId}] 阶段二·对话 utterances=${dialogue.utterances?.length ?? 0} 重复=${dialogue.repeats?.length ?? 0}`);

    // 出站（守卫拦下发往虚构角色的话；没到主动联系的时候，连真实用户也不发）
    const lint = styleLint(dialogue.utterances.map((u) => u.content), this.persona?.speech ?? {});
    const delivery = await this.outbox.deliver(dialogue.utterances, {
      source, entryId: committed[0]?.id ?? null, stage, allowRealUser: canMessageUser,
      blockReason: source === 'auto' ? `这一刻没有主动联系他的念头（${contact.reason ?? ''}）` : '',
    });
    if ((delivery.sent?.length ?? 0) === 0) {
      const flag = source === 'user' ? ' ⚠️他发了消息却仍未发出（断线防护应已拦截此情况）' : '';
      console.log(`[T:${turnId}][未发送] 本回合未发出任何消息（拦截=${delivery.blocked?.length ?? 0}，utterances=${dialogue.utterances?.length ?? 0}）${flag}`);
    }
    // 拦截明细要落到日志里：只报个数量的话，「回复量变少」根本查不出是发不出去还是没生成
    for (const b of (delivery.blocked ?? []).slice(0, 4)) {
      const u = b.utterance ?? {};
      console.log(`  [拦截] ${b.code} → ${u.addresseeId ?? '?'}：「${String(u.content ?? '').slice(0, 20)}」`);
    }

    // 她说出口的话也要进时间轴，否则下一轮没法做重复检测
    const said = [];
    for (const s of delivery.sent ?? []) {
      const rec = this.store.appendEvent({
        at: toISO(Date.now()),
        kind: EventKind.SAY,
        place: this.timeline.currentPlace(Date.now()),
        // speaker/to 必须落库：读取端（会话记录、重复检测、每日记忆）全靠这两个字段
        // 分辨「她对他说的」和「林夏对她说的」。以前这里只写了 actors，
        // 于是她真正发出去的话在时间轴上是「没有说话人的台词」，被推断成
        // 「她对身边的人说」——聊天记录里只剩他单方面在说话。
        speaker: 'self',
        to: s.addresseeId,
        actors: ['self', s.addresseeId].filter(Boolean),
        summary: cut(s.content, 30),
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
      `[回合:${source}][T:${turnId}] 阶段一 事件 ${committed.length}（重写${world.revisions}${world.autoCorrected?.length ? ` 修正${world.autoCorrected.length}` : ''}）` +
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

    // 羁绊累积：关系靠「一起经历过什么」往前走，而不是靠几句好话。
    // ① 她生活里真的想起他（世界阶段判定）② 这次真的和他说上话了（发出去才算）。
    // 每天有上限，聊再多也不会一夜之间把关系刷满。
    const bondGain = (Number(world?.bondDelta) || 0) + ((delivery.sent?.length ?? 0) > 0 ? 1 : 0);
    if (bondGain > 0) {
      const before = this.impressions.bondOf(userId);
      this.impressions.addBond(userId, bondGain, now);
      const after = this.impressions.bondOf(userId);
      if (after !== before) console.log(`  [羁绊] ${before} → ${after}（+${after - before}${Number(world?.bondDelta) ? '，她想起他了' : ''}）`);
    }

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
      .map((e) => `- ${cut(String(e.summary ?? e.prose ?? '').replace(/\s+/g, ' '), 40)}`)
      .filter((x) => x.trim() !== '-')
      .join('\n');
  }

  /**
   * 本轮世界状态摘要（给对话阶段看，已经过矛盾校验）。
   *
   * 2026-10-29：includeSays 必须关。这一块会把当日台词逐条列出来
   * （「林夏对她说：要不要再开一罐汽水」），聊天模型看到后直接把它写成发出去的消息，
   * 用户就收到一句「林夏问我要不要开汽水」。生活线（动作/地点）和聊天线（消息）
   * 从这一层就分开，对话阶段只拿动作线。
   */
  #worldSummary(committed, now) {
    const block = renderWorldBlock(this.timeline, now, {
      resolveName: nameResolver(this.registry), includeSays: false, compact: true,
    });
    const news = (committed ?? [])
      .filter((e) => e.kind !== EventKind.SAY) // 台词不进「刚发生的事」，那是聊天线的事
      .map((e) => `- ${e.summary ?? ''}`)
      .filter((s) => s.trim() !== '-')
      .join('\n');
    return `${block}\n\n<刚才这几分钟（旁白里发生的事，不是消息）>\n${news || '（没有新的事）'}\n</刚才这几分钟>`;
  }

  /** 每日记忆：今天/昨天发生过什么（对话阶段也要知道，才能自然提起以前的事）。
   *  对话阶段只要「她做过的事」，不要台词——见 #worldSummary 的说明。 */
  #digestText(now = Date.now()) {
    const dg = buildDailyDigest(this.store.loadEvents(), now, {
      nameOf: nameResolver(this.registry), includeSays: false,
    });
    return renderDigest(dg, { actsOnly: true });
  }

  /** 她最近「真正发给他」的话（重复检测用）。
   *  用 speaker/to 判定，而不是「actors 里有没有 u:」——
   *  后者分不清「她对林夏说」和「林夏对她说」，也分不清配角的台词。 */
  #isHerRealSay(e) {
    if (e.kind !== EventKind.SAY) return false;
    return isHerSayToUser(e, { nameOf: nameResolver(this.registry) });
  }

  /** 她最近说过的话（重复检测用） */
  #recentSays(limit = 40) {
    return this.store.loadEvents()
      .filter((e) => this.#isHerRealSay(e))
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

  /** 「今天 09:41」「昨天 21:07」「10-26 20:11」——给她看时间，但不让她自己算 */
  #timeLabel(withAt, now = Date.now()) {
    const t = toMs(withAt);
    if (!Number.isFinite(t)) return '';
    const d = new Date(t);
    const n = new Date(now);
    const sameDay = (a, b) => a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (sameDay(d, n)) return `今天 ${hm}`;
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    if (sameDay(d, y)) return `昨天 ${hm}`;
    return `${d.getMonth() + 1}-${d.getDate()} ${hm}`;
  }

  /**
   * 他说过的原话（带相对时间），最近 maxDays 天。
   *
   * 2026-10-29 事故：她主动发「晚上旧书摊还去不」，被问「啊？我吗」后答「不然喃 / 上周说的」——
   * 时间轴里从来没有这个约定，所谓「上周说的」是她自己编的。
   * 根因：urge 的 hook / recall 动机要求她「引用他说过的某句话」，但触发时从没把原话摆出来，
   * 模型没有素材只能现编。这里把他真实说过的话整理成清单，作为**唯一**可引用的过去。
   */
  #hisWords(limit = 8, now = Date.now(), maxDays = 7) {
    const cutoff = now - maxDays * 86400000;
    return this.store.loadEvents()
      .filter((e) => e.source === 'user' && e.kind === EventKind.WORLD)
      .filter((e) => {
        const t = toMs(e.at);
        return Number.isFinite(t) && t >= cutoff;
      })
      .map((e) => ({
        at: e.at,
        text: String(e.prose ?? e.summary ?? '')
          .replace(/^收到消息[:：]\s*/, '')
          .replace(/^\[引用消息\]\s*/, '')
          .trim(),
      }))
      .filter((x) => x.text && !/^\[(图片|表情|贴纸)/.test(x.text) && x.text.length >= 2)
      .slice(-limit)
      .map((x) => ({ ...x, label: this.#timeLabel(x.at, now) }));
  }

  /**
   * 最近对话（按时间交错：他一句、她一句）——给对话阶段当「会话记录」用。
   * 之前对话阶段拿到的是「他的最后 6 句」和「她的最后 14 句」两块各自独立的列表，
   * 模型得自己脑补谁在哪一刻说了什么，来回几轮后极易接错话、答非所问
   * （2026-10-26 线上：她刚说「看到篇推文写广告公司摸鱼指南」，他问「学会了吗」，
   * 她却回「我都不晓得你要我学啥了」——把话题错连到更早的对话）。
   * 改成一份交错的时间线，模型一眼就能看清「她说了 X、他回了 Y」。
   *
   * 关键约束（2026-10-26 修复）：「她说的」只认真正发给他（actors 带真实用户 u: 收件人）的 SAY。
   * 世界 AI 在阶段一叙事里也会写出 SAY 事件（同事说/陈哥说/她自言自语），这些不是她发给他的话，
   * 若混进会话记录，聊天 AI 会把场景台词当成她对他讲过的话，导致答非所问、语境错乱。
   * 同时按真实时间排序，避免 UTC(Z) 与北京时间(+08:00) 两种时间戳混排错序。
   */
  #recentConversation(now = Date.now(), limit = 20) {
    // 时间窗：只保留最近 contextWindowMinutes 分钟内的对话，更早的陈旧消息自动脱落，
    // 避免「几小时前的话题」污染当下这一轮的回复（例如上午 09:42 的闲聊混进 11:01 的回复，
    // 让模型把「学会了吗」错连到更早的对话）。窗口长度可在 config.story.contextWindowMinutes 调。
    const windowMin = Number(loadConfig()?.story?.contextWindowMinutes) || 60;
    const cutoff = now - windowMin * 60 * 1000;
    return this.store.loadEvents()
      .filter((e) => {
        if (this.#isHerRealSay(e)) return true;                            // 她真正发给他的话
        if (e.source === 'user' && e.kind === EventKind.WORLD) return true; // 他发的
        return false;
      })
      .filter((e) => {
        const t = toMs(e.at);
        return Number.isFinite(t) && t >= cutoff;
      })
      .sort((a, b) => toMs(a.at) - toMs(b.at)) // 按真实时间排序，避免 +08:00/UTC 混排错序
      .map((e) => {
        let text = String(e.prose ?? e.summary ?? '').trim();
        // 图片消息：历史里也要带上「真正看过」的描述，否则过一两轮就只剩 [图片] 占位符，
        // 她会彻底忘掉那张图是什么，只能含糊其辞（2026-10-26 线上：「有点像你以前发过的那只」）。
        const notes = Array.isArray(e.imageNotes) ? e.imageNotes.filter(Boolean) : [];
        if (notes.length) {
          const base = text.replace(/\[图片\]/g, '').trim();
          text = `${base ? `${base} ` : ''}［图片：${notes.join('；')}］`;
        }
        return { at: e.at, role: this.#isHerRealSay(e) ? '她' : '他', text };
      })
      .filter((x) => x.text)
      .slice(-limit)
      .map((x) => `[${x.role}] ${x.text}`);
  }

  #primaryUserId() {
    const u = this.registry.byKind('real_user')[0];
    return u?.userId ?? null;
  }
}
