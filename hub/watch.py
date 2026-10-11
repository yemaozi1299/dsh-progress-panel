#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""包住任意命令，把它的输出变成进度上报。

不是所有长任务都是你自己写的 Python 脚本。yt-dlp / ffmpeg / robocopy / npm run build
这些你改不了代码，但可以让它们跑在 watch.py 底下，进度照样出现在悬浮窗里。

    # 最简单：把每一行输出当成一步（没有总数，只显示已处理数 + 速率）
    python hub\\watch.py --title "下载视频" -- yt-dlp -f best <url>

    # 自己数：输出里出现一次 "Downloaded" 就算一个
    python hub\\watch.py --title "下载视频" --unit 个 --count-regex "Downloaded" -- yt-dlp ...

    # 从输出里抠出「当前进度」和「总数」
    python hub\\watch.py --title "转码" --unit 帧 \\
        --done-regex "frame=\\s*(\\d+)" --total 5000 -- ffmpeg -i in.mp4 out.mp4

    # 总数也从输出里读（第一个匹配到的数字就当总数）
    python hub\\watch.py --title "同步" --done-regex "(\\d+)/(\\d+)" --total-from-done -- rsync ...

命令的 stdout 和 stderr 会被原样转发到终端，所以不耽误你看它自己的输出。
Ctrl+C 会连同子进程一起收拾掉，并把任务标成「已取消」。
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from progress import Progress  # noqa: E402

MAX_LOGGED = 400      # 最多往进度日志里塞多少行，免得日志文件无限涨


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description="跑一个命令，把它的输出变成进度上报",
        epilog="用 `--` 把 watch.py 自己的参数和要跑的命令分开，例如：\n"
               "  python hub/watch.py --title 下载 -- yt-dlp <url>",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--title", required=True, help="悬浮窗上显示的任务名")
    ap.add_argument("--id", default=None, help="任务 id（默认由 title 生成）")
    ap.add_argument("--unit", default="", help="进度单位，例如「个」「帧」「页」")
    ap.add_argument("--total", type=float, default=None, help="已知的总数")
    ap.add_argument("--total-regex", default=None,
                    help="从输出里抠总数（取第 1 个捕获组）")
    ap.add_argument("--total-from-done", action="store_true",
                    help="如果 --done-regex 有两个捕获组，第 2 个当总数")
    ap.add_argument("--done-regex", default=None,
                    help="从输出里抠「当前进度」（取第 1 个捕获组）")
    ap.add_argument("--count-regex", default=None,
                    help="每匹配到一行就 +1；不给就用 --done-regex；都不给则每行都算")
    ap.add_argument("--encoding", default="utf-8",
                    help="子进程输出的编码，默认 utf-8；老工具可能要 gbk")
    ap.add_argument("--quiet", action="store_true", help="不转发子进程的输出")
    ap.add_argument("command", nargs=argparse.REMAINDER,
                    help="要跑的命令（前面的 -- 会被去掉）")
    return ap


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)

    cmd = list(args.command)
    if cmd and cmd[0] == "--":
        cmd = cmd[1:]
    if not cmd:
        print("错误：没有给要跑的命令。用法：python hub/watch.py --title 名字 -- <命令>",
              file=sys.stderr)
        return 2

    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    title = args.title
    # 注意用 \w 而不是 [A-Za-z0-9_]：中文标题必须保留下来，
    # 否则所有中文任务都会退化成同一个 id 而互相覆盖。
    task_id = args.id or re.sub(r"[^\w-]+", "-", title, flags=re.UNICODE).strip("-") or "watch"
    done_re = re.compile(args.done_regex) if args.done_regex else None
    count_re = re.compile(args.count_regex) if args.count_regex else None
    total_re = re.compile(args.total_regex) if args.total_regex else None

    p = Progress(task_id, total=args.total, unit=args.unit, title=title,
                 extra={"命令": " ".join(cmd[:3]) + (" …" if len(cmd) > 3 else "")})

    done = 0
    matched = 0
    total = args.total
    logged = 0
    started = time.time()

    p.update(0, message=f"$ {' '.join(cmd[:4])}{' …' if len(cmd) > 4 else ''}")

    proc = None
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=None,
            text=True,
            encoding=args.encoding,
            errors="replace",
            bufsize=1,
        )

        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.rstrip("\n")
            if not args.quiet:
                print(line, flush=True)

            changed = False

            if total_re is not None and total is None:
                m = total_re.search(line)
                if m:
                    try:
                        total = float(m.group(1))
                        p.update(total=total)
                    except (ValueError, IndexError):
                        pass

            if done_re is not None:
                m = done_re.search(line)
                if m:
                    try:
                        done = float(m.group(1))
                        changed = True
                    except (ValueError, IndexError):
                        pass
                    if args.total_from_done and total is None and m.lastindex and m.lastindex >= 2:
                        try:
                            total = float(m.group(2))
                            p.update(total=total)
                        except (ValueError, IndexError):
                            pass
            elif count_re is not None:
                if count_re.search(line):
                    done += 1
                    changed = True
            else:
                if line.strip():
                    done += 1
                    changed = True

            if changed:
                matched += 1
                # 只在「有意义的行」上更新 message，否则日志会被刷屏
                msg = line.strip()[:160] if (done_re or count_re) else None
                p.update(done, total=total, message=msg)
                if msg and logged < MAX_LOGGED:
                    logged += 1
            elif total_re is not None and total is not None:
                p.write()

        code = proc.wait()
        if code == 0:
            p.finish(f"完成：{' '.join(cmd[:2])}（用时 {time.time() - started:.0f}s）")
        else:
            p.fail(f"退出码 {code}")
        return code

    except FileNotFoundError:
        p.fail(f"找不到命令：{cmd[0]}")
        print(f"错误：找不到命令 {cmd[0]}", file=sys.stderr)
        return 127
    except KeyboardInterrupt:
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        p.cancel("被 Ctrl+C 中断")
        print("\n已中断", file=sys.stderr)
        return 130
    except Exception as exc:                                   # noqa: BLE001
        p.fail(f"{type(exc).__name__}: {exc}")
        raise


if __name__ == "__main__":
    sys.exit(main())
