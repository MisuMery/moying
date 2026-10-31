// 关系系统：她**和这个人**之间是什么关系，以及处在这个关系里能说什么、不能说什么。
//
// 这一块独立于角色卡，原因是这两件事本来就不该混在一起：
//   · 角色卡回答「她是谁」——性格、说话习惯、知识边界，跟对面是谁无关；
//   · 关系回答「她和他到了哪一步」——锚点、历史、当前阶段、这个阶段允许的表达。
//
// 更重要的是：**角色定位不是一成不变的**。关系走到依赖阶段（比如已经确认了男女朋友），
// 角色卡里「不许说想你了 / 不许表白 / 不许撒娇」这类红线就不该再压着她——
// 所以每个阶段都带一份 relaxKeywords，命中的红线在该阶段自动失效，
// 同时阶段自己再补一份更贴合当下关系的 forbid。真人就是这么相处的。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT } from '../config.js';
import { BOND_THRESHOLD } from './impression.js';

/**
 * 从印象反推阶段（没显式设置时用）。
 *
 * 优先用**羁绊值 bond**：它是没有上限的累积量，关系能一直往前走。
 * 旧的 facets 只在老数据（还没有 bond）时兜底——facets ±2 封顶，
 * 用久了会顶格卡死，「关系随剧情自然推进」就停在那儿了。
 */
export function inferStageId(impression) {
  const bond = Number(impression?.bond ?? 0);
  if (Number.isFinite(bond) && bond > 0) {
    if (bond >= BOND_THRESHOLD.attached) return 'attached';
    if (bond >= BOND_THRESHOLD.trusting) return 'trusting';
    if (bond >= BOND_THRESHOLD.familiar) return 'familiar';
    if (bond >= BOND_THRESHOLD.distant) return 'distant';
    return 'stranger';
  }
  // 兜底：对齐各档自带的分值（trust+warmth+intimacy）
  const f = impression?.facets ?? {};
  const score = (Number(f.intimacy) || 0) + (Number(f.warmth) || 0) + (Number(f.trust) || 0);
  if (score <= 0) return 'stranger';
  if (score <= 2) return 'distant';
  if (score <= 4) return 'familiar';
  if (score <= 5) return 'trusting';
  return 'attached';
}

const FILE = path.join(DATA_DIR, 'relationship.json');

const FALLBACK = {
  // 关系类型由使用者自己填：老同学 / 朋友 / 恋人 / 故去的亲人 / 同事 / 故事里的人
  kind: '',
  anchor: '',
  history: '',
  // 初始相处方式：用户填的演化起点。各阶段的内容由世界 AI 从这里推演，不预置模板
  initialMode: { tone: '', behaviorRules: [], specialTriggers: [] },
  initialStage: 'distant',
  currentStage: 'distant',
  autoAdvance: true,
  autoEvolve: true,
  stages: [],
};

export function loadRelationship() {
  try {
    const rel = { ...FALLBACK, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
    // 兼容旧格式：顶层全局的相处方式/触发，下放给没有自定义内容的阶段。
    // 新格式里这些字段属于每个阶段自己，关系变了相处方式就跟着换。
    for (const s of rel.stages ?? []) {
      if (!Array.isArray(s.behaviorRules) && Array.isArray(rel.behaviorRules)) s.behaviorRules = rel.behaviorRules;
      if (!Array.isArray(s.specialTriggers) && Array.isArray(rel.specialTriggers)) s.specialTriggers = rel.specialTriggers;
      if (!s.tone && rel.currentTone) s.tone = rel.currentTone;
    }
    return rel;
  } catch {
    return { ...FALLBACK };
  }
}

/** 通用模板：只保留阶段骨架，相处方式留空交给世界 AI 演化。
 *  两个来源：① data/ 里的副本（老安装、或被使用者改过的）；② 仓库 templates/ 下的
 *  原版（干净安装只有它——deploy.sh / init-data.js 都把模板复制成 relationship.json，
 *  从来不会生成 data/relationship.template.json。2026-10-25 审查：原先只读 ①，
 *  干净安装下 loadTemplate 必然落到 catch 返回 stages: []，「重置成通用模板」
 *  会把五档骨架整个清空）。 */
const TEMPLATE_PATH = path.join(DATA_DIR, 'relationship.template.json');
const REPO_TEMPLATE_PATH = path.join(ROOT, 'templates', 'relationship.template.json');

export function loadTemplate() {
  for (const p of [TEMPLATE_PATH, REPO_TEMPLATE_PATH]) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { /* 试下一个来源 */ }
  }
  return { ...FALLBACK, stages: [] };
}

export function saveRelationship(value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(value, null, 2), 'utf8');
  return value;
}

export function stageList() {
  return loadRelationship().stages ?? [];
}

export function getStage(id) {
  return (loadRelationship().stages ?? []).find((s) => s.id === String(id ?? '')) ?? null;
}

/** 显式设置的阶段优先，否则按印象分数反推 */
export function resolveRelationStage(impression) {
  const rel = loadRelationship();
  const explicit = String(impression?.stage ?? rel.currentStage ?? '');
  const hit = (rel.stages ?? []).find((s) => s.id === explicit);
  if (hit) return hit;
  const inferred = inferStageId(impression);
  return (rel.stages ?? []).find((s) => s.id === inferred) ?? null;
}

/**
 * 当前生效的红线：角色卡红线 − 本阶段解除的 + 本阶段新增的。
 * @param {object} persona 角色卡
 * @param {object} stage 当前阶段
 */
export function effectiveRedlines(persona, stage) {
  const base = Array.isArray(persona?.redlines) ? [...persona.redlines] : [];
  const relax = Array.isArray(stage?.relaxKeywords) ? stage.relaxKeywords : [];
  const kept = base.filter((line) => {
    if (!relax.length) return true;
    // 命中解除词的红线在这一阶段不再适用
    return !relax.some((k) => String(line).includes(k));
  });
  const added = Array.isArray(stage?.forbid) ? stage.forbid.map((x) => `（${stage.name}阶段）${x}`) : [];
  return [...kept, ...added];
}

/**
 * 渲染关系块：锚点 + 历史 + 当前阶段，以及**这个阶段自己**的相处方式与特殊触发。
 * 相处方式随阶段走：疏离期的「收着不说破」不会带进恋人阶段。
 */
export function renderRelationship(impression, stage) {
  const rel = loadRelationship();
  const lines = ['<你和这个人的关系（决定亲密的边界与分寸）>'];
  if (rel.history) lines.push(`关系来历：${rel.history}`);
  if (rel.anchor) lines.push(rel.anchor);

  const tone = stage?.tone ?? rel.initialMode?.tone ?? rel.currentTone;
  if (tone) lines.push(`现在的状态：${tone}`);

  // 相处方式与特殊触发都属于**当前阶段**——关系变了，相处的方式就跟着变
  const rules = (Array.isArray(stage?.behaviorRules) && stage.behaviorRules.length)
    ? stage.behaviorRules
    : (rel.initialMode?.behaviorRules ?? rel.behaviorRules);
  if (Array.isArray(rules) && rules.length) {
    lines.push('', `和他的相处方式（${stage ? stage.name : '当前'}阶段）：`, ...rules.map((x) => `- ${x}`));
  }

  const triggers = (Array.isArray(stage?.specialTriggers) && stage.specialTriggers.length)
    ? stage.specialTriggers
    : (rel.initialMode?.specialTriggers ?? rel.specialTriggers);
  if (Array.isArray(triggers) && triggers.length) {
    lines.push('', '特殊触发（遇到时按这个方式反应）：');
    // 称呼归属边界：triggers 里的旧称呼、暗号只属于「他」。没有这句边界，
    // 故事模型会把「丽儿」这类私密称呼泛化到室友/同事嘴里——
    // 2026-10-25 线上实例：林夏喊出「丽儿，还没睡啊？」，而那是他对她的旧称呼。
    lines.push('（这些触发只对「他」成立：只有他做出对应动作才算触发。触发里出现的称呼、暗号是他的专属，故事内其他角色——室友、同事、家人——在任何场合都不许使用；他们叫主角一律按 cast 设定。）');
    for (const t of triggers) {
      lines.push(`- 当${t.when}：${t.react}`);
      if (t.note) lines.push(`  （${t.note}）`);
    }
  }

  if (stage) {
    lines.push('', `当前阶段：${stage.name}（${stage.desc}）`);
    if (Array.isArray(stage.allow) && stage.allow.length) {
      lines.push('', '这个阶段可以做到的：', ...stage.allow.map((x) => `- ${x}`));
    }
    if (Array.isArray(stage.forbid) && stage.forbid.length) {
      lines.push('', '这个阶段仍然不做的：', ...stage.forbid.map((x) => `- ${x}`));
    }
    if (Array.isArray(stage.relaxKeywords) && stage.relaxKeywords.length) {
      lines.push('', `注意：随着关系走近，角色卡里涉及「${stage.relaxKeywords.join('、')}」的限制在本阶段已经不再适用。`);
    }
  }
  lines.push('</你和这个人的关系>');
  return lines.join('\n');
}

/**
 * 故事发展过程中自动调整感情态度（autoAdvance 开启时）。
 * 依据印象分数往上走；也可以由控制台一键切换（会写 impression.stage）。
 */
export function maybeAdvanceStage(impressions, userId) {
  const rel = loadRelationship();
  if (rel.autoAdvance === false) return null;
  const imp = impressions.get(userId);
  const inferred = inferStageId(imp);
  const current = resolveRelationStage(imp);
  if (!current || inferred === current.id) return null;
  const order = (rel.stages ?? []).map((s) => s.id);
  // 只允许顺着关系往前走，不自动倒退（倒退由人工判断）
  if (order.indexOf(inferred) <= order.indexOf(current.id)) return null;
  const next = getStage(inferred);
  if (!next) return null;
  const updated = impressions.put(userId, {
    ...imp,
    stage: next.id,
    facets: { ...(imp.facets ?? {}), ...next.facets },
  });
  // currentStage 一起推进，否则「用户与关系」页会停在旧档位
  if (rel.currentStage !== next.id) {
    saveRelationship({ ...rel, currentStage: next.id });
  }
  return { from: current.id, to: next.id, impression: updated };
}
