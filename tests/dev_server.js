/**
 * 开发用：不装插件也能把进度服务跑起来。
 *
 * 平时服务是由 DSH 加载插件时自动起的（index.js 的 apply）。这个脚本用一套最小的
 * 假 ctx 把它单独拉起来，方便：
 *   · 改 server.js / board.js 之后立刻对着 http://127.0.0.1:8791/ 看效果
 *   · 不想装插件、只要看板页
 *   · 排查「服务到底起没起」
 *
 *   node tests/dev_server.js
 *   node tests/dev_server.js --dir D:\some\where\.dsh-progress --port 9000
 *
 * 注意：它和插件起的服务是**两个实例**。同时开着的话，后起的那个会往后挪端口，
 * 而悬浮窗只认先探到的那个（8791 起）。调试时记得把另一个关掉。
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { progressDir } from '../server.js';

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const dir = argOf('--dir') ? path.resolve(argOf('--dir')) : progressDir();
const port = Number(argOf('--port')) || undefined;

const mod = await import(pathToFileURL(path.resolve('index.js')).href);

const cleanups = [];
mod.apply({
  logger: {
    info: (m) => console.log(String(m)),
    warn: (m) => console.warn(String(m)),
    error: (m) => console.error(String(m)),
  },
  effect: (fn) => { const d = fn(); if (typeof d === 'function') cleanups.push(d); },
  inject: (services, cb) => cb({}),        // 开发环境没有 systemPrompt，正好也验证这条路不炸
  get: () => undefined,
}, port ? { dir, port } : { dir });

console.log(`\n开发服务已启动。进度目录：${dir}`);
console.log('看板页在服务打印的地址上（默认 http://127.0.0.1:8791/）。Ctrl+C 停止。\n');

const stop = () => {
  for (const fn of cleanups) { try { fn(); } catch { /* 无所谓 */ } }
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
