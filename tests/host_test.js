/**
 * 插件入口（index.js）的集成测试。
 *
 * 用一套假的 ctx 把 apply() 真跑起来，验证三件事：
 *   1. 它确实起了进度服务，而且接口能通
 *   2. 它往系统提示词里塞了正确的说明（含真实路径）
 *   3. 卸载时服务被关掉（ctx.effect 的清理函数真的挂了东西）
 *
 *   node tests/host_test.js
 *
 * 没能覆盖的：DSH 真实的插件加载器会不会允许 `node:http`。
 * 这一点靠官方同款实现背书 —— @deepseek-ai/dsh-host-webserver 就是这么干的
 * （createServer + ctx.effect 关服务）。
 */

import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

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

/** 一个够用的假 ctx：记录 effect 的清理函数、inject 的处理器、logger 的输出。 */
function fakeCtx() {
  const cleanups = [];
  const logs = [];
  const injected = [];
  return {
    cleanups, logs, injected,
    ctx: {
      logger: {
        info: (m) => logs.push(['info', String(m)]),
        warn: (m) => logs.push(['warn', String(m)]),
        error: (m) => logs.push(['error', String(m)]),
      },
      effect: (fn) => {
        const dispose = fn();
        if (typeof dispose === 'function') cleanups.push(dispose);
        return () => {};
      },
      inject: (services, cb) => {
        injected.push({ services, cb });
      },
      get: () => undefined,
    },
  };
}

async function main() {
  console.log('\n== 插件入口（index.js）集成测试 ==');

  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-host-'));
  // 用一个高位端口段，避开真在跑的 8791
  const startPort = await freePort();
  const mod = await import(pathToFileURL(path.resolve('index.js')).href);
  ok(typeof mod.apply === 'function', 'index.js 导出了 apply');

  const { ctx, cleanups, logs, injected } = fakeCtx();
  mod.apply(ctx, { dir, port: startPort });

  // 等服务起来
  let base = null;
  for (let i = 0; i < 50 && !base; i++) {
    for (let p = startPort; p < startPort + 10; p++) {
      try {
        const r = await fetch(`http://127.0.0.1:${p}/api/health`);
        if (r.ok) { base = `http://127.0.0.1:${p}`; break; }
      } catch { /* 还没起来 */ }
    }
    if (!base) await new Promise((r) => setTimeout(r, 100));
  }

  ok(!!base, 'apply() 之后服务自己起来了（用户不需要手动启动）', base || '没起来');
  try {
    if (base) {
      const health = await (await fetch(base + '/api/health')).json();
      eq(health.ok, true, '/api/health 可用');
      eq(path.resolve(health.dir), path.resolve(dir), '服务读的是 apply 传进来的目录');

      const tasks = await (await fetch(base + '/api/tasks')).json();
      eq(tasks.tasks, [], '空目录时返回空列表');
    }

    console.log('\n-- 系统提示词 --');
    eq(injected.length, 1, '向 ctx.inject 声明了依赖');
    eq(injected[0].services, ['systemPrompt'], '依赖的是 systemPrompt');
    ok(typeof injected[0].cb === 'function', 'inject 回调拿到了上下文');

    const sections = [];
    injected[0].cb({
      systemPrompt: {
        section: (opts) => { sections.push(opts); return () => {}; },
        getSectionOrder: (k) => 100 + k.length,
      },
    });
    eq(sections.length, 1, '注册了一段提示词');
    const sec = sections[0] || {};
    eq(sec.name, 'dsh-progress-panel:usage', '提示词 section 名字');
    ok(typeof sec.order === 'number', '带了 order（跟随宿主既有 section 排序）', String(sec.order));
    ok(sec.text.includes(dir), '提示词里写了真实的进度目录', dir);
    ok(sec.text.includes('from progress import Progress'), '告诉了 Agent Python 的用法');
    ok(sec.text.includes('sys.path.insert'), '给出了 Python 的 sys.path 写法');
    ok(sec.text.includes('progress.mjs'), '告诉了 Agent Node 助手的路径');
    ok(/import \{ Progress \} from ".*progress\.mjs"/.test(sec.text), 'Node 那行是可以直接抄的 import');
    ok(sec.text.length < 900, '提示词够短（不白占上下文）', sec.text.length + ' 字符');
    ok(!/hub\.py/.test(sec.text), '没再提已经删掉的 hub.py');

    console.log('\n-- 缺 systemPrompt 服务时不炸 --');
    const bare = fakeCtx();
    bare.ctx.inject = (services, cb) => cb({});     // 拿到一个没有 systemPrompt 的上下文
    let threw = false;
    try { mod.apply(bare.ctx, { dir, port: await freePort() }); } catch { threw = true; }
    ok(!threw, '没有 systemPrompt 服务的 profile 里也能正常激活');
    await Promise.all(bare.cleanups.map((fn) => Promise.resolve().then(fn).catch(() => {})));

    console.log('\n-- 卸载 --');
    eq(cleanups.length, 1, 'ctx.effect 注册了一个清理函数');
    await Promise.all(cleanups.map((fn) => Promise.resolve().then(fn).catch(() => {})));
    await new Promise((r) => setTimeout(r, 150));
    let stillUp = false;
    if (base) {
      try { await fetch(base + '/api/health'); stillUp = true; } catch { /* 已经关了 */ }
    }
    ok(!stillUp, '清理之后服务确实关掉了（不会泄漏端口）');

    console.log('\n-- 日志 --');
    const infos = logs.filter(([lvl]) => lvl === 'info').map(([, m]) => m);
    ok(infos.some((m) => m.includes('进度服务')), '启动时打了一行可读的 info 日志', infos[0] || '(没有)');
    ok(infos.some((m) => m.includes(dir)), '日志里带上了进度目录，方便排查');
  } finally {
    await Promise.all(cleanups.map((fn) => Promise.resolve().then(fn).catch(() => {})));
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${fail === 0 ? '全部通过' : '存在失败'}：${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('× 测试自身异常：', e); process.exit(1); });
