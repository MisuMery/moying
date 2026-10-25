import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moying-stage-'));
process.env.MOYING_DATA_DIR = tmp;
const { ensureSeedData } = await import('./seed-data.js');
ensureSeedData(); // 干净环境（无 data/）用通用演示种子补位
for (const f of ['persona.json', 'character.json', 'cast.json', 'user.json', 'impressions.json', 'relationship.json', 'world.json']) {
  try { fs.copyFileSync(path.resolve('data', f), path.join(tmp, f)); } catch { /* 可选文件缺失忽略 */ }
}
fs.copyFileSync(path.resolve('data/impressions.json'), path.join(tmp, 'impressions.json'));

const { loadPersona, buildRegistry, resolveStage, renderSpeechRules } = await import('../src/persona/card.js');
const { applyStage, stageList, inferStageId } = await import('../src/persona/stages.js');
const REL_MOD = await import('../src/persona/relationship.js');
const { maybeAdvanceStage } = REL_MOD;
const { enforceStyle } = await import('../src/style/enforce.js');
const { detectRepeat, normalizeForCompare, similarity } = await import('../src/narrator/repeat.js');
const { ImpressionStore } = await import('../src/persona/impression.js');
const { createRealUser } = await import('../src/cast/actors.js');
const { Store } = await import('../src/store.js');
const { Engine } = await import('../src/narrator/engine.js');

const persona = loadPersona();

// ---------- 分阶段说话 ----------

test('阶段: 感情态度可一键指定，说话档位随之变化', () => {
  const stages = ['stranger', 'distant', 'familiar', 'trusting', 'attached'];
  let prevChars = 0;
  for (const id of stages) {
    const s = resolveStage(persona, { stage: id });
    assert.equal(s.id, id, `指定 ${id} 应命中同名说话档位`);
    assert.ok(s.maxChars >= prevChars, `${id} 的单条上限应随阶段递增`);
    prevChars = s.maxChars;
  }
});

test('阶段: 没显式设置时按印象分数反推', () => {
  // 纯反推逻辑（不看全局默认值）
  assert.equal(inferStageId({ facets: {} }), 'stranger', '什么都不记得 = 陌生');
  assert.equal(inferStageId({ facets: { trust: 1, warmth: 1, intimacy: 0 } }), 'distant');
  assert.equal(inferStageId({ facets: { trust: 2, warmth: 2, intimacy: 2 } }), 'attached');
  // 经过 resolveStage 时，没写 stage 的印象会走 relationship.json 里设的全局默认阶段
  const fallback = resolveStage(persona, { facets: { trust: 1, warmth: 1, intimacy: 0 } });
  assert.ok(fallback?.id, '应该能解析出一个阶段');
});

test('阶段: 一键切换会改写印象分数', () => {
  const store = new ImpressionStore();
  const uid = `stage-${Date.now()}`;
  const applied = applyStage(store, uid, 'trusting');
  assert.equal(applied.stage, 'trusting');
  assert.equal(applied.facets.trust, 2);
  assert.equal(applied.facets.intimacy, 1);
  // 切回陌生要能降下来
  const back = applyStage(store, uid, 'stranger');
  assert.equal(back.facets.trust, 0);
  assert.equal(resolveStage(persona, back).id, 'stranger');
});

test('关系: 分数够了会自动往前进一档（故事发展中关系自然走近）', () => {
  const store = new ImpressionStore();
  const uid = `adv-${Date.now()}`;
  applyStage(store, uid, 'stranger');
  // 模拟故事推进后印象涨到依赖水平
  const imp = store.get(uid);
  store.put(uid, { ...imp, facets: { trust: 2, warmth: 2, intimacy: 2, interest: 2 } });
  const adv = maybeAdvanceStage(store, uid);
  assert.ok(adv, '应触发自动演进');
  assert.equal(adv.to, 'attached');
  assert.equal(store.get(uid).stage, 'attached');
  // 已经到位后再跑一次不应重复触发
  assert.equal(maybeAdvanceStage(store, uid), null);
});

test('关系: 依赖阶段会解除「不许说想你了」这类红线', () => {
  const persona2 = loadPersona();
  const { effectiveRedlines } = REL_MOD;
  const stranger = resolveStage(persona2, { stage: 'stranger' });
  const attached = resolveStage(persona2, { stage: 'attached' });
  const early = effectiveRedlines(persona2, stranger);
  const late = effectiveRedlines(persona2, attached);
  assert.ok(early.some((l) => String(l).includes('想你了')), '早期应保留该限制');
  assert.ok(!late.some((l) => String(l).includes('想你了')), '依赖阶段应解除该限制');
  assert.ok(!late.some((l) => String(l).includes('不许表白')), '依赖阶段应解除不许表白');
  // 解除的同时，阶段自己的分寸要求要补上
  assert.ok(late.some((l) => String(l).includes('依赖阶段')), '应补上本阶段的禁止项');
});

test('口头禅: 「嘿嘿~」「哎呀」这类亲密档的话，关系没到就不能用', () => {
  const p = loadPersona();
  const early = renderSpeechRules(p, resolveStage(p, { stage: 'distant' }));
  const late = renderSpeechRules(p, resolveStage(p, { stage: 'attached' }));
  // 疏离期：亲密档的词必须出现在「现在不要用」那一组里
  const lockedBlock = early.split('还不到份上的话')[1] ?? '';
  assert.ok(lockedBlock.includes('嘿嘿~'), '疏离期应把嘿嘿~列为不可用');
  assert.ok(lockedBlock.includes('哎呀'), '疏离期应把哎呀列为不可用');
  assert.ok(lockedBlock.includes('早点睡'), '疏离期连主动关心也还没到');
  // 依赖期：它们出现在可用清单里，且不再被列为禁用
  const lateLocked = late.split('还不到份上的话')[1] ?? '';
  assert.ok(!lateLocked.includes('嘿嘿~'));
  assert.match(late, /很亲近才用·开心：[^\\n]*嘿嘿~/);
});

test('口头禅: 两套合并后各归其位，中性词任何时候都能用', () => {
  const p = loadPersona();
  const tiers = p.speech.catchphrases;
  assert.deepEqual(Object.keys(tiers), ['any', 'warm', 'intimate']);
  // HDS 那套：开启话题 / 理亏 / 开心
  assert.ok(tiers.warm.open.includes('说起来'));
  assert.ok(tiers.intimate.happy.includes('嘿嘿~'));
  // V3 那套：承接 / 迟疑 / 反问
  assert.ok(tiers.any.agree.includes('嗯嗯'));
  assert.ok(tiers.any.ask.includes('真的假的喃？'));
  const anyStage = renderSpeechRules(p, resolveStage(p, { stage: 'stranger' }));
  assert.match(anyStage, /任何关系·承接\/认同/);
});

test('关系: 相处方式属于每个阶段自己，不跨阶段打架', () => {
  const { renderRelationship } = REL_MOD;
  const distant = renderRelationship({ stage: 'distant' }, resolveStage(persona, { stage: 'distant' }));
  const attached = renderRelationship({ stage: 'attached' }, resolveStage(persona, { stage: 'attached' }));
  // 疏离期：收着不说破、被表白会躲
  assert.match(distant, /收着、不说破/);
  assert.match(distant, /软绵绵地退开/);
  assert.ok(!distant.includes('可以直接表达想念和喜欢'), '疏离期不该出现恋人表达');
  // 依赖期：想念可以说出口、当年的表白可以坦然接住；「收着不说破」不再出现
  assert.match(attached, /可以直接表达想念和喜欢/);
  // 下面这句对真实数据与合成 fixtures 都成立（不依赖任何具体人设文案）
  assert.match(attached, /已经是两个人的日常/);
  assert.ok(!attached.includes('收着、不说破'), '恋人阶段不该再要求收着不说破');
  assert.ok(!attached.includes('软绵绵地退开'), '恋人阶段不该再躲表白话题');
});

test('阶段: 疏离期把长回复压到 2 条 / 12 字以内', () => {
  const stage = resolveStage(persona, { stage: 'distant' });
  const long = [
    '我今天一整天都在改那个主图的颜色，甲方真是太难伺候了',
    '而且室友还一直催我出门',
    '我实在是不想动啊',
  ];
  const out = enforceStyle(long, persona.speech, stage);
  assert.ok(out.length <= stage.maxBubbles, `条数应被压到 ${stage.maxBubbles} 以内，实际 ${out.length}`);
  const total = out.reduce((s, b) => s + [...b].length, 0);
  assert.ok(total <= stage.maxTotalChars, `总字数应不超过 ${stage.maxTotalChars}，实际 ${total}`);
  for (const b of out) assert.ok(!/[。]$/.test(b), `不应带句尾句号：${b}`);
});

test('阶段: 规则里明确写出当前阶段的上限', () => {
  const stage = resolveStage(persona, { stage: 'distant' });
  const rules = renderSpeechRules(persona, stage);
  assert.match(rules, /疏离/);
  assert.match(rules, /一次最多发 2 条/);
});

// ---------- 重复检测 ----------

test('去重: 「你怎么醒这么早」说第二遍会被抓到', () => {
  const recent = ['嗯', '刚醒', '你怎么醒这么早', '今天不上班吗'];
  const repeats = detectRepeat(['你怎么醒这么早'], recent);
  assert.equal(repeats.length, 1);
  assert.equal(repeats[0].kind, 'exact');
  assert.equal(repeats[0].matched, '你怎么醒这么早');
});

test('去重: 换个标点再说一遍也算重复', () => {
  const repeats = detectRepeat(['你怎么醒这么早？'], ['你怎么醒这么早']);
  assert.equal(repeats.length, 1, '归一化后应识别为同一句');
});

test('去重: 「嗯」这种常用短回应不算重复', () => {
  const recent = ['嗯', '好', '嗯'];
  const repeats = detectRepeat(['嗯'], recent);
  assert.equal(repeats.length, 0, '短回应不该被当成重复');
});

test('去重: 意思不同的话不误伤', () => {
  const repeats = detectRepeat(['我去洗个澡'], ['刚醒', '你怎么醒这么早']);
  assert.equal(repeats.length, 0);
});

test('去重: 归一化会去掉句号与标点', () => {
  assert.equal(normalizeForCompare('知道了。'), '知道了');
  assert.equal(normalizeForCompare('嗯？'), '嗯');
  assert.ok(similarity('你怎么醒这么早', '你怎么醒这么早？') === 1);
});

// ---------- 两阶段流程 ----------

test('两阶段: 世界阶段判定状态，对话阶段产出话语，重复的被丢掉', async () => {
  const store = new Store();
  const registry = buildRegistry(persona, { selfId: '10001' });
  registry.register(createRealUser({ userId: '10001' }));
  const impressions = new ImpressionStore();

  // 预置：她刚说过「你怎么醒这么早」
  store.appendEvent({
    at: new Date(Date.now() - 60000).toISOString(), kind: 'say',
    actors: ['self', 'u:10001'], summary: '你怎么醒这么早', prose: '你怎么醒这么早', source: 'user',
  });

  const calls = [];
  const llm = async (role, messages, opts) => {
    calls.push(role);
    if (role === 'story') {
      return {
        content: '{}',
        json: {
          narration: '她醒了，赖在被窝里',
          events: [{ at: new Date().toISOString(), kind: 'act', place: 'home', summary: '醒来看手机' }],
        },
      };
    }
    // chat 阶段：故意重复刚说过的话，且给室友也发一条
    return {
      content: '{}',
      json: {
        utterances: [
          { id: 'u1', addresseeId: 'u:10001', content: '你怎么醒这么早' },
          { id: 'u2', addresseeId: 'u:10001', content: '睡不着' },
          { id: 'u3', addresseeId: 'c:roommate', content: '室友你起了吗' },
        ],
        impressionDelta: { facets: { warmth: 1 } },
      },
    };
  };

  const sent = [];
  const client = { sendSegments: async (kind, id, segments) => { sent.push({ kind, id, segments }); return { message_id: 1 }; } };

  const engine = new Engine({
    client, store, persona, registry, impressions,
    config: { story: { maxRevision: 0 }, reply: { enabled: false }, rate: { maxCharsPerMinute: 999 } },
    llm,
  });

  const r = await engine.handleUserMessage({ userId: '10001', text: '早', now: Date.now() });
  // 不管门控有没有排队，都把缓冲冲刷掉并等这一轮跑完
  await engine.inbox.flush('10001');
  void r;

  // 两个路由都用到了
  assert.ok(calls.includes('story'), '世界阶段应调用 story 路由');
  assert.ok(calls.includes('chat'), '对话阶段应调用 chat 路由');

  // 发给室友的那条必须零出站
  assert.ok(!sent.some((s) => JSON.stringify(s.segments).includes('室友')), '不该出现发给虚构角色的消息');
  // 重复的那句不该发出去
  for (const s of sent) {
    const text = s.segments.map((x) => x.data?.text ?? '').join('');
    assert.ok(!text.includes('你怎么醒这么早'), `重复句不该发出：${text}`);
  }
});

test('印象: 只受控增量，不能一次跳到极端', () => {
  const store = new ImpressionStore();
  const uid = `test-${Date.now()}`;
  store.applyDelta(uid, { facets: { warmth: 5 } }, { entryId: 1 });
  assert.equal(store.get(uid).facets.warmth, 1, '单轮最多 +1');
  for (let i = 0; i < 10; i += 1) store.applyDelta(uid, { facets: { warmth: 1 } }, { entryId: i });
  assert.equal(store.get(uid).facets.warmth, 2, '上限 clamp 到 +2');
  for (let i = 0; i < 10; i += 1) store.applyDelta(uid, { facets: { warmth: -1 } }, { entryId: i });
  assert.equal(store.get(uid).facets.warmth, -2, '下限 clamp 到 -2');
  const text = store.render(uid);
  assert.match(text, /对当前这个人的印象/);
  assert.match(text, /亲近 -2/);
});
