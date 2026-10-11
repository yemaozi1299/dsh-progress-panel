#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""长任务进度约定（Python 版）。

任何跑得久的脚本都可以用它，把进度写成**结构化文件**，这样：
  * 人可以随时打开看板 / DSH 面板看到进度；
  * Agent 查进度只要读一个 JSON，不用去 grep 中文日志、也不烧上下文。

用法::

    from progress import Progress

    with Progress("ggbases-crawl", total=1529, unit="页", title="GGBases 全量抓取") as p:
        for i, page in enumerate(pages, 1):
            ...
            p.update(i, message=f"p={page} 失败 0")
        # 正常退出自动标 done；with 里抛异常自动标 failed

也可以不用 with::

    p = Progress("job", total=n)
    p.update(10)
    p.finish()          # 或 p.fail("原因") / p.cancel()

设计约束（都是为了不拖累宿主脚本）：
  * 零依赖，只用标准库；
  * 写文件是**原子**的（先写 .tmp 再 replace），看板不会读到半个 JSON；
  * 写盘**限频**（默认最快 0.4s 一次），不会因为进度写入把 IO 打满；
  * 任何失败都吞掉——进度记录绝不能把正经活儿搞挂；环境变量 DSH_PROGRESS_OFF=1 可整体关掉。
"""

from __future__ import annotations

import json
import os
import socket
import sys
import time
from collections import deque
from pathlib import Path

# 默认放在「工作区/.dsh-progress」：progress/ 的上一级就是工作区
_DEFAULT_DIR = Path(__file__).resolve().parent.parent / ".dsh-progress"
ENV_DIR = "DSH_PROGRESS_DIR"
ENV_OFF = "DSH_PROGRESS_OFF"

_WRITE_MIN_INTERVAL = 0.4      # 秒；普通 update 最快多久写一次盘
_RATE_WINDOW = 30.0            # 秒；算速率用的滑动窗口
_STALE_AFTER = 120.0           # 秒；超过这么久没更新就算「疑似卡死」


def progress_dir() -> Path:
    """进度目录。可用环境变量 DSH_PROGRESS_DIR 覆盖。"""
    d = os.environ.get(ENV_DIR)
    return Path(d) if d else _DEFAULT_DIR


def _safe_name(s: str) -> str:
    keep = "-_.0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
    return "".join(c if c in keep else "_" for c in s)[:80] or "task"


def _fmt_dur(sec: float | None) -> str:
    if sec is None or sec < 0 or sec != sec:      # None / 负数 / NaN
        return "—"
    sec = int(sec)
    if sec < 60:
        return f"{sec}s"
    if sec < 3600:
        return f"{sec // 60}m{sec % 60:02d}s"
    return f"{sec // 3600}h{(sec % 3600) // 60:02d}m"


class Progress:
    """一个长任务的进度记录器。所有方法都保证不抛异常。"""

    def __init__(self, task_id: str, total: float | None = None, unit: str = "",
                 title: str | None = None, extra: dict | None = None,
                 write_interval: float = _WRITE_MIN_INTERVAL):
        self.enabled = os.environ.get(ENV_OFF, "") == ""
        self.task_id = task_id
        self.slug = _safe_name(task_id)
        self.total = total
        self.unit = unit
        self.title = title or task_id
        self.extra = dict(extra or {})
        self.write_interval = write_interval

        self.done: float = 0
        self.status = "running"
        self.message = ""
        self.started_at = time.time()
        self.updated_at = self.started_at
        self._samples: deque[tuple[float, float]] = deque(maxlen=64)
        self._last_write = 0.0
        self._final = False

        self.dir = progress_dir()
        self.json_path = self.dir / f"{self.slug}.json"
        self.log_path = self.dir / f"{self.slug}.log"

        if self.enabled:
            try:
                self.dir.mkdir(parents=True, exist_ok=True)
            except OSError:
                self.enabled = False
        self._sample()
        self.write(force=True)

    # ---------------------------------------------------------------- 内部
    def _sample(self) -> None:
        self._samples.append((time.time(), self.done))

    def _rate(self) -> float | None:
        """滑动窗口内的速率（单位/秒）。样本不足返回 None。"""
        now = time.time()
        pts = [(t, d) for t, d in self._samples if now - t <= _RATE_WINDOW]
        if len(pts) < 2:
            pts = list(self._samples)[-2:]
        if len(pts) < 2:
            return None
        (t0, d0), (t1, d1) = pts[0], pts[-1]
        dt = t1 - t0
        if dt <= 0:
            return None
        return (d1 - d0) / dt

    def snapshot(self) -> dict:
        now = time.time()
        elapsed = now - self.started_at
        rate = self._rate()
        pct = None
        eta = None
        if self.total:
            pct = max(0.0, min(100.0, self.done / self.total * 100.0))
            if rate and rate > 0:
                eta = max(0.0, (self.total - self.done) / rate)
        d = {
            "task_id": self.task_id,
            "title": self.title,
            "status": self.status,
            "done": self.done,
            "total": self.total,
            "unit": self.unit,
            "pct": pct,
            "rate": rate,
            "eta_sec": eta,
            "elapsed_sec": elapsed,
            "started_at": self.started_at,
            "updated_at": now,
            "message": self.message,
            "extra": self.extra,
            "pid": os.getpid(),
            "host": socket.gethostname(),
            "stale": False,
        }
        return d

    def write(self, force: bool = False) -> None:
        if not self.enabled:
            return
        now = time.time()
        if not force and (now - self._last_write) < self.write_interval:
            return
        self._last_write = now
        try:
            body = json.dumps(self.snapshot(), ensure_ascii=False, separators=(",", ":"))
            tmp = self.json_path.with_suffix(".json.tmp")
            tmp.write_text(body, encoding="utf-8")
            os.replace(tmp, self.json_path)
        except OSError:
            pass

    def log(self, line: str) -> None:
        """往 <task>.log 追加一行人类可读日志（面板会显示尾部）。"""
        if not self.enabled:
            return
        try:
            with self.log_path.open("a", encoding="utf-8") as f:
                f.write(f"{time.strftime('%H:%M:%S')} {line}\n")
        except OSError:
            pass

    # ---------------------------------------------------------------- 对外
    def update(self, done: float | None = None, message: str | None = None,
               total: float | None = None, extra: dict | None = None) -> None:
        if done is not None:
            self.done = done
        if total is not None:
            self.total = total
        if extra:
            self.extra.update(extra)
        if message is not None:
            self.message = message
            self.log(message)
            self.write(force=True)          # 有新消息就立刻落盘
            self._sample()
            return
        self._sample()
        self.write()

    def step(self, n: float = 1, message: str | None = None, **kw) -> None:
        """完成一个单位（比 update 手算 done 方便）。"""
        self.update(self.done + n, message=message, **kw)

    def finish(self, message: str | None = None) -> None:
        if self._final:
            return
        self.status = "done"
        self._final = True
        if self.total:
            self.done = self.total
        if message:
            self.message = message
            self.log(message)
        self.log(f"完成，用时 {_fmt_dur(time.time() - self.started_at)}")
        self.write(force=True)

    def fail(self, message: str = "") -> None:
        if self._final:
            return
        self.status = "failed"
        self._final = True
        self.message = message or "failed"
        self.log("失败：" + self.message)
        self.write(force=True)

    def cancel(self, message: str = "") -> None:
        if self._final:
            return
        self.status = "cancelled"
        self._final = True
        self.message = message or "cancelled"
        self.log("已取消")
        self.write(force=True)

    # ---------------------------------------------------------------- 语法糖
    def __enter__(self) -> "Progress":
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        if exc_type is None:
            self.finish()
        elif exc_type is KeyboardInterrupt:
            self.cancel("被 Ctrl+C 中断")
        else:
            self.fail(f"{exc_type.__name__}: {exc}")
        return False        # 不吞异常

    def __call__(self, done=None, message=None, **kw) -> "Progress":
        self.update(done, message=message, **kw)
        return self


def read_tasks(directory: Path | None = None) -> list[dict]:
    """读目录下所有进度文件（看板 / 面板共用）。

    会跳过中枢自己写的 hub.json 以及任何没有 task_id 的 JSON，
    否则它会被当成一个任务列出来。
    """
    d = directory or progress_dir()
    out = []
    if not d.is_dir():
        return out
    now = time.time()
    for f in sorted(d.glob("*.json")):
        if f.name == "hub.json" or f.name.startswith((".", "_")):
            continue
        try:
            obj = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(obj, dict) or not obj.get("task_id"):
            continue
        obj["stale"] = bool(
            obj.get("status") == "running"
            and (now - float(obj.get("updated_at") or 0)) > _STALE_AFTER
        )
        out.append(obj)
    # 跑着的排前面，再按更新时间倒序
    out.sort(key=lambda o: (o.get("status") != "running", -(o.get("updated_at") or 0)))
    return out


def read_log(task_id: str, tail: int = 200, directory: Path | None = None) -> list[str]:
    d = directory or progress_dir()
    p = d / f"{_safe_name(task_id)}.log"
    if not p.is_file():
        return []
    try:
        lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    return lines[-tail:]


if __name__ == "__main__":
    # 小 CLI：python progress.py list
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if len(sys.argv) > 1 and sys.argv[1] == "list":
        tasks = read_tasks()
        if not tasks:
            print(f"（{progress_dir()} 里没有进度文件）")
        for t in tasks:
            pct = t.get("pct")
            bar = ""
            if pct is not None:
                filled = int(pct / 100 * 20)
                bar = "[" + "#" * filled + "." * (20 - filled) + "] "
            print(f"{bar}{pct if pct is None else round(pct,1)}%  {t['title']}  "
                  f"{t['done']:g}/{t['total']:g}{t.get('unit','')}  "
                  f"ETA {_fmt_dur(t.get('eta_sec'))}  [{t['status']}]  {t.get('message','')}")
    else:
        print(__doc__)
