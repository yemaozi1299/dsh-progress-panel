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

---

## 它由两部分组成

```
┌─────────────┐   写文件    ┌──────────────────┐   HTTP    ┌─────────────────┐
│  你的脚本    │ ─────────▶ │  .dsh-progress/   │ ◀──────── │  DSH 界面里的    │
│ (progress)  │            │  <任务>.json+.log │           │  悬浮窗 (client) │
└─────────────┘            └──────────────────┘           └─────────────────┘
                                    ▲                              │
                                    └──── hub/hub.py（只读服务）────┘
```

| 部分 | 是什么 |
|---|---|
| `client.js` + `index.js` + `package.json` | **DSH 插件**。渲染那个悬浮窗，只负责显示 |
| `hub/progress.py` | **约定**。任何 Python 脚本 `from progress import Progress` 就能上报进度 |
| `hub/hub.py` | **中枢**。把 `.dsh-progress/` 暴露成 HTTP，插件和独立看板页都读它 |

中枢是**只读**的，只听 `127.0.0.1`，不执行任何东西。
它另外自带一个独立看板页 —— 不想装插件的话，直接开 `http://127.0.0.1:8791/` 也能用。

---

## 安装

### 1. 起中枢

```powershell
python hub\hub.py
```

默认 `127.0.0.1:8791`，端口被占会自动往后找（插件会在 8791~8800 里自己探，不用配）。
**中枢不跑，悬浮窗就不显示任何东西** —— 这是故意的，免得没任务时界面上常驻一个报错。

### 2. 装插件

DSH 的 `desktop` profile **由 Electron 应用独占管理**，命令行装不了：

```
$ dsh plugin --profile desktop add ...
error: profile "desktop" is managed exclusively by the Electron application
```

所以走界面：打开 DSH → **左侧边栏的 Plugins 页** → 安装 bundle → 填本仓库的**绝对路径**。

装完刷新页面，控制台会出现：

```
[dsh-progress-panel] 已加载（悬浮窗版）；进度中枢请在 127.0.0.1:8791-8800 上运行 hub/hub.py
```

---

## 在自己的脚本里上报进度

```python
import sys; sys.path.insert(0, "dsh-progress-panel/hub")
from progress import Progress

with Progress("my-task", total=1529, unit="页", title="我的抓取任务") as p:
    for i, page in enumerate(pages, start=1):
        do_something(page)
        p.update(i, message=f"第 {i} 页完成")   # 带 message 会立刻落盘并记一行日志
# 正常退出自动标 done；with 里抛异常自动标 failed
```

细节见 [`hub/README.md`](hub/README.md)。
不想改代码，就包一层 `hub/watch.py`：

```powershell
python hub\watch.py --title "下载视频" --unit 个 --count-regex "Downloaded" -- yt-dlp <url>
```

**想直接上手真实项目？看 [`USAGE.md`](USAGE.md)** —— 四条接入路线、场景配方、会踩的坑。

想先看看效果：

```powershell
python hub\demo_task.py --minutes 10
```

---

## 操作

| 操作 | 效果 |
|---|---|
| **点一下** | 在「小药丸」和「卡片」之间切换 |
| **按住拖走** | 停在放下的地方（不吸附），位置记在 localStorage |
| 卡片里的「日志」 | 展开该任务的日志尾巴（最近 200 行，自动滚到底） |

默认位置是右下角、离底边 190px —— 特意抬高的，因为小鲸鱼挂件占着右下角。

想恢复默认位置：

```js
localStorage.removeItem('dsh-progress-panel:pos'); location.reload()
```

---

## 设计上的几个讲究

**为什么走 `shell.overlay` 而不是照抄小鲸鱼？**
小鲸鱼（`dsh-whale-widget`）是往每个页面注入脚本、直接改 DOM —— 它的客户端产物里
`__ModuleLoader__` / `slots.inject` / `slots.register` 出现次数**都是 0**。
能work，但官方文档明确写着「不要在组件外写 DOM、不要往 `document.body` 上挂东西」。
这里走正规槽位，主题变量、深浅色切换、卸载清理、窗口 resize 都归宿主管。

**拖拽不动 React。** `pointermove` 里直接写 `element.style`，并用 `requestAnimationFrame`
合并成一帧一次；松手才 `setState`。最早那版每次移动都 `setState`，整棵树跟着重渲染，手感很僵。

**尺寸一变就重新贴边。** 展开时卡片比药丸高得多。这里让「贴着的那条边」保持不动、
朝屏幕内生长（贴右就往左长，贴下就往上长），最后再夹一次，保证任何情况下整个窗口都在屏幕里。
卡片本身还有 `max-height: calc(100vh - 28px)` + 内部滚动兜底。

**定位用 `position: fixed`。** 这是验证过的：宿主自带的 Toast（同样注册在 `shell.overlay`）
用的就是 `position:fixed; z-index:1100`，说明祖先元素上没有 transform 会把 fixed 带偏。
本插件用 `z-index: 9600`（比 Toast 高、比鲸鱼低）。

**零依赖、零构建。** 没有 npm 依赖、没有编译步骤、没有安装脚本，不 import 任何 DSH 客户端包
（官方明确禁止 import primitives），控件都是自己写的。样式全部走 `--dsw-alias-*` 主题变量，
**每个都带兜底值**，token 改名最多让样式退化，不会渲染崩。

---

## 测试

```powershell
node tests\client_render_test.cjs     # 56 项：渲染、槽位、拖拽落点、越界、持久化
python tests\test_hub.py             # 30 项：进度生命周期、原子写、stale、HTTP 接口、CORS
```

`client_render_test.cjs` 用一套最小 React 运行时把 `client.js` 里的组件**真跑起来渲染**，
并喂一个**有状态的假 DOM 节点**（尺寸随药丸/卡片变化，`style` 是活的，所以直接写 DOM 也读得到）。
拖拽落点、展开不越界都是**真算过**的。

---

## 已知限制

- 文字直接写简体中文，**没走 Client locale 服务**（单用户本地工具）
- 只在 Windows + DSH desktop profile 上验证过
- 卡片里多任务时最多显示前若干个，日志一次只展开一个
- `.dsh-progress/` 默认放在**本仓库目录**下；换位置用 `DSH_PROGRESS_DIR` 环境变量

## License

MIT
