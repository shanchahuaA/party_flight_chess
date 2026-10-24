import {
  MAX_SEATS,
  NICK_MAX,
  type CreateRoomResp,
  type Downstream,
  type JoinRoomResp,
  type RoomSeatView,
  type RoomSnapshot,
  type Upstream,
} from "../../shared/protocol";

// 房间生命周期核（M2-T3，#40）。每个房间一个 DO（ADR-0001），房间账（座位/昵称/token/房主标记）
// 全落内置 SQLite——Hibernation 唤醒后内存可能已清空，因此**所有事件处理都直接查 SQLite、
// 不设内存缓存**（懒加载模式的替代：读多但账极小，无缓存即无失效 bug），唤醒恢复天然成立。
// 连接模型沿用 #8 骨架：Hibernation + setWebSocketAutoResponse 免计费心跳 + attachment 绑 token。

/** WS attachment：连接与座位的绑定面（序列化落 Hibernation，唤醒后 deserializeAttachment 可得） */
interface WsAttach {
  token: string;
}

interface SeatRow {
  seat: number;
  token: string;
  name: string;
  joined_at: number;
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

  /** 幂等建表（CREATE TABLE IF NOT EXISTS，同步 DDL，随首个事件执行一次） */
  private ensureSchema(): void {
    this.state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS room (
         code TEXT PRIMARY KEY,
         host_seat INTEGER NOT NULL,
         created_at INTEGER NOT NULL
       )`,
    );
    this.state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS seats (
         seat INTEGER PRIMARY KEY,
         token TEXT NOT NULL UNIQUE,
         name TEXT NOT NULL,
         joined_at INTEGER NOT NULL,
         seq INTEGER NOT NULL
       )`,
    );
  }

  // ── HTTP 面（Worker 入口转发）：创建与加入都在这里签发 token，WS 只凭 token 认座 ──

  /** 创建房间：房间账不存在才建（存在=码撞，Worker 侧重试换码）；创建者即房主即座位 0 */
  private async handleInit(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
    const name = normName(body?.name);
    if (name == null) return apiError(400, "昵称不能为空");
    const exists = this.roomRow();
    if (exists) return apiError(409, "occupied");
    const code = this.state.id.name ?? "";
    const token = newToken();
    this.state.storage.sql.exec(
      "INSERT INTO room (code, host_seat, created_at) VALUES (?, ?, ?)",
      code, 0, Date.now(),
    );
    this.state.storage.sql.exec(
      "INSERT INTO seats (seat, token, name, joined_at, seq) VALUES (?, ?, ?, ?, 1)",
      0, token, name, Date.now(),
    );
    return Response.json({ code, token, seat: 0 } satisfies CreateRoomResp);
  }

  /** 加入：满 8 人拒进；座位取最小空位（离房空出的座位可复用） */
  private async handleJoin(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
    const name = normName(body?.name);
    if (name == null) return apiError(400, "昵称不能为空");
    if (!this.roomRow()) return apiError(404, "房间不存在或已解散");
    const taken = this.seatRows();
    if (taken.length >= MAX_SEATS) return apiError(409, "房间已满（8 人）");
    const used = new Set(taken.map((s) => s.seat));
    let seat = 0;
    while (used.has(seat)) seat++;
    // 座位序 seq：房内单调递增（Date.now() 同毫秒会打平，join 次序必须是硬序）
    const token = newToken();
    const nextSeq = this.state.storage.sql
      .exec("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM seats")
      .toArray() as unknown as Array<{ next: number }>;
    this.state.storage.sql.exec(
      "INSERT INTO seats (seat, token, name, joined_at, seq) VALUES (?, ?, ?, ?, ?)",
      seat, token, name, Date.now(), nextSeq[0]?.next ?? 1,
    );
    return Response.json({ token, seat } satisfies JoinRoomResp);
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
      // 房主主动离房：标记转给最早加入的在座玩家（ADR-0001 §6；离线超时的转移在 T8）
      if (wasHost) this.reassignHost();
      if (this.seatRows().length === 0) {
        // 最后一人离房：房间即世界，当场销毁（全员离线 5 分钟自动销毁的 Alarm 在 T8）
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
    this.send(ws, { type: "error", message: "未知消息" });
  }

  /** 被动掉线（关页/断网）：座位保留、凭 token 可归队，广播一次在线状态翻转 */
  webSocketClose(ws: WebSocket): void {
    if (!this.roomRow()) return; // 房间已销毁（解散刚清完账）：无广播对象
    this.pushRoomTo(ws, ws); // close 事件触发时该 socket 仍在列表里，发送与统计都要排除它
  }

  // ── 房间账读写（全部直查 SQLite）──

  private roomRow(): { code: string; host_seat: number } | null {
    const rows = this.state.storage.sql
      .exec("SELECT code, host_seat FROM room LIMIT 1")
      .toArray() as unknown as Array<{ code: string; host_seat: number }>;
    return rows[0] ?? null;
  }

  private seatRows(): SeatRow[] {
    return this.state.storage.sql
      .exec("SELECT seat, token, name, joined_at FROM seats ORDER BY seat")
      .toArray() as unknown as SeatRow[];
  }

  private seatByToken(token: string): number | null {
    if (!token) return null;
    const rows = this.state.storage.sql
      .exec("SELECT seat FROM seats WHERE token = ?", token)
      .toArray() as unknown as Array<{ seat: number }>;
    return rows[0]?.seat ?? null;
  }

  private removeSeat(seat: number): void {
    this.state.storage.sql.exec("DELETE FROM seats WHERE seat = ?", seat);
  }

  /** 房主标记转给最早加入的在座玩家（ADR-0001 §6）——按入座序 seq 排序而非座位号：
   *  座位可复用，1 号位的新面孔可能比 2 号位的老玩家晚进房 */
  private reassignHost(): void {
    const rows = this.state.storage.sql
      .exec("SELECT seat FROM seats ORDER BY seq, seat LIMIT 1")
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
    }));
    return { code: this.state.id.name ?? "", hostSeat: room?.host_seat ?? 0, phase: "lobby", seats };
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
