// 文体强制执行：模型写错了，代码也把它改对。
//
// 句号问题在 HDS 里修了两轮都没断根 —— 因为那是靠提示词约束的，而提示词里的
// 一条负面指令扛不住长上下文里几十处「剧本样本」。这里改成程序化执行：
// 每条气泡在出站前过一遍 enforceStyle，句尾句号直接删掉，超长直接拆条。
// 模型写不写句号已经不影响结果。

/**
 * 去掉句尾句号（含句号后跟引号/括号、以及中文句号 variants）。
 * 保留 ？！……~ 与句尾语气词。
 */
export function stripTerminalPeriod(s) {
  let out = String(s ?? '').trimEnd();
  // 句号可能被包在引号里：「知道了。」或 "知道了。"
  out = out.replace(/([。．])(["”』」】）]?)$/, '$2');
  return out.trimEnd();
}

/** 句中句号降级为逗号（口语里不会在句中用句号断句） */
export function degradeInnerPeriod(s) {
  return String(s ?? '').replace(/[。．](?=.)/g, '，');
}

/** 感叹号降级：角色卡写明「几乎不用！」，超出允许比例就换成语气词或直接去掉 */
export function degradeExclamation(s, rate = 0.05, rng = Math.random) {
  const text = String(s ?? '');
  const marks = (text.match(/[!！]/g) ?? []).length;
  if (marks === 0) return text;
  const chars = [...text].length || 1;
  if (marks / chars <= rate) return text;
  // 保留第一个感叹（情绪最高点），其余换成语气词或直接去掉
  let kept = false;
  let out = '';
  for (const ch of text) {
    if (ch === '!' || ch === '！') {
      if (!kept) { out += ch; kept = true; } else { out += '~'; }
    } else {
      out += ch;
    }
  }
  return out;
}

/** 超长拆条：按逗号/空格/顿号切成碎碎念多条 */
export function splitLong(s, hardMaxChars = 40) {
  const text = String(s ?? '').trim();
  if ([...text].length <= hardMaxChars) return [text];
  const parts = [];
  let buf = '';
  for (const chunk of text.split(/(?<=[，,、；;。！？~…])/)) {
    if ([...buf].length + [...chunk].length > hardMaxChars && buf) {
      parts.push(buf.trim());
      buf = chunk;
    } else {
      buf += chunk;
    }
  }
  if (buf.trim()) parts.push(buf.trim());
  // 兜底：还是太长就硬切
  const out = [];
  for (const p of parts) {
    if ([...p].length <= hardMaxChars) { out.push(p); continue; }
    let rest = p;
    while ([...rest].length > hardMaxChars) {
      out.push([...rest].slice(0, hardMaxChars).join(''));
      rest = [...rest].slice(hardMaxChars).join('');
    }
    if (rest) out.push(rest);
  }
  return out.filter((x) => x.trim());
}

/** 清理连续重复标点与首尾空白 */
export function collapsePunct(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[，,]{2,}/g, '，')
    .replace(/[~～]{3,}/g, '~~')
    .trim();
}

/**
 * 对一组气泡执行全部文体规则。
 * @param {string[]} bubbles 模型产出的气泡原文
 * @param {object} speech persona.speech
 * @returns {string[]} 可直接投递的气泡
 */
export function enforceStyle(bubbles, speech = {}, stage = null) {
  const maxChars = stage?.maxChars ?? speech.maxChars ?? 15;
  const maxBubbles = stage?.maxBubbles ?? speech.maxBubbles ?? 6;
  const maxTotalChars = stage?.maxTotalChars ?? speech.maxTotalChars ?? 0;
  // 单条上限不能超过整轮上限，否则第一轮就会被「至少留一条」逼着超发
  let hardMaxChars = stage?.hardMaxChars ?? speech.hardMaxChars ?? 40;
  if (maxTotalChars > 0) hardMaxChars = Math.min(hardMaxChars, maxTotalChars);
  const exclamationRate = speech.exclamationRate ?? 0.05;
  const out = [];
  for (const raw of bubbles ?? []) {
    let s = String(raw ?? '').trim();
    if (!s) continue;
    s = degradeInnerPeriod(s);
    s = stripTerminalPeriod(s);
    s = degradeExclamation(s, exclamationRate);
    s = collapsePunct(s);
    if (!s) continue;
    const pieces = splitLong(s, hardMaxChars);
    out.push(...pieces.map((p) => stripTerminalPeriod(collapsePunct(p))));
    void maxChars;
  }
  let kept = out.filter((x) => x.trim());

  // 一轮最多几条（阶段决定：疏离期 2 条）
  if (maxBubbles > 0 && kept.length > maxBubbles) kept = kept.slice(0, maxBubbles);

  // 一轮总共最多多少字（疏离期 12 字）
  if (maxTotalChars > 0) {
    const trimmed = [];
    let total = 0;
    for (const b of kept) {
      const n = [...b].length;
      if (total + n > maxTotalChars) break;
      trimmed.push(b);
      total += n;
    }
    // 至少留一条，否则变成完全不回
    kept = trimmed.length ? trimmed : kept.slice(0, 1);
  }
  return kept;
}

/**
 * 文体体检：给一轮产物打分，问题逐条列出（控制台与回归测试用）。
 * @returns {{score:number, issues:string[], stats:object}}
 */
export function styleLint(bubbles, speech = {}) {
  const hardMaxChars = speech.hardMaxChars ?? 40;
  const list = (bubbles ?? []).map((x) => String(x ?? '').trim()).filter(Boolean);
  const issues = [];
  let periodEnd = 0;
  let tooLong = 0;
  let exclaim = 0;
  for (const b of list) {
    if (/[。．]\s*$/.test(b)) { periodEnd += 1; issues.push(`句尾带句号: ${b}`); }
    if ([...b].length > hardMaxChars) { tooLong += 1; issues.push(`超过 ${hardMaxChars} 字: ${b}`); }
    if (/[!！]/.test(b)) exclaim += 1;
    if (/^(亲|宝子|集美|家人们)/.test(b)) issues.push(`用了禁止的网络称呼: ${b}`);
  }
  const n = list.length || 1;
  const score = Math.max(0, 100 - (periodEnd / n) * 60 - (tooLong / n) * 30 - (exclaim / n) * 10);
  return {
    score: Math.round(score),
    issues,
    stats: { count: list.length, periodEnd, tooLong, exclaim },
  };
}

/**
 * 提交前的最终兜底：即便前面漏了，这里也会把句号清干净。
 * 返回 { bubbles, corrections } —— corrections 记录程序改了什么（审计用）。
 */
export function finalSanitize(bubbles, speech = {}) {
  const corrections = [];
  const out = [];
  for (const raw of bubbles ?? []) {
    const before = String(raw ?? '').trim();
    if (!before) continue;
    const after = enforceStyle([before], speech);
    if (!after.length) continue;
    for (const piece of after) {
      out.push(piece);
      if (piece !== before) corrections.push({ before, after: piece });
    }
  }
  return { bubbles: out, corrections };
}
