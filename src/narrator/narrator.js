// 叙事生成：模型写稿 → 程序校验 → 不合格就带着违规点回灌重写。
//
// 与 HDS 最大的不同：模型必须输出**结构化世界事件**，散文只是附带的渲染文本。
// 状态由 events 决定，prose 不参与任何状态推导 —— 这样「下午出门两次」这种
// 矛盾能被 validateDrafts 直接查出来，而不是等用户读故事时才发现。

import { cut, tail } from '../text-safe.js';
import { callLLM } from '../llm/gateway.js';
import {
  validateDrafts, validateNarration, sanitizeNarration, sanitizeOwnSays, narrationTooShort, Severity, REPLY_MARKERS,
} from '../world/validator.js';
import { renderWorldBlock, nameResolver } from '../world/view.js';
import { Timeline, Place, EventKind, PLACE_VOCAB } from '../world/state.js';
import { resolveSpeech } from '../world/speech.js';
import { toISO, toMs } from '../world/time.js';
import { planMove, renderKnownRoutes } from '../world/travel.js';
import {
  renderIdentity, renderSpeechRules, renderRedlines, renderCast, retrieveTraits, renderLivingRules,
  renderRelationshipAnchor, renderResponsePatterns, renderVagueness, renderKnowledgeBoundary,
  renderNarrative, renderScheduleExpectation, renderGeography,
} from '../persona/card.js';
import { renderRelationship } from '../persona/relationship.js';
import { localHour } from '../world/time.js';

// 世界阶段（story 路由）只判定「世界里发生了什么」——
// 她在哪、在做什么、其他角色什么状态。她说什么话由下一阶段的对话模型负责，
// 这一阶段不要输出任何话语，也不要替她决定回复内容。
export const CONTRACT = `你必须只输出一个 JSON 对象，不要有任何额外文字，结构如下：
{
  "narration": "这一段生活的**完整叙事**，是给人读的正片：从一个具体动作或身体感受开始，写感官细节（光、声音、温度、触感），写她的心理活动但一律落在身体反应上（指尖、咬嘴唇、喉结、胸口那块），写配角自己的动作和台词；涉及手机要写完余波（震动→有没有立刻看→看完那几秒→怎么犹豫、删改、最后按下发送→发完把手机放哪）。**她打出去的原话不许写出来**——那句话由对话阶段决定，写出来就会和真正发给他的是两句不一样的话（引述他发来的消息、配角的台词不受此限）。篇幅按上面的要求，可以多段。结尾停在一个动作或一句没说完的话上，允许留白。",
  "bondDelta": 0,
  "events": [
    {
      "at": "2026-10-24T10:27:00Z",
      "kind": "move | act | say | world",
      "from": "仅 move 需要：出发地（用下面地点词表里的 id，且必须等于她此刻实际所在地）",
      "to": "仅 move 需要：目的地（用下面地点词表里的 id）",
      "mode": "仅 move 需要：怎么去的——walk | bike | bus | metro | taxi | train | plane",
      "minutes": "仅 move 需要：这段路大概要多少分钟。按真实通勤估，别为了赶剧情写短",
      "place": "非 move 需要：所在地点（用下面地点词表里的 id）",
      "speaker": "仅 say 需要：这句话是谁说的——她说写 self，配角说写 c:xxx",
      "to": "仅 say 需要：说给谁——对配角说写 c:xxx，自言自语留空；绝不许写 u:（对「他」说的话不在这阶段写）",
      "actors": ["c:roommate"],
      "span": { "from": "...", "to": "..." },
      "remote": false,
      "summary": "一句话摘要（会进入时间轴，务必简短）",
      "durationMinutes": "持续动作才需要：这件事大概占用多少真实分钟（试衣服/喝奶茶/逛店/排队/做饭/洗澡/等车/化妆……）。瞬时动作（说一句、看一眼、拿起手机）不填或填 0。按真实生活估，别为了赶剧情写短。"
    }
  ]
}

bondDelta —— 这一段生活里，她有没有**真的想起过他**（不是提到手机就算）：
- 给 1：梦见他、想起他说过的某句话、下意识去摸手机看他有没有找她、看到什么就想到他、心里惦记着他睡没睡/吃没吃。
- 给 0：只是普通地过日子，手边的事、别的角色、工作、家务，压根没想起他。
这是关系推进的唯一剧情来源——她想起他一次，两人之间就多走一步；没想起就不走，不要为了凑数硬给。

narration 与 events 的分工（不要搞反）：
- narration 是**给人读的正片**，要写足、写细、写具体；它不参与任何状态判定。
- events 是**状态真相**，只写结构化事实；summary 一句话即可，不要在这里展开描写。

注意：
- 本阶段不写她说了什么话（utterances 由后续对话阶段产出），也不要在这里替她构思回复。
- **叙事里不许出现她打给他、发给他、回给他的原话**（引号里的内容一律不行）。**更不许写「她已经发出去了」这个结果**——「按下发送」「发了出去」「回了过去」「回了他一句」这类"已发送"的收尾一律不许写。她拿起手机、盯着输入框、删改、犹豫、想发又停住、最后把手机扣回去，这些过程都可以写；但"发没发出去、发了什么"由后面的对话阶段决定。这里写成"已发送"，就会出现"故事里她回了、他手机上却没消息"的断裂（2026-10-29 22:41 线上）。引述「他」发来的消息、配角当场说的话不受此限。
- **say 事件只写两类**：① 配角自己说的话（actors 写那个配角的 c:xxx）；② 她对配角说的话（actors 写 ["self","c:xxx"]）。她要说给「他」的话一律不许出现在这里——那部分由对话阶段产出，两边各写一句就会打架，最后发出去的话和她此刻的生活对不上。
- **say 事件必须写清 speaker 和 to**：是「林夏说的」还是「她说的」，是说给谁的。
  speaker 只填 self 或 c:xxx，to 只填 c:xxx 或留空。
  这一项写错，记忆里就会把别人的话安到她身上（或把她的话安到别人身上），越引越歪。
  例：林夏问她「你咋回来了」→ { kind:"say", speaker:"c:linxia", to:"self", actors:["c:linxia","self"] }；
      她答林夏「有点不舒服」→ { kind:"say", speaker:"self", to:"c:linxia", actors:["self","c:linxia"] }。
- **actors 只写「在场的人」**，不承担「谁说的」这个含义——谁说的看 speaker。
- 只写已经发生的事实，不写计划、不写推测、不预言未来。
- **已经发生过的信息交换不许再来一遍**：配角问过的事（比如室友已经问过她「跟谁聊」、她已经答过）就写进 events 当事实定下来，这一段不许再问第二次、也不许她再答第二次——那会显得人物失忆。
- **角色之间的关键问答必须落成 event**（kind=act 或 say，actors 带上那个角色，summary 写清「谁问了什么 / 得到什么回答」）。这是下一段接续的唯一依据：不写下来，下一段就不知道这件事已经发生过，又会重复一遍。
- 时间不得倒流，也不得超过当前时间；move 的 from 必须等于她那一刻实际所在地点。
- **事件的 at 只是参考，落库时程序一律以服务器当前时间为准重打，你不必精确估时；格式用 UTC（结尾 Z），不要写 +08:00。**
- **事件时间写到分钟即可**（不要带秒）；会比下面给的「此刻」早零点几秒不算倒流，程序按同一时刻处理，不用紧张。
- move 只用于**她自己**的位移（同行的其他人写进 actors，她自己不用写）；其他角色的移动用 act 表达，place 填该角色此刻所在的地方（例：「室友出门上班」→ kind=act、actors=["c:roommate"]、place="office"）。

**持续动作要带 durationMinutes（事件里的数字字段）**：只要是一段需要时间的事（试衣服、喝奶茶、逛街、排队、做饭、洗澡、等车、化妆……）就填上大概占多少分钟。这一条决定她接下来多久都「在忙这件事」——程序会用它算出她「正在做这件事」的时间段，这段时间她能继续这件事、能分心想别的，但不能凭空「做完了」。别为了把剧情往前赶就把所有事都写成一瞬间完成。

<可填的地点（from / to / place 只能填这里的 id，不要自己造中文地名）>
${PLACE_VOCAB}
</可填的地点>

<她的生活不该只有家和公司>
她活在真实都市里：要买菜、要吃饭、要取快递、要逛商场、要在公园或江边走一圈、要办杂事，周末和下班后更是这样。
工作日白天在公司上班，但午休可以下楼买饭、下班可以顺路去超市或约同事吃个饭再回家；休息日可以在家赖着，也可以出门逛逛。
只要她真的挪了地方，就必须用 move 把「从哪到哪」写清楚（例如 home→market 买菜、market→home 回家、office→food 下班去吃饭、food→home 吃完回家），并且写上 mode（怎么去的）和 minutes（大概多少分钟）。
路程要多久由程序核对：走过一次的路线会记住，下次不能突然缩短；没写过的新地方按你给的分钟数算。
所以**不要把一整段通勤塞进一次回复里**：刚上车就写车厢里的事，说「还有几站」；到没到由时间算，不由你写——时间没到，她就在路上，写不了「到了」「下车了」「进公司了」。
不要让她一整天只在家和公司两点之间来回——那不是真实的生活。
</她的生活不该只有家和公司>
- 叙述里不许出现和这一刻不符的钟点（不许「现在七点了」这种说法，除非现在真的是七点）。
- **不许凭空预设既有事实**：不许写「那家旧书店」「上次说好的」「之前那个」这类默认已经存在的人、地点、约定。
  第一次出现的东西就是第一次出现——写清楚它是什么、从哪来的（「路过一家旧书店」「刷到有人晒旧书」）。
  时间轴里没有的约定，不许在叙事里说成「已经约好」。
- **不要写她和他线下碰面的事**（你们不在同一座城市）：不许写「他来了」「她去他那边」「两人一起去哪儿」。
  她能做的只有发消息、打电话、寄东西、以后有机会再见一面。
- **不许把不住在她那儿的人写进居家场景**：不许写「一起回去」「买回去下饭」「回他家」「留他吃饭」这类情节。
  谁跟她住在一起，见上面「谁住在你那儿」；不在名单里的人，只能同路走一段，到该分开的地方就各走各的。
- actors 里提到她自己时一律用 "self"，**不要写她自己的名字**；其他角色用上面给的 c:xxx 标识。`;

function systemPrompt({ persona, impression, registry, stage, hour, now }) {
  const castIds = registry.fictionalCast().map((a) => `${a.id}（${a.displayName}）`).join('、');
  return [
    renderIdentity(persona),
    '',
    impression,
    '',
    // 关系（锚点 + 当前阶段 + 这个阶段能说什么）紧跟印象：先讲清亲密的边界，再讲怎么说话
    renderRelationship(impression, stage),
    '',
    renderSpeechRules(persona, stage, hour),
    '',
    renderResponsePatterns(persona),
    '',
    renderVagueness(persona),
    '',
    renderKnowledgeBoundary(persona),
    '',
    renderGeography(persona),
    '',
    renderRedlines(persona, stage),
    '',
    now ? renderScheduleExpectation(persona, now) : '',
    '',
    renderCast(persona),
    '',
    renderLivingRules(persona),
    '',
    // 走过的路：走得越多越准。模型看到「家→公司 地铁 30 分钟」，下次自己就会写对，
    // 不用每回合靠校验纠正。
    renderKnownRoutes(),
    '',
    renderNarrative(persona),
    '',
    '<世界状态（唯一真相）>',
    '下面的时间轴由程序从已发生的事实推导，它的每一条都是真的。你写的任何事件都不得与它矛盾。',
    '散文里写过的话不算证据；只有 events 里的结构化字段才是状态依据。',
    '</世界状态>',
    '',
    '<可填的收件人 id>',
    `故事内人物：${castIds}`,
    '真实用户：形如 u:QQ号（就是此刻和你说话的人）',
    '发给故事内人物的话只会写进剧本，不会真的送达；发给真实用户的话才会发出去。',
    '</可填的收件人 id>',
    '',
    CONTRACT,
  ].join('\n');
}

function userPrompt({ timeline, now, contextText, trigger, recentProse, windowText = '', worldText = '',
  lastTail = '', wornList = [], askedList = [], resolveName = null }) {
  const parts = [];
  if (worldText) parts.push(worldText, '');
  parts.push(renderWorldBlock(timeline, now, resolveName ? { resolveName } : {}), '');
  // 演化窗口是时间边界的硬约束，放在状态之后、触发之前
  if (windowText) parts.push(windowText, '');
  parts.push(
    `<最近发生>（已经发生过的事实，状态一律以时间轴为准）`,
    recentProse,
    '</最近发生>',
    '',
  );
  if (lastTail) {
    parts.push(
      `<上一段停在这里>`,
      `……${lastTail}`,
      '</上一段停在这里>',
      `这一段要**从上面这个状态接着往下走**：她此刻就是这个姿势、手边就是这些东西、灯就是这个亮度。`,
      `不许把上面这段重新描写一遍当开头——那是已经写过的，重来一次读者一眼就看出在复读。`,
      '',
    );
  }
  if (wornList.length) {
    parts.push(
      `<下面这些说法已经用滥了（程序从最近几段里数出来的），这一段一律不许出现>`,
      wornList.map((p) => `- ${p}`).join('\n'),
      '</用滥的说法>',
      '',
    );
  }
  if (askedList.length) {
    parts.push(
      `<这些问题刚刚已经被问过了，这一段不许再问一遍、也不许再答一遍（再问就像失忆）>`,
      askedList.map((q) => `- ${q}`).join('\n'),
      '</已经问过的问题>',
      '',
    );
  }
  parts.push(
    `<写作纪律>上面「最近发生」是**刚刚已经写过**的内容，这一段必须往前走，写新的东西：`,
    '- 同一件事、同一个动作不许再写一遍（角色做过的动作不要复刻：已经写过TA梳头/倒水/打趣，这段就写点别的）；',
    '- **已经发生过的信息交换不许重复**：室友已经问过的、她已经答过的，不要再问第二次、也不要再答第二次（那会像失忆）；要推进到新的话题或新的动作。',
    '- 不要沿用与上一段相同或相近的开头、意象和句式（比如又是"水汽/灯光/落地灯"起手）；',
    '- 推进新的细节：新的小事件、新的对话内容、新的身体感受，让时间真的在流动。',
    '</写作纪律>',
    '',
    trigger,
  );
  if (contextText) parts.push('', `相关特质提醒：${contextText}`);
  return parts.join('\n');
}

export class Narrator {
  constructor({ store, registry, persona, impressions, timeline, llm = callLLM }) {
    this.store = store;
    this.registry = registry;
    this.persona = persona;
    this.impressions = impressions;
    this.timeline = timeline;
    this.llm = llm; // 可注入（测试用 mock，生产用真实网关）
  }

  /**
   * 生成一个回合。
   * @param {{trigger:string, userId:string, now:number, source:string, maxRevision?:number, stage?:object}} opts
   */
  async run({ trigger, userId, now, source = 'user', maxRevision = 2, stage = null, windowText = '', worldText = '' }) {
    const recentProse = this.#recentProse();
    // 最近几段叙事原文。三个用途：
    // ① 取**结尾**当接续起点（给开头只会让它照抄一遍，给结尾它才知道接着往哪走）；
    // ② 程序数出「用滥的说法」当禁用清单（硬证据，不是猜的）；
    // ③ 生成后做复读检测，撞车就要求重写一次。
    const recentNarrations = this.store.loadEvents()
      .filter((e) => e.kind === EventKind.NARRATION)
      .slice(-5)
      .map((e) => String(e.prose ?? ''))
      .filter(Boolean);
    const lastTail = tail(String(recentNarrations.slice(-1)[0] ?? '').replace(/\s+/g, ' '), 140);
    const wornList = wornPhrases(recentNarrations);
    const askedList = recentQuestions(recentNarrations);
    const traits = retrieveTraits(this.persona, `${trigger} ${recentProse}`, 6)
      .map((t) => `${t.key}：${t.text}`).join('\n');
    const impression = this.impressions.render(userId);

    const messages = [
      { role: 'system', content: systemPrompt({ persona: this.persona, impression, registry: this.registry, stage, hour: localHour(now), now }) },
      {
        role: 'user',
        content: userPrompt({ timeline: this.timeline, now, contextText: traits, trigger, recentProse, windowText, worldText, lastTail, wornList, askedList, resolveName: nameResolver(this.registry) }),
      },
    ];

    let draft = null;
    let violations = [];
    let revisions = 0;
    let lastRaw = '';
    let narration = '';
    let narrationFixed = [];

    let timeCorr = [];
    let narrRepeatChecked = false;
    for (let attempt = 0; attempt <= maxRevision; attempt += 1) {
      const { json, content } = await this.llm('story', messages, { jsonMode: true });
      lastRaw = content;
      draft = json;
      narration = String(draft?.narration ?? '').trim();
      if (!draft || !Array.isArray(draft.events)) {
        violations = [{ rule: 'FORMAT', severity: Severity.HARD, message: '返回不是合法的 events 数组' }];
        messages.push({ role: 'assistant', content: cut(lastRaw, 500) });
        messages.push({ role: 'user', content: '上次返回不合法或缺少 events 数组。请严格按要求只输出 JSON。' });
        continue;
      }
      // 校验前先按服务器时钟对齐事件时间：模型常把北京时间当 UTC 写（把晚上 21:32 写成
      // 21:32:00Z），校验器据此推算「当前钟点」时会把它当成凌晨 5:32 的睡眠时段，误报
      // R8「睡眠时段却写了洗完澡」、R1「写到未来」，逼模型一轮轮重写、把傍晚叙事改乱。
      // 先对齐到真实时间，校验才建立在正确时钟上（落库也是这套时间）。
      timeCorr = stampServerTimes(draft.events, this.timeline, now);
      const verdict = validateDrafts(draft.events, this.timeline, { now, registry: this.registry, persona: this.persona });
      // 散文本身也要过校验：时钟写错、睡眠时段出现清醒活动都算硬矛盾
      const narrV = validateNarration(narration, { at: now, persona: this.persona });
      const lenV = narrationTooShort(narration, this.persona, now);
      violations = [...verdict.violations, ...narrV, ...lenV];
      const blocking = [...verdict.hard, ...narrV, ...lenV];
      if (blocking.length === 0) {
        // 校验都过了，再查一遍「叙事是不是又在复读」：与最近几段的 n-gram 撞车率过高，
        // 就等于把上一段又抄了一遍（线上实证：14:41:48 与 14:42:23 两段开头几乎一字不差，
        // 「客厅的落地灯」在最近 30 段里出现了 15 次）。点名撞车的说法要求重写一次；
        // 只做一次，避免每回合多花好几轮 LLM。
        if (!narrRepeatChecked && recentNarrations.length && attempt < maxRevision) {
          narrRepeatChecked = true;
          const { rate, hits } = repeatRate(narration, recentNarrations);
          if (rate >= (this.narrationRepeatThreshold ?? 0.12)) {
            revisions += 1;
            messages.push({ role: 'assistant', content: cut(lastRaw, 1500) });
            messages.push({
              role: 'user',
              content: [
                '这一稿和刚刚几段撞车了，等于把上一段又写了一遍：',
                `重复率约 ${Math.round(rate * 100)}%，撞车的说法：${hits.join('、')}`,
                '重写这一段：换一个起手（上面这些说法一律不许再出现），换一批具体的动作、物件和感官细节，',
                '并且从「上一段停在这里」那个状态接着往前走，而不是把上一遍重来一次。篇幅仍要写足。',
              ].join('\n'),
            });
            continue;
          }
        }
        break;
      }

      revisions += 1;
      messages.push({ role: 'assistant', content: cut(lastRaw, 1500) });
      messages.push({
        role: 'user',
        content: [
          '这一稿被程序查出问题，必须改。问题如下：',
          ...verdict.hard.map((v) => `- ${v.message}`),
          ...narrV.map((v) => `- ${v.message}`),
          ...lenV.map((v) => `- ${v.message}`),
          ...verdict.soft.slice(0, 2).map((v) => `- （建议）${v.message}`),
          '',
          '请重新生成完整 JSON，保证：时间不倒流也不超前；move 的 from 必须等于她那一刻实际所在地点；'
          + '叙述里的钟点与这一刻一致；叙事按篇幅要求写足、写具体。',
        ].join('\n'),
      });
    }

    let events = Array.isArray(draft?.events) ? draft.events : [];

    // 事件时间已在上面循环里按服务器时钟对齐（见「校验前先对齐」），这里只并审计记录。
    let autoCorrected = [...(timeCorr ?? [])];

    const hard = validateDrafts(events, this.timeline, { now, registry: this.registry, persona: this.persona }).hard;
    if (hard.length) {
      // 重试耗尽：程序强制修正，绝不静默写入矛盾
      const fixed = forceCorrect(events, this.timeline, now);
      events = fixed.events;
      autoCorrected.push(...fixed.corrections);
    }

    // 散文的最后一道闸：还有违规句子就直接删掉，不静默留下会骗人的描写
    const finalNarrV = validateNarration(narration, { at: now, persona: this.persona });
    if (finalNarrV.length) {
      const cleaned = sanitizeNarration(narration, { at: now, persona: this.persona });
      narration = cleaned.text;
      narrationFixed = cleaned.removed;
    }

    // 叙事里的「她打给他的原话」一律抹掉：那句话由对话阶段决定，
    // 写在这里只会造成「故事里她说 A、QQ 上收到 B」（2026-10-25 线上实例）。
    // 只抹引号内容，动作与余波保留，不回灌重写——不额外花一轮 LLM。
    {
      const castNames = this.registry?.fictionalCast?.().map((a) => a.displayName).filter(Boolean) ?? [];
      const cleaned = sanitizeOwnSays(narration, { castNames });
      if (cleaned.removed.length) {
        narration = cleaned.text;
        narrationFixed = [...(narrationFixed ?? []), ...cleaned.removed.map((r) => `她发出的原话:${r}`)];
      }
    }

    // actors 归一：模型常把「室友」「主角」直接写进去，统一转成注册 id
    let actorFixed = 0;
    for (const e of events) {
      if (!Array.isArray(e.actors)) continue;
      const before = e.actors.join(',');
      e.actors = normalizeActors(e.actors, this.registry);
      if (e.actors.join(',') !== before) actorFixed += 1;
    }

    // 事实事件去重：模型爱把同一个动作换个说法再写一遍（线上：林夏"洗完澡出来打趣她"
    // 连续两回合各写一次）。与近期事件摘要相同/互含/共同前缀≥8 字的，直接丢弃。
    events = this.#dedupeEvents(events);

    return {
      narration,
      narrationFixed,
      events,
      bondDelta: Number(draft?.bondDelta) === 1 ? 1 : 0,
      violations,
      revisions,
      autoCorrected,
      actorFixed,
      source,
    };
  }

  /**
   * 最近发生的事实摘要（只作语气参考）。
   * 这里刻意**不收 narration**：以前把叙事截前 40 字塞进来，模型只看见上一段的「开头」，
   * 于是照着那个开头又写一遍——复读就是这么来的（14:41 与 14:42 两段开头几乎一字不差）。
   * 叙事的接续改由 lastTail 负责，且给的是**结尾**。
   */
  #recentProse(limit = 8) {
    const events = this.store.loadEvents()
      .filter((e) => e.kind !== EventKind.NARRATION)
      .slice(-limit);
    return events.map((e) => `- ${e.summary ?? cut(String(e.prose ?? ''), 40)}`).join('\n') || '（暂无）';
  }

  /**
   * 事实事件去重：把与近期事件摘要相同/互含/共同前缀≥8字的 act/say/world 丢掉。
   * 叙事（narration）与位移（move）不参与——叙事是给人读的正片（去重靠提示词的"写作纪律"），
   * 位移是位置状态，重复可能是真的。
   */
  #dedupeEvents(events) {
    const norm = (s) => String(s ?? '').replace(/[，,、。.!！？?~～…：:；;\s「」『』（）()\[\]]/g, '');
    const recent = this.store.loadEvents().slice(-14)
      .map((e) => norm(e.summary || e.prose || ''))
      .filter(Boolean);
    const out = [];
    let dropped = 0;
    for (const e of events) {
      if (e.kind !== EventKind.NARRATION && e.kind !== EventKind.MOVE) {
        const s = norm(e.summary || e.prose || '');
        const dup = Boolean(s) && recent.some((r) => r === s || r.includes(s) || s.includes(r) || commonPrefix(r, s) >= 8);
        if (dup) { dropped += 1; continue; }
        if (s) recent.push(s);
      }
      out.push(e);
    }
    if (dropped) console.log(`  [事件去重] 丢弃 ${dropped} 条与近期重复的事实事件`);
    return out;
  }
}

/**
 * actors 归一：'self' 保留；已是注册 id 的保留；写成本地名字的转成 id；
 * 谁都对不上的丢弃（R6 会留下记录）。返回去重后的列表。
 */
export function normalizeActors(actors, registry) {
  const out = [];
  for (const raw of Array.isArray(actors) ? actors : []) {
    const a = String(raw ?? '').trim();
    if (!a) continue;
    if (a === 'self') { out.push('self'); continue; }
    if (registry.get(a)) { out.push(a); continue; }
    const hit = registry.findByName?.(a);
    if (hit) out.push(hit.id);
    // 对不上的直接丢弃——宁可少一个同伴，也不能让「主角」变成另一个人
  }
  return [...new Set(out)];
}

/** 两个归一化字符串的公共前缀长度（用于"换个说法重复同一动作"的判定）。 */
function commonPrefix(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  let i = 0;
  const n = Math.min(x.length, y.length);
  while (i < n && x[i] === y[i]) i += 1;
  return i;
}

/** 去掉标点空白，只留可供比对的连续字面 */
function normalizeForCompare(s) {
  return String(s ?? '').replace(/[\s，。、；：！？…"“”「」『』（）()【】《》,.;!?~～-]+/g, '');
}

/** 取文本的 n-gram 集合（段内去重，避免长句里的重复把统计带偏） */
function ngrams(s, n) {
  const out = new Set();
  const t = normalizeForCompare(s);
  for (let i = 0; i + n <= t.length; i += 1) out.add(t.slice(i, i + n));
  return out;
}

/**
 * 从最近几段叙事里自动数出「已经用滥的说法」。
 * 这是程序数出来的硬证据（不是猜的），直接当禁用清单交给模型。
 * 专治「每段都是落地灯 / 输入框 / 门缝」——线上最近 30 段里「客厅的落地灯」出现了 15 次。
 */
export function wornPhrases(narrations, { n = 6, minCount = 3, limit = 10 } = {}) {
  const counts = new Map();
  for (const raw of narrations) {
    const seen = ngrams(raw, n);
    for (const g of seen) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  const ranked = [...counts.entries()]
    .filter(([, c]) => c >= minCount)
    .sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length));

  // 相邻 n-gram 会大量重叠（「客厅的落地灯」「厅的落地灯把」），做一次贪心合并，
  // 只保留互不重叠的代表短语，免得清单里全是同一句话的碎片。
  const picked = [];
  const used = new Set();
  for (const [g] of ranked) {
    const gs = ngrams(g, 4);
    let overlaps = false;
    for (const u of gs) if (used.has(u)) { overlaps = true; break; }
    if (overlaps) continue;
    for (const u of gs) used.add(u);
    picked.push(g);
    if (picked.length >= limit) break;
  }
  return picked;
}

/**
 * 从最近几段叙事里抽出**已经被问出口的问题**。
 * 专治「同一句问话被反复问」——线上实证：33 分钟里林夏问了 9 次「跟谁聊」。
 * 这些问句被原样列给模型当「不许再问」清单，比泛泛说一句「别重复」有效得多。
 */
export function recentQuestions(narrations, { limit = 6 } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of narrations) {
    // 只按句号/换行切，问号要留在句内才能被识别成「问句」
    for (const seg of String(raw ?? '').split(/[。！\n]+/)) {
      const q = String(seg).trim();
      if (!/[？?]/.test(q)) continue;
      if (q.length < 4 || q.length > 40) continue;
      const key = normalizeForCompare(q).slice(0, 10);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(q.replace(/[？?]+$/, '？'));
    }
  }
  return out.slice(-limit);
}

/**
 * 一段新叙事与最近若干段叙事的「撞车率」：新文本里有多少比例的 n-gram 曾在旧段里出现过。
 * 用来判断它是不是又把上一段抄了一遍。
 */
export function repeatRate(text, previous, { n = 6 } = {}) {
  const a = ngrams(text, n);
  if (!a.size) return { rate: 0, hits: [] };
  let best = 0;
  const hits = new Set();
  for (const p of previous) {
    const b = ngrams(p, n);
    let inter = 0;
    for (const g of a) if (b.has(g)) { inter += 1; hits.add(g); }
    const r = inter / a.size;
    if (r > best) best = r;
  }
  return { rate: best, hits: [...hits].slice(0, 8) };
}

/** 复述「她回复了他」的说法——与 validator 的 R10 判定共用同一份关键词表 */
const REPLY_MARKER_RE = new RegExp(REPLY_MARKERS.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'));

/**
 * 时间戳以服务器时钟为准（无条件执行，取代模型自报的时间）。
 * 模型输出的 at 常是「2026-10-26T11:41:00+08:00」这类自己估的北京时间，和真实消息的
 * UTC（Z）混在一起会导致：① 字符串/毫秒排序错乱；② 上下文时间窗误判；③ 导出故事里的
 * 钟点是编的。这里把本批事件统一锚定到服务器当前时刻 now，批内按出现顺序每条 +1 秒，
 * 既保证严格不倒序，又让时间整体可信；格式统一为 UTC（Z）。
 * move 事件的出发点按新时间重新对齐（时间基准变了，地点也得落到她此刻真实所在地）。
 */
export function stampServerTimes(events, timeline, now) {
  const corrections = [];
  const list = Array.isArray(events) ? events : [];
  if (!list.length) return corrections;

  const sim = new Timeline(timeline.events, timeline.startPlace);
  const prevAt = sim.lastAt();
  const n = list.length;
  // 最后一条正好落在 now，往前每条退 1 秒；若与本批之前的历史最后一刻撞上，就整体顺延到其后
  let base = now - (n - 1) * 1000;
  if (prevAt !== null && base <= prevAt) base = prevAt + 1000;

  // 这一批里上一次出发的到达时刻：下一段出行必须从到达之后才开始，不能叠在一起
  let lastArriveAt = Number.NEGATIVE_INFINITY;

  list.forEach((e, i) => {
    let at = base + i * 1000;
    applyDuration(e, at);
    if (e.kind === EventKind.MOVE && Number.isFinite(lastArriveAt) && at < lastArriveAt) {
      corrections.push({
        rule: 'R2', before: toISO(at), after: toISO(lastArriveAt), note: '上一段还没到又出发，已顺延到到达之后',
      });
      at = lastArriveAt;
    }
    const beforeAt = e.at;
    e.at = toISO(at);
    if (beforeAt !== e.at) {
      corrections.push({ rule: 'T', before: beforeAt, after: e.at, note: '时间以服务器时钟为准' });
    }

    if (e.kind === EventKind.MOVE) {
      const actual = sim.placeAt(at);
      if (e.from && e.from !== actual) {
        corrections.push({ rule: 'R2', before: `from=${e.from}`, after: `from=${actual}`, note: '按服务器时间校正出发点' });
        e.from = actual;
      }
      let to = e.to ?? e.place;
      if (to && to === actual) {
        const before = e.to;
        e.to = Place.OTHER;
        if (e.place) e.place = Place.OTHER;
        corrections.push({ rule: 'R2', before: `to=${before}`, after: 'to=other', note: '目的地与所在地相同，已改为 other' });
        to = Place.OTHER;
      }
      // 路程时长：由路网图定，模型给的 minutes 只是参考。
      // 算出 arriveAt 之后，这段路上她一直是 transit——「提前说到站」从此在状态层就不成立。
      if (to) {
        const plan = planMove({ from: e.from, to, mode: e.mode, minutes: e.minutes, legs: e.legs });
        e.mode = plan.mode;
        e.minutes = plan.minutes;
        e.legs = plan.legs;
        e.arriveAt = toISO(at + plan.minutes * 60000);
        lastArriveAt = at + plan.minutes * 60000;
        for (const c of plan.corrections) corrections.push({ ...c, note: `[路程] ${c.note}` });
      }
    }

    sim.commit([e]);
  });

  return corrections;
}

/**
 * 兜底修正：把硬矛盾改成自洽版本，并留下审计记录。
 * - 时间：早于最后一条就推到最后一条之后；超过现在就压到现在
 * - move：from 改为那一刻的实际地点；to 与当前相同就改成 OTHER
 */
export function forceCorrect(events, timeline, now) {
  const corrections = [];
  const sim = new Timeline(timeline.events, timeline.startPlace);
  let prevAt = sim.lastAt();
  const out = [];

  for (const e of events ?? []) {
    const fixed = { ...e };
    let at = toMs(fixed.at);

    if (!Number.isFinite(at)) {
      at = prevAt === null ? now : prevAt + 60000;
      fixed.at = toISO(at);
      corrections.push({ rule: 'R1', before: e.at, after: fixed.at, note: '时间无法解析，已重排' });
    } else if (prevAt !== null && at <= prevAt) {
      const before = fixed.at;
      // 模型常把时间写到整秒/整分，比真实记录（带毫秒）早了零点几秒——
      // 只往后推 1 秒即可，推 1 分钟会让她的反应在时间轴上凭空慢一拍
      at = prevAt + 1000;
      fixed.at = toISO(at);
      corrections.push({ rule: 'R1', before, after: fixed.at, note: '时间倒流，已推到最后一条之后' });
    } else if (at > now) {
      const before = fixed.at;
      at = now;
      fixed.at = toISO(at);
      corrections.push({ rule: 'R1', before, after: fixed.at, note: '写到未来，已压到当前时间' });
    }

    // R10 兜底：这一阶段不该出现「她对他说出口的话」——重写几次还是写了，就要抹到位：
    // ① 收件人是真实用户：摘掉他，降级成「她自言自语了一句」；
    // ② 只是在复述「她回了他什么」：整个降级成 act——回没回是事实，回了什么不进事件。
    // 总之绝不留下「故事里她说了、QQ 上却没发」或「故事里说的和发出去的不一样」这种账。
    if (fixed.kind === EventKind.SAY) {
      // R11 兜底：模型没写说话人，就按 actors 推断补上——
      // 绝不留空，否则读取端（记忆/上下文）又会把别人的话算到她头上。
      if (!fixed.speaker) {
        const { speaker, to } = resolveSpeech(fixed);
        fixed.speaker = speaker;
        if (to && !fixed.to) fixed.to = to;
        corrections.push({
          rule: 'R11',
          before: '(missing)',
          after: `${speaker}${to ? ` → ${to}` : ''}`,
          note: '按 actors 推断补上说话人',
        });
      }
      const actorsIn = Array.isArray(fixed.actors) ? fixed.actors : [];
      const before = actorsIn.join(',');
      const kept = actorsIn.filter((a) => !String(a).startsWith('u:'));
      const beforeBlob = `${String(fixed.summary ?? '')} ${String(fixed.prose ?? '')}`;

      if (kept.length !== actorsIn.length) {
        fixed.actors = kept.length ? kept : ['self'];
        corrections.push({
          rule: 'R10',
          before,
          after: fixed.actors.join(','),
          note: '这一阶段不写她对他说的话，收件人已摘除',
        });
      } else if (REPLY_MARKER_RE.test(beforeBlob)) {
        // 复述她的回复：这一阶段无权"发送"——回没回、发了什么由对话阶段决定。
        // 所以不能留下「她回了消息」这个既成事实（否则叙事里回了、QQ 上却没发）。
        // 降级成 act 时，把"回了/发了/发送"这类结果词剥掉，只留「看了消息、手指停在屏幕上」的过程。
        const rawSummary = String(fixed.summary ?? '');
        const beforeKind = fixed.kind;
        fixed.kind = EventKind.ACT;
        const stripped = rawSummary
          .replace(/[「『“][^「』”]{0,40}[」』”]/g, '')
          .replace(/(又|然后|最后|随即|跟着)?(回|回复|发|发送|回给|发给)(了|过去|出去|回去|他|消息|一句|一条)[^，。；]*/g, '')
          .trim();
        fixed.summary = (stripped && stripped.length >= 5)
          ? stripped
          : '看了他发来的消息，手指在输入框上停了一会儿';
        fixed.prose = '';
        corrections.push({
          rule: 'R10',
          before: `${beforeKind}:${rawSummary}`,
          after: `act:${fixed.summary}`,
          note: '不替她写回复内容，也不留"已发送"的既成事实，降级为过程',
        });
      }
    }

    if (fixed.kind === EventKind.MOVE) {
      const actual = sim.placeAt(at);
      if (fixed.from && fixed.from !== actual) {
        corrections.push({ rule: 'R2', before: `from=${fixed.from}`, after: `from=${actual}`, note: '出发点与实际位置矛盾，已按时间轴修正' });
        fixed.from = actual;
      }
      const to = fixed.to ?? fixed.place;
      if (to && to === actual) {
        corrections.push({ rule: 'R2', before: `to=${to}`, after: 'to=other', note: '目的地与当前位置相同，已改为 other' });
        fixed.to = Place.OTHER;
      }
    }

    applyDuration(fixed, at);
    out.push(fixed);
    sim.commit([fixed]);
    prevAt = at;
  }
  return { events: out, corrections };
}

// 持续动作时长：由模型声明 durationMinutes，程序派生 span（from→to），
// 状态层（activityAt / R5 跨度重叠）与校验（R15 活动未完）据此接管。
// 与路网图同一范式：模型声明 + 程序保证，不硬编码时长表 / 白名单。
const MAX_DURATION_MIN = 180;
export function applyDuration(e, at) {
  if (e?.kind !== EventKind.ACT) return; // 只有「持续动作」才有时长
  const dur = Number(e?.durationMinutes);
  if (!Number.isFinite(dur) || dur <= 0) return;
  const minutes = Math.min(dur, MAX_DURATION_MIN);
  const endAt = at + minutes * 60000;
  e.span = { from: toISO(at), to: toISO(endAt) };
}
