/**
 * Host 半边 —— 起本地进度服务，顺便告诉 Agent 该怎么上报进度。
 *
 * 这里做两件事：
 *   1. 在 DSH 的 Node 进程里起一个只读的本地 HTTP 服务（server.js），
 *      端口 8791~8800 里挑一个空的。DSH 起来它就在，DSH 关掉它就没
 *      —— 用户不需要手动启动任何东西。
 *   2. 往系统提示词里加一段，让 Agent 知道「跑长任务时该上报进度、往哪写、用哪个助手」。
 *      这段只解决**生产端**约定；服务端不靠 Agent 拉起来。
 */

import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  BASE_PORT, createHubServer, ensureDir, listenOnFreePort, progressDir,
} from './server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';

/** 注入给 Agent 的说明。刻意写得短——系统提示词是要占上下文的。 */
function promptText(dir) {
  const hub = path.join(HERE, 'hub');
  const mjs = path.join(hub, 'progress.mjs').replace(/\\/g, '/');
  return [
    '本机装了「进度面板」插件：DSH 界面右下角会实时显示长任务的进度。',
    `进度目录：${dir}`,
    '预计跑超过约 30 秒的任务，请按下面的方式上报进度，用户就能自己看，不用反复问你：',
    '  · Python：',
    `      import sys; sys.path.insert(0, r"${hub}")`,
    '      from progress import Progress',
    '  · Node：',
    `      import { Progress } from ${JSON.stringify(mjs)}`,
    '  用 with / close 正确收尾（正常结束、失败、Ctrl+C 都要有终态），title 用简短的中文业务名。',
    '  协议细节见该插件目录下的 hub/README.md。',
  ].join('\n');
}

/**
 * @param ctx - Host 插件上下文。
 * @param config - 可选配置：`port`（起始端口）、`dir`（进度目录）。
 */
export function apply(ctx, config) {
  const cfg = config || {};
  const dir = progressDir(cfg);
  ensureDir(dir);

  const log = ctx.logger;
  const server = createHubServer(dir, log);

  // 起服务。失败也不能把 DSH 拖下去——看不到进度是小事，DSH 起不来是大事。
  const startPort = Number.isFinite(cfg.port) ? Number(cfg.port) : BASE_PORT;
  listenOnFreePort(server, HOST, startPort).then(
    (port) => {
      try {
        writeFileSync(path.join(dir, 'hub.json'), JSON.stringify({
          url: `http://${HOST}:${port}/`, host: HOST, port, pid: process.pid,
          updated_at: Date.now() / 1000,
        }));
      } catch { /* 纯排查用，写不了无所谓 */ }
      if (log) log.info(`[progress-panel] 进度服务 http://${HOST}:${port}/  目录 ${dir}`);
    },
    (err) => {
      if (log) log.warn(err instanceof Error ? err : new Error(String(err)));
    },
  );

  // 关服务挂到插件生命周期上：卸载插件、profile 重载都会走到这里。
  ctx.effect(() => () => {
    try { server.close(); } catch { /* 还没 listen */ }
    try { server.closeAllConnections?.(); } catch { /* 老 Node 没有 */ }
  });

  // 提示词是可选依赖：没有 systemPrompt 服务的 profile 里，服务照样跑。
  const addPrompt = (sysPrompt) => {
    if (!sysPrompt || typeof sysPrompt.section !== 'function') return;
    const opts = { name: 'dsh-progress-panel:usage', text: promptText(dir) };
    if (typeof sysPrompt.getSectionOrder === 'function') {
      opts.order = sysPrompt.getSectionOrder('DELIVERABLE_FILE_REFERENCES');
    }
    sysPrompt.section(opts);
  };

  if (typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], (sctx) => addPrompt(sctx && sctx.systemPrompt));
  } else if (typeof ctx.get === 'function') {
    addPrompt(ctx.get('systemPrompt'));
  }
}
