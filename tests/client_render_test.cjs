/**
 * dsh-progress-panel/client.js（悬浮窗版）的离线渲染测试。
 *
 * 我装不了这个插件，所以改完必须自己先证一遍：用一套**最小 React 运行时**
 * 把组件真跑起来渲染，喂假的 hub 数据和一个**假的 DOM 节点**，
 * 断言它画成什么样、拖拽落点算得对不对。
 *
 * 能抓到：语法错误、undefined 变量、渲染抛异常、槽位/参数写错、端口探测、
 *         进度条与文案算错、展开收起、日志、拖拽落点、位置持久化。
 * 抓不到：真实 React 行为、真实主题观感（要人眼看）。
 *
 *   node tests/client_render_test.js
 */
const fs = require("fs");
const path = require("path");

const CLIENT = path.resolve(__dirname, "..", "client.js");

let pass = 0, fail = 0;
const eq = (a, b, label) => {
  const okv = JSON.stringify(a) === JSON.stringify(b);
  if (okv) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  × ${label}\n      期望 ${JSON.stringify(b)}\n      实际 ${JSON.stringify(a)}`); }
};
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? "  —— " + detail : ""}`); }
  else { fail++; console.log(`  × ${label}${detail ? "  —— " + detail : ""}`); }
};

const WIN_W = 1280, WIN_H = 800;

/* ------------------------------------------------------------------ 最小 React */
function createMiniReact() {
  let hooks = [], idx = 0, pending = [], schedule = null;
  // useLayoutEffect 在测试里跟 useEffect 一样处理就够了：反正每一轮都是手动驱动的
  const useEffectImpl = (fn, deps) => {
    const i = idx++;
    const prev = hooks[i];
    const changed = !prev || !deps || !prev.deps ||
      deps.length !== prev.deps.length || deps.some((d, k) => d !== prev.deps[k]);
    if (changed) {
      if (prev && prev.cleanup) { try { prev.cleanup(); } catch (e) {} }
      hooks[i] = { deps, cleanup: undefined };
      pending.push(() => {
        const c = fn();
        hooks[i].cleanup = typeof c === "function" ? c : undefined;
      });
    }
  };
  const React = {
    createElement(type, props, ...kids) {
      const children = [];
      const push = (k) => {
        if (Array.isArray(k)) k.forEach(push);
        else if (k !== null && k !== undefined && k !== false && k !== true) children.push(k);
      };
      kids.forEach(push);
      const p = Object.assign({}, props || {}, { children });
      // 模拟 React 给 ref 挂 DOM 节点
      if (p.ref && typeof p.ref === "object") p.ref.current = makeFakeNode(p);
      return { type, props: p };
    },
    useState(init) {
      const i = idx++;
      if (!(i in hooks)) hooks[i] = typeof init === "function" ? init() : init;
      const set = (v) => {
        const nv = typeof v === "function" ? v(hooks[i]) : v;
        if (nv !== hooks[i]) { hooks[i] = nv; if (schedule) schedule(); }
      };
      return [hooks[i], set];
    },
    useEffect: useEffectImpl,
    useLayoutEffect: useEffectImpl,
    useRef(init) { const i = idx++; if (!(i in hooks)) hooks[i] = { current: init }; return hooks[i]; },
    useMemo(fn) { const i = idx++; if (!(i in hooks)) hooks[i] = fn(); return hooks[i]; },
    useCallback(fn) { const i = idx++; if (!(i in hooks)) hooks[i] = fn; return hooks[i]; },
  };
  return {
    React,
    render(Comp) {
      idx = 0; pending = [];
      let tree, err = null;
      try { tree = Comp(); } catch (e) { err = e; }
      const fx = pending; pending = [];
      fx.forEach((f) => { try { f(); } catch (e) { err = err || e; } });
      return { tree, err };
    },
    setScheduler(fn) { schedule = fn; },
    unmount() { for (const hk of hooks) if (hk && hk.cleanup) { try { hk.cleanup(); } catch (e) {} } },
    /** 模拟「卸载后重新挂载」：清空 hook 状态，于是 useState 的惰性初始化会重新跑 */
    reset() {
      for (const hk of hooks) if (hk && hk.cleanup) { try { hk.cleanup(); } catch (e) {} }
      hooks = [];
    },
  };
}

/**
 * 假 DOM 节点。要点：
 *   · 尺寸按「药丸 / 卡片」区分，这样展开变大这件事在测试里是真实的
 *   · style 是**活的**，因为拖拽时组件会绕过 React 直接写 el.style，
 *     getBoundingClientRect 必须读得到这些写入
 */
function makeFakeNode(props) {
  const isCard = String(props.className || "").includes("open");
  const node = {
    _w: isCard ? 330 : 240,
    _h: isCard ? 250 : 32,
    style: Object.assign({}, props.style || {}),
    setPointerCapture() {}, releasePointerCapture() {},
    getBoundingClientRect() {
      const left = parseFloat(this.style.left) || 0;
      const top = parseFloat(this.style.top) || 0;
      return { left, top, width: this._w, height: this._h,
               right: left + this._w, bottom: top + this._h };
    },
  };
  node.offsetWidth = node._w;
  node.offsetHeight = node._h;
  return node;
}

/* ------------------------------------------------------------------ 环境桩 */
let seq = 0;
let rafSeq = 0;
const ivs = new Map();
const rafs = new Map();

function installEnv(hubPort) {
  const calls = { health: [], tasks: [], log: [] };

  const store = new Map();
  global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  global.window = {
    __ModuleLoader__: { load(mod) { global.__loaded = mod; } },
    innerWidth: WIN_W,
    innerHeight: WIN_H,
    addEventListener() {}, removeEventListener() {},
  };
  global.AbortController = global.AbortController || class { constructor() { this.signal = {}; } abort() {} };

  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/api/health")) {
      const port = Number((u.match(/127\.0\.0\.1:(\d+)/) || [])[1]);
      calls.health.push(port);
      if (port === hubPort) return { ok: true, status: 200, json: async () => ({ ok: true, port }) };
      throw new Error("ECONNREFUSED");
    }
    if (u.includes("/api/tasks/")) {
      calls.log.push(u);
      return { ok: true, status: 200, json: async () => ({ task: {}, log: ["10:00:01 已处理 100 页", "10:00:02 已处理 200 页"] }) };
    }
    if (u.includes("/api/tasks")) {
      calls.tasks.push(u);
      return { ok: true, status: 200, json: async () => ({ tasks: global.__fakeTasks || [] }) };
    }
    throw new Error("unexpected url " + u);
  };

  global.setInterval = (fn) => { const id = ++seq; ivs.set(id, fn); return id; };
  global.clearInterval = (id) => { ivs.delete(id); };

  // rAF：攒起来等测试手动刷一帧，好断言「一帧只画一次」
  global.requestAnimationFrame = (fn) => { const id = ++rafSeq; rafs.set(id, fn); return id; };
  global.cancelAnimationFrame = (id) => { rafs.delete(id); };

  return { calls, store };
}

/** 手动把攒下的 rAF 回调跑一帧 */
function flushRaf() {
  const pending = [...rafs.values()];
  rafs.clear();
  for (const fn of pending) { try { fn(0); } catch (e) {} }
}

const flush = () => new Promise((r) => setTimeout(r, 10));
const settle = async (rounds = 8) => { for (let i = 0; i < rounds; i++) await flush(); };
async function pumpIntervals() {
  for (const fn of [...ivs.values()]) { try { await fn(); } catch (e) {} }
  await settle(4);
}

/* ------------------------------------------------------------------ 树工具 */
function walk(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out;
  out.push(node);
  if (typeof node === "object" && node.props) {
    const ch = node.props.children;
    if (Array.isArray(ch)) ch.forEach((c) => walk(c, out));
  }
  return out;
}
const byClass = (tree, cls) =>
  walk(tree).filter((n) => n && typeof n === "object" && n.props &&
    typeof n.props.className === "string" && n.props.className.split(/\s+/).includes(cls));
const textOf = (node) =>
  walk(node).map((n) => (typeof n === "string" ? n : (typeof n === "number" ? String(n) : ""))).join(" ");
const byText = (tree, s) => walk(tree).find((n) => n && typeof n === "object" && n.props &&
  n.props.className && String(n.props.className).includes("dshpp-btn") && textOf(n).includes(s));

/** 造一个 PointerEvent 桩 */
const pt = (x, y, target) => ({
  button: 0, pointerId: 1, clientX: x, clientY: y,
  target: target || { closest: () => null },
  currentTarget: { setPointerCapture() {}, releasePointerCapture() {} },
  preventDefault() {},
});

/* ------------------------------------------------------------------ 主流程 */
(async () => {
  console.log("\n== dsh-progress-panel/client.js 悬浮窗版 · 离线渲染测试 ==");

  const src = fs.readFileSync(CLIENT, "utf8");
  let syntaxOk = true, syntaxErr = "";
  try { new Function(src); } catch (e) { syntaxOk = false; syntaxErr = e.message; }
  ok(syntaxOk, "client.js 语法可解析", syntaxErr);

  const HUB_PORT = 8796;
  const { calls, store } = installEnv(HUB_PORT);
  new Function("window", "fetch", "AbortController", "console", "localStorage", "setInterval", "clearInterval", "setTimeout", "clearTimeout", src)(
    global.window, global.fetch, global.AbortController, console, global.localStorage,
    global.setInterval, global.clearInterval, global.setTimeout, global.clearTimeout
  );
  const mod = global.__loaded;
  ok(!!mod, "调用了 window.__ModuleLoader__.load");
  eq(mod.id, "@local/dsh-progress-panel", "模块 id 与 package name 一致");

  const mini = createMiniReact();
  global.__miniReact = mini.React;
  const plugin = mod.factory((name) => {
    if (name === "react") return global.__miniReact;
    throw new Error("未预期的 require: " + name);
  });
  ok(plugin && typeof plugin.apply === "function", "返回带 apply 的插件对象");
  eq(plugin.inject, ["slots"], "inject 声明 ['slots']");

  const registered = [];
  plugin.apply({
    slots: {
      inject: (owner, cb) => { registered.push({ owner, cb }); },
      register: (opts, Comp) => { registered.push({ opts, Comp }); return () => {}; },
    },
  });
  eq(registered[0].owner, "shell.overlay", "注册进 shell.overlay（悬浮槽位）");
  registered[0].cb();
  const reg = registered.find((r) => r.opts);
  eq(reg.opts.name, "shell.overlay", "register 的槽位名");
  eq(reg.opts.id, "dsh-progress-panel", "register 的 id");
  ok(typeof reg.opts.order === "number", "register 带了 order", String(reg.opts.order));

  mini.setScheduler(() => { try { mini.render(reg.Comp); } catch (e) { console.error(e); } });
  /** 反复「渲染 → 等异步 → 泵轮询」，直到状态稳定 */
  const drive = async (m, Comp, rounds = 4) => {
    for (let i = 0; i < rounds; i++) {
      m.render(Comp);
      await settle(5);
      await pumpIntervals();
    }
    return m.render(Comp);
  };
  const renderNow = () => drive(mini, reg.Comp);

  console.log("\n-- 基本显示 --");
  global.__fakeTasks = [];
  let r = await renderNow();
  eq(r.err, null, "初次渲染不抛异常");
  eq(r.tree, null, "没有任务 → 什么都不渲染（不占地方）");
  ok(calls.health.length >= 5, "端口探测走了多个端口", "试过 " + calls.health.join(","));
  eq(calls.health.includes(HUB_PORT), true, `探测命中 ${HUB_PORT}`);

  console.log("\n-- 悬浮药丸（收起态）--");
  global.__fakeTasks = [{
    task_id: "ggbases-crawl", title: "GGBases 抓取", status: "running",
    done: 948, total: 1529, unit: "页", pct: 62.0, rate: 1.2, eta_sec: 920,
    updated_at: Date.now() / 1000, message: "p=930 失败 0", stale: false,
  }];
  r = await renderNow();
  eq(r.err, null, "有任务时渲染不抛异常");
  const fab = byClass(r.tree, "dshpp-fab")[0];
  ok(!!fab, "渲染出悬浮容器 .dshpp-fab");
  eq(byClass(r.tree, "dshpp-pill").length, 1, "默认是收起的药丸");
  eq(byClass(r.tree, "dshpp-card").length, 0, "默认不是卡片");
  const pillTxt = textOf(fab);
  ok(pillTxt.includes("GGBases 抓取"), "药丸显示任务名");
  ok(pillTxt.includes("62%"), "药丸显示百分比", (pillTxt.match(/\d+%/) || [])[0]);
  const miniBar = byClass(r.tree, "dshpp-bar")[0];
  eq(walk(miniBar).find((n) => n.type === "i").props.style.width, "62%", "迷你进度条宽度");

  console.log("\n-- 悬浮定位 --");
  const st = fab.props.style;
  // 1280x800，药丸 240x32 → left = 1280-240-14 = 1026；top = 800-32-190 = 578
  eq([st.left, st.top], ["1026px", "578px"], "默认落在右下角并抬高 190px 避开鲸鱼");
  ok(String(fab.props.className).indexOf("dragging") < 0, "未拖拽时没有 dragging 类");

  console.log("\n-- 多个任务 --");
  global.__fakeTasks = [
    { task_id: "a", title: "任务甲", status: "running", done: 5, total: 10, pct: 50, updated_at: Date.now() / 1000 },
    { task_id: "b", title: "任务乙", status: "running", done: 1, total: 4, pct: 25, updated_at: Date.now() / 1000 },
  ];
  r = await renderNow();
  ok(textOf(r.tree).includes("+1"), "多于一个任务时显示 +N 角标");

  console.log("\n-- 点击展开成卡片 --");
  global.__fakeTasks = [{
    task_id: "ggbases-crawl", title: "GGBases 抓取", status: "running",
    done: 948, total: 1529, unit: "页", pct: 62.0, rate: 1.2, eta_sec: 920,
    updated_at: Date.now() / 1000, message: "p=930 失败 0", stale: false,
  }];
  r = await renderNow();
  let root = byClass(r.tree, "dshpp-fab")[0];
  root.props.onPointerDown(pt(1100, 590));
  root.props.onPointerUp(pt(1100, 590));
  await settle(4);
  r = await renderNow();
  eq(byClass(r.tree, "dshpp-card").length, 1, "点击后展开成卡片");
  const cardTxt = textOf(r.tree);
  ok(cardTxt.includes("任务进度"), "卡片有标题栏");
  ok(cardTxt.includes("62.0%"), "卡片显示一位小数百分比");
  ok(cardTxt.includes("948") && cardTxt.includes("1,529") && cardTxt.includes("页"), "显示 已完成/总数 + 单位");
  ok(/ETA \d+m\d+s/.test(cardTxt), "显示 ETA", (cardTxt.match(/ETA [\dmsh]+/) || [])[0]);
  ok(cardTxt.includes("1.20") && cardTxt.includes("/s"), "显示速率");
  ok(cardTxt.includes("p=930 失败 0"), "显示最新消息");

  // ↓↓↓ 之前真实存在的 bug：贴右下角时展开，卡片会冲出屏幕
  const est = byClass(r.tree, "dshpp-fab")[0].props.style;
  const ex = parseFloat(est.left), ey = parseFloat(est.top);
  ok(ex >= 0 && ey >= 0, "展开后左上角还在屏幕内", `(${ex}, ${ey})`);
  ok(ex + 330 <= 1280, "展开后右边不越界", `right = ${ex + 330} ≤ 1280`);
  ok(ey + 250 <= 800, "展开后下边不越界", `bottom = ${ey + 250} ≤ 800`);
  // 而且是「贴着右下 → 朝屏幕内生长」，不是硬夹回去
  eq([est.left, est.top], ["936px", "360px"], "贴右下时展开朝左上生长（右下角保持不动）");

  console.log("\n-- 展开日志 --");
  const logBtn = byText(r.tree, "日志");
  ok(!!logBtn, "卡片里有「日志」按钮");
  logBtn.props.onClick();
  await settle(4);
  r = await renderNow();
  ok(calls.log.length > 0, "点击后去拉了日志", calls.log[0]);
  eq(byClass(r.tree, "dshpp-log").length, 1, "渲染出日志框");
  ok(textOf(byClass(r.tree, "dshpp-log")[0]).includes("已处理 200 页"), "日志内容显示出来");
  byText(r.tree, "收起").props.onClick();
  await settle(4);
  r = await renderNow();
  eq(byClass(r.tree, "dshpp-pill").length, 1, "「收起」按钮回到药丸");

  console.log("\n-- 拖拽（自由落点，不吸附）--");
  store.clear();
  root = byClass(r.tree, "dshpp-fab")[0];
  // 药丸 240x32，点在 (1100,590)、窗口左上默认 (1026,578) → 抓取偏移 (74,12)
  root.props.onPointerDown(pt(1100, 590));
  root.props.onPointerMove(pt(1150, 620));     // 动了 → 算拖拽
  ok(rafs.size > 0, "拖拽时用 rAF 合并，没有每个 move 都重渲染（攒了 " + rafs.size + " 帧）");
  ok(byClass(mini.render(reg.Comp).tree, "dshpp-fab")[0].props.className.includes("dragging"),
     "拖拽中带 dragging 类");
  flushRaf();                                  // 手动刷一帧，等价于浏览器下一帧
  const liveNode = byClass(mini.render(reg.Comp).tree, "dshpp-fab")[0].props.ref.current;
  eq([liveNode.style.left, liveNode.style.top], ["1036px", "608px"],
     "坐标直接写到了 DOM 上（没等 React 重渲染）");
  await settle(2);
  r = await renderNow();
  const moved = byClass(r.tree, "dshpp-fab")[0].props.style;
  ok(moved.left != null, "拖拽时用 left/top 定位", JSON.stringify(moved));
  byClass(r.tree, "dshpp-fab")[0].props.onPointerUp(pt(1150, 620));
  await settle(4);
  r = await renderNow();
  const dropped = byClass(r.tree, "dshpp-fab")[0].props.style;
  // 落在松手的位置 (1036,608)，而不是被吸到角落 (1026,754)
  eq([dropped.left, dropped.top], ["1036px", "608px"],
     "松手停在原地，不做吸附", `left=${dropped.left} top=${dropped.top}`);
  ok(store.has("dsh-progress-panel:pos"), "位置写进了 localStorage", store.get("dsh-progress-panel:pos"));
  eq(JSON.parse(store.get("dsh-progress-panel:pos")), { x: 1036, y: 608 }, "存下来的就是落点");
  ok(!String(byClass(r.tree, "dshpp-fab")[0].props.className).includes("dragging"), "松手后去掉 dragging 类");

  console.log("\n-- 位置持久化 --");
  // 注意：组件在 factory 里就把 React 捕获住了，所以「新实例」只能靠清空 hook 来模拟，
  // 不能再造一个 mini-React（换了也不会被用上）。
  mini.unmount();
  ivs.clear();
  mini.reset();
  mini.setScheduler(() => { try { mini.render(reg.Comp); } catch (e) {} });
  const r2 = await drive(mini, reg.Comp);
  ok(!!byClass(r2.tree, "dshpp-fab")[0], "重新挂载后正常渲染");
  const st2 = byClass(r2.tree, "dshpp-fab")[0].props.style;
  eq([st2.left, st2.top], ["1036px", "608px"], "重新挂载后沿用存下来的位置");

  console.log("\n-- 按钮不触发拖拽 --");
  const before = JSON.stringify(store.get("dsh-progress-panel:pos"));
  r = await drive(mini, reg.Comp);
  byClass(r.tree, "dshpp-fab")[0].props.onPointerDown(
    pt(1100, 700, { closest: (s) => (s === "button" ? {} : null) }));
  byClass(r.tree, "dshpp-fab")[0].props.onPointerMove(pt(1200, 760));
  await settle(2);
  r = await drive(mini, reg.Comp);
  eq(JSON.stringify(store.get("dsh-progress-panel:pos")), before, "按在按钮上不会拖动悬浮窗");

  console.log("\n-- 完成 / 卡住 / 异常 --");
  global.__fakeTasks = [{
    task_id: "t-done", title: "刚跑完", status: "done", done: 10, total: 10, unit: "步",
    pct: 100, updated_at: Date.now() / 1000,
  }];
  r = await drive(mini, reg.Comp);
  ok(byClass(r.tree, "dshpp-bar")[0].props.className.includes("done"), "完成态进度条样式不同");

  global.__fakeTasks = [{
    task_id: "t-old", title: "很久以前", status: "done", done: 1, total: 1, pct: 100,
    updated_at: Date.now() / 1000 - 3600,
  }];
  r = await drive(mini, reg.Comp);
  eq(r.tree, null, "结束超过 1 分钟的任务自动隐藏悬浮窗");

  global.__fakeTasks = [{
    task_id: "t-stale", title: "卡住的任务", status: "running", done: 5, total: 100,
    unit: "页", pct: 5, eta_sec: null, updated_at: Date.now() / 1000, stale: true,
  }];
  r = await drive(mini, reg.Comp);
  byClass(r.tree, "dshpp-fab")[0].props.onPointerDown(pt(1100, 700));
  byClass(r.tree, "dshpp-fab")[0].props.onPointerUp(pt(1100, 700));
  await settle(4);
  r = await drive(mini, reg.Comp);
  ok(textOf(r.tree).includes("疑似卡住"), "卡片里标出「疑似卡住」");
  ok(!/ETA/.test(textOf(r.tree)), "stale 时不显示 ETA（免得给假数字）");

  global.fetch = async () => { throw new Error("ECONNREFUSED"); };
  global.__fakeTasks = [];
  r = await drive(mini, reg.Comp);
  eq(r.err, null, "fetch 全失败时渲染不抛异常");
  eq(r.tree, null, "中枢不可达时静默（不常驻报错）");

  mini.unmount();
  ivs.clear();

  console.log(`\n${fail === 0 ? "全部通过" : "存在失败"}：${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("× 测试自身异常：", e);
  process.exit(1);
});
