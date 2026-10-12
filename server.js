/**
 * 进度服务的路由处理器。
 *
 * 早先的版本自己起了个 HTTP 服务、占 8791~8800 里的一个端口，客户端再去探端口，
 * 还得开 CORS。那没必要：DSH 自己的 Web 应用**已经**跑着一个 webserver
 * （`@deepseek-ai/dsh-host-webserver`，就是 GUI 那个端口），插件往上注册一条路由就行。
 *
 * 换来的是：
 *   · 不占端口、没有额外进程
 *   · **完全不需要 CORS**（同源）
 *   · 客户端不用再探 10 个端口，直接打相对路径
 *   · 桌面版也通 —— Electron 会把 `dsh-app://app/api/...` 转发到同一个 webserver
 *
 * 路径选 `/api/progress` 是算过的：webserver 的匹配规则是
 * 「exact 优先，其次**最长前缀获胜**」（packages/host/webserver/src/index.ts:318），
 * 所以它会稳稳压过 DSH 自己的 `/api` 路由，而不会被它吞掉。
 *
 * 代价：DSH 自己的 `/api` 路由带鉴权（`connection.admit`），而我这条更长、绕过了它，
 * 所以这里是**无鉴权**的。默认 webserver 只绑 127.0.0.1，本机自用没问题；
 * 部署时若把 host 改成 0.0.0.0，index.js 会打警告。
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { BOARD_HTML } from './board.js';

/** 路由前缀。前端和看板页都按这个拼 URL。 */
export const ROUTE_PATH = '/api/progress';

const STALE_AFTER = 120;              // 秒；超过这么久没更新算「疑似卡住」

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
 * 否则读取端会找不到写出来的日志文件（而且不报错，只是日志一直是空的）。
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
  // 跑着的排前面，再按更新时间倒序
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

function sendJson(res, obj, code) {
  const body = JSON.stringify(obj);
  res.writeHead(code || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

/**
 * 造一个挂到 `webServer.register` 上的 handler。
 *
 * 服务是只读的：不执行任何东西，只读目录和日志文件。
 *
 * @param dir - 进度目录。
 * @param log - 可选的 ctx.logger，用来记录意外错误。
 * @returns `(req, res) => Promise<void>`，直接交给 webserver。
 */
export function createProgressHandler(dir, log) {
  return async function handle(req, res) {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(res, { error: 'read-only' }, 405);
      }
      const url = new URL(req.url || '/', 'http://localhost');
      // 自己再验一次前缀，别假设调用方筛过了。
      // webserver 的规则是「pathname === prefix 或 prefix + '/'」，
      // 这里复刻它 —— 否则 '/health' 这种短路径被 slice 之后会变成 ''，
      // 阴差阳错地命中「根路径 → 看板页」。
      if (url.pathname !== ROUTE_PATH && !url.pathname.startsWith(ROUTE_PATH + '/')) {
        return sendJson(res, { error: 'not found' }, 404);
      }
      const rest = url.pathname.slice(ROUTE_PATH.length);
      if (rest === '' || rest === '/') {
        return sendHtml(res, BOARD_HTML.replace('__DIR__', dir));
      }
      if (rest === '/health') {
        return sendJson(res, { ok: true, dir, uptime_sec: process.uptime() }, 200);
      }
      if (rest === '/tasks') {
        return sendJson(res, { tasks: await readTasks(dir), now: Date.now() / 1000, dir }, 200);
      }
      if (rest.startsWith('/tasks/')) {
        const id = decodeURIComponent(rest.slice('/tasks/'.length)).replace(/\/+$/, '');
        if (!id) return sendJson(res, { error: 'missing task id' }, 400);
        let tail = parseInt(url.searchParams.get('tail') || '200', 10);
        if (!Number.isFinite(tail)) tail = 200;
        tail = Math.max(1, Math.min(2000, tail));
        const tasks = await readTasks(dir);
        const task = tasks.find((t) => t.task_id === id);
        if (!task) return sendJson(res, { error: 'no such task: ' + id }, 404);
        return sendJson(res, { task, log: await readLog(dir, id, tail) }, 200);
      }
      return sendJson(res, { error: 'not found' }, 404);
    } catch (err) {
      if (log) log.warn(err instanceof Error ? err : new Error(String(err)));
      try { sendJson(res, { error: 'internal' }, 500); } catch { /* 已经发过了 */ }
    }
  };
}

/** 确保目录存在；只是读的话不存在也没关系，但先建好能省掉一堆判断。 */
export function ensureDir(dir) {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch { /* 建不了就算了，读的时候自然会返回空 */ }
}
