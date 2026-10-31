// 旧剧情审查：从 HDS 数据库读出剧本，抽取位移信号，找出时间线矛盾。
//
// 用法：node src/migration/scan.js <旧 koishi.db 路径> [输出报告路径]
// 只做只读扫描，不改任何东西。报告供人工复核，确认后再由 export.js 导出。

import sqlite3 from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DB = process.argv[2];
const OUT = process.argv[3] || path.join('data', 'legacy-audit.md');

if (!DB) {
  console.error('用法：node src/migration/scan.js <旧 koishi.db 路径> [输出报告路径]');
  process.exit(1);
}

// 位移信号：从散文里识别「她离开了家 / 回到了家 / 到了公司 / 在通勤」
const SIGNAL = [
  { kind: 'out', label: '离家外出', re: /(出门|下楼|离开家|走出(了)?门|出了门|拉(着)?她出去|一起出门|出门去)/ },
  { kind: 'home', label: '回到家', re: /(到家了?|回到家|回到(家|住处|屋里|合租屋|自己的房间)|进了门|推门进|进屋)/ },
  { kind: 'office', label: '到公司', re: /(到(了)?公司|去公司|到工位|赶到公司|走进公司|公司里)/ },
  { kind: 'transit', label: '通勤路上', re: /(上(了)?地铁|坐地铁|地铁里|到地铁站|挤地铁|公交车|打(了)?车|路上)/ },
];

function localTime(ms) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ms));
}

/** 把引号内的引述挖空 —— 「他说：你今天还要出门吗」里的"出门"不是她的动作 */
function stripQuoted(text) {
  return String(text ?? '')
    .replace(/[“"][^”"\n]{1,200}?[”"]/g, (m) => '　'.repeat(m.length));
}

function extractSignals(text) {
  const clean = stripQuoted(text);
  const out = [];
  for (const s of SIGNAL) {
    const m = clean.match(s.re);
    if (m) {
      // 取命中处原文（从原文本取，便于人工复核）
      const idx = clean.indexOf(m[0]);
      const raw = String(text ?? '').slice(Math.max(0, idx), idx + m[0].length) || m[0];
      out.push({ kind: s.kind, label: s.label, matched: raw || m[0] });
    }
  }
  return out;
}

function main() {
  const db = new sqlite3.DatabaseSync(DB, { readOnly: true });
  const rows = db.prepare('SELECT id, kind, content, occurredAt FROM interlude_script_entry WHERE kind = ? ORDER BY occurredAt ASC, id ASC').all('script');
  db.close();

  // 位移序列
  const moves = [];
  for (const r of rows) {
    const sig = extractSignals(r.content ?? '');
    // 一条剧本里可能出现多个信号，取最后一个作为该条的落点（叙事通常先出发后到达）
    if (!sig.length) continue;
    const last = sig[sig.length - 1];
    moves.push({
      entryId: r.id,
      at: r.occurredAt,
      time: localTime(r.occurredAt),
      kind: last.kind,
      label: last.label,
      matched: last.matched,
      excerpt: String(r.content ?? '').replace(/\s+/g, ' ').slice(0, 120),
    });
  }

  // 矛盾检测：连续两次「离家外出」之间若没有「回到家」，就是硬矛盾
  const issues = [];
  for (let i = 1; i < moves.length; i += 1) {
    const prev = moves[i - 1];
    const cur = moves[i];
    if (prev.kind === 'out' && cur.kind === 'out') {
      // 中间是否夹着 home
      let hasHomeBetween = false;
      for (let j = i - 1; j >= 0; j -= 1) {
        if (moves[j].kind === 'home') { hasHomeBetween = true; break; }
        if (moves[j].kind === 'out' && j < i - 1) break;
      }
      if (!hasHomeBetween) {
        issues.push({
          type: 'DOUBLE_DEPARTURE',
          severity: 'hard',
          time: cur.time,
          entryId: cur.entryId,
          detail: `在 ${prev.time} 已经写过「${prev.matched}」，中间没有回家记录，${cur.time} 又写了「${cur.matched}」`,
          excerpt: cur.excerpt,
          prevEntryId: prev.entryId,
        });
      }
    }
    // 通勤后没有到达任何地方又开始新的外出
    if (prev.kind === 'transit' && cur.kind === 'out') {
      issues.push({
        type: 'TRANSIT_THEN_OUT',
        severity: 'soft',
        time: cur.time,
        entryId: cur.entryId,
        detail: `${prev.time} 还在通勤，${cur.time} 又写外出`,
        excerpt: cur.excerpt,
      });
    }
  }

  // 时间倒流检测（条目时间非递增）
  const backflow = [];
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].occurredAt < rows[i - 1].occurredAt) {
      backflow.push({
        type: 'TIME_BACKFLOW',
        severity: 'hard',
        entryId: rows[i].id,
        detail: `条目 ${rows[i].id} 时间 ${localTime(rows[i].occurredAt)} 早于上一条 ${localTime(rows[i - 1].occurredAt)}`,
      });
    }
  }

  const report = [
    '# 旧剧情审查报告',
    '',
    `扫描源：\`${DB}\``,
    `剧本条目：${rows.length} 条；识别出位移信号 ${moves.length} 处`,
    '',
    '## 汇总',
    '',
    `- 硬矛盾：**${issues.filter((i) => i.severity === 'hard').length + backflow.length}** 处`,
    `- 软提示：${issues.filter((i) => i.severity === 'soft').length} 处`,
    '',
    '## 硬矛盾明细',
    '',
    ...(issues.filter((i) => i.severity === 'hard').length + backflow.length
      ? [...issues.filter((i) => i.severity === 'hard'), ...backflow].map((i) =>
        `- **[${i.type}]** ${i.time}（条目 ${i.entryId}）${i.detail}\n  > ${i.excerpt ?? ''}`)
      : ['（无）']),
    '',
    '## 软提示明细',
    '',
    ...(issues.filter((i) => i.severity === 'soft').length
      ? issues.filter((i) => i.severity === 'soft').map((i) => `- **[${i.type}]** ${i.time}（条目 ${i.entryId}）${i.detail}`)
      : ['（无）']),
    '',
    '## 位移序列（复核用）',
    '',
    '| 时间 | 类型 | 命中词 | 条目 |',
    '| --- | --- | --- | --- |',
    ...moves.map((m) => `| ${m.time} | ${m.label} | ${m.matched} | ${m.entryId} |`),
  ].join('\n');

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, report, 'utf8');
  console.log(`剧本条目: ${rows.length}`);
  console.log(`位移信号: ${moves.length}`);
  console.log(`硬矛盾: ${issues.filter((i) => i.severity === 'hard').length + backflow.length}`);
  console.log(`软提示: ${issues.filter((i) => i.severity === 'soft').length}`);
  console.log(`报告: ${OUT}`);
}

main();
