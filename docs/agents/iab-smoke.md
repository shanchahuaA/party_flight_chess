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
| 127.0.0.1:5173 打不开（ERR_CONNECTION_REFUSED）但 localhost 正常 | vite dev 默认只绑 localhost（实测只上 `[::1]`）——双身份冒烟的第二 origin 直拒 | vite 带 `--host` 起（监听 0.0.0.0）；`localhost` 与 `127.0.0.1` 即成两个 origin=两份 localStorage（T8 断线冒烟的双端打法） |
| 杀掉 8787 的 workerd 后秒级「复活」/ 被踢一次马上又听上 8787 | wrangler dev 有监护 node：杀 workerd 它 1s 内自动拉新（甚至神不知鬼不觉） | 「真断线」要连 wrangler 的监护链一起杀：`powershell Get-CimInstance Win32_Process` 按 CommandLine 找 `wrangler`/`pfc-m2\server` 父链全灭；ZCode 后台任务的 TaskStop 也不保证杀进程树，孤儿层照样重生 |
| WS 断连反复挂 `connecting` 不降级 | 假活 workerd：端口还监听但进程半死，`curl -m 3 /health` 超时（health:000）——vite 代理黑洞挂死连接 | 判活只认 `curl -m 3 http://127.0.0.1:8787/health`；假活来源=上一轮被 taskkill 的 workerd 被监护先拉新又旧账未清，全套连杀重启最省事 |
| `Object.defineProperty(document, "hidden", …)` 报 `Cannot redefine property` | IAB 把 `hidden` 铺成 document 自身**不可配置**属性，盖不掉（连 `Document.prototype` 覆盖也读不到） | 别试伪造可见性——计时域冒烟走 `__pzvis()` 通道（见 dev-channels.md）；IAB 常驻 `hidden=true` 且 `visibilitychange` 永不触发 |
| 时钟不走/全场「慢动作」定格（T9 计时域上线后） | 壳层只认 hidden **切换沿**暂停计时——若某环境常驻 hidden 会被误伤；boot 时已故意不读 hidden | 页内先查 `document.hidden`；IAB 冒烟确认 `__pz().now` 在走再继续 |
| 冒烟中途改了壳层源码后行为诡异（旧代码与页内 import 探针读数互相矛盾、toast/状态读了不存在） | **vite 编辑窗口期 + 浏览器 304 缓存 = 双模块实例**：页的 import 图冻结在 reload 时刻（带 `?t=` 时间戳），evaluate 里裸 `import("/src/xxx.ts")` 拿的是另一份新实例——改 UI 状态探不到、注入无效 | 验证：`performance.getEntriesByType("resource")` 看模块 URL 是否带旧 `?t=`。处置：杀 vite（先查 PID 归属）→ `rm -rf client/node_modules/.vite` → 重启带 `--force`；页签 `goto("about:blank")` 再回目标 URL 强制换文档。**冒烟中途尽量别改壳层源码**，要改就当轮重启 vite 再继续 |

## M2-T7 计时与快照恢复冒烟（#44；协调方脚本档）

> 判定工具：`__pztime()`（?dev=1 挂载，roomStore 的 ServerClock 对时读数）+ 既有 `__pz()`/`__pzroom()`。
> 原理铁则：serverNow 走 performance.now 单调插值（与 Date.now/本机墙钟解耦），倒计时=windowDeadline-serverNow。
> IAB 页签不可假锁——「锁屏」用关页签 10s 重开 `?room=码` 归队等价（真机锁屏 10 分钟回前台走同一条恢复触发面），见下步 ③。

1. **对时到位**：房主建联机房、配置 60s 慢窗 → 开局 → `__pztime()` 断 `samplesN>=1 且 rttBest!=null 且 offset!=null`（几秒内多采样收齐）。
   坑：单机 `?fast` 不走联机钟——那边 `__pztime().serverNow` 恒 0（LocalKernelSource 自有冻结钟，T9 域）；对时探针只在房间/联机对局面非 0。
2. **改本机时钟演示不漂（判定法）**：先记 `__pz().now` 与 `__pztime().serverNow` → 页内把墙钟拨快 10 分钟（IAB 可用）`(() => { const d = Date.now; Date.now = () => d() + 600_000; return "wall+10min"; })()` → 再读 `__pz().now`：读数连续平滑（差值≈两次调用间隔），`localWallDelta` 精准 **−600000**（=墙钟动了、读数没动；探针定义=serverNow−Date.now，墙钟被拨快→差值反向减；实测 −600002 含 ms 抖动）；真机上改系统时区/时钟是同一判定。
   坑：别把 `localWallDelta` 变动当读数漂移——它就是「读数-墙钟差」，它动恰好证明只有墙钟动；判定盯 `serverNow`/`__pz().now` 本身。
3. **快照恢复**：对局中关页签 10 秒 → 重开 `?room=码&dev=1` → `__pzroom` 座位/在线归队，`__pz()` turn/相位/战报尾片与关页前一致（无补播动画）→ `__pztime().samplesN>0`（新连接=新采样阵，重对时生效）。
   坑：重开后先等首条 game 消息到达再断言（`__pz()` null=hello 还没到，别误判挂了）；同页签重开必须保 token——别 `localStorage.removeItem("pfc.token.<码>")`，归队靠它静默续座。
4. **窗口已过/长局单调**：等一个 60s 窗轮空（无人操作→替掷/收窗一拍落账）→ `__pz()` turn 单调递增、相位流转合拍 → `__pztime().serverNow` 每次读都比上次大（恒不倒行）。
   坑：IAB 后台节流会造成 UI 倒计时渲染慢于真实读数——判定一律读 `__pz()`/`__pztime()` 快照，别凭肉眼秒数收案。

## M2-T8 断线治理冒烟（#45；协调方脚本档）

> 判定工具：`__pzroom()`（M2-T8 增量字段：`banner`=断线/重连横幅全文、`silentMs`=下行静默毫秒、
> `token`=本机原 token 的 dev=1 披露）+ 既有 `__pz()`/`__pztime()`。
> 双端技巧：`localhost:5173` 与 `127.0.0.1:5173` 是**不同 origin → 两份独立 localStorage=两个身份**；
> vite 需带 `--host` 起（默认只绑 localhost，127.0.0.1 直接 ERR_CONNECTION_REFUSED——见坑清单）。

1. **重连归队（快，真自动）**：A 身份（localhost）`?room=码&dev=1` 直跳静默归队；开局后关 A 标签
   → 重开同 URL → `__pzroom()` 断 `you` 回座位、座位列在线标记复原、`banner=null`。
   坑：重开页先等首条 game hello（`__pz()` null=还没到）；别在等待里手动点按钮，静默归队自己会到位。
2. **重连中态（快，制造真断线）**：杀 8787 的 workerd（`netstat -ano | grep :8787` → `taskkill //PID`）
   → 4–6s 后读 A 页 `__pzroom()`：断 `banner="连接断开，自动重连中…"` 且 `ws="connecting"`；
   8787 恢复后 ≤30s 内 `banner=null && ws="open"`（自动归队，无需人工）。
   坑：wrangler dev 的监护 node 会在 workerd 被杀 1s 内自动拉起新 workerd——「杀服务」实际是秒级
   自愈；造出经典断线窗要连杀监护 node（按 PID 链），或盯着 `banner` 抓到 22s 到顶的降级窗。
3. **到顶降级（快，可选）**：把 8787 拉真空 ≥22s（连杀 wrangler 监护链，别救）→ A 页横幅变化
   `连接断开…` → `自动重连多次未成功——可点「重新连接」再试，或先回首页`（10×2.2s 到顶）。
   再起 8787、点横幅「重新连接」→ `banner=null && ws="open"`（手动路兜底）。
   坑：半死的 workerd（监听着但 health:000 超时）会让 connect 挂死、重连循环停在 connecting——
   判活用 `curl -m 3 http://127.0.0.1:8787/health`，不要信 netstat 有监听。
4. **踢人+原身份拒进（快）**：双身份两页都在房（A 房主、B 朋友甲，见标题段双端技巧）→ A 页座位列
   点 B 的「🥾」（页内派发 `document.querySelector(".seats button.kick").click()`）→ 断言：
   A `__pzroom()` B 座位消失；B 页 `__pzroom()=null`（已回首页）+ B 的 `pfc.token.<码>` 被清。
   再从 A 页用 `__pzroom().token` 拿到的 B 原 token 裸开 WS（页内 evaluate `new WebSocket(.../ws/码?token=B原token)`，
   1.2s 后收结果）→ 断 `opened=false` 且 `error+close:1006`（升级被 403 拒的浏览器侧形态，读不到状态码
   是浏览器 WS API 限制，见坑清单）。[实现期定案：可踢任何 phase；假人不给踢（走 addBot/removeBot 面）]
5. **房主转移（等 5 分钟，真等）**：三身份房间（localhost 房主 + 127.0.0.1×2 或 HTTP join 凑数）→
   **关房主页**（socket 落地=host 离线钟起摆）→ 保持≥1 个其他真人在线 → 真等 5 分钟+10s →
   留守页 `__pzroom()` 断 `hostSeat` 变为最早加入的**在线**真人（实现期定案：在线过滤）且旧房主座位
   皇冠标记消失；旧房主再重开 `?room=` → 皇冠不回归（普通玩家）、解散被拒（error toast）。
   坑：转移钟只在「房主 socket close」时开摆——刷新页面=旧 socket close+新 socket open 会**撤钟**，
   「离线」语义必须真关标签页（about:blank 或关掉），不能只切后台。
6. **全员离线销毁（等 5 分钟，真等）**：全真人关页 → 真等 5 分钟+10s → `curl POST /api/rooms/<码>/join`
   断 404（或页内 fetch 后断言）；旧 `?room=` 打开=进房页且静默归队失败落表单（404 教 token 清空）。
   坑：户内 HTTP join（页内 fetch）**不触 socket=不算在线**，不再撤销毁钟——测「有真人但没上线」时
   别把 join 当「续命」，那是语义而非坑。

## 冒烟后必做

- 把新发现的坑**回写本页**（一行一行加，别攒）。
- 破坏性操作（杀进程/清缓存）前确认 PID 归属，别顺手杀掉别的 node 服务。
