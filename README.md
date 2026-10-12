# dsh-progress-panel

给 **DeepSeek Harness (DSH)** 用的长任务进度悬浮窗。

长任务（爬虫、批处理、下载、构建……）跑到哪儿了，在 DSH 界面右下角一眼就能看到 ——
不用切窗口，不用翻日志，也不用去问 Agent。

```
收起态                                    展开态
┌────────────────────────────────┐   ┌──────────────────────────────────┐
│ ● GGBases 抓取 ▓▓▓▓▓░ 62%      │   │ ● 任务进度            1 个   收起 │
└────────────────────────────────┘   │ ──────────────────────────────── │
                                     │ ● GGBases 抓取        62.0%  日志 │
                                     │ ▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░ │
                                     │ 948/1,529 页  1.20 页/s  ETA 15m20s│
                                     │ p=930 失败 0                      │
                                     │ ┌──────────────────────────────┐ │
                                     │ │ 13:40:01 已处理 600/1529 页   │ │
                                     │ │ 13:40:05 已处理 604/1529 页   │ │
                                     │ └──────────────────────────────┘ │
                                     └──────────────────────────────────┘
```

**没有任务时什么都不显示**，不占地方。

## 装完即用，不需要额外启动任何东西

进度服务跑在插件的 **Host 半边**里（`index.js` → `server.js`），
用 `node:http` 在 DSH 自己的 Node 进程里起一个只读的本地服务。
DSH 启动它就在，DSH 关掉它就没 —— **没有独立进程、不需要 Python、没有开机自启要配**。

这一点是刻意设计的：早先的版本是个要用户自己双击启动的 Python 小服务，
对「装个插件」来说太鸡肋了，忘了起就什么都看不到。

---

## 组成

```
你的脚本 / 命令
      │  写一个 JSON 文件（+ 可选一行行日志）
      ▼
$DSH_HOME/.dsh-progress/          ← 唯一的约定，两个生产端助手都往这儿写
      ▲
      │  读
┌─────┴──────────────────────────────────────────┐
│ DSH 进程里的插件                                │
│  index.js  起服务 + 给 Agent 注入使用说明        │
│  server.js 只读 HTTP（4 个端点）                 │
│  client.js 右下角的悬浮窗（shell.overlay 槽位）  │
└────────────────────────────────────────────────┘
```

| 文件 | 作用 |
|---|---|
| `index.js` / `server.js` / `board.js` | Host 半边：起进度服务、注入提示词 |
| `client.js` | 浏览器半边：悬浮窗 |
| `hub/progress.py` | Python 生产端助手 |
| `hub/progress.mjs` | Node 生产端助手 |
| `hub/watch.py` | 包住任意命令的包装器 |

服务是**只读**的，只听 `127.0.0.1`，CORS 也只放行 `127.0.0.1` / `localhost` 的页面
（早期版本用的是 `*`，那意味着你访问的任何网页都能读你的任务名）。
它另外自带一个独立看板页：`http://127.0.0.1:8791/`。

---

## 安装

DSH 的 `desktop` profile 由 Electron 应用独占管理，命令行装不了：

```
$ dsh plugin --profile desktop add ...
error: profile "desktop" is managed exclusively by the Electron application
```

走界面：打开 DSH → **左侧边栏的 Plugins 页** → 安装 bundle → 填本目录的**绝对路径**。

装完刷新页面。控制台会出现：

```
[dsh-progress-panel] 已加载；进度服务由插件自身在 127.0.0.1:8791-8800 上提供
```

**就这两步，没有第三步。** 想确认服务活着，浏览器打开 `http://127.0.0.1:8791/`。

---

## 让脚本上报进度

```python
import sys; sys.path.insert(0, r"<本目录>\hub")
from progress import Progress

with Progress("my-task", total=1529, unit="页", title="我的抓取任务") as p:
    for i, page in enumerate(pages, start=1):
        do_something(page)
        p.update(i, message=f"第 {i} 页完成")
# 正常退出自动标 done；with 里抛异常自动标 failed
```

不想改代码就包一层：

```powershell
python hub\watch.py --title "下载视频" --unit 个 --count-regex "Downloaded" -- yt-dlp <url>
```

**真实项目怎么接？看 [`USAGE.md`](USAGE.md)** —— 四条接入路线、场景配方、会踩的坑。

---

## 它显示哪些任务

没有白名单 —— 认的是「有没有按约定写进度文件」。

| 情况 | 结果 |
|---|---|
| `status: running` | 一直显示 |
| `done` / `failed` / `cancelled` | 结束后再留 **1 分钟**，然后自动消失 |
| 超过 120 秒没更新的 running | 仍显示，但标「疑似卡住」且不显示 ETA |
| 缺 `task_id`、`hub.json`、`.`/`_` 开头、坏 JSON、带 BOM | 分别跳过或容忍，不会影响别的任务 |

**排序**：在跑的在前，同组按最后更新时间倒序。
**数量**：药丸只显示第一个 + `+N`；展开卡片列出全部，每个可单独看日志。

> 独立看板页 `http://127.0.0.1:8791/` 不做筛选，把目录里的全列出来 —— 想翻历史用看板页。

---

## 操作

| 操作 | 效果 |
|---|---|
| **点一下** | 药丸 ⇄ 卡片 |
| **按住拖走** | 停在放下的地方（不吸附），位置记在 localStorage |
| 卡片里的「日志」 | 展开该任务的日志尾巴（最近 200 行） |

恢复默认位置：

```js
localStorage.removeItem('dsh-progress-panel:pos'); location.reload()
```

---

## 设计上的几个讲究

**服务内置，不靠 Agent 激活。** 也有人建议「让插件注入一段提示词，叫 Agent 去启动服务」——
那个方向是错的：只有 Agent 在场才有效、时机也不对（服务必须在长任务开始前就活着），
而且 Agent 起的进程正是最容易被回收的那种。现在提示词只用来解决**生产端**约定，
服务端由宿主生命周期管。

**走 `shell.overlay` 槽位而不是注入 DOM。** 另一个同类插件（`dsh-whale-widget`）是往每个页面
注入脚本直接改 DOM —— 它的产物里 `__ModuleLoader__` / `slots.register` 出现次数都是 0。
能跑，但官方文档明确不建议。正规槽位换来的是主题变量、深浅色切换、卸载清理、resize 全归宿主。

**拖拽不动 React。** `pointermove` 里直接写 `element.style` 并用 `requestAnimationFrame`
合并成一帧一次，松手才 `setState`。最早那版每次移动都 `setState`，整棵树跟着重渲染，手感很僵。

**尺寸一变就重新贴边。** 展开时卡片比药丸高得多。让「贴着的那条边」保持不动、
朝屏幕内生长，最后再夹一次；卡片本身还有 `max-height` + 内部滚动兜底。

**零依赖、零构建。** 不 import 任何 DSH 客户端包（官方明确禁止），控件自己写，
样式全部走 `--dsw-alias-*` 主题变量且**每个都带兜底值**。

---

## 测试

```powershell
npm test
```

| 套件 | 覆盖 |
|---|---|
| `tests/host_test.js` | 插件入口：起服务、注入提示词、卸载时关服务 |
| `tests/server_test.js` | 服务：路由、排序、stale、BOM、**CORS 收紧**、端口递补 |
| `tests/client_render_test.cjs` | 悬浮窗：渲染、拖拽落点、展开不越界、位置持久化 |
| `tests/test_progress.py` | Python 生产端：生命周期、原子写、读取、BOM |

共 150+ 项断言。前两个套件用假 ctx / 假 DOM 把真代码跑起来，不是纸面检查。

`host_test.js` 覆盖不到的只有一点：**DSH 的插件加载器是否允许 Host 插件用 `node:http`**。
已用假 ctx 验证了接口形状，这一条靠官方同款实现背书
（`@deepseek-ai/dsh-host-webserver` 就是 `createServer` + `ctx.effect` 关服务）。

---

## 已知限制

- 只在 **Windows + DSH desktop profile** 上验证过。代码是跨平台的，但没在 mac / Linux 跑过
- 绑定 `127.0.0.1`，**不支持多机 / 远程**
- **只存当前状态，不存历史**；要历史得自己把 `snapshot()` 落到别处
- 界面文字硬编码简体中文，**没走 Client locale 服务**
- 依赖宿主的 `shell.overlay` 槽位与 `--dsw-alias-*` 主题变量；槽位改名会导致面板不显示
  （样式 token 改名只会退化，不会崩）
- 进度目录默认 `$DSH_HOME/.dsh-progress`，改位置用 `DSH_PROGRESS_DIR` 环境变量或插件 `config.dir`

## 发布

见 [`PUBLISHING.md`](PUBLISHING.md)。

## License

MIT
