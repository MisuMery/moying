// 对话阶段（chat 路由）：只负责「她说了什么」。
//
// 与世界阶段分开的意义：世界阶段已经把「她在哪、在干嘛、和谁在一起」定下来并通过了
// 矛盾校验，对话阶段拿到的是**已经确认无矛盾的状态**，不会再出现「已经出门了又说出门」
// 这类把世界状态和话语搅在一起的矛盾；同时这一阶段能看见最近说过的所有话，
// 专门负责避免「你怎么醒这么早」说两遍。

import { cut, tail as tailCut } from '../text-safe.js';
import { callLLM } from '../llm/gateway.js';
import { renderWorldBlock, nameResolver } from '../world/view.js';
import {
  renderIdentity, renderSpeechRules, renderRedlines, renderResponsePatterns,
  renderVagueness, renderKnowledgeBoundary, renderCast, retrieveTraits, renderGeography,
  renderLivingRules, loadUser,
} from '../persona/card.js';
import { renderRelationship } from '../persona/relationship.js';
import { localHour } from '../world/time.js';
import { detectRepeat, renderRecentSays } from './repeat.js';
import { faceIdByName } from '../onebot/face-catalog.js';
import { isBannedFaceName } from '../onebot/outbox.js';

// 常用表情名候选：只保留**目录里真实存在且有数字编号**的，
// 否则模型写了名字却查不到，只能退回 emoji 或纯文字（那正是我们不想要的）。
const FACE_NAME_HINTS = [
  '笑哭', '委屈', '流泪', '大哭', '难过', '惊讶',
  '发怒', '抓狂', '睡', '困', '哈欠', '吐', '嘘', '赞', '鼓掌', '握手',
  '拥抱', '爱心', '心碎', '吃瓜', '咖啡', '玫瑰', 'doge', '托腮', '晕', '酷',
  '悠闲', '胜利', '抱拳', '拳头', '太阳', '月亮', '蛋糕', '茶', '鞭炮', '奋斗',
  '暗中观察', '问号脸', '脑阔疼', '沧桑', '头秃', 'emm', '呵呵哒',
]; // 偷笑/害羞/调皮/可爱/憨笑/呲牙/卖萌/得意 这类老式卖萌已进禁用清单，不再推荐

/** 当前协议端目录里真正能发的表情名 */
export function availableFaceNames() {
  return FACE_NAME_HINTS.filter((n) => {
    if (isBannedFaceName(n)) return false; // 双保险：禁用清单里的绝不推荐
    const id = faceIdByName(n);
    return id !== null && id !== undefined && /^\d+$/.test(String(id));
  });
}

export function dialogueContract(userId, { faceNames = [], maxBubbles = 3 } = {}) {
  return `只输出一个 JSON 对象：
{
  "utterances": [
    { "id": "u1", "addresseeId": "u:${userId}", "content": "回给他的那句话" }
  ],
  "impressionDelta": { "facets": { "warmth": 1 }, "addNotes": ["记得的一件小事"] }
}

规则：
- **utterances 只装「真的发到他手机上」的话**，收件人永远是 u:${userId}。
  你对故事内人物说的话不写进 utterances——那些是剧本里的台词，世界叙事已经写过了；
  写进来也发不出去，只会把本该给他的回复挤掉。
- utterances 可以为空数组（她选择不说话也是正常的，尤其是忙、困、没什么可说的时候）。
- 但对方直接发来的私聊消息是另一回事：除非她在睡觉、在气头上、或真的懒得搭理，否则绝不许把 utterances 留空。再短的回应对她来说也比沉默好——「嗯」「？」「hhhh」都算回应。
- 上面「你的生活」那一层是旁白，**不是消息**：那里面的句子（谁问了你什么、你回了谁什么、你端着碗、她推过来一罐汽水）一律不许原句搬进 utterances。
  你要发出去的话，只能是对「他」说的新句子。
- **addresseeId 一律填 u:${userId}**，绝不许填「对方QQ号」「对方」「他」「你」这类占位符或中文，也不要填 c:xxx（那是故事内人物，没有手机号）。填错的话那句话会被丢弃，他就什么都收不到。
- **他连着发了几条，那是「一段话」，不是「几道题」**：不要一条对一条地分配回复，
  也不许把身边发生的事当成其中某一条的答案。想清楚他这一串到底在说什么，一次性接住。
- 一次最多发 ${maxBubbles} 条；绝大多数时候 1~2 条就够。宁可少发，也不要凑数。
- **每条都要短**，按当前阶段的上限来；不要复述对方刚说的话，也不要重复自己刚说过的话。
- impressionDelta.addNotes 只写「关于他」的具体事（他说过什么、做过什么、你们之间发生的小事），一条一句；
  你自己的日常、你和故事内人物的事不要写进来，更不要写成「他说过」——记串了以后会一直引错。
- **绝不说空话**：「昨天的事」「之前聊的那个」「那件事」「有些事想跟你说」这种没有内容的话一律不许说——对方接不住，你下一句也接不住。要提就提具体是什么（哪句话、哪样东西、哪个时刻）；想不起来就别提这件事，换一件具体的说。
- **绝不编过去**：你们之间发生过的，只有「你和他之间真实的过去」里列出的那些。上面没有的，就是没发生过。
${faceNames.length
    ? `- 表情：只用 QQ 自带表情，写成 [表情:名字]，例如 [表情:笑哭]；偶尔一个就够，别每条都带，也别连发。
  可用名字：${faceNames.join(' ')}
  不要直接写 😂🙃 这类 emoji 字符，也不要写「[笑哭]」这种裸方括号。
  上面若有「可用的表情包」清单，真心想甩一张就在那句话里写 [贴纸:id]（一次最多一张，不必每句都带）。`
    : '- **不要发表情**：不写 [表情:xxx]、不写 emoji 字符、不写颜文字、不甩贴纸。这一轮纯文字。'}
`;
}

/** 指代词：他这句话是不是在“接你上一句” */
const REFERENTIAL_RE = /(这个|那个|这事|那事|这件事|那件事|刚才|刚刚|指的是|什么意思|啥意思|突然说|说的是)/;

// ---- 真实性与距离的两道闸 ----
// 2026-10-29 事故：她发「晚上旧书摊还去不」→他问「啊？我吗」→她答「不然喃 / 上周说的」。
// 时间轴里没有这个约定，两人也不在同一座城市。提示词加了约束，但模型仍可能越界，
// 所以这里再做一层文本检查：命中就回灌重写，绝不让假过去和同城约会直接发出去。
const PAST_MARK_RE = /(上周|上个?星期|上回|上次|那天|那会儿|之前你|你之前|你说过|你讲过|你答应|说好的|约好的|约好|商量好|你欠我)/;
const TOGETHER_RE = /(一起去|一起逛|一起看|一起吃|一起走|一块儿去|还去不|来接我|我去接你|你过来|来我这边|来我这儿|楼下等|等你下班|碰头)/;
// 同居暗示：比「一起去」更隐晦的一种越界——把对方当成住在一起的人。
// 2026-10-29 17:45 事故：她和陈哥下班路上聊「回去看看家里还有点菜」，
// 这段叙事进了对话提示，她转头对他说「那快开完回来吃饭」——凭空造出一个共同的家。
// 只拦「把对方叫回家」的句式；「我回来了」「回去吃饭」「你回家了吗」这些不合规也合法，不拦。
const COHABIT_RE = /(回来吃|回来吧|快回来|等你回来|回来一趟|(?<!我)回我这儿|(?<!我)回我这边|回我们家|回家吃|给你留饭|留了饭|家里等你|在家等你|给你带饭|给你捎饭)/;

function bigramSet(text) {
  const s = String(text ?? '').replace(/[\s，。、！？…~～「」“”"'（）()《》]/g, '');
  const out = new Set();
  for (let i = 0; i + 2 <= s.length; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

/**
 * 检查这一批话里有没有「编出来的过去」「假装同城的线下约会」「把他当同住的人」。
 * @returns {{text:string, kind:'past'|'together'|'home'}[]}
 */
export function checkFabricated(texts = [], pastAnchors = [], apart = true) {
  const anchors = (pastAnchors ?? []).map((a) => bigramSet(a?.text ?? ''));
  const hits = [];
  for (const raw of texts) {
    const text = String(raw ?? '');
    if (!text) continue;
    if (apart && COHABIT_RE.test(text)) {
      hits.push({ text, kind: 'home' });
      continue;
    }
    if (apart && TOGETHER_RE.test(text)) {
      hits.push({ text, kind: 'together' });
      continue;
    }
    if (PAST_MARK_RE.test(text)) {
      // 有原话可指，且这句确实和某句原话有交集 → 算有依据；否则就是编的
      const grams = bigramSet(text);
      const supported = anchors.some((a) => {
        for (const g of grams) if (a.has(g)) return true;
        return false;
      });
      if (!supported) hits.push({ text, kind: 'past' });
    }
  }
  return hits;
}

/**
 * 角色归属块：谁是谁、各自的事归谁。
 * 2026-10-29：她把和林夏的旧书店安排说成「上周说的」、算到用户头上——
 * 根因之一是没人告诉她「林夏的事不是你们之间的事」。
 */
export function renderCastOwnership(persona, userId) {
  const cast = persona?.cast ?? [];
  if (!cast.length) return '';
  const names = cast.map((c) => c.displayName).join('/');
  return [
    '<谁是谁（各自的事别串）>',
    ...cast.map((c) => `- ${c.displayName}：${cut(String(c.relation ?? ''), 40)}。你和他/她之间的事，只属于你们两个人。`),
    `- 他（u:${userId}）：跟你隔着距离的那个人。`,
    '规则：',
    `1. ${names} 说给你的话、你答应他们的事、你和他们一起去过的地方，都不能说成「你和他」之间发生过。`,
    '2. 反过来也一样：他说过的、你们聊过的，不要安到他们头上。',
    '3. 你在他们面前的样子，和在他面前的样子不一样，别混着用。',
    '4. 谁跟你住在一起，见上面「谁住在你那儿」——不住你那儿的人，不许写进你的家，也不许对他说「回来吃饭」「给你留了饭」「等你回来」，他住在另一座城市。',
    '</谁是谁（各自的事别串）>',
  ].join('\n');
}

/** 把「他真实说过的原话」摆出来——这是她唯一可以引用的过去 */export function renderPastAnchorBlock(pastAnchors = []) {
  if (!pastAnchors.length) {
    return [
      '<你们之间真实发生过的过去>',
      '他这边没有留下任何可引用的原话。',
      '所以不要提「上次你说的」「我们说好的」「上周约的」这类过去——没有这回事。想说点什么，说眼前的事。',
      '</你们之间真实发生过的过去>',
    ].join('\n');
  }
  return [
    '<你们之间真实发生过的过去（只能引用这些）>',
    ...pastAnchors.map((a) => `- [${a.label ?? ''}] 他说：「${a.text}」`),
    '想提「上次」「那天」「你说过的」，只能指向上面某一句，并且说得清是哪句、什么情境。',
    '上面没有的，就是没发生过——不许编，也不许把「你自己想去」包装成「我们说好的」。',
    '</你们之间真实发生过的过去>',
  ].join('\n');
}


/**
 * 构造「他这句是在接你上一句」提示块。
 * 只在他最新消息含指代词、且上下文里能找到她上一句时才生成——否则不打扰。
 * 目的：拦住「被追问却答‘嗯’‘刚醒’把话题掐断」这种最伤体验的回复。
 */
export function buildReferentBlock(recentConversation = []) {
  const lines = (recentConversation ?? []).map((x) => String(x ?? ''));
  if (!lines.length) return '';

  let hisIdx = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].startsWith('[他]')) { hisIdx = i; break; }
  }
  if (hisIdx < 0) return '';
  const his = lines[hisIdx].replace(/^\[他\]\s*/, '').trim();
  if (!his || !REFERENTIAL_RE.test(his)) return '';

  let her = '';
  for (let i = hisIdx - 1; i >= 0; i -= 1) {
    if (lines[i].startsWith('[她]')) { her = lines[i].replace(/^\[她\]\s*/, '').trim(); break; }
  }
  if (!her) return '';

  return [
    '<他这句是在接你上一句（必须接住，不许把话题丢掉）>',
    `你上一句对他说的是：「${her}」`,
    `他刚回你的是：「${his}」`,
    '——他话里的「这个/那个/刚才」之类，指的就是你上一句里提到的那件事。',
    '你必须接着它回应：要么说清那具体是什么事，要么顺着它往下聊；',
    '绝不许把它撂在一边、只回「嗯」「哦」「刚醒」「早」这种把话掐断的敷衍。',
    '要是你上一句说得太笼统（比如只说了「昨天的事」却没说是哪件），现在就把它说具体。',
    '</他这句是在接你上一句>',
    '',
  ].join('\n');
}

/**
 * 连发规则：他连发几条 = 一段话，不是几道题。
 *
 * 2026-10-29 线上：他连发「嘿嘿，晚点去也可以啦」「应该不是很急吧」，
 * 她回了四条，一条对一条地分配，最后一条还把旁白（「林夏问我要不要开汽水」）当成了答案。
 * 模型看到的是逐条的 [他]，天然会按条数生成回复。这里先把「这是一串」说破。
 */
export function renderBatchRule(recentConversation = [], maxBubbles = 3) {
  const lines = (recentConversation ?? []).map((x) => String(x ?? ''));
  const countTail = (prefix) => {
    let n = 0;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i].startsWith(prefix)) break;
      n += 1;
    }
    return n;
  };
  const his = countTail('[他]');
  const hers = countTail('[她]');
  const out = [];
  if (his >= 2) {
    out.push(`<他这一串（连续 ${his} 条）>`);
    out.push(`他刚才连着发了 ${his} 条。这**是一段话**，不是 ${his} 个问题。`);
    out.push('· 先把这 ' + his + ' 条合起来看：他到底在说哪件事、什么语气。你的回话要落在**这件事**上。');
    out.push('· 不要一条对一条地分配回复；也不要只抓最后半句——如果前两条才是重点，就答前两条。');
    out.push(`· 回 2 条左右（1~${maxBubbles} 条都行）：一条接住他的意思，另一条可以带上你这边正在做的事。`);
    out.push('· 连发一串说明他聊在兴头上，你回得比他少是正常的；但也别只剩一个字——那不像在聊。');
    out.push('· 自检：你说完这几句，他会不会觉得「她看懂我在说什么了」？会，就发。');
    out.push('</他这一串>');
    out.push('');
  }
  if (hers >= 3) {
    out.push(`（你上一轮已经连发了 ${hers} 条，这一轮收着点：1~2 条，挑最想说的那句。）`);
    out.push('');
  }
  return out.join('\n');
}

function systemPrompt({ persona, impression, registry, stage, hour, userId, maxBubbles = 3, faceNames = [] }) {
  const castIds = registry.fictionalCast().map((a) => `${a.id}（${a.displayName}）`).join('、');
  return [
    renderIdentity(persona),
    '',
    impression,
    '',
    renderRelationship(impression, stage),
    '',
    renderSpeechRules(persona, stage, hour),
    '',
    renderResponsePatterns(persona),
    '',
    renderVagueness(persona),
    '',
    renderKnowledgeBoundary(persona),
    '',
    renderGeography(persona),
    '',
    renderRedlines(persona, stage),
    '',
    renderCast(persona),
    '',
    renderLivingRules(persona),
    '',
    renderCastOwnership(persona, userId),
    '',
    '<可填的收件人 id>',
    `故事内人物：${castIds}`,
    `真实用户：u:${userId}（就是此刻和你说话的人；收件人必须写这个真实 id，绝不写「对方QQ号」之类的占位符）`,
    '</可填的收件人 id>',
    '',
    dialogueContract(userId, { faceNames, maxBubbles }),
  ].join('\n');
}

/**
 * 主动联系是硬约束，不是建议：没到那份上就不许给他发消息。
 * 程序在 outbox 还会再拦一道，这里是让模型别浪费力气写注定发不出去的话。
 */
export function renderContactRule(contact, canMessageUser, userId, forceReply = false) {
  if (canMessageUser) {
    // 回复场景（他直接发来私聊消息）：与 DIALOGUE_CONTRACT 保持一致，必须回，绝不许留空。
    // 不能再给「没话就不发」的退路——否则模型会照那条走、把回复吞掉，聊天就无声断裂。
    // forceReply 只在「意愿门控已判定她要回」的 user 回合传 true。
    if (forceReply) {
      const hint = contact?.text ? `（${contact.text}）` : '';
      return [
        '<这一刻要不要主动找他>',
        `他刚发来消息${hint}，你必须回——哪怕只回「嗯」「？」「hhhh」一个字也行，**绝不许把 utterances 留空**。`,
        '叙事里写的「打字、删改、按了发送」只是过程；你实际说出口的话必须由 utterances 给出，少一条都不行。',
        '发给故事内人物的话照旧可以写（只会写进剧本，不会真的送达）。',
        '</这一刻要不要主动找他>',
      ].join('\n');
    }
    const why = contact?.text ? `你的念头：${contact.text}` : '他刚发了消息，你在回他';
    return [
      '<这一刻要不要主动找他>',
      `可以给他（u:${userId}）发消息，但不是非发不可——要真的有话想说才发，没话就不发。`,
      why,
      // 线上教训（2026-10-28 早）：她主动说「昨天说的事 我都记得」，他问「怎么突然说这个」，
      // 她答不上来——因为那句话本身就是空话。主动开口必须落到具体的一件小事上。
      contact?.text
        ? '**要说就说得具体**：明确是哪件事、哪句话、哪样东西、哪个时刻（「你昨天说怕我着凉」「冰箱里那盒酸奶过期了」这种）。'
          + '绝不许说「昨天的事」「之前聊的那个」「那件事」这种没有内容的空话——他接不住，你下一句也接不住。'
        : '',
      '发给故事内人物的话照旧可以写（只会写进剧本，不会真的送达）。',
    ].filter(Boolean).join('\n');
  }
  return [
    '<这一刻要不要主动找他>',
    `不要给他（u:${userId}）发任何消息。理由：${contact?.reason ?? '这一刻没有想联系他的念头'}。`,
    '你可以在心里想到他、可以想起他说过的话，但不要发出去。utterances 里不许出现收件人是他的条目。',
    '说给故事内人物（室友、同事等）的话照旧照写。',
    '</这一刻要不要主动找他>',
  ].join('\n');
}

export class DialogueNarrator {
  constructor({ store, registry, persona, impressions, timeline, llm = callLLM, stickers = null }) {
    this.store = store;
    this.registry = registry;
    this.persona = persona;
    this.impressions = impressions;
    this.timeline = timeline;
    this.llm = llm;
    this.stickers = stickers;
  }

  /**
   * @param {{worldSummary:string, trigger:string, userId:string, now:number,
   *          recentSays:string[], recentConversation?:string[], stage?:object, maxRevision?:number}} opts
   */
  async run({
    worldSummary, narration = '', trigger, userId, now, recentSays = [], recentConversation = [],
    stage = null, contact = null, canMessageUser = true, maxRevision = 1, requireReply = false,
    pastAnchors = [],
  }) {
    const impression = this.impressions.render(userId);
    const traits = retrieveTraits(this.persona, trigger, 4).map((t) => `${t.key}：${t.text}`).join('\n');
    // 气泡上限与表情政策都从角色卡读（控制台 → 角色卡 → 说话方式）。
    // 以前表情规则在对话契约里另写了一份，关不掉；现在只有 speech.emoji.enabled 一个开关。
    const maxBubbles = Number(stage?.maxBubbles ?? this.persona?.speech?.maxBubbles ?? 3) || 3;
    const emojiOff = this.persona?.speech?.emoji?.enabled === false;
    const faceNames = emojiOff ? [] : availableFaceNames();

    const userParts = [];
    // ================= 第一层：生活（旁白） =================
    // 2026-10-29 重构：以前世界状态、散文、每日记忆、聊天记录平铺在同一个块里，
    // 只靠空行分隔。弱模型分不清「我身边发生的事」和「我该发出去的消息」，
    // 于是把他问「还没喝的嘛」回成了「林夏问我要不要开汽水[表情:困]」——
    // 那是时间轴里的旁白，不是话。现在两层用显式标签隔开，且旁白层不含任何台词。
    userParts.push('<你的生活（旁白层）>');
    userParts.push(worldSummary || renderWorldBlock(this.timeline, now, { includeSays: false, resolveName: nameResolver(this.registry) }));
    if (narration) {
      // 只留最后两段：语感和身体状态够用了，全给会把里面的对话句子带进来
      const narrTail = String(narration).split(/\n+/).filter(Boolean).slice(-2).join('\n');
      if (narrTail) {
        userParts.push('');
        userParts.push('<刚才那几分钟（旁白，读它只为知道自己的状态和口气）>');
        userParts.push(tailCut(narrTail, 260));
        userParts.push('</刚才那几分钟>');
      }
    }
    userParts.push('</你的生活>');
    userParts.push('');
    userParts.push('这一层是你自己过的日子：你在哪、在做什么、谁在你身边、你今天做过什么。');
    userParts.push('它决定了你此刻的心情、累不累、有没有空——但**这一层里没有任何一句话是你要发给他的**，一个句子都不许搬下去。');
    userParts.push('');

    // 他是谁：控制台「用户与关系 → 用户是谁」里填的内容。
    // 这两个字段以前存了没人读，模型只能从对话里猜他是谁，猜出来还常和关系锚点打架。
    try {
      const me = loadUser() ?? {};
      const profile = String(me.profile ?? '').trim();
      const nick = String(me.nickname ?? '').trim();
      if (profile || nick) {
        userParts.push('<他是谁（背景，别把它当新消息复述出来）>');
        if (nick) userParts.push(`你平时叫他：${nick}`);
        if (profile) userParts.push(profile.slice(0, 600));
        userParts.push('</他是谁>');
        userParts.push('');
      }
    } catch { /* 读不到就跳过，不影响这一轮 */ }

    // ================= 第二层：聊天窗口（消息） =================
    // 最近的对话（按时间交错：他一句、她一句）。这是真实发生过的会话记录，
    // 必须作为回应他最新一句的权威依据——不要再凭空假设他在说别的话题。
    if (recentConversation?.length) {
      const batch = renderBatchRule(recentConversation, maxBubbles);
      if (batch) userParts.push(batch, '');
      userParts.push('<你和他的聊天窗口（这一层才是消息）>');
      userParts.push('下面每一行都真的在手机上发生过。[他] 是他发来的，[她] 是你自己发出去的。');
      userParts.push(...recentConversation);
      userParts.push('</你和他的聊天窗口>');
      userParts.push('');
    }
    // 他真实说过的原话：她要引用「上次」「你说过的」，只能来自这里
    userParts.push(renderPastAnchorBlock(pastAnchors), '');
    // 他这句如果是在“接你上一句”（带指代词），就把两句摆在一起逼她接住。
    // 2026-10-28 线上：她主动说「昨天说的事 我都记得」，他问「怎么突然说这个」，
    // 她却回「嗯/刚醒」——上下文里明明有她那句话，但没人要求她接，她只顾着写刚醒的日常。
    const referentBlock = buildReferentBlock(recentConversation);
    if (referentBlock) userParts.push(referentBlock, '');

    // 你最近说过的话（只用于避免把同样的意思再说一遍）
    if (recentSays?.length) {
      userParts.push(renderRecentSays(recentSays, 14));
      userParts.push('');
    }
    // 有标注过的表情包才告诉她可以用
    const stickerBlock = this.stickers?.renderForPrompt?.() ?? '';
    if (stickerBlock) userParts.push(stickerBlock, '');
    // 要不要主动联系他：这是硬约束，不是建议。放在最后，紧挨着触发点。
    userParts.push(renderContactRule(contact, canMessageUser, userId, requireReply));
    userParts.push('');
    userParts.push(trigger);
    if (traits) userParts.push('', `相关特质提醒：${traits}`);

    const messages = [
      { role: 'system', content: systemPrompt({ persona: this.persona, impression, registry: this.registry, stage, hour: localHour(now), userId, maxBubbles, faceNames }) },
      { role: 'user', content: userParts.filter(Boolean).join('\n') },
    ];

    let draft = null;
    let repeats = [];
    let fabricated = [];
    let revisions = 0;
    let lastContent = '';
    const apart = Boolean(this.persona?.geography?.apart);

    for (let attempt = 0; attempt <= maxRevision; attempt += 1) {
      const { json, content } = await this.llm('chat', messages, { jsonMode: true });
      lastContent = content ?? '';
      draft = json;
      const utterances = Array.isArray(draft?.utterances) ? draft.utterances : [];
      const contents = utterances.map((u) => u?.content ?? '');
      repeats = detectRepeat(contents, recentSays);
      fabricated = checkFabricated(contents, pastAnchors, apart);
      if (!repeats.length && !fabricated.length) break;
      revisions += 1;
      messages.push({ role: 'assistant', content: cut(lastContent, 800) });
      const feedback = [];
      if (repeats.length) {
        feedback.push(
          '这些话和最近说过的重复了，不许再说：',
          ...repeats.map((r) => `- 「${r.content}」≈ 之前说过的「${r.matched}」（${r.kind}）`),
        );
      }
      if (fabricated.length) {
        feedback.push(
          '这些话是编的，不许说：',
          ...fabricated.map((f) => (f.kind === 'past'
            ? `- 「${f.text}」——没有这回事。你们之间没有这个约定，也没有这一段过去；他要是没说过，就不许说成「你说过/说好的/上周」`
            : f.kind === 'home'
              ? `- 「${f.text}」——你们各有各的住处，隔着几百公里。不许把他叫回「家」、不许说给他留了饭、不许说等他回来吃；吃饭是各吃各的，想聊就问他吃了没、吃的什么`
              : `- 「${f.text}」——你们不在同一座城市，不存在「一起去/过来/等你下班/楼下见」这种同城的事`)),
          '想提过去，只能引用上面「你们之间真实发生过的过去」里列出的原话；',
          '想他、关心他都可以，但落在异地的方式上（发消息、寄东西、以后有机会再见）。',
        );
      }
      feedback.push('', '重新输出 JSON。');
      messages.push({ role: 'user', content: feedback.join('\n') });
    }

    // 断线防护：这是他直接发来的私聊消息（意愿门控已判定她要回），却一个字都没生成，
    // 绝不能让聊天无声断裂。强制再要一次，至少回一个字。
    let utterances = Array.isArray(draft?.utterances) ? draft.utterances : [];
    if (requireReply && utterances.length === 0) {
      messages.push({ role: 'assistant', content: cut(lastContent, 800) });
      messages.push({
        role: 'user',
        content: [
          '错误：你刚才把 utterances 留空了。',
          `但这是他直接发来的私聊消息，你必须至少回复一个字（如「嗯」「？」「hhhh」或一句自然的话）。`,
          `重新输出 JSON，至少包含一条发给 u:${userId} 的话，绝不许为空数组。`,
        ].join('\n'),
      });
      const retry = await this.llm('chat', messages, { jsonMode: true });
      draft = retry.json ?? draft;
      utterances = Array.isArray(draft?.utterances) ? draft.utterances : [];
      revisions += 1;
      console.log('  [断线防护] 阶段二初次为空，已强制再生成一次');
    }

    // 重写后仍重复：直接丢掉重复的那几条，绝不把重复的话发出去
    const finalRepeats = detectRepeat(utterances.map((u) => u?.content ?? ''), recentSays);
    if (finalRepeats.length) {
      const drop = new Set(finalRepeats.map((r) => r.content));
      utterances = utterances.filter((u) => !drop.has(u?.content ?? ''));
    }

    // 重写后仍在编：假的过去、同城约会一律不发（宁可少一条，也不能让假约定落地）
    const finalFabricated = checkFabricated(utterances.map((u) => u?.content ?? ''), pastAnchors, apart);
    if (finalFabricated.length) {
      const drop = new Set(finalFabricated.map((f) => f.text));
      utterances = utterances.filter((u) => !drop.has(u?.content ?? ''));
      console.log(`  [真实性拦截] 丢弃 ${finalFabricated.length} 条：${finalFabricated.map((f) => f.text).join(' / ')}`);
      // 他发的消息必须回：过滤到空就说一句最安全的话，宁短也不编，也不能无声断裂
      if (requireReply && !utterances.length) {
        utterances = [{ id: 'fallback', addresseeId: `u:${userId}`, content: '嗯' }];
      }
    }

    // 台词归位：utterances 只装「发到他手机上」的话。对林夏、陈哥说的属于剧本，
    // 世界阶段已经写过；留在队列里只会被出站守卫拦下、白白占掉本该给他的回复额度。
    // 2026-10-29 线上：全天 utterances 里一多半收件人是 c:chenge（面馆/午饭那几轮），
    // 日志上「拦截=1/2」全是这个，他那边看到的回复量就少了一半。
    const castIds = new Set(this.registry.fictionalCast().map((a) => a.id));
    const isCastLine = (u) => castIds.has(String(u?.addresseeId ?? '').trim());
    const castLines = utterances.filter(isCastLine);
    if (castLines.length) {
      utterances = utterances.filter((u) => !isCastLine(u));
      console.log(`  [台词归位] ${castLines.length} 条对故事内人物说的话不入出站队列：${castLines.map((u) => String(u?.content ?? '').slice(0, 12)).join(' / ')}`);
      // 他要回的话不能被这些台词挤没
      if (requireReply && !utterances.length) {
        utterances = [{ id: 'fallback', addresseeId: `u:${userId}`, content: '嗯' }];
      }
    }

    // 收件人兜底：模型偶尔会把占位符「对方QQ号 / 对方 / 他」当 addresseeId 写进去，
    // 这种未注册 id 会被出站守卫拦掉、回复直接丢失。这里把明显的占位符矫正成真实的 u:userId。
    const knownActors = new Set([...this.registry.fictionalCast().map((a) => a.id), `u:${userId}`]);
    const PLACEHOLDER = /对方|QQ号|占位|^\s*他\s*$|^\s*你\s*$/;
    let normalized = 0;
    for (const u of utterances) {
      const aid = String(u.addresseeId ?? '').trim();
      if (!knownActors.has(aid) && (PLACEHOLDER.test(aid) || !/^(u:|c:)/.test(aid))) {
        u.addresseeId = `u:${userId}`;
        normalized += 1;
      }
    }
    if (normalized) console.log(`  [收件人矫正] ${normalized} 条占位符已映射到 u:${userId}`);

    // 纯应答气泡：真人在聊天里也会先「嗯」一声再补一句，但那是在连续打字；
    // 拆成两个气泡发出来，读起来就像机器人在逐条确认。只在后面还有话时删掉它。
    if (utterances.length > 1) {
      const PURE_ACK = /^[\s。，！？~～…]*[嗯哦啊噢唔额诶欸哈嘿哼]{1,3}[\s。，！？~～…]*$/;
      const kept = utterances.filter((u) => !PURE_ACK.test(String(u?.content ?? '')));
      if (kept.length && kept.length < utterances.length) {
        console.log(`  [应答合并] 去掉 ${utterances.length - kept.length} 条单独的「嗯」类气泡`);
        utterances = kept;
      }
    }

    // 表情兜底：角色卡里关掉了表情，模型不听话写了也要剥干净。
    // 2026-10-29：她说「得看我起不起得来」后面跟个 [表情:酷]、「你也是」后面跟 [表情:抱拳]，
    // 场合全是错的——不是频率问题，是这类引擎对「什么时候该配哪个表情」根本没有判断力。
    if (emojiOff) {
      let stripped = 0;
      for (const u of utterances) {
        const before = String(u?.content ?? '');
        const after = before
          .replace(/\[(?:表情|贴纸)[:：][^\]]*\]/g, '')
          .replace(/\[[\u4e00-\u9fa5a-zA-Z]{1,4}\]/g, '')
          .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu, '')
          .replace(/[ \t]{2,}/g, ' ')
          .trim();
        if (after !== before) { u.content = after; stripped += 1; }
      }
      utterances = utterances.filter((u) => String(u?.content ?? '').trim());
      if (stripped) console.log(`  [表情剥离] ${stripped} 条里的表情已去掉（角色卡：不发表情）`);
      // 她可能整条只发了一个表情——剥完就空了，他那边会什么都收不到
      if (requireReply && !utterances.length) {
        utterances = [{ id: 'fallback', addresseeId: `u:${userId}`, content: '嗯' }];
      }
    }

    // 气泡数上限：连发一条对一条是这里收住的最后一道。
    // 模型多写几句不奇怪，全发出去就变成「他发 2 条、她发 4 条」的问答机。
    if (utterances.length > maxBubbles) {
      console.log(`  [气泡上限] ${utterances.length} → ${maxBubbles} 条`);
      utterances = utterances.slice(0, maxBubbles);
    }

    return {
      utterances,
      impressionDelta: draft?.impressionDelta ?? null,
      repeats: finalRepeats,
      revisions,
    };
  }
}
