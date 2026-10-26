// DO WS 协议边界测试的共用客户端（M2-T3 起多文件共用，M2-T4 抽出，M2-T5 扩对局面缝）。
// 好测试=外部行为级别：HTTP/WS 进、快照/状态码/关闭码/事实断言，不测内部函数。
// 消息秩序（M2-T5 起）：room 快照与 game 胖消息并行流动——nextRoom/nextError 内部跳过 game
// 型消息（大厅面断言不被对局流量背肩）；nextGame 反向只取 game（房间在线广播等被跳过）。
// 测试时钟缝：advanceTime 直改 DO 私有 clockOffset（纯内存、无存储面），随后驱动一次 alarm
// ——kernel 时钟轴=Date.now()+offset，快进后到点的时限由 alarm tick 吃掉。
import { runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
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

/** 下行单型取窄（协议真源派生，不手写形状） */
export type RoomMsg = Extract<Downstream, { type: "room" }>;
export type GameMsg = Extract<Downstream, { type: "game" }>;
export type ErrorMsg = Extract<Downstream, { type: "error" }>;

export interface WsClient {
  /** 连接建立时服务端直发的首条快照（带 you），connect() 已替你消费掉 */
  hello: Downstream;
  recv(): Promise<Downstream>;
  /** 非阻塞取一条缓冲消息（无=undefined）——驱动循环轮询用：绝不丢消息（recv 的 waiter 会把
   *  未消费的值抽走，pop 只从缓冲取，供「间隔轮询+快进」的驱动循环无损接力） */
  pop(): Downstream | undefined;
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
    pop: () => buf.shift(),
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

/** game 型消息跃过（大厅面断言的噪声面；M2-T5 起对局流量与房间快照并行流动） */
function isGame(m: Downstream): boolean {
  return m.type === "game";
}

/** 快照断言助手：recv 到下一条 room 广播（跳过 game 型对局流量；error 不跳——它自身即断言对象） */
export async function nextRoom(c: WsClient): Promise<RoomSnapshot> {
  for (;;) {
    const m = await c.recv();
    if (m.type !== "room") {
      if (isGame(m)) continue;
      throw new Error(`expect room snapshot, got ${JSON.stringify(m)}`);
    }
    return m.room;
  }
}

/** 对局胖消息断言助手：recv 到下一条 game（跳过 room/error 等房间面流量） */
export async function nextGame(c: WsClient): Promise<GameMsg> {
  for (;;) {
    const m = await c.recv();
    if (m.type !== "game") {
      if (m.type === "room" || m.type === "replaced") continue;
      throw new Error(`expect game message, got ${JSON.stringify(m)}`);
    }
    return m;
  }
}

/** error 断言助手：recv 到下一条 error 并验文案包含（跳过 game 型对局流量） */
export async function nextError(c: WsClient, ...contain: string[]): Promise<string> {
  for (;;) {
    const m = await c.recv();
    if (m.type !== "error") {
      if (isGame(m)) continue;
      throw new Error(`expect error, got ${JSON.stringify(m)}`);
    }
    for (const s of contain) expect(m.message).toContain(s);
    return m.message;
  }
}

/**
 * 测试时钟快进：DO 内 game 事件全靠 kernel 时钟轴推进（Date.now()+clockOffset）。
 * offset 累加后立刻驱动一次 alarm（handle tick 吃掉所有已到点时限）。
 * fire=false 只挪钟不驱动（留给测试自己 runDurableObjectAlarm 精挑时机）。
 */
export async function advanceTime(code: string, ms: number, fire = true): Promise<void> {
  const stub = env.ROOM.get(env.ROOM.idFromName(code));
  await runInDurableObject(stub, (instance) => {
    (instance as unknown as { clockOffset: number }).clockOffset += ms;
  });
  if (fire) {
    await runDurableObjectAlarm(stub); // 无钟可派时返回 false，无害
  }
}

/** 直读 DO 的 game 行（sqlite 直查——hibernation 账形态断言用，行为级例外沿 lobby.test 先例） */
export async function gameRow(
  code: string,
): Promise<{ state: unknown; seat_map: unknown; saved_at: number } | null> {
  return runInDurableObject(env.ROOM.get(env.ROOM.idFromName(code)), (_i, state) => {
    const rows = state.storage.sql
      .exec("SELECT state, seat_map, saved_at FROM game WHERE id = 1")
      .toArray() as unknown as Array<{ state: string; seat_map: string; saved_at: number }>;
    const row = rows[0];
    if (!row) return null;
    return { state: JSON.parse(row.state), seat_map: JSON.parse(row.seat_map), saved_at: row.saved_at };
  });
}
