import type { Downstream, Upstream } from "../../shared/protocol";

// 每个房间一个 DO（ADR-0001）。hello-world 阶段只做 echo 广播，
// 但连接模型（Hibernation + 自动心跳 + attachment 存昵称）就是正式架构的连接模型。
export class Room {
  constructor(private readonly state: DurableObjectState) {
    // 心跳原样应答、不唤醒进程、不计费（ADR-0001 §2）
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const name = (url.searchParams.get("name") ?? "").trim().slice(0, 20) || "玩家";

    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ name });
    this.send(pair[1], {
      type: "hello",
      room: this.state.id.name,
      clients: this.count(),
      now: Date.now(),
    });
    this.broadcast({
      type: "presence",
      kind: "join",
      from: name,
      clients: this.count(),
      now: Date.now(),
    });
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
    if (msg?.type !== "chat" || typeof msg.text !== "string") return;
    const text = msg.text.slice(0, 200);
    const turn = typeof msg.turn === "number" ? msg.turn : null;
    for (const w of this.state.getWebSockets()) {
      const att = w.deserializeAttachment() as { name?: string } | null;
      this.send(w, {
        type: "chat",
        from: att?.name ?? "玩家",
        self: w === ws,
        turn,
        text,
        now: Date.now(),
      });
    }
  }

  webSocketClose(ws: WebSocket): void {
    const att = ws.deserializeAttachment() as { name?: string } | null;
    this.broadcast({
      type: "presence",
      kind: "leave",
      from: att?.name ?? "玩家",
      // close 回调触发时，关闭中的 socket 仍在 getWebSockets() 里，人数要扣掉它
      clients: this.count() - 1,
      now: Date.now(),
    });
  }

  private count(): number {
    return this.state.getWebSockets().length;
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
