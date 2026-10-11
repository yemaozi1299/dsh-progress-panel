# 真实场景怎么用

这份文档讲的是**日常真的拿它干活**时怎么做。原理和 API 在
[`README.md`](README.md) 和 [`hub/README.md`](hub/README.md)。

一句话概括这个工具的设计：**任务自己在跑的时候就顺手写一个 JSON 文件**，
悬浮窗只是去读它。所以「接入」的成本应该低到可以忽略，下面几条路线按你的情况挑一条。

---

## 0. 一次性准备：让中枢一直开着

悬浮窗自己不会去找数据 —— 它读的是本机 `127.0.0.1:8791~8800` 上的进度中枢。
**中枢不在，悬浮窗就不显示任何东西**（故意的，免得没任务时界面上常驻一个报错）。

```
双击  start-hub.cmd
```

窗口会一直开着，那就是中枢在跑。**这个窗口关掉 = 进度功能停摆**，这是唯一的日常负担。

想彻底不用管它，把 `start-hub.cmd` 的**快捷方式**丢进开机启动目录：

```
Win+R  →  shell:startup  →  把快捷方式拖进去
```

（重复双击 `start-hub.cmd` 不会起第二个 —— 它会自己认出已经在跑的那个然后退出。）

验证中枢活着：浏览器打开 `http://127.0.0.1:8791/`，能看到看板页就对了。
这个页面本身就是个可用的独立看板，不装插件也能用。

---

## 1. 四条接入路线

### 路线 A：自己的 Python 脚本（最准，推荐）

加三行：

```python
import sys; sys.path.insert(0, r"D:\QQQQQ\DeepSeekHarness\Telegram_p\dsh-progress-panel\hub")
from progress import Progress

with Progress("my-task", total=1529, unit="页", title="我的抓取任务") as p:
    for i, item in enumerate(items, start=1):
        work(item)
        p.update(i, message=f"第 {i} 页完成")
```

`with` 退出时自动收尾：正常 → `done`，抛异常 → `failed`。
细节（不知道总数、多阶段、`p.step()` / `p.log()`）见 [`hub/README.md`](hub/README.md)。

> **路径太长每次都要写？** 设一个环境变量一劳永逸：
> ```powershell
> [Environment]::SetEnvironmentVariable("PYTHONPATH",
>   "D:\QQQQQ\DeepSeekHarness\Telegram_p\dsh-progress-panel\hub", "User")
> ```
> 之后 `from progress import Progress` 就能直接用了。

### 路线 B：别人的命令 / CLI 工具

`yt-dlp`、`ffmpeg`、`robocopy`、`npm run build` 这些你改不了代码，用 `hub\watch.py` 包一层：

```powershell
cd D:\QQQQQ\DeepSeekHarness\Telegram_p\dsh-progress-panel

# 最简单：每行输出算一步（不知道总数，只显示已处理数 + 速率）
python hub\watch.py --title "下载视频" -- yt-dlp -f best "https://..."

# 数次数：输出里每出现一次 Downloaded 就算一个
python hub\watch.py --title "下载视频" --unit 个 --count-regex "Downloaded" -- yt-dlp ...

# 从输出里抠进度和总数
python hub\watch.py --title "转码" --unit 帧 --done-regex "frame=\s*(\d+)" --total 5000 -- ffmpeg -i in.mp4 out.mp4

# 「3/10」这种格式：两个捕获组，第二个当总数
python hub\watch.py --title "同步" --unit 个 --done-regex "(\d+)/(\d+)" --total-from-done -- rsync ...
```

命令的 stdout **原样转发到终端**，所以不耽误你看它自己的输出。Ctrl+C 会连子进程一起收拾。

> 老工具输出 GBK 乱码就加 `--encoding gbk`。

### 路线 C：别的语言（Node / Go / C# / 批处理）

没有 Python 也没关系 —— 约定就是**一个 JSON 文件**，字段见
[`hub/README.md`](hub/README.md) 的表。最小的写法是每次覆盖写：

```powershell
$dir = "D:\QQQQQ\DeepSeekHarness\Telegram_p\dsh-progress-panel\.dsh-progress"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
@{ task_id="build"; title="构建"; status="running"; done=$i; total=$n; unit="步";
   pct=[math]::Round($i/$n*100,1); updated_at=$now; message="正在编译 $i/$n" } |
  ConvertTo-Json -Compress | Set-Content "$dir\build.json" -Encoding UTF8
```

> **写 UTF-8**，否则中文会乱。PowerShell 的 `Set-Content -Encoding UTF8` 会写 BOM，
> 这个读取端是容忍的（`utf-8-sig`）；但如果你用别的语言写，最好别带 BOM。
>
> `pct` 和 `updated_at` 是唯二「不填会显示得比较怪、但不会出错」的字段：
> 前者不填就没有百分比，后者不填会被当成很久没更新。

### 路线 D：让 Agent 跑（顺带把你自己解放出来）

直接在对话里说清楚，比如：

> 用进度面板跑这个：把 `data/` 下所有 json 合并去重，大概两万多个文件。
> 任务名「合并数据」，用 `progress` 上报，我要在悬浮窗里看着。

Agent 会用路线 A 或 B 接上，你就能一边看着进度一边干别的，不用一直问「好了没」。

---

## 2. 几个场景配方

### 不知道总数

```python
p = Progress("scan", unit="个", title="扫描文件")   # 不给 total
for f in files:
    scan(f)
    p.update(p.done + 1)
```
悬浮窗会显示「已处理 1234 个」+ 速率，只是没有百分比和 ETA —— 这比编一个假总数好。

### 一次跑一批，想知道总体还剩多少

```python
with Progress("batch", total=len(files), unit="个", title="批量压缩") as p:
    for i, f in enumerate(files, 1):
        compress(f)
        p.update(i, message=f.name)      # message 会进日志，展开能看到逐个文件名
```

### 多阶段长流程

同一个任务换阶段，改 `total` 和 `message` 就行：

```python
p = Progress("pipeline", title="数据处理流水线")
p.update(0, total=len(files), unit="个"); p.log("阶段 1/3：读取")
for i, f in enumerate(files, 1): read(f); p.update(i)
p.update(0, total=len(groups), unit="组"); p.log("阶段 2/3：分组")
for i, g in enumerate(groups, 1): group(g); p.update(i)
p.finish("三个阶段都完成")
```
阶段切换会写进日志，展开「日志」就能看到里程碑。

### 多个任务同时跑

各自用不同的 `task_id` 就行。悬浮窗会显示主要的那个 + `+N` 角标，
展开卡片能看到全部。比如同时跑爬虫和转码：

```powershell
python hub\watch.py --title "爬虫" -- python crawl.py
python hub\watch.py --title "转码" -- ffmpeg -i a.mp4 a.mkv
```

### 慢任务**和**快任务混在一起

快任务（几秒）也会闪一下然后消失 —— 完成后会保留 1 分钟，方便你确认它确实跑完了。

---

## 3. 会踩的坑

| 现象 | 原因 / 怎么办 |
|---|---|
| 悬浮窗一直不出现 | 九成是中枢没跑。先开 `http://127.0.0.1:8791/` 看看 —— 打不开就是中枢停了，双击 `start-hub.cmd` |
| 看板页有任务，但悬浮窗上没有 | DSH 页面是装插件之前打开的，刷新一下；还不行就重启 DSH |
| 数字不动、显示「疑似卡住」 | 超过 120 秒没更新。要么脚本真的卡住了，要么它死了没来得及收尾 |
| 进程被强杀，一直显示「进行中」 | 强杀（任务管理器）不会触发收尾。等 120 秒它会自动变「疑似卡住」，或者手动删掉 `.dsh-progress\<任务>.json` |
| 中文任务名变成 `____` | 老版本的 bug，已修；`git pull` 或更新到最新即可 |
| 任务堆了一屏 | 只显示在跑的 + 1 分钟内结束的，正常的不用清理。要彻底清就删 `.dsh-progress\` 下的 json/log |
| ffmpeg / yt-dlp 的输出是乱码 | 加 `--encoding gbk` |

---

## 4. 日常配合的建议

- **长任务开始前**瞄一眼右下角，确认悬浮窗在（哪怕只是一闪而过的药丸）。
  不在就先去看中枢。—— 这是唯一需要养成的习惯。
- 任务跑起来之后**点一下展开**，看着 bar 动就知道没白等；不放心就点「日志」看尾巴。
- **嫌挡着就拖走**，它记住位置，不吸附。
- 位置串了（比如换了显示器分辨率）：
  ```js
  localStorage.removeItem('dsh-progress-panel:pos'); location.reload()
  ```
- 只想看不想装插件：直接用独立看板 `http://127.0.0.1:8791/`，功能一样全。

---

## 5. 这个工具不适合什么

- **秒级任务** —— 接入成本比收益高，直接跑就行
- **需要保留历史记录的场景** —— 这里只存「当前状态」，任务结束后 1 分钟就不显示了。
  要历史就自己把 `p.snapshot()` 追加进日志文件
- **多机 / 远程** —— 中枢只监听 `127.0.0.1`，设计上就是本机自用
