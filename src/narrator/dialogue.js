// 对话阶段（chat 路由）：只负责「她说了什么」。
//
// 与世界阶段分开的意义：世界阶段已经把「她在哪、在干嘛、和谁在一起」定下来并通过了
// 矛盾校验，对话阶段拿到的是**已经确认无矛盾的状态**，不会再出现「已经出门了又说出门」
// 这类把世界状态和话语搅在一起的矛盾；同时这一阶段能看见最近说过的所有话，
// 专门负责避免「你怎么醒这么早」说两遍。

import { callLLM } from '../llm/gateway.js';
import { renderWorldBlock, nameResolver } from '../world/view.js';
import {
  renderIdentity, renderSpeechRules, renderRedlines, renderResponsePatterns,
  renderVagueness, renderKnowledgeBoundary, renderCast, retrieveTraits,
} from '../persona/card.js';
import { renderRelationship } from '../persona/relationship.js';
import { localHour } from '../world/time.js';
import { detectRepeat, renderRecentSays } from './repeat.js';

export const DIALOGUE_CONTRACT = `只输出一个 JSON 对象：
{
  "utterances": [
    { "id": "u1", "addresseeId": "u:对方QQ号 或 c:roommate", "content": "她说出口的话" }
  ],
  "impressionDelta": { "facets": { "warmth": 1 }, "addNotes": ["记得的一件小事"] }
}

规则：
- utterances 可以为空数组（她选择不说话也是正常的，尤其是忙、困、没什么可说的时候）。
- addresseeId 必须是上面列出的收件人；写给故事内人物的话只会进剧本，不会真的送达。
- 每条都要短，按当前阶段的上限来；不要复述对方刚说的话，也不要重复自己刚说过的话。`;

function systemPrompt({ persona, impression, registry, stage, hour }) {
  const castIds = registry.fictionalCast().map((a) => `${a.id}（${a.displayName}）`).join('、');
  return [
    renderIdentity(persona),
    '',
    impression,
    '',
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
    '<可填的收件人 id>',
    `故事内人物：${castIds}`,
    '真实用户：形如 u:QQ号（就是此刻和你说话的人）',
    '</可填的收件人 id>',
    '',
    DIALOGUE_CONTRACT,
  ].join('\n');
}

/**
 * 主动联系是硬约束，不是建议：没到那份上就不许给他发消息。
 * 程序在 outbox 还会再拦一道，这里是让模型别浪费力气写注定发不出去的话。
 */
export function renderContactRule(contact, canMessageUser, userId) {
  if (canMessageUser) {
    const why = contact?.text ? `你的念头：${contact.text}` : '他刚发了消息，你在回他';
    return [
      '<这一刻要不要主动找他>',
      `可以给他（u:${userId}）发消息，但不是非发不可——要真的有话想说才发，没话就不发。`,
      why,
      '发给故事内人物的话照旧可以写（只会写进剧本，不会真的送达）。',
      '</这一刻要不要主动找他>',
    ].join('\n');
  }
  return [
    '<这一刻要不要主动找他>',
    `不要给他（u:${userId}）发任何消息。理由：${contact?.reason ?? '这一刻没有想联系他的念头'}。`,
    '你可以在心里想到他、可以想起他说过的话，但不要发出去。utterances 里不许出现收件人是他的条目。',
    '说给故事内人物（室友、同事等）的话照旧照写。',
    '</这一刻要不要主动找他>',
  ].join('\n');
}

export class DialogueNarrator {
  constructor({ store, registry, persona, impressions, timeline, llm = callLLM, stickers = null }) {
    this.store = store;
    this.registry = registry;
    this.persona = persona;
    this.impressions = impressions;
    this.timeline = timeline;
    this.llm = llm;
    this.stickers = stickers;
  }

  /**
   * @param {{worldSummary:string, trigger:string, userId:string, now:number,
   *          recentSays:string[], recentUserSays?:string[], stage?:object, maxRevision?:number}} opts
   */
  async run({
    worldSummary, narration = '', trigger, userId, now, recentSays = [], recentUserSays = [],
    stage = null, contact = null, canMessageUser = true, maxRevision = 1,
  }) {
    const impression = this.impressions.render(userId);
    const traits = retrieveTraits(this.persona, trigger, 4).map((t) => `${t.key}：${t.text}`).join('\n');

    const userParts = [];
    userParts.push('<此刻她的状态（已经过矛盾校验，是事实）>');
    userParts.push(worldSummary || renderWorldBlock(this.timeline, now, { resolveName: nameResolver(this.registry) }));
    userParts.push('</此刻她的状态>');
    userParts.push('');
    // 刚写好的叙事给对话阶段看一眼：她要说的话得接着这一段生活
    if (narration) {
      userParts.push('<刚刚这段生活（你正处在其中）>');
      userParts.push(narration.slice(-600));
      userParts.push('</刚刚这段生活>');
      userParts.push('');
    }
    // 要不要主动联系他：这是硬约束，不是建议
    userParts.push(renderContactRule(contact, canMessageUser, userId));
    userParts.push('');
    if (recentUserSays?.length) {
      userParts.push('<对方最近说的>', ...recentUserSays.slice(-6).map((s) => `- ${s}`), '</对方最近说的>', '');
    }
    userParts.push(renderRecentSays(recentSays, 14));
    userParts.push('');
    // 有标注过的表情包才告诉她可以用
    const stickerBlock = this.stickers?.renderForPrompt?.() ?? '';
    if (stickerBlock) userParts.push(stickerBlock, '');
    userParts.push(trigger);
    if (traits) userParts.push('', `相关特质提醒：${traits}`);

    const messages = [
      { role: 'system', content: systemPrompt({ persona: this.persona, impression, registry: this.registry, stage, hour: localHour(now) }) },
      { role: 'user', content: userParts.filter(Boolean).join('\n') },
    ];

    let draft = null;
    let repeats = [];
    let revisions = 0;

    for (let attempt = 0; attempt <= maxRevision; attempt += 1) {
      const { json, content } = await this.llm('chat', messages, { jsonMode: true });
      draft = json;
      const utterances = Array.isArray(draft?.utterances) ? draft.utterances : [];
      repeats = detectRepeat(utterances.map((u) => u?.content ?? ''), recentSays);
      if (!repeats.length) break;
      revisions += 1;
      messages.push({ role: 'assistant', content: content.slice(0, 800) });
      messages.push({
        role: 'user',
        content: [
          '这些话和最近说过的重复了，不许再说：',
          ...repeats.map((r) => `- 「${r.content}」≈ 之前说过的「${r.matched}」（${r.kind}）`),
          '',
          '换一种说法，或者直接不回（utterances 给空数组也可以）。重新输出 JSON。',
        ].join('\n'),
      });
    }

    // 重写后仍重复：直接丢掉重复的那几条，绝不把重复的话发出去
    let utterances = Array.isArray(draft?.utterances) ? draft.utterances : [];
    const finalRepeats = detectRepeat(utterances.map((u) => u?.content ?? ''), recentSays);
    if (finalRepeats.length) {
      const drop = new Set(finalRepeats.map((r) => r.content));
      utterances = utterances.filter((u) => !drop.has(u?.content ?? ''));
    }

    return {
      utterances,
      impressionDelta: draft?.impressionDelta ?? null,
      repeats: finalRepeats,
      revisions,
    };
  }
}
