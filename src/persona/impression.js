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

/**
 * 羁绊值 bond：一段关系里「共同经历过多少」的累积量，**没有上限**。
 *
 * 为什么要有它（2026-10-28 架构审计）：原来只靠 facets（±2 就封顶）推断阶段，
 * 线上跑几天就把 trust/warmth/interest 全顶到 +2，关系推进到「信任」档就再也上不去了——
 * 「关系随剧情自然推进」这条设想等于半途卡死。
 * bond 由每一次真实互动累积（他找她、她找他、她生活里想起他），于是关系会一直往前走。
 */
export const BOND_THRESHOLD = {
  distant: 4,
  familiar: 12,
  trusting: 24,
  attached: 44,
};

/** 每天最多累积多少羁绊——防止一晚上刷满 */
const BOND_DAILY_CAP = 6;

/** 由 facets 反推一个起始羁绊（老数据没有 bond 时用，保证阶段不倒退） */
export function bondFromFacets(facets = {}) {
  const score = (Number(facets.intimacy) || 0) + (Number(facets.warmth) || 0) + (Number(facets.trust) || 0);
  if (score <= 0) return 0;
  if (score <= 2) return 5;
  if (score <= 4) return 13;
  if (score <= 5) return 26;
  return 46;
}

function emptyImpression(userId) {
  return {
    userId: String(userId),
    // stage: 感情态度阶段 id（陌生/疏离/熟悉/信任/依赖），由控制台一键设置
    stage: null,
    facets: Object.fromEntries(FACET_KEYS.map((k) => [k, 0])),
    bond: 0,
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
        // 记的时候就把归属定下来：关于他的 / 她自己的。渲染时分开摆，避免混着引用。
        about: /他|你/.test(t) ? 'him' : 'self',
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

  /**
   * 累积羁绊（只增，不减——关系走过的事不会没发生过）。
   * @param {number} n 增量
   * @param {number} reason 用于日志的简短说明（不落库）
   */
  addBond(userId, n = 1, now = Date.now()) {
    const key = String(userId);
    const add = Number(n) || 0;
    if (add <= 0) return this.get(key);

    const rec = this.data[key] ?? emptyImpression(key);
    // 老数据没有 bond：按现有印象给一个起点，保证阶段不会因为引入 bond 而倒退
    if (!Number.isFinite(Number(rec.bond)) || Number(rec.bond) <= 0) {
      rec.bond = bondFromFacets(rec.facets ?? {});
    }
    // 每日上限：一天聊再多也不会暴涨
    const day = new Date(now).toISOString().slice(0, 10);
    if (rec.bondDay !== day) { rec.bondDay = day; rec.bondToday = 0; }
    const room = Math.max(0, BOND_DAILY_CAP - (Number(rec.bondToday) || 0));
    const real = Math.min(room, add);
    if (real <= 0) { this.data[key] = rec; return this.get(key); }

    rec.bond = Number(rec.bond) + real;
    rec.bondToday = (Number(rec.bondToday) || 0) + real;
    rec.updatedAt = new Date(now).toISOString();
    this.data[key] = rec;
    this.#save();
    return this.get(key);
  }

  /** 当前羁绊值（老数据按 facets 折算，不会返回 0 导致阶段倒退） */
  bondOf(userId) {
    const rec = this.data[String(userId)];
    if (!rec) return 0;
    const b = Number(rec.bond);
    if (Number.isFinite(b) && b > 0) return b;
    return bondFromFacets(rec.facets ?? {});
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
    // 记忆分两类：关于他的、她自己这边的。
    // 2026-10-29：notes 曾经混在一起，模型把「她自己想去旧书摊」记成「他说过要去」，
    // 于是她越聊越确信有个不存在的约定。分开摆，再明确一句别混。
    const all = (imp.notes ?? []).slice(-8);
    const about = (n) => n.about ?? (/他|你/.test(String(n.text ?? '')) ? 'him' : 'self');
    const his = all.filter((n) => about(n) === 'him');
    const mine = all.filter((n) => about(n) === 'self');
    const stageLine = imp.stage ? `当前感情态度：${stageName(imp.stage)}` : '';
    // 羁绊是累积量：让模型知道两人之间已经走过多少，分寸随它走
    const bond = this.bondOf(userId);
    const bondLine = bond > 0
      ? `两人之间已经积累的来往：${bond}（只增不减——走得越久，她对他越不见外）`
      : '';
    return [
      '<对当前这个人的印象（最高优先级，必须贯彻在语气与分寸里）>',
      stageLine,
      bondLine,
      facetText,
      his.length ? '记得的、关于他的：' : '',
      ...his.map((n) => `- ${n.text}`),
      mine.length ? '她自己这边的事（跟他没关系，别安到他头上）：' : '',
      ...mine.map((n) => `- ${n.text}`),
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
