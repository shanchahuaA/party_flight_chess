// M2-T7（#44）对时与快照恢复的协议边界（Spec #37 缝 2：Room DO 的 WS 协议边界，房间/对局在 room/lobby/game.test）。
// 好测试=外部行为级别：WS 进、下行消息序列与字段断言，不测 DO 内部——sync/refresh 是纯通道 API，
// 全部单发回该连接（绝不广播），故用「另一连接缓冲结构化扫描」钉住单发性。
//
// 状态机三问对照：不动——sync 直答与 refresh 对齐都走既有的单 socket 串行面，
// 不触碰房间账与内核账（refresh 只读快照，零状态写入；单发面由 workerd 串行天然不并发）。
import { describe, expect, it } from "vitest";
import type { GameState } from "../../kernel/src/types";
import {
  connect,
  createRoom,
  joinRoom,
  nextGame,
  nextRoom,
  type RoomMsg,
  type WsClient,
} from "./helpers";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 单发性扫描：另一连接的缓冲里逐条过一遍，断言「你禁止的下行形状」一件也没到
 *  （syncNow/单发 room 泄到别的连接=广播=违约）。胜利面是缓冲里只有广播楼的房消息。 */
async function assertLeakFree(c: WsClient, want: (m: RoomMsg | { type: string }) => boolean): Promise<void> {
  await sleep(80); // 让可能迟到的广播先落地再扫
  for (let m = c.pop(); m != null; m = c.pop()) {
    expect(want(m as RoomMsg)).toBe(false);
  }
}

/** 泄漏判据：该连接不该收到的下行——syncNow 应答类 +「带 you 的 room」单发对齐类 */
const isSingleAddressedLeak = (m: { type: string; you?: unknown }): boolean =>
  m.type === "syncNow" || (m.type === "room" && m.you != null);

/** 裁剪硬约束（与 game.test 同口径内联一份，不给他文件增加导出面）：
 *  本人=players[0] 真值手牌；他人 hand=[]、暗牌 [0,0]；RNG 五流+内部发号全 0。 */
function expectTrimmed(s: GameState, selfName: string): void {
  expect(s.players[0]?.name).toBe(selfName); // 重定基=收者恒 players[0]
  expect(s.players[0]!.hand.length).toBeGreaterThan(0); // 自己手牌真值
  for (const p of s.players.slice(1)) {
    expect(p.hand).toEqual([]);
    expect(p.secretOptions).toEqual([0, 0]);
  }
  expect(s.rngStates).toEqual({ setup: 0, deck: 0, items: 0, dice: 0, world: 0 });
  expect(s.seq).toBe(0);
  expect(s.dogSeq).toBe(0);
  expect(s.customsSeq).toBe(0);
}

describe("对时与快照恢复（M2-T7）", () => {
  it("sync 探针→单发 syncNow（now 与本地 Date.now 时差 <2s），绝不广播", async () => {
    const created = await createRoom("房主");
    const joined = await joinRoom(created.code, "朋友甲");
    const host = await connect(created.code, created.token);
    const guest = await connect(created.code, joined.token);
    await nextRoom(host); // 朋友甲上线广播（guest 侧对 host 的广播，guest 自身无残留）

    host.send({ type: "sync" });
    const m = await host.recv();
    expect(m.type).toBe("syncNow");
    if (m.type !== "syncNow") return;
    expect(Math.abs(m.now - Date.now())).toBeLessThan(2000); // 服务端 epoch 与本地墙钟实际同轴（ADR §5）

    // 单发性：应答只回该连接——另一连接缓冲里绝不出现 syncNow
    await assertLeakFree(guest, isSingleAddressedLeak);
    host.close();
    guest.close();
  }, 30_000);

  it("refresh（lobby 态）→单发 room hello（you 回发，等价重连的幂等拉快照），无 game", async () => {
    const created = await createRoom("房主");
    const joined = await joinRoom(created.code, "朋友甲");
    const host = await connect(created.code, created.token);
    const guest = await connect(created.code, joined.token);
    await nextRoom(host); // 朋友甲上线广播
    await sleep(60);
    while (host.pop() !== undefined) {} // 排干广播残留，refresh 断言不再被对肩

    host.send({ type: "refresh" });
    const m = await host.recv();
    expect(m.type).toBe("room");
    if (m.type !== "room") return;
    expect(m.you).toBe(0);
    expect(m.room.phase).toBe("lobby");
    expect(m.room.code).toBe(created.code);

    // 单发性：对齐包绝不广播给另一连接（广播 room 的 you 恒 null）
    await assertLeakFree(guest, isSingleAddressedLeak);
    host.close();
    guest.close();
  }, 30_000);

  it("refresh（playing 态）→room+game(facts=[]) 依序单发，裁剪口径与开局 hello 相同", async () => {
    const created = await createRoom("房主");
    const joined = await joinRoom(created.code, "朋友甲");
    const host = await connect(created.code, created.token);
    const guest = await connect(created.code, joined.token);
    await nextRoom(host); // 朋友甲上线广播

    // 完整 boot（两真人即满足 ≥2 开局门；缺省配置=drafting 无时限，alarm 无钟可催，局静置）
    host.send({ type: "start" });
    expect((await nextRoom(host)).phase).toBe("playing");
    const hello = await nextGame(host); // 开局 game hello（本批开局事实+全量快照）
    expect((await nextRoom(guest)).phase).toBe("playing");
    await nextGame(guest);
    await sleep(60);
    while (host.pop() !== undefined) {}
    while (guest.pop() !== undefined) {}

    host.send({ type: "refresh" });
    const r = await host.recv();
    expect(r.type).toBe("room"); // 依序第一条=room（you 回发）
    if (r.type !== "room") return;
    expect(r.you).toBe(0);
    expect(r.room.phase).toBe("playing");
    const g = await host.recv(); // 第二条=game（facts=[] 全量快照，定序不靠跳过）
    expect(g.type).toBe("game");
    if (g.type !== "game") return;
    expect(g.facts).toEqual([]);
    // 裁剪口径与开局 hello 同一套（同 helper 对两份状态各断一遍=「相同」的行为级表达）
    expectTrimmed(hello.state, "房主");
    expectTrimmed(g.state, "房主");

    // 单发性：对齐包不广播——guest 缓冲里无 syncNow、room 必须 you=null（仅带外广播）
    await assertLeakFree(guest, isSingleAddressedLeak);
    host.close();
    guest.close();
  }, 60_000);
});
