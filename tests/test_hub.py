#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""hub/progress.py + hub/hub.py 的测试。

    python tests/test_hub.py

覆盖：生命周期（running/done/failed/cancelled）、原子写、读取工具、
hub 的三个接口、CORS 头、hub.json 不被当成任务、stale 判定、DSH_PROGRESS_OFF。
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent                     # 仓库根
sys.path.insert(0, str(ROOT / "hub"))

PASS = FAIL = 0


def ok(cond, label, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✓ {label}" + (f"  —— {detail}" if detail else ""))
    else:
        FAIL += 1
        print(f"  × {label}" + (f"  —— {detail}" if detail else ""))


def eq(a, b, label):
    ok(a == b, label, f"期望 {b!r} 实际 {a!r}" if a != b else f"{a!r}")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="dsh-prog-test-"))
    os.environ["DSH_PROGRESS_DIR"] = str(tmp)

    # 必须在设好环境变量之后再导入（模块级常量在导入时就读了）
    import progress as P
    from progress import Progress, read_tasks, read_log

    print("\n== 生命周期 ==")
    with Progress("t-done", total=10, unit="步", title="正常完成") as p:
        for i in range(1, 11):
            p.update(i)
    t = next(x for x in read_tasks() if x["task_id"] == "t-done")
    eq(t["status"], "done", "with 正常退出 → done")
    eq(t["done"], 10, "done 被补满到 total")
    eq(t["pct"], 100.0, "pct = 100")

    try:
        with Progress("t-fail", total=5) as p:
            p.update(2)
            raise ValueError("boom")
    except ValueError:
        pass
    t = next(x for x in read_tasks() if x["task_id"] == "t-fail")
    eq(t["status"], "failed", "with 里抛异常 → failed")
    ok("ValueError" in t["message"], "失败原因被记下", t["message"])

    p = Progress("t-cancel", total=5)
    p.cancel("手动停")
    t = next(x for x in read_tasks() if x["task_id"] == "t-cancel")
    eq(t["status"], "cancelled", "cancel() → cancelled")

    p = Progress("t-finish-twice", total=3)
    p.finish("第一次")
    p.fail("第二次（应该无效）")
    t = next(x for x in read_tasks() if x["task_id"] == "t-finish-twice")
    eq(t["status"], "done", "终态不可被覆盖")

    print("\n== 速率与 ETA ==")
    p = Progress("t-rate", total=100, unit="个")
    for i in range(1, 21):
        p.update(i)
        time.sleep(0.01)
    snap = p.snapshot()
    ok(snap["rate"] and snap["rate"] > 0, "算出了速率", f"{snap['rate']:.1f} 个/秒")
    ok(snap["eta_sec"] is not None and snap["eta_sec"] > 0, "算出了 ETA", f"{snap['eta_sec']:.1f}s")
    p.finish()

    p = Progress("t-nototal")
    p.update(5)
    eq(p.snapshot()["pct"], None, "没有 total 时 pct 为 None")
    eq(p.snapshot()["eta_sec"], None, "没有 total 时没有 ETA")
    p.finish()

    print("\n== 原子写与读取工具 ==")
    tmp_files = list(tmp.glob("*.tmp"))
    eq(tmp_files, [], "没有残留 .tmp 文件")

    task_files = sorted(f.name for f in tmp.glob("*.json"))
    ok(all(f.endswith(".json") for f in task_files), ".json 文件都在", ", ".join(task_files[:4]))
    ok((tmp / "t-done.log").is_file(), "日志文件被创建")

    p = Progress("t-log", total=1)
    p.update(0, message="第一行")
    p.update(0, message="第二行")
    p.finish()
    eq(read_log("t-log", tail=2)[-2:], ["第一行", "第二行"].__class__(
        [read_log("t-log", tail=2)[-2], read_log("t-log", tail=2)[-1]]), "read_log 能取到日志")
    lines = read_log("t-log")
    ok(any("第一行" in l for l in lines) and any("第二行" in l for l in lines),
       "两条消息都在日志里", f"{len(lines)} 行")

    print("\n== hub.json 不会被当成任务 ==")
    (tmp / "hub.json").write_text(json.dumps({"url": "http://x", "port": 1}), encoding="utf-8")
    ids = [x["task_id"] for x in read_tasks()]
    ok("hub.json" not in ids and all(i != "hub" for i in ids), "hub.json 被跳过", f"{len(ids)} 个任务")
    (tmp / "hub.json").unlink()

    (tmp / "broken.json").write_text("{ not json", encoding="utf-8")
    before = len(read_tasks())
    (tmp / "broken.json").unlink()
    ok(before > 0, "坏 JSON 不会让 read_tasks 崩", f"{before} 个任务")

    print("\n== stale 判定 ==")
    stale = {"task_id": "t-stale", "status": "running", "updated_at": time.time() - 999,
             "done": 1, "total": 10, "pct": 10, "title": "卡住的"}
    (tmp / "t-stale.json").write_text(json.dumps(stale), encoding="utf-8")
    t = next(x for x in read_tasks() if x["task_id"] == "t-stale")
    ok(t["stale"] is True, "超过 120 秒没更新 → stale")
    (tmp / "t-stale.json").unlink()

    print("\n== DSH_PROGRESS_OFF ==")
    os.environ["DSH_PROGRESS_OFF"] = "1"
    n_before = len(list(tmp.glob("*.json")))
    p = Progress("t-off", total=1)
    p.update(1, message="不该写盘")
    p.finish()
    eq(len(list(tmp.glob("*.json"))), n_before, "关掉后不写任何文件")
    del os.environ["DSH_PROGRESS_OFF"]

    print("\n== hub HTTP 接口 ==")
    port = free_port()
    hub = subprocess.Popen(
        [sys.executable, str(ROOT / "hub" / "hub.py"), "--port", str(port), "--dir", str(tmp)],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8")
    base = f"http://127.0.0.1:{port}"
    try:
        up = False
        for _ in range(50):
            try:
                with urllib.request.urlopen(base + "/api/health", timeout=1) as r:
                    health = json.load(r)
                up = True
                break
            except Exception:
                time.sleep(0.2)
        ok(up, "hub 起来了", base)
        if up:
            eq(health["ok"], True, "/api/health 返回 ok")
            eq(Path(health["dir"]), tmp, "hub 读的是同一个进度目录")

            with urllib.request.urlopen(base + "/api/tasks") as r:
                data = json.load(r)
            ids = [t["task_id"] for t in data["tasks"]]
            ok("t-done" in ids, "/api/tasks 列出了任务", f"{len(ids)} 个")
            ok("hub.json" not in str(ids), "/api/tasks 里没有 hub.json")

            with urllib.request.urlopen(base + f"/api/tasks/t-done?tail=3") as r:
                one = json.load(r)
            eq(one["task"]["task_id"], "t-done", "/api/tasks/<id> 返回任务")
            ok(isinstance(one["log"], list), "/api/tasks/<id> 带日志数组")

            try:
                urllib.request.urlopen(base + "/api/tasks/does-not-exist")
                ok(False, "不存在的任务返回 404")
            except urllib.error.HTTPError as e:
                eq(e.code, 404, "不存在的任务返回 404")

            with urllib.request.urlopen(base + "/") as r:
                page = r.read().decode("utf-8", "replace")
                ctype = r.headers.get("Content-Type", "")
            ok("进度看板" in page and "text/html" in ctype, "看板页可访问", f"{len(page)} 字节")

            # CORS 头（面板跨端口要用）
            req = urllib.request.Request(base + "/api/tasks", method="GET")
            with urllib.request.urlopen(req) as r:
                acao = r.headers.get("Access-Control-Allow-Origin")
            eq(acao, "*", "带 CORS 头")
    finally:
        hub.terminate()
        try:
            hub.wait(timeout=5)
        except subprocess.TimeoutExpired:
            hub.kill()

    print(f"\n{'全部通过' if FAIL == 0 else '存在失败'}：{PASS} passed, {FAIL} failed\n")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
