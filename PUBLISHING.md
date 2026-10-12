# 发布清单

代码本身已经准备好了，这个文件只记「要发出去还需要动哪些地方」。
**现在别照着做** —— 其中改包名那一步会让当前已安装的插件失效，得配套重装。

---

## 1. 改包名（唯一有破坏性的一步）

现在叫 `@local/dsh-progress-panel`。`@local` 是个占位 scope，发不出去。
发布前换成你自己的，比如 `dsh-progress-panel` 或 `@你的名字/dsh-progress-panel`。

**改的时候必须同步三个地方**，漏一个就装不上或者面板不渲染：

| 文件 | 改什么 |
|---|---|
| `package.json` | `"name"` |
| `cordis.patch.yml` | 那条 insert 的 `name` |
| `client.js` | `window.__ModuleLoader__.load({ id: ... })` —— **必须和包名完全一致**，宿主按这个 id 找模块 |

顺手把 `"private": true` 去掉（它现在挡着 `npm publish`）。

改完之后必须**卸载再重装**插件，因为 profile 里记的是旧包名：

```
DSH → 侧边栏 Plugins 页 → 找到它 → 移除 → 重新安装
```

---

## 2. 发布前该核对的

- [ ] `version` 从 `0.1.0` 起正常递增（别跳）
- [ ] `license` / `README.md` / `LICENSE` 里的作者信息是你要的
- [ ] `description` 和 `keywords` 面向搜索优化过（现在写的是中文描述，npm 上可能想再加一句英文）
- [ ] `files` 字段只列该发的（现在已经排除了 `tests/`）

---

## 3. 已经不用管的事

这些在改成「服务内置」的时候已经解决了，发布时不需要用户做任何额外操作：

| 曾经的坑 | 现在 |
|---|---|
| 用户要自己启动一个 Python 中枢 | 服务跑在插件的 Host 半边里，装完即有 |
| 忘了启动就什么都看不到 | 不存在这个问题了 —— DSH 在它就在 |
| 要装 Python | 不需要，纯 Node |
| `start-hub.cmd` / 开机自启脚本 | 已删除，不再需要 |
| 任意网页都能读你的任务名（CORS `*`） | 已收紧到只允许 `127.0.0.1` / `localhost` 的 origin |

---

## 4. 发布之后仍然存在的限制

老实说在前面，免得用户踩：

- **只在 Windows + DSH desktop profile 上验证过**。代码本身是跨平台的
  （`node:http` / `node:fs`，没有平台相关调用），但没在 macOS / Linux 上跑过
- **绑定 127.0.0.1，不支持多机 / 远程**。设计上就是本机自用
- **只存当前状态，不存历史**。任务结束后 1 分钟就从面板上消失；
  要看历史得自己把 `snapshot()` 追加到别处
- **没走 Client locale 服务**，界面文字是硬编码简体中文。要国际化的话得补一套
- **依赖宿主的 `shell.overlay` 槽位和 `--dsw-alias-*` 主题变量**。
  样式都带兜底值，token 改名最多让外观退化，不会崩；但槽位要是改名了，面板就不显示了
- **`ctx.inject(['systemPrompt'])` 和 `ctx.systemPrompt.section()` 的用法**
  是照着官方包（`dsh-client-ui-deliverables`）抄的，但**没有在真实 DSH 里验证过**
  —— 本机这个会话没有 `plugin_manager`，我装不了插件。
  已经用假 ctx 做了集成测试（`tests/host_test.js`），能覆盖接口形状，
  覆盖不了「宿主是否允许 Host 插件用 `node:http`」这一点。
  这一点靠官方同款实现背书：`@deepseek-ai/dsh-host-webserver` 就是这么干的。

---

## 5. 发布前建议再跑一遍

```powershell
npm test
```

四个套件：插件入口集成、进度服务、悬浮窗渲染、Python 生产端。
`tests/client_render_test.cjs` 和 `tests/server_test.js` 里的断言写死了
端口区间 `8791~8800`，如果改了 `PORT_SPAN`，这两处要一起改。
