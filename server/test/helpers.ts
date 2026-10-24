// DO WS 协议边界测试的共用客户端（M2-T3 起多文件共用，M2-T4 抽出）。
// 好测试=外部行为级别：HTTP/WS 进、快照/状态码/关闭码断言，不测内部函数。
import { SELF } from "cloudflare:test";
import { expect } from "vitest";
import type {
  CreateRoomResp,
  Downstream,
  JoinRoomResp,
  RoomSnapshot,
  Upstream,
} from "../../shared/protocol";

const BASE = "https://test.local";

export async function postJSON(path: string, body: unknown): Promise<Response> {
  return SELF.fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export interface WsClient {
  /** 连接建立时服务端直发的首条快照（带 you），connect() 已替你消费掉 */
  hello: Downstream;
  recv(): Promise<Downstream>;
  recvClose(): Promise<number>;
  send(u: Upstream): void;
  close(): void;
}

/** WS 测试客户端：push 缓冲 + recv 取后续广播；服务端主动 close 时 recvClose 收码 */
export async function connect(code: string, token: string): Promise<WsClient> {
  const resp = await SELF.fetch(`${BASE}/ws/${code}?token=${encodeURIComponent(token)}`, {
    headers: { Upgrade: "websocket" },
  });
  if (resp.status !== 101) {
    throw new Error(`upgrade failed: ${resp.status} ${await resp.text()}`);
  }
  const ws = resp.webSocket!;
  ws.accept();
  const buf: Downstream[] = [];
  const waiters: Array<(m: Downstream) => void> = [];
  let closeCode: number | null = null;
  let closeResolve: ((c: number) => void) | null = null;
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data)) as Downstream;
    const w = waiters.shift();
    if (w) w(m);
    else buf.push(m);
  });
  const closed = new Promise<number>((resolve) => {
    closeResolve = resolve;
  });
  ws.addEventListener("close", (e) => {
    closeCode = e.code;
    closeResolve?.(e.code);
  });
  const recv = () =>
    new Promise<Downstream>((resolve, reject) => {
      const m = buf.shift();
      if (m) return resolve(m);
      waiters.push(resolve);
      setTimeout(() => {
        const i = waiters.indexOf(resolve);
        if (i >= 0) {
          waiters.splice(i, 1);
          reject(new Error("recv timeout"));
        }
      }, 10_000);
    });
  const hello = await recv();
  return {
    hello,
    recv,
    recvClose: () => (closeCode != null ? Promise.resolve(closeCode) : closed),
    send: (u) => ws.send(JSON.stringify(u)),
    close: () => ws.close(),
  };
}

export async function createRoom(name: string): Promise<CreateRoomResp> {
  const res = await postJSON("/api/rooms", { name });
  expect(res.status).toBe(200);
  return (await res.json()) as CreateRoomResp;
}

export async function joinRoom(code: string, name: string): Promise<JoinRoomResp> {
  const res = await postJSON(`/api/rooms/${code}/join`, { name });
  expect(res.status).toBe(200);
  return (await res.json()) as JoinRoomResp;
}

/** 快照断言助手：recv 到下一条 room 广播（跳过可能的无关消息不跳——DO 广播有序，直接取） */
export async function nextRoom(c: WsClient): Promise<RoomSnapshot> {
  const m = await c.recv();
  expect(m.type).toBe("room");
  if (m.type !== "room") throw new Error("expected room snapshot");
  return m.room;
}

/** error 断言助手：recv 到下一条 error 并验文案包含 */
export async function nextError(c: WsClient, ...contain: string[]): Promise<string> {
  const m = await c.recv();
  expect(m.type).toBe("error");
  if (m.type !== "error") throw new Error("expected error");
  for (const s of contain) expect(m.message).toContain(s);
  return m.message;
}
