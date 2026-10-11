#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""进度中枢：一个只读的本地小服务，把 `.dsh-progress/` 里的进度暴露成 HTTP API。

它是两个东西的**唯一数据源**：
  * DSH Web 界面里的进度面板插件（跨端口 fetch，所以带 CORS 头）；
  * 内置的独立看板页 `http://127.0.0.1:8791/`（不想装插件时直接开这个）。

只读、只监听 127.0.0.1、不执行任何东西。

    python progress/hub.py                # 默认 127.0.0.1:8791
    python progress/hub.py --port 9000
    python progress/hub.py --dir D:\\some\\where\\.dsh-progress

各端口的占用情况会先探测一遍，默认从 8791 开始**自动挑一个空闲端口**，
并把最终端口写进 `<进度目录>/hub.json`，这样面板只要在 8791~8800 里探一遍就能找到它。

接口::

    GET /                 独立看板页（自动刷新）
    GET /api/tasks        所有任务的最新进度
    GET /api/tasks/<id>   {task, log:[...]}
    GET /api/health       存活探测
"""

from __future__ import annotations

import argparse
import json
import socket
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, str(Path(__file__).resolve().parent))
from progress import progress_dir, read_tasks, read_log, _fmt_dur  # noqa: E402

BASE_PORT = 8791
PORT_SPAN = 10          # 8791..8800，客户端也在这一段里探测
STATE: dict = {"dir": None, "started": time.time(), "port": None}


# --------------------------------------------------------------------------- #
# 独立看板页（不依赖任何前端框架）
# --------------------------------------------------------------------------- #
PAGE = r"""<!DOCTYPE html>
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
  .bar.cancel > i{background:var(--fg3)}
  .meta{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--fg2)}
  .pill{border:1px solid var(--line);border-radius:99px;padding:1px 9px;font-size:11px}
  .pill.running{color:var(--acc);border-color:var(--acc)}
  .pill.done{color:var(--ok);border-color:var(--ok)}
  .pill.failed{color:var(--bad);border-color:var(--bad)}
  .pill.stale{color:var(--warn);border-color:var(--warn)}
  button{background:#1e2532;color:var(--fg);border:1px solid var(--line);border-radius:8px;
         padding:5px 11px;font:12px inherit;cursor:pointer}
  button:hover{border-color:var(--acc);color:var(--acc)}
  pre{background:#0b0f16;border:1px solid var(--line);border-radius:8px;padding:10px;
      max-height:320px;overflow:auto;font:12px/1.5 ui-monospace,Consolas,monospace;
      color:var(--fg2);margin:10px 0 0;white-space:pre-wrap;word-break:break-all}
  .empty{color:var(--fg3);padding:40px 0;text-align:center}
  .err{background:#2a1416;border:1px solid #5c2b2f;color:#ffb4b4;border-radius:8px;padding:10px;margin-bottom:12px}
</style></head><body><div class="wrap">
<h1><span class="dot"></span>进度看板</h1>
<div class="sub" id="sub">连接中…</div>
<div id="err"></div>
<div id="list"></div>
</div>
<script>
const DIR = "__DIR__";
let expanded = new Set();
const fmt = (s) => s == null ? "—" : s < 60 ? Math.round(s)+"s"
  : s < 3600 ? Math.floor(s/60)+"m"+String(Math.round(s%60)).padStart(2,"0")+"s"
  : Math.floor(s/3600)+"h"+String(Math.floor((s%3600)/60)).padStart(2,"0")+"m";
const esc = (s) => String(s==null?"":s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

async function tick(){
  try{
    const r = await fetch("/api/tasks", {cache:"no-store"});
    const {tasks, now} = await r.json();
    document.getElementById("err").innerHTML = "";
    document.getElementById("sub").textContent =
      tasks.length ? `${tasks.length} 个任务 · ${new Date().toLocaleTimeString()}` : `暂无任务 · ${new Date().toLocaleTimeString()}`;
    const list = document.getElementById("list");
    if (!tasks.length){
      list.innerHTML = `<div class="empty">还没有任务在跑。<br><br>
        在脚本里 <code>from progress import Progress</code> 用起来，进度就会出现在这里。</div>`;
      return;
    }
    list.innerHTML = tasks.map(t => {
      const pct = t.pct == null ? null : Math.max(0, Math.min(100, t.pct));
      const cls = t.status === "done" ? "done" : t.status === "failed" ? "failed"
                : t.status === "cancelled" ? "cancel" : "";
      const stalePill = t.stale ? `<span class="pill stale">疑似卡住</span>` : "";
      const eta = t.status === "running" && !t.stale ? `ETA ${fmt(t.eta_sec)}` : "";
      const isOpen = expanded.has(t.task_id);
      return `<div class="card">
        <div class="row">
          <span class="title">${esc(t.title)}</span>
          <span class="pill ${esc(t.status)}">${esc(t.status)}</span>${stalePill}
          <span class="dim num" style="margin-left:auto">${t.done==null?"":(t.done+"/"+(t.total??"?"))} ${esc(t.unit||"")}</span>
          <button onclick="toggle('${esc(t.task_id)}')">${isOpen?"收起日志":"查看日志"}</button>
        </div>
        <div class="bar ${cls}"><i style="width:${pct==null?0:pct}%"></i></div>
        <div class="meta">
          <span class="num">${pct==null?"—":pct.toFixed(1)+"%"}</span>
          <span>已用 ${fmt(t.elapsed_sec)}</span>
          ${eta?`<span>${eta}</span>`:""}
          ${t.rate?`<span class="num">${t.rate.toFixed(2)} ${esc(t.unit||"")}/s</span>`:""}
          <span class="dim">${esc(t.message||"")}</span>
        </div>
        ${isOpen?`<pre id="log-${esc(t.task_id)}">加载中…</pre>`:""}
      </div>`;
    }).join("");
    for (const id of expanded){
      const el = document.getElementById("log-"+id);
      if (!el) continue;
      try{
        const r2 = await fetch("/api/tasks/"+encodeURIComponent(id)+"?tail=200", {cache:"no-store"});
        const d = await r2.json();
        el.textContent = (d.log||[]).join("\n") || "（没有日志）";
        el.scrollTop = el.scrollHeight;
      }catch(e){ el.textContent = "日志读取失败"; }
    }
  }catch(e){
    document.getElementById("err").innerHTML =
      `<div class="err">连不上进度中枢：${esc(e.message)}</div>`;
  }
}
function toggle(id){ expanded.has(id) ? expanded.delete(id) : expanded.add(id); tick(); }
tick(); setInterval(tick, 1500);
</script></body></html>
"""


class Handler(BaseHTTPRequestHandler):
    server_version = "dsh-progress-hub"

    def log_message(self, fmt, *args):        # 静音默认访问日志
        pass

    # ------------------------------------------------------------------ 工具
    def _send(self, code: int, body: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        # 面板跑在 DSH 页面（另一个端口），必须放开 CORS
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, code: int = 200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    # ------------------------------------------------------------------ 路由
    def do_OPTIONS(self):                      # CORS 预检
        self._send(204, b"", "text/plain")

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        u = urlparse(self.path)
        path, q = u.path, parse_qs(u.query)
        d = STATE["dir"]

        if path in ("/", "/index.html"):
            html = PAGE.replace("__DIR__", str(d).replace("\\", "\\\\"))
            self._send(200, html.encode("utf-8"), "text/html; charset=utf-8")
            return

        if path == "/api/health":
            self._json({"ok": True, "dir": str(d), "uptime_sec": time.time() - STATE["started"]})
            return

        if path == "/api/tasks":
            self._json({"tasks": read_tasks(d), "now": time.time(), "dir": str(d)})
            return

        if path.startswith("/api/tasks/"):
            task_id = u.path[len("/api/tasks/"):].strip("/")
            if not task_id:
                self._json({"error": "missing task id"}, 400)
                return
            try:
                tail = max(1, min(2000, int(q.get("tail", ["200"])[0])))
            except ValueError:
                tail = 200
            task = next((t for t in read_tasks(d) if t.get("task_id") == task_id), None)
            if task is None:
                self._json({"error": f"no such task: {task_id}"}, 404)
                return
            self._json({"task": task, "log": read_log(task_id, tail=tail, directory=d)})
            return

        self._json({"error": "not found"}, 404)


def port_in_use(port: int, host: str = "127.0.0.1") -> bool:
    """能不能连上？能连上就说明有人占了。比 SO_REUSEADDR 那套可靠。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.35)
        return s.connect_ex((host, port)) == 0


def pick_port(start: int) -> int:
    for p in range(start, start + PORT_SPAN):
        if not port_in_use(p):
            return p
    raise SystemExit(f"{start}~{start + PORT_SPAN - 1} 全被占用了，用 --port 指定别的端口")


def write_hub_file(d: Path, host: str, port: int) -> None:
    """把实际端口写到进度目录，方便人肉排查（面板是靠自己探端口，不读这个文件）。"""
    try:
        d.mkdir(parents=True, exist_ok=True)
        tmp = d / "hub.json.tmp"
        tmp.write_text(json.dumps({
            "url": f"http://{host}:{port}/", "host": host, "port": port,
            "pid": __import__("os").getpid(), "started_at": STATE["started"],
        }, ensure_ascii=False), encoding="utf-8")
        __import__("os").replace(tmp, d / "hub.json")
    except OSError:
        pass


def find_running_hub(host: str = "127.0.0.1") -> int | None:
    """扫一遍 8791~8800，看是不是已经有一个中枢在跑。

    有的话就没必要再起一个：端口会越占越多，面板探到哪个也不确定。
    """
    import urllib.request
    for p in range(BASE_PORT, BASE_PORT + PORT_SPAN):
        if not port_in_use(p, host):
            continue
        try:
            with urllib.request.urlopen(f"http://{host}:{p}/api/health", timeout=0.6) as r:
                info = json.loads(r.read().decode("utf-8"))
            if info.get("ok"):
                return p
        except Exception:
            continue          # 这个端口上的东西不是我们
    return None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="进度中枢（只读本地服务）")
    ap.add_argument("--host", default="127.0.0.1", help="默认只监听本机")
    ap.add_argument("--port", type=int, default=None,
                    help=f"起始端口；被占用时自动往后找（默认 {BASE_PORT}）")
    ap.add_argument("--dir", default=None, help="进度目录（默认 工作区/.dsh-progress）")
    ap.add_argument("--allow-multiple", action="store_true",
                    help="就算已经有一个在跑也再起一个")
    args = ap.parse_args(argv)

    STATE["dir"] = Path(args.dir).resolve() if args.dir else progress_dir()

    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    # 只在「用户没有明确指定端口」时才做重复检查。
    # 明确给了 --port 就是有意要起一个独立的实例（测试、或临时换个目录看数据）。
    if not args.allow_multiple and args.port is None:
        running = find_running_hub(args.host)
        if running is not None:
            print(f"已经有一个进度中枢在跑了： http://{args.host}:{running}/")
            print("（这次什么都不用做；确实要再起一个就加 --allow-multiple）")
            return 0

    start = args.port or BASE_PORT
    port = pick_port(start)
    if port != start:
        print(f"端口 {start} 被占用，改用 {port}")

    srv = ThreadingHTTPServer((args.host, port), Handler)
    STATE["port"] = port
    write_hub_file(STATE["dir"], args.host, port)

    print(f"进度中枢已启动： http://{args.host}:{port}/")
    print(f"  进度目录： {STATE['dir']}")
    print(f"  API：      /api/tasks  ·  /api/tasks/<id>?tail=200  ·  /api/health")
    print("  Ctrl+C 停止")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        srv.server_close()
        try:                                   # 退出时清掉 hub.json，别留误导信息
            (STATE["dir"] / "hub.json").unlink(missing_ok=True)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
