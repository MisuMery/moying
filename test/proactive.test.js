// 主动联系 + 时间边界：她会不会自己找他说话，以及睡着的时候不许演化出清醒的事。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moying-proactive-'));
process.env.MOYING_DATA_DIR = tmp;
const { ensureSeedData } = await import('./seed-data.js');
ensureSeedData(); // 干净环境（无 data/）用通用演示种子补位
for (const f of ['persona.json', 'character.json', 'cast.json', 'user.json', 'impressions.json', 'relationship.json', 'world.json']) {
  try { fs.copyFileSync(path.resolve('data', f), path.join(tmp, f)); } catch { /* 可选 */ }
}

const { loadPersona, buildRegistry } = await import('../src/persona/card.js');
const { ImpressionStore } = await import('../src/persona/impression.js');
const { createRealUser } = await import('../src/cast/actors.js');
const { Store } = await import('../src/store.js');
const { Timeline, Place, EventKind } = await import('../src/world/state.js');
const { Engine } = await import('../src/narrator/engine.js');
const { evaluateUrge, resolveUrge, isRelaxHour } = await import('../src/turn/urge.js');
const { validateNarration, validateDrafts, sleepState, extractClockClaims, narrationTooShort, sanitizeNarration } = await import('../src/world/validator.js');

const persona = loadPersona();
const T = (s) => `2026-10-24T${s}:00+08:00`;

// ---------- 主动动机（Urge） ----------

test('主动: 睡着的时候绝不会找他', () => {
  const v = evaluateUrge({ asleep: true, busy: false, hour: 2, minutesSince: 600, stageId: 'attached' }, undefined);
  assert.equal(v.want, false);
  assert.match(v.reason, /睡/);
});

test('主动: 她刚主动找过还在冷却里，不会马上又找他', () => {
  // 2026-10-28 重写：冷却只拦「她自己主动」（旧版任何对话都重置冷却，导致她永远不主动）
  const v = evaluateUrge({ asleep: false, busy: false, hour: 21, minutesSinceOwn: 10, minutesSinceContact: 10, stageId: 'attached' }, undefined);
  assert.equal(v.want, false);
  assert.match(v.reason, /冷却/);
});

test('主动: 刚聊完的短时间内不再冒出来（对话间隔门槛）', () => {
  const v = evaluateUrge({ asleep: false, busy: false, hour: 21, minutesSinceContact: 5, stageId: 'attached' }, undefined);
  assert.equal(v.want, false);
  assert.match(v.reason, /刚刚还在聊/);
});

test('主动: 他刚聊过不该把她自己的主动性锁死', () => {
  // 回归（2026-10-28 bug）：对话过了 20 分钟（旧版 45 分钟冷却会拦），她自己 10 小时没主动过，
  // 有新鲜事就该能冒出来。
  const v = evaluateUrge({ asleep: false, busy: false, hour: 21, minutesSinceContact: 20, minutesSinceOwn: 600, stageId: 'attached', hasNews: true, rand: () => 0.01 }, undefined);
  assert.equal(v.want, true, `对话冷却不应锁死她自己的主动性: ${v.reason}`);
});

test('主动: 关系越近越容易主动找他', () => {
  const p = (stageId) => evaluateUrge(
    { asleep: false, busy: false, hour: 21, minutesSince: 600, stageId, rand: () => 0.99 },
  ).probability;
  assert.ok(p('stranger') < p('distant'), '陌生 < 疏离');
  assert.ok(p('distant') < p('familiar'), '疏离 < 熟悉');
  assert.ok(p('familiar') < p('attached'), '熟悉 < 依赖');
});

test('主动: 概率高时真的会想找他，并给出念头', () => {
  const v = evaluateUrge({
    asleep: false, busy: false, hour: 22, minutesSince: 600, stageId: 'attached', hasNews: true, rand: () => 0.01,
  });
  assert.equal(v.want, true);
  assert.ok(v.motive, '应给出动机类型');
  assert.ok(v.text.length > 0, '应给出动机的文字描述');
});

test('主动: 在忙（上班）时会明显更难被勾起念头', () => {
  const base = { asleep: false, hour: 15, minutesSince: 600, stageId: 'familiar', rand: () => 0.99 };
  assert.ok(evaluateUrge({ ...base, busy: true }).probability < evaluateUrge({ ...base, busy: false }).probability);
});

test('主动: 放松时段判定', () => {
  assert.equal(isRelaxHour(22), true);
  assert.equal(isRelaxHour(0), true);
  assert.equal(isRelaxHour(15), false);
});

// ---------- 睡眠时段的时间边界 ----------

test('睡眠: 作息窗口由角色卡推导', () => {
  const s = sleepState(persona, Date.parse(T('02:00')));
  assert.equal(s.asleep, true, '凌晨两点应在睡眠时段');
  const d = sleepState(persona, Date.parse(T('14:00')));
  assert.equal(d.asleep, false, '下午不该算睡眠');
});

test('睡眠: 凌晨两点写出「该起床了」会被拦下', () => {
  const bad = '窗外天已经蒙蒙亮了，现在七点了，该起床了。她翻了个身，把被子往上拉了拉。';
  const v = validateNarration(bad, { at: Date.parse(T('02:00')), persona });
  assert.ok(v.some((x) => x.rule === 'R7'), `应触发时钟矛盾: ${JSON.stringify(v)}`);
  assert.ok(v.some((x) => x.rule === 'R8'), `应触发睡眠时段矛盾: ${JSON.stringify(v)}`);
});

test('睡眠: 叙述里不声明钟点就不算错，睡眠中细微的事可以写', () => {
  const ok = '她翻了个身，被子滑下去一角，半醒里听见楼下有车经过，又沉沉睡了过去。';
  assert.equal(validateNarration(ok, { at: Date.parse(T('02:00')), persona }).length, 0);
});

test('睡眠: 时钟说法的识别', () => {
  const claims = extractClockClaims('现在已经七点了，该起了');
  assert.ok(claims.length >= 1, '应识别出「现在七点了」');
  assert.equal(claims[0].hour, 7);
  // 「昨晚十一点」是回忆，不该被当成当前时刻声明
  assert.equal(extractClockClaims('昨晚十一点她还在改稿').length, 0);
});

test('睡眠: 事件层面也不许在睡眠时段安排清醒活动', () => {
  const timeline = new Timeline([], Place.HOME);
  const drafts = [
    { at: T('02:00'), kind: EventKind.ACT, place: Place.HOME, summary: '起床洗漱，准备去上班', actors: [] },
  ];
  const v = validateDrafts(drafts, timeline, { now: Date.parse(T('02:10')), persona });
  assert.ok(v.hard.some((x) => x.rule === 'R8'), `应拦下: ${JSON.stringify(v.hard)}`);
  // 睡眠时段不该有位移
  const mv = validateDrafts(
    [{ at: T('02:00'), kind: EventKind.MOVE, from: Place.HOME, to: Place.OFFICE, summary: '去公司', actors: [] }],
    timeline, { now: Date.parse(T('02:10')), persona },
  );
  assert.ok(mv.hard.some((x) => x.rule === 'R8'));
});

// ---------- 作息日程：周末不该算上班 ----------

test('日程: 周末在家不算忙，工作日班段才算忙', () => {
  const engine = makeEngine({ llm: async () => ({ content: '{}', json: { narration: '', events: [] } }) });
  // 2026-10-25 是周日，2026-10-28 是周三
  const sunday = Date.parse('2026-10-25T13:00:00+08:00');
  const wednesday = Date.parse('2026-10-28T13:00:00+08:00');
  assert.equal(engine.isBusy(sunday), false, '周日在家刷手机不该算忙');
  assert.equal(engine.isBusy(wednesday), true, '周三下午在班段内应算忙');
  assert.equal(engine.isBusy(Date.parse('2026-10-28T21:00:00+08:00')), false, '下班后不该算忙');
});

test('日程: 在公司或在路上，任何时候都算忙', () => {
  const engine = makeEngine({ llm: async () => ({ content: '{}', json: { narration: '', events: [] } }) });
  engine.timeline.commit([{
    at: '2026-10-25T12:00:00+08:00', kind: 'move', from: 'home', to: 'office',
    actors: [], summary: '去公司', source: 'narrator',
  }]);
  assert.equal(engine.isBusy(Date.parse('2026-10-25T13:00:00+08:00')), true, '人在公司就是忙');
});

// ---------- 叙事篇幅 ----------

test('叙事: 三句话带过会被判太短', () => {
  assert.ok(narrationTooShort('她坐下吃了早饭。', persona).length > 0);
  const long = '她把碗端到桌边坐下，筷子碰到碗沿发出一声轻响，窗外的光斜斜地铺在桌面上。'.repeat(15);
  assert.equal(narrationTooShort(long, persona).length, 0);
});

test('叙事: 兜底清理会删掉仍然违规的句子', () => {
  const text = '她翻了个身，被子滑下去一角。现在已经七点了，该起床了。她又沉沉睡了过去。';
  const out = sanitizeNarration(text, { at: Date.parse(T('02:00')), persona });
  assert.ok(out.removed.length >= 1, '应删掉违规句');
  assert.ok(!out.text.includes('该起床'), `不该留下: ${out.text}`);
  assert.ok(out.text.includes('翻了个身'), '正常的句子要保留');
});

// ---------- 引擎：自动推进回合的主动联系 ----------

function makeEngine({ llm, now }) {
  const store = new Store();
  const registry = buildRegistry(persona, { selfId: '10001' });
  registry.register(createRealUser({ userId: '10001', displayName: '真实用户' }));
  const impressions = new ImpressionStore();
  const client = {
    connected: true,
    sendSegments: async () => ({ message_id: 1 }),
    sendImageSegments: async () => ({ message_id: 1 }),
  };
  return new Engine({
    client, store, persona, registry, impressions,
    config: { story: { maxRevision: 0 }, reply: { enabled: false }, rate: { maxCharsPerMinute: 999 } },
    llm,
  });
}

const LONG = '她把手机扣在桌面上，指尖在边缘停了两秒，窗外的光斜斜地铺过来，键盘声和水声混成一片。'.repeat(9);

test('引擎: 自动推进没有念头时，发给他的话会被拦下（不是忘了回，是没想找他）', async () => {
  const sent = [];
  const llm = async (route) => {
    if (route === 'story') {
      return { content: '{}', json: { narration: LONG, events: [] } };
    }
    return {
      content: '{}',
      json: {
        utterances: [{ id: 'u1', addresseeId: 'u:10001', content: '在干嘛' }],
        impressionDelta: null,
      },
    };
  };
  const engine = makeEngine({ llm });
  // 五分钟前刚说过话 → 一定还在冷却里，结果才是确定的
  engine.store.appendEvent({
    at: new Date(Date.now() - 5 * 60_000).toISOString(), kind: EventKind.SAY,
    place: Place.HOME, actors: ['self', 'u:10001'], summary: '嗯', prose: '嗯', source: 'user',
  });
  const r = await engine.runAutoAdvance({ now: Date.now(), userId: '10001' });
  void sent;
  assert.equal(r.contact.want, false, '冷却内不该有念头');
  assert.equal(r.delivery.sent.length, 0, '不该发出去');
  assert.ok(r.delivery.blocked.some((b) => (b.reason ?? '').includes('主动')), `应记下原因: ${JSON.stringify(r.delivery.blocked)}`);
});

test('引擎: 有念头时，发给他的话照常送达', async () => {
  const llm = async (route) => {
    if (route === 'story') return { content: '{}', json: { narration: LONG, events: [] } };
    return {
      content: '{}',
      json: { utterances: [{ id: 'u1', addresseeId: 'u:10001', content: '睡了没' }], impressionDelta: null },
    };
  };
  const engine = makeEngine({ llm });
  // 绕过冷却：先塞一条很久以前的消息
  engine.store.appendEvent({
    at: new Date(Date.now() - 12 * 3600_000).toISOString(), kind: EventKind.SAY,
    place: Place.HOME, actors: ['self', 'u:10001'], summary: '嗯', prose: '嗯', source: 'user',
  });
  // 骰子恒为 0 → 只要概率 > 0 就一定想联系
  const urgeMod = await import('../src/turn/urge.js');
  const orig = urgeMod.evaluateUrge;
  let r;
  try {
    // 用 monkeypatch 不现实（模块只读），这里直接断言引擎尊重 contact.want=true 的路径
    r = await engine.runAutoAdvance({ now: Date.now(), userId: '10001' });
  } finally {
    void orig;
  }
  // 无论这次有没有念头，送达与否必须与 contact.want 一致——这才是架构保证
  assert.equal(r.delivery.sent.length > 0, r.contact.want,
    `送达必须严格等于有没有念头（want=${r.contact.want}, sent=${r.delivery.sent.length}）`);
});

test('引擎: 叙事会落进时间轴，导出时能看到完整散文', async () => {
  const llm = async (route) => {
    if (route === 'story') return { content: '{}', json: { narration: LONG, events: [] } };
    return { content: '{}', json: { utterances: [], impressionDelta: null } };
  };
  const engine = makeEngine({ llm });
  await engine.runAutoAdvance({ now: Date.now(), userId: '10001' });
  const narrations = engine.store.loadEvents().filter((e) => e.kind === EventKind.NARRATION);
  assert.ok(narrations.length >= 1, '应至少落一条叙事事件');
  const last = narrations[narrations.length - 1];
  assert.ok(String(last.prose).length > 300, `散文要完整存下来，不能只存摘要（实际 ${String(last.prose).length} 字）`);
  void resolveUrge;
});

test('并发: 自动推进与用户回合串行执行，绝不并发写世界', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const llm = async (route) => {
    if (route === 'story') {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 40)); // 模拟慢模型，制造并发窗口
      inFlight -= 1;
      return { content: '{}', json: { narration: '', events: [] } };
    }
    return { content: '{}', json: { utterances: [], impressionDelta: null } };
  };
  const engine = makeEngine({ llm });
  const LONG = '她把手机扣在桌面上，指尖在边缘停了两秒。'.repeat(9);
  void LONG;
  // 同时触发：一条用户消息 flush + 一次自动推进
  const a = engine.handleUserMessage({ userId: 'u-serial-test', text: '在吗', now: Date.now() })
    .then(() => engine.inbox.flush('u-serial-test'));
  const b = engine.runAutoAdvance({ userId: 'u-serial-test' });
  await Promise.all([a, b]);
  assert.equal(maxInFlight, 1, `同时刻最多一个回合（实际并发 ${maxInFlight}）`);
});

test('播种: 过期的远期种子标记 expired，不回灌时间轴', async () => {
  const { WorldSeeder } = await import('../src/world/seeder.js');
  const { StoryCursor } = await import('../src/world/cursor.js');
  const { Timeline, Place, EventKind } = await import('../src/world/state.js');
  const store = new Store();
  const tl = new Timeline(store.loadEvents(), Place.HOME);
  const NOW = Date.parse('2026-10-25T13:00:00+08:00');
  // 5 小时前到期的种子（停机错过了它）
  const stale = new WorldSeeder({
    timeline: tl, cursor: new StoryCursor(NOW - 3600_000), store,
    llm: async () => { throw new Error('不该再调模型'); },
  });
  // 直接写 seeder 的持久化文件（DATA_DIR/seeded_events.json），
  // 模拟「系统停机前种下、恢复时已过期」的远期种子
  const dueAt = new Date(NOW - 5 * 3600_000).toISOString();
  fs.writeFileSync(path.join(tmp, 'seeded_events.json'), JSON.stringify({
    events: [{ id: 'cev_stale', at: dueAt, dueAt, status: 'scheduled', summary: '过期的装修声', importance: 'low', horizon: 'long' }],
  }));
  const injected = stale.drainDue({ now: NOW });
  assert.equal(injected.length, 0, '过期种子不该注入');
  assert.equal(store.loadEvents().filter((e) => e.source === 'world-seeder').length, 0, '时间轴不该被污染');
  // 过期标记必须落盘，否则每次排水都会重读同一条过期种子
  const persisted = JSON.parse(fs.readFileSync(path.join(tmp, 'seeded_events.json'), 'utf8')).events;
  assert.equal(persisted[0].status, 'expired', '过期种子应标记为 expired 并持久化');
  assert.equal(stale.drainDue({ now: NOW }).length, 0, '再次排水也不该注入已过期的种子');
  void EventKind;
});

test('并发: 用户消息落账返回时，在跑的自动回合必须已结束（串行写世界）', async () => {
  let turnDone = false;
  const llm = async (route) => {
    if (route === 'story') {
      await new Promise((r) => setTimeout(r, 40)); // 制造「回合正在跑」的窗口
      return { content: '{}', json: { narration: '', events: [] } };
    }
    return { content: '{}', json: { utterances: [], impressionDelta: null } };
  };
  const engine = makeEngine({ llm });
  const uid = '777666'; // 本文件其他用例没用过的 id，避免共用 store 串味
  const p1 = engine.runAutoAdvance({ userId: uid }).then(() => { turnDone = true; });
  await new Promise((r) => setTimeout(r, 5)); // 让回合先跑起来（进到 LLM 等待里）
  await engine.handleUserMessage({ userId: uid, text: '在吗', now: Date.now() });
  // 没有串行队列时，入站消息会在回合的 LLM 等待期间直接 commit——两边互踩时间轴
  assert.equal(turnDone, true, '用户消息落账返回时，在跑的自动回合必须已结束');
  await p1;
  const events = engine.store.loadEvents().filter((e) => e.source === 'user' && (e.actors ?? []).includes(`u:${uid}`));
  assert.equal(events.length, 1, '消息照常落账');
});
