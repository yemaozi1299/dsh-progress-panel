/**
 * 进度服务 —— 跑在 DSH 的 Node 进程里，不需要任何外部进程。
 *
 * 早先的版本是个独立的 Python 小服务，要用户自己双击启动，这个对发布来说太鸡肋了：
 * 装个插件还要再管一个进程，忘了起就什么都看不到。
 * 现在服务直接长在插件的 Host 半边里，DSH 启动它就启动，DSH 关掉它就关掉
 * —— 这本来就是对的，DSH 不在也没有面板可看。
 *
 * 官方也是这么做的：`@deepseek-ai/dsh-host-webserver` 就是个 Host 插件，
 * 用 `node:http` 的 createServer 起服务，再用 `ctx.effect` 把关闭挂到生命周期上。
 *
 * 接口刻意和原来那个 Python 中枢保持一致（4 个只读端点），
 * 所以 client.js 一行都不用改。
 */

import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { BOARD_HTML } from './board.js';

export const BASE_PORT = 8791;
export const PORT_SPAN = 10;          // 8791~8800，客户端也在这段里探
const STALE_AFTER = 120;              // 秒；超过这么久没更新算「疑似卡住」

/** 只有本机页面才配读这些数据，别的站点一律不给 CORS 头。 */
const LOCAL_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

/**
 * 进度目录。优先级：环境变量 > 插件 config > $DSH_HOME/.dsh-progress。
 * 默认放 DSH_HOME 下是因为面板本来就是 profile 级的全局挂件，
 * 任何脚本往那儿写都能被看到，不用操心自己在哪个工作区。
 */
export function progressDir(config) {
  const env = process.env.DSH_PROGRESS_DIR;
  if (env) return path.resolve(env);
  if (config && typeof config.dir === 'string' && config.dir) return path.resolve(config.dir);
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, '.dsh-progress');
}

/**
 * 任务 id → 文件名。必须和 hub/progress.py 的 _safe_name 保持一致，
 * 否则读取端会找不到写出来的日志文件。
 *
 * 用 \p{L}\p{N} 而不是 [A-Za-z0-9_]：中文要原样保留，
 * 否则「下载视频」和「转码视频」都会被压成 ____ 而互相覆盖。
 */
export function safeName(s) {
  const cleaned = String(s)
    .replace(/[^\p{L}\p{N}_.-]+/gu, '_')
    .replace(/^[._\s]+/, '')
    .replace(/[._\s]+$/, '');
  const out = cleaned.slice(0, 80);
  if (!out) return 'task';
  // Windows 保留设备名
  const base = out.split('.')[0].toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(base)) return '_' + out;
  return out;
}

/** 读目录下所有进度文件。坏文件跳过，绝不让一个任务把整页搞挂。 */
export async function readTasks(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];                       // 目录还不存在 = 还没有任务
  }
  const now = Date.now() / 1000;
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    if (n === 'hub.json' || n.startsWith('.') || n.startsWith('_')) continue;
    try {
      let raw = await readFile(path.join(dir, n), 'utf8');
      // 容忍 BOM：PowerShell 的 `Set-Content -Encoding UTF8` 会写，
      // 而 JSON.parse 见到 \ufeff 直接抛，表现为「文件明明在却什么都没有」。
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !obj.task_id) continue;
      obj.stale = obj.status === 'running' && (now - (Number(obj.updated_at) || 0)) > STALE_AFTER;
      out.push(obj);
    } catch {
      continue;
    }
  }
  // 跑着的排前面，再按更新时间倒序（和 Python 版行为一致）
  out.sort((a, b) => {
    const ra = a.status === 'running' ? 0 : 1;
    const rb = b.status === 'running' ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return (Number(b.updated_at) || 0) - (Number(a.updated_at) || 0);
  });
  return out;
}

/** 读某个任务的日志尾巴。 */
export async function readLog(dir, taskId, tail = 200) {
  try {
    const raw = await readFile(path.join(dir, safeName(taskId) + '.log'), 'utf8');
    const lines = raw.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-tail);
  } catch {
    return [];
  }
}

function send(res, code, body, ctype, origin) {
  const headers = {
    'Content-Type': ctype,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  };
  if (LOCAL_ORIGIN.test(origin || '')) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
    headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
    headers['Access-Control-Allow-Headers'] = '*';
  }
  res.writeHead(code, headers);
  res.end(body);
}

const json = (res, obj, code, origin) =>
  send(res, code || 200, JSON.stringify(obj), 'application/json; charset=utf-8', origin);

/** 建好但还没 listen 的服务器。路由是只读的，不执行任何东西。 */
export function createHubServer(dir, log) {
  return createServer((req, res) => {
    const origin = req.headers.origin;
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const route = url.pathname;

    if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain', origin);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, { error: 'read-only' }, 405, origin);
    }

    handle(route, url, res, origin).catch((err) => {
      if (log) log.warn(err instanceof Error ? err : new Error(String(err)));
      try { json(res, { error: 'internal' }, 500, origin); } catch { /* 已经发过了 */ }
    });
  });

  async function handle(route, url, res, origin) {
    if (route === '/' || route === '/index.html') {
      return send(res, 200, BOARD_HTML.replace('__DIR__', dir), 'text/html; charset=utf-8', origin);
    }
    if (route === '/api/health') {
      return json(res, { ok: true, dir, uptime_sec: process.uptime() }, 200, origin);
    }
    if (route === '/api/tasks') {
      return json(res, { tasks: await readTasks(dir), now: Date.now() / 1000, dir }, 200, origin);
    }
    if (route.startsWith('/api/tasks/')) {
      const id = decodeURIComponent(route.slice('/api/tasks/'.length)).replace(/\/+$/, '');
      if (!id) return json(res, { error: 'missing task id' }, 400, origin);
      let tail = parseInt(url.searchParams.get('tail') || '200', 10);
      if (!Number.isFinite(tail)) tail = 200;
      tail = Math.max(1, Math.min(2000, tail));
      const tasks = await readTasks(dir);
      const task = tasks.find((t) => t.task_id === id);
      if (!task) return json(res, { error: 'no such task: ' + id }, 404, origin);
      return json(res, { task, log: await readLog(dir, id, tail) }, 200, origin);
    }
    return json(res, { error: 'not found' }, 404, origin);
  }
}

/**
 * 依次尝试 8791~8800，返回真正抢到的端口。
 * 客户端也是在这段里逐个探活的，所以两边不用额外约定。
 */
export async function listenOnFreePort(server, host, start) {
  let lastErr;
  for (let p = start; p < start + PORT_SPAN; p++) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => { server.off('listening', onListening); reject(err); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(p, host);
      });
      return p;
    } catch (err) {
      lastErr = err;
      if (err && err.code === 'EADDRINUSE') continue;
      throw err;
    }
  }
  throw lastErr || new Error('8791~8800 全被占用');
}

/** 确保目录存在；只是读的话不存在也没关系，但先建好能省掉一堆判断。 */
export function ensureDir(dir) {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch { /* 建不了就算了，读的时候自然会返回空 */ }
}
