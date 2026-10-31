// 路网图 + 行程状态回归测试
// 场景取自 2026-10-30 线上：07:44 上车、07:48「最后一站到站」，5 分钟走完 30 分钟通勤。
import fs from 'node:fs';

const TMP = '/tmp/moying-travel-test';
process.env.MOYING_DATA_DIR = TMP;
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const { planMove, normalizeLegs, phaseAt, loadGraph, saveGraph, resetGraph } =
  await import('/app/src/world/travel.js');
const { Timeline, Place, EventKind } = await import('/app/src/world/state.js');
const { validateDrafts } = await import('/app/src/world/validator.js');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log('  ✓', name); pass += 1; }
  catch (e) { console.log('  ✗', name, '\n     ', e.message); fail += 1; }
};

// 清空图，保证每个用例互不影响
const fresh = () => resetGraph();

// ---------- 1. 时长约束 ----------

ok('第一次走：按声明的 30 分钟，并记进图', () => {
  fresh();
  const r = planMove({ from: 'home', to: 'office', mode: 'metro', minutes: 30 });
  if (r.minutes !== 30) throw new Error(`minutes=${r.minutes}`);
  const g = loadGraph();
  if (g.edges['home::office::metro']?.minutes !== 30) throw new Error('没记进图');
});

ok('同一条路第 2 次写 5 分钟 → 还在学，不锁死（取较大值 30）', () => {
  fresh();
  planMove({ from: 'home', to: 'office', mode: 'metro', minutes: 30 });
  const r = planMove({ from: 'home', to: 'office', mode: 'metro', minutes: 5 });
  // 前 3 次还在学：不锁死，但不许比走过的短（往上调放行）
  if (r.minutes !== 30) throw new Error(`应升到 30，得到 ${r.minutes}`);
  if (!r.corrections.some((c) => c.rule === 'T4')) throw new Error('没留下纠正记录');
});

ok('走熟以后（第 4 次）突然写 5 分钟 → 纠正为 30', () => {
  fresh();
  for (let i = 0; i < 3; i += 1) planMove({ from: 'home', to: 'office', mode: 'metro', minutes: 30 });
  const r = planMove({ from: 'home', to: 'office', mode: 'metro', minutes: 5 });
  if (r.minutes !== 30) throw new Error(`没纠正，得到 ${r.minutes}`);
  if (!r.corrections.some((c) => c.rule === 'T4')) throw new Error('没留下纠正记录');
});

ok('低于交通方式下限（地铁 3 分钟）→ 抬到 8', () => {
  fresh();
  const r = planMove({ from: 'a', to: 'b', mode: 'metro', minutes: 3 });
  if (r.minutes < 8) throw new Error(`minutes=${r.minutes}`);
});

ok('没写交通方式/时长 → 给兜底值而不是 0', () => {
  fresh();
  const r = planMove({ from: 'x', to: 'y' });
  if (!r.mode || !(r.minutes > 0)) throw new Error(JSON.stringify(r));
  if (!r.corrections.length) throw new Error('没有留下兜底记录');
});

ok('三角不等式：朋友家→公司首次走 5 分钟，被家→两边夹住', () => {
  fresh();
  planMove({ from: 'home', to: 'office', mode: 'metro', minutes: 22 });
  planMove({ from: 'home', to: 'friend', mode: 'metro', minutes: 35 });
  const r = planMove({ from: 'friend', to: 'office', mode: 'metro', minutes: 5 });
  if (r.minutes < 13) throw new Error(`被算成 ${r.minutes} 分钟（应 ≥13）`);
  if (!r.corrections.some((c) => c.rule === 'T5')) throw new Error('没触发三角校验');
});

// ---------- 2. 分段 ----------

ok('没给 legs → 按交通方式拆，总和等于总时长', () => {
  const legs = normalizeLegs(null, 'metro', 30);
  const sum = legs.reduce((s, l) => s + l.minutes, 0);
  if (sum !== 30) throw new Error(`分段和 ${sum} ≠ 30`);
  if (!legs.some((l) => l.phase === 'riding')) throw new Error('没有乘车段');
  if (!legs.some((l) => l.phase === 'waiting')) throw new Error('没有候车段');
});

ok('给了 legs → 归一化到总时长', () => {
  const legs = normalizeLegs([{ kind: 'walk', minutes: 10 }, { kind: 'ride', minutes: 10 }], 'metro', 30);
  const sum = legs.reduce((s, l) => s + l.minutes, 0);
  if (sum !== 30) throw new Error(`分段和 ${sum} ≠ 30`);
  if (legs[0].minutes !== 15) throw new Error(`没按比例放大：${JSON.stringify(legs)}`);
});

ok('phaseAt：第 10 分钟在车厢里，不是刚到', () => {
  const move = { at: '2026-10-30T07:44:00Z', legs: normalizeLegs(null, 'metro', 30) };
  const dep = Date.parse(move.at);
  const mid = phaseAt(move, dep + 15 * 60000);
  if (!mid.phase) throw new Error('没有阶段');
  if (!(mid.remainMin > 0)) throw new Error('没算剩余时间');
});

// ---------- 3. 行程状态：路上就是路上 ----------

ok('move 带 arriveAt：途中 place 是 transit，到点才是目的地', () => {
  const t0 = Date.parse('2026-10-30T07:44:00Z');
  const tl = new Timeline([
    { id: 'e1', at: new Date(t0).toISOString(), kind: EventKind.MOVE, from: 'home', to: 'office', mode: 'metro', minutes: 30, arriveAt: new Date(t0 + 30 * 60000).toISOString() },
  ], 'home');
  if (tl.placeAt(t0 + 5 * 60000) !== Place.TRANSIT) throw new Error(`5 分钟时是 ${tl.placeAt(t0 + 5 * 60000)}`);
  if (tl.placeAt(t0 + 29 * 60000) !== Place.TRANSIT) throw new Error('29 分钟时已经算到了');
  if (tl.placeAt(t0 + 31 * 60000) !== 'office') throw new Error(`31 分钟时是 ${tl.placeAt(t0 + 31 * 60000)}`);
});

ok('journeyAt：给出目的地和剩余分钟', () => {
  const t0 = Date.parse('2026-10-30T07:44:00Z');
  const tl = new Timeline([
    { id: 'e1', at: new Date(t0).toISOString(), kind: EventKind.MOVE, from: 'home', to: 'office', mode: 'metro', minutes: 30, arriveAt: new Date(t0 + 30 * 60000).toISOString() },
  ], 'home');
  const j = tl.journeyAt(t0 + 5 * 60000);
  if (!j) throw new Error('在途却没识别出来');
  if (j.to !== 'office') throw new Error(`to=${j.to}`);
  if (j.remainMin !== 25) throw new Error(`remainMin=${j.remainMin}`);
  if (tl.journeyAt(t0 + 31 * 60000) !== null) throw new Error('到了还说在途');
});

ok('旧数据没有 arriveAt → 仍按瞬时位移处理（不破坏历史）', () => {
  const t0 = Date.parse('2026-10-30T07:44:00Z');
  const tl = new Timeline([
    { id: 'e1', at: new Date(t0).toISOString(), kind: EventKind.MOVE, from: 'home', to: 'office' },
  ], 'home');
  if (tl.placeAt(t0 + 1000) !== 'office') throw new Error('旧 move 被当成在途了');
});

// ---------- 4. R13：提前说到被拦 ----------

ok('R13：在途时写「她走进公司」→ 硬拦', () => {
  const t0 = Date.parse('2026-10-30T07:44:00Z');
  const base = { id: 'e1', at: new Date(t0).toISOString(), kind: EventKind.MOVE, from: 'home', to: 'office', mode: 'metro', minutes: 30, arriveAt: new Date(t0 + 30 * 60000).toISOString() };
  const tl = new Timeline([base], 'home');
  const now = t0 + 5 * 60000;
  const { hard } = validateDrafts(
    [{ at: new Date(now).toISOString(), kind: EventKind.ACT, place: 'office', summary: '她走进公司大楼' }],
    tl, { now },
  );
  const hit = hard.find((v) => v.rule === 'R13');
  if (!hit) throw new Error(`没拦住：${JSON.stringify(hard)}`);
  if (!/路上/.test(hit.message)) throw new Error(`提示没说清在路上：${hit.message}`);
});

ok('R13：到了以后写同一句 → 放行', () => {
  const t0 = Date.parse('2026-10-30T07:44:00Z');
  const base = { id: 'e1', at: new Date(t0).toISOString(), kind: EventKind.MOVE, from: 'home', to: 'office', mode: 'metro', minutes: 30, arriveAt: new Date(t0 + 30 * 60000).toISOString() };
  const tl = new Timeline([base], 'home');
  const now = t0 + 31 * 60000;
  const { hard } = validateDrafts(
    [{ at: new Date(now).toISOString(), kind: EventKind.ACT, place: 'office', summary: '她走进公司大楼' }],
    tl, { now },
  );
  const hit = hard.find((v) => v.rule === 'R13');
  if (hit) throw new Error(`到了还被拦：${hit.message}`);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
