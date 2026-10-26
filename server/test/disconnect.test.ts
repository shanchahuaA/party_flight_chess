// M2-T8（#45）断线治理集成主链（Spec #37 缝 2 继续：Room DO 的 WS 协议边界；User Stories 20–23）。
// 好测试=外部行为级别：HTTP/WS 进、快照/事实/关闭码断言；kernel 名册事实经 gameRow 直查
// （沿 room.test/game.test「账面直查」先例——「名册 boot 定死」的验收面）。
// 断线计时刻（转移/销毁）走 T5 时钟缝 advanceTime：时限=内核时钟轴（clockOffset 折算），不抢生产 Date.now。
//
// 状态机三问对照（docs/脚手架约定.md；DO 单线程事件串行是结构性前提）：
// 1. 同一实体并发操作（房主踢离线者/被顶替旧连接同拍）：kick 全程单事件内完成（拉黑→除座→断连→广播），
//    无跨事件竞态；同 token 重连升级在拉黑落账后到达=403 拒。
// 2. 挂账期间标的消失（drafting 期被踢者的暗牌未选）：DO 代选注入（chooseSecret）让窗照常开——
//    名册在 kernel 里不会消失，代选即其唯一出口（测试 S4）。
// 3. 边界 tick 重入：房级时限带条件重瞄（到点复核在线态，条件失效即清钟不动作）——一次性钟不复入。
import { describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { GameState } from "../../kernel/src/types";
import type { LobbyConfig, RoomSnapshot } from "../../shared/protocol";
import {
  advanceTime,
  connect,
  createRoom,
  gameRow,
  joinRoom,
  nextError,
  nextGame,
  nextRoom,
  postJSON,
  type WsClient,
} from "./helpers";
import type { RoomMsg } from "./helpers";

const MAIN_CFG: LobbyConfig = {
  turnCap: 5, maxHp: 5, windowMs: 10_000, restMs: 0,
  timerMode: "world", maliceEvery: 2, maliceLevel: "off",
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 三真人房（房东/朋友甲[被踢目标]/朋友乙[见证人]），sockets 全连接（hello 已消化；
 *  朋友甲/乙上线广播按保留在 host 缓冲） */
async function newRoom3(): Promise<{ code: string; host: WsClient; guestA: WsClient; guestB: WsClient; tokens: { host: string; guestA: string; guestB: string } }> {
  const created = await createRoom("房东");
  const jA = await joinRoom(created.code, "朋友甲");
  const jB = await joinRoom(created.code, "朋友乙");
  const host = await connect(created.code, created.token);
  const guestA = await connect(created.code, jA.token);
  const guestB = await connect(created.code, jB.token);
  // 上线广播只发「其他人」：host 缓冲=甲、乙两条；guestA 缓冲=乙一条；guestB 无缓冲（自己的广播 excludeSend）
  await nextRoom(host); // 甲上线
  await nextRoom(guestA); // 乙上线（甲侧）
  await nextRoom(host); // 乙上线（host 侧）
  await sleep(60);
  while (host.pop() !== undefined) {}
  while (guestA.pop() !== undefined) {}
  while (guestB.pop() !== undefined) {}
  return { code: created.code, host, guestA, guestB, tokens: { host: created.token, guestA: jA.token, guestB: jB.token } };
}

const seatByName = (snap: RoomSnapshot, name: string) => snap.seats.find((s) => s.name === name);

describe("踢人（M2-T8）：即刻断连+拉黑+座位除名", () => {
  it("大厅态踢人：kicked 通知单发+4003 关线；见证人看到座位除名；原 token 重连被拒（拉黑）", async () => {
    const r = await newRoom3();

    // 门闸：非房主拒绝
    r.guestB.send({ type: "kick", seat: 1 });
    await nextError(r.guestB, "只有房主能踢人");

    // 门闸：不能踢自己/座位不在
    r.host.send({ type: "kick", seat: 0 });
    await nextError(r.host, "自己");
    r.host.send({ type: "kick", seat: 99 });
    await nextError(r.host, "不在房间");

    // 房主踢朋友甲（seat 1）
    r.host.send({ type: "kick", seat: 1 });
    const km = await r.guestA.recv();
    expect(km.type).toBe("kicked"); // 被踢者下游通知：单发简明通知
    expect(await r.guestA.recvClose()).toBe(4003); // 即刻断连（专用关闭码）
    expect(await r.guestA.recvClose()).toBe(4003); // 即刻断连（专用关闭码）

    // 见证人快照：座位除名、房主标记不动
    const snap = await nextRoom(r.guestB);
    expect(snap.seats.find((s) => s.name === "朋友甲")).toBeUndefined();
    expect(seatByName(snap, "房东")?.host).toBe(true);
    expect(snap.hostSeat).toBe(0);

    // 原身份不可重进：同 token 升级被 403 拒（黑名单；房间未销毁仍拉黑）
    await expect(connect(r.code, r.tokens.guestA)).rejects.toThrow("403");
    r.host.close();
    r.guestB.close();
  }, 30_000);

  it("踢非真人（假人/不存在座位）被拒；黑名单只在房间销毁时清（5 分钟后 403 仍在）", async () => {
    const r = await newRoom3();
    r.host.send({ type: "addBot" });
    const kickSnap = await nextRoom(r.host); // 小黄入座广播（host 侧直消费）
    await nextRoom(r.guestA);
    await nextRoom(r.guestB);
    await sleep(50);
    while (r.host.pop() !== undefined) {}
    while (r.guestA.pop() !== undefined) {}
    while (r.guestB.pop() !== undefined) {}

    const botSeat = kickSnap.seats.find((s) => s.bot)?.seat;
    expect(botSeat).toEqual(expect.any(Number));
    r.host.send({ type: "kick", seat: botSeat! });
    await nextError(r.host, "假人");

    r.host.send({ type: "kick", seat: 1 }); // 踢朋友甲
    expect(await r.guestA.recvClose()).toBe(4003);

    // 拉黑至房间销毁：假快进 5 分钟（房里还有真人在线，房间活着）→ 拉黑仍在
    await advanceTime(r.code, 300_000, false);
    await expect(connect(r.code, r.tokens.guestA)).rejects.toThrow("403");
    r.host.close();
    r.guestB.close();
  }, 30_000);
});

describe("踢人+对局（M2-T8）：棋子转自动掷骰、kernel 名册不动", () => {
  it("drafting 期踢人：被踢者暗牌由服务端代选，窗照常开（不被卡死）", async () => {
    const r = await newRoom3();
    const { code } = r;
    r.host.send({ type: "setConfig", config: MAIN_CFG });
    await nextRoom(r.host);
    await nextRoom(r.guestA);
    await nextRoom(r.guestB);
    await sleep(40);
    while (r.guestA.pop() !== undefined) {}
    r.host.send({ type: "start" });
    expect((await nextRoom(r.host)).phase).toBe("playing");
    const hb = await nextGame(r.host); // 开局 hello（drafting）
    expect(hb.state.phase).toBe("drafting");
    await nextRoom(r.guestB);
    await nextGame(r.guestB);
    await sleep(40);
    while (r.guestB.pop() !== undefined) {}

    // 房东选牌；朋友乙这票**暂不投**——被踢的朋友甲由服务端代选注入，最后由乙的补选开窗（全员选定才开窗）
    r.host.send({ type: "intent", turn: hb.state.turn, intent: { type: "chooseSecret", pid: 0, pick: 0 } });
    await nextGame(r.host); // 房东 ack（drafting 仍在——甲未选）
    await nextGame(r.guestB); // 广播
    while (r.guestB.pop() !== undefined) {}

    // 踢：服务端代选朋友甲暗牌（secretPicked pid≠0；乙还没选，窗暂不开——不卡死也不能假开）
    r.host.send({ type: "kick", seat: 1 });
    expect(await r.guestA.recvClose()).toBe(4003);
    const inj = await nextGame(r.host);
    const injFacts = inj.facts as unknown as Array<{ type: string; pid?: number; auto?: boolean }>;
    expect(injFacts.some((f) => f.type === "secretPicked" && f.pid !== 0)).toBe(true); // 代选落账（host 视角 pid≠0）
    expect(inj.state.phase).toBe("drafting");
    await nextGame(r.guestB); // 注入广播的乙侧拷贝先消费，防 openedB 吃到旧包

    // 朋友乙补选：全员选定 → 窗开局照常（若没有代选注入，本窗到天荒地老也不开）
    r.guestB.send({ type: "intent", turn: inj.state.turn, intent: { type: "chooseSecret", pid: 0, pick: 0 } });
    const openedB = await nextGame(r.guestB);
    const openedH = await nextGame(r.host);
    const openedFacts = openedH.facts as unknown as Array<{ type: string; pid?: number; auto?: boolean }>;
    expect(openedH.state.phase).toBe("acting");
    expect(openedFacts.some((f) => f.type === "windowStart")).toBe(true);
    expect(openedB.state.windowDeadline).toBeGreaterThan(0);
    r.host.close();
    r.guestB.close();
  }, 60_000);

  it("acting 期踢人：被踢座位的名字仍在 kernel 名册（gameRow 直查）；下窗其棋子有 auto 替掷事实", async () => {
    const r = await newRoom3();
    r.host.send({ type: "setConfig", config: MAIN_CFG });
    await nextRoom(r.host);
    await nextRoom(r.guestA);
    await nextRoom(r.guestB);
    r.host.send({ type: "start" });
    expect((await nextRoom(r.host)).phase).toBe("playing");
    const hb = await nextGame(r.host);
    await nextRoom(r.guestB);
    await nextGame(r.guestB);
    await sleep(40);
    while (r.guestB.pop() !== undefined) {}
    r.host.send({ type: "intent", turn: hb.state.turn, intent: { type: "chooseSecret", pid: 0, pick: 0 } });
    await nextGame(r.host);
    await nextGame(r.guestB);
    r.guestB.send({ type: "intent", turn: hb.state.turn, intent: { type: "chooseSecret", pid: 0, pick: 0 } });
    await nextGame(r.guestB);
    await nextGame(r.host);
    await sleep(40);
    while (r.guestB.pop() !== undefined) {}

    r.host.send({ type: "kick", seat: 1 }); // 朋友甲凳上被踢
    expect(await r.guestA.recvClose()).toBe(4003);
    // 注入开窗批（secretPicked 甲 + windowStart）顺路消费：此后局稳在 acting
    await nextGame(r.host);
    await nextGame(r.guestB);
    await sleep(40);
    while (r.host.pop() !== undefined) {}
    while (r.guestB.pop() !== undefined) {}

    // kernel 名册不可移动：gameRow 直查仍是 3 人玩家（被踢者棋子留局，由系统代掷）
    const row = await gameRow(r.code);
    expect(row).toBeTruthy();
    expect((row!.state as GameState).players).toHaveLength(3);
    expect((row!.state as GameState).players.map((p) => p.name)).toContain("朋友甲");

    // 本窗无人操作快进：auto 替掷覆盖全桌——被踢者（host 视角 pid≠0、auto=true）与房东（pid 0）都该有
    await advanceTime(r.code, 10_000);
    const g = await nextGame(r.host);
    const facts = g.facts as unknown as Array<{ type: string; pid?: number; auto?: boolean }>;
    const autoRolls = facts.filter((f) => f.type === "roll" && f.auto === true);
    expect(autoRolls.some((f) => f.pid !== 0)).toBe(true); // 被踢棋子的自动掷骰事实
    expect(autoRolls.length).toBeGreaterThanOrEqual(2); // 三个真人旗（两真人一被踢）同窗全替
    r.host.close();
    r.guestB.close();
  }, 90_000);
});

describe("房主离线转移（M2-T8）：5 分钟自动转给最早加入的在座在线真人", () => {
  it("房主掉线 5 分钟→标记转移；前房主重连只是普通玩家；被转移者即得房主权", async () => {
    const r = await newRoom3();

    // 房主+朋友甲先后掉线，朋友乙留守（在线）——转移目标=在座**在线**真人（实现期定案：转给离线者无人可按开始）
    r.host.close();
    r.guestA.close();
    await sleep(80);
    while (r.guestB.pop() !== undefined) {} // 两条离场快照排干，再等转移广播

    await advanceTime(r.code, 300_000); // 5 分钟（钟缝推进+alarm 驱动）
    const snap = await nextRoom(r.guestB); // 转移广播
    expect(snap.hostSeat).toBe(2);
    expect(seatByName(snap, "朋友乙")?.host).toBe(true);
    expect(seatByName(snap, "房东")?.host).toBe(false);

    // 被转移者即得房主权：改配置被接受（不再是 409 的「只有房主」）
    r.guestB.send({ type: "setConfig", config: { ...MAIN_CFG, windowMs: 60_000 } });
    const ack = await nextRoom(r.guestB);
    expect(ack.config.windowMs).toBe(60_000);

    // 前房主重连=普通玩家：座位拿回但房主标记没回来；解散动作被拒
    const back = await connect(r.code, r.tokens.host);
    expect(back.hello.type).toBe("room");
    if (back.hello.type !== "room") return;
    expect(back.hello.you).toBe(0);
    expect(back.hello.room.hostSeat).toBe(2);
    expect(seatByName(back.hello.room, "房东")?.host).toBe(false);
    back.send({ type: "dissolve" });
    await nextError(back, "只有房主能解散房间");
    r.guestB.close();
    back.close();
  }, 60_000);

  it("房主在线时不转移（无常空挂熟期）；到点前归来则钟撤销", async () => {
    const r = await newRoom3();
    // 房主离线 29 秒（未到 5 分钟，只挪钟不驱动 alarm）→ 归来不掉皇冠
    r.host.close();
    await advanceTime(r.code, 29_000, false);
    const back = await connect(r.code, r.tokens.host);
    if (back.hello.type !== "room") return;
    expect(back.hello.room.hostSeat).toBe(0);
    expect(seatByName(back.hello.room, "房东")?.host).toBe(true);
    back.send({ type: "dissolve" });
    const m = await back.recv();
    expect(m.type).toBe("dissolved"); // 归来仍是房主：解散被受理（房间即刻清账）
    r.guestA.close();
    r.guestB.close();
  }, 60_000);
});

describe("全员离线销毁（M2-T8）：5 分钟无僵尸房间", () => {
  it("未到 5 分钟不销毁（短离线安全窗）；到点即毁：join/升级全 404、对局账一并清", async () => {
    const created = await createRoom("房东");
    const jA = await joinRoom(created.code, "朋友甲");
    const host = await connect(created.code, created.token);
    const guest = await connect(created.code, jA.token);
    await host.recv(); // 甲上线广播
    host.send({ type: "addBot" }); // 假人+开局：销毁发生在对局态（假人撑不起一层房）
    await nextRoom(host);
    host.send({ type: "start" });
    expect((await nextRoom(host)).phase).toBe("playing");

    // 双真人全下（对局照常由 alarm 推进，账在 SQLite）
    host.close();
    guest.close();

    // 假快进 29 秒未到点：房间必须还活着——凭 token 升级照常 101
    // （连接即出在线：升级清掉断线钟，故随后关线重排再@app 补足到点量）
    await advanceTime(created.code, 29_000, false);
    const alive = await connect(created.code, created.token);
    expect(alive.hello.type).toBe("room");
    alive.close();

    // 关线重排后再过 5 分钟+余量（离线 29s 归队又下线，钟从重关线时刻重起）：销毁——
    // join/升级全 404；对局/座位/房间/黑名单账全清（无僵尸房）
    await advanceTime(created.code, 301_000, true);
    const res = await postJSON(`/api/rooms/${created.code}/join`, { name: "迟到者" });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("不存在");
    await expect(connect(created.code, created.token)).rejects.toThrow("404");
    await runInDurableObject(env.ROOM.get(env.ROOM.idFromName(created.code)), (_i, state) => {
      for (const table of ["game", "seats", "room", "blocked"]) {
        expect(state.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).toArray()).toEqual([{ n: 0 }]);
      }
    });
  }, 60_000);
});

describe("重连归队（M2-T8）：座位/手牌/局面完整恢复、可继续行动", () => {
  it("对局中断线：离场期间局照常替掷推进（turn 前进），凭 token 重连拿回全量局面、预发可受理", async () => {
    const r = await newRoom3();
    r.host.send({ type: "setConfig", config: MAIN_CFG });
    await nextRoom(r.host);
    await nextRoom(r.guestA);
    await nextRoom(r.guestB);
    r.host.send({ type: "start" });
    expect((await nextRoom(r.host)).phase).toBe("playing");
    const hb = await nextGame(r.host);
    await nextRoom(r.guestB);
    await nextGame(r.guestB);
    await sleep(40);
    while (r.guestB.pop() !== undefined) {}
    r.host.send({ type: "intent", turn: hb.state.turn, intent: { type: "chooseSecret", pid: 0, pick: 0 } });
    await nextGame(r.host);
    await nextGame(r.guestB);
    r.guestB.send({ type: "intent", turn: hb.state.turn, intent: { type: "chooseSecret", pid: 0, pick: 0 } });
    await nextGame(r.guestB); // 乙的 ack（甲未选，窗仍未开）
    await nextGame(r.host); // 房主侧广播
    r.guestA.send({ type: "intent", turn: hb.state.turn, intent: { type: "chooseSecret", pid: 0, pick: 0 } });
    const openedB = await nextGame(r.guestA); // 甲的 ack=第三张暗牌落定=开窗拍（全员选定）
    await nextGame(r.guestB);
    await nextGame(r.host);
    await sleep(40);
    while (r.host.pop() !== undefined) {}
    while (r.guestB.pop() !== undefined) {}
    const turnBefore = openedB.state.turn;

    // 朋友甲断线（对局的 socket 落地——kernel 照常推进：替掷接管其棋子）
    r.guestA.close();

    // 快进 30s（三个整窗）：无人能替甲发意图——窗只能被替掷收掉，turn 前进即「离场被替掷推进」的行为证据
    await advanceTime(r.code, 30_000);
    const afterRow = await gameRow(r.code);
    expect(afterRow).toBeTruthy();
    expect((afterRow!.state as GameState).players).toHaveLength(3); // 名册定死：断线不踢人

    // 凭 token 归队：room hello（you=1、座位互见在线）+ game hello（facts=[] 全量快照）
    const back = await connect(r.code, r.tokens.guestA);
    expect(back.hello.type).toBe("room");
    if (back.hello.type !== "room") return;
    expect(back.hello.you).toBe(1);
    expect(seatByName(back.hello.room, "朋友甲")?.online).toBe(true);
    const hello = await nextGame(back);
    expect(hello.facts).toEqual([]);
    const me = hello.state.players[0]; // 重定基=自己恒 pid 0（壳层约定原样）
    expect(me.name).toBe("朋友甲");
    expect(me.secretOptions.length).toBe(2);
    expect(me.hand.length).toBeGreaterThan(0); // 手牌真值恢复
    expect(hello.state.phase).toBe("acting");
    expect(hello.state.turn).toBeGreaterThan(turnBefore); // 缺席期间局被推进（替掷收窗）
    for (const p of hello.state.players.slice(1)) {
      expect(p.hand).toEqual([]); // 他人手牌保密口径原样
      expect(p.secretOptions).toEqual([0, 0]);
    }

    // 归队即可以为「当下窗」发意图：roll 受理（说明局面/回合号对账没丢，行动通路完整）
    if (freshActing(hello.state, me)) {
      back.send({ type: "intent", turn: hello.state.turn, intent: { type: "roll", pid: 0 } });
      const ack = await nextGame(back);
      const ackFacts = ack.facts as unknown as Array<{ type: string; pid?: number; auto?: boolean }>;
      expect(ackFacts.some((f) => f.type === "roll" && f.auto === false && f.pid === 0)).toBe(true);
    }
    r.guestB.close();
  }, 90_000);
});

/** 归队后立即行动的前置（窗口没有刚被替掷收掉/没在走路/没在打牌抉择中） */
function freshActing(s: GameState, me: GameState["players"][number]): boolean {
  return s.phase === "acting" && !me.rolled && me.walk == null && me.cardPending == null && !me.dead;
}
