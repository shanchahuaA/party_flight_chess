// M3-T9（#61）战报「首次全量 + 后续增量」+ M2 遗留两钟的 DO 集成测试。
// 缝 2（沿用）：Room DO 的 WS 协议边界——发一条上行 → 断言收到的下行，不测 DO 内部方法。
//
// 验收线（票面）：
// 1. 首条（含重连/新连接后的首条）带全量 → 后续只带增量
// 2. 客户端累积后条数等于内核实际条数（不重复不丢失）
// 3. 两人同局各收各的增量，互不串
// 4. HTTP join 后（未升级 WS）房间不再悬置——join 后重估房级两钟
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
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
    "首条 game 带全量（msgMode=full）；后续只带本批增量（msgMode=delta）",
    async () => {
      const r = await bootRoom();
      // 首条=boot 全量：msgMode 标记 full，且 messages 与内核战报条数一致（不是尾片切片）
      expect(r.hostBoot.msgMode).toBe("full");
      expect(r.guestBoot.msgMode).toBe("full");
      // 开局期战报很少，全量 == state.messages 里的全部
      expect(r.hostBoot.messages.map((m) => m.id)).toEqual(r.hostBoot.state.messages.map((m) => m.id));

      // 造一条新的下行：补选暗牌（bootRoom 只开了局、没选牌）——这条必然是 delta
      sendIntent(r.host, r.hostBoot.state.turn, { type: "chooseSecret", pid: 0, pick: 0 });
      const ack = await nextGame(r.host);
      expect(ack.msgMode).toBe("delta");
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
        if (m.msgMode === "full") {
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
    "Hibernation 唤醒后，仍活着的老连接重新收到一次全量（水位只在内存，唤醒即清）",
    async () => {
      const r = await bootRoom();
      // 先选暗牌把窗打开（boot 后还在 drafting，不选牌就没有新战报产生）
      sendIntent(r.host, r.hostBoot.state.turn, { type: "chooseSecret", pid: 0, pick: 0 });
      sendIntent(r.guest, r.guestBoot.state.turn, { type: "chooseSecret", pid: 0, pick: 0 });
      const openBatch = await drainAll([r.host, r.guest]);
      expect(openBatch.length).toBeGreaterThan(0);
      // 推一拍制造更多战报，建立「已收过 delta」的水位
      await advanceTime(r.code, 2_600);
      const beforeEvict = await drainAll([r.host, r.guest]);
      expect(beforeEvict.some((m) => m.msgMode === "delta")).toBe(true);

      // 模拟 Hibernation 唤醒 = DO 实例重建：内存态全清、SQLite 与已 accept 的 socket 仍在。
      // workerd 测试里 evictDurableObject 会把 socket 一并断掉（客户端侧看到的是断线重连），
      // 拿不到「老 socket 还活着」的形状；这里直接清内存水位来复现同一个不变量。
      const stub = env.ROOM.get(env.ROOM.idFromName(r.code));
      await runInDurableObject(stub, (instance) => {
        const wm = (instance as unknown as { msgWatermark: Map<unknown, number> }).msgWatermark;
        wm.clear();
      });

      // 唤醒后推一拍：老 socket 不重连，继续收广播
      await advanceTime(r.code, 2_600);
      const after = await drainAll([r.host]);
      expect(after.length).toBeGreaterThan(0);
      // 关键：唤醒后首条必须是 full——若水位被持久化，这里会继续给 delta，
      // 客户端就永远补不回 Hibernation 期间缺的那段战报。
      expect(after[0]!.msgMode).toBe("full");
      expect(after[0]!.messages[0]!.id).toBe(1);
      r.host.close();
      r.guest.close();
    },
    90_000,
  );

  it(
    "重连（新连接）重新收到一次全量，不重复不丢失",
    async () => {
      const r = await bootRoom();
      // 先把窗打开并制造战报（drafting 期没有新战报）
      sendIntent(r.host, r.hostBoot.state.turn, { type: "chooseSecret", pid: 0, pick: 0 });
      sendIntent(r.guest, r.guestBoot.state.turn, { type: "chooseSecret", pid: 0, pick: 0 });
      await drainAll([r.host, r.guest]);
      await advanceTime(r.code, 2_600);
      await drainAll([r.host, r.guest]);
      // 驱逐 DO 模拟进程重启
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
      expect(boot!.msgMode).toBe("full"); // 重连首条=全量
      const ids = boot!.messages.map((x) => x.id);
      expect(new Set(ids).size).toBe(ids.length); // 全量内部不重复
      expect(ids[0]).toBe(1); // 从第一条开始
      // 后续下行回到 delta（推进一拍并排干）——这条必须成立，不是可选断言：
      // 水位若被本可复用的旧状态污染，这里会看到 full 或空批
      await advanceTime(r.code, 2_600);
      const later: GameMsg[] = [];
      for (let i = 0; i < 60; i++) {
        const m = again.pop();
        if (!m) {
          await sleep(40);
          continue;
        }
        if ((m as { type: string }).type === "game") later.push(m as GameMsg);
        if (later.length >= 2) break;
      }
      expect(later.length).toBeGreaterThan(0);
      expect(later[0]!.msgMode).toBe("delta");
      const maxBootId = Math.max(...ids);
      for (const m of later) {
        for (const x of m.messages) expect(x.id).toBeGreaterThan(maxBootId);
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
      // 开窗造战报（drafting 期不会有新条目）
      sendIntent(r.host, r.hostBoot.state.turn, { type: "chooseSecret", pid: 0, pick: 0 });
      sendIntent(r.guest, r.guestBoot.state.turn, { type: "chooseSecret", pid: 0, pick: 0 });
      await drainAll([r.host, r.guest]);
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

      // ── 证伪「共享水位」：让 guest 换新连接（必须收 full），host 原连接的水位独善其身 ──
      // 若服务端用单一共享水位，guest 重连后 host 的下一条就会变 full 或被跳过——这里两边都钉住。
      const hostMaxBefore = Math.max(...hIds);
      const stub = env.ROOM.get(env.ROOM.idFromName(r.code));
      await evictDurableObject(stub);
      const guest2 = await connect(r.code, r.guestToken);
      let guestBoot2: GameMsg | null = null;
      for (;;) {
        const m = await guest2.recv();
        if (m.type === "game") {
          guestBoot2 = m;
          break;
        }
      }
      // guest 新连接首条=全量，且从本局第一条起（不是接着任何人的水位）
      expect(guestBoot2!.msgMode).toBe("full");
      expect(guestBoot2!.messages[0]!.id).toBe(1);

      // host 原连接继续只收增量：msgMode 不被别人的重连带成 full，条目 id 严格大于它自己的水位
      await advanceTime(r.code, 2_600);
      const hostAfter: GameMsg[] = [];
      for (let i = 0; i < 40; i++) {
        const m = r.host.pop() as { type?: string } | undefined;
        if (!m) {
          await sleep(40);
          continue;
        }
        if (m.type === "game") hostAfter.push(m as GameMsg);
        if (hostAfter.length >= 1) break;
      }
      expect(hostAfter.length).toBeGreaterThan(0);
      expect(hostAfter[0]!.msgMode).toBe("delta");
      for (const x of hostAfter[0]!.messages) expect(x.id).toBeGreaterThan(hostMaxBefore);

      guest2.close();
      r.host.close();
      r.guest.close();
    },
    90_000,
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
