/**
 * 进度服务的测试（server.js）。
 *
 * 服务现在跑在插件的 Host 半边里，不再是个独立进程，所以直接用 Node 起一个来测。
 * 客户端那半边（client.js）由 client_render_test.cjs 覆盖。
 *
 *   node tests/server_test.js
 *
 * 重点覆盖三件容易出错的事：
 *   · safeName 必须和 hub/progress.py 的 _safe_name 完全一致
 *     —— 不一致就读不到日志文件，而且不会报错，只是「日志一直是空的」
 *   · 只有本机 origin 才拿得到 CORS 头（发布版必须收紧，否则任何网页都能读你的任务名）
 *   · 坏文件 / BOM / 缺字段不能把整个列表搞挂
 */

import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';

import {
  BASE_PORT, PORT_SPAN, createHubServer, listenOnFreePort,
  progressDir, readLog, readTasks, safeName,
} from '../server.js';

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

const get = async (base, url, headers = {}) => {
  const r = await fetch(base + url, { headers });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, headers: r.headers, body };
};

const task = (over = {}) => ({
  task_id: 'x', title: '任务', status: 'running', done: 1, total: 10, unit: '页',
  pct: 10, updated_at: Date.now() / 1000, ...over,
});

async function main() {
  console.log('\n== 进度服务（server.js）测试 ==');

  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-srv-'));
  const server = createHubServer(dir, null);
  const port = await freePort();
  await new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(port, '127.0.0.1', res);
  });
  const base = `http://127.0.0.1:${port}`;

  try {
    /* ---------------------------------------------------------- safeName */
    console.log('\n-- safeName 必须和 Python 版一致 --');
    const cases = [
      ['下载视频', '下载视频'],
      ['转码视频', '转码视频'],
      ['my-task', 'my-task'],
      ['a/b:c*d?', 'a_b_c_d'],
      ['CON', '_CON'],
      ['  ..  ', 'task'],
      ['批处理 2026-01-01', '批处理_2026-01-01'],
    ];
    for (const [input, want] of cases) eq(safeName(input), want, `safeName(${JSON.stringify(input)})`);
    ok(safeName('下载视频') !== safeName('转码视频'), '两个中文标题不会撞成同一个文件名');

    console.log('\n-- progressDir 优先级 --');
    const saved = { d: process.env.DSH_PROGRESS_DIR, h: process.env.DSH_HOME };
    process.env.DSH_HOME = 'C:\\fake-home';
    delete process.env.DSH_PROGRESS_DIR;
    eq(progressDir(), path.join('C:\\fake-home', '.dsh-progress'), '默认落在 $DSH_HOME/.dsh-progress');
    eq(progressDir({ dir: 'C:\\custom' }), path.resolve('C:\\custom'), 'config.dir 可覆盖');
    process.env.DSH_PROGRESS_DIR = 'C:\\from-env';
    eq(progressDir({ dir: 'C:\\custom' }), path.resolve('C:\\from-env'), '环境变量优先于 config');
    if (saved.d === undefined) delete process.env.DSH_PROGRESS_DIR; else process.env.DSH_PROGRESS_DIR = saved.d;
    if (saved.h === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved.h;

    console.log('\n-- 空目录 --');
    eq(await readTasks(dir), [], '目录里没东西时返回空数组');
    eq(await readTasks(path.join(dir, 'does-not-exist')), [], '目录不存在也返回空数组，不抛');

    /* ---------------------------------------------------------- 路由 */
    console.log('\n-- /api/health --');
    let r = await get(base, '/api/health');
    eq(r.status, 200, '返回 200');
    eq(r.body.ok, true, 'ok = true');
    eq(path.resolve(r.body.dir), path.resolve(dir), '回显进度目录');

    console.log('\n-- /api/tasks（含各种该被忽略的文件）--');
    await writeFile(path.join(dir, 'a.json'), JSON.stringify(task({ task_id: 'a', title: '甲' })));
    await writeFile(path.join(dir, 'b.json'), JSON.stringify(
      task({ task_id: 'b', title: '乙', status: 'done', updated_at: Date.now() / 1000 })));
    await writeFile(path.join(dir, 'hub.json'), JSON.stringify({ url: 'x', port: 1 }));
    await writeFile(path.join(dir, '_hidden.json'), JSON.stringify(task({ task_id: '_hidden' })));
    await writeFile(path.join(dir, '.dot.json'), JSON.stringify(task({ task_id: '.dot' })));
    await writeFile(path.join(dir, 'no-id.json'), JSON.stringify({ title: '没有 task_id' }));
    await writeFile(path.join(dir, 'broken.json'), '{ 不是 json');
    await writeFile(path.join(dir, 'not-object.json'), '[1,2,3]');
    await writeFile(path.join(dir, 'bom.json'), '\ufeff' + JSON.stringify(
      task({ task_id: 'bom', title: '带 BOM', status: 'done', updated_at: Date.now() / 1000 })));

    r = await get(base, '/api/tasks');
    const ids = r.body.tasks.map((t) => t.task_id);
    eq(r.status, 200, '返回 200');
    ok(ids.includes('a') && ids.includes('b'), '正常任务被列出', ids.join(','));
    ok(!ids.includes('hub.json') && !r.body.tasks.some((t) => t.task_id === 'hub'), 'hub.json 被跳过');
    ok(!ids.includes('_hidden') && !ids.includes('.dot'), '下划线 / 点开头的文件被跳过');
    ok(!ids.some((t) => t.title === '没有 task_id'), '缺 task_id 的被跳过');
    ok(ids.includes('bom'), '带 BOM 的文件能读出来');
    eq(ids[0], 'a', 'running 的任务排在最前（b/bom 都是 done）');

    const a = r.body.tasks.find((t) => t.task_id === 'a');
    eq(a.stale, false, '刚更新的 running 不算 stale');
    eq(a.pct, 10, '字段原样透传');

    console.log('\n-- stale 判定 --');
    await writeFile(path.join(dir, 'old.json'), JSON.stringify(
      task({ task_id: 'old', status: 'running', updated_at: Date.now() / 1000 - 600 })));
    r = await get(base, '/api/tasks');
    eq(r.body.tasks.find((t) => t.task_id === 'old').stale, true, '超过 120 秒没更新 → stale');
    eq(r.body.tasks[0].task_id, 'a', 'running 组内按更新时间倒序：刚更新的在前');
    eq(r.body.tasks[1].task_id, 'old', 'stale 的排后面，但仍在显示（不会因为卡住就消失）');
    eq(r.body.tasks[2].task_id, 'bom', 'done 的排最后');

    console.log('\n-- /api/tasks/<id> 与日志 --');
    await writeFile(path.join(dir, 'a.log'), '第一行\n第二行\n第三行\n');
    r = await get(base, '/api/tasks/a?tail=2');
    eq(r.status, 200, '返回 200');
    eq(r.body.task.task_id, 'a', '带回任务对象');
    eq(r.body.log, ['第二行', '第三行'], 'tail 参数生效，且去掉了行尾空行');

    r = await get(base, '/api/tasks/a');
    eq(r.body.log.length, 3, '不传 tail 时默认给全部（少于 200 行）');

    r = await get(base, '/api/tasks/%E4%B8%8B%E8%BD%BD%E8%A7%86%E9%A2%91');
    eq(r.status, 404, 'URL 编码的中文 id 能正确解码并查不到时返回 404');

    r = await get(base, '/api/tasks/nope');
    eq(r.status, 404, '不存在的任务返回 404');

    r = await get(base, '/api/tasks/');
    eq(r.status, 400, '空 id 返回 400');

    r = await get(base, '/api/nothing');
    eq(r.status, 404, '未知路径返回 404');

    console.log('\n-- readLog 直接调用 --');
    eq(await readLog(dir, 'a', 1), ['第三行'], 'readLog tail=1');
    eq(await readLog(dir, 'no-such', 5), [], '没有日志时返回空数组');

    /* ---------------------------------------------------------- CORS */
    console.log('\n-- CORS 只给本机页面 --');
    r = await get(base, '/api/tasks', { Origin: 'http://127.0.0.1:3080' });
    eq(r.headers.get('access-control-allow-origin'), 'http://127.0.0.1:3080', '本机 origin 放行');
    r = await get(base, '/api/tasks', { Origin: 'http://localhost:19387' });
    eq(r.headers.get('access-control-allow-origin'), 'http://localhost:19387', 'localhost 也放行');
    r = await get(base, '/api/tasks', { Origin: 'https://evil.example' });
    eq(r.headers.get('access-control-allow-origin'), null, '外部站点不给 CORS 头');
    r = await get(base, '/api/tasks', { Origin: 'http://127.0.0.1.evil.com' });
    eq(r.headers.get('access-control-allow-origin'), null, '伪造前缀的域名也不给');

    const opt = await fetch(base + '/api/tasks', { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:3080' } });
    eq(opt.status, 204, 'OPTIONS 预检返回 204');

    console.log('\n-- 只读 --');
    const post = await fetch(base + '/api/tasks', { method: 'POST' });
    eq(post.status, 405, 'POST 被拒（405）');
    const del = await fetch(base + '/api/tasks/a', { method: 'DELETE' });
    eq(del.status, 405, 'DELETE 被拒（405）');

    /* ---------------------------------------------------------- 看板页 */
    console.log('\n-- 独立看板页 --');
    r = await get(base, '/');
    eq(r.status, 200, 'GET / 返回 200');
    ok(typeof r.body === 'string' && r.body.includes('进度看板'), '是看板页 HTML');
    ok(r.body.includes(dir.replace(/\\/g, '\\')), '__DIR__ 被替换成真实进度目录');
    ok(!r.body.includes('__DIR__'), '没有漏掉未替换的占位符');

    /* ---------------------------------------------------------- 端口 */
    console.log('\n-- 端口挑选 --');
    const s1 = createHubServer(dir, null);
    const p1 = await listenOnFreePort(s1, '127.0.0.1', await freePort());
    ok(Number.isInteger(p1), '能拿到一个端口', String(p1));
    // 同一个端口再起一个：应该自动往后挪
    const s2 = createHubServer(dir, null);
    const p2 = await listenOnFreePort(s2, '127.0.0.1', p1);
    ok(p2 === p1 + 1, '起始端口被占用时自动往后挪一位', `${p1} -> ${p2}`);
    s1.close(); s1.closeAllConnections?.();
    s2.close(); s2.closeAllConnections?.();
    eq([BASE_PORT, PORT_SPAN], [8791, 10], '端口区间常量没被改动过（客户端按这个探活）');
  } finally {
    server.close();
    server.closeAllConnections?.();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${fail === 0 ? '全部通过' : '存在失败'}：${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('× 测试自身异常：', e); process.exit(1); });
