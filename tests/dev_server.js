/**
 * 开发用：不装插件也能把进度接口跑起来。
 *
 * 正式运行时，路由是插件的 Host 半边挂到 DSH 自己的 webserver 上的
 * （`index.js` 里 `ctx.inject(['webServer'], ...)`）。
 * 这个脚本用一套最小的假 ctx 把它单独拉起来，方便：
 *   · 改 server.js / board.js 之后立刻对着页面看效果
 *   · 不想装插件、只要一个本地看板
 *   · 排查「路由到底挂没挂上」
 *
 *   node tests/dev_server.js
 *   node tests/dev_server.js --dir D:\some\where\.dsh-progress --port 8791
 *
 * 注意：它监听自己的端口（默认 8791），和 DSH 那个 webserver 是两回事。
 * 这只是给开发时一个能直接打开的 URL —— 生产路径完全不经过它。
 */

import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROUTE_PATH, progressDir } from '../server.js';

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const dir = argOf('--dir') ? path.resolve(argOf('--dir')) : progressDir();
const port = Number(argOf('--port')) || 8791;

// 收集假 webServer 上注册的路由
const routes = [];
const logger = {
  info: (m) => console.log(String(m)),
  warn: (m) => console.warn(String(m)),
  error: (m) => console.error(String(m)),
};
const effect = (fn) => { fn(); };
// 注入回调拿到的是**继承了 ctx 全部能力**的上下文（官方代码里就用 webCtx.effect），
// 所以这里也要把 logger/effect 一并给过去。
const withService = (extra) => Object.assign({ logger, effect }, extra);

const fakeCtx = {
  logger,
  effect,
  inject: (services, cb) => {
    if (services.includes('webServer')) {
      cb(withService({
        webServer: {
          host: '127.0.0.1',
          register: (route) => { routes.push(route); return () => {}; },
        },
      }));
      return;
    }
    cb(withService({}));            // 没有 systemPrompt，正好也验证这条路不炸
  },
  get: () => undefined,
};

const mod = await import(pathToFileURL(path.resolve('index.js')).href);
mod.apply(fakeCtx, { dir });

const route = routes.find((r) => r.path === ROUTE_PATH);
if (!route) {
  console.error('没有注册出路由，检查 index.js 的 apply');
  process.exit(1);
}

// 最小复刻 webserver 的前缀派发：pathname === prefix 或 prefix + '/'
createServer((req, res) => {
  const pathname = new URL(req.url || '/', 'http://x').pathname;
  if (pathname !== ROUTE_PATH && !pathname.startsWith(ROUTE_PATH + '/')) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  Promise.resolve(route.handler(req, res)).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
}).listen(port, '127.0.0.1', () => {
  console.log(`\n开发服务已启动： http://127.0.0.1:${port}${ROUTE_PATH}`);
  console.log(`  进度目录： ${dir}`);
  console.log('  Ctrl+C 停止\n');
});
