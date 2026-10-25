// 感情阶段的门面（facade）：阶段定义以 relationship.json 为唯一来源。
//
// 这个文件只保留「一键切换」这类操作入口，避免阶段规则在两处各写一份。

import { loadRelationship, saveRelationship, getStage, inferStageId } from './relationship.js';

export { inferStageId } from './relationship.js';

/** 阶段清单（id / 名称 / 描述 / 印象分数） */
export function stageList() {
  const rel = loadRelationship();
  return (rel.stages ?? []).map((s) => ({
    id: s.id, name: s.name, desc: s.desc, facets: s.facets,
    speech: s.speech, allow: s.allow, forbid: s.forbid, relaxKeywords: s.relaxKeywords,
  }));
}

export function RELATION_STAGES() {
  return stageList();
}

export function getRelationStage(id) {
  return getStage(id);
}

/** 当前阶段 id：显式设置的优先，否则按印象分数反推 */
export function currentStageId(impression) {
  const explicit = String(impression?.stage ?? '');
  if (explicit && getStage(explicit)) return explicit;
  return inferStageId(impression);
}

/**
 * 一键切换阶段：改写印象分数并记下阶段 id。
 * @param {import('./impression.js').ImpressionStore} store
 */
export function applyStage(store, userId, stageId, { keepNotes = true } = {}) {
  const stage = getStage(stageId);
  if (!stage) throw new Error(`未知阶段: ${stageId}`);
  const cur = store.get(userId);
  const next = {
    ...cur,
    userId: String(userId),
    stage: stage.id,
    facets: { ...(cur.facets ?? {}), ...stage.facets },
    notes: keepNotes ? (cur.notes ?? []) : [],
    updatedAt: new Date().toISOString(),
  };
  const updated = store.put(userId, next);
  // 关系配置里的 currentStage 同步写，两个页面才不会各说各话
  const rel = loadRelationship();
  if (rel.currentStage !== stage.id) {
    saveRelationship({ ...rel, currentStage: stage.id });
  }
  return updated;
}
