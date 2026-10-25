// 时间工具：统一用 Asia/Shanghai，内部一律 ISO 字符串，比较前转毫秒。
import { loadConfig } from '../config.js';

export function timezone() {
  return loadConfig()?.story?.timezone || 'Asia/Shanghai';
}

/** 当前时间的毫秒时间戳 */
export function nowMs() {
  return Date.now();
}

/** 毫秒 → ISO（带时区偏移） */
export function toISO(ms) {
  return new Date(ms).toISOString();
}

/** ISO/Date → 毫秒；非法返回 NaN */
export function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const t = Date.parse(String(value ?? ''));
  return Number.isFinite(t) ? t : NaN;
}

/** 毫秒 → 本地时区的 HH:mm */
export function fmtClock(ms, tz = timezone()) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ms));
}

/** 毫秒 → 本地日期 YYYY-MM-DD */
export function fmtDate(ms, tz = timezone()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

/** 毫秒 → 本地小时数（0-23），用于作息窗口判断 */
export function localHour(ms, tz = timezone()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ms));
  const h = parts.find((p) => p.type === 'hour')?.value ?? '0';
  return Number(h) % 24;
}

/** 毫秒 → 星期几（0=周日），用于工作日判断 */
export function localWeekday(ms, tz = timezone()) {
  // 用 en-CA 的日期 + Date 构造避免时区漂移
  const dateStr = fmtDate(ms, tz);
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 把「时:分」拼到某个本地日期上，返回毫秒。用于作息窗口边界 */
export function atLocalHour(ms, hour, minute = 0, tz = timezone()) {
  const dateStr = fmtDate(ms, tz);
  // 以 UTC 正午为锚反解该本地日期对应的 UTC 偏移
  const probe = Date.parse(`${dateStr}T12:00:00Z`);
  const offset = (() => {
    const shown = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(probe));
    const [sh, sm] = shown.split(':').map(Number);
    return (sh * 60 + sm) - (12 * 60);
  })();
  return Date.parse(`${dateStr}T00:00:00Z`) + (hour * 60 + minute - offset) * 60000;
}
