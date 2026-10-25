// 入口：连 SnowLuma、收私聊、跑叙事引擎、定时自动推进。
import { loadConfig } from './config.js';
import { loadPersona, buildRegistry } from './persona/card.js';
import { createRealUser } from './cast/actors.js';
import { ImpressionStore } from './persona/impression.js';
import { Store } from './store.js';
import { Engine } from './narrator/engine.js';
import { OneBotClient, segmentsToText, extractMediaFromSegments } from './onebot/onebot.js';
import { refreshFaceCatalog } from './onebot/face-catalog.js';
import { isRouteReady } from './llm/gateway.js';
import { startConsole } from './api/console.js';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function main() {
  const config = loadConfig();
  const persona = loadPersona();
  if (!persona) {
    log('[致命] 缺少角色卡 data/persona.json，先建角色卡再启动');
    process.exit(1);
  }
  if (!isRouteReady('story')) {
    log('[警告] story 路由未配置完整，收到消息时无法生成（控制台可填）');
  }

  const store = new Store();
  const impressions = new ImpressionStore();
  const registry = buildRegistry(persona, { selfId: config.selfId });
  for (const uid of config.allowedUsers ?? []) {
    registry.register(createRealUser({ userId: String(uid) }));
  }

  const client = new OneBotClient({
    wsUrl: config.onebot.wsUrl,
    httpUrl: config.onebot.httpUrl,
    accessToken: config.onebot.accessToken,
    heartbeat: config.onebot.heartbeat,
    onEvent: (frame) => { handleEvent(frame).catch((e) => log('[事件处理出错]', e?.message ?? e)); },
  });

  const engine = new Engine({ client, store, persona, registry, impressions, config });

  async function handleEvent(frame) {
    if (frame?.post_type !== 'message') return;
    if (frame.message_type !== 'private') return; // MVP 只做私聊
    const selfId = String(client.selfId ?? config.selfId ?? '');
    const senderId = String(frame.sender?.user_id ?? frame.user_id ?? '');
    if (!senderId || (selfId && senderId === selfId)) return; // 不回自己
    if ((config.allowedUsers ?? []).length && !config.allowedUsers.map(String).includes(senderId)) return;

    const text = (await segmentsToText(frame.message ?? [], { selfId })).trim();
    // 图片要单独提出来给视觉模型看（segmentsToText 里只留了 [图片] 占位）
    const images = extractMediaFromSegments(frame.message ?? [])
      .filter((m) => m.kind === 'image')
      .map((m) => ({ url: m.url, file: m.file }));
    if (!text && !images.length) return;
    log(`[收到] ${senderId}: ${text.slice(0, 40)}${images.length ? `（+${images.length} 图）` : ''}`);

    try {
      const result = await engine.handleUserMessage({
        userId: senderId,
        text,
        images,
        displayName: frame.sender?.nickname ?? '',
        messageId: frame.message_id ?? null,
      });
      if (result.replied === false) {
        log(`[不回] ${result.asleep ? '她在睡觉' : `意愿不足(${result.reason})`} p=${result.probability}`);
      } else {
        log(`[排队] ${Math.round(result.delayMs / 1000)}s 后回复（积压 ${result.queued} 条${result.merged ? '，已合并' : ''}）`);
      }
    } catch (error) {
      log('[处理失败]', error?.message ?? error);
    }
  }

  client.onStatus(({ connected }) => {
    if (connected) {
      log('[已连接] OneBot');
      refreshFaceCatalog(client).then((added) => {
        if (added) log('[表情] 已从协议端补齐表情目录');
      }).catch(() => {});
      if (!config.selfId && client.selfId) {
        log(`[登录] QQ ${client.selfId}（可写入配置 selfId）`);
      }
    } else {
      log('[断开] OneBot，等待重连');
    }
  });

  await client.connect();

  // 自动推进：独立生活回合，走与用户回合完全相同的校验路径。
  // 间隔每轮都重读配置——控制台改了不用重启就能生效；关掉时仍保持轮询，方便再打开。
  {
    const scheduleNext = () => {
      const cfg = loadConfig();
      const minutes = Number(cfg.story?.autoAdvanceMinutes ?? 12);
      if (minutes <= 0) { setTimeout(scheduleNext, 60000); return; }
      const jitter = Number(cfg.story?.autoAdvanceJitter ?? 3);
      const delay = (minutes + (Math.random() * 2 - 1) * jitter) * 60000;
      setTimeout(async () => {
        try {
          const r = await engine.runAutoAdvance({ now: Date.now() });
          if (!r?.skipped) {
            log(`[自动推进] 事件 ${r.committed?.length ?? 0} 条 / 发送 ${r.delivery?.sent?.length ?? 0} 条`);
          }
        } catch (error) {
          log('[自动推进失败]', error?.message ?? error);
        }
        scheduleNext();
      }, delay);
    };
    scheduleNext();
    log(`[自动推进] 已启动，间隔约 ${Number(config.story?.autoAdvanceMinutes ?? 12)}±${Number(config.story?.autoAdvanceJitter ?? 3)} 分钟`);
  }

  // 世界事件播种：让她的世界自己会动（不依赖用户参与）
  const seedMinutes = Number(config.story?.seedIntervalMinutes ?? 60);
  if (seedMinutes > 0) {
    const jitter = Number(config.story?.seedJitterMinutes ?? 15);
    const scheduleSeed = () => {
      const delay = (seedMinutes + (Math.random() * 2 - 1) * jitter) * 60000;
      setTimeout(async () => {
        try {
          const r = await engine.seeder.sweep({});
          if (r.error) log('[播种失败]', r.error);
          if (r.count) log(`[播种] 新增 ${r.count} 条外部事件`);
          for (const x of r.rejected ?? []) log('  [播种剔除]', x.summary, '—', x.reason);
          for (const s of engine.seeder.drainDue({})) log('  [世界事件]', s.summary);
        } catch (error) {
          log('[播种异常]', error?.message ?? error);
        }
        scheduleSeed();
      }, delay);
    };
    scheduleSeed();
    log(`[世界播种] 已启动，间隔约 ${seedMinutes}±${jitter} 分钟`);
  }

  // 控制台
  const port = Number(config.console?.port ?? 3210);
  startConsole({ port, engine, client, store, registry, impressions, persona });
  log(`[控制台] http://0.0.0.0:${port}`);
}

main().catch((error) => {
  console.error('[启动失败]', error);
  process.exit(1);
});
