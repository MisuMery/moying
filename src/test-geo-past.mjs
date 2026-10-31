// 验证：异地约束 + 虚构过去拦截
import { checkFabricated, renderPastAnchorBlock } from './narrator/dialogue.js';
import { evaluateUrge } from './turn/urge.js';
import { renderGeography } from './persona/card.js';

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); } else { fail += 1; console.log(`  ✗ ${name}`); }
}

console.log('--- 1. 虚构过去 ---');
{
  const anchors = [];
  const hits = checkFabricated(['上周说的', '不然喃'], anchors, true);
  ok('无锚点「上周说的」被拦', hits.some((h) => h.kind === 'past' && h.text === '上周说的'));
  ok('「不然喃」不算编造', !hits.some((h) => h.text === '不然喃'));
}
{
  const anchors = [{ label: '昨天 21:03', text: '那不多夸夸我' }];
  const hits = checkFabricated(['你上次不是让我多夸夸你'], anchors, true);
  ok('有原话锚点时不误杀', hits.length === 0);
}
{
  const anchors = [{ label: '昨天 21:03', text: '那不多夸夸我' }];
  const hits = checkFabricated(['上周我们约好去旧书摊的'], anchors, true);
  ok('与锚点无关的「上周」仍被拦', hits.some((h) => h.kind === 'past'));
}

console.log('--- 2. 同城线下 ---');
{
  const a = checkFabricated(['晚上旧书摊还去不'], [], true);
  ok('「晚上旧书摊还去不」被拦', a.some((h) => h.kind === 'together'));
  const b = checkFabricated(['等你下班一起吃'], [], true);
  ok('「等你下班一起吃」被拦', b.length > 0);
  const c = checkFabricated(['我今晚想吃火锅'], [], true);
  ok('她自己的晚饭不被拦', c.length === 0);
}
{
  // 同城设定下不该拦
  const d = checkFabricated(['晚上一起去吃面不'], [], false);
  ok('同城设定不拦「一起去」', d.length === 0);
}

console.log('--- 3. 主动动机不再凭空引用 ---');
{
  let hookCount = 0;
  for (let i = 0; i < 400; i += 1) {
    const u = evaluateUrge({
      asleep: false, busy: false, hour: 22, longing: 0.8,
      minutesSinceContact: 400, minutesSinceOwn: 400, stageId: 'attached', hasNews: true,
      hisWords: [], rand: Math.random,
    });
    if (['hook', 'recall'].includes(u.motive)) hookCount += 1;
  }
  ok('无原话时不会抽中 hook/recall', hookCount === 0);

  let withWords = 0;
  for (let i = 0; i < 400; i += 1) {
    const u = evaluateUrge({
      asleep: false, busy: false, hour: 22, longing: 0.8,
      minutesSinceContact: 400, minutesSinceOwn: 400, stageId: 'attached', hasNews: true,
      hisWords: [{ text: '那不多夸夸我' }], rand: Math.random,
    });
    if (['hook', 'recall'].includes(u.motive)) withWords += 1;
  }
  ok('有原话时 hook/recall 可以出现', withWords > 0);
}

console.log('--- 4. 提示块 ---');
{
  const g = renderGeography({ geography: { apart: true, selfSide: 'A城', userSide: 'B城', note: '不在同一座城市' } });
  ok('地理块含「隔着距离」', g.includes('隔着距离') && g.includes('不在同一座城市'));
  const empty = renderPastAnchorBlock([]);
  ok('无锚点提示明确禁提过去', empty.includes('没有这回事'));
  const full = renderPastAnchorBlock([{ label: '昨天 21:03', text: '那不多夸夸我' }]);
  ok('有锚点时列出原话', full.includes('那不多夸夸我'));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
