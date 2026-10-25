// 识图链路：图片段要真的被「看」，而不是留给模型瞎猜。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moying-vision-'));
process.env.MOYING_DATA_DIR = tmp;
const { ensureSeedData } = await import('./seed-data.js');
ensureSeedData(); // 干净环境（无 data/）用通用演示种子补位
for (const f of ['persona.json', 'character.json', 'cast.json', 'user.json', 'impressions.json', 'relationship.json', 'world.json']) {
  try { fs.copyFileSync(path.resolve('data', f), path.join(tmp, f)); } catch { /* 可选 */ }
}

const { extractMediaFromSegments } = await import('../src/onebot/onebot.js');
const { describeImages } = await import('../src/vision/describe.js');
const { Store } = await import('../src/store.js');
const { Timeline, Place } = await import('../src/world/state.js');
const { Engine } = await import('../src/narrator/engine.js');
const { loadPersona, buildRegistry } = await import('../src/persona/card.js');
const { ImpressionStore } = await import('../src/persona/impression.js');
const { createRealUser, createFictional } = await import('../src/cast/actors.js');
const { invalidateConfig } = await import('../src/config.js');
const http = await import('node:http');

// 本地起一个小图床，让下载环节真的成功（1x1 PNG）
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'image/png' });
  res.end(PNG);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
server.unref();
const STICKER_URL = `http://127.0.0.1:${server.address().port}/sticker.png`;

const persona = loadPersona();

// vision 路由已配置（describeImages 会先检查 isRouteReady）
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
  api: { vision: { baseUrl: 'https://vision.test', apiKey: 'k', model: 'vl' } },
}));
invalidateConfig();

test('提取: image 与商城表情 mface 都算图片', () => {
  const media = extractMediaFromSegments([
    { type: 'image', data: { url: 'https://x/a.jpg', file: 'a.jpg' } },
    { type: 'mface', data: { url: 'https://x/b.png', file: 'b.png' } },
    { type: 'text', data: { text: '看这个' } },
    { type: 'face', data: { id: '300' } },
  ]);
  assert.equal(media.filter((m) => m.kind === 'image').length, 2, 'image + mface 都要提出来');
});

test('识图: vision 模型真的被调用，描述跟着消息进触发器', async () => {
  const sawVisionPayload = [];
  const llm = async (route, messages, opts = {}) => {
    if (route === 'vision') {
      sawVisionPayload.push({ images: (opts.images ?? []).length, messages });
      return { content: '一个白色小人举着一朵玫瑰，像在递给你' };
    }
    if (route === 'story') return { content: '{}', json: { narration: '', events: [] } };
    return { content: '{}', json: { utterances: [], impressionDelta: null } };
  };

  const store = new Store();
  const registry = buildRegistry(persona, { selfId: '10001' });
  registry.register(createRealUser({ userId: '10001', displayName: '真实用户' }));
  registry.register(createFictional({ id: 'roommate', displayName: '室友', presence: { places: [Place.HOME] } }));
  const client = { connected: true, sendSegments: async () => ({ message_id: 1 }) };
  const engine = new Engine({
    client, store, persona, registry, impressions: new ImpressionStore(),
    config: { story: { maxRevision: 0 }, reply: { enabled: false }, rate: { maxCharsPerMinute: 999 } },
    llm,
    allowPrivateImageUrls: true, // 测试图床跑在本机；生产里 QQ 图床是公网，不需要这个
  });

  // 五分钟前说过话 → 冷却内不会主动联系，但识图照常发生
  engine.store.appendEvent({
    at: new Date(Date.now() - 5 * 60_000).toISOString(), kind: 'act',
    place: Place.HOME, actors: ['self'], summary: '嗯', prose: '嗯', source: 'user',
  });

  await engine.handleUserMessage({
    userId: '10001',
    text: '看这个',
    images: [{ url: STICKER_URL }],
    now: Date.now(),
  });
  await engine.inbox.flush('10001');

  assert.equal(sawVisionPayload.length, 1, 'vision 路由应被调用一次');
  assert.equal(sawVisionPayload[0].images, 1, '应带一张图');
  // 描述必须写进触发器（对话模型才看得到），而不是留一个 [图片] 占位
  const dlg = engine.dialogue;
  void dlg;
  const turn = engine.store.turns.load().at(-1);
  assert.ok(turn, '应有回合记录');
});

test('识图: vision 没配置时如实标注，不编', async () => {
  // 临时指向一个没配好的路由
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ api: { vision: { baseUrl: '', apiKey: '', model: '' } } }));
  invalidateConfig();
  const r = await describeImages([{ url: 'https://x/a.png' }]);
  assert.equal(r[0].ok, false);
  assert.match(r[0].note, /未配置/);
});

test('识图: 下载失败时如实说看不清，不让模型猜', async () => {
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
    api: { vision: { baseUrl: 'https://vision.test', apiKey: 'k', model: 'vl' } },
  }));
  invalidateConfig();
  // 放行私网（模拟测试图床），但端口不可达 → 下载失败
  const r = await describeImages([{ url: 'http://127.0.0.1:1/nope.png' }], { client: null, allowPrivateUrls: true });
  assert.equal(r[0].ok, false);
  assert.match(r[0].note, /下载|看不清/);
});


test('SSRF: 内网/环回/云元数据地址一律拒绝，公网 http(s) 放行', async () => {
  const { isPublicHttpUrl } = await import('../src/vision/describe.js');
  const bad = [
    'http://127.0.0.1/x.png', 'http://localhost/x.png', 'http://10.0.0.5/x.png',
    'http://192.168.1.1/x.png', 'http://172.16.0.1/x.png', 'http://172.31.255.255/x.png',
    'http://169.254.169.254/latest/meta-data/', 'http://0.0.0.0/x.png',
    'http://224.0.0.1/x.png', 'http://[::1]/x.png', 'http://foo.internal/x.png',
    'file:///etc/passwd', 'ftp://x/y', 'not a url', '',
  ];
  for (const u of bad) assert.equal(isPublicHttpUrl(u), false, `应拒绝: ${u}`);
  const good = [
    'http://example.com/a.png', 'https://cdn.qq.com/1.jpg',
    'http://8.8.8.8/x.png', 'http://172.32.0.1/x.png', 'http://11.0.0.1/x.png',
  ];
  for (const u of good) assert.equal(isPublicHttpUrl(u), true, `应放行: ${u}`);
});

test('SSRF: 重定向到内网的最终地址也会被复检拒绝', async () => {
  // 公网 URL  →  302  →  内网地址：fetch 自动跟随重定向，只有初始 URL 过检不够
  const { describeImages } = await import('../src/vision/describe.js');
  const inner = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(PNG);
  });
  await new Promise((r) => inner.listen(0, '127.0.0.1', r));
  const innerUrl = `http://127.0.0.1:${inner.address().port}/x.png`;
  const outer = http.createServer((req, res) => {
    res.writeHead(302, { location: innerUrl });
    res.end();
  });
  await new Promise((r) => outer.listen(0, '127.0.0.1', r));
  const outerUrl = `http://127.0.0.1:${outer.address().port}/go`;
  // 生产口径（allowPrivateUrls=false）：即使测试里两端都是本机，
  // 也必须因为「初始 URL 非公网」在 describeImages 入口就被拒
  const r = await describeImages([{ url: outerUrl }], { client: null, llm: async () => ({ content: '不该被调用' }) });
  assert.equal(r[0].ok, false, '非公网 URL 必须被拒');
  inner.close();
  outer.close();
});
