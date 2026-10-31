// 路网图：不预登记地点，边从剧情里长出来。
//
// 为什么需要它：2026-10-30 线上，她 07:44 上车、07:48 就「最后一站到站」——
// 5 分钟走完了 30 分钟的通勤。根因是 move 事件是瞬时位移，系统里没有任何
// 「这段路要多久」的概念，模型写什么就是什么。
//
// 这里只解决两件事：
//   1. 每条 `出发地|目的地|交通方式` 的耗时，走过一次就记住（边从剧情里长）；
//   2. 给一条 move 定一个可信的时长：同边一致、三角不等式、交通方式下限三重约束。
//
// 不做的事：不存坐标、不要求预登记地点。新地点第一次出现就自动入网。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { toMs } from './time.js';

const GRAPH_FILE = path.join(DATA_DIR, 'travel.json');

/** 交通方式：最小时长 + 典型时速（时速只用于判断「这个时长在这个方式下合不合理」）。
 *  可在 world.json 的 travelModes 里覆盖，与地点无关，所以永远不会膨胀。 */
export const DEFAULT_MODES = {
  walk: { minMinutes: 1, kmh: 4.5, label: '步行' },
  bike: { minMinutes: 3, kmh: 15, label: '骑车' },
  bus: { minMinutes: 8, kmh: 18, label: '公交' },
  metro: { minMinutes: 8, kmh: 35, label: '地铁' },
  taxi: { minMinutes: 5, kmh: 25, label: '打车' },
  train: { minMinutes: 60, kmh: 200, label: '高铁' },
  plane: { minMinutes: 90, kmh: 700, label: '飞机' },
};

/** 同一对起终点、不同交通方式之间，时长的大致比值（快的在前）。
 *  用来抓「同一段路，打车比地铁还慢一倍」这种矛盾。 */
const MODE_SPEED_RANK = { walk: 0, bike: 1, bus: 2, taxi: 2, metro: 3, train: 5, plane: 6 };

const SPLIT = '::';
const edgeKey = (from, to, mode) => `${from}${SPLIT}${to}${SPLIT}${mode}`;

/** 分段（legs）的阶段名，用于提示词里说「你在站台上/在车厢里」 */
export const LEG_PHASE = {
  walk: 'walking',
  wait: 'waiting',
  ride: 'riding',
  drive: 'driving',
  fly: 'flying',
};

const PHASE_LABEL = {
  walking: '走路上',
  waiting: '等车',
  riding: '车上',
  driving: '车上',
  flying: '飞机上',
};

/** 默认分段比例：模型没给 legs 时按这个拆，只为让她「在路上」有层次，不追求精确 */
const DEFAULT_SPLIT = {
  metro: [['walk', 0.25], ['wait', 0.15], ['ride', 0.5], ['walk', 0.1]],
  bus: [['walk', 0.2], ['wait', 0.2], ['ride', 0.6]],
  taxi: [['walk', 0.1], ['drive', 0.9]],
  bike: [['walk', 0.05], ['ride', 0.95]],
  walk: [['walk', 1]],
  train: [['walk', 0.15], ['wait', 0.2], ['ride', 0.5], ['walk', 0.15]],
  plane: [['walk', 0.15], ['wait', 0.4], ['fly', 0.4], ['walk', 0.05]],
};

function readWorldModes() {
  try {
    const p = path.join(DATA_DIR, 'world.json');
    if (!fs.existsSync(p)) return {};
    const w = JSON.parse(fs.readFileSync(p, 'utf8'));
    return w?.travelModes && typeof w.travelModes === 'object' ? w.travelModes : {};
  } catch {
    return {};
  }
}

/** 交通方式规格（world.json 覆盖 → 默认表） */
export function modeSpec(mode) {
  const m = String(mode ?? '').trim();
  const custom = readWorldModes()[m];
  const base = DEFAULT_MODES[m] ?? null;
  if (!base && !custom) return null;
  return { id: m, minMinutes: 5, kmh: 20, label: m, ...base, ...(custom ?? {}) };
}

/** 把模型给的交通方式归一到已知值；认不出来返回 null */
export function normalizeMode(mode) {
  const raw = String(mode ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (DEFAULT_MODES[raw]) return raw;
  const alias = {
    走路: 'walk', 步行: 'walk', 徒步: 'walk', on_foot: 'walk', foot: 'walk',
    骑车: 'bike', 自行车: 'bike', 单车: 'bike', cycling: 'bike',
    公交: 'bus', 公交车: 'bus', 巴士: 'bus',
    地铁: 'metro', 轨道交通: 'metro', subway: 'metro', 轻轨: 'metro',
    打车: 'taxi', 出租车: 'taxi', 网约车: 'taxi', 滴滴: 'taxi', car: 'taxi', 开车: 'taxi',
    高铁: 'train', 火车: 'train', 动车: 'train', 地铁城际: 'train',
    飞机: 'plane', 航班: 'plane', flight: 'plane',
  };
  return alias[raw] ?? null;
}

// ---------- 图的读写 ----------

export function loadGraph() {
  try {
    if (!fs.existsSync(GRAPH_FILE)) return { edges: {} };
    const g = JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf8'));
    return { edges: g?.edges && typeof g.edges === 'object' ? g.edges : {} };
  } catch {
    return { edges: {} };
  }
}

export function saveGraph(graph) {
  try {
    fs.mkdirSync(path.dirname(GRAPH_FILE), { recursive: true });
    fs.writeFileSync(GRAPH_FILE, JSON.stringify(graph, null, 2), 'utf8');
  } catch (e) {
    // 不能静默：写不进去的话路网永远是空的，系统会悄悄退化成「模型说多久就多久」
    console.log(`  [路网] 写入失败（${e?.code ?? e?.message}），本次无法记住这条路线`);
  }
}

export function findEdge(graph, from, to, mode) {
  return graph?.edges?.[edgeKey(from, to, mode)] ?? null;
}

/** 记一条边：前几次取较大值（避免第一次估短了就被固化），之后取加权平均 */
export function recordEdge(graph, from, to, mode, minutes) {
  if (!from || !to || from === to || !mode) return;
  const key = edgeKey(from, to, mode);
  const prev = graph.edges[key];
  const samples = (prev?.samples ?? 0) + 1;
  let next = minutes;
  if (prev?.minutes && samples >= 2) {
    if (samples < 4) {
      // 还在学：取较大值。第一次若写了 8 分钟（被交通方式下限抬上来的），
      // 第二次写 30 分钟时应该升到 30，而不是被 8 拉回去。
      next = Math.max(prev.minutes, minutes);
    } else {
      next = Math.round(prev.minutes * 0.7 + minutes * 0.3);
    }
  }
  graph.edges[key] = { minutes: Math.max(1, next), samples, updatedAt: new Date().toISOString() };
}

/** 同一对起终点、其他交通方式已有时长（用于速度比校验） */
function siblingEdges(graph, from, to) {
  const out = [];
  const prefix = `${from}${SPLIT}${to}${SPLIT}`;
  for (const [k, v] of Object.entries(graph.edges ?? {})) {
    if (k.startsWith(prefix)) out.push({ mode: k.slice(prefix.length), minutes: v.minutes });
  }
  return out;
}

/** 某个地点在图上的邻居（无向：A→B 和 B→A 都算相邻），返回 Map<邻居, 分钟> */
function neighbors(graph, node, mode) {
  const out = new Map();
  for (const [k, v] of Object.entries(graph.edges ?? {})) {
    const [a, b, m] = k.split(SPLIT);
    if (m !== mode) continue;
    if (a === node && b) out.set(b, v.minutes);
    else if (b === node && a) out.set(a, v.minutes);
  }
  return out;
}

/** 三角不等式：找一个共同邻居，用两条已知边夹住这段路。
 *  朋友家→公司第一次走也能被约束：家→朋友家 35、家→公司 22 ⇒ 这段至少在 13~57 之间。 */
function viaCheck(graph, from, to, mode, minutes) {
  const nearFrom = neighbors(graph, from, mode);
  const nearTo = neighbors(graph, to, mode);
  for (const [via, da] of nearFrom) {
    if (via === to) continue;
    const db = nearTo.get(via);
    if (db === undefined) continue;
    const lo = Math.abs(da - db);
    const hi = da + db;
    // 下界比上界硬：|a−b| 是三点共线时的最短值，绕路只会更长，不会更短。
    // 留 20% 余量给估算误差；上界放宽到 1.5 倍，容纳绕行。
    if (minutes < lo * 0.8 || minutes > hi * 1.5) {
      return { via, lo, hi, suggest: Math.round((lo + hi) / 2) };
    }
  }
  return null;
}

// ---------- 分段 ----------

function defaultLegs(mode, totalMinutes) {
  const spec = DEFAULT_SPLIT[mode] ?? [['walk', 1]];
  const legs = spec.map(([kind, ratio]) => ({
    kind,
    phase: LEG_PHASE[kind] ?? 'riding',
    minutes: Math.max(1, Math.round(totalMinutes * ratio)),
  }));
  // 取整误差补到最长的一段上，保证总和等于总时长
  const sum = legs.reduce((s, l) => s + l.minutes, 0);
  const gap = totalMinutes - sum;
  if (gap !== 0) {
    let idx = 0;
    for (let i = 1; i < legs.length; i += 1) if (legs[i].minutes > legs[idx].minutes) idx = i;
    legs[idx].minutes = Math.max(1, legs[idx].minutes + gap);
  }
  return legs;
}

/** 模型给了 legs 就按它归一化到总时长；没给就按交通方式拆 */
export function normalizeLegs(legs, mode, totalMinutes) {
  if (!Array.isArray(legs) || !legs.length) return defaultLegs(mode, totalMinutes);
  const cleaned = legs
    .map((l) => {
      const kind = String(l?.kind ?? l?.mode ?? 'walk').toLowerCase();
      const norm = LEG_PHASE[kind] ? kind : (kind === 'car' ? 'drive' : 'walk');
      return { kind: norm, phase: LEG_PHASE[norm], minutes: Math.max(0, Number(l?.minutes) || 0) };
    })
    .filter((l) => l.minutes > 0);
  if (!cleaned.length) return defaultLegs(mode, totalMinutes);

  const sum = cleaned.reduce((s, l) => s + l.minutes, 0);
  const k = sum > 0 ? totalMinutes / sum : 1;
  const scaled = cleaned.map((l) => ({ ...l, minutes: Math.max(1, Math.round(l.minutes * k)) }));
  const drift = totalMinutes - scaled.reduce((s, l) => s + l.minutes, 0);
  if (drift !== 0) {
    let idx = 0;
    for (let i = 1; i < scaled.length; i += 1) if (scaled[i].minutes > scaled[idx].minutes) idx = i;
    scaled[idx].minutes = Math.max(1, scaled[idx].minutes + drift);
  }
  return scaled;
}

/** 班表里的通勤分钟数：角色卡 schedule.commuteMinutes。
 *  它是「家→公司全程」的真实配置，拿来做第一条边的起始值，
 *  免得第一次出门被交通方式下限（地铁 8 分钟）定成 8 分钟。 */
function commuteSeed() {
  try {
    const p = path.join(DATA_DIR, 'character.json');
    if (!fs.existsSync(p)) return 0;
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    // 不写死层级（实际在 rhythm.schedule.commuteMinutes），递归找一个就行，
    // 以后角色卡结构调整也不会悄悄失效。
    const find = (o) => {
      if (!o || typeof o !== 'object') return 0;
      const n = Number(o.commuteMinutes);
      if (Number.isFinite(n) && n > 0) return n;
      for (const v of Object.values(o)) {
        const r = find(v);
        if (r) return r;
      }
      return 0;
    };
    return find(c);
  } catch {
    return 0;
  }
}

/** 图里还没有「家↔公司」时，用班表的通勤分钟数播一条边（标 samples=3，立即生效） */
function seedHomeOffice(graph) {
  const seed = commuteSeed();
  if (!seed) return false;
  const now = new Date().toISOString();
  let changed = false;
  for (const [a, b] of [['home', 'office'], ['office', 'home']]) {
    const key = edgeKey(a, b, 'metro');
    if (graph.edges[key]) continue;
    graph.edges[key] = { minutes: seed, samples: 3, updatedAt: now, seeded: true };
    changed = true;
  }
  return changed;
}

// ---------- 主入口：给定一条 move，算出可信时长与分段 ----------

/**
 * @param {{from:string,to:string,mode?:string,minutes?:number,legs?:Array}} move
 * @returns {{mode:string, minutes:number, legs:Array, source:string, corrections:Array}}
 */
export function planMove(move = {}) {
  const corrections = [];
  const { from, to } = move;
  const rawMode = normalizeMode(move.mode);
  const spec = modeSpec(rawMode ?? 'metro') ?? modeSpec('metro');

  let mode = rawMode;
  if (!mode) {
    // 没写交通方式：按有没有历史边猜一个；再没有就用地铁做默认（都市通勤最常见的假设）
    const known = siblingEdges(loadGraph(), from, to);
    mode = known[0]?.mode ?? 'metro';
    corrections.push({ rule: 'T1', note: `没写交通方式，按「${spec.label}」计`, after: mode });
  }

  const graph = loadGraph();
  // 第一次出门前，用班表里的通勤分钟数把「家↔公司」播进图
  if (seedHomeOffice(graph)) saveGraph(graph);
  const edge = findEdge(graph, from, to, mode);
  let minutes = Number(move.minutes);

  if (!Number.isFinite(minutes) || minutes <= 0) {
    minutes = edge?.minutes ?? Math.max(spec.minMinutes, Math.round(spec.minMinutes * 2));
    corrections.push({
      rule: 'T2',
      note: edge ? `没给时长，按这条路平时 ${edge.minutes} 分钟计` : `没给时长，按「${spec.label}」典型 ${minutes} 分钟计`,
    });
  }

  // ① 交通方式下限：地铁不可能 3 分钟走完全程
  const floor = Number(spec.minMinutes) || 1;
  if (minutes < floor) {
    corrections.push({ rule: 'T3', note: `${spec.label}最短也要 ${floor} 分钟，已按此计（原 ${minutes}）` });
    minutes = floor;
  }

  // ② 同边一致：这条路走过，就不能这次突然缩短/拉长一大截。
  // 前 3 次还在学，不锁死——否则第一次估短（被交通方式下限抬上来的 8 分钟）
  // 会把这条路永久定成 8 分钟，之后写 30 也被拉回去。
  if (edge?.minutes) {
    if ((edge.samples ?? 0) < 3) {
      // 还在学：不判违规（第一次可能估短了），但不允许比走过的更短——
      // 走过 30 分钟的路，下一次写 5 分钟，光靠交通方式下限只抬到 8，照样是瞬移。
      // 往上调放行，往下压不放行，这样一次估长不会把路永久定死。
      if (minutes < edge.minutes) {
        corrections.push({
          rule: 'T4',
          note: `这条路走过 ${edge.minutes} 分钟，这次 ${minutes} 分钟说不过去，先按 ${edge.minutes} 计`,
          before: minutes,
          after: edge.minutes,
        });
        minutes = edge.minutes;
      }
    } else {
      const lo = edge.minutes * 0.6;
      const hi = edge.minutes * 1.4;
      if (minutes < lo || minutes > hi) {
        corrections.push({
          rule: 'T4',
          note: `这条路你平时走 ${edge.minutes} 分钟，这次的 ${minutes} 分钟不合理，已按平时计`,
          before: minutes,
          after: edge.minutes,
        });
        minutes = edge.minutes;
      }
    }
  }

  // ③ 三角不等式：朋友家→公司首次走，也能被「家→朋友家 + 家→公司」约束住
  const via = viaCheck(graph, from, to, mode, minutes);
  if (via) {
    corrections.push({
      rule: 'T5',
      note: `经${via.via}过去是 ${via.hi} 分钟上下，${minutes} 分钟到不了，已按 ${via.suggest} 分钟计`,
      before: minutes,
      after: via.suggest,
    });
    minutes = via.suggest;
  }

  // ④ 速度比：同一段路，打车不该比地铁慢一倍
  const rank = MODE_SPEED_RANK[mode] ?? 0;
  for (const sib of siblingEdges(graph, from, to)) {
    if (sib.mode === mode) continue;
    const sibRank = MODE_SPEED_RANK[sib.mode] ?? 0;
    if (sibRank <= rank) continue;                     // 只跟更快的比
    if (minutes > sib.minutes * 2.2) {
      corrections.push({
        rule: 'T6',
        note: `这段路${DEFAULT_MODES[sib.mode]?.label ?? sib.mode}只要 ${sib.minutes} 分钟，${spec.label}不该慢到 ${minutes} 分钟`,
      });
      break;
    }
  }

  const legs = normalizeLegs(move.legs, mode, minutes);
  const source = edge ? 'graph' : 'declared';

  // 换乘（从 transit 出发）不是一段新的路，不能进图——否则「路上→公司」会把路线搅乱
  const recordable = from && to && from !== to && from !== 'transit' && to !== 'transit';
  if (recordable) {
    const next = { edges: { ...graph.edges } };
    recordEdge(next, from, to, mode, minutes);
    saveGraph(next);
  }

  return { mode, minutes, legs, source, corrections };
}

/** 把分段排成时间轴，返回某时刻处于哪一段 */
export function phaseAt(move, ms) {
  const dep = toMs(move?.at);
  const legs = Array.isArray(move?.legs) ? move.legs : [];
  if (!Number.isFinite(dep) || !legs.length) return { phase: 'riding', remainMin: null };
  let cursor = dep;
  for (const l of legs) {
    const end = cursor + (Number(l.minutes) || 0) * 60000;
    if (ms < end) {
      return {
        phase: l.phase ?? 'riding',
        label: PHASE_LABEL[l.phase] ?? '路上',
        remainMin: Math.max(1, Math.ceil((end - ms) / 60000)),
      };
    }
    cursor = end;
  }
  const last = legs[legs.length - 1];
  return { phase: last?.phase ?? 'riding', label: PHASE_LABEL[last?.phase] ?? '路上', remainMin: 0 };
}

/** 提示词：你熟悉的路（走得越多，写得越准） */
export function renderKnownRoutes(limit = 8) {
  const graph = loadGraph();
  const entries = Object.entries(graph.edges ?? {})
    .sort((a, b) => (b[1].samples ?? 0) - (a[1].samples ?? 0))
    .slice(0, limit);
  if (!entries.length) return '';
  const lines = entries.map(([k, v]) => {
    const [from, to, mode] = k.split(SPLIT);
    const label = DEFAULT_MODES[mode]?.label ?? mode;
    return `${from} → ${to}：${label}约 ${v.minutes} 分钟`;
  });
  return ['<你熟悉的路>', ...lines, '</你熟悉的路>'].join('\n');
}

/** 调试/测试用：清空图 */
export function resetGraph() {
  saveGraph({ edges: {} });
}
