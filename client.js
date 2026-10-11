/**
 * DSH 进度面板 —— 浏览器那一半（悬浮窗版）。
 *
 * 注册进 `shell.overlay` 槽位，在界面上画一个**可拖拽的悬浮控件**：
 *   · 收起时是一颗小药丸：状态点 + 任务名 + 迷你进度条 + 百分比
 *   · 点一下展开成卡片：进度条、已完成/总数、速率、ETA、最新消息、可滚动的日志尾巴
 *   · 按住可以拖走，松手自动吸附到最近的角，位置记在 localStorage
 *
 * 参考了 dsh-whale-widget 的观感（右下角悬浮、可拖动、吸附、z-index 很高），
 * 但没有沿用它的做法——鲸鱼是把脚本注入每个页面直接改 DOM，
 * 而官方文档明确不建议在组件外写 DOM。这里走的是**正规槽位**，
 * 所以主题变量、深浅色切换、卸载清理都是宿主管的。
 *
 * 定位用 `position: fixed`。这是被验证过的：宿主自带的 Toast
 * （同样注册在 shell.overlay）用的就是 `position:fixed; z-index:1100`。
 *
 * 两处交互上的讲究（都是踩过坑之后加的）：
 *   1. **拖拽不动 React**。pointermove 里直接写 element.style，并且用 rAF 合并，
 *      松手才 setState。原先每次移动都 setState 会让整棵树重渲染，手感很僵。
 *   2. **尺寸一变就重新贴边**。展开时卡片比药丸高得多，如果只认左上角坐标就会冲出屏幕；
 *      这里在 useLayoutEffect 里量完尺寸，让「贴着的那条边」不动、朝屏幕内生长，最后再夹一次。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-progress-panel',

  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PORT_FIRST = 8791;
    const PORT_LAST = 8800;
    const POLL_MS = 1500;
    const SHOW_DONE_FOR_MS = 60000;   // 完成/失败后再留 1 分钟，好看到收尾
    const LOG_TAIL = 200;
    const POS_KEY = 'dsh-progress-panel:pos';
    const MARGIN = 14;
    const DEFAULT_BOTTOM = 190;       // 默认离底边这么高，避开右下角的小鲸鱼
    const Z = 9600;                   // 比宿主 Toast(1100) 高，比鲸鱼(9999) 低
    const DRAG_SLOP = 4;              // 位移小于这个像素算「点击」而不是「拖拽」
    const EDGE = 4;                   // 拖拽时的最小贴边留白

    // 主题变量一律带兜底值：token 改名最多让样式退化，不会渲染崩
    const V = {
      fg:    'var(--dsw-alias-label-primary, #e6edf3)',
      fg2:   'var(--dsw-alias-label-secondary, #9aa7b8)',
      fg3:   'var(--dsw-alias-label-tertiary, #6b7788)',
      line:  'var(--dsw-alias-border-l2, #2a3242)',
      bg:    'var(--dsw-alias-bg-layer-1, #161b25)',
      bg2:   'var(--dsw-alias-bg-layer-2, #1e2532)',
      code:  'var(--dsw-alias-markdown-code-block, #0b0f16)',
      acc:   'var(--dsw-alias-state-business-primary, #7c9cff)',
      ok:    'var(--dsw-alias-state-success-primary, #3fb950)',
      warn:  'var(--dsw-alias-state-warn-primary, #d29922)',
      err:   'var(--dsw-alias-state-error-primary, #f85149)',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(124,156,255,.12))',
    };

    const CSS = `
.dshpp-fab{position:fixed;z-index:${Z};font-size:12px;line-height:1.5;color:${V.fg};
  font-family:inherit;background:${V.bg};border:1px solid ${V.line};border-radius:12px;
  box-shadow:0 6px 24px rgba(0,0,0,.28);user-select:none;-webkit-user-select:none;
  touch-action:none;overflow:hidden;transition:box-shadow .15s ease}
.dshpp-fab:hover{box-shadow:0 8px 28px rgba(0,0,0,.36)}
.dshpp-fab.dragging{box-shadow:0 14px 40px rgba(0,0,0,.45);cursor:grabbing}
.dshpp-fab.dragging .dshpp-dot{animation:none}
.dshpp-pill{display:flex;align-items:center;gap:8px;padding:6px 10px;cursor:grab;min-width:0}
.dshpp-pill:active{cursor:grabbing}
.dshpp-card{width:330px;max-height:calc(100vh - ${MARGIN * 2}px);display:flex;flex-direction:column;
  cursor:grab}
.dshpp-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid ${V.line};
  flex:0 0 auto}
.dshpp-body{padding:8px 10px 10px;cursor:default;user-select:text;-webkit-user-select:text;
  overflow:auto;min-height:0}
.dshpp-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:${V.fg3}}
.dshpp-dot.running{background:${V.acc};animation:dshpp-pulse 1.6s ease-in-out infinite}
.dshpp-dot.done{background:${V.ok}}
.dshpp-dot.failed{background:${V.err}}
@keyframes dshpp-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.dshpp-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1 1 auto;min-width:0}
.dshpp-bar{flex:0 0 54px;height:5px;border-radius:99px;background:${V.bg2};overflow:hidden}
.dshpp-card .dshpp-bar{flex:1 1 auto;height:7px;margin:0}
.dshpp-bar>i{display:block;height:100%;background:${V.acc};transition:width .3s ease}
.dshpp-bar.done>i{background:${V.ok}}
.dshpp-bar.failed>i{background:${V.err}}
.dshpp-bar.cancelled>i{background:${V.fg3}}
.dshpp-num{font-variant-numeric:tabular-nums;color:${V.fg2};white-space:nowrap;flex:0 0 auto}
.dshpp-pct{font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap;flex:0 0 auto}
.dshpp-more{color:${V.fg3};font-size:11px;flex:0 0 auto}
.dshpp-btn{background:transparent;border:1px solid ${V.line};color:${V.fg2};border-radius:6px;
  padding:1px 7px;font:inherit;font-size:11px;cursor:pointer;flex:0 0 auto}
.dshpp-btn:hover{border-color:${V.acc};color:${V.acc}}
.dshpp-task{padding:7px 0;border-bottom:1px solid ${V.line}}
.dshpp-task:last-child{border-bottom:none;padding-bottom:0}
.dshpp-row{display:flex;align-items:center;gap:8px;min-width:0}
.dshpp-meta{display:flex;gap:10px;flex-wrap:wrap;color:${V.fg3};font-size:11px;margin-top:5px}
.dshpp-msg{color:${V.fg3};font-size:11px;margin-top:4px;word-break:break-all}
.dshpp-stale{color:${V.warn}}
.dshpp-log{margin:7px 0 0;padding:7px 9px;border:1px solid ${V.line};border-radius:7px;
  background:${V.code};color:${V.fg2};max-height:190px;overflow:auto;
  font:11px/1.5 ui-monospace,Consolas,"Cascadia Mono",monospace;white-space:pre-wrap;
  word-break:break-all;user-select:text}
`;

    const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

    const fmtDur = (s) => {
      if (s == null || !isFinite(s) || s < 0) return '—';
      s = Math.round(s);
      if (s < 60) return s + 's';
      if (s < 3600) return Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's';
      return Math.floor(s / 3600) + 'h' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + 'm';
    };
    const fmtNum = (n) => (typeof n === 'number' && isFinite(n) ? n.toLocaleString('en-US') : '?');

    function loadPos() {
      try {
        const raw = localStorage.getItem(POS_KEY);
        if (!raw) return null;
        const p = JSON.parse(raw);
        return (p && typeof p.x === 'number' && typeof p.y === 'number') ? p : null;
      } catch (e) { return null; }
    }
    function savePos(p) {
      try { localStorage.setItem(POS_KEY, JSON.stringify({ x: Math.round(p.x), y: Math.round(p.y) })); } catch (e) {}
    }

    /** 中枢可能落在 8791~8800 里的任意一个，逐个探活后缓存。 */
    async function discoverHub() {
      for (let p = PORT_FIRST; p <= PORT_LAST; p++) {
        const base = 'http://127.0.0.1:' + p;
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 700);
        try {
          const res = await fetch(base + '/api/health', { signal: ctl.signal, cache: 'no-store' });
          if (res.ok) {
            const info = await res.json();
            if (info && info.ok) return base;
          }
        } catch (e) {
          /* 这个端口没有，试下一个 */
        } finally {
          clearTimeout(timer);
        }
      }
      return null;
    }

    function pickVisible(tasks, nowMs) {
      const now = nowMs / 1000;
      return (tasks || []).filter((t) => {
        if (!t || !t.task_id) return false;
        if (t.status === 'running') return true;
        return (now - (t.updated_at || 0)) * 1000 < SHOW_DONE_FOR_MS;
      });
    }

    function Panel() {
      const [hub, setHub] = React.useState(null);
      const [probed, setProbed] = React.useState(false);
      const [tasks, setTasks] = React.useState([]);
      const [open, setOpen] = React.useState(false);
      const [logId, setLogId] = React.useState(null);
      const [log, setLog] = React.useState([]);
      const [pos, setPos] = React.useState(loadPos);
      const [dragging, setDragging] = React.useState(false);
      const rootRef = React.useRef(null);
      const dragRef = React.useRef(null);
      const sizeRef = React.useRef({ w: 0, h: 0 });
      const winRef = React.useRef({ w: 0, h: 0 });
      const rafRef = React.useRef(0);
      const aliveRef = React.useRef(true);

      React.useEffect(() => {
        aliveRef.current = true;
        discoverHub().then((base) => {
          if (!aliveRef.current) return;
          setHub(base);
          setProbed(true);
        });
        return () => { aliveRef.current = false; };
      }, []);

      React.useEffect(() => {
        if (!hub) return undefined;
        let stop = false;
        const tick = async () => {
          try {
            const res = await fetch(hub + '/api/tasks', { cache: 'no-store' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            if (!stop) setTasks(pickVisible(data.tasks, Date.now()));
          } catch (e) {
            if (!stop) setHub(null);   // 中枢没了就回到静默
          }
        };
        tick();
        const id = setInterval(tick, POLL_MS);
        return () => { stop = true; clearInterval(id); };
      }, [hub]);

      React.useEffect(() => {
        if (!hub || !logId) { setLog([]); return undefined; }
        let stop = false;
        const tick = async () => {
          try {
            const res = await fetch(hub + '/api/tasks/' + encodeURIComponent(logId)
                                    + '?tail=' + LOG_TAIL, { cache: 'no-store' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            if (!stop) setLog(Array.isArray(data.log) ? data.log : []);
          } catch (e) { /* 下一轮再试 */ }
        };
        tick();
        const id = setInterval(tick, POLL_MS);
        return () => { stop = true; clearInterval(id); };
      }, [hub, logId]);

      // 位置变了就记下来
      React.useEffect(() => {
        if (pos) savePos(pos);
      }, [pos && pos.x, pos && pos.y]);

      /**
       * 量完尺寸之后重新摆位。要点：
       *   · 没拖过 → 贴右下角（抬高避开鲸鱼）
       *   · 尺寸变了 → 让「贴着的那条边」不动，朝屏幕内生长（贴右就往左长、贴下就往上长）
       *   · 最后无论怎样都夹一次，保证整个窗口在屏幕里
       * 用 useLayoutEffect：在浏览器绘制前跑完，所以看不到跳一下。
       */
      React.useLayoutEffect(() => {
        const el = rootRef.current;
        if (!el) return;
        const w = el.offsetWidth, hh = el.offsetHeight;
        if (!w || !hh) return;
        const W = window.innerWidth, H = window.innerHeight;
        const prev = sizeRef.current, prevWin = winRef.current;
        const sizeChanged = prev.w !== w || prev.h !== hh;
        const winChanged = prevWin.w !== W || prevWin.h !== H;
        if (!sizeChanged && !winChanged) return;
        sizeRef.current = { w, h: hh };
        winRef.current = { w: W, h: H };

        setPos((p) => {
          let x, y;
          if (!p) {
            x = W - w - MARGIN;
            y = H - hh - DEFAULT_BOTTOM;
          } else {
            x = p.x; y = p.y;
            if (sizeChanged && prev.w > 0 && prev.h > 0) {
              const dw = w - prev.w, dh = hh - prev.h;
              if (dw && (x + prev.w / 2) > W / 2) x -= dw;   // 贴右边 → 往左长
              if (dh && (y + prev.h / 2) > H / 2) y -= dh;   // 贴下边 → 往上长
            }
          }
          x = clamp(x, MARGIN, Math.max(MARGIN, W - w - MARGIN));
          y = clamp(y, MARGIN, Math.max(MARGIN, H - hh - MARGIN));
          if (p && p.x === x && p.y === y) return p;   // 没变就别触发重渲染
          return { x, y };
        });
      });

      React.useEffect(() => () => {                       // 卸载时收掉没跑完的那一帧
        if (rafRef.current && typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(rafRef.current);
        }
        rafRef.current = 0;
      }, []);

      /* ---------------- 拖拽 ---------------- */
      // 直接把坐标写到 DOM 上，不走 React —— 手感的关键
      const paint = (x, y) => {
        const el = rootRef.current;
        if (el) { el.style.left = x + 'px'; el.style.top = y + 'px'; }
      };

      const onPointerDown = (e) => {
        if (e.button !== 0) return;
        if (e.target && e.target.closest && e.target.closest('button')) return;
        const el = rootRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        dragRef.current = {
          dx: e.clientX - r.left, dy: e.clientY - r.top,
          w: r.width, h: r.height, x: r.left, y: r.top,
          sx: e.clientX, sy: e.clientY, moved: false,
        };
        try { el.setPointerCapture(e.pointerId); } catch (err) {}
        e.preventDefault();
      };

      const onPointerMove = (e) => {
        const d = dragRef.current;
        if (!d) return;
        if (!d.moved) {
          if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) < DRAG_SLOP) return;
          d.moved = true;
          setDragging(true);
        }
        d.x = clamp(e.clientX - d.dx, EDGE, Math.max(EDGE, window.innerWidth - d.w - EDGE));
        d.y = clamp(e.clientY - d.dy, EDGE, Math.max(EDGE, window.innerHeight - d.h - EDGE));
        // 一帧只画一次，中间那些 move 直接丢掉
        if (rafRef.current) return;
        if (typeof requestAnimationFrame !== 'function') { paint(d.x, d.y); return; }
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = 0;
          const dd = dragRef.current;
          if (dd) paint(dd.x, dd.y);
        });
      };

      const onPointerUp = (e) => {
        const d = dragRef.current;
        if (!d) return;
        dragRef.current = null;
        if (rafRef.current) {
          if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafRef.current);
          rafRef.current = 0;
        }
        const el = rootRef.current;
        try { if (el) el.releasePointerCapture(e.pointerId); } catch (err) {}
        if (dragging) setDragging(false);
        if (!d.moved) { setOpen((v) => !v); return; }   // 没怎么动 → 当成点击

        // 吸附到最近的角。尺寸以此刻的真实 DOM 为准（拖拽中可能展开过）
        const w = el && el.offsetWidth ? el.offsetWidth : d.w;
        const hh = el && el.offsetHeight ? el.offsetHeight : d.h;
        const W = window.innerWidth, H = window.innerHeight;
        const corners = [
          { x: MARGIN, y: MARGIN },
          { x: W - w - MARGIN, y: MARGIN },
          { x: MARGIN, y: H - hh - MARGIN },
          { x: W - w - MARGIN, y: H - hh - MARGIN },
        ];
        let best = corners[0], bestD = Infinity;
        for (const c of corners) {
          const dd = (c.x - d.x) * (c.x - d.x) + (c.y - d.y) * (c.y - d.y);
          if (dd < bestD) { bestD = dd; best = c; }
        }
        paint(best.x, best.y);
        setPos(best);
      };

      const toggleLog = (id) => {
        if (logId === id) { setLogId(null); return; }
        setLog([]);
        setLogId(id);
      };

      /* ---------------- 渲染 ---------------- */
      try {
        if (!probed || !hub || tasks.length === 0) return null;

        const primary = tasks[0];
        const pctOf = (t) => (t.pct == null ? null : clamp(t.pct, 0, 100));
        const barCls = (t) => {
          const s = String(t.status || 'running');
          return 'dshpp-bar' + (s === 'running' ? '' : ' ' + s);
        };

        // 拖拽中用 dragRef 的实时坐标，避免这期间的轮询重渲染把窗口拽回去
        const d = dragRef.current;
        const live = (dragging && d) ? { left: d.x + 'px', top: d.y + 'px' }
                   : pos ? { left: pos.x + 'px', top: pos.y + 'px' }
                   : { visibility: 'hidden', left: '0px', top: '0px' };

        let body;
        if (!open) {
          const pct = pctOf(primary);
          body = h('div', { className: 'dshpp-pill', title: (primary.title || primary.task_id) + '（点一下展开，按住可以拖走）' },
            h('span', { className: 'dshpp-dot ' + String(primary.status || 'running') }),
            h('span', { className: 'dshpp-title' }, String(primary.title || primary.task_id)),
            h('span', { className: barCls(primary) },
              h('i', { style: { width: (pct == null ? 0 : pct) + '%' } })),
            h('span', { className: 'dshpp-pct' }, pct == null ? '—' : pct.toFixed(0) + '%'),
            tasks.length > 1 ? h('span', { className: 'dshpp-more' }, '+' + (tasks.length - 1)) : null,
          );
        } else {
          const rows = [];
          for (const t of tasks) {
            const pct = pctOf(t);
            const st = String(t.status || 'running');
            const isOpenLog = logId === t.task_id;
            const eta = (st === 'running' && !t.stale && t.eta_sec != null) ? ('ETA ' + fmtDur(t.eta_sec)) : null;
            rows.push(h('div', { className: 'dshpp-task', key: 't-' + t.task_id },
              h('div', { className: 'dshpp-row' },
                h('span', { className: 'dshpp-dot ' + st }),
                h('span', { className: 'dshpp-title' }, String(t.title || t.task_id)),
                h('span', { className: 'dshpp-pct' }, pct == null ? '—' : pct.toFixed(1) + '%'),
                h('button', { className: 'dshpp-btn', onClick: () => toggleLog(t.task_id) },
                  isOpenLog ? '收起' : '日志'),
              ),
              h('div', { className: 'dshpp-row', style: { marginTop: '6px' } },
                h('span', { className: barCls(t) }, h('i', { style: { width: (pct == null ? 0 : pct) + '%' } })),
              ),
              h('div', { className: 'dshpp-meta' },
                h('span', null, fmtNum(t.done) + '/' + fmtNum(t.total) + (t.unit ? ' ' + t.unit : '')),
                t.rate ? h('span', null, t.rate.toFixed(2) + (t.unit ? ' ' + t.unit : '') + '/s') : null,
                eta ? h('span', null, eta) : null,
                t.stale ? h('span', { className: 'dshpp-stale' }, '疑似卡住') : null,
              ),
              t.message ? h('div', { className: 'dshpp-msg' }, String(t.message)) : null,
              isOpenLog ? h('pre', { className: 'dshpp-log' },
                (log.length ? log.join('\n') : '（暂无日志）')) : null,
            ));
          }
          body = h('div', { className: 'dshpp-card' },
            h('div', { className: 'dshpp-head' },
              h('span', { className: 'dshpp-dot running' }),
              h('span', { className: 'dshpp-title' }, '任务进度'),
              h('span', { className: 'dshpp-num' }, tasks.length + ' 个'),
              h('button', { className: 'dshpp-btn', onClick: () => setOpen(false) }, '收起'),
            ),
            h('div', { className: 'dshpp-body' }, rows),
          );
        }

        return h('div', {
          className: 'dshpp-fab' + (dragging ? ' dragging' : '') + (open ? ' open' : ''),
          style: live,
          ref: rootRef,
          onPointerDown,
          onPointerMove,
          onPointerUp,
        }, h('style', null, CSS), body);
      } catch (err) {
        console.error('[dsh-progress-panel] 渲染失败，已跳过本次渲染：', err);
        return null;
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        console.info('[dsh-progress-panel] 已加载（悬浮窗版）；进度中枢请在 127.0.0.1:'
                     + PORT_FIRST + '-' + PORT_LAST + ' 上运行 hub/hub.py');
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-progress-panel',
          order: 50,
        }, Panel));
      },
    };
  },
});
