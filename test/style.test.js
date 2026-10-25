import { test } from 'node:test';
import assert from 'node:assert/strict';

import { enforceStyle, styleLint, finalSanitize, stripTerminalPeriod } from '../src/style/enforce.js';
import { loadPersona, renderSpeechRules, renderRedlines, buildRegistry } from '../src/persona/card.js';
import { ensureSeedData } from './seed-data.js';

ensureSeedData(); // 必须在 loadPersona() 之前：干净环境先补通用演示种子
const persona = loadPersona();
const speech = persona.speech;

// 这些都是实际故事里真实出现过的带句号回复（正是用户抱怨的那批）
const REAL_DIRTY = [
  '知道了。', '不出去。', '醒了就睡不着了。', '嗯。', '有点吵。', '没有。',
  '就是吃饭，聊天，太吵了。', '在缓了。', '一直都不太习惯。', '喝果汁。',
  '不知道。', '有点累，闭眼缓缓。', '不想动。', '你也是。', '晚安。',
  '你问。', '好像好一点点。', '就是有点吵，现在好多了。', '醒了。',
  '"到家了。"', '「知道了。」',
];

test('P4: 句尾句号被强制清除（含引号包裹的情况）', () => {
  const out = enforceStyle(REAL_DIRTY, speech);
  assert.ok(out.length > 0, '不应全部清空');
  for (const b of out) {
    assert.ok(!/[。．]\s*$/.test(b), `仍带句尾句号: ${b}`);
  }
});

test('P4: 引号内的句号也被清掉', () => {
  assert.equal(stripTerminalPeriod('"到家了。"'), '"到家了"');
  assert.equal(stripTerminalPeriod('「知道了。」'), '「知道了」');
  assert.equal(stripTerminalPeriod('嗯？'), '嗯？', '问号要保留');
  assert.equal(stripTerminalPeriod('好哦~'), '好哦~', '波浪号要保留');
  assert.equal(stripTerminalPeriod('那个……'), '那个……', '省略号要保留');
});

test('P4: 超长句被拆成碎碎念多条', () => {
  const long = '今天甲方又让我把主图的颜色改回第一版了，说之前的藏青太跳，我改了一下午结果发现还是原来那个好看，好烦哦';
  const out = enforceStyle([long], speech);
  assert.ok(out.length > 1, `应拆成多条，实际: ${JSON.stringify(out)}`);
  for (const b of out) {
    assert.ok([...b].length <= speech.hardMaxChars, `单条仍超长: ${b}`);
  }
});

test('P4: 感叹号被降级（角色卡写明几乎不用！）', () => {
  const out = enforceStyle(['太好了！！！真的太好了！！！'], speech);
  const marks = out.join('').match(/[!！]/g) ?? [];
  assert.ok(marks.length <= 1, `感叹号应最多保留一个，实际 ${marks.length}`);
});

test('P4: 禁止的网络称呼被检出', () => {
  const lint = styleLint(['宝子你在吗', '嗯'], speech);
  assert.ok(lint.issues.some((i) => i.includes('网络称呼')), `应检出网络称呼: ${JSON.stringify(lint.issues)}`);
});

test('P4: 全量脏样本修复后句号率为 0，得分 100', () => {
  const { bubbles, corrections } = finalSanitize(REAL_DIRTY, speech);
  const lint = styleLint(bubbles, speech);
  assert.equal(lint.stats.periodEnd, 0, `句号残留: ${JSON.stringify(lint.issues)}`);
  assert.equal(lint.stats.tooLong, 0, `超长残留: ${JSON.stringify(lint.issues)}`);
  assert.equal(lint.score, 100);
  assert.ok(corrections.length > 0, '应记录程序改了什么（审计）');
});

test('P4: 干净输入不应被误改', () => {
  const clean = ['嗯', '好哦~', '那个……', '说起来', '在忙吗？'];
  const out = enforceStyle(clean, speech);
  assert.deepEqual(out, clean, '干净输入应保持原样');
});

test('P4: 角色卡渲染包含句号规则与红线', () => {
  const rules = renderSpeechRules(persona);
  assert.match(rules, /句尾一律不加句号/);
  const red = renderRedlines(persona);
  assert.match(red, /绝不编造|不许现编时间/);
  assert.match(red, /昵称爱称/);
  // V3 新增的降温红线必须在位
  assert.match(red, /不许表白/);
  assert.match(red, /不许撒娇撒成黏人精/);
  assert.match(red, /方括号表情文字|禁止输出 \[表情/);
});

test('P4: 角色卡能构建出虚构角色注册表', () => {
  const reg = buildRegistry(persona, { selfId: '12345' });
  // 不依赖任何具体配角：配角由使用者的 cast.json 决定
  const cast = reg.byKind('fictional');
  assert.ok(cast.length > 0, '应至少注册一个虚构角色');
  for (const a of cast) {
    assert.equal(a.deliverable, false, `${a.id} 不该有投递地址`);
  }
  assert.ok(reg.get('self'), '主角自己应注册');
});

// 「印象只受控增量」用例已移至 stages.test.js：它会写盘（applyDelta → #save），
// 必须住在「先设 MOYING_DATA_DIR 再 import」的文件里，否则每次跑测试都会往
// 真实的 data/impressions.json 里堆 test-* 垃圾条目（2026-10-25 审查实证）。
