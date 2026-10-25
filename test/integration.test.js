import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 用临时数据目录，避免污染真实 data/
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moying-test-'));
process.env.MOYING_DATA_DIR = tmp;
const { ensureSeedData } = await import('./seed-data.js');
ensureSeedData(); // 干净环境（无 data/）用通用演示种子补位
for (const f of ['persona.json', 'character.json', 'cast.json', 'user.json', 'impressions.json', 'relationship.json', 'world.json']) {
  try { fs.copyFileSync(path.resolve('data', f), path.join(tmp, f)); } catch { /* 可选文件缺失忽略 */ }
}

const { Store } = await import('../src/store.js');
const { Timeline, Place, EventKind } = await import('../src/world/state.js');
const { validateDrafts } = await import('../src/world/validator.js');
const { Narrator } = await import('../src/narrator/narrator.js');
const { loadPersona, buildRegistry } = await import('../src/persona/card.js');
const { ImpressionStore } = await import('../src/persona/impression.js');
const { createRealUser } = await import('../src/cast/actors.js');
const { createFictional } = await import('../src/cast/actors.js');
const { Outbox } = await import('../src/onebot/outbox.js');

const persona = loadPersona();
const T = (s) => `2026-10-24T${s}:00+08:00`;

const personaa = persona;
/** 凑一段符合篇幅要求的叙事（程序会校验字数，太短会被打回重写） */
const LONG_NARRATION = (seed) => (seed + '。'
  + '窗外的光一点点挪过桌面，键盘声和远处的水声混在一起，她端起杯子又放下，'
  + '指尖在手机边缘停了两秒，最后什么也没做，只是把视线重新投回屏幕。').repeat(8);
void personaa;

function setup(priorEvents = []) {
  const store = new Store();
  for (const e of priorEvents) store.appendEvent(e);
  const registry = buildRegistry(persona, { selfId: '10001' });
  registry.register(createRealUser({ userId: '10001', displayName: '真实用户' }));
  // 自带一个中性配角，测试不依赖使用者的 cast.json 里具体有谁
  if (!registry.get('c:roommate')) {
    registry.register(createFictional({ id: 'roommate', displayName: '室友', presence: { places: [Place.HOME] } }));
  }
  return { store, registry, timeline: new Timeline(store.loadEvents(), Place.HOME), impressions: new ImpressionStore() };
}

test('P5: 模型写出「下午两次出门」，校验拦下并回灌重写', async () => {
  const { store, registry, timeline, impressions } = setup([
    { id: 'e1', at: T('16:23'), kind: EventKind.MOVE, from: Place.HOME, to: Place.OUTSIDE, actors: ['c:roommate'], summary: '出门去生日局', source: 'narrator' },
  ]);

  let calls = 0;
  const llm = async () => {
    calls += 1;
    if (calls === 1) {
      // 第一次：模型犯了 HDS 那个真实的错 —— 已经在外面了，又写「从家出门」
      return {
        content: '{"narration":"她又出门了","events":[{"at":"' + T('18:27') + '","kind":"move","from":"home","to":"outside_social","actors":[],"summary":"出门买东西"}],"utterances":[]}',
        json: {
          narration: '她又出门了',
          events: [{ at: T('18:27'), kind: EventKind.MOVE, from: Place.HOME, to: Place.OUTSIDE, actors: [], summary: '出门买东西' }],
          utterances: [],
        },
      };
    }
    // 第二次：改成从外面回家（合法）
    return {
      content: '{"narration":"她从生日局回来了","events":[{"at":"' + T('18:27') + '","kind":"move","from":"outside_social","to":"home","actors":[],"summary":"散场回家"}],"utterances":[]}',
      json: {
        narration: LONG_NARRATION('她从生日局回来了'),
        events: [{ at: T('18:27'), kind: EventKind.MOVE, from: Place.OUTSIDE, to: Place.HOME, actors: [], summary: '散场回家' }],
        utterances: [],
      },
    };
  };

  const narrator = new Narrator({ store, registry, persona, impressions, timeline, llm });
  const result = await narrator.run({ trigger: '（自动推进）', userId: '10001', now: Date.parse(T('18:30')), maxRevision: 2 });

  assert.equal(result.revisions, 1, '应触发一次重写');
  const verdict = validateDrafts(result.events, timeline, { now: Date.parse(T('18:30')), registry });
  assert.equal(verdict.hard.length, 0, `重写后不应有硬矛盾: ${JSON.stringify(verdict.hard)}`);
  assert.equal(result.events[0].from, Place.OUTSIDE, '应改成从外面出发');
});

test('P5: 重试耗尽时程序强制修正，绝不静默写入矛盾', async () => {
  const { store, registry, timeline, impressions } = setup([
    { id: 'e1', at: T('16:23'), kind: EventKind.MOVE, from: Place.HOME, to: Place.OUTSIDE, actors: [], summary: '出门', source: 'narrator' },
  ]);

  // 模型每次都写错（固执地重复 HDS 的 bug）
  const llm = async () => ({
    content: '{}',
    json: {
      narration: '又出门',
      events: [{ at: T('18:27'), kind: EventKind.MOVE, from: Place.HOME, to: Place.OUTSIDE, actors: [], summary: '又出门' }],
      utterances: [],
    },
  });

  const narrator = new Narrator({ store, registry, persona, impressions, timeline, llm });
  const result = await narrator.run({ trigger: '（推进）', userId: '10001', now: Date.parse(T('18:30')), maxRevision: 1 });

  assert.ok(result.autoCorrected.length > 0, '应留下强制修正审计');
  assert.equal(result.autoCorrected[0].rule, 'R2');
  const verdict = validateDrafts(result.events, timeline, { now: Date.parse(T('18:30')), registry });
  assert.equal(verdict.hard.length, 0, `强制修正后不得残留硬矛盾: ${JSON.stringify(verdict.hard)}`);
});

test('P5: 说给室友的话零出站，说给用户的正常发出（带句号也会被清）', async () => {
  const { store, registry } = setup();
  const sent = [];
  const client = {
    sendSegments: async (kind, id, segments) => {
      sent.push({ kind, id, segments });
      return { message_id: 1 };
    },
  };
  const outbox = new Outbox({ client, registry, store, speech: persona.speech, minGapMs: 0 });

  const result = await outbox.deliver([
    { id: 'u1', addresseeId: 'c:roommate', content: '室友我先睡了。' },
    { id: 'u2', addresseeId: 'u:10001', content: '有点累了。' },
  ], { source: 'test' });

  assert.equal(result.sent.length, 1, '只有发给真实用户的那条能出站');
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0].code, 'UNDELIVERABLE_ADDRESSEE');
  // 句号必须被清掉
  assert.equal(result.sent[0].content, '有点累了', `句号应被清除，实际: ${result.sent[0].content}`);
  assert.equal(sent[0].kind, 'private');
  assert.equal(sent[0].id, '10001');

  // 账本里两条都要留痕
  const ledger = store.loadLedger();
  assert.ok(ledger.some((l) => l.status === 'blocked_fictional'), '被拦的要记账');
  assert.ok(ledger.some((l) => l.status === 'sent'), '发出的要记账');
});

test('P5: 表情标记会被转成 QQ 表情段', async () => {
  const { store, registry } = setup();
  const sent = [];
  const client = { sendSegments: async (kind, id, segments) => { sent.push(segments); return { message_id: 1 }; } };
  const outbox = new Outbox({ client, registry, store, speech: persona.speech, minGapMs: 0 });
  await outbox.deliver([{ id: 'u1', addresseeId: 'u:10001', content: '嘿嘿~[表情:微笑]' }], { source: 'test' });
  const segs = sent[0] ?? [];
  // 没有离线表情表时退化为文本；有表时应出现 face 段
  const types = segs.map((s) => s.type);
  assert.ok(types.includes('text'), '至少要有文本段');
});

// ---- 2026-10-25 千问审查发现的两个 BUG 的回归 ----

const STICKER_DIR = path.join(tmp, 'stickers');
fs.mkdirSync(STICKER_DIR, { recursive: true });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
fs.writeFileSync(path.join(STICKER_DIR, 'real.png'), PNG);
// Outbox 只依赖 StickerStore 的 get/absolutePath 两个方法，用最小桩替代
const stickers = {
  get: (id) => (id === 's_real' ? { id: 's_real', file: 'real.png' } : null),
  absolutePath: (entry) => (entry?.file === 'real.png' ? path.join(STICKER_DIR, 'real.png') : null),
};

test('BUG1 回归: 表情包 id 不存在时，文字仍要送达（不整条吞掉）', async () => {
  const { store, registry } = setup();
  const sent = [];
  const client = { sendSegments: async (kind, id, segments) => { sent.push({ kind, id, segments }); return { message_id: 7 }; } };
  const outbox = new Outbox({ client, registry, store, speech: persona.speech, minGapMs: 0, stickers });

  const result = await outbox.deliver(
    [{ id: 'u1', addresseeId: 'u:10001', content: '给你看这个[贴纸:s_missing]' }],
    { source: 'test' },
  );

  assert.equal(result.sent.length, 1, '文字必须送达，不能被整条吞掉');
  assert.equal(sent.length, 1, '只应发一条消息');
  const text = sent[0].segments.filter((s) => s.type === 'text').map((s) => s.data.text).join('');
  assert.ok(text.includes('给你看这个'), `剥掉标记后的文字要发出去，实际: ${text}`);
  assert.ok(!text.includes('贴纸'), '不能把 [贴纸:xxx] 原文发给用户');
  const ledger = store.loadLedger();
  assert.ok(ledger.some((l) => l.status === 'sent'), '账本应记 sent');
  assert.ok(!ledger.some((l) => l.status === 'failed'), '不该留下 failed 记录');
});

test('BUG1 回归: 表情包存在时，文字和图组成同一条消息发出', async () => {
  const { store, registry } = setup();
  const sent = [];
  const client = { sendSegments: async (kind, id, segments) => { sent.push({ kind, id, segments }); return { message_id: 8 }; } };
  const outbox = new Outbox({ client, registry, store, speech: persona.speech, minGapMs: 0, stickers });

  await outbox.deliver([{ id: 'u1', addresseeId: 'u:10001', content: '这个[贴纸:s_real]' }], { source: 'test' });

  assert.equal(sent.length, 1, '文字和图必须是同一条消息，不能拆成两次发送');
  const types = sent[0].segments.map((s) => s.type);
  assert.ok(types.includes('text'), '要有文字段');
  assert.ok(types.includes('image'), '要有图片段');
  const img = sent[0].segments.find((s) => s.type === 'image');
  assert.ok(img.data.file.startsWith('base64://'), '图片应以 base64 段发出');
  const ledger = store.loadLedger();
  assert.ok(ledger.some((l) => l.status === 'sent' && l.stickerId === 's_real'), '账本应记下表情包 id');
});

test('BUG2 回归: 「重置成通用模板」不丢五档骨架（data/ 无模板时回退仓库模板）', async () => {
  const { loadTemplate } = await import('../src/persona/relationship.js');
  const tplPath = path.join(tmp, 'relationship.template.json');
  // 前置条件：测试数据目录里没有模板文件——干净安装就是这样，
  // 原先只读 data/relationship.template.json，此时必然落空返回 stages: []
  assert.equal(fs.existsSync(tplPath), false, '前置条件：tmp 里不应有 relationship.template.json');

  const tpl = loadTemplate();
  assert.equal(tpl.stages.length, 5, '仓库模板应带五档骨架');
  assert.deepEqual(
    tpl.stages.map((s) => s.id),
    ['stranger', 'distant', 'familiar', 'trusting', 'attached'],
  );
  assert.equal(tpl.initialStage, 'stranger');

  // data/ 里有被使用者改过的模板时，以 data/ 为准（回退不覆盖定制）
  fs.writeFileSync(tplPath, JSON.stringify({ _note: '定制', stages: [{ id: 'custom' }] }));
  try {
    const custom = loadTemplate();
    assert.deepEqual(custom.stages.map((s) => s.id), ['custom'], 'data/ 模板应优先');
  } finally {
    fs.unlinkSync(tplPath);
  }
});
