/**
 * 独立看板页 —— 服务自带的那个 `http://127.0.0.1:8791/`。
 *
 * 和悬浮窗读同一份数据。不装插件、不开 DSH 的时候，浏览器直接开这个页面就能看进度；
 * 也是排查问题时最快的自检手段（打不开就说明服务没起来）。
 *
 * 纯字符串，没有构建步骤，不依赖任何前端库。
 */

export const BOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>进度看板</title>
<style>
  :root{--bg:#0e1117;--card:#161b25;--line:#2a3242;--fg:#e6edf3;--fg2:#9aa7b8;--fg3:#6b7788;
        --acc:#7c9cff;--ok:#3fb950;--warn:#d29922;--bad:#f85149}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
       font:14px/1.55 "Segoe UI","Microsoft YaHei",system-ui,sans-serif}
  .wrap{max-width:1100px;margin:0 auto;padding:20px}
  h1{font-size:16px;margin:0 0 4px;display:flex;align-items:center;gap:8px}
  h1 .dot{width:9px;height:9px;border-radius:50%;background:linear-gradient(135deg,var(--acc),#a78bfa)}
  .sub{color:var(--fg3);font-size:12px;margin-bottom:16px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:12px}
  .row{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
  .title{font-weight:600}
  .dim{color:var(--fg3)}
  .num{font-variant-numeric:tabular-nums}
  .bar{height:8px;background:#232b3a;border-radius:99px;overflow:hidden;margin:10px 0 8px}
  .bar > i{display:block;height:100%;background:linear-gradient(90deg,var(--acc),#a78bfa);transition:width .3s}
  .bar.done > i{background:var(--ok)} .bar.failed > i{background:var(--bad)}
  .bar.cancelled > i{background:var(--fg3)}
  .meta{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--fg2)}
  .pill{border:1px solid var(--line);border-radius:99px;padding:1px 9px;font-size:11px}
  .pill.running{color:var(--acc);border-color:var(--acc)}
  .pill.done{color:var(--ok);border-color:var(--ok)}
  .pill.failed{color:var(--bad);border-color:var(--bad)}
  .pill.cancelled{color:var(--fg3)}
  .pill.stale{color:var(--warn);border-color:var(--warn)}
  button{background:#1e2532;color:var(--fg);border:1px solid var(--line);border-radius:8px;
         padding:5px 11px;font:12px inherit;cursor:pointer}
  button:hover{border-color:var(--acc);color:var(--acc)}
  pre{background:#0b0f16;border:1px solid var(--line);border-radius:8px;padding:10px;
      max-height:320px;overflow:auto;font:12px/1.5 ui-monospace,Consolas,monospace;
      color:var(--fg2);margin:10px 0 0;white-space:pre-wrap;word-break:break-all}
  .empty{color:var(--fg3);padding:40px 0;text-align:center;line-height:2}
  code{background:#0b0f16;border:1px solid var(--line);border-radius:5px;padding:1px 6px;font-size:12px}
  .err{background:#2a1416;border:1px solid #5c2b2f;color:#ffb4b4;border-radius:8px;padding:10px;margin-bottom:12px}
</style></head><body><div class="wrap">
<h1><span class="dot"></span>进度看板</h1>
<div class="sub" id="sub">连接中…</div>
<div id="err"></div>
<div id="list"></div>
</div>
<script>
const DIR = "__DIR__";
const expanded = new Set();
// 接口和这个页面同源（都挂在宿主的 webserver 上），直接打相对路径
const API = "/api/progress";
const fmt = (s) => s == null ? "—" : s < 60 ? Math.round(s)+"s"
  : s < 3600 ? Math.floor(s/60)+"m"+String(Math.round(s%60)).padStart(2,"0")+"s"
  : Math.floor(s/3600)+"h"+String(Math.floor((s%3600)/60)).padStart(2,"0")+"m";
const esc = (s) => String(s==null?"":s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

async function tick(){
  try{
    const r = await fetch(API + "/tasks", {cache:"no-store"});
    const {tasks} = await r.json();
    document.getElementById("err").innerHTML = "";
    document.getElementById("sub").textContent =
      tasks.length ? \`\${tasks.length} 个任务 · \${new Date().toLocaleTimeString()}\`
                   : \`暂无任务 · \${new Date().toLocaleTimeString()}\`;
    const list = document.getElementById("list");
    if (!tasks.length){
      list.innerHTML = \`<div class="empty">还没有任务在跑。<br>
        进度目录：<code>\${esc(DIR)}</code><br><br>
        让脚本往这里写进度即可，例如 <code>from progress import Progress</code></div>\`;
      return;
    }
    list.innerHTML = tasks.map(t => {
      const pct = t.pct == null ? null : Math.max(0, Math.min(100, t.pct));
      const cls = t.status === "done" ? "done" : t.status === "failed" ? "failed"
                : t.status === "cancelled" ? "cancelled" : "";
      const stalePill = t.stale ? '<span class="pill stale">疑似卡住</span>' : "";
      const eta = t.status === "running" && !t.stale ? "ETA " + fmt(t.eta_sec) : "";
      const isOpen = expanded.has(t.task_id);
      return \`<div class="card">
        <div class="row">
          <span class="title">\${esc(t.title || t.task_id)}</span>
          <span class="pill \${esc(t.status)}">\${esc(t.status)}</span>\${stalePill}
          <span class="dim num" style="margin-left:auto">\${t.done==null?"":(t.done+"/"+(t.total??"?"))} \${esc(t.unit||"")}</span>
          <button onclick="toggle('\${esc(t.task_id)}')">\${isOpen?"收起日志":"查看日志"}</button>
        </div>
        <div class="bar \${cls}"><i style="width:\${pct==null?0:pct}%"></i></div>
        <div class="meta">
          <span class="num">\${pct==null?"—":pct.toFixed(1)+"%"}</span>
          <span>已用 \${fmt(t.elapsed_sec)}</span>
          \${eta?\`<span>\${eta}</span>\`:""}
          \${t.rate?\`<span class="num">\${t.rate.toFixed(2)} \${esc(t.unit||"")}/s</span>\`:""}
          <span class="dim">\${esc(t.message||"")}</span>
        </div>
        \${isOpen?\`<pre id="log-\${esc(t.task_id)}">加载中…</pre>\`:""}
      </div>\`;
    }).join("");
    for (const id of expanded){
      const el = document.getElementById("log-"+id);
      if (!el) continue;
      try{
        const r2 = await fetch(API + "/tasks/"+encodeURIComponent(id)+"?tail=200", {cache:"no-store"});
        const d = await r2.json();
        el.textContent = (d.log||[]).join("\\n") || "（没有日志）";
        el.scrollTop = el.scrollHeight;
      }catch(e){ el.textContent = "日志读取失败"; }
    }
  }catch(e){
    document.getElementById("err").innerHTML =
      \`<div class="err">连不上进度服务：\${esc(e.message)}</div>\`;
  }
}
function toggle(id){ expanded.has(id) ? expanded.delete(id) : expanded.add(id); tick(); }
tick(); setInterval(tick, 1500);
</script></body></html>
`;
