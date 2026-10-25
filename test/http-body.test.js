// 有界响应体读取（src/http-body.js）的测试。
//
// 这个模块的卖点是「上限真的在生效」：边读边计数、超限立刻取消流抛错，
// 而不是先整包读入再判长度。所以测试的重点不只是「超限会抛」，
// 还包括「超限时真的停止了读取」——用可计数的流验证早停，防止有人把
// 实现改回「读完再判」还能让测试全绿。

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { readTextBounded, readJsonBounded, readBytesBounded } = await import('../src/http-body.js');

/** 造一个「可计数」的 ReadableStream：每块固定字节数，记录被拉了几次 */
function countingStream(chunkSize, maxChunks) {
  let pulls = 0;
  const stream = new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (pulls > maxChunks) { controller.close(); return; }
      controller.enqueue(new Uint8Array(chunkSize).fill(97)); // 'a'
    },
  });
  return { stream, pulls: () => pulls };
}

test('readTextBounded: 未超限时返回完整文本', async () => {
  const { stream } = countingStream(4, 3);
  const text = await readTextBounded({ body: stream }, 1024);
  assert.equal(text, 'aaaaaaaaaaaa');
});

test('readTextBounded: 真实 Response 也走同一条路', async () => {
  const res = new Response('你好，世界');
  assert.equal(await readTextBounded(res, 1024), '你好，世界');
});

test('readTextBounded: 超限抛 BODY_TOO_LARGE 且真的早停（不读完整个流）', async () => {
  const { stream, pulls } = countingStream(5, 1000);
  await assert.rejects(
    () => readTextBounded({ body: stream }, 12),
    (e) => e.code === 'BODY_TOO_LARGE',
  );
  // 每块 5 字节：第 3 块读到 15 > 12 就该取消。允许 <4，绝不把 1000 块读完
  assert.ok(pulls() <= 4, `应早停，实际拉了 ${pulls()} 块`);
});

test('readTextBounded: 超限错误带上限与已读字节数', async () => {
  const { stream } = countingStream(10, 1000);
  await assert.rejects(
    () => readTextBounded({ body: stream }, 10),
    (e) => e.code === 'BODY_TOO_LARGE' && /超过 10 字节上限/.test(e.message) && /已读到 20 字节/.test(e.message),
  );
});

test('readTextBounded: 只有异步迭代器的 body 也能读（无 getReader 的退化实现）', async () => {
  const body = (async function* () { yield ' foo'; yield 'bar'; })();
  assert.equal(await readTextBounded({ body }, 1024), ' foobar');
});

test('readTextBounded: 异步迭代器超限同样抛 BODY_TOO_LARGE', async () => {
  const body = (async function* () { for (let i = 0; i < 1000; i += 1) yield new Uint8Array(10); })();
  await assert.rejects(() => readTextBounded({ body }, 25), (e) => e.code === 'BODY_TOO_LARGE');
});

test('readTextBounded: 字符串块（无 byteLength）不会让上限静默失效', async () => {
  // 历史坑：chunk.byteLength 为 undefined 时 total += undefined → NaN，
  // NaN > limit 恒为假，整个上限形同虚设。这里每块 10 字符，上限 12。
  const body = (async function* () { for (let i = 0; i < 1000; i += 1) yield '0123456789'; })();
  await assert.rejects(() => readTextBounded({ body }, 12), (e) => e.code === 'BODY_TOO_LARGE');
});

test('readTextBounded: 测试桩只有 text() 时走退路，超限仍抛', async () => {
  const ok = { text: async () => '短内容' };
  assert.equal(await readTextBounded(ok, 1024), '短内容');
  const big = { text: async () => 'x'.repeat(100) };
  await assert.rejects(() => readTextBounded(big, 10), (e) => e.code === 'BODY_TOO_LARGE');
});

test('readTextBounded: 连 text() 都没有的桩退到 json()，超限仍抛', async () => {
  const ok = { json: async () => ({ a: 1 }) };
  assert.deepEqual(JSON.parse(await readTextBounded(ok, 1024)), { a: 1 });
  const big = { json: async () => ({ pad: 'x'.repeat(100) }) };
  await assert.rejects(() => readTextBounded(big, 10), (e) => e.code === 'BODY_TOO_LARGE');
});

test('readTextBounded: 什么都没有时给干净错误', async () => {
  await assert.rejects(() => readTextBounded({}, 1024), /没有可读取的 body/);
});

test('readJsonBounded: 未超限时解析 JSON', async () => {
  const res = new Response(JSON.stringify({ ok: true, n: 1 }));
  assert.deepEqual(await readJsonBounded(res, 1024), { ok: true, n: 1 });
});

test('readJsonBounded: 超限抛 BODY_TOO_LARGE（与文本路径一致）', async () => {
  const { stream } = countingStream(100, 1000);
  await assert.rejects(() => readJsonBounded({ body: stream }, 50), (e) => e.code === 'BODY_TOO_LARGE');
});

test('readJsonBounded: 非法 JSON 仍由 JSON.parse 抛 SyntaxError', async () => {
  const res = new Response('{oops');
  await assert.rejects(() => readJsonBounded(res, 1024), SyntaxError);
});

test('readBytesBounded: 未超限时返回完整 Buffer', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const buf = await readBytesBounded({ body: new Response(bytes).body ?? bytesToStream(bytes) }, 1024);
  assert.deepEqual([...buf], [1, 2, 3, 4, 5]);
});

test('readBytesBounded: 超限抛 BODY_TOO_LARGE', async () => {
  const { stream } = countingStream(100, 1000);
  await assert.rejects(() => readBytesBounded({ body: stream }, 50), (e) => e.code === 'BODY_TOO_LARGE');
});

test('readBytesBounded: 桩只有 arrayBuffer() 时走退路', async () => {
  const stub = { arrayBuffer: async () => new Uint8Array([9, 8, 7]).buffer };
  const buf = await readBytesBounded(stub, 1024);
  assert.deepEqual([...buf], [9, 8, 7]);
  const big = { arrayBuffer: async () => new Uint8Array(100).buffer };
  await assert.rejects(() => readBytesBounded(big, 10), (e) => e.code === 'BODY_TOO_LARGE');
});

test('readBytesBounded: 没有可读体时给干净错误', async () => {
  await assert.rejects(() => readBytesBounded({}, 1024), /没有可读取的 body/);
});

/** 小工具：把字节数组包成单块 ReadableStream */
function bytesToStream(bytes) {
  return new ReadableStream({
    start(controller) { controller.enqueue(bytes); controller.close(); },
  });
}
