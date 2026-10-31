// 世界事件校验：模型写出来的每一条事件都要过这一关。
//
// HDS 唯一的时间校验只看剧本前 30 个字符的时钟是否超前，完全不查条目之间的矛盾，
// 于是「下午出了两次门」这种硬伤一路写进故事。这里用六条规则做程序化校验，
// 并且是**按顺序模拟推进**着校验 —— 这样连续事件之间的因果也能查到。

import { toMs, localHour, localWeekday, timezone } from './time.js';
import { narrativeLength } from '../persona/card.js';
import { Timeline, Place, EventKind, PLACE_LABEL } from './state.js';
import { resolveSpeech } from './speech.js';

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
  R10: '话语归属',
  R11: '话语主体',
  R12: '同住边界',
  R13: '行程一致',
  R14: '途中未抵达',
};

/** 时钟容差：模型常把时间写到整秒/整分，比毫秒级的真实记录早零点几秒；
 *  这算同一时刻，不该判成「时间倒流」去白白重写一轮。 */
const CLOCK_TOLERANCE_MS = 1000;

/** 硬矛盾：必须拒绝重生成；软矛盾：自动补字段并留痕 */
const HARD_RULES = new Set(['R1', 'R2', 'R5', 'R7', 'R8', 'R10', 'R11', 'R12', 'R13', 'R14']);

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

/** 复述「她回复了他」的说法——出现这些的 say 事件是在替对话阶段写她的话。
 *  她回没回、回得迟不迟是事实（可以写成 act），回了什么不是这一阶段的事。 */
const REPLY_MARKERS = [
  '回了一句', '回了句', '回他', '回你', '回给', '回了一条', '回了条', '回复了一句', '回复了句',
  '应了一句', '应了句', '答应了一句', '答了一句', '答了句',
  '发了一句', '发了句', '发了一条', '敲了一句', '写了句', '写了一句', '打了句', '打了一句',
  '秒回', '打字回', '斟酌后回', '改了几遍才回', '删改几次后回', '删了又打', '重新组织语言回',
  '把刚才的事告诉他', '顺嘴说了句那件事', '把这话发给', '把自己手边的事说给他',
  // 2026-10-29：世界阶段（尤其 auto 推进）常直接写"已发送"的结果。这些不在上面
  // "复述内容"的语义里，但同样是在替对话阶段宣布"发送已完成"——不拦就会出现
  // 故事里她回了、QQ 上却没消息。加进来，让 R10 一并降级成过程。
  '回了过去', '回了消息', '发了过去', '发了出去', '发出去了',
  '按了发送', '点了发送', '发送成功', '已发送',
];

/** 配角显示名列表：registry 缺失时退回空数组（不影响其他规则） */
function castNameList(ctx) {
  try {
    const list = ctx?.registry?.fictionalCast?.() ?? [];
    return list.map((a) => a?.displayName).filter(Boolean);
  } catch {
    return [];
  }
}

/** 发送类说法：引号内容前面出现这些，说明那句引号是「她打给他/发给他的话」 */
const SEND_MARKERS = [
  '打出来', '打出', '打完', '敲了', '敲出', '敲字', '输入', '码了', '打了',
  '发出去', '发出', '发送', '发了', '发过去', '回了', '回复', '回他', '回你', '回给',
  '补一句', '补了句', '又补', '删改', '删了又打', '删掉又打', '按下发送', '按了发送',
  '改了又改', '斟酌', '删了两个字', '删了字', '发送出去',
];

/** 引述标记：引号前出现这些，说明那句是「他发来的消息」或屏幕上的字，不是她要发出的 */
const QUOTE_MARKERS = [
  '看到', '看见', '那行字', '屏幕上', '写着', '他发来', '他发的', '发来的', '消息是',
  '那句是', '他问', '他说', '问他', '问他道', '回想起他说', '他之前说',
];

/**
 * 抹掉叙事里「她打给他 / 发给他」的原话。
 *
 * 她真正发了什么由对话阶段决定；这一阶段把原话写进散文，就会出现
 * 「故事里她说 A，QQ 上收到的是 B」。只抹引号里的内容，动作与余波都保留，
 * 因此「她慢慢打出来，中间删了「早」字又加回去」会变成
 * 「她慢慢打出来，中间删了字又加回去」——读起来照样顺。
 *
 * @param {string} narration
 * @param {{castNames?:string[]}} opts
 * @returns {{text:string, removed:string[]}}
 */
export function sanitizeOwnSays(narration, { castNames = [] } = {}) {
  const text = String(narration ?? '');
  if (!text.trim()) return { text, removed: [] };
  const removed = [];
  // 「X」她慢慢打出来 / 她慢慢打出来「X」两种写法都要认，所以前后各看一段
  const out = text.replace(/([「『“]([^「」『』”]{1,40})[」』”])(：|:)?/g, (full, quoted, inner, colon, offset, str) => {
    const before = str.slice(Math.max(0, offset - 26), offset);
    const after = str.slice(offset + quoted.length, offset + quoted.length + 26);
    const ctx = before + after;
    if (QUOTE_MARKERS.some((m) => before.includes(m) || after.includes(m))) return full; // 他发来的/屏幕上的字
    if (castNames.some((n) => n && ctx.includes(n))) return full; // 配角当场说的话
    // 发送动作可以在引号前，也可以在引号后（「X」她慢慢打出来）
    if (!SEND_MARKERS.some((m) => before.includes(m)) && !SEND_MARKERS.some((m) => after.includes(m))) return full;
    removed.push(inner);
    return ''; // 连同紧跟的冒号一起去掉，免得留下「又补一句：」
  });
  return { text: out.replace(/[ 　]{2,}/g, ' '), removed };
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

// ---------- R14 的用词判定 ----------
//
// 在途和已达的区别只在措辞里，字段看不出来：place 都填 transit，
// 但一句「到超市门口啦」就让她瞬移到了。所以这里只看话，不看字段。
//
// 两段正则分工：
//   NOT_YET = 路上该说的（还没到 / 快到了 / 再走五分钟）——先剔掉，剔完剩下的才算嫌疑
//   ARRIVED = 抵达该说的（到了 / 进门 / 下车 / 站在门口）
// 目的地名取自这次行程的 move.to —— 不是地点白名单，没预登记的地儿照样管得着。
const NOT_YET_SRC = '(还|都)?没(有|过)?[^。！？，,；;]{0,8}?(到|进|下|出)(了|啦|车|站)?'
  + '|(快|就快|马上|就要|即将|快要|将要|要|将)[^。！？，,；;]{0,6}?到(了|啦|达)?'
  + '|再[^。！？，,；;]{0,10}?就?到(了|啦)?'
  + '|还有[^。！？，,；;]{0,10}?到'
  + '|差[^。！？，,；;]{0,6}?到'
  + '|在路上|在车上|还没|换乘|转乘|转线|准备到|起身|快到';

const ARRIVED_SRC = '到了|到啦|到达|到站|已经到|走进(门|楼|店|超市|公司|家|屋)'
  + '|到(家|公司|店|楼|门口)(了|啦)|回(到)?(家|公司|店)(了|啦)'
  + '|进了?(门|楼|店|超市|公司|家|屋)|进(门|屋)|推门|跨进'
  + '|下车了|出站|站在[^。！？，,；;]{0,6}?(门口|门边|门前)';

/** 地点标签取短名：'超市/菜场' → '超市'，'外面（和熟人聚会）' → '外面' */
export function shortPlace(id) {
  const raw = PLACE_LABEL[id];
  if (!raw) return '';
  return String(raw).split('/')[0].replace(/（[^）]*）/g, '').trim();
}

/**
 * 这段文字有没有「我到了」。
 * @param {string} text 事件的 summary + prose（或她要说的话）
 * @param {string} toPlace 这段行程的目的地 id
 * @returns {string} 命中的说法，没命中返回空串
 */
export function findArrivalClaim(text, toPlace) {
  const s = String(text ?? '');
  if (!s.trim()) return '';
  // 「收到消息：到家了吗」是他问的，「陈哥问她外卖是不是也到了」是别人说的。
  // 只判她自己的宣称，引述一律放行。
  if (/^\s*(收到消息|他发来|他说|他问|他：|他\s)/.test(s)) return '';
  if (/(吗|呢)\s*[。？?]?\s*$/.test(s) && /(到了|到家了|到了吗)/.test(s)) return '';
  const stripped = s.replace(new RegExp(NOT_YET_SRC, 'g'), ' ');
  const hit = stripped.match(new RegExp(ARRIVED_SRC));
  if (hit) return hit[0];
  const label = shortPlace(toPlace);
  if (label) {
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = stripped.match(new RegExp(`${esc}(门口|门前|里面|里头|大厅|里)`));
    if (m) return m[0];
  }
  return '';
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
    let at = toMs(d?.at);

    // R1 时钟单调：不能早于已提交的最后一条，也不能超过现在
    if (!Number.isFinite(at)) {
      violations.push(violation('R1', Severity.HARD, `第 ${index + 1} 条事件时间无法解析: ${d?.at}`, { index }));
      continue;
    }
    if (prevAt !== null && at < prevAt - CLOCK_TOLERANCE_MS) {
      violations.push(violation('R1', Severity.HARD,
        `第 ${index + 1} 条事件时间 ${new Date(at).toISOString()} 早于已提交的最后一条 ${new Date(prevAt).toISOString()}（时间倒流）`,
        { index }));
    }
    // 容差内（同一秒左右）：程序直接顺延，不判违规、也不回灌重写。
    // 这只是模型时间精度不够（整秒 vs 毫秒），不是矛盾；
    // 报成违规会让每个用户回合都白跑一轮重写，拖慢回复。
    if (prevAt !== null && at >= prevAt - CLOCK_TOLERANCE_MS && at <= prevAt) {
      d.at = new Date(prevAt + 1000).toISOString();
      at = prevAt + 1000;
    }
    if (at > now + CLOCK_TOLERANCE_MS) {
      violations.push(violation('R1', Severity.HARD,
        `第 ${index + 1} 条事件时间 ${new Date(at).toISOString()} 晚于当前时间（写到了未来）`,
        { index }));
    }

    // R11 话语主体：say 必须写清「谁说的、说给谁」。
    // 2026-10-29 审计：821 条 say 里有 335 条只有 ('self',)、28 条是 ('self','c:linxia')
    // 却同时装着「她对林夏说」和「林夏对她说」——读取端只能猜，A 的事就被套到 B 身上。
    if (d?.kind === EventKind.SAY) {
      const sp = String(d?.speaker ?? '').trim();
      const to = String(d?.to ?? '').trim();
      if (!sp) {
        violations.push(violation('R11', Severity.HARD,
          `第 ${index + 1} 条 say 事件没有 speaker——必须写清这句话是谁说的（self 或 c:xxx）`,
          { index }));
      } else if (sp.startsWith('u:')) {
        violations.push(violation('R11', Severity.HARD,
          `第 ${index + 1} 条 say 事件的 speaker 是真实用户——他不在这一阶段的场景里，不许替他写话`,
          { index }));
      } else if (sp !== 'self' && !sp.startsWith('c:')) {
        violations.push(violation('R11', Severity.HARD,
          `第 ${index + 1} 条 say 事件的 speaker「${sp}」不合法，只能填 self 或 c:xxx`,
          { index }));
      }
      if (to && !to.startsWith('c:') && to !== 'self') {
        violations.push(violation('R11', Severity.HARD,
          `第 ${index + 1} 条 say 事件的 to「${to}」不合法，只能填 c:xxx、self 或留空`,
          { index }));
      }
      if (to && to === sp) {
        violations.push(violation('R11', Severity.HARD,
          `第 ${index + 1} 条 say 事件自己说给自己（speaker 与 to 相同）`,
          { index }));
      }
    }

    // R10 话语归属：这一阶段不许替她写下「对他说出口的话」——那部分由对话阶段产出。
    // 两边兼写的结果就是：故事里她说「知道啦，这就躺下」，实际发给他的是「嗯」。
    if (d?.kind === EventKind.SAY) {
      const { speaker, to: resolvedTo } = resolveSpeech(d, {
        nameOf: (id) => ctx.registry?.get?.(id)?.displayName ?? id,
      });
      const toUser = speaker.startsWith('u:') ? speaker : (String(resolvedTo ?? '').startsWith('u:') ? resolvedTo : null);
      if (toUser) {
        violations.push(violation('R10', Severity.HARD,
          `第 ${index + 1} 条 say 事件写的是她对 ${toUser} 说的话——这一阶段不写她对「他」说的话，那部分由对话阶段产出`,
          { index }));
      } else if (!resolvedTo) {
        // 另一种更隐蔽的越界：用 say 事件复述「她回了他什么」
        // （summary 写成「回了一句，说还早呢，再玩会儿」）。故事里于是多出一段她的话，
        // 而 QQ 上真正发出去的是对话阶段产出的另一句——两边永远对不上。
        // 她回没回、回得迟不迟是可以用 act 写的事实，至于回了「什么」，这里不许替她编。
        const blob = `${String(d?.summary ?? '')} ${String(d?.prose ?? '')}`;
        const hit = REPLY_MARKERS.find((m) => blob.includes(m));
        if (hit) {
          // 提到配角名字的放行——她对配角回话属于这一阶段该写的内容
          const castNames = castNameList(ctx);
          const mentionsCast = castNames.some((n) => n && blob.includes(n));
          if (!mentionsCast) {
            violations.push(violation('R10', Severity.HARD,
              `第 ${index + 1} 条 say 事件在复述「她回了他什么」（含「${hit}」）——这一阶段不替她写回复的内容，`
              + '把他发消息后她回了这一句写成 act（回没回是事实，回了什么由对话阶段决定）',
              { index }));
          }
        }
      }
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

    // R13 行程一致：她写到的地方，必须是她那一刻真在的地方。
    // 2026-10-30 事故：07:44 上车、07:48 就「最后一站到站」，5 分钟走完 30 分钟的通勤。
    // move 现在带 arriveAt，途中 placeAt 一直是 transit —— 此刻写「到公司了」就是瞬移，
    // 不靠词表也能拦住，因为它校验的是地点，不是措辞。
    if (d?.kind !== EventKind.MOVE && d?.place) {
      const actual = sim.placeAt(at);
      if (d.place !== actual) {
        const j = typeof sim.journeyAt === 'function' ? sim.journeyAt(at) : null;
        const where = j
          ? `还在路上（去${PLACE_LABEL[j.to] ?? j.to}，还剩约 ${j.remainMin} 分钟）`
          : `在${PLACE_LABEL[actual] ?? actual}`;
        violations.push(violation('R13', Severity.HARD,
          `第 ${index + 1} 条写的是${PLACE_LABEL[d.place] ?? d.place}，但那一刻她${where}。`
          + '她还在车上/路上，这一条要写路上的事，或者把地点改成她此刻真在的地方',
          { index, place: d.place, actual }));
      }
    }

    // R14 途中不得宣称抵达 —— R13 的措辞版。
    // 2026-10-31 事故：08:21:48 出门去超市（路网定 5 分钟，arriveAt 08:26:48），
    // 08:22 就写「林夏走到超市门口回头喊她快点」，08:23 直接对他说「到超市门口啦」。
    // R13 查不出来：那些事件的 place 都老老实实填了 transit，错的是话不是字段。
    // 路网图只管住了账（arriveAt、travel.json 的边），管不住嘴 —— 这一条补的就是嘴。
    if (d?.kind !== EventKind.MOVE) {
      const j = typeof sim.journeyAt === 'function' ? sim.journeyAt(at) : null;
      if (j && j.remainMin >= 1) {
        const claim = findArrivalClaim(`${String(d?.summary ?? '')} ${String(d?.prose ?? '')}`, j.to);
        if (claim) {
          const label = shortPlace(j.to);
          // 她亲口对他说「到了」是硬拦：他会当真，下楼接、把饭端上桌，然后发现人还在路上。
          // 旁白里的「走进雨里」「站在门口」多半只是修辞，降成 soft 记一笔，不打断生成——
          // 硬拦一次要重跑一整轮 story，为一句措辞不值。
          // 只有她自己的话算数：陈哥说「我那份外卖也到了」跟她到没到没关系
          const sp = String(d?.speaker ?? '').trim();
          const saidByHer = d?.kind === EventKind.SAY && (sp === '' || sp === 'self');
          violations.push(violation('R14', saidByHer ? Severity.HARD : Severity.SOFT,
            `第 ${index + 1} 条出现「${claim}」，可她那一刻还在去${label}的路上，还要约 ${j.remainMin} 分钟才到。`
            + `路上只能写走路、风、车上、同伴说话；到${label}、下车、进门、站在门口这些，等她真到了再写`,
            { index, claim, to: j.to, remainMin: j.remainMin, saidByHer }));
        }
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

    // R12 同住边界：只有林夏跟她合租。陈哥是同事，一旦出现在住处，等于把设定改成了同居。
    // 2026-10-29 事故：叙事里写「和陈哥一起买鸭翅回去下饭」「回去看看家里还有菜」，
    // 这段被对话阶段接着用，她转头对他说「那快开完回来吃饭」——凭空造出一个共同的家。
    if (Array.isArray(d?.actors) && d.actors.length && !d.remote) {
      const place = d.kind === EventKind.MOVE ? (d.to ?? d.place) : (d.place ?? sim.placeAt(at));
      if (place === Place.HOME) {
        for (const actorId of d.actors) {
          const actor = ctx.registry?.get?.(actorId);
          if (!actor || actor.kind !== 'fictional') continue;
          const allowed = actor.presence?.places;
          if (Array.isArray(allowed) && allowed.length && !allowed.includes(Place.HOME)) {
            violations.push(violation('R12', Severity.HARD,
              `第 ${index + 1} 条：${actor.displayName} 不住她那儿（只是同事/朋友），不能出现在住处——下班可以同路走一段，到路口就该各回各家`,
              { index, actorId }));
          }
        }
      }
    }

    // R4 作息窗口：深夜不该在外/公司；工作时段不该在家（软）
    if (d?.kind === EventKind.MOVE) {
      const h = localHour(at);
      const to = d.to ?? d.place;
      // 凌晨 1–7 点不该出现在「家以外」的任何地方（原来只查 office/outside/transit 三个值，
      // 新增的公园/商场/超市/餐馆/办事会漏掉，这里改成「非 home 一律提示」）
      if (h >= 1 && h < 7 && to && to !== Place.HOME) {
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

  // 判定以「规则是否硬性」为准，但 severity 可以往下调：
  // R14 对她说出口的话是硬拦，对旁白只是记录（一句修辞不值得重跑一整轮）。
  const hard = violations.filter((v) => HARD_RULES.has(v.rule) && v.severity === Severity.HARD);
  const soft = violations.filter((v) => !(HARD_RULES.has(v.rule) && v.severity === Severity.HARD));
  return { violations, hard, soft, ok: violations.length === 0 };
}

export { RULES, REPLY_MARKERS };
