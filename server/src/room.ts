import {
  CONFIG_LIMITS,
  GAME_DEFAULTS,
} from "../../kernel/src/game";
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

// 房间生命周期核（M2-T3，#40）+ 大厅核（M2-T4，#41）。每个房间一个 DO（ADR-0001），
// 房间账（座位/昵称/token/房主标记/角色/配置/假人/phase）全落内置 SQLite——Hibernation 唤醒后
// 内存可能已清空，因此**所有事件处理都直接查 SQLite、不设内存缓存**（懒加载模式的替代：
// 读多但账极小，无缓存即无失效 bug），唤醒恢复天然成立。
// 连接模型沿用 #8 骨架：Hibernation + setWebSocketAutoResponse 免计费心跳 + attachment 绑 token。
// 配置域与角色表不手抄：直接 import 内核 CONFIG_LIMITS/ROLES（内核进 server 的第一处，T5 全量进）。

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

/** 房间行（phase/config 在 T4 加入；config 序列化 JSON、缺省=内核默认） */
interface RoomRow {
  code: string;
  host_seat: number;
  phase: string;
  config: string | null;
}

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
   *  T4 加列（room.config/phase/seed、seats.role/bot）：线上无存量账，本地 wrangler dev 的
   *  旧存储靠补列迁移继续醒——列已存在时 ALTER 抛错即吞。 */
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

  /** 加入：满 8 人拒进；已开局拒进（Spec #37 Out of Scope：新面孔仅限大厅态，局中只许掉线归队）；
   *  座位取最小空位（离房空出的座位可复用） */
  private async handleJoin(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
    const name = normName(body?.name);
    if (name == null) return apiError(400, "昵称不能为空");
    const room = this.roomRow();
    if (!room) return apiError(404, "房间不存在或已解散");
    if (room.phase !== "lobby") return apiError(409, "已开局，不能再加入");
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
    if (msg?.type === "leave") {
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
    // ── 大厅态动作（M2-T4，#41）：phase!=lobby 一律拒（开赛后大厅面收口）──
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
      const gate = this.lobbyGate(seat, "只有房主能开始");
      if (gate) {
        this.send(ws, { type: "error", message: gate });
        return;
      }
      if (this.seatRows().length < 2) {
        this.send(ws, { type: "error", message: "至少 2 人才能开局——人不够可以先加假人" });
        return;
      }
      // 开局流程：phase 翻转 + 种子落账（T5 起此处直接 boot 内核转对局态，种子即新局的 seed）
      const seedBytes = new Uint32Array(1);
      crypto.getRandomValues(seedBytes);
      this.state.storage.sql.exec(
        "UPDATE room SET phase = 'started', seed = ? WHERE code = ?",
        seedBytes[0], this.state.id.name ?? "",
      );
      this.pushRoomTo();
      return;
    }
    this.send(ws, { type: "error", message: "未知消息" });
  }

  /** 被动掉线（关页/断网）：座位保留、凭 token 可归队，广播一次在线状态翻转 */
  webSocketClose(ws: WebSocket): void {
    if (!this.roomRow()) return; // 房间已销毁（解散刚清完账）：无广播对象
    this.pushRoomTo(ws, ws); // close 事件触发时该 socket 仍在列表里，发送与统计都要排除它
  }

  // ── 房间账读写（全部直查 SQLite）──

  /** 大厅动作公共闸：phase=lobby +（房主动作）房主校验。返回 null=通过，否则=错误文案 */
  private lobbyGate(seat: number, hostDenied: string | null): string | null {
    const room = this.roomRow();
    if (!room) return "房间不存在或已解散";
    if (room.phase !== "lobby") return "已开局，大厅已收口";
    if (hostDenied != null && room.host_seat !== seat) return hostDenied;
    return null;
  }

  private roomRow(): RoomRow | null {
    const rows = this.state.storage.sql
      .exec("SELECT code, host_seat, phase, config FROM room LIMIT 1")
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

  /** 解散/销毁：清全部账、广播后全员断线 */
  private destroy(): void {
    this.broadcast({ type: "dissolved" });
    this.state.storage.sql.exec("DELETE FROM seats");
    this.state.storage.sql.exec("DELETE FROM room");
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
      phase: room?.phase === "started" ? "started" : "lobby",
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
