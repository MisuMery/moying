// 回复量回归：门控（busy 折扣 / 连续忽略补偿）+ Inbox 失败重试
import { evaluateWillingness, resolveWillingness, detectTopicEnd } from './turn/willingness.js';
import { Inbox } from './turn/inbox.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('  ✓', name); }
  else { fail += 1; console.log('  ✗', name, extra); }
};

const cfg = resolveWillingness({}, 'normal');

// ---- 1. 上班时间：不能再「每两条掉一条」 ----
// 稳定随机数 0.5：旧 busyFactor 0.55 → p=0.55，random 0.55 时 50% 截断
const busyVerdict = evaluateWillingness(
  {},
  { now: Date.now(), text: '真的着凉了吗？', hour: 11, busy: true, secondsSinceOwnSay: 9999 },
  cfg,
  () => 0.5,
);
ok('上班+问句 p≥0.8（原来 0.55）', busyVerdict.probability >= 0.8, `p=${busyVerdict.probability}`);
ok('上班+问句 random0.5 会回', busyVerdict.shouldReply === true, `reason=${busyVerdict.reason}`);

// 连发三条普通陈述（非问句），全部要回
let replied = 0;
for (const t of ['hhhhhhh，那好吧', '怎么不点外卖', '你还没有回我昨晚的消息呢']) {
  const v = evaluateWillingness(
    {},
    { now: Date.now(), text: t, hour: 11, busy: true, secondsSinceOwnSay: 9999 },
    cfg,
    () => 0.5,
  );
  if (v.shouldReply) replied += 1;
}
ok('上班连发三条都回（原来大概率掉 1~2 条）', replied === 3, `回了 ${replied}/3`);

// ---- 2. 连续被忽略两次 → 第三条必回 ----
const catchup = evaluateWillingness(
  { score: 0, updatedAt: Date.now() },
  { now: Date.now(), text: '在干嘛', hour: 11, busy: true, secondsSinceOwnSay: 9999, consecutiveIgnored: 2 },
  cfg,
  () => 0.9, // 高随机数也要压过去
);
ok('连续被忽略 2 次后保底 0.95', catchup.probability >= 0.95, `p=${catchup.probability} reason=${catchup.reason}`);
ok('连续被忽略补偿会回', catchup.shouldReply === true);

// 睡觉时不补偿（真睡着不该被叫醒）
const asleep = evaluateWillingness(
  { score: 0, updatedAt: Date.now() },
  { now: Date.now(), text: '在干嘛', hour: 3, busy: false, secondsSinceOwnSay: 9999, consecutiveIgnored: 5 },
  cfg,
  () => 0.5,
);
ok('睡着时不因连续忽略而回', asleep.shouldReply === false, `p=${asleep.probability}`);

// ---- 3. Inbox：回合跑挂必须重试，不能把他的消息吞掉 ----
let calls = 0;
const seen = [];
const inbox = new Inbox({
  maxAttempts: 3,
  retryDelayMs: 30,
  onFlush: async (uid, msgs) => {
    calls += 1;
    seen.push(msgs.map((m) => m.text).join('|'));
    if (calls === 1) throw new Error('模型返回不是合法 JSON: ');
  },
});
inbox.push('u1', { text: '真的着凉了吗？' }, 60000); // 先不让它自己触发，手动 flush
await inbox.flush('u1');
await new Promise((r) => setTimeout(r, 120));
ok('回合失败后自动重试并成功', calls === 2, `调用 ${calls} 次`);
ok('重试带的是同一批消息', seen[1] === '真的着凉了吗？', seen.join(' → '));

// 一直失败：3 次后明确放弃，且不会无限循环
let calls2 = 0;
const inbox2 = new Inbox({
  maxAttempts: 3,
  retryDelayMs: 20,
  onFlush: async () => { calls2 += 1; throw new Error('boom'); },
});
inbox2.push('u2', { text: 'x' }, 60000);
await inbox2.flush('u2');
await new Promise((r) => setTimeout(r, 500));
ok('连续失败到上限后停止（3 次）', calls2 === 3, `调用 ${calls2} 次`);

// ---- 4. 反应延迟区间：8~25s，忙时 +25s ----
{
  const at = (r, busy, sinceOwn = 9999) => evaluateWillingness(
    {},
    { now: Date.now(), text: '在干嘛', hour: 11, busy, secondsSinceOwnSay: sinceOwn },
    cfg,
    () => r,
  ).delayMs;
  const idleMax = at(0.9999, false);
  const idleMin = at(0, false);
  ok('空闲上限 ≈25s（原 45s）', idleMax <= 25000 && idleMax > 24000, `${idleMax}ms`);
  ok('空闲下限 8s', idleMin === 8000, `${idleMin}ms`);

  const busyMax = at(0.9999, true);
  const busyMin = at(0, true);
  ok('忙时上限 ≈50s（原 105s）', busyMax <= 50000 && busyMax > 49000, `${busyMax}ms`);
  ok('忙时下限 33s（原 68s）', busyMin === 33000, `${busyMin}ms`);

  const engaged = at(0.9999, true, 10);
  ok('还在聊时再 ×0.4', engaged <= 20000 && engaged > 19000, `${engaged}ms`);
}

// ---- 5. 话题收尾识别（含「嗯呐」这类语气词变体） ----
{
  const ack = ['嗯', '嗯嗯', '嗯呐', '嗯呢', '嗯呐呐', '好的', '好的呀', '好嘞', '知道啦', '知道了',
    '行吧', '收到', '谢谢啦', 'ok', 'OK', '可以', '明白', '没事', '好滴'];
  const closing = ['晚安', '拜拜', '我先去洗澡', '你忙'];
  const normal = ['好想你', '好久不见', '嗯，我也是', '我在改图', '今天天气不错', '好的那我先走了'];

  for (const t of ack) ok(`「${t}」判为收尾应答`, detectTopicEnd(t) === 'ack', String(detectTopicEnd(t)));
  for (const t of closing) ok(`「${t}」判为道别`, detectTopicEnd(t) === 'closing', String(detectTopicEnd(t)));
  for (const t of normal) ok(`「${t}」不该判收尾`, detectTopicEnd(t) === null, String(detectTopicEnd(t)));
  ok('问句不算收尾（嗯呐？）', detectTopicEnd('嗯呐？') === null);
}

// ---- 6. 收尾应答之后基本不回 ----
{
  const v = evaluateWillingness(
    { score: 2, updatedAt: Date.now() },
    { now: Date.now(), text: '嗯呐', hour: 15, busy: true, secondsSinceOwnSay: 15, consecutiveIgnored: 0 },
    cfg,
    () => 0.5,
  );
  ok('「嗯呐」在忙也几乎不回（p≤0.03）', v.probability <= 0.03, `p=${v.probability}`);
  ok('原因标成 topic_end', v.reason === 'topic_end', v.reason);
  ok('random=0.5 时不回', v.shouldReply === false);

  // 但连着被忽略之后再发正经内容，仍然要回（补偿不能被收尾挡住）
  const v2 = evaluateWillingness(
    { score: 2, updatedAt: Date.now() },
    { now: Date.now(), text: '我今天加班到八点', hour: 15, busy: true, secondsSinceOwnSay: 9999, consecutiveIgnored: 2 },
    cfg,
    () => 0.9,
  );
  ok('收尾之后的新话题照常回', v2.shouldReply === true, `p=${v2.probability}`);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
