import { Timeline, EventKind, Place } from '/app/src/world/state.js';
import { findArrivalClaim, validateDrafts } from '/app/src/world/validator.js';

let pass = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) pass += 1;
  else fails.push({ name, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${ok ? '' : ` → ${JSON.stringify(detail)}`}`);
}

// 还原 2026-10-31 08:21:48 那次出门：家→超市，路网 5 分钟
const T0 = Date.parse('2026-10-31T08:21:48.925+08:00');
const move = {
  id: 'mv1', at: new Date(T0).toISOString(), kind: EventKind.MOVE,
  from: Place.HOME, to: Place.MARKET, mode: 'walk', minutes: 5,
  arriveAt: new Date(T0 + 5 * 60000).toISOString(),
  actors: ['c:linxia'], summary: '她和林夏一起出门，走路去超市',
};
const tl = new Timeline([move], Place.HOME);
const NOW = T0 + 10 * 60000;

function draft(atMs, extra) {
  return { at: new Date(atMs).toISOString(), ...extra };
}
function rules(v) {
  return v.hard.map((x) => x.rule);
}

// 1) 途中（+30 秒）说「到超市门口啦」→ R14
{
  const v = validateDrafts([
    draft(T0 + 30000, {
      kind: EventKind.SAY, speaker: 'self', to: 'u:1513971767',
      place: Place.TRANSIT, summary: '到超市门口啦',
    }),
  ], tl, { now: NOW });
  check('途中说「到超市门口啦」判 R14', rules(v).includes('R14'), v.hard);
}

// 2) 同一时刻的旁白「林夏走到超市门口」→ R14，但只记 soft（旁白里的措辞不打断生成）
{
  const v = validateDrafts([
    draft(T0 + 40000, {
      kind: EventKind.NARRATION, place: Place.TRANSIT,
      summary: '林夏走到超市门口回头喊她快点',
      prose: '林夏走到超市门口回头喊她快点，风把她的头发吹到脸上。',
    }),
  ], tl, { now: NOW });
  check('途中旁白写配角已到门口：R14 记为 soft',
    v.soft.some((x) => x.rule === 'R14') && !rules(v).includes('R14'), v);
}

// 3) 途中说「还有两站/快到了」→ 放行（这是路上该说的话）
{
  const v = validateDrafts([
    draft(T0 + 50000, {
      kind: EventKind.NARRATION, place: Place.TRANSIT,
      summary: '风从街口灌过来', prose: '还有几分钟就到了，她把领子往上拢了拢，快步跟上林夏。',
    }),
  ], tl, { now: NOW });
  check('途中说「还有几分钟就到」放行', !rules(v).includes('R14'), v.hard);
}

// 4) 到了之后（+6 分钟）再说抵达 → 不判 R14
{
  const v = validateDrafts([
    draft(T0 + 6 * 60000, {
      kind: EventKind.NARRATION, place: Place.MARKET,
      summary: '她推门进去', prose: '她推门进去，暖气扑在脸上，玻璃门上还留着外面的风。',
    }),
  ], tl, { now: NOW });
  check('抵达之后写进门不判 R14', !rules(v).includes('R14'), v.hard);
}

// 5) 没有行程时，「到家了」不该由 R14 管（R13 会管地点）
{
  const plain = new Timeline([
    { id: 'a1', at: new Date(T0).toISOString(), kind: EventKind.ACT, place: Place.HOME, actors: [], summary: '她在沙发上坐下' },
  ], Place.HOME);
  const v = validateDrafts([
    draft(T0 + 30000, {
      kind: EventKind.NARRATION, place: Place.HOME,
      summary: '到家了', prose: '她把包扔在玄关，到家了。',
    }),
  ], plain, { now: NOW });
  check('没有行程时不误报 R14', !rules(v).includes('R14'), v.hard);
}

// 6) 判据是目的地，不是白名单：没登记过的地儿同样管得住
{
  const g = findArrivalClaim('我已经到了，在门口等你', 'gym');
  check('未登记地点靠通用抵达词也拦得住', Boolean(g), g);
}

console.log(`\n${pass}/${pass + fails.length} 通过`);
if (fails.length) {
  for (const f of fails) console.log(' 失败：', f.name, JSON.stringify(f.detail).slice(0, 300));
  process.exitCode = 1;
}
