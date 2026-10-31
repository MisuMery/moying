// 合并规则：他还在连着发时顺延，但有天花板；重试定时器不被顺延
import { Inbox } from './turn/inbox.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('  ✓', name); }
  else { fail += 1; console.log('  ✗', name, extra); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1. 他还在说：把 deadline 顺延到「现在 + settleMs」 ----
{
  const inbox = new Inbox({ onFlush: async () => {}, settleMs: 2000, maxWaitMs: 60000 });
  const r1 = inbox.push('u1', { text: '第一条' }, 1000);
  ok('第一条按门控给的延迟排', r1.merged === false && r1.delayMs === 1000, JSON.stringify(r1));

  await sleep(300);
  const r2 = inbox.push('u1', { text: '第二条' }, 1000);
  ok('第二条进来后合并', r2.merged === true && r2.count === 2, JSON.stringify(r2));
  // 原 deadline 只剩 700ms，但 settle=2s：他还在说，就等她这一串说完（≈2300ms）
  ok('顺延到「现在+settle」（原 700ms → ≈2000ms）', r2.delayMs > 1900, `剩余 ${r2.delayMs}ms`);

  await sleep(300);
  const r3 = inbox.push('u1', { text: '第三条' }, 1000);
  ok('三条仍并成一批', r3.count === 3, JSON.stringify(r3));
  ok('继续顺延', r3.delayMs > 1900, `剩余 ${r3.delayMs}ms`);
  inbox.buffers.clear();
}

// ---- 2. 顺延有天花板：一直发也最多等到 maxWaitMs ----
{
  const inbox = new Inbox({ onFlush: async () => {}, settleMs: 300, maxWaitMs: 900 });
  const r1 = inbox.push('u2', { text: 'm1' }, 200);
  const cap = r1.deadline + inbox.maxWaitMs;
  for (let i = 0; i < 8; i += 1) {
    await sleep(100);
    inbox.push('u2', { text: `m${i + 2}` }, 200);
    const b = inbox.buffers.get('u2');
    if (!b) break; // 已触发
    if (b.deadline > cap + 1) {
      ok('deadline 越过天花板', false, `deadline 超出 ${b.deadline - cap}ms`);
      break;
    }
  }
  const b = inbox.buffers.get('u2');
  ok('deadline 始终不超过 firstDeadline+maxWaitMs', !b || b.deadline <= cap + 1, b ? `deadline-first=${b.deadline - r1.deadline}ms` : '已触发');
  inbox.buffers.clear();
}

// ---- 3. 重试定时器不被顺延 ----
{
  let calls = 0;
  const inbox = new Inbox({
    maxAttempts: 3, retryDelayMs: 400, settleMs: 5000, maxWaitMs: 60000,
    onFlush: async () => { calls += 1; if (calls === 1) throw new Error('boom'); },
  });
  inbox.push('u3', { text: 'a' }, 20);
  await sleep(60); // 第一次已失败，进入 400ms 重试窗口

  const r = inbox.push('u3', { text: 'b' }, 20);
  ok('重试期间新消息只累积', r.merged === true && r.count === 2, JSON.stringify(r));
  ok('没有被 settleMs 顺延（≤400ms）', r.delayMs <= 400, `剩余 ${r.delayMs}ms`);

  await sleep(500);
  ok('重试照常跑（共 2 次）', calls === 2, `调用了 ${calls} 次`);
  ok('重试成功后队列清空', !inbox.buffers.has('u3'));
  inbox.buffers.clear();
}

// ---- 4. 正常单条：行为不变 ----
{
  const inbox = new Inbox({ onFlush: async () => {}, settleMs: 12000, maxWaitMs: 180000 });
  const r = inbox.push('u4', { text: '就一条' }, 33000);
  ok('单条按 33s 排（和线上那次一致）', r.delayMs === 33000 && r.merged === false);
  inbox.buffers.clear();
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
