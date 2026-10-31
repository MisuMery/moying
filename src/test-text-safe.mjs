// 回归测试：任何文本截断都不许劈开 emoji（2026-10-30 事故的护栏）。
//
// 事故链：他的消息「…我就不喜欢你20秒🥺」共 25 个 code unit，时间轴按 24 截断，
// 正好切在代理对中间，留下孤立高代理 \ud83e → JSON.stringify 写出字面 "\ud83e"
// → DeepSeek 解析请求体报 unexpected end of hex escape → story 路由整条 400，
// 且那条消息一直留在上下文里，回复与自动推进一起永久停摆。
//
// 这里守两件事：
//   ① cut / tail / toWellFormed 的行为（不劈 emoji、能修坏字符）；
//   ② 真实渲染路径（时间轴、当前事实、每日记忆）在含 emoji 的数据上不产坏字符。

import { cut, tail, toWellFormed, wellFormedDeep } from './text-safe.js';
import { Timeline } from './world/state.js';
import { renderWorldBlock, renderCurrentFacts } from './world/view.js';
import { buildDailyDigest, renderDigest } from './world/digest.js';

let pass = 0;
let fail = 0;

function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); } else { fail += 1; console.log(`  ✗ ${name} ${extra}`); }
}

function loneCount(s) {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i += 1; else n += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) n += 1;
  }
  return n;
}

// —— 事故原句：25 个 code unit，emoji 占 23、24 两个位置 ——
const INCIDENT = '收到消息：哼，你不承认的话，我就不喜欢你20秒🥺';
ok('事故原句长度符合当时事实', INCIDENT.length === 25, `实际 ${INCIDENT.length}`);

const c24 = cut(INCIDENT, 24);
ok('cut(24) 不劈 emoji', loneCount(c24) === 0 && c24.length === 23, JSON.stringify(c24));
ok('cut(25) 原样返回', cut(INCIDENT, 25) === INCIDENT);
ok('cut 超长才补省略号', cut('abc', 10, '…') === 'abc' && cut('abcdef', 3, '…') === 'abc…');
ok('cut(0) 返回空串', cut(INCIDENT, 0) === '');

ok('tail 不切在低代理上', loneCount(tail('x🥺yz', 4)) === 0 && tail('x🥺yz', 4).length >= 2);
ok('tail 整段返回', tail('abc', 10) === 'abc');

const broken = `前${String.fromCharCode(0xd83e)}后`;
ok('toWellFormed 修掉孤立高代理', loneCount(toWellFormed(broken)) === 0 && toWellFormed(broken).includes('\uFFFD'));
const deep = wellFormedDeep({ a: [broken, { b: broken }], c: 1 });
ok('wellFormedDeep 深到底', loneCount(JSON.stringify(deep)) === 0 && loneCount(deep.a[1].b) === 0);

// —— 真实渲染路径 ——
const now = Date.parse('2026-10-30T22:10:00+08:00');
const events = [
  {
    id: 'e1', at: '2026-10-30T11:39:58.246Z', kind: 'world', place: 'home',
    actors: ['u:1513971767'], remote: true, summary: INCIDENT, prose: INCIDENT, source: 'user',
  },
  {
    id: 'e2', at: '2026-10-30T11:41:00.000Z', kind: 'say', place: 'home',
    actors: ['self'], speaker: 'self', to: 'u:1513971767',
    summary: `${INCIDENT}的回应`, prose: `${INCIDENT}的回应`, source: 'narrator',
  },
];
const tl = new Timeline(events, 'home');
const nameOf = (x) => (x === 'u:1513971767' ? '他' : x);

for (const includeSays of [true, false]) {
  const block = renderWorldBlock(tl, now, { includeSays, compact: true, resolveName: nameOf });
  ok(`时间轴块(includeSays=${includeSays}) 无孤立代理`, loneCount(block) === 0);
}
ok('当前事实块无孤立代理', loneCount(renderCurrentFacts(tl, now, { includeSays: false })) === 0);
ok('每日记忆无孤立代理',
  loneCount(renderDigest(buildDailyDigest(events, now, { nameOf, includeSays: false }), { actsOnly: true })) === 0);

// —— 请求体级别：整个 messages 序列化后不许出现孤立代理转义 ——
const body = JSON.stringify({ messages: [{ role: 'user', content: renderWorldBlock(tl, now, { includeSays: true, resolveName: nameOf }) }] });
ok('序列化后的请求体没有 \\uD800-\\uDFFF 转义', !/\\u[dD][89abAB][0-9a-fA-F]{2}/.test(body));

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
