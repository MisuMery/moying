// 验证：同居暗示（把他当同住人）的拦截，且不误伤合法说法
import { checkFabricated, renderCastOwnership } from './narrator/dialogue.js';
import { renderGeography, loadPersona } from './persona/card.js';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name} ${extra}`); }
}

const hit = (t) => checkFabricated([t], [], true).map((h) => h.kind);

console.log('--- 1. 该拦的：把他叫回家 ---');
for (const t of [
  '那快开完回来吃饭',
  '回来吧',
  '等你回来',
  '回来一趟呗',
  '给你留了饭',
  '家里等你',
  '我回我这儿了',            // 不命中也行，下面单独验
  '你回来吃啊',
  '回家吃吧',
  '给你带饭',
]) {
  const k = hit(t);
  if (t === '我回我这儿了') { ok(`「${t}」不该误判（她自己的事）`, k.length === 0, k.join(',')); continue; }
  ok(`「${t}」判为同居暗示`, k.includes('home'), k.join(','));
}

console.log('--- 2. 不能误伤：她自己回家 / 关心他回家 ---');
for (const t of [
  '我回来了',
  '我先回去看看家里还有没有菜',
  '回去吃饭',
  '你回家了吗',
  '到家了没',
  '我到家了',
  '等我回去再说',
  '下班回去路上买点熟菜',
  '你晚上吃什么',
  '你吃了吗',
  '她回她自己那边，不关你事',
]) {
  const k = hit(t);
  ok(`「${t}」放行`, k.length === 0, k.join(','));
}

console.log('--- 3. 异地关闭时（apart=false）不拦 ---');
{
  const k = checkFabricated(['回来吃饭'], [], false).map((h) => h.kind);
  ok('同城设定下「回来吃饭」放行', k.length === 0, k.join(','));
}

console.log('--- 4. 原有规则仍生效 ---');
{
  ok('「上周说的」仍被拦', checkFabricated(['上周说的'], [], true).some((h) => h.kind === 'past'));
  ok('「你过来」仍被拦', checkFabricated(['你过来吧'], [], true).some((h) => h.kind === 'together'));
  ok('同居优先于同城归类', checkFabricated(['回来吃饭，你过来'], [], true)[0]?.kind === 'home');
}

console.log('--- 5. 提示词是否真的带上了 ---');
{
  const p = loadPersona();
  const geo = renderGeography(p);
  ok('地理块含「回来吃饭」禁令', geo.includes('回来吃饭'), geo.slice(0, 60));
  const owner = renderCastOwnership(p, '1513971767');
  ok('归属块含第 4 条同居规则', owner.includes('回来吃饭'), owner.slice(-80));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
