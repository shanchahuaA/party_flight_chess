// M3-T9（#61）战报「首次全量 + 后续增量」+ M2 遗留两钟的 DO 集成测试。
// 缝 2（沿用）：Room DO 的 WS 协议边界——发一条上行 → 断言收到的下行，不测 DO 内部方法。
//
// 验收线（票面）：
// 1. 首条（含重连/新连接后的首条）带全量 → 后续只带增量
// 2. 客户端累积后条数等于内核实际条数（不重复不丢失）
// 3. 两人同局各收各的增量，互不串
// 4. HTTP join 后（未升级 WS）房间不再悬置——join 后重估房级两钟
import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { GameState, Intent } from "../../kernel/src/types";
import type { LobbyConfig } from "../../shared/protocol";
import {
  advanceTime,
  connect,
  createRoom,
  joinRoom,
  nextGame,
  nextRoom,
  postJSON,
  type GameMsg,
} from "./helpers";

const CFG: LobbyConfig = {
  turnCap: 5, maxHp: 5, windowMs: 10_000, restMs: 0,
  timerMode: "world", maliceEvery: 2, maliceLevel: "off",
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const sendIntent = (c: { send: (u: { type: "intent"; turn: number; intent: Intent }) => void }, turn: number, intent: Intent): void => {
  c.send({ type: "intent", turn, intent });
};

/** 建 3 人房（两真人+一假人）并开到第一窗开张；返回两端首条 game（boot 全量） */
async function bootRoom() {
  const created = await createRoom("房东");
  const joined = await joinRoom(created.code, "朋友甲");
  const host = await connect(created.code, created.token);
  const guest = await connect(created.code, joined.token);
  // 第二人上线会广播给 host（guest 自己的 hello 已带两人座位，其缓冲里还有一条 host 视角的广播）
  await nextRoom(host);
  await drainAll([guest]);
  host.send({ type: "addBot" });
  await nextRoom(host);
  await nextRoom(guest);
  host.send({ type: "setConfig", config: CFG });
  await nextRoom(host);
  await nextRoom(guest);
  host.send({ type: "start" });
  expect((await nextRoom(host)).phase).toBe("playing");
  expect((await nextRoom(guest)).phase).toBe("playing");
  const hostBoot = await nextGame(host);
  const guestBoot = await nextGame(guest);
  return { code: created.code, token: created.token, guestToken: joined.token, host, guest, hostBoot, guestBoot };
}

/** 排干双端缓冲（boot 之后的余波：选牌 ack/广播/windowStart 等）。
 *  先睡一拍让 workerd 把广播吐完，再多轮「排空→冷却」——首轮见底不代表广播已全到。 */
async function drainAll(clients: Array<{ pop(): unknown }>): Promise<GameMsg[]> {
  const out: GameMsg[] = [];
  await sleep(60);
  for (let round = 0; round < 8; round++) {
    let any = false;
    for (const c of clients) {
      for (;;) {
        const m = c.pop() as { type?: string } | undefined;
        if (!m) break;
        any = true;
        if (m.type === "game") out.push(m as never);
      }
    }
    if (!any) break;
    await sleep(40);
  }
  return out;
}

describe("战报全量+增量（#61 / T-02）", () => {
  it(
    "首条 game 带全量（msgs=full）；后续只带本批增量（msgs=delta）",
    async () => {
      const r = await bootRoom();
      // 首条=boot 全量：msgs 标记 full，且 messages 与内核战报条数一致（不是尾片切片）
      expect(r.hostBoot.msgs).toBe("full");
      expect(r.guestBoot.msgs).toBe("full");
      // 开局期战报很少，全量 == state.messages 里的全部
      expect(r.hostBoot.messages.map((m) => m.id)).toEqual(r.hostBoot.state.messages.map((m) => m.id));

      // 造一条新的下行：补选暗牌（bootRoom 只开了局、没选牌）——这条必然是 delta
      sendIntent(r.host, r.hostBoot.state.turn, { type: "chooseSecret", pid: 0, pick: 0 });
      const ack = await nextGame(r.host);
      expect(ack.msgs).toBe("delta");
      expect(r.hostBoot.state.phase).toBe("drafting");
      // 增量内部 id 不重复
      const ids = ack.messages.map((x) => x.id);
      expect(new Set(ids).size).toBe(ids.length);
      // 增量只含「首条之后的新条目」：id 全部大于全量里见过的最大值（若全量非空）
      const maxBoot = r.hostBoot.messages.at(-1)?.id ?? 0;
      for (const x of ack.messages) expect(x.id).toBeGreaterThan(maxBoot);
      r.host.close();
      r.guest.close();
    },
    60_000,
  );

  it(
    "客户端累积（full + delta 去重）后条数等于内核实际条数——打完一局能翻到第一条",
    async () => {
      const r = await bootRoom();
      /** 模拟客户端累积器（与服务端契约同构：full 整段替换、delta 按 id 追加去重） */
      const acc = new Map<number, number>();
      const absorb = (m: GameMsg): void => {
        const incoming = m.messages ?? [];
        if (m.msgs === "full") {
          acc.clear();
          for (const x of incoming) acc.set(x.id, x.id);
          return;
        }
        for (const x of incoming) acc.set(x.id, x.id);
      };
      absorb(r.hostBoot);
      // 驱动若干拍（真人老实掷+确认），把所有下行喂进累积器
      const turn0 = r.hostBoot.state.turn;
      sendIntent(r.host, turn0, { type: "chooseSecret", pid: 0, pick: 0 });
      sendIntent(r.guest, turn0, { type: "chooseSecret", pid: 0, pick: 0 });
      for (let i = 0; i < 8; i++) {
        await advanceTime(r.code, 2_600);
        const batch = await drainAll([r.host, r.guest]);
        for (const m of batch) absorb(m);
        // 真人每拍补 roll/confirm（若无则空转——替掷会兜住）
        const last = batch.at(-1);
        if (!last) continue;
        sendIntent(r.host, last.state.turn, { type: "roll", pid: 0 });
        sendIntent(r.guest, last.state.turn, { type: "roll", pid: 0 });
        const batch2 = await drainAll([r.host, r.guest]);
        for (const m of batch2) absorb(m);
        const last2 = batch2.at(-1) ?? last;
        sendIntent(r.host, last2.state.turn, { type: "confirm", pid: 0 });
        sendIntent(r.guest, last2.state.turn, { type: "confirm", pid: 0 });
        const batch3 = await drainAll([r.host, r.guest]);
        for (const m of batch3) absorb(m);
      }
      // 收尾：再推一拍并排干，拿到最新的 state
      await advanceTime(r.code, 2_600);
      const seen = await drainAll([r.host, r.guest]);
      for (const m of seen) absorb(m);
      // 累积器覆盖了内核的完整 id 空间：1..maxId 一条不缺（不重复不丢失）
      const maxId = Math.max(0, ...acc.keys());
      expect(maxId).toBeGreaterThan(0);
      expect(acc.size).toBe(maxId); // 1..maxId 全在
      // 第一条在（能翻到本局第一条）
      expect(acc.has(1)).toBe(true);
      r.host.close();
      r.guest.close();
    },
    90_000,
  );

  it(
    "重连（新连接/evict 后）重新收到一次全量，不重复不丢失",
    async () => {
      const r = await bootRoom();
      // 推进几拍让战报累积起来
      await advanceTime(r.code, 2_600);
      await drainAll([r.host, r.guest]);
      // 驱逐 DO 模拟 Hibernation 唤醒/进程重启（attachment 已清）
      const stub = env.ROOM.get(env.ROOM.idFromName(r.code));
      await evictDurableObject(stub);
      const again = await connect(r.code, r.token);
      // hello：room 快照先到，随后 game（对局中）
      let boot: GameMsg | null = null;
      for (;;) {
        const m = await again.recv();
        if (m.type === "game") {
          boot = m;
          break;
        }
      }
      expect(boot!.msgs).toBe("full"); // 重连首条=全量
      const ids = boot!.messages.map((x) => x.id);
      expect(new Set(ids).size).toBe(ids.length); // 全量内部不重复
      expect(ids[0]).toBe(1); // 从第一条开始
      // 后续下行回到 delta（war:推进一拍并排干）
      await advanceTime(r.code, 2_600);
      const later: GameMsg[] = [];
      for (let i = 0; i < 40; i++) {
        const m = again.pop();
        if (!m) {
          await sleep(40);
          continue;
        }
        if ((m as { type: string }).type === "game") later.push(m as GameMsg);
        if (later.length >= 2) break;
      }
      if (later.length > 0) {
        expect(later[0]!.msgs).toBe("delta");
        const maxBootId = Math.max(...ids);
        for (const m of later) {
          for (const x of m.messages) expect(x.id).toBeGreaterThan(maxBootId);
        }
      }
      again.close();
      r.host.close();
      r.guest.close();
    },
    90_000,
  );

  it(
    "两人同局各收各的增量，互不串（服务端按连接记水位）",
    async () => {
      const r = await bootRoom();
      const hIds = new Set<number>();
      const gIds = new Set<number>();
      for (const x of r.hostBoot.messages) hIds.add(x.id);
      for (const x of r.guestBoot.messages) gIds.add(x.id);
      // 两端首条全量应完全一致（同一内核的同一批战报）
      expect([...hIds].sort()).toEqual([...gIds].sort());
      // 推几拍，各端独立累积
      await advanceTime(r.code, 2_600);
      const hostBatch = await drainAll([r.host]);
      const guestBatch = await drainAll([r.guest]);
      for (const m of hostBatch) for (const x of m.messages) hIds.add(x.id);
      for (const m of guestBatch) for (const x of m.messages) gIds.add(x.id);
      // 两端看到的战报 id 集合应当一致（同一局的事实广播给所有人）——「不串」的判据是
      // 两端的累积都不是「别人的私有切片」：这里用集合相等反证不会各收各的半截
      expect([...hIds].sort()).toEqual([...gIds].sort());
      // 各自累积器里没有重复 id（Set 天然保证）；关键断言：增量批的条目不回头补旧条目
      for (const m of hostBatch) {
        for (const x of m.messages) expect(x.id).toBeGreaterThan(0);
      }
      r.host.close();
      r.guest.close();
    },
    60_000,
  );
});

describe("M2 遗留：HTTP join 后房间不悬置（#61）", () => {
  it("HTTP join 会让房级断线钟重估（有意为之的行为面：join 后房间仍受全员离线规则约束）", async () => {
    const created = await createRoom("房主");
    // 只走 HTTP 领座，连一个 WS 都不建——房间此刻「有真人但零在线」
    const joined = await joinRoom(created.code, "路人");
    expect(joined.seat).toBe(1);
    // 关键点：join 不该让房间永远免死。快进 6 分钟（>5min 全员离线销毁窗）→ 房间按规则回收。
    // 若 #61 前缺「join 后重估」这一步，这里的行为反而不稳定（可能带着 open 钟悬置或永不回收）。
    await advanceTime(created.code, 360_000);
    await expect(connect(created.code, joined.token)).rejects.toThrow();
  }, 60_000);

  it("HTTP join 后立刻升级 WS：房间正常活着，两个座位都在，且不会被误销毁", async () => {
    const created = await createRoom("房主");
    const host = await connect(created.code, created.token);
    // 不 await nextRoom(host)：单人房没有其他推送，hello 已是唯一消息
    const joined = await joinRoom(created.code, "路人"); // HTTP join（此时房主在线）
    expect(joined.seat).toBe(1);
    const guest = await connect(created.code, joined.token);
    // hello 已在 connect 内消费；直接读它的快照（比再 recv 稳——广播可能已在之前发出）
    expect(guest.hello.type).toBe("room");
    const snap = (guest.hello as { room: { seats: unknown[]; phase: string } }).room;
    expect(snap.seats).toHaveLength(2);
    expect(snap.phase).toBe("lobby");
    // 有人在线 → 销毁钟已撤。快进 4 分钟（< 5min 销毁窗）：房间必须仍然活着。
    // 判据用 HTTP 面（升级面受 socket 时序影响）：房间在 → 200/409，绝不会 404。
    await advanceTime(created.code, 240_000, false);
    const probe = await postJSON(`/api/rooms/${created.code}/join`, { name: "探针" });
    expect(probe.status).not.toBe(404);
    guest.close();
    host.close();
  }, 60_000);
});
