// 角色注册表：真实用户 / 群 / 虚构角色 / 主角本人，全部是一等实体。
//
// 这是对 HDS 最关键的反转之一：在 HDS 里虚构角色（室友、同事）只是 supportingCast 的
// 一段自由文本，不是实体，于是「她对室友说的一句话」没有地方记录接收者，
// 最终被默认绑给了当前真实参与者 —— 说给室友的话发到了真实用户手机上。
// 这里把它们建成和真实用户平级的实体，只是 deliverable 恒为 false。

export const ActorKind = {
  SELF: 'self',
  REAL_USER: 'real_user',
  REAL_GROUP: 'real_group',
  FICTIONAL: 'fictional',
};

/**
 * @typedef {Object} Actor
 * @property {string} id          稳定标识，如 'self' / 'u:10001' / 'g:123' / 'c:roommate'
 * @property {string} kind        ActorKind 之一
 * @property {string} displayName 展示名
 * @property {boolean} deliverable 是否可能拥有投递地址（虚构角色恒 false）
 */

/**
 * 虚构角色：deliverable 在构造时被锁死为 false，且不可被外部覆盖。
 * 这是三重保障的第一层（类型/构造层）—— 想给它地址也写不进去。
 */
export function createFictional({ id, displayName, relation = '', notes = '', presence = null }) {
  const actor = {
    id: `c:${id}`,
    kind: ActorKind.FICTIONAL,
    displayName,
    relation,
    notes,
    // presence.places: 这个角色可能出现在哪些地点（不填表示不限制）
    // presence.remoteOnly: 只能远程联系（如远居老家的父母）
    presence,
    deliverable: false,
  };
  Object.defineProperty(actor, 'deliverable', { value: false, writable: false, enumerable: true });
  return actor;
}

export function createRealUser({ userId, displayName = '', endpoints = [] }) {
  return {
    id: `u:${userId}`,
    kind: ActorKind.REAL_USER,
    displayName: displayName || String(userId),
    userId: String(userId),
    endpoints,
    deliverable: true,
  };
}

export function createRealGroup({ groupId, displayName = '' }) {
  return {
    id: `g:${groupId}`,
    kind: ActorKind.REAL_GROUP,
    displayName: displayName || String(groupId),
    groupId: String(groupId),
    endpoints: [{ transport: 'onebot_group', targetId: String(groupId) }],
    deliverable: true,
  };
}

export function createSelf({ userId, displayName }) {
  return {
    id: 'self',
    kind: ActorKind.SELF,
    displayName,
    userId: String(userId || ''),
    endpoints: [],
    deliverable: false, // 主角自己不是收件人
  };
}

export class ActorRegistry {
  constructor() {
    /** @type {Map<string, Actor>} */
    this.actors = new Map();
  }

  register(actor) {
    if (!actor?.id) throw new Error('Actor 缺少 id');
    this.actors.set(actor.id, actor);
    return actor;
  }

  registerAll(list) {
    for (const a of list) this.register(a);
  }

  get(id) {
    return this.actors.get(id) ?? null;
  }

  require(id) {
    const a = this.get(id);
    if (!a) throw new Error(`未注册的 Actor: ${id}`);
    return a;
  }

  byKind(kind) {
    return [...this.actors.values()].filter((a) => a.kind === kind);
  }

  /** 按展示名找角色（模型常把「室友」「主角」直接写进 actors，用这个归位） */
  findByName(name) {
    const n = String(name ?? '').trim();
    if (!n) return null;
    for (const a of this.actors.values()) {
      if (a.displayName === n) return a;
    }
    // 「她」只能是自己
    if (n === '她' || n === '她自己') return this.actors.get('self') ?? null;
    return null;
  }

  /** 虚构角色列表（注入提示词时用） */
  fictionalCast() {
    return this.byKind(ActorKind.FICTIONAL);
  }

  toJSON() {
    return [...this.actors.values()];
  }
}
