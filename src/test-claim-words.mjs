import { findArrivalClaim } from '/app/src/world/validator.js';

// 真实出现过的句子（事故现场）+ 一批该放行的路上说法
const CASES = [
  // [文本, 目的地, 期望是否命中]
  ['林夏走到超市门口回头喊她快点', 'market', true],
  ['到超市门口啦', 'market', true],
  ['林夏已经走到超市门口了，玻璃门里头冷气足', 'market', true],
  ['她加快了两步，风从街口灌过', 'market', false],
  ['还有两站，快到了', 'office', false],
  ['再走五分钟就到了', 'office', false],
  ['还没到，路上堵', 'office', false],
  ['我已经到公司了', 'office', true],
  ['下车了，在B口等你', 'office', true],    // 还在去公司的路上就说下车＝提前
  ['她推门进去，暖气扑在脸上', 'market', true],
  ['进了超市就直奔冷柜', 'market', true],
  ['到家了', 'home', true],
  ['我快到家了', 'home', false],
  ['还有三站才到，你先吃', 'office', false],
  ['走了一半，梧桐叶子踩得脆响', 'market', false],
  ['她下车换乘二号线', 'office', false],  // 换乘是路上的一部分
  ['她站在门口等他', 'market', true],
  ['差一点就到了，别催', 'office', false],
];

let pass = 0;
const fails = [];
for (const [text, to, want] of CASES) {
  const got = findArrivalClaim(text, to);
  const ok = want ? Boolean(got) : !got;
  if (ok) pass += 1;
  else fails.push({ text, to, want, got });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${JSON.stringify(text)} to=${to} => ${got ? `"${got}"` : '(放行)'}`);
}
console.log(`\n${pass}/${CASES.length} 通过`);
if (fails.length) {
  console.log('失败项：');
  for (const f of fails) console.log(' ', f);
}
