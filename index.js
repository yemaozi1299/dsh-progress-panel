/**
 * Host 半边 —— 往宿主的 webserver 上注册一条只读路由，并告诉 Agent 该怎么上报进度。
 *
 * 这里做两件事：
 *   1. 把进度接口挂到 DSH 自己那个 webserver 上（`ctx.inject(['webServer'], ...)`）。
 *      不占端口、没有额外进程、同源所以不需要 CORS。DSH 起来它就在，DSH 关掉它就没。
 *   2. 往系统提示词里加一段，让 Agent 知道「跑长任务时该上报进度、往哪写、用哪个助手」。
 *      这段只解决**生产端**约定；服务端由宿主生命周期管，不靠 Agent 拉起来。
 *
 * 关路由挂在 `ctx.effect` 上（和官方 `client-connection` 注册 /api 路由是同一写法），
 * 卸载插件或重载 profile 时会自动摘掉。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROUTE_PATH, createProgressHandler, ensureDir, progressDir } from './server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 只认这几种「本机」写法；其它一律当成对外暴露。 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

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
 * @param config - 可选配置：`dir`（进度目录）。
 */
export function apply(ctx, config) {
  const dir = progressDir(config || {});
  ensureDir(dir);
  const log = ctx.logger;

  // 路由：挂到宿主的 webserver 上。
  ctx.inject(['webServer'], (webCtx) => {
    const server = webCtx && webCtx.webServer;
    if (!server || typeof server.register !== 'function') {
      if (log) log.warn('[progress-panel] 这个 profile 里没有 webServer，进度接口没挂上');
      return;
    }

    // 无鉴权，所以只在「只绑本机」时才安心。绑了 0.0.0.0 就提醒一句。
    try {
      const host = server.host;
      if (host && !LOOPBACK.has(String(host)) && log) {
        log.warn(`[progress-panel] webserver 绑在 ${host} 上，而 ${ROUTE_PATH} 是无鉴权的：`
                 + '任务名和日志尾巴对该网络可见。要么把 host 改回 127.0.0.1，'
                 + '要么别在不可信网络里开着。');
      }
    } catch { /* host 读不到就算了，不影响注册 */ }

    webCtx.effect(() => {
      try {
        return server.register({
          kind: 'prefix',
          path: ROUTE_PATH,
          handler: createProgressHandler(dir, log),
        });
      } catch (err) {
        // register 在路径重复时会抛。绝不能因此把插件（甚至 DSH）带崩。
        if (log) log.warn(err instanceof Error ? err : new Error(String(err)));
        return () => {};
      }
    }, 'dsh-progress-panel: /api/progress route');

    if (log) log.info(`[progress-panel] 进度接口已挂在 ${ROUTE_PATH}（进度目录 ${dir}）`);
  });

  // 提示词：可选依赖，没有 systemPrompt 服务的 profile 里照样跑。
  ctx.inject(['systemPrompt'], (promptCtx) => {
    const sysPrompt = promptCtx && promptCtx.systemPrompt;
    if (!sysPrompt || typeof sysPrompt.section !== 'function') return;
    const opts = { name: 'dsh-progress-panel:usage', text: promptText(dir) };
    if (typeof sysPrompt.getSectionOrder === 'function') {
      opts.order = sysPrompt.getSectionOrder('DELIVERABLE_FILE_REFERENCES');
    }
    sysPrompt.section(opts);
  });
}
