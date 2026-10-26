# Dev 通道速查（M1 单机调试口）

> 内核 dev 意图 + 壳层 `__pz*` 页内通道 + URL 冒烟参数的唯一汇总。M2 搬 Durable Object 时按文末清单收回。

## 内核 dev 意图（`kernel/src/game.ts`，全部要求 `allowDev: true`）

共性：**不消耗随机流**（不污染种子测试）、伤害/淘汰走与真实路径同一原语（`applyHpDelta`/`retirePlayer`）——dev 出来的账与真账同构。

| 意图 | 参数 | 用途 | 约束 |
|---|---|---|---|
| `dev.setPos` | pid, pos, from, net | 钉位置/净步，清 trail/walk | 格越界拒；游离区拉回主干道 |
| `dev.setHp` | pid, hp | 直设血量 | 0..maxHp 界外拒 |
| `dev.setDead` | pid | 完整淘汰口径（清账/手牌回弃/播报同构） | = `retirePlayer` 同构 |
| `dev.drawCard` | pid, cardId | 强抽指定事件卡（绕牌堆） | 已有 cardPending 拒 |
| `dev.giveItem` | pid, cardId | 从牌堆/弃牌堆塞卡进手牌 | **单池守恒**：堆/弃各减一 |
| `dev.hit` | pid, dmg | 走完整伤害通道（护身符/盾照拦） | dmg≤0 拒 |
| `dev.spawnDog` | cell | 钉位生成野狗+当拍同格照打遭遇战 | 格越界拒 |
| `dev.customs` | sheriff? | 钉警长开海关风云（缺省随机指派） | 已有海关拒（与抽卡同闸） |
| `dev.setBeast` | hp | 直改年兽血量；钉 0=当场击杀 | 未开张拒 |

## 壳层页内通道（`client/src/game/store.ts`，`?dev=1` 才挂载）

| 全局函数 | 转发到 | 冒烟用途 |
|---|---|---|
| `__pzcard(cardId, pid=0)` | dev.drawCard | 强抽事件卡（浮层/抉择/效果） |
| `__pzgive(cardId, pid=0)` | dev.giveItem | 塞道具卡 |
| `__pzplay(cardId, target?)` | 真实 playItem 意图 | 道具打出链（非 dev 口子） |
| `__pzdead(pid=0)` | dev.setDead | 出局观战态占位 |
| `__pzcustoms(sheriff?)` | dev.customs | 海关风云（传 0 钉人间当警长） |
| `__pzbeast(hp)` | dev.setBeast | 年兽收束/团灭（钉 1=下一刀必杀） |
| `__pzdog(cell?)` | dev.spawnDog | 遭遇战（缺省人间相邻格） |
| `__pzvis(hidden)` | 伪造 hidden 切换沿 | 单机计时域（T9）：`true`=切后台时钟冻结／`false`=回前台恢复——IAB 常驻 `document.hidden=true` 出不了真实切换沿，冒烟全靠它 |
| `__pz()` | 只读快照 | 内核态随手查：now/turn/phase/me/bots/finishers/hand/ground/dogs/customs/items/msgs |
| `__pztime()` | 对时探针（M2-T7 #44，联机面挂账） | roomStore 的 ServerClock 读数：serverNow/localWallDelta/rttBest/offset/samplesN——改本机时钟判读/重对时样本数冒烟断读；单机 `?fast` 下 serverNow 恒 0（另走 T9 冻结钟域） |

## URL 冒烟参数（`maybeBootFastPath`，免大厅直达一局）

| 参数 | 效果 |
|---|---|
| `?fast` | 短窗局（10s 窗/restMs 0/stepMs 90、3 人、随机 seed），自带 `__pz` 只读快照 |
| `?dev=1` | 开 `allowDev` 并挂全部 `__pz*` 通道 |
| `?win=秒` | 自定义窗长（多步交互冒烟防收窗，如海关任务条） |
| `?slow=1` | 60s 慢窗——**壳层冒烟默认用它**（10s 快窗与逐格走/替掷竞速，手速跟不上） |
| `?turn=N` | 自定义局长 turnCap（快进最后一波用，≥5） |
| `?mode=turn` | 轮班·限时（T9）：按座次轮流行动——配 `&turn=5&win=3` 可 90s 内打满一整局到结算页 |

常用组合：`?fast&slow=1&dev=1`；终局冒烟再加 `&turn=5`；轮班冒烟 `?fast&dev=1&mode=turn&win=3&turn=5`。

## 房间冒烟通道（M2-T3 起，`docs/agents/iab-smoke.md` 配合读）

| 手段 | 效果 |
|---|---|
| `?room=CODE` 链接直跳 | 进房页自动填码；本机存过 token（`pfc.token.<码>`）即静默归队（刷新/断线免重输） |
| 页内 `localStorage.removeItem("pfc.token.<码>")` + 重载 | 模拟全新玩家走表单（清 token 后 join 不归队） |
| 同页签重开 `?room=` 链接 | 同 token 双开顶替：旧连接收横幅「已让位」，新连接归位 |
| 页内 fetch `POST /api/rooms/<码>/join` | HTTP 占座假人（凑满 8 人验拒进），不开 WS |

**同源单身份**：同一浏览器的所有页签共享 localStorage——一个浏览器对一个房间只能持有一个身份；双浏览器语义（两玩家互见/互踢/断线归队双端面）由 server 集成测试（`server/test` 双 WS 客户端）覆盖，IAB 冒烟只走单身份 UX 面。
**双身份豁口（M2-T8 起冒烟在用）**：`localhost:5173` 与 `127.0.0.1:5173` 是不同 origin=两份 localStorage——vite 带 `--host` 起（否则 127.0.0.1 直接连接拒绝），一张标签一张嘴就能演双端；详细判定步见 [iab-smoke.md](./iab-smoke.md)「M2-T8 断线治理冒烟」。

## 测试侧确定性工具（`kernel/test/helpers.ts` + 探针）

- `boot/bootWithDie/bootWithDies/bootWithDiesPure`：种子搜素建局（纪律见文件头「种子搜索纪律」）。
- `tryGiveItem`：条件注入道具，不耗随机流。
- `npm run probe`：常驻探针 REPL（`test/probe.debug.test.ts`；全量测试自动跳过）。
- `npm run dump:board`：棋盘全表（格 id/型/生态/街/坐标/邻接）。

## M2 搬 DO 时要收回的 M1 口子

1. `maybeBootFastPath` 客户端本地建局直连内核（无服务器仲裁）——改走 DO 或仅测试构建保留。
2. 客户端生成种子（`store.ts` 的 `Math.random`）——生产由权威端指派。
3. `?dev=1` 客户端可自开 `allowDev` + 配置域校验豁免——生产 DO 侧强制 `allowDev: false`、不信任客户端配置。
4. 全部 `__pz*` 直调通道与 `__pz()` 全量快照——按调试构建剔除或环境变量门控。
