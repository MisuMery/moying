import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// 时间预算回归：stampServerTimes 按真实占用排布（不再 (n-1)*1000 把整批压成几秒），
// 模型自报的 span 一律丢弃，窗口装不下按比例压缩且不产生跨度重叠，
// 叙事篇幅下限随窗口缩放（不再逼模型靠塞事件凑字数）。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moying-budget-'));
process.env.MOYING_DATA_DIR = tmp;

const { Timeline, Place, EventKind } = await import('../src/world/state.js');
const { stampServerTimes, applyDuration, forceCorrect } = await import('../src/narrator/narrator.js');
const { validateDrafts, narrationTooShort } = await import('../src/world/validator.js');
const { toMs } = await import('../src/world/time.js');

const NOW = Date.parse('2026-10-31T22:08:00+08:00');

function withHistory(lastOffsetMin) {
  const hist = lastOffsetMin
    ? [{ at: new Date(NOW - lastOffsetMin * 60000).toISOString(), kind: EventKind.ACT, place: Place.HOME, actors: ['self'], summary: '历史' }]
    : [];
  return new Timeline(hist, Place.HOME);
}

const act = (summary, durationMinutes, extra = {}) => ({
  at: '1970-01-01T00:00:00Z', kind: EventKind.ACT, place: Place.OTHER, actors: ['self'], summary, durationMinutes, ...extra,
});

test('stampServerTimes: 8 条瞬时事件不再挤进 (n-1) 秒的等差数列', () => {
  const list = Array.from({ length: 8 }, (_, i) => act(`动作${i}`, 0));
  stampServerTimes(list, withHistory(10), NOW);
  const stamps = list.map((e) => toMs(e.at));
  // 旧实现是 base + i*1000，跨度恒为 7 秒；新实现每条至少占 1 秒且从窗口起点铺开
  assert.ok(stamps.every(Number.isFinite), '每条都应有 at');
  assert.deepEqual(stamps, [...stamps].sort((a, b) => a - b), '时间必须单调不减');
  for (let i = 1; i < stamps.length; i += 1) {
    assert.ok(stamps[i] - stamps[i - 1] >= 1000, `相邻事件至少隔 1 秒（第 ${i} 条差 ${stamps[i] - stamps[i - 1]}ms）`);
  }
});

test('stampServerTimes: 持续动作按 durationMinutes 真实占位，不再被压成 1 秒', () => {
  const list = [act('试衣服', 20), act('挑鞋子', 10)];
  stampServerTimes(list, withHistory(40), NOW);
  const d0 = toMs(list[0].span.to) - toMs(list[0].span.from);
  assert.ok(d0 >= 15 * 60000, `第 1 条应占约 20 分钟，实际 ${Math.round(d0 / 60000)} 分钟`);
  // 后一条必须在前一条结束之后开始
  assert.ok(toMs(list[1].at) >= toMs(list[0].span.to) - 1000, '后一件事不能与前一件重叠');
});

test('stampServerTimes: 最后一条持续动作的 span 应盖住「此刻」', () => {
  const list = [act('试衣服', 40)];
  stampServerTimes(list, withHistory(5), NOW);
  const f = toMs(list[0].span.from);
  const t = toMs(list[0].span.to);
  assert.ok(f <= NOW && NOW < t, `span 应覆盖 now（${new Date(f).toISOString()} ~ ${new Date(t).toISOString()}）`);
});

test('stampServerTimes: 模型自报的 span 一律丢弃并按 at 重算', () => {
  // 线上实证：模型把本地墙上时间补个 Z 当 UTC 写，18/18 条偏 8 小时
  const list = [act('试衣服', 15, { span: { from: '2026-10-31T14:07:00Z', to: '2026-10-31T14:08:00Z' } })];
  stampServerTimes(list, withHistory(5), NOW);
  assert.notEqual(toMs(list[0].span.from), Date.parse('2026-10-31T14:07:00Z'), '错 span 必须被覆盖');
  assert.equal(toMs(list[0].span.to) - toMs(list[0].span.from), 15 * 60000, '应按 durationMinutes 重算');
});

test('stampServerTimes: 非 ACT 事件不留 span', () => {
  const list = [
    { at: 'x', kind: EventKind.SAY, speaker: 'self', to: 'c:linxia', actors: ['self'], summary: '说话', span: { from: '2026-10-31T14:00:00Z', to: '2026-10-31T14:10:00Z' } },
    { at: 'x', kind: EventKind.WORLD, actors: [], summary: '天气', span: { from: '2026-10-31T14:00:00Z', to: '2026-10-31T14:10:00Z' } },
  ];
  stampServerTimes(list, withHistory(5), NOW);
  assert.equal(list[0].span, undefined, 'say 不该有跨度');
  assert.equal(list[1].span, undefined, 'world 不该有跨度');
});

test('stampServerTimes: 窗口装不下时按比例压缩，且压缩后跨度互不重叠（R5 不误伤）', () => {
  // 8 分钟窗口里塞 25 分钟的流程
  const list = [act('看衣服', 7), act('上扶梯', 2), act('挑东西', 16), act('试衣服', 15)];
  stampServerTimes(list, withHistory(8), NOW);
  const { violations } = validateDrafts(list, withHistory(0), { now: NOW + 60000 });
  const r5 = violations.filter((v) => v.rule === 'R5');
  assert.equal(r5.length, 0, `压缩后不该有跨度重叠，实际：${r5.map((v) => v.message).join(' / ')}`);
  // 最后一条仍应「正在进行」
  assert.ok(toMs(list[3].span.from) <= NOW && NOW < toMs(list[3].span.to), '末尾活动应覆盖 now');
});

test('stampServerTimes: 所有事件都不得排到 now 之后', () => {
  const list = [act('做饭', 60), act('吃饭', 20), act('洗碗', 10)];
  stampServerTimes(list, withHistory(3), NOW);
  for (const e of list) {
    assert.ok(toMs(e.at) <= NOW, `at 不得晚于 now：${e.summary}`);
  }
});

test('narrationTooShort: 窗口短时下限随之降低，不逼模型凑字数', () => {
  const persona = { narrative: { length: { min: 400, max: 800 } } };
  const short = '她站在试衣间的灯下，抬手把袖子往上捋了捋，镜子里的人有点陌生。'; // 约 32 字
  // 8 分钟窗口 → 下限 320 字，32 字仍然太短
  assert.equal(narrationTooShort(short, persona, NOW, 8).length, 1, '8 分钟窗口仍要求成段叙事');
  // 0.5 分钟窗口 → 下限 120 字，32 字依旧不足（下限有 120 的地板）
  assert.equal(narrationTooShort(short, persona, NOW, 0.5).length, 1);
  // 但 400 字的文在短窗口里不该被打回
  const long = '她'.repeat(150);
  assert.equal(narrationTooShort(long, persona, NOW, 1).length, 0, '150 字在 1 分钟窗口里够用');
  // 长窗口维持原来的 400 字下限
  assert.equal(narrationTooShort(long, persona, NOW, 180).length, 1, '长窗口仍要 400 字');
});

test('activityAt: 活动期间挪了地方 → 就地作废（换地点即中断）', () => {
  const at = NOW - 10 * 60000;
  const actEv = {
    at: new Date(at).toISOString(), kind: EventKind.ACT, place: Place.OTHER, actors: ['self'], summary: '试衣服',
    span: { from: new Date(at).toISOString(), to: new Date(at + 20 * 60000).toISOString() },
  };
  const moveEv = {
    at: new Date(at + 5 * 60000).toISOString(), kind: EventKind.MOVE, from: Place.OTHER, to: Place.HOME,
    arriveAt: new Date(at + 25 * 60000).toISOString(),
  };
  const moved = new Timeline([actEv, moveEv], Place.OTHER);
  assert.equal(moved.activityAt(at + 6 * 60000), null, '挪了地方就不该还认为她在试衣服');
  // 同样的活动、没有 move：仍然命中
  const stayed = new Timeline([actEv], Place.OTHER);
  assert.ok(stayed.activityAt(at + 6 * 60000), '没挪地方应仍然命中');
});

// ---------- 冗余位移：目的地 === 所在地 ----------
// 2026-10-31 线上事故：她本就在商场，模型又写了一次「move → mall」。
// 老兜底把这种 move 改写成「去 other」，等于凭空造出一次位移，
// 于是后面 5 条 place=mall 的事件（看衣服/试衣服/结账）全被判 R13「她不在商场」，
// 模型被一轮轮打回重写。正确语义是原地停留。

test('stampServerTimes: 目的地就是所在地 → 降级为原地 act，不把她送去 other', () => {
  const arrivedAt = NOW - 30 * 60000;
  const hist = [{
    at: new Date(NOW - 45 * 60000).toISOString(), kind: EventKind.MOVE,
    from: Place.HOME, to: Place.MALL, mode: 'metro', minutes: 15,
    arriveAt: new Date(arrivedAt).toISOString(),
  }];
  const tl = new Timeline(hist, Place.HOME);
  assert.equal(tl.placeAt(NOW), Place.MALL, '前提：她此刻已经在商场');

  const drafts = [
    { at: '1970-01-01T00:00:00Z', kind: EventKind.MOVE, from: Place.MALL, to: Place.MALL, mode: 'walk', minutes: 3, summary: '她俩又上一层楼逛' },
    { at: '1970-01-01T00:00:00Z', kind: EventKind.ACT, place: Place.MALL, actors: ['self'], summary: '在店里翻衣架', durationMinutes: 12 },
  ];
  const corr = stampServerTimes(drafts, tl, NOW);

  assert.equal(drafts[0].kind, EventKind.ACT, '冗余 move 应降级成原地 act');
  assert.equal(drafts[0].place, Place.MALL, '降级后地点仍是商场，绝不能变成 other');
  assert.equal(drafts[0].arriveAt, undefined, '原地停留不该留下行程');
  assert.equal(drafts[0].to, undefined, '不该留下目的地字段');
  assert.ok(corr.some((c) => c.rule === 'R2' && /原地/.test(c.note)), '应留下审计记录');

  const { hard } = validateDrafts(drafts, tl, { now: NOW });
  assert.equal(hard.filter((v) => v.rule === 'R13').length, 0, '后续同地点事件不该被判 R13 错位');

  const after = new Timeline([...hist, ...drafts], Place.HOME);
  assert.equal(after.placeAt(NOW), Place.MALL, '整批结束后她仍在商场');
});

test('forceCorrect: 硬矛盾兜底时同样降级为原地停留', () => {
  const arrivedAt = NOW - 30 * 60000;
  const hist = [{
    at: new Date(NOW - 45 * 60000).toISOString(), kind: EventKind.MOVE,
    from: Place.HOME, to: Place.MALL, mode: 'metro', minutes: 15,
    arriveAt: new Date(arrivedAt).toISOString(),
  }];
  const tl = new Timeline(hist, Place.HOME);
  const drafts = [
    { at: new Date(NOW - 5 * 60000).toISOString(), kind: EventKind.MOVE, from: Place.MALL, to: Place.MALL, minutes: 3, summary: '往三楼走' },
    { at: new Date(NOW - 2 * 60000).toISOString(), kind: EventKind.ACT, place: Place.MALL, actors: ['self'], summary: '挑衣服' },
  ];
  const { events } = forceCorrect(drafts, tl, NOW);
  assert.equal(events[0].kind, EventKind.ACT, '兜底也应降级成 act');
  assert.equal(events[0].place, Place.MALL);
  const after = new Timeline([...hist, ...events], Place.HOME);
  assert.equal(after.placeAt(NOW), Place.MALL);
});
