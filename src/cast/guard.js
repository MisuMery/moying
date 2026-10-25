// 出站守卫：唯一决定「这句话发给谁」的地方。
//
// 三重保障，任一层都能拦住「说给虚构角色的话发给真实用户」：
//   1. 类型层   —— FictionalActor.deliverable 是 false 字面量且不可写（actors.js）
//   2. 地址层   —— resolveEndpoint 对 fictional 返回 null：它没有地址，物理上不存在投递路径
//   3. 守卫层   —— OutboundGuard.authorize：每条出站必须带 addresseeId，虚构角色一律拒绝并记账
//
// 这套设计不依赖模型「记得写对」。模型写错也只是生成一条被拒绝的记录，
// 并拿到 UndeliverableAddressee 回抛，下一轮它会改成叙述文体（她对室友说……）。

import { ActorKind } from './actors.js';

/**
 * 唯一的地址解析函数：Actor → 可投递端点，或 null。
 * 虚构角色走到这里必然是 null —— 不是抛错，是「没有这个地址」。
 * @returns {{transport:'onebot_private'|'onebot_group', targetId:string}|null}
 */
export function resolveEndpoint(actor) {
  if (!actor) return null;
  if (actor.kind === ActorKind.FICTIONAL || actor.kind === ActorKind.SELF) return null;
  const eps = actor.endpoints ?? [];
  if (eps.length) return eps[0];
  if (actor.kind === ActorKind.REAL_USER && actor.userId) {
    return { transport: 'onebot_private', targetId: String(actor.userId) };
  }
  if (actor.kind === ActorKind.REAL_GROUP && actor.groupId) {
    return { transport: 'onebot_group', targetId: String(actor.groupId) };
  }
  return null;
}

export class UndeliverableAddressee extends Error {
  constructor(message, { utteranceId, addresseeId }) {
    super(message);
    this.name = 'UndeliverableAddressee';
    this.utteranceId = utteranceId;
    this.addresseeId = addresseeId;
  }
}

export class OutboundGuard {
  /**
   * @param {{registry: import('./actors.js').ActorRegistry, ledger: {record:Function}}} deps
   */
  constructor({ registry, ledger }) {
    this.registry = registry;
    this.ledger = ledger;
  }

  /**
   * 判定一条话语能否出站。
   * @param {{id?:string, addresseeId:string, content:string}} utterance
   * @returns {{ok:true, endpoint:object, actor:object} | {ok:false, reason:string, code:string}}
   */
  authorize(utterance) {
    const { addresseeId, content, id } = utterance ?? {};
    if (!addresseeId) {
      return { ok: false, code: 'MISSING_ADDRESSEE', reason: '出站话语缺少 addresseeId（拒绝回落到默认收件人）' };
    }
    const actor = this.registry.get(addresseeId);
    if (!actor) {
      return { ok: false, code: 'UNKNOWN_ACTOR', reason: `收件人未注册: ${addresseeId}` };
    }
    if (actor.kind === ActorKind.FICTIONAL) {
      // 虚构角色：记录并拒绝。把原因回抛给叙事层，让它改写为叙述文体。
      this.ledger?.record?.({
        utteranceId: id ?? null,
        addresseeId,
        addresseeName: actor.displayName,
        status: 'blocked_fictional',
        content: String(content ?? '').slice(0, 200),
        reason: '虚构角色没有投递地址，这句话只应写进剧本',
      });
      return {
        ok: false,
        code: 'UNDELIVERABLE_ADDRESSEE',
        reason: `「${actor.displayName}」是故事内人物，不能投递；请改写为叙述文体（她对他/她说……）`,
      };
    }
    const endpoint = resolveEndpoint(actor);
    if (!endpoint) {
      return { ok: false, code: 'NO_ENDPOINT', reason: `收件人 ${actor.displayName} 没有可用端点` };
    }
    return { ok: true, endpoint, actor };
  }

  /** 批量授权，返回可发送清单 + 被拦清单（被拦的用于回抛叙事层） */
  authorizeAll(utterances) {
    const deliverable = [];
    const blocked = [];
    for (const u of utterances ?? []) {
      const verdict = this.authorize(u);
      if (verdict.ok) deliverable.push({ utterance: u, endpoint: verdict.endpoint, actor: verdict.actor });
      else blocked.push({ utterance: u, code: verdict.code, reason: verdict.reason });
    }
    return { deliverable, blocked };
  }
}
