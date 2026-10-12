/**
 * 长任务进度约定（Node 版）。
 *
 * 和 hub/progress.py 写出来的是**同一份格式**，两边可以混用，面板不作区分。
 *
 * 用法：
 *
 *     import { Progress } from '.../hub/progress.mjs'
 *
 *     const p = new Progress('my-task', { total: 1529, unit: '页', title: '我的抓取任务' })
 *     try {
 *       for (let i = 1; i <= 1529; i++) {
 *         await work(i)
 *         p.update(i, `第 ${i} 页完成`)
 *       }
 *       p.finish('全部完成')
 *     } catch (err) {
 *       p.fail(String(err && err.message || err))
 *       throw err
 *     } finally {
 *       p.close()          // 兜底：没走 finish/fail 也不会一直挂在 running
 *     }
 *
 * 或者用 `using`（Node 22+ 支持显式资源管理）：
 *
 *     using p = new Progress('my-task', { total: 10 })
 *     ...
 *     p.finish()
 *
 * 设计约束和 Python 版一致：零依赖、原子写、写盘限频、**绝不抛异常**。
 */

import {
  appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WRITE_MIN_INTERVAL = 400;   // 毫秒；普通 update 最快多久落一次盘
const RATE_WINDOW_MS = 30000;     // 算速率用的滑动窗口
export const STALE_AFTER = 120;   // 秒；超过这么久没更新算「疑似卡住」

/** 进度目录：环境变量 > $DSH_HOME/.dsh-progress，和插件服务端保持一致。 */
export function progressDir() {
  const env = process.env.DSH_PROGRESS_DIR;
  if (env) return path.resolve(env);
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, '.dsh-progress');
}

/** 任务 id → 文件名。和 server.js / progress.py 的规则必须一致。 */
export function safeName(s) {
  const cleaned = String(s)
    .replace(/[^\p{L}\p{N}_.-]+/gu, '_')
    .replace(/^[._\s]+/, '')
    .replace(/[._\s]+$/, '');
  const out = cleaned.slice(0, 80) || 'task';
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(out.split('.')[0].toUpperCase())) {
    return '_' + out;
  }
  return out;
}

export function fmtDuration(sec) {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '—';
  const s = Math.round(sec);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's';
  return Math.floor(s / 3600) + 'h' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + 'm';
}

export class Progress {
  /**
   * @param {string} taskId - 任务标识，决定文件名。
   * @param {{total?: number, unit?: string, title?: string, extra?: object, dir?: string}} [opts]
   */
  constructor(taskId, opts = {}) {
    // 和 Python 版一致：没设或设成空串都算「开着」
    this.enabled = !process.env.DSH_PROGRESS_OFF;
    this.taskId = String(taskId);
    this.slug = safeName(this.taskId);
    this.total = opts.total ?? null;
    this.unit = opts.unit ?? '';
    this.title = opts.title ?? this.taskId;
    this.extra = { ...(opts.extra || {}) };

    this.done = 0;
    this.status = 'running';
    this.message = '';
    this.startedAt = Date.now();
    this._samples = [];
    this._lastWrite = 0;
    this._final = false;

    this.dir = opts.dir || progressDir();
    this.jsonPath = path.join(this.dir, this.slug + '.json');
    this.logPath = path.join(this.dir, this.slug + '.log');

    if (this.enabled) {
      try { mkdirSync(this.dir, { recursive: true }); } catch { this.enabled = false; }
    }
    this._sample();
    this._write(true);
  }

  _sample() {
    this._samples.push([Date.now(), this.done]);
    if (this._samples.length > 64) this._samples.shift();
  }

  _rate() {
    const now = Date.now();
    let pts = this._samples.filter(([t]) => now - t <= RATE_WINDOW_MS);
    if (pts.length < 2) pts = this._samples.slice(-2);
    if (pts.length < 2) return null;
    const [t0, d0] = pts[0];
    const [t1, d1] = pts[pts.length - 1];
    const dt = (t1 - t0) / 1000;
    if (dt <= 0) return null;
    return (d1 - d0) / dt;
  }

  snapshot() {
    const now = Date.now();
    const rate = this._rate();
    let pct = null, eta = null;
    if (this.total) {
      pct = Math.max(0, Math.min(100, (this.done / this.total) * 100));
      if (rate && rate > 0) eta = Math.max(0, (this.total - this.done) / rate);
    }
    return {
      task_id: this.taskId,
      title: this.title,
      status: this.status,
      done: this.done,
      total: this.total,
      unit: this.unit,
      pct,
      rate,
      eta_sec: eta,
      elapsed_sec: (now - this.startedAt) / 1000,
      started_at: this.startedAt / 1000,
      updated_at: now / 1000,
      message: this.message,
      extra: this.extra,
      pid: process.pid,
      stale: false,
    };
  }

  _write(force = false) {
    if (!this.enabled) return;
    const now = Date.now();
    if (!force && now - this._lastWrite < WRITE_MIN_INTERVAL) return;
    this._lastWrite = now;
    try {
      const body = JSON.stringify(this.snapshot());
      const tmp = this.jsonPath + '.tmp';
      writeFileSync(tmp, body, 'utf8');
      renameSync(tmp, this.jsonPath);          // 原子替换，读端不会看到半个文件
    } catch { /* 进度写不进去也不能影响正经活儿 */ }
  }

  log(line) {
    if (!this.enabled) return;
    try {
      const t = new Date();
      const hhmmss = [t.getHours(), t.getMinutes(), t.getSeconds()]
        .map((n) => String(n).padStart(2, '0')).join(':');
      appendFileSync(this.logPath, `${hhmmss} ${line}\n`, 'utf8');
    } catch { /* 同上 */ }
  }

  /** 更新进度。给了 message 就立刻落盘并记一行日志。 */
  update(done, message) {
    if (done != null) this.done = done;
    if (message != null) {
      this.message = String(message);
      this.log(this.message);
      this._sample();
      this._write(true);
      return this;
    }
    this._sample();
    this._write();
    return this;
  }

  step(n = 1, message) { return this.update(this.done + n, message); }

  setTotal(total) { this.total = total; this._write(true); return this; }

  finish(message) {
    if (this._final) return this;
    this.status = 'done';
    this._final = true;
    if (this.total) this.done = this.total;
    if (message != null) { this.message = String(message); this.log(this.message); }
    this.log(`完成，用时 ${fmtDuration((Date.now() - this.startedAt) / 1000)}`);
    this._write(true);
    return this;
  }

  fail(message) {
    if (this._final) return this;
    this.status = 'failed';
    this._final = true;
    this.message = String(message || 'failed');
    this.log('失败：' + this.message);
    this._write(true);
    return this;
  }

  cancel(message) {
    if (this._final) return this;
    this.status = 'cancelled';
    this._final = true;
    this.message = String(message || 'cancelled');
    this.log('已取消');
    this._write(true);
    return this;
  }

  /** 兜底收尾：没显式结束过就标失败，免得任务永远停在 running。 */
  close() {
    if (!this._final) this.fail('进程退出但任务未收尾');
  }

  [Symbol.dispose]() { this.close(); }
}

/** 读目录下所有任务（看板 / 手工排查用）。 */
export function readTasks(dir = progressDir()) {
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const now = Date.now() / 1000;
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json') || n === 'hub.json' || n.startsWith('.') || n.startsWith('_')) continue;
    try {
      let raw = readFileSync(path.join(dir, n), 'utf8');
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object' || !obj.task_id) continue;
      obj.stale = obj.status === 'running' && (now - (Number(obj.updated_at) || 0)) > STALE_AFTER;
      out.push(obj);
    } catch { /* 坏文件跳过 */ }
  }
  out.sort((a, b) => {
    const ra = a.status === 'running' ? 0 : 1;
    const rb = b.status === 'running' ? 0 : 1;
    return ra !== rb ? ra - rb : (Number(b.updated_at) || 0) - (Number(a.updated_at) || 0);
  });
  return out;
}

export default Progress;
