// 配置加载与保存。磁盘落 data/config.json，控制台可在线改并立即生效。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const DATA_DIR = process.env.MOYING_DATA_DIR || path.join(ROOT, 'data');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

/** 三套模型路由的默认值。chat=对话气泡/story=剧本/vision=识图 */
function defaultApi(over = {}) {
  return {
    baseUrl: '',
    apiKey: '',
    model: '',
    temperature: 0.9,
    maxTokens: 1024,
    timeoutMs: 60000,
    ...over,
  };
}

export function defaultConfig() {
  return {
    onebot: {
      wsUrl: 'ws://snowluma:3001',
      httpUrl: 'http://snowluma:3000',
      accessToken: '',
      heartbeat: 'auto',
    },
    api: {
      chat: defaultApi({ temperature: 0.9, maxTokens: 300, timeoutMs: 30000 }),
      story: defaultApi({ temperature: 0.8, maxTokens: 4000, timeoutMs: 120000 }),
      vision: defaultApi({ temperature: 0.3, maxTokens: 800, timeoutMs: 60000 }),
    },
    // 机器人自己的 QQ 号（连上后由 get_login_info 自动回填）
    selfId: '',
    // 允许对话的真实用户白名单；空表示所有私聊都接
    allowedUsers: [],
    story: {
      // 自动推进（独立生活演化）间隔，分钟；0 关闭。默认 12 分钟——
      // 隔太久故事会断层，隔太密又容易写成流水账；10~15 分钟是「过日子」的节奏
      autoAdvanceMinutes: 12,
      autoAdvanceJitter: 3,
      // 世界事件播种扫描间隔，分钟；0 关闭
      seedIntervalMinutes: 60,
      seedJitterMinutes: 15,
      timezone: 'Asia/Shanghai',
      // 硬矛盾重试次数，超过则由程序强制修正
      maxRevision: 2,
    },
    // 主动联系：她会不会在过自己日子的时候突然想找他说话（HDS 的 Urge 对应物）
    urge: {
      enabled: true,
      // 主动找过他之后隔多久才可能再想找他（分钟）
      cooldownMinutes: 45,
      // 多久没联系会开始惦记（分钟）
      missAfterMinutes: 360,
    },
    // 回复门控：不是每条消息都回（参考 HDS 的 willingness 模型）
    reply: {
      preset: 'normal', // normal | quiet | warm
      enabled: true,
      // 以下可不填，按 preset 走；想微调再写
      threshold: null,
      replyCost: null,
      probabilityAmplifier: null,
      minDelayMs: null,
      maxDelayMs: null,
    },
    // 发送限流：一分钟最多发多少字/多少条
    rate: {
      maxCharsPerMinute: 40,
      maxMessagesPerMinute: 6,
      windowMs: 60000,
      maxWaitMs: 150000,
    },
    console: {
      port: 3210,
      token: '',
    },
  };
}

// 原型污染防线：JSON.parse 会产出 own property「__proto__」（与对象字面量不同），
// 而 out[k] = v 的方括号赋值会触发 Object.prototype 的 __proto__ setter，
// 把 out 的原型整个换掉。这三个键一律跳过。
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (typeof base !== 'object' || Array.isArray(base)) return patch ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (UNSAFE_KEYS.has(k)) continue;
    out[k] = k in base && typeof base[k] === 'object' && !Array.isArray(base[k]) && v && typeof v === 'object' && !Array.isArray(v)
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

let cached = null;

export function loadConfig() {
  if (cached) return cached;
  const base = defaultConfig();
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    cached = deepMerge(base, raw);
  } catch {
    cached = base;
  }
  return cached;
}

export function saveConfig(patch) {
  const next = deepMerge(loadConfig(), patch);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  cached = next;
  return next;
}

/** 让外部改动（控制台写盘）后能重新读到最新值 */
export function invalidateConfig() {
  cached = null;
}

export { ROOT };
