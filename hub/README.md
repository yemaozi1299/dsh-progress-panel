# hub —— 长任务进度约定 + 本地进度中枢

这是 `dsh-progress-panel` 的数据侧。解决的问题：脚本一跑几十分钟，
**人看不到进度，Agent 查起来也很贵**（轮询后台任务输出会把几十行日志灌进上下文）。

做法很简单——**让脚本把进度写成一个 JSON 文件**，剩下的事都好办。

```
脚本  ──写──▶  .dsh-progress/<任务>.json + .log
                      │
                      ├─▶ hub.py  ──HTTP──▶  DSH 界面里的悬浮窗
                      └─          ──HTTP──▶  独立看板页 http://127.0.0.1:8791/
```

---

## 在脚本里用

```python
import sys; sys.path.insert(0, "dsh-progress-panel/hub")   # 或把 hub/ 加进 PYTHONPATH
from progress import Progress

with Progress("my-task", total=1529, unit="页", title="我的抓取任务") as p:
    for i, page in enumerate(pages, start=1):
        do_something(page)
        p.update(i, message=f"第 {i} 页完成")   # 带 message 会立刻落盘 + 记一行日志
# 正常退出自动标 done；with 里抛异常自动标 failed；Ctrl+C 要在外面接
```

不用 with 也行：

```python
p = Progress("my-task", total=n)
p.update(10)
p.step()                    # 等价于 done += 1
p.log("顺手记一行日志")      # 只写日志，不改进度
p.finish("完成")            # 或 p.fail("原因") / p.cancel()
```

**字段**（`<任务>.json`）：

| 字段 | 说明 |
|---|---|
| `task_id` / `title` | 标识与显示名 |
| `status` | `running` / `done` / `failed` / `cancelled` |
| `done` / `total` / `unit` | 进度与单位 |
| `pct` | 百分比，`total` 为空时是 `null` |
| `rate` / `eta_sec` | 最近 30 秒窗口的速率与预计剩余，样本不足时为 `null` |
| `elapsed_sec` / `started_at` / `updated_at` | 时间信息（epoch 秒） |
| `message` | 最新一条人类可读的消息 |
| `extra` | 你自己塞的任意键值 |
| `stale` | **由读取方计算**：`running` 但超过 120 秒没更新 |

---

## 起进度中枢

```powershell
python hub\hub.py                       # 默认 127.0.0.1:8791，被占用自动往后找
python hub\hub.py --port 9000
python hub\hub.py --dir D:\some\where\.dsh-progress
```

只读、只听本机、不执行任何东西。启动后会打印实际地址，并把端口写进
`.dsh-progress/hub.json`（方便人肉排查；悬浮窗是自己探端口的，不读这个文件）。

| 接口 | 用途 |
|---|---|
| `GET /` | 独立看板页，自动刷新，不需要装任何插件 |
| `GET /api/tasks` | 所有任务的最新进度 |
| `GET /api/tasks/<id>?tail=200` | 单个任务 + 日志尾部 |
| `GET /api/health` | 存活探测（悬浮窗靠它找端口） |

都带 `Access-Control-Allow-Origin: *`，因为 DSH 界面在另一个端口上。

**不想装 DSH 插件的话，这个看板页本身就够用了。**

---

## 验证

```powershell
# 起一个假任务，进度会自己往前走
python hub\demo_task.py --minutes 10

# 进度约定 + hub 接口的测试（30 项）
python tests\test_hub.py
```

---

## 设计约束（都是为了让宿主脚本不受影响）

- **零依赖**，只用标准库
- **原子写**：先写 `.tmp` 再 `os.replace`，看板不会读到半个 JSON
- **写盘限频**：普通 `update` 最快 0.4 秒写一次；只有带 `message` 才强制立刻落盘
- **绝不抛异常**：进度记录写失败就静默跳过，不能把正经活儿搞挂
- `DSH_PROGRESS_DIR` 换目录，`DSH_PROGRESS_OFF=1` 整个关掉

进度文件默认存在**仓库目录**下的 `.dsh-progress/`（已加进 `.gitignore`）。
