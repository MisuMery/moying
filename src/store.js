// 持久化：JSONL 追加写 + 全量读。
// 数据量很小（一天几十条事件），JSONL 比 SQLite 更好审、更好备份，控制台直接读。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { sortEventsByTime } from './world/time.js';

export class JsonlStore {
  constructor(file) {
    this.file = path.join(DATA_DIR, file);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, '', 'utf8');
  }

  append(obj) {
    const line = JSON.stringify(obj);
    fs.appendFileSync(this.file, `${line}\n`, 'utf8');
    return obj;
  }

  load() {
    const out = [];
    for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        out.push(JSON.parse(s));
      } catch { /* 跳过坏行，不让它拖垮启动 */ }
    }
    return out;
  }

  /** 只保留最后 n 条（用于裁剪过大的文件） */
  trimKeep(n) {
    const all = this.load();
    if (all.length <= n) return all.length;
    fs.writeFileSync(this.file, `${all.slice(-n).map((x) => JSON.stringify(x)).join('\n')}\n`, 'utf8');
    return n;
  }
}

export class Store {
  constructor() {
    this.events = new JsonlStore('events.jsonl');
    this.ledger = new JsonlStore('ledger.jsonl');
    this.turns = new JsonlStore('turns.jsonl');
    this.seq = 0;
  }

  nextId(prefix = 'e') {
    this.seq += 1;
    return `${prefix}_${Date.now().toString(36)}_${this.seq}`;
  }

  /** 追加世界事件（已通过校验） */
  appendEvent(event) {
    // id 放展开之后：调用方显式传 id: undefined 时也不会把生成的号覆盖掉
    const rec = { ...event, id: event?.id ?? this.nextId('e'), recordedAt: new Date().toISOString() };
    this.events.append(rec);
    return rec;
  }

  appendEvents(list) {
    return list.map((e) => this.appendEvent(e));
  }

  /**
   * 读全部事件，**按 at 升序**返回。
   * 文件是追加写，行序不等于时间序（见 world/time.js 的 sortEventsByTime），
   * 所有「取最近 N 条」「取最后一条」的调用都依赖这里排好序——
   * 排序放在最上游一处，比在每个调用点各自排序更不容易漏。
   */
  loadEvents() {
    return sortEventsByTime(this.events.load());
  }

  /** 投递账本：每条出站/被拦的记录 */
  recordLedger(entry) {
    const rec = { id: this.nextId('l'), at: new Date().toISOString(), ...entry };
    this.ledger.append(rec);
    return rec;
  }

  loadLedger() {
    return this.ledger.load();
  }

  recordTurn(entry) {
    return this.turns.append({ id: this.nextId('t'), at: new Date().toISOString(), ...entry });
  }
}
