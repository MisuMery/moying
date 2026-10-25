import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Timeline, Place, EventKind } from '../src/world/state.js';
import { validateDrafts, Severity } from '../src/world/validator.js';
import { renderWorldBlock } from '../src/world/view.js';
import { ActorRegistry, createFictional, createRealUser } from '../src/cast/actors.js';
import { resolveEndpoint, OutboundGuard } from '../src/cast/guard.js';

const T = (s) => `2026-10-24T${s}:00+08:00`;

// ---------- P2 世界状态机 ----------

test('P2: 16:23 已出门，18:27 再写「从家出门」必须被硬拦截', () => {
  const timeline = new Timeline([
    { id: 1, at: T('16:23'), kind: EventKind.MOVE, from: Place.HOME, to: Place.OUTSIDE, actors: ['c:roommate'], prose: '出门去生日局', source: 'narrator' },
  ], Place.HOME);

  // 此刻她在外面
  assert.equal(timeline.currentPlace(Date.parse(T('18:27'))), Place.OUTSIDE);

  // 模型又写了一次「出门」（隐含从家出发）
  const drafts = [
    { id: 2, at: T('18:27'), kind: EventKind.MOVE, from: Place.HOME, to: Place.OUTSIDE, actors: [], prose: '她又出门了', source: 'narrator' },
  ];
  const { hard, ok } = validateDrafts(drafts, timeline, { now: Date.parse(T('18:30')) });
  assert.equal(ok, false, '必须检出矛盾');
  assert.ok(hard.some((v) => v.rule === 'R2'), `应命中 R2 地点占用，实际: ${JSON.stringify(hard)}`);
});

test('P2: 先回家再出门是合法的（有显式的回家事件）', () => {
  const timeline = new Timeline([
    { id: 1, at: T('16:23'), kind: EventKind.MOVE, from: Place.HOME, to: Place.OUTSIDE, actors: [], prose: '出门', source: 'narrator' },
  ], Place.HOME);

  const drafts = [
    { id: 2, at: T('17:50'), kind: EventKind.MOVE, from: Place.OUTSIDE, to: Place.HOME, actors: [], prose: '回来了', source: 'narrator' },
    { id: 3, at: T('18:27'), kind: EventKind.MOVE, from: Place.HOME, to: Place.OUTSIDE, actors: [], prose: '又出去买东西', source: 'narrator' },
  ];
  const { hard } = validateDrafts(drafts, timeline, { now: Date.parse(T('18:30')) });
  assert.equal(hard.length, 0, `回家后再出门应合法，却被拦: ${JSON.stringify(hard)}`);
});

test('P2: 时间倒流与写到未来都被拦截', () => {
  const timeline = new Timeline([
    { id: 1, at: T('16:23'), kind: EventKind.MOVE, from: Place.HOME, to: Place.OUTSIDE, actors: [], prose: '', source: 'narrator' },
  ], Place.HOME);
  const now = Date.parse(T('18:30'));

  const back = validateDrafts([{ id: 2, at: T('15:00'), kind: EventKind.ACT, place: Place.HOME, prose: '' }], timeline, { now });
  assert.ok(back.hard.some((v) => v.rule === 'R1'), '时间倒流应命中 R1');

  const future = validateDrafts([{ id: 2, at: T('23:00'), kind: EventKind.ACT, place: Place.OUTSIDE, prose: '' }], timeline, { now });
  assert.ok(future.hard.some((v) => v.rule === 'R1'), '写到未来应命中 R1');
});

test('P2: 时段重叠被拦截', () => {
  const timeline = new Timeline([
    { id: 1, at: T('19:00'), kind: EventKind.ACT, place: Place.HOME, span: { from: T('19:00'), to: T('20:00') }, prose: '打游戏', source: 'narrator' },
  ], Place.HOME);
  const { hard } = validateDrafts([
    { id: 2, at: T('19:30'), kind: EventKind.ACT, place: Place.HOME, span: { from: T('19:30'), to: T('20:30') }, prose: '洗澡' },
  ], timeline, { now: Date.parse(T('21:00')) });
  assert.ok(hard.some((v) => v.rule === 'R5'), '重叠时段应命中 R5');
});

test('P2: 当日时间轴视图包含已知位移，且给出禁止动作提示', () => {
  const timeline = new Timeline([
    { id: 1, at: T('16:23'), kind: EventKind.MOVE, from: Place.HOME, to: Place.OUTSIDE, actors: ['c:roommate'], summary: '出门去生日局', source: 'narrator' },
  ], Place.HOME);
  const block = renderWorldBlock(timeline, Date.parse(T('18:27')));
  assert.match(block, /当日时间轴 2026-10-24/);
  assert.match(block, /现在 18:27/);
  assert.match(block, /不得写「出门/, '应明确禁止再写出门');
});

// ---------- P3 消息归属 ----------

function makeRegistry() {
  const reg = new ActorRegistry();
  reg.register(createRealUser({ userId: '10001', displayName: '真实用户' }));
  reg.register(createFictional({ id: 'roommate', displayName: '室友', relation: '合租室友' }));
  reg.register(createFictional({ id: 'colleague', displayName: '同事', relation: '同事', presence: { places: [Place.OFFICE, Place.OUTSIDE] } }));
  return reg;
}

test('P3: 虚构角色没有投递地址', () => {
  const reg = makeRegistry();
  assert.equal(resolveEndpoint(reg.get('c:roommate')), null, '室友不该有投递地址');
  assert.equal(resolveEndpoint(reg.get('c:colleague')), null, '同事不该有投递地址');
  assert.ok(resolveEndpoint(reg.get('u:10001')), '真实用户应有地址');
});

test('P3: 说给室友的话必须零出站', () => {
  const reg = makeRegistry();
  const blocked = [];
  const guard = new OutboundGuard({
    registry: reg,
    ledger: { record: (e) => blocked.push(e) },
  });

  const result = guard.authorizeAll([
    { id: 'u1', addresseeId: 'c:roommate', content: '室友我出门啦' },
    { id: 'u2', addresseeId: 'u:10001', content: '在忙吗' },
  ]);

  assert.equal(result.deliverable.length, 1, '只有发给真实用户的那条能出站');
  assert.equal(result.deliverable[0].utterance.id, 'u2');
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0].code, 'UNDELIVERABLE_ADDRESSEE');
  assert.equal(blocked.length, 1, '被拦的要记账');
  assert.equal(blocked[0].status, 'blocked_fictional');
});

test('P3: 缺少 addresseeId 不许回落到默认收件人', () => {
  const reg = makeRegistry();
  const guard = new OutboundGuard({ registry: reg, ledger: { record: () => {} } });
  const v = guard.authorize({ id: 'u9', content: '不知道发给谁' });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'MISSING_ADDRESSEE');
});

test('P3: 虚构角色的 deliverable 不可被篡改', () => {
  const roommate = createFictional({ id: 'roommate', displayName: '室友' });
  assert.equal(roommate.deliverable, false);
  try {
    roommate.deliverable = true;
  } catch { /* 严格模式下会抛；非严格静默失败都算通过 */ }
  assert.equal(roommate.deliverable, false, 'deliverable 必须锁死为 false');
});

test('P3: 远程联系标记生效（父母只能远程）', () => {
  const reg = makeRegistry();
  reg.register(createFictional({ id: 'mom', displayName: '张母', presence: { remoteOnly: true } }));
  const { soft } = validateDrafts([
    { at: T('20:00'), kind: EventKind.ACT, place: Place.HOME, actors: ['c:mom'], prose: '妈妈打来电话' },
  ], new Timeline([], Place.HOME), { now: Date.parse(T('20:30')), registry: reg });
  assert.ok(soft.some((v) => v.rule === 'R3'), '远程角色未标 remote 应给出软提示');
});

// 表情包 file 字段安全、备份软链接拒绝、配置 __proto__ 防护在 security.test.js
// （那几个用例会写盘，必须住在「先设 MOYING_DATA_DIR 再 import」的文件里）
