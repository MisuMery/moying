// 表情库：她自己收集、也会用的表情包。
//
// 参考 qq-agent-plus 的 sticker-manager：每张图带一句 desc（画的是什么/适合什么场合）
// 和若干 tags，对话模型看着这份清单决定什么时候甩一张出来。
// 标注交给视觉模型（vision 路由），平时对话走 chat 路由。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

const FILE = path.join(DATA_DIR, 'stickers.json');
export const STICKER_DIR = path.join(DATA_DIR, 'stickers');

export const MAX_DESC = 80;
export const MAX_TAGS = 20;

function ensureDir() {
  fs.mkdirSync(STICKER_DIR, { recursive: true });
}

/** 只允许「stickers 目录内的纯文件名」：剥掉路径、拒绝特殊字符 */
function sanitizeFileName(name) {
  const base = path.basename(String(name ?? '').trim());
  if (!base || base === '.' || base === '..') return '';
  if (!/^[-\w\u4e00-\u9fa5][-.\w\u4e00-\u9fa5]*\.(png|jpg|jpeg|gif|webp)$/i.test(base)) return '';
  return base;
}

export class StickerStore {
  constructor() {
    this.data = this.#load();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      const list = Array.isArray(raw) ? raw : (raw?.stickers ?? []);
      return { stickers: list };
    } catch {
      return { stickers: [] };
    }
  }

  #save() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(this.data, null, 2), 'utf8');
  }

  /** 每次读都重新加载，保证引擎进程能立刻看到控制台导入/标注的结果 */
  #reload() {
    this.data = this.#load();
    return this.data;
  }

  all() {
    return this.#reload().stickers;
  }

  get(id) {
    return this.#reload().stickers.find((s) => s.id === id) ?? null;
  }

  /**
   * 入库一张图。
   * @param {{file:string, desc?:string, tags?:string[], source?:string, dataBase64?:string}} input
   */
  add(input) {
    ensureDir();
    let file = sanitizeFileName(input.file);
    // 直接给了图片数据：落盘到 stickers 目录
    if (!file && input.dataBase64) {
      const ext = String(input.mime ?? 'image/png').includes('jpeg') ? 'jpg' : 'png';
      file = `sticker_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
      fs.writeFileSync(path.join(STICKER_DIR, file), Buffer.from(String(input.dataBase64).split(',').pop() ?? '', 'base64'));
    }
    const entry = {
      id: input.id ?? `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      file,
      desc: String(input.desc ?? '').slice(0, MAX_DESC),
      tags: (Array.isArray(input.tags) ? input.tags : []).map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, MAX_TAGS),
      source: input.source ?? 'console',
      createdAt: new Date().toISOString(),
    };
    this.data.stickers.push(entry);
    this.#save();
    return entry;
  }

  /** 视觉模型标注后回填描述与标签 */
  annotate(id, { desc, tags }) {
    const s = this.get(id);
    if (!s) return null;
    if (desc !== undefined) s.desc = String(desc ?? '').slice(0, MAX_DESC);
    if (tags !== undefined) s.tags = (Array.isArray(tags) ? tags : []).map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, MAX_TAGS);
    s.annotatedAt = new Date().toISOString();
    this.#save();
    return s;
  }

  remove(id) {
    const before = this.data.stickers.length;
    this.data.stickers = this.data.stickers.filter((s) => s.id !== id);
    this.#save();
    return this.data.stickers.length < before;
  }

  /** 绝对路径（发送时读取） */
  absolutePath(entry) {
    if (!entry?.file) return null;
    // 只认 stickers 目录内的文件名：绝不接受绝对路径或带 ../ 的，
    // 否则一条 file:"/etc/passwd" 的记录就能把整台机器的文件读走
    const safe = sanitizeFileName(entry.file);
    if (!safe) return null;
    const p = path.join(STICKER_DIR, safe);
    return fs.existsSync(p) ? p : null;
  }

  /** 给对话模型的清单（只给有描述的，避免塞一堆看不懂的图） */
  renderForPrompt(limit = 12) {
    const usable = this.data.stickers.filter((s) => s.desc || s.tags?.length).slice(-limit);
    if (!usable.length) return '';
    return [
      '<可用的表情包（想用就在话里写 [贴纸:id]，一次最多一张，别刷屏）>',
      ...usable.map((s) => `- ${s.id}：${s.desc || s.tags.join('/')}`),
      '</可用的表情包>',
    ].join('\n');
  }
}
