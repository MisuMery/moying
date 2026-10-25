// 关系演化：相处方式由世界 AI 按剧情推演，不写死模板。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moying-evolve-'));
process.env.MOYING_DATA_DIR = tmp;
const { ensureSeedData } = await import('./seed-data.js');
ensureSeedData(); // 干净环境（无 data/）用通用演示种子补位
for (const f of ['persona.json', 'character.json', 'cast.json', 'user.json', 'impressions.json', 'relationship.json', 'world.json']) {
  try { fs.copyFileSync(path.resolve('data', f), path.join(tmp, f)); } catch { /* 可选 */ }
}
// relationship.template.json 住在 templates/（公开包不含 data/），单独从那儿取
try { fs.copyFileSync(path.resolve('templates', 'relationship.template.json'), path.join(tmp, 'relationship.template.json')); } catch { /* 可选 */ }

const { loadRelationship, saveRelationship, getStage, loadTemplate } = await import('../src/persona/relationship.js');
const { evolveStageContent, ensureStageContent } = await import('../src/persona/evolve.js');
const { loadPersona } = await import('../src/persona/card.js');

const persona = loadPersona();

test('模板: 不预置任何关系类型的相处方式', () => {
  const tpl = loadTemplate();
  assert.ok(Array.isArray(tpl.stages) && tpl.stages.length >= 3);
  for (const s of tpl.stages) {
    assert.equal((s.behaviorRules ?? []).length, 0, `${s.id} 不该预置相处方式`);
    assert.equal(s.tone, '', `${s.id} 不该预置状态描述`);
  }
  // 但阶段骨架（能说什么/不能说什么）要有，且不含恋人专属词
  const all = JSON.stringify(tpl.stages);
  assert.ok(!all.includes('表白'), '通用模板不该出现恋人专属条款');
  assert.ok(!all.includes('某个只有他们两个人知道的旧称呼'), '通用模板不该出现这个故事的专属触发');
});

test('演化: 世界 AI 写出新一档的相处方式并落库', async () => {
  const llm = async () => ({
    content: '{}',
    json: {
      tone: '重新靠近了的人',
      behaviorRules: ['可以说自己的烦恼', '会主动关心他', '偶尔表达一点在意'],
      specialTriggers: [{ when: '他认真问到当年的事', react: '会安静讲一点，然后收住话头' }],
    },
  });
  const r = await evolveStageContent({ stageId: 'trusting', persona, recentFacts: '- 他发来消息问她吃饭没', llm });
  assert.equal(r.ok, true, r.reason);
  const st = getStage('trusting');
  assert.equal(st.behaviorRules.length, 3);
  assert.equal(st.specialTriggers.length, 1);
  assert.ok(st.evolvedAt, '应记下演化时间');
  assert.ok(st.evolvedFrom, '应记下演化来源');
  // 起点是最近一个已有内容的前置档（熟悉），不是初始模式
  assert.equal(r.from, 'familiar');
});

test('演化: 上一档没有内容时，从初始相处方式起步', async () => {
  // 把前面几档都清空，模拟新装/刚重置（此时没有可继承的前置档）
  const rel = loadRelationship();
  saveRelationship({
    ...rel,
    stages: rel.stages.map((s) => (
      ['stranger', 'distant'].includes(s.id)
        ? { ...s, tone: '', behaviorRules: [], specialTriggers: [], manual: false }
        : s
    )),
  });
  const llm = async () => ({
    content: '{}',
    json: { tone: '刚搭上话', behaviorRules: ['回应为主'], specialTriggers: [] },
  });
  const r = await evolveStageContent({ stageId: 'distant', persona, llm });
  assert.equal(r.ok, true);
  assert.equal(r.from, 'initialMode', '应从初始相处方式演化');
  assert.ok(JSON.stringify(loadRelationship().initialMode.behaviorRules ?? []).length > 2, '初始相处方式应存在');
});

test('演化: 模型出错时保留原样，不写入半成品', async () => {
  const before = JSON.stringify(getStage('familiar').behaviorRules ?? []);
  const llm = async () => { throw new Error('boom'); };
  const r = await evolveStageContent({ stageId: 'familiar', persona, llm });
  assert.equal(r.ok, false);
  assert.match(r.reason, /失败|boom/);
  assert.equal(JSON.stringify(getStage('familiar').behaviorRules ?? []), before, '不该被改动');
});

test('演化: 模型给不出可用内容时也不覆盖', async () => {
  const before = JSON.stringify(getStage('familiar').behaviorRules ?? []);
  const r = await evolveStageContent({ stageId: 'familiar', persona, llm: async () => ({ content: '{}', json: { behaviorRules: [] } }) });
  assert.equal(r.ok, false);
  assert.equal(JSON.stringify(getStage('familiar').behaviorRules ?? []), before);
});

test('演化: 手动改过的档不会被自动覆盖，强制才行', async () => {
  const rel = loadRelationship();
  saveRelationship({
    ...rel,
    stages: rel.stages.map((s) => (s.id === 'familiar' ? { ...s, manual: true } : s)),
  });
  const llm = async () => ({ content: '{}', json: { tone: 'x', behaviorRules: ['a', 'b'], specialTriggers: [] } });
  const skipped = await evolveStageContent({ stageId: 'familiar', persona, llm });
  assert.equal(skipped.ok, false);
  assert.match(skipped.reason, /手动改过/);
  const forced = await evolveStageContent({ stageId: 'familiar', persona, llm, force: true });
  assert.equal(forced.ok, true);
  assert.equal(getStage('familiar').manual, false);
});

test('演化: 空档会自动补一份（ensureStageContent）', async () => {
  const rel = loadRelationship();
  saveRelationship({
    ...rel,
    stages: rel.stages.map((s) => (s.id === 'stranger' ? { ...s, tone: '', behaviorRules: [], specialTriggers: [], manual: false } : s)),
  });
  const r = await ensureStageContent({
    stageId: 'stranger',
    persona,
    llm: async () => ({ content: '{}', json: { tone: '还没什么交情', behaviorRules: ['回应为主', '不主动找他'], specialTriggers: [] } }),
  });
  assert.equal(r.ok, true);
  assert.equal(getStage('stranger').behaviorRules.length, 2);
  // 已经有内容时不重复调用
  const again = await ensureStageContent({ stageId: 'stranger', persona, llm: async () => { throw new Error('不该再调用'); } });
  assert.equal(again, null);
});
