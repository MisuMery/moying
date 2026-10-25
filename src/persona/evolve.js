// 关系演化：相处方式不是写死的模板，而是**由世界 AI 按剧情推演**出来的。
//
// 为什么要这样：开源之后，别人可能拿她扮朋友、扮故去的亲人、扮某个故事里的角色——
// 预先写一套「恋人模板」是行不通的（把「收着不说破」套到故人身上就是错的）。
// 所以流程是：
//   1. 用户只填两样：**关系类型**（kind）和**初始相处方式**（initialMode）
//   2. 关系往前走一档时，世界 AI 结合「角色卡 + 关系来历 + 这一档的定义 +
//      最近真的发生了什么」，把上一档的相处方式**改写**成这一档合适的样子
//   3. 改写结果落到该阶段上，并记下 evolvedAt / evolvedFrom，随时可人工覆盖
//
// 关键约束：新一档的内容必须**主动淘汰**掉与新阶段矛盾的规则
//（例：上一档写着「不表白」，这一档已经可以表达在乎了，就必须改掉，不能留下打架的条款）。

import { callLLM } from '../llm/gateway.js';
import { loadRelationship, saveRelationship, getStage } from './relationship.js';

const MAX_RULES = 8;
const MAX_TRIGGERS = 4;

export const EVOLVE_CONTRACT = `只输出一个 JSON 对象，不要有任何额外文字：
{
  "tone": "一句话写清此刻两人处在什么状态（她的视角，不写剧情）",
  "behaviorRules": ["相处方式，一条一句，3~8 条"],
  "specialTriggers": [
    { "when": "他做了什么 / 说到什么", "react": "她怎么反应（写成行为与分寸，不要写台词）" }
  ]
}

要求：
- 这是**相处方式**，不是剧情：不写具体事件、不写台词、不预言未来。
- 必须继承上一阶段里**仍然成立**的部分，并把**不再成立**的部分改掉。
  典型冲突：上一阶段写着「不许表白 / 不表达在乎 / 躲开感情话题」，
  而当前阶段已经允许表达在乎——这类条款必须改写，不能原样保留。
- 特殊触发只保留 0~4 条，写「他做了什么」→「她怎么反应」；
  同一个触发在不同阶段可以有完全不同的反应方式（这才叫演化）。
- 不写亲昵称呼清单、不写口头禅（那是角色卡的事）。
- 语言贴近她的人设，但保持通用：不假设两人一定是恋人。`;

function cleanRules(list) {
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    const s = String(x ?? '').trim();
    if (s) out.push(s);
  }
  return out.slice(0, MAX_RULES);
}

function cleanTriggers(list) {
  const out = [];
  for (const t of Array.isArray(list) ? list : []) {
    if (!t || typeof t !== 'object') continue;
    const when = String(t.when ?? '').trim();
    const react = String(t.react ?? '').trim();
    if (!when || !react) continue;
    const item = { when: when.replace(/^当/, ''), react };
    if (t.note) item.note = String(t.note).trim();
    out.push(item);
  }
  return out.slice(0, MAX_TRIGGERS);
}

/**
 * 把某个阶段的相处方式演化成贴合当前剧情的样子。
 *
 * @param {object} opts
 * @param {string} opts.stageId 目标阶段（默认当前阶段）
 * @param {object} opts.persona 角色卡
 * @param {string} opts.recentFacts 最近真实发生过的事（时间轴摘要）
 * @param {Function} opts.llm 注入点（测试用）
 * @param {boolean} opts.save 是否写回 relationship.json
 * @returns {Promise<{ok:boolean, stageId:string, stage:object, from:string, reason:string}>}
 */
export async function evolveStageContent({
  stageId = null,
  persona = null,
  recentFacts = '',
  llm = callLLM,
  save = true,
  force = false,
} = {}) {
  const rel = loadRelationship();
  const target = getStage(stageId ?? rel.currentStage);
  if (!target) return { ok: false, reason: `找不到阶段 ${stageId}`, stageId, stage: null };
  // 人工改过的阶段不自动覆盖，除非显式强制（控制台「按最近剧情重写」）
  if (target.manual && !force) {
    return { ok: false, stageId: target.id, stage: target, from: target.evolvedFrom ?? '', reason: '这一档你手动改过，自动演化跳过（可点「按最近剧情重写」强制）' };
  }

  // 演化起点：优先用上一档已经演化过的内容，其次用初始相处方式
  const order = (rel.stages ?? []).map((s) => s.id);
  const idx = order.indexOf(target.id);
  let origin = null;
  for (let i = idx - 1; i >= 0; i -= 1) {
    const prev = getStage(order[i]);
    if (prev && Array.isArray(prev.behaviorRules) && prev.behaviorRules.length) { origin = prev; break; }
  }
  const seed = origin ?? { name: '初始', tone: rel.initialMode?.tone ?? '', behaviorRules: rel.initialMode?.behaviorRules ?? [], specialTriggers: rel.initialMode?.specialTriggers ?? [] };
  const from = origin ? origin.id : 'initialMode';

  const identity = persona?.identity ?? {};
  const userParts = [
    '<这个人是谁>',
    `${identity.name ?? '她'}，${identity.age ?? ''}岁，${identity.job ?? ''}。`,
    ...(Array.isArray(persona?.traits) ? persona.traits.slice(0, 5).map((t) => `- ${t.key}：${t.text}`) : []),
    '</这个人是谁>',
    '',
    '<两人的关系>',
    `关系类型：${rel.kind || '（未填写）'}`,
    rel.history ? `关系来历：${rel.history}` : '',
    rel.anchor ? `她怎么看待这份感情：${rel.anchor}` : '',
    '</两人的关系>',
    '',
    '<演化起点（上一档的相处方式）>',
    `来自：${seed.name}`,
    seed.tone ? `状态：${seed.tone}` : '',
    ...(seed.behaviorRules ?? []).map((x) => `- ${x}`),
    ...(seed.specialTriggers ?? []).map((t) => `- 当${t.when}：${t.react}`),
    '</演化起点>',
    '',
    `<目标阶段：${target.name}（${target.desc ?? ''}）>`,
    '这个阶段可以做到的：',
    ...(target.allow ?? []).map((x) => `- ${x}`),
    '这个阶段仍然不做的：',
    ...(target.forbid ?? []).map((x) => `- ${x}`),
    '</目标阶段>',
  ];
  if (recentFacts) userParts.push('', '<最近真的发生过的事（演化要有依据）>', recentFacts, '</最近真的发生过的事>');
  userParts.push('', `请把「${seed.name}」的相处方式演化到「${target.name}」，只输出 JSON。`);

  const messages = [
    { role: 'system', content: `你是关系演化推演器，负责根据剧情把两人的相处方式推到下一个合理的形态。\n\n${EVOLVE_CONTRACT}` },
    { role: 'user', content: userParts.filter(Boolean).join('\n') },
  ];

  let draft = null;
  try {
    const { json } = await llm('story', messages, { jsonMode: true });
    draft = json;
  } catch (error) {
    return { ok: false, stageId: target.id, stage: target, from, reason: `调用世界模型失败：${error?.message ?? error}` };
  }

  const tone = String(draft?.tone ?? '').trim();
  const rules = cleanRules(draft?.behaviorRules);
  const triggers = cleanTriggers(draft?.specialTriggers);
  if (!rules.length) {
    return { ok: false, stageId: target.id, stage: target, from, reason: '模型没有给出可用的相处方式，保留原样' };
  }

  const nextStage = {
    ...target,
    tone: tone || target.tone || seed.tone || '',
    behaviorRules: rules,
    specialTriggers: triggers,
    evolvedAt: new Date().toISOString(),
    evolvedFrom: from,
    manual: false, // 演化产物，允许后续继续演化
  };

  if (save) {
    const stages = (rel.stages ?? []).map((s) => (s.id === nextStage.id ? nextStage : s));
    saveRelationship({ ...rel, stages });
  }

  return { ok: true, stageId: nextStage.id, stage: nextStage, from, reason: `由「${seed.name}」演化而来` };
}

/** 当前阶段还没有相处方式时（新装的、或刚重置成模板），先演化一份 */
export async function ensureStageContent({ persona = null, recentFacts = '', llm = callLLM, stageId = null } = {}) {
  const rel = loadRelationship();
  const target = getStage(stageId ?? rel.currentStage);
  if (!target) return null;
  const has = Array.isArray(target.behaviorRules) && target.behaviorRules.length;
  if (has) return null;
  return evolveStageContent({ stageId: target.id, persona, recentFacts, llm });
}
