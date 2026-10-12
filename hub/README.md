# hub —— 生产端助手

这里只有**写进度**的东西：两个语言的助手，加一个包命令的包装器。
读和显示都在插件的 Host / Client 半边里，不在这儿。

```
你的脚本 / 命令
      │  用下面的助手写一个 JSON（+ 可选一行行日志）
      ▼
%DSH_HOME%\.dsh-progress\
      ▲
      │  插件里的服务读它 → 悬浮窗显示
```

**默认进度目录：`%DSH_HOME%\.dsh-progress\`**
（即 `C:\Users\<你>\.dsh\.dsh-progress\`）

改位置用环境变量 `DSH_PROGRESS_DIR` —— 服务端和两个助手都认它。
`DSH_PROGRESS_OFF=1` 可以整体关掉上报。

---

## Python

```python
import sys; sys.path.insert(0, r"<插件目录>\hub")
from progress import Progress

with Progress("my-task", total=1529, unit="页", title="我的抓取任务") as p:
    for i, page in enumerate(pages, start=1):
        do_something(page)
        p.update(i, message=f"第 {i} 页完成")   # 带 message 会立刻落盘并记一行日志
# 正常退出自动标 done；with 里抛异常自动标 failed
```

不用 `with` 也可以：

```python
p = Progress("my-task", total=n)
p.update(10)
p.step()                    # 等价于 done += 1
p.log("顺手记一行")          # 只写日志，不改进度
p.finish("完成")            # 或 p.fail("原因") / p.cancel()
```

小 CLI：`python hub/progress.py list` 用文本形式列一遍当前任务。

## Node

```js
import { Progress } from '<插件目录>/hub/progress.mjs'

const p = new Progress('my-task', { total: 1529, unit: '页', title: '我的抓取任务' })
try {
  for (let i = 1; i <= 1529; i++) { await work(i); p.update(i, `第 ${i} 页完成`) }
  p.finish('全部完成')
} catch (err) {
  p.fail(String((err && err.message) || err)); throw err
} finally {
  p.close()          // 兜底：没走 finish/fail 也不会一直挂着 running
}
```

Node 22+ 还可以用 `using p = new Progress(...)`（实现了 `Symbol.dispose`）。

## 别的语言 / 包住现成的命令

任何语言都能直接写那个 JSON，字段见下表。
不想改代码就用 `watch.py` 把命令包起来：

```powershell
# 每行输出算一步
python hub\watch.py --title "下载视频" -- yt-dlp -f best <url>

# 数次数
python hub\watch.py --title "下载" --unit 个 --count-regex "Downloaded" -- yt-dlp ...

# 从输出抠进度和总数
python hub\watch.py --title "转码" --unit 帧 --done-regex "frame=\s*(\d+)" --total 5000 -- ffmpeg -i a.mp4 a.mkv

# 「3/10」这种：两个捕获组，第二个当总数
python hub\watch.py --title "同步" --unit 个 --done-regex "(\d+)/(\d+)" --total-from-done -- rsync ...
```

命令输出原样转发到终端，Ctrl+C 连子进程一起收拾。老工具输出 GBK 就加 `--encoding gbk`。

---

## 字段

`<任务>.json`，UTF-8（**带不带 BOM 都行**，读取端会剥掉）：

| 字段 | 说明 |
|---|---|
| `task_id` | **必填**。没有这个字段的文件会被忽略 |
| `title` | 显示名；缺省用 `task_id` |
| `status` | `running` / `done` / `failed` / `cancelled` |
| `done` / `total` / `unit` | 进度与单位；`total` 为空时没有百分比和 ETA |
| `pct` | 百分比（`total` 为空时是 `null`） |
| `rate` / `eta_sec` | 最近 30 秒窗口的速率与预计剩余 |
| `elapsed_sec` / `started_at` / `updated_at` | 时间信息（epoch 秒） |
| `message` | 最新一条人类可读的消息 |
| `extra` | 任意键值，原样透传 |
| `stale` | **由读取方算**，写入时不用管 |

日志放在同名的 `<任务>.log`，一行一条；悬浮窗的「日志」按钮读它尾部 200 行。

> **文件名规则**：`task_id` 会被转成文件名（非字母数字下划线连字符的字符换成 `_`，
> 所以中文会原样保留）。Python、Node、服务端三处实现必须一致 ——
> 不一致的表现是「面板上任务在，但日志一直是空的」。
> `tests/server_test.js` 里专门有一组断言盯着这件事。

---

## 设计约束

两个助手都遵守同样的规矩，都是为了让宿主脚本不受影响：

- **零依赖**，只用各自的标准库
- **原子写**：先写 `.tmp` 再 rename，读端不会看到半个 JSON
- **写盘限频**：普通 `update` 最快 0.4 秒落一次盘；只有带 `message` 才强制立刻写
- **绝不抛异常**：进度写失败就静默跳过，不能把正经活儿搞挂
- **正确的终态**：正常 / 异常 / Ctrl+C 都要落到 `done` / `failed` / `cancelled`，
  不能永远挂在 `running`（真挂住了也不是没救，服务端 120 秒后会标「疑似卡住」）
