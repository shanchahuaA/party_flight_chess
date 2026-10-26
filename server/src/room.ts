import {
  CONFIG_LIMITS,
  GAME_DEFAULTS,
  GameKernel,
} from "../../kernel/src/game";
import { KernelError } from "../../kernel/src/types";
import type {
  Fact,
  GameConfig,
  GameState,
  Intent,
} from "../../kernel/src/types";
import type { RoleId } from "../../kernel/src/data/roles";
import { ROLES } from "../../kernel/src/data/roles";
import {
  BOT_NAMES,
  MAX_BOTS,
  MAX_SEATS,
  NICK_MAX,
  type CreateRoomResp,
  type Downstream,
  type JoinRoomResp,
  type LobbyConfig,
  type RoomSeatView,
  type RoomSnapshot,
  type Upstream,
} from "../../shared/protocol";
import { buildGameView } from "./gameView";

// 房间生命周期核（M2-T3，#40）+ 大厅核（M2-T4，#41）+ 对局核（M2-T5，#42）。
// 每个房间一个 DO（ADR-0001）：房间账（座位/昵称/token/房主标记/角色/配置/假人/phase）与
// 对局账（内核整态+pid↔座位映射）全落内置 SQLite——Hibernation 唤醒后内存可能已清空，
// 因此**所有事件处理都直接查 SQLite、不设内存权威缓存**（唯一内存态=懒加载的内核实例句柄），
// 唤醒恢复天然成立。内核原样进 DO、零 fork（ADR 决策；M2-T1 序列化缝 save/load）。
// 连接模型沿用 #8 骨架：Hibernation + setWebSocketAutoResponse 免计费心跳 + attachment 绑 token。
// 配置域与角色表不手抄：直接 import 内核 CONFIG_LIMITS/ROLES。
// 对局面（M2-T5）：start=建号 phase=playing + boot 内核 → 玩家上行 intent（回合号守卫+pid 按
// socket 重定基）→ kernel.apply → 落账 → 逐连接 buildGameView 裁剪广播；Alarm 把 kernel.tick
// 喂进去（窗截止/步进/休息/海关钟等全 deadline 制）;内核 gameEnd（结算）→ phase=intermission
// 回局间配置态（可改配置/选角/再来一局，HTTP join 不放人——Spec Out of Scope）。

/** WS attachment：连接与座位的绑定面（序列化落 Hibernation，唤醒后 deserializeAttachment 可得） */
interface WsAttach {
  token: string;
}

interface SeatRow {
  seat: number;
  token: string;
  name: string;
  joined_at: number;
  /** 明选角色（null=未选：开局缺省真人=轻装上阵、假人=系统随机） */
  role: string | null;
  bot: number;
}

/** 房间行（phase/config/seed 在 T3/T4/本票加入；config 序列化 JSON、缺省=内核默认） */
interface RoomRow {
  code: string;
  host_seat: number;
  created_at: number;
  config: string | null;
  phase: string;
  seed: number | null;
}

/** 房间 phase（对外协议口径）：lobby 大厅态 / playing 对局中 / intermission 局间配置态。
 *  库存值 "started"（T3/T4 遗留、本地 wrangler dev 旧账）归一为 playing 由 normPhase 处理。 */
type RoomPhase = "lobby" | "playing" | "intermission";

/** 大厅默认配置：内核 GAME_DEFAULTS 的可调子集（房主面板改的就是这七个域） */
const DEFAULT_LOBBY_CONFIG: LobbyConfig = {
  turnCap: GAME_DEFAULTS.turnCap,
  maxHp: GAME_DEFAULTS.maxHp,
  windowMs: GAME_DEFAULTS.windowMs,
  restMs: GAME_DEFAULTS.restMs,
  timerMode: GAME_DEFAULTS.timerMode,
  maliceEvery: GAME_DEFAULTS.maliceEvery,
  maliceLevel: GAME_DEFAULTS.maliceLevel,
};

/** 房主配置域校验：数值五项对内核 CONFIG_LIMITS、枚举两项对内核口径——与 GameKernel.create
 *  同一道闸前移到大厅（T5 boot 时内核还会再兜一道）。返回 null=有字段非法。 */
function validateLobbyConfig(raw: unknown): LobbyConfig | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  const cfg: LobbyConfig = {
    turnCap: 0, maxHp: 0, windowMs: 0, restMs: 0,
    timerMode: "world", maliceEvery: 0, maliceLevel: "mild",
  };
  for (const key of ["turnCap", "maxHp", "windowMs", "restMs", "maliceEvery"] as const) {
    const [lo, hi] = CONFIG_LIMITS[key];
    const v = c[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) return null;
    cfg[key] = v;
  }
  if (c.timerMode !== "world" && c.timerMode !== "turn") return null;
  if (c.maliceLevel !== "mild" && c.maliceLevel !== "fierce" && c.maliceLevel !== "off") return null;
  cfg.timerMode = c.timerMode;
  cfg.maliceLevel = c.maliceLevel;
  return cfg;
}

/** 内核意图词表白名单：先于内核挡未知 type——kernel.apply 的 switch 无 default 分支，
 *  未知 type 会静默落进收尾步（得不抛错的空批）。白名单与 kernel types.ts 的 Intent union
 *  对齐（dev 系放行进内核再拒——allowDev=false 的拒绝事实「dev 意图未开放」在此露出）。 */
const KNOWN_INTENT_TYPES = new Set<string>([
  "roll", "confirm", "chooseRoute", "skipRest", "chooseSecret", "chooseCard",
  "playItem", "customsShip", "customsCheck", "customsGive", "strike", "giveItem", "hitBeast",
  "dev.back", "dev.setPos", "dev.setHp", "dev.setDead", "dev.drawCard", "dev.giveItem",
  "dev.hit", "dev.spawnDog", "dev.setBeast", "dev.customs",
]);

export class Room {
  constructor(private readonly state: DurableObjectState) {
    // 心跳原样应答、不唤醒进程、不计费（ADR-0001 §2）
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureSchema();
    const url = new URL(request.url);
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() === "websocket") {
      return this.handleUpgrade(url);
    }
    if (request.method === "POST" && url.pathname === "/init") {
      return this.handleInit(request);
    }
    if (request.method === "POST" && url.pathname === "/join") {
      return this.handleJoin(request);
    }
    return new Response("not found", { status: 404 });
  }

  /** 幂等建表（CREATE TABLE IF NOT EXISTS，同步 DDL，随首个事件执行一次）。
   *  T4 加列（room.config/phase/seed、seats.role/bot）；T5 加表 game（对局账 singleton）。
   *  线上无存量账，本地 wrangler dev 的旧存储靠补列迁移继续醒——列已存在时 ALTER 抛错即吞。 */
  private ensureSchema(): void {
    this.state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS room (
         code TEXT PRIMARY KEY,
         host_seat INTEGER NOT NULL,
         created_at INTEGER NOT NULL,
         config TEXT,
         phase TEXT NOT NULL DEFAULT 'lobby',
         seed INTEGER
       )`,
    );
    this.state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS seats (
         seat INTEGER PRIMARY KEY,
         token TEXT NOT NULL UNIQUE,
         name TEXT NOT NULL,
         joined_at INTEGER NOT NULL,
         seq INTEGER NOT NULL,
         role TEXT,
         bot INTEGER NOT NULL DEFAULT 0
       )`,
    );
    this.state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS game (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         state TEXT NOT NULL,
         seat_map TEXT NOT NULL,
         saved_at INTEGER NOT NULL
       )`,
    );
    this.addColumnIfMissing("room", "config", "TEXT");
    this.addColumnIfMissing("room", "phase", "TEXT NOT NULL DEFAULT 'lobby'");
    this.addColumnIfMissing("room", "seed", "INTEGER");
    this.addColumnIfMissing("seats", "role", "TEXT");
    this.addColumnIfMissing("seats", "bot", "INTEGER NOT NULL DEFAULT 0");
  }

  private addColumnIfMissing(table: string, column: string, ddl: string): void {
    try {
      this.state.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    } catch {
      /* 列已存在 */
    }
  }

  // ── HTTP 面（Worker 入口转发）：创建与加入都在这里签发 token，WS 只凭 token 认座 ──

  /** 创建房间：房间账不存在才建（存在=码撞，Worker 侧重试换码）；创建者即房主即座位 0。
   *  开局配置随建账落内核默认值（房主面板后续改的就是这行 JSON）。 */
  private async handleInit(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
    const name = normName(body?.name);
    if (name == null) return apiError(400, "昵称不能为空");
    const exists = this.roomRow();
    if (exists) return apiError(409, "occupied");
    const code = this.state.id.name ?? "";
    const token = newToken();
    this.state.storage.sql.exec(
      "INSERT INTO room (code, host_seat, created_at, config, phase) VALUES (?, ?, ?, ?, 'lobby')",
      code, 0, Date.now(), JSON.stringify(DEFAULT_LOBBY_CONFIG),
    );
    this.state.storage.sql.exec(
      "INSERT INTO seats (seat, token, name, joined_at, seq) VALUES (?, ?, ?, ?, 1)",
      0, token, name, Date.now(),
    );
    return Response.json({ code, token, seat: 0 } satisfies CreateRoomResp);
  }

  /** 加入：满 8 人拒进；phase!=lobby 拒进（Spec #37 Out of Scope：新面孔仅限大厅态，局间配置态
   *  不放新面孔、局中只许掉线归队）；座位取最小空位（离房空出的座位可复用） */
  private async handleJoin(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
    const name = normName(body?.name);
    if (name == null) return apiError(400, "昵称不能为空");
    const room = this.roomRow();
    if (!room) return apiError(404, "房间不存在或已解散");
    if (this.normPhase(room) !== "lobby") return apiError(409, "已开局，不能再加入");
    const taken = this.seatRows();
    if (taken.length >= MAX_SEATS) return apiError(409, "房间已满（8 人）");
    const seat = this.firstFreeSeat();
    const token = newToken();
    this.state.storage.sql.exec(
      "INSERT INTO seats (seat, token, name, joined_at, seq) VALUES (?, ?, ?, ?, ?)",
      seat, token, name, Date.now(), this.nextSeq(),
    );
    return Response.json({ token, seat } satisfies JoinRoomResp);
  }

  /** 座位序 seq：房内单调递增（Date.now() 同毫秒会打平，join/加假人次序必须是硬序） */
  private nextSeq(): number {
    const rows = this.state.storage.sql
      .exec("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM seats")
      .toArray() as unknown as Array<{ next: number }>;
    return rows[0]?.next ?? 1;
  }

  // ── WS 面：upgrade 前先验 token（不验不上线），attachment 绑 token → 座位 ──

  private handleUpgrade(url: URL): Response {
    const token = url.searchParams.get("token") ?? "";
    if (!this.roomRow()) return apiError(404, "房间不存在或已解散");
    const seat = this.seatByToken(token);
    if (seat == null) return apiError(401, "身份已失效，请重新进房");

    // 同 token 顶替（双开防漂移）：先踢旧连（下线通知+关闭），新连接随后收快照。
    // 旧 socket 在 close 事件落地前仍会短暂留在 getWebSockets() 里，send 抛错由 send() 吞掉，无碍。
    for (const old of this.state.getWebSockets()) {
      const att = old.deserializeAttachment() as WsAttach | null;
      if (att?.token === token) {
        this.send(old, { type: "replaced" });
        try {
          old.close(4001, "replaced");
        } catch {
          // 已在关闭中的 socket 再 close 会抛，忽略
        }
      }
    }

    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ token } satisfies WsAttach);
    this.send(pair[1], this.buildRoomMsg(seat));
    // 对局中连接（含掉线断线重连=凭 token 归队，M2-T5）：room hello 照旧，追加一条 game 消息
    // （facts=[] 的全量快照——重连与在场者收到的游戏包同构，Spec #37 决策 3「重连=同构大快照」）
    if (this.normPhase() === "playing") {
      this.sendGameTo(pair[1], seat, []); // 内核账缺行等极端态：静默不发，error 面兜底
    }
    // 其他人看到该座位转在线：发送上排除自己（已有直发），统计上**不排除**——新 socket 已 accept、是真在线
    this.pushRoomTo(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    const msg = parsed as Upstream;
    const token = (ws.deserializeAttachment() as WsAttach | null)?.token ?? "";
    const seat = this.seatByToken(token);
    if (seat == null) {
      // 座位已不在（离房后旧连接迟到消息等）：令其下线
      this.send(ws, { type: "error", message: "你已不在房间" });
      try {
        ws.close(1000);
      } catch {
        /* 已关闭 */
      }
      return;
    }
    if (msg?.type === "intent") {
      this.handleIntent(ws, seat, msg);
      return;
    }
    if (msg?.type === "leave") {
      if (this.normPhase() === "playing") {
        // 对局中封离席（M2-T5 定案）：内核名册 boot 即定死、无「座位减少」自愈面——真人棋子的
        // 「断线替掷接管/重连归队」语义在 T8 接线，本票先把口子锁住（防名册与 kernel 脱钩）。
        this.send(ws, { type: "error", message: "对局进行中，暂不能离席" });
        return;
      }
      const wasHost = this.roomRow()?.host_seat === seat;
      this.removeSeat(seat);
      // 房主主动离房：标记转给最早加入的在座真人（ADR-0001 §6；假人当不了房主——
      // 它按不了开始也改不了配置，皇冠落它头上=房间死局）；离线超时的转移在 T8
      if (wasHost) this.reassignHost();
      if (this.humanCount() === 0) {
        // 在座真人清零：房间即世界，当场销毁（剩的假人不是人；全员离线 5 分钟的 Alarm 在 T8）
        this.destroy();
        return;
      }
      // 离房无回包：socket 关闭即 ack（客户端主动发 leave，知道自己为什么断开）
      try {
        ws.close(1000, "left");
      } catch {
        /* 已关闭 */
      }
      this.pushRoomTo(ws, ws); // 发送与统计都排除离房者（其 socket 关闭事件落地前仍在列表里）
      return;
    }
    if (msg?.type === "dissolve") {
      if (this.roomRow()?.host_seat !== seat) {
        this.send(ws, { type: "error", message: "只有房主能解散房间" });
        return;
      }
      this.destroy();
      return;
    }
    // ── 大厅/局间动作（M2-T4+T5）：lobby|intermission 二态开放同一闸（intermission=局间配置态，
    //    含每局新种子）；playing 期间大厅面全收口 ──
    if (msg?.type === "pickRole") {
      const gate = this.lobbyGate(seat, null);
      if (gate) {
        this.send(ws, { type: "error", message: gate });
        return;
      }
      if (!ROLES.some((r) => r.id === msg.roleId)) {
        this.send(ws, { type: "error", message: "未知角色" });
        return;
      }
      this.state.storage.sql.exec("UPDATE seats SET role = ? WHERE seat = ?", msg.roleId, seat);
      this.pushRoomTo(); // 发全员含操作者：胖快照对齐即 ack（可重复选/换选，无唯一性冲突）
      return;
    }
    if (msg?.type === "setConfig") {
      const gate = this.lobbyGate(seat, "只有房主能改配置");
      if (gate) {
        this.send(ws, { type: "error", message: gate });
        return;
      }
      const cfg = validateLobbyConfig(msg.config);
      if (!cfg) {
        this.send(ws, { type: "error", message: "配置超出允许范围" });
        return;
      }
      this.state.storage.sql.exec("UPDATE room SET config = ? WHERE code = ?", JSON.stringify(cfg), this.state.id.name ?? "");
      this.pushRoomTo();
      return;
    }
    if (msg?.type === "addBot") {
      const gate = this.lobbyGate(seat, "只有房主能加减假人");
      if (gate) {
        this.send(ws, { type: "error", message: gate });
        return;
      }
      const seats = this.seatRows();
      const bots = seats.filter((s) => s.bot);
      if (bots.length >= MAX_BOTS) {
        this.send(ws, { type: "error", message: "假人最多 7 个" });
        return;
      }
      if (seats.length >= MAX_SEATS) {
        this.send(ws, { type: "error", message: "房间已满（8 人），加不了假人" });
        return;
      }
      const free = this.firstFreeSeat();
      const usedNames = new Set(bots.map((s) => s.name));
      const name = BOT_NAMES.find((n) => !usedNames.has(n)) ?? `假人${free + 1}`;
      const seq = this.nextSeq();
      // 假人 token=合成值（bot:<seq>，永不签发给真人）；seatByToken 只认 bot=0 的行，假人永不上线
      this.state.storage.sql.exec(
        "INSERT INTO seats (seat, token, name, joined_at, seq, role, bot) VALUES (?, ?, ?, ?, ?, NULL, 1)",
        free, `bot:${seq}`, name, Date.now(), seq,
      );
      this.pushRoomTo();
      return;
    }
    if (msg?.type === "removeBot") {
      const gate = this.lobbyGate(seat, "只有房主能加减假人");
      if (gate) {
        this.send(ws, { type: "error", message: gate });
        return;
      }
      const rows = this.state.storage.sql
        .exec("SELECT seat FROM seats WHERE bot = 1 ORDER BY seq DESC LIMIT 1")
        .toArray() as unknown as Array<{ seat: number }>;
      if (!rows[0]) {
        this.send(ws, { type: "error", message: "没有假人可减" });
        return;
      }
      this.state.storage.sql.exec("DELETE FROM seats WHERE seat = ?", rows[0].seat);
      this.pushRoomTo();
      return;
    }
    if (msg?.type === "start") {
      this.handleStart(ws, seat);
      return;
    }
    this.send(ws, { type: "error", message: "未知消息" });
  }

  /** 房主开始（lobby|intermission 皆可开）：建号 phase=playing + boot 内核转对局态（M2-T5 实装）。
   *  seed 在本次 start 重新生成落账（每局新随机种子，Spec 实现决策 2/6「换新随机种子」）。 */
  private handleStart(ws: WebSocket, seat: number): void {
    const gate = this.lobbyGate(seat, "只有房主能开始");
    if (gate) {
      this.send(ws, { type: "error", message: gate });
      return;
    }
    const seats = this.seatRows();
    if (seats.length < 2) {
      this.send(ws, { type: "error", message: "至少 2 人才能开局——人不够可以先加假人" });
      return;
    }
    const room = this.roomRow()!;
    // 座位升序拼 PlayerDef[]（pid=seats 升序下标）；role 缺省不传 roleId（内核缺省：真人=轻装上阵、假人=系统随机）
    const defs = seats.map((s) => ({
      name: s.name,
      isBot: !!s.bot,
      ...(s.role != null ? { roleId: s.role as RoleId } : {}),
    }));
    const lobby = room.config ? (JSON.parse(room.config) as LobbyConfig) : DEFAULT_LOBBY_CONFIG;
    // 每局新种子（本次 start 现场生成）；配置七域=房主大厅面板落账的 LobbyConfig（kernel 再兜域校验）；
    // routeAskMs/stepMs 取内核默认（不可调域，Spec #37 决策 6）。allowDev 不传=服务端永远关 dev 意图。
    const seedBytes = new Uint32Array(1);
    crypto.getRandomValues(seedBytes);
    const config: GameConfig = {
      ...GAME_DEFAULTS,
      seed: seedBytes[0],
      turnCap: lobby.turnCap,
      maxHp: lobby.maxHp,
      windowMs: lobby.windowMs,
      restMs: lobby.restMs,
      timerMode: lobby.timerMode,
      maliceEvery: lobby.maliceEvery,
      maliceLevel: lobby.maliceLevel,
    };
    let kernel: GameKernel;
    let bootFacts: Fact[];
    try {
      const made = GameKernel.create(config, this.now(), defs);
      kernel = made.kernel;
      bootFacts = made.facts; // 开局事实（drafting 抽暗牌/轻装上阵摸牌等）随广播下发
    } catch (e) {
      // 配置/名册意外被内核拒（配置已按 CONFIG_LIMITS 校验、人数已挡，理论上不可达）：不翻 phase 直接回 error
      this.send(ws, { type: "error", message: e instanceof KernelError ? e.message : "开局失败，请重试" });
      return;
    }    this.pidSeat = seats.map((s) => s.seat); // pid=座位升序下标（seat_map 同源）
    this.kernel = kernel;
    this.lastIdleAt = this.now(); // boot 已把 ≤now 的一切给过内核一次（新局时钟账从零起步）
    this.state.storage.sql.exec(
      "UPDATE room SET phase = 'playing', seed = ? WHERE code = ?",
      config.seed, this.state.id.name ?? "",
    );
    this.saveGame(kernel);
    // 广播：逐连接 room 快照（phase=playing，大厅面收口）+ game 开局全量（开局事实批），顺序固定
    this.pushRoomTo();
    this.broadcastGame(bootFacts);
  }

  webSocketClose(ws: WebSocket): void {
    if (!this.roomRow()) return; // 房间已销毁（解散刚清完账）：无广播对象
    this.pushRoomTo(ws, ws); // close 事件触发时该 socket 仍在列表里，发送与统计都要排除它
  }

  // ── 对局门（M2-T5）：意图受理链——门闸→回合号守卫→pid 守卫→pid 替换→kernel.apply ──

  private handleIntent(ws: WebSocket, seat: number, msg: Extract<Upstream, { type: "intent" }>): void {
    // 门闸：仅 playing 受理（lobby=「对局未开始」；intermission 同样只收配置面动作）
    if (this.normPhase() !== "playing" || !this.ensureKernel()) {
      this.send(ws, { type: "error", message: "对局未开始" });
      this.sendAlignTo(ws);
      return;
    }
    const kernel = this.kernel!;
    // 回合号守卫：上行 turn 与内核当前回合不对账=过期操作（协议纪律：所有上行带 turn）
    if (typeof msg.turn !== "number" || !Number.isFinite(msg.turn) || msg.turn !== kernel.state.turn) {
      this.send(ws, { type: "error", message: "操作过期，请按最新回合操作" });
      this.sendAlignTo(ws);
      return;
    }
    const intent = msg.intent as { type?: string; pid?: number; [k: string]: unknown } | null | undefined;
    if (!intent || typeof intent.type !== "string" || !KNOWN_INTENT_TYPES.has(intent.type)) {
      this.send(ws, { type: "error", message: "未知意图" });
      this.sendAlignTo(ws);
      return;
    }
    const pid = this.pidOfSeat(seat); // seat→pid 反查（boot 的座位升序映射）
    if (pid == null) {
      // 座位不在 kernel 名册（如局间旧账+座位表变动的极端态）：拒绝而非把空 pid 换给内核
      this.send(ws, { type: "error", message: "你已不在对局中" });
      this.sendAlignTo(ws);
      return;
    }
    // pid 视角转译（协议规定上行 intent.pid 恒=0=发送者视角）：替换成真实 pid 才能交内核
    if ("pid" in intent) intent.pid = pid;
    let facts: Fact[] | null;
    try {
      facts = kernel.apply(intent as Intent, this.now());
    } catch (e) {
      // KernelError/意外拒绝：该 socket 收 error 事实 + 整份对局快照对齐（非广播）；局不崩（ADR：非法操作绝不半截）
      const text = e instanceof Error ? e.message : "无法执行该操作";
      this.send(ws, { type: "error", message: text });
      this.sendAlignTo(ws);
      return;
    }
    this.afterKernelChanged(facts);
  }

  /** 每次内核变化（apply/tick）后统一收口：落账 → 逐连接裁剪广播 →（gameEnd 时）房间面翻
   *  intermission + 房间快照播报 → 重排 Alarm。顺序：落账最前，广播期间内核已定稿。 */
  private afterKernelChanged(facts: Fact[]): void {
    const kernel = this.kernel;
    if (!kernel) return;
    this.saveGame(kernel); // 每次内核变化即整包落账（Hibernation 恢复真源）
    this.broadcastGame(facts);
    if (facts.some((f) => f.type === "gameEnd")) {
      // 内核 phase=over（结算已落账）：房间面回局间配置态——大变，一并广播房间快照
      this.state.storage.sql.exec(
        "UPDATE room SET phase = 'intermission' WHERE code = ?",
        this.state.id.name ?? "",
      );
      this.pushRoomTo();
    }
    this.scheduleAlarm();
  }

  // ── Alarm 计时（ADR-0001 §3 服务端唯一权威）：tick 进给+编排放送 ──

  /** alarm 到点：内核时钟推进一步→统一收口。内存干净时（唤醒/首拍）先 ensureKernel。 */
  async alarm(): Promise<void> {
    const roomPhase = this.normPhase();
    if (roomPhase !== "playing" || !this.ensureKernel()) {
      // 残留 alarm（旧局收场/房间销毁后未清的钟）：清钟即止
      this.state.storage.deleteAlarm();
      return;
    }
    const tickNow = this.now();
    let facts: Fact[] = [];
    try {
      facts = this.kernel!.tick(tickNow);
    } catch {
      facts = []; // tick 自身异常不破 DO：如实当空批收口（内核有回归测试兜底，这里不掏错误细节）
    }
    // ≤tickNow 的所有时限都在这一拍里给过内核机会（fireBots/步进/收窗/休息/海关钟全套）
    this.lastIdleAt = Math.max(this.lastIdleAt, tickNow);
    this.afterKernelChanged(facts);
  }

  /**
   * 重排 Alarm：从内核态扫最早未来时限。时限全部是内核时钟轴（now()=Date.now()+clockOffset），
   * 派给 setAlarm 前按 `- clockOffset` 折算回真实 epoch。
   * 扫描口径=「kernel 哪些位置等在一个时限上」而不复刻内核判定逻辑（DO 只管时钟进给）：
   * - windowDeadline（acting）/ restUntil（rest）：阶段专属；
   * - walk.nextStepAt / walk.ask.deadline / cardPending.deadline：跨阶段（rest/over 也有续走与挂账）；
   * - botSchedule.rollAt（acting）/ customs 时钟群（acting，armed 才有查验钟）。
   * - ≤ lastIdleAt（上次内核消化过的时钟点）的时限不再派：哨兵噪声（botSchedule.confirmAt=0、
   *   旧局的 rollAt/时限残值等）不再重派，防 alarm 空转自旋；drafting 期扫描整体为空（开局无钟）。
   * 无时限=删钟。
   */
  private scheduleAlarm(): void {
    const kernel = this.kernel;
    if (!kernel) {
      void this.state.storage.deleteAlarm();
      return;
    }
    const s = kernel.state;
    const cands: number[] = [];
    if (s.phase === "acting") {
      cands.push(s.windowDeadline);
      for (const p of s.players) {
        if (!p.dead) cands.push(p.botSchedule.rollAt);
      }
      const c = s.customs;
      if (c) {
        if (c.armed) cands.push(c.checkDeadline);
        if (c.pending) cands.push(c.pending.deadline);
        for (const b of c.botPlans) cands.push(b.at);
      }
    }
    if (s.phase === "rest") cands.push(s.restUntil);
    // 跨阶段面：走路/环岛选路/抉择卡挂账（rest 与 over 也吃它们）
    for (const p of s.players) {
      if (p.walk) {
        cands.push(p.walk.nextStepAt);
        if (p.walk.ask) cands.push(p.walk.ask.deadline);
      }
      if (p.cardPending) cands.push(p.cardPending.deadline);
    }
    let next: number | null = null;
    for (const t of cands) {
      if (!Number.isFinite(t) || t <= this.lastIdleAt) continue; // 已被内核消化/不待办
      if (next == null || t < next) next = t;
    }
    if (next == null) {
      void this.state.storage.deleteAlarm();
      return;
    }
    // 内核时钟→真实 epoch；≥此刻 1ms（过时戳=「尽快一条」——kernel tick 会吃掉它）
    void this.state.storage.setAlarm(Math.max(Date.now() + 1, next - this.clockOffset));
  }

  // ── 内核进出（重启恢复 / 开局落账）──

  /** 内核时钟轴 = DO 的 now()：生产 clockOffset 恒 0；测试经 runInDurableObject 直改私有字段快进时间 */
  private clockOffset = 0;

  /** 空转簿记：≤ 它的时限已在最近一拍给过内核机会，再喂不再行动——见 scheduleAlarm 注释 */
  private lastIdleAt = 0;

  /** 内核实例句柄（懒加载、非权威——权威=SQLite 的 game 行；任何事件兜底 ensureKernel） */
  private kernel: GameKernel | null = null;

  /** pid→座位（boot 定死、随 seat_map 落账；内存反查表由 ensureKernel 从账恢复） */
  private pidSeat: number[] | null = null;

  now(): number {
    return Date.now() + this.clockOffset;
  }

  /** 内核账缺失/不允许（playing 且 game 行在）时懒加载续局：重启恢复的唯一通道 */
  private ensureKernel(): GameKernel | null {
    if (this.kernel) return this.kernel;
    const room = this.roomRow();
    if (!room || this.normPhase(room) !== "playing") return null;
    const rows = this.state.storage.sql
      .exec("SELECT state, seat_map FROM game WHERE id = 1")
      .toArray() as unknown as Array<{ state: string; seat_map: string }>;
    const row = rows[0];
    if (!row) return null;
    let saved: GameState;
    let seatMap: number[];
    try {
      saved = JSON.parse(row.state) as GameState;
      const map = JSON.parse(row.seat_map) as Record<string, number>;
      seatMap = Object.entries(map)
        .map(([pid, seat]) => [Number(pid), seat])
        .sort((a, b) => a[0] - b[0])
        .map(([, seat]) => seat);
    } catch {
      return null; // 账残缺：对局不可续（error 面兜底，T8 会有重开面）
    }
    try {
      this.kernel = GameKernel.load(this.gameConfig(room), saved);
      this.pidSeat = seatMap;
      return this.kernel;
    } catch {
      return null;
    }
  }

  /** 由房间账重建 GameConfig（boot 与续局同一构造——seed/config 在 start 落定、局中冻结） */
  private gameConfig(room: RoomRow): GameConfig {
    const lobby = room.config ? (JSON.parse(room.config) as LobbyConfig) : DEFAULT_LOBBY_CONFIG;
    return {
      ...GAME_DEFAULTS,
      seed: room.seed ?? GAME_DEFAULTS.seed,
      turnCap: lobby.turnCap,
      maxHp: lobby.maxHp,
      windowMs: lobby.windowMs,
      restMs: lobby.restMs,
      timerMode: lobby.timerMode,
      maliceEvery: lobby.maliceEvery,
      maliceLevel: lobby.maliceLevel,
    };
  }

  /** 对局落账：整包内核态+pid↔座位映射写 game 表 singleton（每次内核变化调） */
  private saveGame(kernel: GameKernel): void {
    const seatMap: Record<string, number> = {};
    (this.pidSeat ?? []).forEach((seat, pid) => {
      seatMap[pid] = seat;
    });
    this.state.storage.sql.exec(
      `INSERT INTO game (id, state, seat_map, saved_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET state = excluded.state, seat_map = excluded.seat_map, saved_at = excluded.saved_at`,
      JSON.stringify(kernel.save()),
      JSON.stringify(seatMap),
      Date.now(),
    );
  }

  /** pidOfSeat：boot 时座位=seats 升序、pid=该序下标（开局定死落到 seat_map） */
  private pidOfSeat(seat: number): number | null {
    const map = this.pidSeat;
    if (!map) return null;
    const pid = map.indexOf(seat);
    return pid >= 0 ? pid : null;
  }

  /** seatOfPid：pid→座位（boot 座位升序；与 pidOfSeat 同一映射） */
  private seatOfPid(pid: number): number | null {
    const map = this.pidSeat;
    return map && pid >= 0 && pid < map.length ? map[pid] : null;
  }

  // ── 房间账读写（全部直查 SQLite）──

  /** 库存 phase 归一：T3/T4 遗留值 "started" 视同 playing（本地 wrangler dev 旧账兼容面） */
  private normPhase(room?: RoomRow | null): RoomPhase {
    const p = (room ?? this.roomRow())?.phase;
    if (p === "playing" || p === "started") return "playing";
    if (p === "intermission") return "intermission";
    return "lobby";
  }

  /** 大厅/局间动作公共闸：lobby|intermission 放行 +（房主动作）房主校验。null=通过 */
  private lobbyGate(seat: number, hostDenied: string | null): string | null {
    const room = this.roomRow();
    if (!room) return "房间不存在或已解散";
    const phase = this.normPhase(room);
    if (phase !== "lobby" && phase !== "intermission") return "已开局，大厅已收口";
    if (hostDenied != null && room.host_seat !== seat) return hostDenied;
    return null;
  }

  private roomRow(): RoomRow | null {
    const rows = this.state.storage.sql
      .exec("SELECT code, host_seat, created_at, config, phase, seed FROM room LIMIT 1")
      .toArray() as unknown as RoomRow[];
    return rows[0] ?? null;
  }

  private seatRows(): SeatRow[] {
    return this.state.storage.sql
      .exec("SELECT seat, token, name, joined_at, role, bot FROM seats ORDER BY seat")
      .toArray() as unknown as SeatRow[];
  }

  /** token→座位：只认真人行（bot=0）。假人 token 是合成值（bot:<seq>），永不能认证 WS */
  private seatByToken(token: string): number | null {
    if (!token) return null;
    const rows = this.state.storage.sql
      .exec("SELECT seat FROM seats WHERE token = ? AND bot = 0", token)
      .toArray() as unknown as Array<{ seat: number }>;
    return rows[0]?.seat ?? null;
  }

  private removeSeat(seat: number): void {
    this.state.storage.sql.exec("DELETE FROM seats WHERE seat = ?", seat);
  }

  /** 在座真人数（假人凑局不算「人在」：真人清零=房间无主可经营，销毁） */
  private humanCount(): number {
    return this.seatRows().filter((s) => !s.bot).length;
  }

  /** 最小空位（离房空出的座位可复用；join 与加假人同一条分配规则） */
  private firstFreeSeat(): number {
    const used = new Set(this.seatRows().map((s) => s.seat));
    let seat = 0;
    while (used.has(seat)) seat++;
    return seat;
  }

  /** 房主标记转给最早加入的在座真人（ADR-0001 §6）——按入座序 seq 排序而非座位号：
   *  座位可复用，1 号位的新面孔可能比 2 号位的老玩家晚进房。假人排除：见 leave 处注释 */
  private reassignHost(): void {
    const rows = this.state.storage.sql
      .exec("SELECT seat FROM seats WHERE bot = 0 ORDER BY seq, seat LIMIT 1")
      .toArray() as unknown as Array<{ seat: number }>;
    if (rows[0]) {
      this.state.storage.sql.exec("UPDATE room SET host_seat = ?", rows[0].seat);
    }
  }

  /** 解散/销毁：清全部账（含对局账）、广播后全员断线 */
  private destroy(): void {
    this.broadcast({ type: "dissolved" });
    this.state.storage.sql.exec("DELETE FROM seats");
    this.state.storage.sql.exec("DELETE FROM game");
    this.state.storage.sql.exec("DELETE FROM room");
    this.kernel = null;
    for (const w of this.state.getWebSockets()) {
      try {
        w.close(1000, "dissolved");
      } catch {
        /* 已关闭 */
      }
    }
  }

  // ── 快照与广播 ──

  /** 在线 = 连接还挂着的 token 集。exclude：close 事件里的 socket 仍留在 getWebSockets() 中
   *  （Hibernation API 既有坑，#8 记录在案），统计必须排除，否则离座座位永远显示在线 */
  private onlineTokens(exclude?: WebSocket): Set<string> {
    const online = new Set<string>();
    for (const w of this.state.getWebSockets()) {
      if (w === exclude) continue;
      const att = w.deserializeAttachment() as WsAttach | null;
      if (att?.token) online.add(att.token);
    }
    return online;
  }

  private buildSnapshot(exclude?: WebSocket): RoomSnapshot {
    const room = this.roomRow();
    const online = this.onlineTokens(exclude);
    const phase = this.normPhase(room);
    const seats: RoomSeatView[] = this.seatRows().map((s) => ({
      seat: s.seat,
      name: s.name,
      online: online.has(s.token),
      host: room?.host_seat === s.seat,
      roleId: (s.role as RoomSeatView["roleId"]) ?? null,
      bot: !!s.bot,
    }));
    const config = room?.config
      ? (JSON.parse(room.config) as LobbyConfig)
      : { ...DEFAULT_LOBBY_CONFIG };
    return {
      code: this.state.id.name ?? "",
      hostSeat: room?.host_seat ?? 0,
      phase,
      config,
      seats,
    };
  }

  private buildRoomMsg(you: number | null, excludeOnline?: WebSocket): Downstream {
    return { type: "room", room: this.buildSnapshot(excludeOnline), you, now: Date.now() };
  }

  /**
   * 把当前快照推给除 excludeSend 外的所有连接。
   * excludeSend：不该收到此条的 socket（新连自己已有直发快照 / 正在关闭的 socket）。
   * excludeOnline：在线统计要排除的 socket（仅正在关闭的——它已死但仍在列表里）；
   * 新连上线时不传，新 socket 计入在线。
   */
  private pushRoomTo(excludeSend?: WebSocket, excludeOnline?: WebSocket): void {
    const msg = this.buildRoomMsg(null, excludeOnline);
    for (const w of this.state.getWebSockets()) {
      if (w === excludeSend) continue;
      this.send(w, msg);
    }
  }

  private broadcast(msg: Downstream): void {
    for (const w of this.state.getWebSockets()) this.send(w, msg);
  }

  /**
   * 对局广播（M2-T5）：逐连接逐人构建——收者视角重定基+裁剪后整份 game 消息（每次一个新克隆，
   * 绝不全场共用一条 JSON）。kernel.save() 的快照是广播源（引用只读，buildGameView 内深克隆隔离）。
   */
  private broadcastGame(facts: Fact[]): void {
    const kernel = this.kernel ?? this.ensureKernel();
    if (!kernel) return;
    const saved = kernel.save();
    for (const w of this.state.getWebSockets()) {
      const att = w.deserializeAttachment() as WsAttach | null;
      const seat = att?.token ? this.seatByToken(att.token) : null;
      if (seat != null) this.sendGameToRaw(w, seat, facts, saved);
    }
  }

  /** 单连接的 game 消息（直发：hello/命中 error 后的对齐）。视图缺 seat（kernel 名册外）时不发。 */
  private sendGameTo(ws: WebSocket, seat: number, facts: Fact[]): void {
    const kernel = this.kernel ?? this.ensureKernel();
    if (!kernel) return;
    this.sendGameToRaw(ws, seat, facts, kernel.save());
  }

  /** 带现成快照源的构建+发送（broadcastGame 循环里复用一份 save，逐收者深克隆隔离不串染） */
  private sendGameToRaw(ws: WebSocket, seat: number, facts: Fact[], saved: GameState): void {
    const pid = this.pidOfSeat(seat);
    if (pid == null) return; // 座位不在 kernel 名册（intermission 旧账等）：老游戏不留接缝
    const view = buildGameView(saved, facts, pid);
    this.send(ws, { type: "game", now: Date.now(), facts: view.facts, messages: view.messages, state: view.state });
  }

  /**
   * 单独对齐一个 socket（error 后、非法意图后）—— помощи: room 快照 + 对局快照（若 playing），
   * 自收补差包不带新事实（facts=[]）。
   */
  private sendAlignTo(ws: WebSocket): void {
    const att = ws.deserializeAttachment() as WsAttach | null;
    const seat = att?.token ? this.seatByToken(att.token) : null;
    if (seat != null) this.send(ws, this.buildRoomMsg(seat));
    if (this.normPhase() === "playing" && seat != null) this.sendGameTo(ws, seat, []);
  }

  private send(ws: WebSocket, msg: Downstream): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // 对端刚好断开时 send 会抛，忽略即可
    }
  }
}

/** 昵称规整：trim 后非空才收，超长截断（两端口径一致，server 是最后一道） */
function normName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().slice(0, NICK_MAX);
  return name.length > 0 ? name : null;
}

/** 身份 token（随机 capability，进房签发一次；泄露面=同房间座位，不承担跨房安全） */
function newToken(): string {
  return crypto.randomUUID();
}

function apiError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}
