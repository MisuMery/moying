// 角色卡导入：把别人写的一段原始设定，交给**世界故事 AI**分析整理成结构化配置。
//
// 为什么用 story 路由而不是 chat：这一步要的是逻辑性与结构化能力
// （拆字段、补全作息与红线、把口语化的描述整理成一致的口径），正是故事模型擅长的；
// 对话模型更适合写短回复，不适合做这种整理。
// 因此流程上要求：先配好 story API 并测试通过，才能点「AI 分析」。

export const CHARACTER_TEMPLATE = {
  identity: { name: '', age: 0, job: '', city: '', appearance: [''] },
  relationshipAnchor: '她和对方是什么关系、这份感情怎么用（收着/不说破/还是直白）',
  traits: [{ key: '特点名', weight: 1, text: '一句话描述' }],
  speech: {
    maxChars: 15, hardMaxChars: 40, maxLines: 3, medianChars: 5,
    sentenceEndPeriod: 'forbidden', allowedTerminal: ['', '~', '……', '？'],
    exclamationRate: 0.02, burst: 'multiple_short', burstCount: '1~4',
    typoRepair: '', catchphrases: { agree: [''], hesitate: [''], yield: [''], ask: [''], rebut: [''], cheer: [''], laugh: [''] },
    dialect: { words: [''], hesitation: [''], density: '' },
    address: { toUser: ['你'], joking: [''], self: ['我'], selfJoking: [''], forbidden: [''] },
    emoji: { allowSingleOnlyMessage: true, forbidBracketText: true, note: '' },
    modernSlang: { whitelist: [''], note: '' },
    responsePatterns: ['先落一个短回应，再补第二句'],
    vagueness: ['坦白不知道：不知道 / 这个我不太清楚'],
    toneStrength: '',
  },
  speechStages: [
    { id: 'stranger', name: '陌生', when: '', maxChars: 4, hardMaxChars: 8, maxBubbles: 1, maxTotalChars: 6, note: '' },
    { id: 'distant', name: '疏离', when: '', maxChars: 6, hardMaxChars: 15, maxBubbles: 2, maxTotalChars: 12, note: '' },
    { id: 'familiar', name: '熟悉', when: '', maxChars: 8, hardMaxChars: 20, maxBubbles: 2, maxTotalChars: 16, note: '' },
    { id: 'trusting', name: '信任', when: '', maxChars: 12, hardMaxChars: 28, maxBubbles: 3, maxTotalChars: 24, note: '' },
    { id: 'attached', name: '依赖', when: '', maxChars: 15, hardMaxChars: 40, maxBubbles: 4, maxTotalChars: 30, note: '' },
  ],
  rhythm: { sleepAround: '', sleepNote: '', nightOwl: false, workHours: '', lowPointAround: '' },
  knowledgeBoundary: '',
  redlines: [''],
};

export function buildCharacterImportPrompt(rawText) {
  const system = [
    '你是角色设定整理器。用户会给你一段（可能口语化、零散的）角色设定文本，',
    '你要把它整理成结构化的角色配置 JSON。要求：',
    '1. 严格输出 JSON，且只包含下面模板里的字段，不要新增顶层字段。',
    '2. 原文没提到的字段：用符合这个人物气质的合理值补齐，不要留空字符串或空数组。',
    '3. speech 里的字数上限要贴合原文的说话风格（原文话少就调小，话多再调大）。',
    '4. redlines（红线）至少 8 条，把原文提到的禁忌、知识边界、语气禁忌都写进去。',
    '5. speechStages 五档的字数/条数必须单调递增（陌生最少，依赖最多）。',
    '6. 不要编造原文完全没有的硬性事实（如具体的公司名、住址）。',
    '',
    '模板：',
    JSON.stringify(CHARACTER_TEMPLATE, null, 2),
  ].join('\n');

  const user = [
    '下面是用户填写的原始角色设定，请整理成上面的 JSON：',
    '---',
    String(rawText ?? '').slice(0, 12000),
    '---',
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** 粗略校验 AI 产出的结构，缺关键字段就拒绝写入 */
export function validateCharacterDraft(json) {
  const errors = [];
  if (!json || typeof json !== 'object') return ['返回的不是对象'];
  if (!json.identity?.name) errors.push('缺少 identity.name');
  if (!Array.isArray(json.traits) || !json.traits.length) errors.push('traits 为空');
  if (!json.speech || typeof json.speech !== 'object') errors.push('缺少 speech');
  if (!Array.isArray(json.speechStages) || json.speechStages.length < 5) errors.push('speechStages 需要 5 档');
  else {
    const lens = json.speechStages.map((s) => Number(s?.maxChars ?? 0));
    for (let i = 1; i < lens.length; i += 1) {
      if (lens[i] < lens[i - 1]) { errors.push('speechStages 的字数上限必须单调递增'); break; }
    }
  }
  if (!Array.isArray(json.redlines) || json.redlines.length < 5) errors.push('redlines 至少需要 5 条');
  return errors;
}
