#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""演示任务：产生一条假进度，用来确认面板 / 看板真的在工作。

    python progress/demo_task.py                    # 默认跑 3 分钟
    python progress/demo_task.py --minutes 10
    python progress/demo_task.py --seconds 30 --fail   # 演示失败态

它会模拟一段「下载 240 个文件」的进度，速率故意有快有慢，好看出 ETA 在变。
Ctrl+C 会正确地标成「已取消」。
"""

from __future__ import annotations

import argparse
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from progress import Progress  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="演示一个长任务的进度上报")
    ap.add_argument("--seconds", type=float, default=None, help="总时长（秒）")
    ap.add_argument("--minutes", type=float, default=3.0, help="总时长（分钟）")
    ap.add_argument("--total", type=int, default=240, help="总步数")
    ap.add_argument("--fail", action="store_true", help="最后标记为失败，演示失败态")
    args = ap.parse_args(argv)

    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    duration = args.seconds if args.seconds is not None else args.minutes * 60
    total = max(1, args.total)
    step_sec = duration / total

    print(f"演示任务开始：共 {total} 步，预计 {duration:.0f} 秒")
    print("（另开一个终端跑 python progress/hub.py，然后打开看板或 DSH 面板）")

    p = Progress("demo-download", total=total, unit="个",
                 title="演示：下载 240 个文件", extra={"说明": "这个是假任务，用来验证进度显示"})
    p.update(0, message="开始")
    try:
        for i in range(1, total + 1):
            time.sleep(step_sec * random.uniform(0.6, 1.5))
            if i % 20 == 0 or i == total:
                p.update(i, message=f"已下载 {i}/{total} 个文件")
            else:
                p.update(i)
        if args.fail:
            p.fail("演示用的失败：第 240 个文件校验不通过")
            print("已标记为失败")
        else:
            p.finish(f"演示完成：{total} 个文件")
            print("已完成")
    except KeyboardInterrupt:
        p.cancel("被 Ctrl+C 中断")
        print("\n已取消")
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
