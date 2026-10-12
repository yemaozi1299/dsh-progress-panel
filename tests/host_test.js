/**
 * 插件入口（index.js）的集成测试。
 *
 * 用一套假的 ctx 把 apply() 真跑起来，验证四件事：
 *   1. 它确实往宿主的 webServer 上注册了路由，而且接口能通
 *   2. 它往系统提示词里塞了正确的说明（含真实路径）
 *   3. 卸载时路由被摘掉（ctx.effect 的清理真的挂了东西）
 *   4. 异常路径不会把 DSH 带崩：没有 webServer、路径撞车、host 不是本机
 *
 *   node tests/host_test.js
 *
 * 覆盖不到的一点：真实 webserver 的 `register` 是否完全按我预期的签名工作。
 * 这一点靠官方同款实现背书 —— `client-connection` 就是用
 * `ctx.inject(['webServer'], (webCtx) => webCtx.effect(() => webCtx.webServer.register(route)))`
 * 注册它的 /api 路由的（packages/client/connection/src/index.ts:139）。
 */

import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { ROUTE_PATH } from '../server.js';

let pass = 0, fail = 0;
const eq = (a, b, label) => {
  if (JSON.stringify(a) === JSON.stringify(b)) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  × ${label}\n      期望 ${JSON.stringify(b)}\n      实际 ${JSON.stringify(a)}`); }
};
const ok = (c, label, d) => {
  if (c) { pass++; console.log(`  ✓ ${label}${d ? '  —— ' + d : ''}`); }
  else { fail++; console.log(`  × ${label}${d ? '  —— ' + d : ''}`); }
};

const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

/**
 * 一个够用的假 ctx。
 * `webServer` 只有 register/host 两样东西 —— 正是 index.js 用到的全部。
 */
function fakeCtx({ host = '127.0.0.1', duplicateRoute = false, withWebServer = true,
                   registerThrows = false } = {}) {
  const cleanups = [];
  const logs = [];
  const routes = [];
  const sections = [];
  const injected = [];

  const webServer = {
    host,
    register(route) {
      if (registerThrows) throw new Error('webserver: duplicate prefix route "' + route.path + '"');
      if (duplicateRoute) throw new Error('webserver: duplicate prefix route "' + route.path + '"');
      routes.push(route);
      return () => {
        const i = routes.indexOf(route);
        if (i >= 0) routes.splice(i, 1);
      };
    },
  };

  const logger = {
    info: (m) => logs.push(['info', String(m)]),
    warn: (m) => logs.push(['warn', String(m)]),
    error: (m) => logs.push(['error', String(m)]),
  };
  const effect = (fn) => {
    const dispose = fn();
    if (typeof dispose === 'function') cleanups.push(dispose);
    return () => {};
  };

  // 注入回调拿到的上下文是**继承了 ctx 全部能力**的（官方代码里就用
  // `webCtx.effect(...)`），所以这里也要把 effect/logger 一并给过去。
  const withService = (extra) => Object.assign({ logger, effect }, extra);

  const ctx = {
    logger,
    effect,
    inject: (services, cb) => {
      injected.push(services.join(','));
      if (services.includes('webServer')) {
        if (!withWebServer) return;          // 服务一直没来 → 回调不该被调用
        cb(withService({ webServer }));
        return;
      }
      if (services.includes('systemPrompt')) {
        cb(withService({
          systemPrompt: {
            section: (opts) => { sections.push(opts); return () => {}; },
            getSectionOrder: (k) => 100 + k.length,
          },
        }));
        return;
      }
      cb(withService({}));
    },
    get: () => undefined,
  };

  return { cleanups, logs, routes, sections, injected, ctx };
}

const runCleanups = async (cleanups) => {
  await Promise.all(cleanups.splice(0).map((fn) => Promise.resolve().then(fn).catch(() => {})));
};

async function main() {
  console.log('\n== 插件入口（index.js）集成测试 ==');

  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-host-'));
  const mod = await import(pathToFileURL(path.resolve('index.js')).href);
  ok(typeof mod.apply === 'function', 'index.js 导出了 apply');

  /* ---------------------------------------------------------------- 正常路径 */
  const f = fakeCtx();
  mod.apply(f.ctx, { dir });

  console.log('\n-- 注册路由 --');
  eq(f.injected.sort(), ['systemPrompt', 'webServer'], '声明了两个可选服务依赖');
  eq(f.routes.length, 1, '注册了 1 条路由');
  const route = f.routes[0] || {};
  eq(route.kind, 'prefix', '是 prefix 路由');
  eq(route.path, ROUTE_PATH, '路径是 /api/progress');
  eq(typeof route.handler, 'function', 'handler 是个函数');
  eq(f.cleanups.length, 1, 'ctx.effect 注册了 1 个清理函数');
  ok(f.logs.some(([l, m]) => l === 'info' && m.includes('/api/progress')),
     '打了一行 info 说明挂在哪', (f.logs.find(([l]) => l === 'info') || [])[1] || '');
  ok(!f.logs.some(([l]) => l === 'warn'), '正常路径下没有警告');

  console.log('\n-- 路由真的能通 --');
  const server = createServer((req, res) => {
    Promise.resolve(route.handler(req, res)).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  const port = await freePort();
  await new Promise((res) => server.listen(port, '127.0.0.1', res));
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await (await fetch(base + ROUTE_PATH + '/health')).json();
    eq(health.ok, true, '/health 可用');
    eq(path.resolve(health.dir), path.resolve(dir), '读的是 apply 传进来的目录');
    const tasks = await (await fetch(base + ROUTE_PATH + '/tasks')).json();
    eq(tasks.tasks, [], '空目录时返回空列表');
    const board = await (await fetch(base + ROUTE_PATH)).text();
    ok(board.includes('进度看板'), '根路径返回看板页');
  } finally {
    server.close();
    server.closeAllConnections?.();
  }

  console.log('\n-- 系统提示词 --');
  eq(f.sections.length, 1, '注册了一段提示词');
  const sec = f.sections[0] || {};
  eq(sec.name, 'dsh-progress-panel:usage', 'section 名字');
  ok(typeof sec.order === 'number', '带了 order（跟随宿主既有 section 排序）', String(sec.order));
  ok(sec.text.includes(dir), '写了真实的进度目录', dir);
  ok(sec.text.includes('from progress import Progress'), '告诉了 Agent Python 的用法');
  ok(sec.text.includes('sys.path.insert'), '给出了 Python 的 sys.path 写法');
  ok(sec.text.includes('progress.mjs'), '告诉了 Agent Node 助手的路径');
  ok(/import \{ Progress \} from ".*progress\.mjs"/.test(sec.text), 'Node 那行可以直接抄');
  ok(sec.text.length < 900, '够短（不白占上下文）', sec.text.length + ' 字符');
  ok(!/hub\.py/.test(sec.text), '没再提已经删掉的 hub.py');

  console.log('\n-- 卸载 --');
  await runCleanups(f.cleanups);
  eq(f.routes.length, 0, '清理之后路由被摘掉了（不会留下悬空路由）');

  /* ---------------------------------------------------------------- 异常路径 */
  console.log('\n-- 没有 webServer 的 profile --');
  const noWs = fakeCtx({ withWebServer: false });
  let threw = false;
  try { mod.apply(noWs.ctx, { dir }); } catch { threw = true; }
  ok(!threw, '不抛异常（插件安静地不激活这条路）');
  eq(noWs.routes.length, 0, '没有注册任何路由');
  ok(noWs.sections.length === 1, '提示词那部分照常工作');

  console.log('\n-- 路由路径撞车 --');
  const dup = fakeCtx({ duplicateRoute: true });
  threw = false;
  try { mod.apply(dup.ctx, { dir }); } catch { threw = true; }
  ok(!threw, 'register 抛异常时 apply 不跟着炸（绝不能把 DSH 带崩）');
  ok(dup.logs.some(([l, m]) => l === 'warn' && m.includes('duplicate')),
     '把冲突记成一条警告', (dup.logs.find(([l]) => l === 'warn') || [])[1] || '');

  console.log('\n-- host 不是本机时的告警 --');
  const exposed = fakeCtx({ host: '0.0.0.0' });
  mod.apply(exposed.ctx, { dir });
  const warns = exposed.logs.filter(([l]) => l === 'warn').map(([, m]) => m);
  ok(warns.some((m) => m.includes('0.0.0.0')), '绑 0.0.0.0 时警告数据会外露', warns[0] || '(没有警告)');
  ok(warns.some((m) => m.includes('无鉴权')), '说清了原因（这条路由不带鉴权）');
  await runCleanups(exposed.cleanups);

  const localhost = fakeCtx({ host: '127.0.0.1' });
  mod.apply(localhost.ctx, { dir });
  ok(!localhost.logs.some(([l]) => l === 'warn'), '绑 127.0.0.1 时不吵');
  await runCleanups(localhost.cleanups);

  await rm(dir, { recursive: true, force: true }).catch(() => {});
  console.log(`\n${fail === 0 ? '全部通过' : '存在失败'}：${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('× 测试自身异常：', e); process.exit(1); });
