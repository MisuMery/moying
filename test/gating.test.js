import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moying-gate-'));
process.env.MOYING_DATA_DIR = tmp;
const { ensureSeedData } = await import('./seed-data.js');
ensureSeedData(); // 干净环境（无 data/）用通用演示种子补位
for (const f of ['persona.json', 'character.json', 'cast.json', 'user.json', 'impressions.json', 'relationship.json', 'world.json']) {
  try { fs.copyFileSync(path.resolve('data', f), path.join(tmp, f)); } catch { /* 可选文件缺失忽略 */ }
}

const { evaluateWillingness, resolveWillingness } = await import('../src/turn/willingness.js');
const { RateLimiter } = await import('../src/turn/ratelimit.js');
const { Inbox } = await import('../src/turn/inbox.js');
const { buildSegments } = await import('../src/onebot/outbox.js');

const cfg = resolveWillingness({}, 'normal');
const always = () => 0.01;   // 骰子永远小 → 只要概率 > 0 就会回
const never = () => 0.99;    // 骰子永远大 → 只有概率 = 1 才回

// ---------- 回复门控 ----------

test('门控: 白天正常状态，一条消息大概率会回', () => {
  const v = evaluateWillingness({}, { now: Date.now(), text: '在干嘛', hour: 15, busy: false }, cfg, always);
  assert.equal(v.shouldReply, true);
  assert.ok(v.probability > 0.7, `正常状态概率应较高，实际 ${v.probability}`);
  assert.ok(v.delayMs >= cfg.minDelayMs, '至少要等一会儿才回，不能秒回');
});

test('门控: 凌晨睡觉时基本不回', () => {
  // 用不含急事关键词的普通消息（「在吗」属于关键词，会走急事保底）
  const v = evaluateWillingness({}, { now: Date.now(), text: '今天天气不错', hour: 3, busy: false }, cfg, never);
  assert.equal(v.asleep, true);
  assert.ok(v.probability < 0.1, `睡觉时概率应极低，实际 ${v.probability}`);
  assert.equal(v.shouldReply, false);
  // 同一条消息，白天的意愿应远高于睡觉时 —— 差别来自作息调制
  const day = evaluateWillingness({}, { now: Date.now(), text: '今天天气不错', hour: 15, busy: false }, cfg, never);
  assert.ok(day.probability > v.probability * 5, `白天应远高于睡觉时：${day.probability} vs ${v.probability}`);
});

test('门控: 真有急事即便睡着也留一线', () => {
  const v = evaluateWillingness({}, { now: Date.now(), text: '急事，快点回我', hour: 3, busy: false }, cfg, always);
  assert.ok(v.probability >= 0.25, `急事应保底概率，实际 ${v.probability}`);
});

test('门控: 问句基本都会回（不回很奇怪）', () => {
  const v = evaluateWillingness({}, { now: Date.now(), text: '你睡了吗？', hour: 21, busy: false }, cfg, always);
  assert.ok(v.probability >= 0.8, `问句概率应很高，实际 ${v.probability}`);
});

test('门控: 忙的时候回复更慢；高保底场景折扣仍可见', () => {
  // 2026-10-31 语义：忙的体感交给 busyDelayMs（回复慢两分多钟），概率由亲密度保底兜底——
  // 「该回的总会回，只是慢」。折扣在保底之下的区间依然生效（问句 1 → 0.915 可见）。
  const free = evaluateWillingness({}, { now: Date.now(), text: '在干嘛', hour: 15, busy: false }, cfg, always);
  const busy = evaluateWillingness({}, { now: Date.now(), text: '在干嘛', hour: 15, busy: true }, cfg, always);
  assert.ok(busy.delayMs > free.delayMs, '忙的时候回复更慢');
  assert.ok(busy.probability >= 0.8, `忙也有亲密度保底，实际 ${busy.probability}`);
  const freeQ = evaluateWillingness({}, { now: Date.now(), text: '晚上想吃什么？', hour: 15, busy: false }, cfg, always);
  const busyQ = evaluateWillingness({}, { now: Date.now(), text: '晚上想吃什么？', hour: 15, busy: true }, cfg, always);
  assert.ok(busyQ.probability < freeQ.probability, '问句高保底场景下忙的折扣仍应可见');
});

test('门控: 回复一次后意愿被扣，不会条条秒回', () => {
  const v1 = evaluateWillingness({}, { now: Date.now(), text: '第一条', hour: 15 }, cfg, always);
  const v2 = evaluateWillingness({ score: v1.score, updatedAt: Date.now() }, { now: Date.now(), text: '第二条', hour: 15 }, cfg, always);
  assert.ok(v2.rawScore > v1.score, '新消息会重新累积意愿');
  assert.ok(v1.score < v1.rawScore, '回复后应扣分');
});

test('门控: quiet 档门槛更高、扣分更重；保底不受档位影响', () => {
  // 2026-10-31 语义：quiet 的冷淡体现在「意愿门槛高、回复扣分重」——
  // 而最终概率由亲密度保底兜底，不因档位冷淡把该回的消息吞掉。
  const quiet = resolveWillingness({}, 'quiet');
  const n = resolveWillingness({}, 'normal');
  assert.ok(quiet.threshold > n.threshold, `quiet 门槛应更高：${quiet.threshold} vs ${n.threshold}`);
  assert.ok(quiet.replyCost > n.replyCost, `quiet 扣分应更重：${quiet.replyCost} vs ${n.replyCost}`);
  const q = evaluateWillingness({}, { now: Date.now(), text: '在干嘛', hour: 15 }, quiet, always);
  const m = evaluateWillingness({}, { now: Date.now(), text: '在干嘛', hour: 15 }, n, always);
  assert.equal(q.probability, m.probability, '亲密度保底对两个档位一视同仁');
});

// ---------- 字数限流 ----------

test('限流: 一分钟内发超字数要等待', () => {
  const rl = new RateLimiter({ maxCharsPerMinute: 40, maxMessagesPerMinute: 6 });
  const now = Date.now();
  // 先发掉 30 字
  rl.consume('一二三四五六七八九十'.repeat(3), now); // 30 字
  const okSmall = rl.check('好的', now + 1000);
  assert.equal(okSmall.ok, true, '还剩额度时应放行');

  const over = rl.check('这句话有二十个字那么长那么长那么长啊', now + 2000);
  assert.equal(over.ok, false, '超出额度应拦下');
  assert.ok(over.waitMs > 0, '应给出需要等待的时间');
});

test('限流: 窗口滑过去后额度恢复', () => {
  const rl = new RateLimiter({ maxCharsPerMinute: 40 });
  const now = Date.now();
  rl.consume('x'.repeat(40), now);
  assert.equal(rl.check('再发一句', now + 1000).ok, false);
  assert.equal(rl.check('再发一句', now + 61000).ok, true, '一分钟后应恢复');
});

test('限流: 条数上限同样生效', () => {
  const rl = new RateLimiter({ maxCharsPerMinute: 1000, maxMessagesPerMinute: 3 });
  const now = Date.now();
  for (let i = 0; i < 3; i += 1) rl.consume('嗯', now + i * 100);
  const r = rl.check('嗯', now + 1000);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'message-rate');
});

// ---------- 消息合并 ----------

test('合并: 连续多条消息攒成一个回合', async () => {
  const flushed = [];
  const inbox = new Inbox({ onFlush: (userId, msgs) => flushed.push({ userId, msgs }), settleMs: 50, maxWaitMs: 400, retryDelayMs: 100 });
  inbox.push('1001', { text: '第一条' }, 300);
  inbox.push('1001', { text: '第二条', }, 300);
  inbox.push('1001', { text: '第三条' }, 300);
  assert.equal(flushed.length, 0, '还没到点不该触发');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(flushed.length, 1, '到点只触发一次');
  assert.equal(flushed[0].msgs.length, 3, '三条消息应合并成一个回合');
});

test('合并: 后续消息不会无限延后回复', async () => {
  // 短间隔连发：deadline 不动；顺延只发生在「他还在发、且静默窗口还没到」时，
  // 并有 firstDeadline + maxWaitMs 的硬天花板（绝不饿死）。
  const flushed = [];
  const inbox = new Inbox({ onFlush: (uid, msgs) => flushed.push(msgs), settleMs: 50, maxWaitMs: 400, retryDelayMs: 100 });
  const r1 = inbox.push('1002', { text: '第一条' }, 300);
  const r2 = inbox.push('1002', { text: '第二条' }, 300);
  assert.equal(r2.deadline, r1.deadline, '短间隔连发不应推后 deadline');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(flushed.length, 1);
});

test('合并: 他还在连着发时顺延，但不超过天花板', async () => {
  const flushed = [];
  const inbox = new Inbox({ onFlush: (uid, msgs) => flushed.push(msgs), settleMs: 80, maxWaitMs: 300, retryDelayMs: 100 });
  const r1 = inbox.push('1003', { text: '第一条' }, 300);
  await new Promise((r) => setTimeout(r, 280)); // 快到 deadline 时他又发来一条
  const r2 = inbox.push('1003', { text: '第二条' }, 300);
  assert.ok(r2.deadline > r1.deadline, '话没说完应顺延（不抢话）');
  assert.ok(r2.deadline <= r1.deadline + 300 + 50, `不超过 firstDeadline+maxWait 天花板: ${r2.deadline - r1.deadline}ms`);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(flushed.length, 1, '顺延后到点只触发一次');
  assert.equal(flushed[0].length, 2, '两条合并成一个回合');
});

// ---------- 表情 ----------

test('表情: 方括号表情不会原样发给用户', () => {
  // V3 明确禁止 [表情：呲牙] 这种导出格式出现在她的话里
  const segs = buildSegments('哈哈[表情：呲牙]');
  const text = segs.map((s) => s.data?.text ?? '').join('');
  assert.ok(!text.includes('[表情'), `不应残留方括号：${JSON.stringify(segs)}`);
});

test('表情: 带 ID 的原生表情直接用编号', () => {
  const segs = buildSegments('[QQ 原生表情：胖三斤（ID: 300）]');
  const face = segs.find((s) => s.type === 'face');
  assert.ok(face, `应转成表情段：${JSON.stringify(segs)}`);
  assert.equal(face.data.id, '300');
});

test('表情: 普通文本不受影响', () => {
  const segs = buildSegments('知道了');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].type, 'text');
  assert.equal(segs[0].data.text, '知道了');
});
