// 有界响应体读取（供普通 fetch / Response 调用点复用）。
//
// 背景：多处 `await res.text()` / `await res.json()` 只设了超时、没有字节上限 —— 上游返回
// 超大或畸形响应时，单次调用就能把常驻进程读爆（OOM 后 systemd 拉起，会话与正在进行的批次全丢）。
// safe-fetch.js 里的 readBounded 是绑在它自有 http.request 流程上的私有实现，不能直接给这些
// fetch 调用点复用，所以在这里抽出一份等价能力：**边读边计数，超限立刻取消流并抛错**，
// 绝不先把整个 body 读进来再判断长度（那样上限就形同虚设）。
//
// 返回值只在未超限时给出完整内容；超限一律抛 code === 'BODY_TOO_LARGE' 的错误，
// 而不是截断后静默返回半截内容（截断会让调用方把残缺数据当成完整数据使用）。

/**
 * 构造超限错误。message 带上限与实际读到的字节数，便于定位是哪个上游返回了多大响应。
 * @param {number} maxBytes 配置的字节上限。
 * @param {number} bytesRead 已读到的字节数。
 * @returns {Error & { code: 'BODY_TOO_LARGE' }}
 */
function bodyTooLargeError(maxBytes, bytesRead) {
  const error = new Error(`上游响应过大：超过 ${maxBytes} 字节上限（已读到 ${bytesRead} 字节），已中断读取`);
  error.code = 'BODY_TOO_LARGE';
  return error;
}

/** 取出可作为流读取的响应体（Node 18+ 的 fetch Response 都带 ReadableStream）。 */
function bodyStreamOf(res) {
  const body = res?.body;
  if (body && typeof body.getReader === 'function') return body;
  if (body && typeof body[Symbol.asyncIterator] === 'function') return body;
  return null;
}

/**
 * 一个块的字节数。
 *
 * ⚠️ 别直接写 `chunk.byteLength`（2026-10-09 复核）：拿到字符串或没有 byteLength 的对象时
 * 它是 `undefined`，`total += undefined` → `NaN`，而 `NaN > limit` **恒为假** —— 整个上限就
 * 静默失效了。真实 fetch 的 body reader 只吐 Uint8Array，所以生产上不会爆；但本模块的卖点
 * 就是"上限真的在生效"，它自己的退路分支（异步迭代器 / text()）也都能接住字符串，
 * 主路径不该是反着来的。
 */
function chunkByteLength(chunk) {
  if (typeof chunk === 'string') return Buffer.byteLength(chunk, 'utf8');
  const n = chunk?.byteLength;
  return Number.isFinite(n) ? n : Buffer.byteLength(String(chunk ?? ''), 'utf8');
}

/**
 * 有界读取响应文本。
 *
 * 优先走 res.body 的 reader（或异步迭代器）逐块累计字节数，一旦超过 maxBytes 立即
 * `reader.cancel()` 取消底层流并抛错，不再继续读取。只有 res.body 不可用时（老运行时、
 * 测试桩）才退回 `res.text()` / `res.json()` 整体读取，并在之后按字节数校验。
 *
 * @param {Response|{ body?: ReadableStream, text?: Function, json?: Function }} res 响应对象。
 * @param {number} maxBytes 字节上限；超过即抛 `code === 'BODY_TOO_LARGE'`（不截断）。
 * @returns {Promise<string>} 未超限时的完整文本。
 */
export async function readTextBounded(res, maxBytes) {
  const limit = Math.max(1, Math.floor(Number(maxBytes) || 1));
  const body = bodyStreamOf(res);

  // getReader 本身也可能抛：流已被别的 reader 锁住、或已被 text()/json() 消费过。
  // 放在 try 里，抛了就当作“没有可用的流”往下跑到 text()/json() 退路 ——
  // 否则逸出的是一句裸 TypeError，而不是本模块承诺的 BODY_TOO_LARGE 或退路行为（审查指出）。
  let reader = null;
  // 拿不到 reader 时，流也可能是**被锁住**的（被别的 reader 占着，或已被 text()/json() 消费）。
  // 那种情况下 for-await 一样会抛，所以连流退路也一并跳过，直接走 text()/json() 退路。
  let streamUsable = Boolean(body);
  if (body && typeof body.getReader === 'function') {
    try {
      reader = body.getReader();
    } catch {
      reader = null;
      streamUsable = false;
    }
  }

  if (reader) {
    const decoder = new TextDecoder();
    let total = 0;
    let text = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += chunkByteLength(value);
        if (total > limit) {
          // 先取消底层流再抛：别让上游继续吐数据占住连接和内存。
          await reader.cancel().catch(() => { /* 取消失败不影响已判定的超限 */ });
          throw bodyTooLargeError(limit, total);
        }
        // 字符串块不进 TextDecoder：decode 只吃 BufferSource，传字符串会直接抛 TypeError
        text += typeof value === 'string' ? value : decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      return text;
    } finally {
      // 正常读完（done）后释放读锁，避免 body 一直被占住。
      try { reader.releaseLock(); } catch { /* 已取消/已释放 */ }
    }
  }

  if (body && streamUsable && typeof body[Symbol.asyncIterator] === 'function') {
    // 退化实现：只有异步迭代器，没有 getReader。
    // 判 asyncIterator 而不是 Boolean(body)：`{}` 这类既没有 getReader 也不是异步可迭代的
    // 桩对象，`for await` 会逸出裸 TypeError —— 那是本模块承诺之外的行为（2026-10-09 审查）。
    // 不可迭代时落到下面的 text()/json() 退路。
    const decoder = new TextDecoder();
    let total = 0;
    let text = '';
    for await (const chunk of body) {
      const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.byteLength;
      total += bytes;
      if (total > limit) {
        try { await body.return?.(); } catch { /* 取消失败不掩盖超限错误 */ }
        throw bodyTooLargeError(limit, total);
      }
      text += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    }
    return text + decoder.decode();
  }

  // 退路：老运行时或测试桩没有可流的 body —— 只能整体读出后再按字节数校验。
  // 真实 fetch Response 走不到这里；测试桩通常只提供 text()/json()。
  if (typeof res?.text === 'function') {
    const text = await res.text();
    const bytes = Buffer.byteLength(String(text), 'utf8');
    if (bytes > limit) throw bodyTooLargeError(limit, bytes);
    return String(text);
  }
  if (typeof res?.json === 'function') {
    // 连 text() 都没有的桩：取回对象再序列化回文本，长度校验同样生效。
    const text = JSON.stringify(await res.json());
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > limit) throw bodyTooLargeError(limit, bytes);
    return text;
  }
  throw new Error('响应对象没有可读取的 body/text/json');
}

/**
 * 有界读取并解析 JSON：先有界读文本，再 `JSON.parse`。
 *
 * 超限行为与 readTextBounded 完全一致（抛 `code === 'BODY_TOO_LARGE'`）；
 * JSON 语法错误仍由 `JSON.parse` 抛 SyntaxError，调用方按各自原有文案处理即可。
 *
 * @param {Response|{ body?: ReadableStream, text?: Function, json?: Function }} res 响应对象。
 * @param {number} maxBytes 字节上限。
 * @returns {Promise<any>} 解析后的 JSON 值。
 */
export async function readJsonBounded(res, maxBytes) {
  return JSON.parse(await readTextBounded(res, maxBytes));
}

/**
 * 有界读取响应字节（Buffer）。给"拿二进制体"的调用点用（图片、音频等）。
 *
 * 与 readTextBounded 同一条纪律：边读边计数，超限立即取消流并抛
 * `code === 'BODY_TOO_LARGE'`，绝不先 `arrayBuffer()` 整包读入再判长度
 * —— 那样上限形同虚设（2026-10-09 审查：pollinations / tts-openai 等
 * 都是"读完再判 > 8MiB"，上游畸形响应照样能把进程读爆）。
 *
 * @param {Response|{ body?: ReadableStream, arrayBuffer?: Function }} res 响应对象。
 * @param {number} maxBytes 字节上限；超过即抛 `code === 'BODY_TOO_LARGE'`（不截断）。
 * @returns {Promise<Buffer>} 未超限时的完整字节。
 */
export async function readBytesBounded(res, maxBytes) {
  const limit = Math.max(1, Math.floor(Number(maxBytes) || 1));
  const body = bodyStreamOf(res);

  let reader = null;
  if (body && typeof body.getReader === 'function') {
    try {
      reader = body.getReader();
    } catch {
      reader = null;
    }
  }

  if (reader) {
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += chunkByteLength(value);
        if (total > limit) {
          await reader.cancel().catch(() => { /* 取消失败不影响已判定的超限 */ });
          throw bodyTooLargeError(limit, total);
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    } finally {
      try { reader.releaseLock(); } catch { /* 已取消/已释放 */ }
    }
  }

  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let total = 0;
    for await (const chunk of body) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
      total += buf.byteLength;
      if (total > limit) {
        try { await body.return?.(); } catch { /* 取消失败不掩盖超限错误 */ }
        throw bodyTooLargeError(limit, total);
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  }

  // 退路：老运行时或测试桩没有可流的 body —— 只能整体读出后再按字节数校验。
  if (typeof res?.arrayBuffer === 'function') {
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > limit) throw bodyTooLargeError(limit, buffer.length);
    return buffer;
  }
  throw new Error('响应对象没有可读取的 body/arrayBuffer');
}
