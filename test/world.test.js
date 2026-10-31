import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moying-world-'));
process.env.MOYING_DATA_DIR = tmp;
const { ensureSeedData } = await import('./seed-data.js');
ensureSeedData(); // 干净环境（无 data/）用通用演示种子补位
for (const f of ['persona.json', 'character.json', 'cast.json', 'user.json', 'impressions.json', 'world.json']) {
  try { fs.copyFileSync(path.resolve('data', f), path.join(tmp, f)); } catch { /* 可选 */ }
}

const { StoryCursor } = await import('../src/world/cursor.js');
const { WorldSeeder } = await import('../src/world/seeder.js');
const { loadWorld, saveWorld, resolveWorld, seasonOf, renderWorldSetting, renderStoryRequirement, seedDensity } = await import('../src/world/world.js');
const { Store } = await import('../src/store.js');
const { Timeline, Place, EventKind } = await import('../src/world/state.js');
const { selectRange, renderStoryMarkdown, renderStoryJson } = await import('../src/export/story.js');
const { validateDrafts } = await import('../src/world/validator.js');

const NOW = Date.parse('2026-10-25T13:00:00+08:00');

test('当日时间轴: 凌晨的事件也要算在当天（存储是 UTC 字符串）', () => {
  // 引擎自己写的事件用 toISO()，是 UTC（…Z）；北京时间 0~8 点那些会被写成前一天。
  // 她是夜猫子，漏掉这段正好是最该看见的部分。
  const mk = (iso) => ({ at: new Date(Date.parse(iso)).toISOString(), kind: EventKind.ACT, place: Place.HOME, actors: [], summary: iso.slice(11, 16), source: 'narrator' });
  const tl = new Timeline([
    mk('2026-10-25T02:00:00+08:00'),
    mk('2026-10-25T07:00:00+08:00'),
    mk('2026-10-25T13:00:00+08:00'),
    mk('2026-10-24T23:00:00+08:00'), // 昨天的，不该被算进来
  ], Place.HOME);
  const got = tl.eventsOnDate('2026-10-25').map((e) => e.summary);
  assert.deepEqual(got, ['02:00', '07:00', '13:00'], `当天应命中三条，实际 ${JSON.stringify(got)}`);
  assert.equal(tl.eventsOnDate('2026-10-24').length, 1, '昨天的那条要算在昨天');
});

// ---------- 在场推导：远程互动不等于物理同在 ----------

test('在场: 他发来一条消息，不会变成「他在她身边」', () => {
  const events = [
    { at: '2026-10-25T11:00:00+08:00', kind: EventKind.ACT, place: Place.HOME, actors: ['c:roommate'], summary: '两人窝在沙发上刷手机', source: 'narrator' },
    // 他隔着屏幕发来一条消息（remote）
    { at: '2026-10-25T12:37:00+08:00', kind: EventKind.WORLD, place: Place.HOME, actors: ['u:10001'], remote: true, summary: '收到消息', source: 'user' },
  ];
  const tl = new Timeline(events, Place.HOME);
  const companions = tl.companionsAt(Date.parse('2026-10-25T12:38:00+08:00'));
  assert.deepEqual(companions, ['c:roommate'], `身边应是室友，实际 ${JSON.stringify(companions)}`);
});

test('在场: 只有物理同在的事件才改变同伴', () => {
  const tl = new Timeline([
    { at: '2026-10-25T10:00:00+08:00', kind: EventKind.ACT, place: Place.HOME, actors: ['c:roommate'], summary: '一起吃早饭', source: 'narrator' },
    // 叙事、世界事件、远程事件都不该改变「谁在她身边」
    { at: '2026-10-25T10:30:00+08:00', kind: EventKind.NARRATION, place: Place.HOME, actors: ['self'], summary: '一段散文', source: 'narrator' },
    { at: '2026-10-25T11:00:00+08:00', kind: EventKind.WORLD, place: Place.HOME, actors: ['c:roommate'], summary: '楼道里装修声响', source: 'seeder' },
    { at: '2026-10-25T11:30:00+08:00', kind: EventKind.ACT, place: Place.HOME, actors: ['u:10001'], remote: true, summary: '他在群里说话', source: 'user' },
  ], Place.HOME);
  assert.deepEqual(tl.companionsAt(Date.parse('2026-10-25T12:00:00+08:00')), ['c:roommate']);
  // 一起出门才换人
  tl.commit([{ at: '2026-10-25T12:10:00+08:00', kind: EventKind.MOVE, from: Place.HOME, to: Place.OUTSIDE, actors: ['c:colleague'], summary: '和同事出门', source: 'narrator' }]);
  assert.deepEqual(tl.companionsAt(Date.parse('2026-10-25T12:20:00+08:00')), ['c:colleague']);
});

test('在场: 她自己做事不会把同住的人从家里抹掉', () => {
  const tl = new Timeline([
    { at: '2026-10-25T12:14:00+08:00', kind: EventKind.ACT, place: Place.HOME, actors: ['c:roommate'], summary: '室友起身去厨房洗水果', source: 'seeder' },
    // 她收到消息、回消息、刷手机——这些都不影响室友还在家
    { at: '2026-10-25T12:37:00+08:00', kind: EventKind.WORLD, place: Place.HOME, actors: ['u:10001'], remote: true, summary: '收到消息', source: 'user' },
    { at: '2026-10-25T12:38:00+08:00', kind: EventKind.ACT, place: Place.HOME, actors: ['self'], summary: '她窝在沙发刷手机', source: 'narrator' },
  ], Place.HOME);
  assert.deepEqual(tl.companionsAt(Date.parse('2026-10-25T12:39:00+08:00')), ['c:roommate'],
    '室友在厨房削水果，不该因为她刷手机就消失');
});

test('在场: 室友出门上班（act 写明去向）后就不算在家', () => {
  const tl = new Timeline([
    { at: '2026-10-25T08:00:00+08:00', kind: EventKind.ACT, place: Place.HOME, actors: ['c:roommate'], summary: '和室友一起吃早饭', source: 'narrator' },
    // 室友出门上班：act、actors 只有她、place 写她去的地方
    { at: '2026-10-25T08:40:00+08:00', kind: EventKind.ACT, place: Place.OFFICE, actors: ['c:roommate'], summary: '室友出门上班', source: 'narrator' },
  ], Place.HOME);
  assert.deepEqual(tl.companionsAt(Date.parse('2026-10-25T09:00:00+08:00')), [],
    '室友去公司了，家里应该只剩她一个人');
});

// ---------- 演化游标：时间边界 ----------

test('游标: 窗口上界就是 now，不允许演化到未来', () => {
  const c = new StoryCursor(NOW - 3 * 3600_000); // 上次推进在 10:00
  const w = c.window(NOW);
  assert.equal(w.to, NOW, '窗口上界必须是当前时刻');
  assert.equal(w.from, NOW - 3 * 3600_000);
  assert.equal(w.spanMinutes, 180);
});

test('游标: 窗口说明给出时间预算，并说明装不下的后果', () => {
  const c = new StoryCursor(NOW - 3600_000);
  const text = c.renderWindow(NOW);
  assert.match(text, /本轮演化窗口/);
  // 窗口不再只讲「区间」，而是讲「预算」——所有 durationMinutes 加起来不能超过它。
  // 只给区间不给预算，模型就会把半小时的流程塞进 8 分钟（时间压缩的根）。
  assert.match(text, /60 分钟是全部时间预算/);
  assert.match(text, /durationMinutes 加起来不能超过它/);
  assert.match(text, /装不下的事就别写/);
});

test('游标: 只前进不后退', () => {
  const c = new StoryCursor(NOW);
  c.advance(NOW + 600_000);
  assert.equal(c.get(), NOW + 600_000);
  c.advance(NOW); // 更早的时间不应回退
  assert.equal(c.get(), NOW + 600_000);
});

test('时间边界: 写到未来的事件被校验拦下', () => {
  const timeline = new Timeline([], Place.HOME);
  const drafts = [{ at: new Date(NOW + 3600_000).toISOString(), kind: 'act', place: 'home', summary: '提前写到了一小时以后' }];
  const { hard } = validateDrafts(drafts, timeline, { now: NOW });
  assert.ok(hard.some((v) => v.rule === 'R1'), '超出 now 的事件应命中 R1');
});

test('时间边界: 窗口内的提前安排是允许的', () => {
  const timeline = new Timeline([], Place.HOME);
  // 现在 13:00，安排 13:40 的事 —— 仍在窗口内（<= now 才算已发生，这里用 now 之后的会被拦）
  const inPast = [{ at: new Date(NOW - 600_000).toISOString(), kind: 'act', place: 'home', summary: '刚才发生的事' }];
  const r = validateDrafts(inPast, timeline, { now: NOW });
  assert.equal(r.hard.length, 0, '窗口内的事件应通过');
});

// ---------- 播种器准入 ----------

function makeSeeder(llm) {
  // 每个用例都从干净状态开始，避免播种密度在用例之间累加
  for (const f of ['seeded_events.json', 'events.jsonl', 'cursor.json']) {
    fs.rmSync(path.join(tmp, f), { force: true });
  }
  const store = new Store();
  const timeline = new Timeline(store.loadEvents(), Place.HOME);
  const cursor = new StoryCursor(NOW - 2 * 3600_000);
  return { seeder: new WorldSeeder({ timeline, cursor, store, llm }), store, timeline, cursor };
}

test('播种: 正常事件能落账', async () => {
  const llm = async () => ({
    json: { events: [{ at: new Date(NOW - 600_000).toISOString(), importance: 'low', horizon: 'now', summary: '楼下开始装修' }] },
    content: '{}',
  });
  const { seeder } = makeSeeder(llm);
  const r = await seeder.sweep({ now: NOW });
  assert.equal(r.count, 1);
  assert.match(r.added[0].summary, /装修/);
});

test('播种: 牵涉对话参与者的事件被剔除', async () => {
  const llm = async () => ({
    json: { events: [{ at: new Date(NOW - 600_000).toISOString(), importance: 'high', horizon: 'now', summary: '他发来一条消息问她在不在' }] },
    content: '{}',
  });
  const { seeder } = makeSeeder(llm);
  const r = await seeder.sweep({ now: NOW });
  assert.equal(r.count, 0, '涉参与者的事件必须被拒');
  assert.match(r.rejected[0].reason, /参与者/);
});

test('播种: 超过现在的事件被剔除（不许跳到未来）', async () => {
  const llm = async () => ({
    json: { events: [{ at: new Date(NOW + 3 * 3600_000).toISOString(), importance: 'low', horizon: 'now', summary: '下午四点停电' }] },
    content: '{}',
  });
  const { seeder } = makeSeeder(llm);
  const r = await seeder.sweep({ now: NOW });
  assert.equal(r.count, 0);
  assert.match(r.rejected[0].reason, /超过了现在/);
});

test('播种: 远期种子给出未来到期时间即可排期', async () => {
  const llm = async () => ({
    json: {
      events: [{
        at: new Date(NOW).toISOString(), importance: 'medium', horizon: 'long',
        summary: '老师宣布三天后考试', dueAt: new Date(NOW + 3 * 86400_000).toISOString(),
      }],
    },
    content: '{}',
  });
  const { seeder } = makeSeeder(llm);
  const r = await seeder.sweep({ now: NOW });
  assert.equal(r.count, 1);
  assert.equal(r.added[0].status, 'scheduled');
});

test('播种: 到期事件会被注入世界时间轴', async () => {
  const llm = async () => ({
    json: { events: [{ at: new Date(NOW - 60_000).toISOString(), importance: 'low', horizon: 'now', summary: '起风了' }] },
    content: '{}',
  });
  const { seeder, store } = makeSeeder(llm);
  await seeder.sweep({ now: NOW });
  const injected = seeder.drainDue({ now: NOW });
  assert.equal(injected.length, 1);
  assert.equal(injected[0].source, 'world-seeder');
  assert.ok(store.loadEvents().some((e) => e.summary === '起风了'));
});

// ---------- 世界设定 ----------

test('世界设定: 默认档就是现实世界，时代由真实时间推导（含季节）', () => {
  const w = loadWorld();
  assert.equal(w.preset, 'default');
  const r = resolveWorld(w, NOW);
  assert.match(r.era, /2026 年 10 月 25 日/, '默认档应给出真实日期');
  assert.match(r.era, /秋季/, '季节由真实日期推导，不再单独配置');
  assert.match(r.location, /现实世界/);
  assert.equal(seasonOf(7), '夏');
  assert.equal(seasonOf(1), '冬');
});

test('世界设定: 自定义档用自己的时代与地点', () => {
  const custom = {
    preset: 'custom',
    custom: { era: '天历三七二年', location: '架空都城 · 云京' },
  };
  const r = resolveWorld(custom, NOW);
  assert.equal(r.era, '天历三七二年');
  assert.equal(r.location, '架空都城 · 云京');
  const text = renderWorldSetting(custom, NOW);
  assert.match(text, /<世界设定>/);
  assert.match(text, /天历三七二年/);
  assert.match(text, /云京/);
});

test('世界设定: 季节与气候不再单独配置', () => {
  const w = loadWorld();
  // 旧字段（environment / rules / type / name / era / location）应被清理
  const legacy = { ...w, type: '现实世界', name: 'x', environment: { season: '夏' }, rules: ['r'], era: '旧时代' };
  const saved = saveWorld(legacy);
  assert.equal(saved.environment, undefined);
  assert.equal(saved.rules, undefined);
  assert.equal(saved.type, undefined);
  assert.equal(saved.name, undefined);
  // 顶层的旧 era 会归入 custom，从而自动切成自定义档
  assert.equal(saved.preset, 'custom');
  assert.equal(saved.custom.era, '旧时代');
  // 恢复默认档，避免影响后续用例
  saveWorld({ preset: 'default', custom: { era: '', location: '' } });
});

test('故事要求: 默认文案来自 HDS 标准，且渲染成独立提示词块', () => {
  const text = renderStoryRequirement();
  assert.match(text, /<故事要求/);
  assert.match(text, /当代现实主义生活剧/);
  assert.match(text, /配角也有各自的节奏、立场与情绪/);
  assert.match(text, /未完成但真实感的余波/);
});

test('故事要求: 可自定义；留空则回落到默认那套', () => {
  const custom = renderStoryRequirement({ storyRequirement: '群像日常，慢节奏' });
  assert.match(custom, /群像日常，慢节奏/);
  const blank = renderStoryRequirement({ storyRequirement: '   ' });
  assert.match(blank, /当代现实主义生活剧/);
  assert.ok(seedDensity(loadWorld()).perDayMax >= 1);
});

// ---------- 故事导出 ----------

test('导出: 按时间范围挑选事件', () => {
  const events = [
    { at: '2026-10-25T10:00:00+08:00', kind: 'act', summary: '早上' },
    { at: '2026-10-25T13:00:00+08:00', kind: 'act', summary: '中午' },
    { at: '2026-10-25T16:00:00+08:00', kind: 'act', summary: '下午' },
  ];
  const picked = selectRange(events, { from: '2026-10-25T11:00:00+08:00', to: '2026-10-25T15:00:00+08:00' });
  assert.equal(picked.length, 1);
  assert.equal(picked[0].summary, '中午');
});

test('导出: Markdown 含图例与分段日期', () => {
  const events = [
    { at: '2026-10-25T13:00:00+08:00', kind: 'act', prose: '她坐在窗边发呆', summary: '发呆' },
    { at: '2026-10-25T13:05:00+08:00', kind: 'say', prose: '嗯', source: 'user' },
  ];
  const md = renderStoryMarkdown(events, { title: '测试导出' });
  assert.match(md, /# 测试导出/);
  assert.match(md, /阅读图例/);
  assert.match(md, /## 2026-10-25/);
  assert.match(md, /📖/);
  assert.match(md, /💬|🧑/);
});

test('导出: JSON 结构化输出', () => {
  const events = [{ at: '2026-10-25T13:00:00+08:00', kind: 'world', summary: '起风了' }];
  const out = renderStoryJson(events, { from: null, to: null });
  assert.equal(out.meta.count, 1);
  assert.equal(out.events[0].kind, 'world');
});
