import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// 活动时长回归：applyDuration 派生 span → activityAt 读取 → R15 活动未完拦截 → 渲染提示。
// 与路网图 / R14 同一范式：模型声明 durationMinutes，程序保证，不硬编码时长表。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moying-activity-'));
process.env.MOYING_DATA_DIR = tmp;

const { Timeline, Place, EventKind } = await import('../src/world/state.js');
const { applyDuration, stampServerTimes } = await import('../src/narrator/narrator.js');
const { validateDrafts } = await import('../src/world/validator.js');
const { renderCurrentFacts } = await import('../src/world/view.js');
const { toMs } = await import('../src/world/time.js');

const NOW = Date.parse('2026-10-25T13:00:00+08:00');

// 在给定偏移处放一条已提交的 ACT「试衣服」，span 由 applyDuration 派生
function timelineWithActivity(startOffsetMin = 0, durationMin = 20) {
  const at = NOW + startOffsetMin * 60000;
  const act = {
    at: new Date(at).toISOString(),
    kind: EventKind.ACT,
    place: 'fitting_room',
    actors: ['self'],
    summary: '试衣服',
    durationMinutes: durationMin,
  };
  applyDuration(act, at);
  return { tl: new Timeline([act], Place.HOME), at };
}

// ---------- applyDuration：模型声明 → 程序派生 span ----------
test('applyDuration: ACT 带 durationMinutes 派生 span', () => {
  const e = { at: new Date(NOW).toISOString(), kind: EventKind.ACT, durationMinutes: 20, summary: '试衣服' };
  applyDuration(e, NOW);
  assert.ok(e.span, '应生成 span');
  assert.equal(toMs(e.span.from), NOW, 'span.from = at');
  assert.equal(toMs(e.span.to), NOW + 20 * 60000, 'span.to = at + 20min');
});

test('applyDuration: 超过 180 分钟封顶', () => {
  const e = { at: new Date(NOW).toISOString(), kind: EventKind.ACT, durationMinutes: 999, summary: 'x' };
  applyDuration(e, NOW);
  assert.equal(toMs(e.span.to), NOW + 180 * 60000, '封顶 180 分钟');
});

test('applyDuration: 无 / 0 / 负 / 非数字 不派生', () => {
  for (const d of [undefined, 0, -5, 'abc']) {
    const e = { at: new Date(NOW).toISOString(), kind: EventKind.ACT, durationMinutes: d, summary: 'x' };
    applyDuration(e, NOW);
    assert.equal(e.span, undefined, `duration=${JSON.stringify(d)} 不应生成 span`);
  }
});

test('applyDuration: MOVE 不派生 span', () => {
  const e = { at: new Date(NOW).toISOString(), kind: EventKind.MOVE, durationMinutes: 30, summary: 'x' };
  applyDuration(e, NOW);
  assert.equal(e.span, undefined, 'MOVE 不应有时长 span');
});

// ---------- activityAt：状态层读取进行中活动 ----------
test('activityAt: 命中进行中活动并返回剩余分钟', () => {
  const { tl, at } = timelineWithActivity(0, 20);
  const a = tl.activityAt(at + 5 * 60000);
  assert.ok(a, '应命中');
  assert.equal(a.activity, '试衣服');
  assert.equal(a.remainMin, 15, `剩余应约 15 分钟，实际 ${a.remainMin}`);
});

test('activityAt: 活动结束后返回 null（不误报）', () => {
  const { tl, at } = timelineWithActivity(0, 20);
  assert.equal(tl.activityAt(at + 25 * 60000), null, '已结束应返回 null');
});

test('activityAt: 活动开始前返回 null（不误报）', () => {
  const { tl, at } = timelineWithActivity(10, 20); // 10 分钟后才开始
  assert.equal(tl.activityAt(at - 5 * 60000), null, '未开始应返回 null');
});

// ---------- stampServerTimes 也要派生 span ----------
test('stampServerTimes: 为 ACT 派生 span', () => {
  const at = NOW;
  const drafts = [{ at: new Date(at).toISOString(), kind: EventKind.ACT, place: 'shop', actors: ['self'], summary: '逛店', durationMinutes: 40 }];
  stampServerTimes(drafts, new Timeline([], Place.HOME), at);
  assert.ok(drafts[0].span, 'stampServerTimes 应派生 span');
  assert.equal(toMs(drafts[0].span.from), at);
  assert.equal(toMs(drafts[0].span.to), at + 40 * 60000);
});

// ---------- R15 活动未完：跨批拦截 ----------
test('R15: 她说「试完了」时活动仍在进行 → HARD', () => {
  const { tl, at } = timelineWithActivity(0, 20); // 已提交 ACT 试衣服 20min
  const drafts = [{ at: new Date(at + 2 * 60000).toISOString(), kind: EventKind.SAY, speaker: 'self', to: 'u:123', actors: ['self'], summary: '试完了' }];
  const { violations } = validateDrafts(drafts, tl, { now: at + 2 * 60000 });
  const r15 = violations.filter((v) => v.rule === 'R15');
  assert.equal(r15.length, 1, `应命中 R15，实际 ${r15.length}`);
  assert.equal(r15[0].severity, 'hard', '她亲口对他说应是 HARD');
});

test('R15: 她把事实写成 ACT「试完衣服」→ HARD', () => {
  const { tl, at } = timelineWithActivity(0, 20);
  const drafts = [{ at: new Date(at + 2 * 60000).toISOString(), kind: EventKind.ACT, place: 'shop', actors: ['self'], summary: '试完衣服' }];
  const { violations } = validateDrafts(drafts, tl, { now: at + 2 * 60000 });
  const r15 = violations.filter((v) => v.rule === 'R15');
  assert.equal(r15.length, 1, 'ACT 宣称做完应命中');
  assert.equal(r15[0].severity, 'hard', 'ACT 事实应是 HARD');
});

test('R15: world 事件里「试完了」→ SOFT（不阻断生成）', () => {
  const { tl, at } = timelineWithActivity(0, 20);
  const drafts = [{ at: new Date(at + 2 * 60000).toISOString(), kind: EventKind.WORLD, summary: '镜前试完了衣服', actors: [] }];
  const { violations } = validateDrafts(drafts, tl, { now: at + 2 * 60000 });
  const r15 = violations.filter((v) => v.rule === 'R15');
  assert.equal(r15.length, 1, 'world 修辞也应记录');
  assert.equal(r15[0].severity, 'soft', 'world 事件应是 SOFT');
});

test('R15: 别人说的「做完了」不拦截', () => {
  const { tl, at } = timelineWithActivity(0, 20);
  const drafts = [{ at: new Date(at + 2 * 60000).toISOString(), kind: EventKind.SAY, speaker: 'c:linxia', to: 'self', actors: ['c:linxia', 'self'], summary: '我试完了' }];
  const { violations } = validateDrafts(drafts, tl, { now: at + 2 * 60000 });
  assert.equal(violations.filter((v) => v.rule === 'R15').length, 0, '别人的话不应触发 R15');
});

test('R15: 活动已结束再说「试完了」不误伤', () => {
  const { tl, at } = timelineWithActivity(0, 20);
  const drafts = [{ at: new Date(at + 25 * 60000).toISOString(), kind: EventKind.SAY, speaker: 'self', to: 'u:123', actors: ['self'], summary: '试完了' }];
  const { violations } = validateDrafts(drafts, tl, { now: at + 25 * 60000 });
  assert.equal(violations.filter((v) => v.rule === 'R15').length, 0, '活动结束后不应误伤');
});

test('R15: 没活动时说「试完了」不误伤', () => {
  const tl = new Timeline([], Place.HOME);
  const drafts = [{ at: new Date(NOW).toISOString(), kind: EventKind.SAY, speaker: 'self', to: 'u:123', actors: ['self'], summary: '试完了' }];
  const { violations } = validateDrafts(drafts, tl, { now: NOW });
  assert.equal(violations.filter((v) => v.rule === 'R15').length, 0, '无活动在身不应触发');
});

test('R15: 过程中说法（还在试 / 喝了一半）不触发', () => {
  const { tl, at } = timelineWithActivity(0, 20);
  for (const s of ['还在试', '喝了一半', '排队等着']) {
    const drafts = [{ at: new Date(at + 2 * 60000).toISOString(), kind: EventKind.ACT, place: 'shop', actors: ['self'], summary: s }];
    const { violations } = validateDrafts(drafts, tl, { now: at + 2 * 60000 });
    assert.equal(violations.filter((v) => v.rule === 'R15').length, 0, `「${s}」不应触发 R15`);
  }
});

// ---------- 渲染：进行中活动要给模型「还在做」的提示 ----------
test('renderCurrentFacts: 进行中活动出现提示文案', () => {
  const { tl, at } = timelineWithActivity(0, 20);
  const out = renderCurrentFacts(tl, at + 5 * 60000);
  assert.match(out, /正在试衣服/, '应渲染正在做某事');
  assert.match(out, /还有.*分钟才完/, '应给出剩余时间');
});
