// 重复检测：同一句话别再说第二遍。
//
// 「你怎么醒这么早」连着出现两次，就是这个世界状态与对话分家之后最容易漏的一类问题：
// 世界阶段不知道上一轮说过什么，对话阶段又可能照着触发消息复述一遍。
// 这里在对话写入前做一次拦截：与最近说过的话比对，重复就打回重写。

/** 归一化：去掉标点、空白、句号，只比内容 */
export function normalizeForCompare(s) {
  return String(s ?? '')
    .replace(/[\s]/g, '')
    .replace(/[。．、，,；;：:！!？?~～…"“”'’()（）\[\]【】]/g, '')
    .toLowerCase();
}

/** 字符 bigram 的 Jaccard 相似度 */
export function similarity(a, b) {
  const A = normalizeForCompare(a);
  const B = normalizeForCompare(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  const grams = (s) => {
    const out = new Set();
    for (let i = 0; i + 2 <= s.length; i += 1) out.add(s.slice(i, i + 2));
    if (s.length === 1) out.add(s);
    return out;
  };
  const ga = grams(A);
  const gb = grams(B);
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter += 1;
  return inter / (ga.size + gb.size - inter || 1);
}

/**
 * 找出与最近对话重复的句子。
 * @param {string[]} candidates 本轮准备说的话
 * @param {string[]} recentSays 最近已经说过的话（越靠后越近）
 * @param {{window?:number, exactMinLen?:number, simThreshold?:number}} opts
 */
export function detectRepeat(candidates, recentSays, opts = {}) {
  const window = opts.window ?? 30;
  const exactMinLen = opts.exactMinLen ?? 3;   // 短于 3 字的「嗯」「好」不算重复（常用回应）
  const simThreshold = opts.simThreshold ?? 0.7;
  const recent = (recentSays ?? []).slice(-window);

  const repeats = [];
  for (const c of candidates ?? []) {
    const cNorm = normalizeForCompare(c);
    if (!cNorm) continue;
    let hit = null;
    for (const r of recent) {
      const rNorm = normalizeForCompare(r);
      if (!rNorm) continue;
      if (rNorm === cNorm && cNorm.length >= exactMinLen) {
        hit = { matched: r, kind: 'exact', score: 1 };
        break;
      }
      const s = similarity(cNorm, rNorm);
      if (s >= simThreshold && cNorm.length >= 4) {
        hit = { matched: r, kind: 'similar', score: Number(s.toFixed(2)) };
        break;
      }
    }
    if (hit) repeats.push({ content: c, ...hit });
  }
  return repeats;
}

/** 给提示词用的「最近说过的话」清单 */
export function renderRecentSays(recentSays, limit = 12) {
  const list = (recentSays ?? []).slice(-limit);
  if (!list.length) return '';
  return ['<你最近刚说过的话（不要再说一遍，也不要换个说法重复同样的意思）>',
    ...list.map((s) => `- ${s}`),
    '</你最近刚说过的话>'].join('\n');
}
