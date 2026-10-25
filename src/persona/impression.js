// 「她对这个用户的印象」—— HDS 也有类似字段，但被塞在提示词靠后的位置，
// 而且会被模型整段重写。这里做成一等对象：只接受受控增量（facets ±1、notes 增删），
// 程序 clamp 范围，注入时放在 system 之后的第一段，和红线同级、永不裁剪。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

const FILE = path.join(DATA_DIR, 'impressions.json');

export const FACET_KEYS = ['trust', 'warmth', 'annoyance', 'intimacy', 'interest'];
export const FACET_LABEL = {
  trust: '信任',
  warmth: '亲近',
  annoyance: '厌烦',
  intimacy: '暧昧',
  interest: '好奇',
};
const RANGE = [-2, 2];
const MAX_NOTES = 8;

function clamp(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(RANGE[1], Math.max(RANGE[0], Math.round(n)));
}

function emptyImpression(userId) {
  return {
    userId: String(userId),
    // stage: 感情态度阶段 id（陌生/疏离/熟悉/信任/依赖），由控制台一键设置
    stage: null,
    facets: Object.fromEntries(FACET_KEYS.map((k) => [k, 0])),
    notes: [],
    updatedAt: null,
  };
}

export class ImpressionStore {
  constructor() {
    this.data = this.#load();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  }

  #save() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(this.data, null, 2), 'utf8');
  }

  get(userId) {
    const key = String(userId);
    return this.data[key] ?? emptyImpression(key);
  }

  /**
   * 应用受控增量。delta 只允许 { facets: {key: ±1}, addNotes: string[], removeNotes: string[] }
   * —— 模型不能整段重写印象，历史只能一条条加。
   */
  applyDelta(userId, delta, evidence = {}) {
    const key = String(userId);
    const cur = this.data[key] ?? emptyImpression(key);

    if (delta?.facets && typeof delta.facets === 'object') {
      for (const [k, v] of Object.entries(delta.facets)) {
        if (!FACET_KEYS.includes(k)) continue;
        const step = Number(v);
        if (!Number.isFinite(step)) continue;
        // 单轮最多 ±1，防止模型一次跳到极端
        const bounded = Math.max(-1, Math.min(1, step));
        cur.facets[k] = clamp((cur.facets[k] ?? 0) + bounded);
      }
    }

    for (const text of delta?.addNotes ?? []) {
      const t = String(text ?? '').trim().slice(0, 80);
      if (!t) continue;
      if (cur.notes.some((n) => n.text === t)) continue;
      cur.notes.push({
        text: t,
        evidenceEntryId: evidence.entryId ?? null,
        at: evidence.at ?? new Date().toISOString(),
      });
    }
    for (const text of delta?.removeNotes ?? []) {
      cur.notes = cur.notes.filter((n) => n.text !== String(text ?? '').trim());
    }
    if (cur.notes.length > MAX_NOTES) cur.notes = cur.notes.slice(-MAX_NOTES);

    cur.updatedAt = new Date().toISOString();
    this.data[key] = cur;
    this.#save();
    return cur;
  }

  /** 整体替换（一键切换感情阶段用） */
  put(userId, value) {
    const key = String(userId);
    this.data[key] = { ...(this.data[key] ?? {}), ...value };
    this.#save();
    return this.data[key];
  }

  /** 渲染注入块（最高优先级段落） */
  render(userId) {
    const imp = this.get(userId);
    const facetText = FACET_KEYS
      .map((k) => `${FACET_LABEL[k]} ${fmtSigned(imp.facets?.[k] ?? 0)}`)
      .join(' / ');
    const notes = (imp.notes ?? []).slice(-6).map((n) => `- ${n.text}`);
    const stageLine = imp.stage ? `当前感情态度：${stageName(imp.stage)}` : '';
    return [
      '<对当前这个人的印象（最高优先级，必须贯彻在语气与分寸里）>',
      stageLine,
      facetText,
      notes.length ? '记得的事：' : '',
      ...notes,
      '</对当前这个人的印象>',
    ].filter(Boolean).join('\n');
  }

  /** 控制台展示用 */
  toJSON() {
    return this.data;
  }
}

function fmtSigned(n) {
  const v = Number(n) || 0;
  return v > 0 ? `+${v}` : String(v);
}

/** 阶段 id → 中文名（渲染提示词用，避免循环依赖 stages.js） */
function stageName(id) {
  const names = { stranger: '陌生', distant: '疏离', familiar: '熟悉', trusting: '信任', attached: '依赖' };
  return names[String(id ?? '')] ?? String(id ?? '');
}
