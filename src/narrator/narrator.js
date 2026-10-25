// 叙事生成：模型写稿 → 程序校验 → 不合格就带着违规点回灌重写。
//
// 与 HDS 最大的不同：模型必须输出**结构化世界事件**，散文只是附带的渲染文本。
// 状态由 events 决定，prose 不参与任何状态推导 —— 这样「下午出门两次」这种
// 矛盾能被 validateDrafts 直接查出来，而不是等用户读故事时才发现。

import { callLLM } from '../llm/gateway.js';
import { validateDrafts, validateNarration, sanitizeNarration, narrationTooShort, Severity } from '../world/validator.js';
import { renderWorldBlock, nameResolver } from '../world/view.js';
import { Timeline, Place, EventKind } from '../world/state.js';
import { toISO, toMs } from '../world/time.js';
import {
  renderIdentity, renderSpeechRules, renderRedlines, renderCast, retrieveTraits,
  renderRelationshipAnchor, renderResponsePatterns, renderVagueness, renderKnowledgeBoundary,
  renderNarrative,
} from '../persona/card.js';
import { renderRelationship } from '../persona/relationship.js';
import { localHour } from '../world/time.js';

// 世界阶段（story 路由）只判定「世界里发生了什么」——
// 她在哪、在做什么、其他角色什么状态。她说什么话由下一阶段的对话模型负责，
// 这一阶段不要输出任何话语，也不要替她决定回复内容。
export const CONTRACT = `你必须只输出一个 JSON 对象，不要有任何额外文字，结构如下：
{
  "narration": "这一段生活的**完整叙事**，是给人读的正片：从一个具体动作或身体感受开始，写感官细节（光、声音、温度、触感），写她的心理活动但一律落在身体反应上（指尖、咬嘴唇、喉结、胸口那块），写配角自己的动作和台词；涉及手机要写完余波（震动→有没有立刻看→看完那几秒→怎么决定回什么→发完把手机放哪）。篇幅按上面的要求，可以多段。结尾停在一个动作或一句没说完的话上，允许留白。",
  "events": [
    {
      "at": "2026-10-24T18:27:00+08:00",
      "kind": "move | act | say | world",
      "from": "仅 move 需要：出发地 home|office|transit|outside_social|other",
      "to": "仅 move 需要：目的地",
      "place": "非 move 需要：所在地点",
      "actors": ["c:roommate"],
      "span": { "from": "...", "to": "..." },
      "remote": false,
      "summary": "一句话摘要（会进入时间轴，务必简短）"
    }
  ]
}

narration 与 events 的分工（不要搞反）：
- narration 是**给人读的正片**，要写足、写细、写具体；它不参与任何状态判定。
- events 是**状态真相**，只写结构化事实；summary 一句话即可，不要在这里展开描写。

注意：
- 本阶段不写她说了什么话（utterances 由后续对话阶段产出），也不要在这里替她构思回复。
- 只写已经发生的事实，不写计划、不写推测、不预言未来。
- 时间不得倒流，也不得超过当前时间；move 的 from 必须等于她那一刻实际所在地点。
- move 只用于**她自己**的位移（同行的其他人写进 actors，她自己不用写）；其他角色的移动用 act 表达，place 填该角色此刻所在的地方（例：「室友出门上班」→ kind=act、actors=["c:roommate"]、place="office"）。
- 叙述里不许出现和这一刻不符的钟点（不许「现在七点了」这种说法，除非现在真的是七点）。
- actors 里提到她自己时一律用 "self"，**不要写她自己的名字**；其他角色用上面给的 c:xxx 标识。`;

function systemPrompt({ persona, impression, registry, stage, hour }) {
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
    renderRedlines(persona, stage),
    '',
    renderCast(persona),
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

function userPrompt({ timeline, now, contextText, trigger, recentProse, windowText = '', worldText = '', resolveName = null }) {
  const parts = [];
  if (worldText) parts.push(worldText, '');
  parts.push(renderWorldBlock(timeline, now, resolveName ? { resolveName } : {}), '');
  // 演化窗口是时间边界的硬约束，放在状态之后、触发之前
  if (windowText) parts.push(windowText, '');
  parts.push(
    `<最近发生>（仅作语气与细节参考，状态一律以时间轴为准）`,
    recentProse,
    '</最近发生>',
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
    const traits = retrieveTraits(this.persona, `${trigger} ${recentProse}`, 6)
      .map((t) => `${t.key}：${t.text}`).join('\n');
    const impression = this.impressions.render(userId);

    const messages = [
      { role: 'system', content: systemPrompt({ persona: this.persona, impression, registry: this.registry, stage, hour: localHour(now) }) },
      {
        role: 'user',
        content: userPrompt({ timeline: this.timeline, now, contextText: traits, trigger, recentProse, windowText, worldText, resolveName: nameResolver(this.registry) }),
      },
    ];

    let draft = null;
    let violations = [];
    let revisions = 0;
    let lastRaw = '';
    let narration = '';
    let narrationFixed = [];

    for (let attempt = 0; attempt <= maxRevision; attempt += 1) {
      const { json, content } = await this.llm('story', messages, { jsonMode: true });
      lastRaw = content;
      draft = json;
      narration = String(draft?.narration ?? '').trim();
      if (!draft || !Array.isArray(draft.events)) {
        violations = [{ rule: 'FORMAT', severity: Severity.HARD, message: '返回不是合法的 events 数组' }];
        messages.push({ role: 'assistant', content: lastRaw.slice(0, 500) });
        messages.push({ role: 'user', content: '上次返回不合法或缺少 events 数组。请严格按要求只输出 JSON。' });
        continue;
      }
      const verdict = validateDrafts(draft.events, this.timeline, { now, registry: this.registry, persona: this.persona });
      // 散文本身也要过校验：时钟写错、睡眠时段出现清醒活动都算硬矛盾
      const narrV = validateNarration(narration, { at: now, persona: this.persona });
      const lenV = narrationTooShort(narration, this.persona, now);
      violations = [...verdict.violations, ...narrV, ...lenV];
      const blocking = [...verdict.hard, ...narrV, ...lenV];
      if (blocking.length === 0) break;

      revisions += 1;
      messages.push({ role: 'assistant', content: lastRaw.slice(0, 1500) });
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

    let events = draft?.events ?? [];
    const hard = validateDrafts(events, this.timeline, { now, registry: this.registry, persona: this.persona }).hard;
    let autoCorrected = [];
    if (hard.length) {
      // 重试耗尽：程序强制修正，绝不静默写入矛盾
      ({ events, corrections: autoCorrected } = forceCorrect(events, this.timeline, now));
    }

    // 散文的最后一道闸：还有违规句子就直接删掉，不静默留下会骗人的描写
    const finalNarrV = validateNarration(narration, { at: now, persona: this.persona });
    if (finalNarrV.length) {
      const cleaned = sanitizeNarration(narration, { at: now, persona: this.persona });
      narration = cleaned.text;
      narrationFixed = cleaned.removed;
    }

    // actors 归一：模型常把「室友」「主角」直接写进去，统一转成注册 id
    let actorFixed = 0;
    for (const e of events) {
      if (!Array.isArray(e.actors)) continue;
      const before = e.actors.join(',');
      e.actors = normalizeActors(e.actors, this.registry);
      if (e.actors.join(',') !== before) actorFixed += 1;
    }

    return {
      narration,
      narrationFixed,
      events,
      violations,
      revisions,
      autoCorrected,
      actorFixed,
      source,
    };
  }

  #recentProse(limit = 6) {
    const events = this.store.loadEvents().slice(-limit);
    return events.map((e) => `- ${e.summary ?? String(e.prose ?? '').slice(0, 40)}`).join('\n') || '（暂无）';
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
      at = prevAt + 60000;
      fixed.at = toISO(at);
      corrections.push({ rule: 'R1', before, after: fixed.at, note: '时间倒流，已推到最后一条之后' });
    } else if (at > now) {
      const before = fixed.at;
      at = now;
      fixed.at = toISO(at);
      corrections.push({ rule: 'R1', before, after: fixed.at, note: '写到未来，已压到当前时间' });
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

    out.push(fixed);
    sim.commit([fixed]);
    prevAt = at;
  }
  return { events: out, corrections };
}
