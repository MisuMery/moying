// 世界设定：她活在一个什么样的世界里，以及这段生活要写成什么样。
//
// 两块内容，职责不重叠：
//   1) 世界设定（preset / custom / description）—— 时代、地点、世界长什么样
//   2) 故事要求（storyRequirement）—— 这段生活要按什么标准写
// 季节不再单独配置：默认档由真实日期推导，自定义档写在自己的时代里。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, loadConfig } from '../config.js';

const WORLD_PATH = path.join(DATA_DIR, 'world.json');

/** 默认档：就是现实世界，时间与地点跟着真实世界走 */
export const PRESET_DEFAULT = 'default';
/** 自定义档：时代、地点由用户填写（可以是架空世界） */
export const PRESET_CUSTOM = 'custom';

export const DEFAULT_STORY_REQUIREMENT =
  '当代现实主义生活剧。主角拥有丰富、具体且持续变化的个人生活；配角也有各自的节奏、立场与情绪。'
  + '关系在日常互动和小事件中缓慢发展，生活常常留下未完成但真实感的余波。';

export const DEFAULT_WORLD = {
  preset: PRESET_DEFAULT,
  custom: { era: '', location: '' },
  description:
    '一个和现实一致的普通都市：有加班、房租、外卖、通勤、追剧，也有楼下装修、天气突变、快递延误这类小事。'
    + '没有超自然力量，没有戏剧化的巧合。',
  storyRequirement: DEFAULT_STORY_REQUIREMENT,
  seedTopics: [],
  seedDensity: { perDayMin: 1, perDayMax: 4, highPerDay: 1, singleMax: 2 },
};

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 由月份推季节（北半球） */
export function seasonOf(month) {
  const m = Number(month);
  if (m >= 3 && m <= 5) return '春';
  if (m >= 6 && m <= 8) return '夏';
  if (m >= 9 && m <= 11) return '秋';
  return '冬';
}

/** 默认档的时代：真实世界的当前日期 + 季节（季节从这里来，不再单独配置） */
export function realWorldEra(now = Date.now(), timeZone = 'Asia/Shanghai') {
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short',
  });
  const p = {};
  for (const part of fmt.formatToParts(new Date(now))) p[part.type] = part.value;
  const month = Number(p.month);
  // zh-CN 下 weekday 通常是「周六」这种，少数环境给单个汉字
  const rawWd = String(p.weekday ?? '').trim();
  const idx = ['日', '一', '二', '三', '四', '五', '六'].indexOf(rawWd.replace(/^周/, ''));
  const weekday = /^周/.test(rawWd) ? rawWd : (idx >= 0 ? WEEK[idx] : '');
  return `${p.year} 年 ${month} 月 ${Number(p.day)} 日${weekday ? `（${weekday}）` : ''} · ${seasonOf(month)}季`;
}

/** 默认档的地点：就是现实世界 */
export const DEFAULT_LOCATION = '现实世界，与真实地理、真实城市一致（主角所在城市以角色卡为准）';

/** 把可能来自旧版本的字段归位，保证读出来的结构永远一致 */
function normalize(raw) {
  const w = { ...DEFAULT_WORLD, ...(raw ?? {}) };
  const src = raw ?? {};
  // 旧版本把 era / location 放在顶层 → 归入 custom，并据此判断档位
  const legacyEra = typeof src.era === 'string' ? src.era : '';
  const legacyLoc = typeof src.location === 'string' ? src.location : '';
  const custom = { era: '', location: '', ...(src.custom ?? {}) };
  if (!custom.era) custom.era = legacyEra;
  if (!custom.location) custom.location = legacyLoc;
  w.custom = custom;
  if (w.preset !== PRESET_CUSTOM) {
    w.preset = (custom.era || custom.location) ? PRESET_CUSTOM : PRESET_DEFAULT;
  }
  // 已经废弃的字段不再保留（世界描述与世界规则合并为 description）
  for (const k of ['type', 'name', 'environment', 'rules', 'era', 'location']) delete w[k];
  // 故事要求留空 = 用默认那套（控制台「恢复默认」就是把这里清空）
  if (!String(w.storyRequirement ?? '').trim()) w.storyRequirement = DEFAULT_STORY_REQUIREMENT;
  return w;
}

export function loadWorld() {
  try {
    return normalize(JSON.parse(fs.readFileSync(WORLD_PATH, 'utf8')));
  } catch {
    return { ...DEFAULT_WORLD, custom: { ...DEFAULT_WORLD.custom } };
  }
}

export function saveWorld(value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const next = normalize({ ...(loadWorld()), ...(value ?? {}) });
  fs.writeFileSync(WORLD_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/**
 * 解出最终生效的时代与地点。
 * - default 档：时代由真实时间推导（含季节），地点就是现实世界
 * - custom 档：用用户填的；填空的项退回默认档写法
 */
export function resolveWorld(world = loadWorld(), now = Date.now()) {
  const w = normalize(world);
  const tz = loadConfig()?.story?.timezone ?? 'Asia/Shanghai';
  if (w.preset === PRESET_CUSTOM) {
    return {
      preset: PRESET_CUSTOM,
      era: w.custom?.era?.trim() || realWorldEra(now, tz),
      location: w.custom?.location?.trim() || DEFAULT_LOCATION,
      description: w.description ?? '',
    };
  }
  return {
    preset: PRESET_DEFAULT,
    era: realWorldEra(now, tz),
    location: DEFAULT_LOCATION,
    description: w.description ?? '',
  };
}

/** 注入世界阶段的提示词块（恒定注入，不参与裁剪） */
export function renderWorldSetting(world = loadWorld(), now = Date.now()) {
  const r = resolveWorld(world, now);
  const lines = ['<世界设定>'];
  lines.push(`时代：${r.era}`);
  lines.push(`地点：${r.location}`);
  if (r.description) lines.push(`世界描述：${r.description}`);
  lines.push('</世界设定>');
  return lines.join('\n');
}

/** 故事要求：这段生活要写成什么样（恒定注入，与世界观分开，便于单独改） */
export function renderStoryRequirement(world = loadWorld()) {
  const w = normalize(world);
  const text = String(w.storyRequirement ?? '').trim() || DEFAULT_STORY_REQUIREMENT;
  return [
    '<故事要求（这段生活必须写成这样）>',
    text,
    '据此落笔：她自己有事在做，配角不是背景板，进展靠小事累积，收尾允许留白。',
    '</故事要求>',
  ].join('\n');
}

/** 播种器取材用的主题池 */
export function seedTopics(world = loadWorld()) {
  return Array.isArray(world?.seedTopics) ? world.seedTopics : [];
}

export function seedDensity(world = loadWorld()) {
  return { ...DEFAULT_WORLD.seedDensity, ...(world?.seedDensity ?? {}) };
}
