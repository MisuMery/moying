// 世界事件校验：模型写出来的每一条事件都要过这一关。
//
// HDS 唯一的时间校验只看剧本前 30 个字符的时钟是否超前，完全不查条目之间的矛盾，
// 于是「下午出了两次门」这种硬伤一路写进故事。这里用六条规则做程序化校验，
// 并且是**按顺序模拟推进**着校验 —— 这样连续事件之间的因果也能查到。

import { toMs, localHour, localWeekday, timezone } from './time.js';
import { narrativeLength } from '../persona/card.js';
import { Timeline, Place, EventKind, PLACE_LABEL } from './state.js';

export const Severity = { HARD: 'hard', SOFT: 'soft' };

const RULES = {
  R1: '时钟单调',
  R2: '地点占用',
  R3: '在场一致',
  R4: '作息窗口',
  R5: '跨度重叠',
  R6: '引用存在',
  R7: '叙述时钟',
  R8: '睡眠时段',
  R9: '叙事篇幅',
};

/** 硬矛盾：必须拒绝重生成；软矛盾：自动补字段并留痕 */
const HARD_RULES = new Set(['R1', 'R2', 'R5', 'R7', 'R8']);

// ---------- 睡眠时段：这段时间里只能有睡眠中极细微的事 ----------

/** 清醒才会做的事，出现在睡眠时段就是「两点写出了七点的事」 */
const AWAKE_WORDS = [
  '起床', '醒来', '洗漱', '刷牙', '洗脸', '出门', '上班', '通勤', '到公司', '到工位',
  '做饭', '做早饭', '早餐', '早饭', '泡咖啡', '冲咖啡', '收拾碗筷', '洗完澡',
  '该起了', '该起床', '该上班', '新的一天', '早上好',
];

/** 中文数字 → 整数 */
const CN_NUM = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function cnHour(token) {
  const t = String(token ?? '').trim();
  if (/^\d{1,2}$/.test(t)) return Number(t);
  if (t === '十') return 10;
  if (t === '二十') return 20;
  if (/^二十[一二三四]$/.test(t)) return 20 + CN_NUM[t[2]];
  if (/^十[一二三四五六七八九]$/.test(t)) return 10 + CN_NUM[t[1]];
  if (t.length === 1 && t in CN_NUM) return CN_NUM[t];
  return null;
}

const MERIDIEM = {
  凌晨: 0, 清晨: 0, 早上: 0, 上午: 0, 中午: 12, 下午: 12, 傍晚: 12, 晚上: 12, 夜里: 0, 半夜: 0,
};

const CLOCK_RE = /(早上|上午|凌晨|清晨|中午|下午|傍晚|晚上|夜里|半夜)?\s*(二十[一二三四]|十[一二三四五六七八九]|\d{1,2}|[一二三四五六七八九]|十)\s*[点點時时](半|过|多|整)?/g;
/** 「现在七点了」「已经两点了」「快七点了」这类在声明当前时刻的说法 */
const CURRENT_CLAIM = /(现在|已经|到了|快到|快|才|刚过|都)\s*$/;

/**
 * 从叙述里找出「现在几点」的声明。只认声明当前时刻的说法，
 * 「昨晚十一点」这种过去时间的正常回忆不会被误伤。
 */
export function extractClockClaims(text) {
  const out = [];
  const s = String(text ?? '');
  for (const m of s.matchAll(CLOCK_RE)) {
    const hour = cnHour(m[2]);
    if (hour === null) continue;
    const mer = MERIDIEM[m[1] ?? ''] ?? null;
    let h = hour;
    if (mer !== null && hour < 12) h = hour + mer;
    if (h >= 24) h -= 24;
    const before = s.slice(Math.max(0, m.index - 8), m.index);
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 3);
    const isClaim = CURRENT_CLAIM.test(before) || /^[了整多]/.test(after);
    if (isClaim) out.push({ hour: h, phrase: (before.slice(-4) + m[0] + after.slice(0, 1)).trim() });
  }
  return out;
}

/**
 * R9 叙事篇幅：散文写得太短就不算叙事，只算流水账。
 * 这是「主动发消息」能不能发生的前提 —— 三句话带过的一段生活里，她不会想起谁。
 */
export function narrationTooShort(narration, persona, at = Date.now()) {
  const { min } = narrativeLength(persona);
  // 睡眠中的一拍本来就没什么事可写，放宽下限，否则模型为了凑字数会写出清醒活动
  const floor = sleepState(persona, at).asleep ? 120 : min;
  const n = [...String(narration ?? '')].length;
  if (!n) return [violation('R9', Severity.HARD, '缺少 narration，必须写一段完整的叙事', { length: 0 })];
  if (n < floor) {
    return [violation('R9', Severity.HARD,
      `叙事只有 ${n} 字，不足 ${floor} 字——要写具体动作、感官细节和落在身体上的心理活动，不能三句话带过`,
      { length: n, min: floor })];
  }
  return [];
}

/**
 * 散文的最后一道闸：把仍然违规的句子整句删掉，留下审计记录。
 * 只在重试耗尽后才动刀，正常情况不该走到这里。
 */
export function sanitizeNarration(narration, { at = Date.now(), persona = null } = {}) {
  const text = String(narration ?? '');
  const pieces = text.split(/(?<=[。！？…])|\n+/).filter(Boolean);
  const kept = [];
  const removed = [];
  for (const piece of pieces) {
    const v = validateNarration(piece, { at, persona });
    if (v.length) removed.push({ text: piece.trim(), reasons: v.map((x) => x.message) });
    else kept.push(piece);
  }
  return { text: kept.join('').trim(), removed };
}

/**
 * R7 + R8：校验散文本身。
 * - R7 叙述里声明的当前时刻必须与事件时间一致（±1 小时内允许「快七点了」）
 * - R8 睡眠时段里不许出现清醒活动
 */
export function validateNarration(narration, { at = Date.now(), persona = null } = {}) {
  const violations = [];
  const text = String(narration ?? '');
  if (!text.trim()) return violations;
  const hour = localHour(at);

  // R7
  for (const c of extractClockClaims(text)) {
    let diff = Math.abs(c.hour - hour);
    if (diff > 12) diff = 24 - diff;
    if (diff > 1) {
      violations.push(violation('R7', Severity.HARD,
        `叙述里写着「${c.phrase}」，但这一刻实际是 ${hour} 点——不许把时间写错，也不许跳到还没到的时刻`,
        { claimed: c.hour, actual: hour }));
    }
  }

  // R8
  const sleep = sleepState(persona, at);
  if (sleep.asleep) {
    const hit = AWAKE_WORDS.find((w) => text.includes(w));
    if (hit) {
      violations.push(violation('R8', Severity.HARD,
        `现在是睡眠时段（${sleep.note}），叙述里却出现「${hit}」——睡眠中只允许翻身、半醒、梦的碎片这类极细微的事`,
        { word: hit }));
    }
  }
  return violations;
}

/** 某一刻她是不是在睡觉（由角色卡作息推导） */
export function sleepState(persona, at = Date.now()) {
  const r = persona?.rhythm ?? {};
  const parse = (v, dflt) => {
    const m = String(v ?? '').match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
    return m ? Number(m[1]) + Number(m[2]) / 60 : dflt;
  };
  const sleepAt = parse(r.sleepAround, 22.5);
  const wakeAt = parse(r.wakeAround, 7.5);
  const mins = Number(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone(), minute: '2-digit', hour12: false,
  }).format(new Date(at)) ?? 0);
  const h = localHour(at) + (Number.isFinite(mins) ? mins : 0) / 60;
  const asleep = sleepAt > wakeAt ? (h >= sleepAt || h < wakeAt) : (h >= sleepAt && h < wakeAt);
  return {
    asleep,
    sleepAt,
    wakeAt,
    note: `${String(Math.floor(sleepAt)).padStart(2, '0')}:${String(Math.round((sleepAt % 1) * 60)).padStart(2, '0')}`
      + ` 至 ${String(Math.floor(wakeAt)).padStart(2, '0')}:${String(Math.round((wakeAt % 1) * 60)).padStart(2, '0')}`,
  };
}

function violation(rule, severity, message, extra = {}) {
  return { rule, ruleName: RULES[rule], severity, message, ...extra };
}

/**
 * 校验一组草稿事件。
 * @param {Array} drafts 模型本轮产出的世界事件
 * @param {Timeline} timeline 已提交的时间轴
 * @param {{now:number, registry?:{get:Function}}} ctx
 * @returns {{violations:Array, hard:Array, soft:Array, ok:boolean}}
 */
export function validateDrafts(drafts, timeline, ctx = {}) {
  const violations = [];
  const now = ctx.now ?? Date.now();
  const sim = new Timeline(timeline.events, timeline.startPlace);
  let prevAt = sim.lastAt();

  for (const [index, d] of (drafts ?? []).entries()) {
    const at = toMs(d?.at);

    // R1 时钟单调：不能早于已提交的最后一条，也不能超过现在
    if (!Number.isFinite(at)) {
      violations.push(violation('R1', Severity.HARD, `第 ${index + 1} 条事件时间无法解析: ${d?.at}`, { index }));
      continue;
    }
    if (prevAt !== null && at < prevAt) {
      violations.push(violation('R1', Severity.HARD,
        `第 ${index + 1} 条事件时间 ${new Date(at).toISOString()} 早于已提交的最后一条 ${new Date(prevAt).toISOString()}（时间倒流）`,
        { index }));
    }
    if (at > now) {
      violations.push(violation('R1', Severity.HARD,
        `第 ${index + 1} 条事件时间 ${new Date(at).toISOString()} 晚于当前时间（写到了未来）`,
        { index }));
    }

    // R2 地点占用：move 的出发地必须等于当前实际所在地；目的地不能和当前相同
    if (d?.kind === EventKind.MOVE) {
      const cur = sim.placeAt(at);
      const to = d.to ?? d.place;
      if (d.from && d.from !== cur) {
        violations.push(violation('R2', Severity.HARD,
          `第 ${index + 1} 条：写「从${PLACE_LABEL[d.from] ?? d.from}出发」，但那一刻她实际在${PLACE_LABEL[cur] ?? cur}` +
          `（${cur === Place.HOME ? '她已经出门了，不能再从家出发' : '出发点与当前位置矛盾'}）`,
          { index, from: d.from, actual: cur }));
      }
      if (to && to === cur) {
        violations.push(violation('R2', Severity.HARD,
          `第 ${index + 1} 条：移动到${PLACE_LABEL[to] ?? to}，但她此刻已经在这里了`,
          { index, to, actual: cur }));
      }
    }

    // R3 在场一致：参与事件的虚构角色必须能在该地点出现，否则要标 remote
    if (Array.isArray(d?.actors) && d.actors.length && !d.remote) {
      const place = d.kind === EventKind.MOVE ? (d.to ?? d.place) : sim.placeAt(at);
      for (const actorId of d.actors) {
        const actor = ctx.registry?.get?.(actorId);
        if (!actor || actor.kind !== 'fictional') continue;
        const allowed = actor.presence?.places;
        if (Array.isArray(allowed) && allowed.length && !allowed.includes(place)) {
          violations.push(violation('R3', Severity.SOFT,
            `第 ${index + 1} 条：${actor.displayName} 不会出现在${PLACE_LABEL[place] ?? place}，` +
            `若是远程联系请标 remote:true`,
            { index, actorId, place }));
        }
        if (actor.presence?.remoteOnly) {
          violations.push(violation('R3', Severity.SOFT,
            `第 ${index + 1} 条：${actor.displayName} 只能远程联系，请标 remote:true`,
            { index, actorId }));
        }
      }
    }

    // R4 作息窗口：深夜不该在外/公司；工作时段不该在家（软）
    if (d?.kind === EventKind.MOVE) {
      const h = localHour(at);
      const to = d.to ?? d.place;
      if (h >= 1 && h < 7 && [Place.OFFICE, Place.OUTSIDE, Place.TRANSIT].includes(to)) {
        violations.push(violation('R4', Severity.SOFT,
          `第 ${index + 1} 条：凌晨 ${h} 点移动到${PLACE_LABEL[to] ?? to}，与「夜猫子但在家」的作息不符`,
          { index, hour: h }));
      }
      const wd = localWeekday(at);
      const isWorkday = wd >= 1 && wd <= 5;
      if (isWorkday && h >= 10 && h < 18 && to === Place.HOME && sim.placeAt(at) === Place.OFFICE) {
        violations.push(violation('R4', Severity.SOFT,
          `第 ${index + 1} 条：工作日 ${h} 点从公司回到家里，通常这个点她应在公司`,
          { index, hour: h }));
      }
    }

    // R5 跨度重叠：同一时段不能有两个进行中的持续事件
    if (d?.span?.from && d?.span?.to) {
      const f = toMs(d.span.from);
      const t = toMs(d.span.to);
      if (Number.isFinite(f) && Number.isFinite(t) && t <= f) {
        violations.push(violation('R5', Severity.HARD, `第 ${index + 1} 条：事件跨度结束早于开始`, { index }));
      }
      for (const e of sim.events) {
        if (!e?.span?.from || !e?.span?.to) continue;
        const ef = toMs(e.span.from);
        const et = toMs(e.span.to);
        if (!Number.isFinite(ef) || !Number.isFinite(et)) continue;
        if (f < et && ef < t) {
          violations.push(violation('R5', Severity.HARD,
            `第 ${index + 1} 条：与已发生事件「${String(e.prose ?? '').slice(0, 20)}…」时段重叠`,
            { index }));
          break;
        }
      }
    }

    // R6 引用存在：提到的角色必须已注册
    for (const actorId of d?.actors ?? []) {
      if (ctx.registry && !ctx.registry.get(actorId)) {
        violations.push(violation('R6', Severity.SOFT, `第 ${index + 1} 条：引用了未注册的角色 ${actorId}`, { index, actorId }));
      }
    }

    // R8 睡眠时段：睡着的时候不该有位移，更不该出现清醒才会做的事
    if (Number.isFinite(at)) {
      const sleep = sleepState(ctx.persona, at);
      if (sleep.asleep) {
        const blob = `${String(d?.summary ?? '')} ${String(d?.prose ?? '')}`;
        if (d?.kind === EventKind.MOVE) {
          violations.push(violation('R8', Severity.HARD,
            `第 ${index + 1} 条：睡眠时段（${sleep.note}）不该有位移，睡觉就只是睡觉`, { index }));
        } else if (d?.kind === EventKind.ACT) {
          const hit = AWAKE_WORDS.find((w) => blob.includes(w));
          if (hit) {
            violations.push(violation('R8', Severity.HARD,
              `第 ${index + 1} 条：睡眠时段却写了「${hit}」——那是一天里别的时刻才会发生的事`, { index, word: hit }));
          }
        }
      }
    }

    sim.commit([d]);
    prevAt = Number.isFinite(at) ? at : prevAt;
  }

  const hard = violations.filter((v) => HARD_RULES.has(v.rule));
  const soft = violations.filter((v) => !HARD_RULES.has(v.rule));
  return { violations, hard, soft, ok: violations.length === 0 };
}

export { RULES };
