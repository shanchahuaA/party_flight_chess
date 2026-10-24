# IAB 浏览器冒烟须知（本项目实测坑合集）

> 用 ZCode 内置浏览器（IAB）做壳层冒烟前先读这页——以下坑全部在 M1 实测踩过，重踩一次平均烧 10+ 次调用。
> 浏览器操作本身按 control-browser 技能走；本页只记**本项目叠加的坑与固定打法**。

## 固定打法（先照抄再动手）

1. **起服务**：`cd client && npm run dev`（端口 5173）。沙箱可能拦环回——被拦时用页内通道顶着走。收尾 TaskStop 后 `netstat -ano | grep 5173` 复核，防僵尸 vite（见下）。
2. **URL 组合**：`http://localhost:5173/?fast&slow=1&dev=1`（60s 慢窗+dev 通道；快窗会与逐格走/替掷竞速）。终局冒烟加 `&turn=5`。全部参数见 [dev-channels.md](./dev-channels.md)。
3. **驱动点击用页内派发**，不用 Playwright 定位器（真实输入管道可能整体失效）：`evaluate(() => document.getElementById('x').click())`。
4. **读状态用 `__pz()` 快照**（页内 evaluate 直调），别截图——`screenshot()` 间歇性 "surface preparation timed out"，`domSnapshot()` 常返空串。
5. **每步先 `waitForTimeout` 再断言**；单次 evaluate 有 **3s 硬顶**，长轮询拆多发。

## 坑清单（按症状查）

| 症状 | 原因 | 处置 |
|---|---|---|
| evaluate 返回 `{}` | 字符串被当表达式，函数形态不会被自动调用 | 写成自调用 IIFE：`` `(() => { ...; return {...}; })()` `` |
| `ReferenceError: xxx is not defined`（页内） | 顶层 `let/const` 不在 `window` 上；或 Node 侧变量越上下文 | 用裸标识符；Node 侧变量先序列化拼进函数体 |
| 页面白屏但无报错 | 5173 被僵尸 vite 占着，服务旧转换缓存（`we is not defined` 类） | `netstat -ano | grep 5173` 找 PID kill + `rm -rf client/node_modules/.vite` 重启 |
| 点击注入石沉大海 | 真实输入管道（playwright/cua click）整体失效 | 改页内 dispatch（打法 3），别死磕重试 |
| 断言读不到 toast | toast 寿命 ~1.8s，跨 MCP 调用早没了 | 同一 cell 里动作+读取连做，或读 `__pz()` 代替 |
| 游戏推进「慢动作」 | 页签转后台后 `setInterval` 被节流 | 抓时机截图要算节流余量；能用 `__pz()` 就别抓帧 |
| rAF 一个都不来 / setTimeout 被钳 ~1s | IAB 已知钳制（hasFocus=false） | 壳层已用 setTimeout 链驱动，别改依赖 rAF |
| 长等待报超时 | 单次 js 调用 120s 硬顶 | 长跑计时拆多 cell，单 cell 等待 ≤10s |
| 重开一局后卡在 drafting | `?fast` 的暗牌自动代选只在首局 `maybeBootFastPath` 注入，再来一局要手点 SecretDraft | 冒烟脚本重开后记得点 `.goal` → `.ok` |
| 点 `.ok` 等按钮没生效 | Vue 重渲吞掉 evaluate 里的 click（点击后按钮被换掉） | 读回 `disabled`/浮层是否仍在，没生效就补点一次 |
| `querySelector(".ok")` 点了没反应 | 选择器命中了别的元素（如 `<i class="ok">` 图标排前面） | 用标签收窄：`querySelector("button.ok")`；点前读回 `tagName` |
| evaluate 里 JS 串含中文/特殊符号报 `Invalid or unexpected token` | cell 传输编码不稳（Node 侧拼串时炸） | JS cell 里的字符串/键名保持 ASCII；中文断言放读取结果后 Node 侧比对 |
| `Object.defineProperty(document, "hidden", …)` 报 `Cannot redefine property` | IAB 把 `hidden` 铺成 document 自身**不可配置**属性，盖不掉（连 `Document.prototype` 覆盖也读不到） | 别试伪造可见性——计时域冒烟走 `__pzvis()` 通道（见 dev-channels.md）；IAB 常驻 `hidden=true` 且 `visibilitychange` 永不触发 |
| 时钟不走/全场「慢动作」定格（T9 计时域上线后） | 壳层只认 hidden **切换沿**暂停计时——若某环境常驻 hidden 会被误伤；boot 时已故意不读 hidden | 页内先查 `document.hidden`；IAB 冒烟确认 `__pz().now` 在走再继续 |
| 冒烟中途改了壳层源码后行为诡异（旧代码与页内 import 探针读数互相矛盾、toast/状态读了不存在） | **vite 编辑窗口期 + 浏览器 304 缓存 = 双模块实例**：页的 import 图冻结在 reload 时刻（带 `?t=` 时间戳），evaluate 里裸 `import("/src/xxx.ts")` 拿的是另一份新实例——改 UI 状态探不到、注入无效 | 验证：`performance.getEntriesByType("resource")` 看模块 URL 是否带旧 `?t=`。处置：杀 vite（先查 PID 归属）→ `rm -rf client/node_modules/.vite` → 重启带 `--force`；页签 `goto("about:blank")` 再回目标 URL 强制换文档。**冒烟中途尽量别改壳层源码**，要改就当轮重启 vite 再继续 |

## 冒烟后必做

- 把新发现的坑**回写本页**（一行一行加，别攒）。
- 破坏性操作（杀进程/清缓存）前确认 PID 归属，别顺手杀掉别的 node 服务。
