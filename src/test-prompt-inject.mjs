// 验证：异地约束与「过去锚点」真的进了对话提示词
import { DialogueNarrator } from './narrator/dialogue.js';
import { CONTRACT } from './narrator/narrator.js';
import { loadPersona, buildRegistry, renderGeography } from './persona/card.js';

let pass = 0; let fail = 0;
const ok = (n, c) => { if (c) { pass += 1; console.log(`  ✓ ${n}`); } else { fail += 1; console.log(`  ✗ ${n}`); } };

const persona = loadPersona();
const reg = buildRegistry(persona);

const captured = [];
const llm = async (route, messages) => {
  captured.push(messages);
  return { json: { utterances: [{ id: 'u1', addresseeId: 'u:1513971767', content: '嗯' }] }, content: '{}' };
};

const d = new DialogueNarrator({
  store: { loadEvents: () => [] }, registry: reg, persona,
  impressions: { render: () => '' }, timeline: null, llm,
});

await d.run({
  worldSummary: '她在公司', trigger: '他发来一条消息', userId: '1513971767',
  now: Date.now(), pastAnchors: [{ label: '昨天 21:03', text: '那不多夸夸我' }],
});

const sys = captured[0]?.[0]?.content ?? '';
const usr = captured[0]?.[1]?.content ?? '';

ok('对话 system 含异地块', sys.includes('隔着距离') && sys.includes('两座城市'));
ok('对话 user 含过去锚点', usr.includes('你们之间真实发生过的过去') && usr.includes('那不多夸夸我'));
ok('叙事 CONTRACT 禁凭空预设', CONTRACT.includes('不许凭空预设既有事实'));
ok('叙事 CONTRACT 禁线下碰面', CONTRACT.includes('不要写她和他线下碰面的事'));
ok('地理块从角色卡读到 apart', renderGeography(persona).includes('两座城市'));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
