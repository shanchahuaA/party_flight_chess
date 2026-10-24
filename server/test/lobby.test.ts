// M2-T4（#41）大厅核：角色明选/房主配置/假人/开始 的 WS 协议边界（Spec #37 缝 2，续 room.test.ts）。
// 好测试=外部行为级别：动作上行进、快照/error 出；配额与权限拒收都在消息面断言。
//
// 状态机三问对照（docs/脚手架约定.md；DO 单线程事件串行是结构性前提）：
// 1. 同一实体并发操作（房主与假人抢座位语义）：DO 事件串行 + firstFreeSeat 分配，无第二写者；豁免专项测试。
// 2. 挂账期间标的消失（房主离房时座位表只剩假人）：reassignHost 只认真人行 + 真人清零即销毁——
//    本文件「房主离房皇冠不落假人」与「真人清零只剩假人即销毁」两条覆盖（皇冠落假人=死局，review 抓出）。
// 3. 边界 tick 重入（大厅无 tick/Alarm——纯事件驱动）：豁免；「开局后 join 拒 409/大厅动作收口」覆盖 phase 边界。
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { LobbyConfig, RoomSeatView } from "../../shared/protocol";
import { connect, createRoom, joinRoom, nextError, nextRoom, postJSON } from "./helpers";

/** 内核默认配置（GAME_DEFAULTS 可调子集）：新建房间快照必须带这套缺省 */
const DEFAULT_CONFIG: LobbyConfig = {
  turnCap: 15,
  maxHp: 10,
  windowMs: 30_000,
  restMs: 10_000,
  timerMode: "world",
  maliceEvery: 3,
  maliceLevel: "mild",
};

/** 房主+朋友甲双双在线的标准开局面（hello 与上线广播都已消费完） */
async function twoOnline() {
  const created = await createRoom("房主");
  const joined = await joinRoom(created.code, "朋友甲");
  const host = await connect(created.code, created.token);
  const guest = await connect(created.code, joined.token);
  await host.recv(); // guest 上线广播
  return { code: created.code, hostToken: created.token, host, guest };
}

function seatOf(seats: RoomSeatView[], seat: number): RoomSeatView {
  const s = seats.find((x) => x.seat === seat);
  if (!s) throw new Error(`seat ${seat} not found`);
  return s;
}

describe("大厅：角色明选（M2-T4）", () => {
  it("选角实时互见；可重复选同角色、可换选", async () => {
    const { host, guest } = await twoOnline();

    guest.send({ type: "pickRole", roleId: "tough" });
    const mine = await nextRoom(guest);
    expect(seatOf(mine.seats, 1).roleId).toBe("tough");
    const seen = await nextRoom(host);
    expect(seatOf(seen.seats, 1).roleId).toBe("tough");

    // 多人同角色合法（可重复选）：房主也选 tough（广播含操作者本人=ack，各自消费）
    host.send({ type: "pickRole", roleId: "tough" });
    const seen2 = await nextRoom(guest);
    expect(seatOf(seen2.seats, 0).roleId).toBe("tough");
    expect(seatOf(seen2.seats, 1).roleId).toBe("tough");
    await nextRoom(host); // host 自身 ack

    // 换选=再发一次 pickRole
    guest.send({ type: "pickRole", roleId: "woe" });
    const seen3 = await nextRoom(host);
    expect(seatOf(seen3.seats, 1).roleId).toBe("woe");
  });

  it("未知角色拒收（error），座位账不动（新连接快照全员未选）", async () => {
    const { code, hostToken, host } = await twoOnline();
    host.send({ type: "pickRole", roleId: "hacker" as never });
    await nextError(host, "未知角色");
    const check = await connect(code, hostToken);
    expect(check.hello.type).toBe("room");
    if (check.hello.type !== "room") return;
    expect(check.hello.room.seats.every((s) => s.roleId === null)).toBe(true);
  });
});

describe("大厅：房主配置（M2-T4）", () => {
  it("新房间快照带内核默认配置", async () => {
    const created = await createRoom("房主");
    const host = await connect(created.code, created.token);
    expect(host.hello.type).toBe("room");
    if (host.hello.type !== "room") return;
    expect(host.hello.room.config).toEqual(DEFAULT_CONFIG);
    expect(host.hello.room.phase).toBe("lobby");
  });

  it("房主改配置全员实时互见（与单机同一套域）", async () => {
    const { host, guest } = await twoOnline();
    const cfg: LobbyConfig = {
      turnCap: 30, maxHp: 5, windowMs: 90_000, restMs: 0,
      timerMode: "turn", maliceEvery: 5, maliceLevel: "fierce",
    };
    host.send({ type: "setConfig", config: cfg });
    const seen = await nextRoom(guest);
    expect(seen.config).toEqual(cfg);
    const ack = await nextRoom(host);
    expect(ack.config).toEqual(cfg);
  });

  it("非房主改配置被拒；出界值/坏枚举被拒（配置账不动）", async () => {
    const { code, hostToken, host, guest } = await twoOnline();

    guest.send({ type: "setConfig", config: { ...DEFAULT_CONFIG, turnCap: 20 } });
    await nextError(guest, "只有房主");

    host.send({ type: "setConfig", config: { ...DEFAULT_CONFIG, turnCap: 99 } });
    await nextError(host, "允许范围");

    host.send({ type: "setConfig", config: { ...DEFAULT_CONFIG, timerMode: "sometimes" as never } });
    await nextError(host, "允许范围");

    host.send({ type: "setConfig", config: { ...DEFAULT_CONFIG, maliceLevel: "cruel" as never } });
    await nextError(host, "允许范围");

    // 拒收不改账：新连接读到的仍是默认配置
    const check = await connect(code, hostToken);
    expect(check.hello.type).toBe("room");
    if (check.hello.type !== "room") return;
    expect(check.hello.room.config).toEqual(DEFAULT_CONFIG);
  });
});

describe("大厅：假人凑局（M2-T4）", () => {
  it("加假人全员互见（bot 标记+命名池）；减假人=减最近加的", async () => {
    const { host, guest } = await twoOnline();

    host.send({ type: "addBot" });
    const seen1 = await nextRoom(guest);
    expect(seen1.seats).toHaveLength(3);
    expect(seatOf(seen1.seats, 2)).toMatchObject({ name: "小黄", bot: true, roleId: null, online: false });
    await nextRoom(host); // host 同步 ack

    host.send({ type: "addBot" });
    const seen2 = await nextRoom(guest);
    expect(seatOf(seen2.seats, 3)).toMatchObject({ name: "小绿", bot: true });
    await nextRoom(host);

    // LIFO：减掉的是最近加的小绿，小黄留在座位上
    host.send({ type: "removeBot" });
    const seen3 = await nextRoom(guest);
    expect(seen3.seats).toHaveLength(3);
    expect(seen3.seats.map((s) => s.name)).toContain("小黄");
    expect(seen3.seats.map((s) => s.name)).not.toContain("小绿");
  });

  it("配额：真人+假人 ≤8、假人 ≤7；非房主加减被拒；没假人可减被拒", async () => {
    const created = await createRoom("房主");
    const joined = await joinRoom(created.code, "朋友甲");
    const host = await connect(created.code, created.token);
    const guest = await connect(created.code, joined.token);
    await host.recv(); // guest 上线广播

    // 2 真人 → 最多 6 假人：第 7 个先撞满座
    for (let i = 0; i < 6; i++) {
      host.send({ type: "addBot" });
      await nextRoom(host);
    }
    host.send({ type: "addBot" });
    await nextError(host, "已满");

    // 真人离场腾位后可加第 7 个假人，但假人上限先到。
    // leave 触发两次快照广播（leave 处理一次 + close 事件一次，胖快照下冗余无害），都要消费。
    guest.send({ type: "leave" });
    expect(await guest.recvClose()).toBe(1000);
    await nextRoom(host); // guest 离场广播
    await nextRoom(host); // close 事件广播
    host.send({ type: "addBot" });
    await nextRoom(host); // 第 7 个假人（1 真 + 7 假 = 8）
    host.send({ type: "addBot" });
    await nextError(host, "假人最多 7 个");

    for (let i = 0; i < 7; i++) {
      host.send({ type: "removeBot" });
      await nextRoom(host);
    }
    host.send({ type: "removeBot" });
    await nextError(host, "没有假人");

    // 非房主加假人被拒
    const rejoined = await joinRoom(created.code, "新朋友");
    const other = await connect(created.code, rejoined.token);
    await nextRoom(host); // 上线广播
    other.send({ type: "addBot" });
    await nextError(other, "只有房主");
  });

  it("假人 token 是合成值且永不能认证 WS（bot 行被认座查询排除）", async () => {
    const created = await createRoom("房主");
    const host = await connect(created.code, created.token);
    host.send({ type: "addBot" });
    await nextRoom(host);
    const botToken = await runInDurableObject(
      env.ROOM.get(env.ROOM.idFromName(created.code)),
      (_instance, state) =>
        state.storage.sql.exec("SELECT token FROM seats WHERE bot = 1 LIMIT 1").toArray()[0]!.token,
    );
    expect(botToken).toMatch(/^bot:/);
    await expect(connect(created.code, botToken as string)).rejects.toThrow("401");
  });
});

describe("大厅：开始（M2-T4）", () => {
  it("仅房主能开始；≥2 人才能开始；开始后 phase=started 全员互见、join 拒收、大厅动作收口", async () => {    const { code, hostToken, host, guest } = await twoOnline();

    guest.send({ type: "start" });
    await nextError(guest, "只有房主");

    // 1 人房不够开
    const solo = await createRoom("独房主");
    const soloHost = await connect(solo.code, solo.token);
    soloHost.send({ type: "start" });
    await nextError(soloHost, "至少 2 人");
    soloHost.close();

    host.send({ type: "start" });
    const seen = await nextRoom(guest);
    expect(seen.phase).toBe("started");
    const ack = await nextRoom(host);
    expect(ack.phase).toBe("started");

    // 开局后：新面孔拒进、大厅动作收口、掉线者凭 token 仍可归队
    expect((await postJSON(`/api/rooms/${code}/join`, { name: "迟到者" })).status).toBe(409);
    guest.send({ type: "pickRole", roleId: "boss" });
    await nextError(guest, "已开局");
    host.send({ type: "addBot" });
    await nextError(host, "已开局");

    const back = await connect(code, hostToken);
    expect(back.hello.type).toBe("room");
    if (back.hello.type !== "room") return;
    expect(back.hello.room.phase).toBe("started");
  });
});

describe("大厅：休眠唤醒等价（M2-T4）", () => {
  it("角色/配置/假人/phase 全落 SQLite，重连快照完整恢复", async () => {
    const created = await createRoom("房主");
    const joined = await joinRoom(created.code, "朋友甲");
    const host = await connect(created.code, created.token);
    const guest = await connect(created.code, joined.token);
    await host.recv(); // guest 上线广播

    guest.send({ type: "pickRole", roleId: "beast" });
    await nextRoom(host);
    await nextRoom(guest);
    const cfg: LobbyConfig = { ...DEFAULT_CONFIG, turnCap: 20, timerMode: "turn" };
    host.send({ type: "setConfig", config: cfg });
    await nextRoom(host);
    await nextRoom(guest);
    host.send({ type: "addBot" });
    await nextRoom(host);
    await nextRoom(guest);
    host.send({ type: "start" });
    await nextRoom(host);
    await nextRoom(guest);
    host.close();
    guest.close();

    // 直查账：Hibernation 唤醒后的唯一重建来源
    await runInDurableObject(env.ROOM.get(env.ROOM.idFromName(created.code)), (_instance, state) => {
      const seats = state.storage.sql.exec("SELECT seat, name, role, bot FROM seats ORDER BY seat").toArray();
      expect(seats).toEqual([
        { seat: 0, name: "房主", role: null, bot: 0 },
        { seat: 1, name: "朋友甲", role: "beast", bot: 0 },
        { seat: 2, name: "小黄", role: null, bot: 1 },
      ]);
      const room = state.storage.sql.exec("SELECT phase, config FROM room").toArray()[0]!;
      expect(room.phase).toBe("started");
      expect(JSON.parse(room.config as string)).toEqual(cfg);
    });

    // 重连恢复：大厅面完整（角色/配置/假人/started）
    const back = await connect(created.code, created.token);
    expect(back.hello.type).toBe("room");
    if (back.hello.type !== "room") return;
    expect(back.hello.room.phase).toBe("started");
    expect(back.hello.room.config).toEqual(cfg);
    expect(seatOf(back.hello.room.seats, 1).roleId).toBe("beast");
    expect(seatOf(back.hello.room.seats, 2).bot).toBe(true);
  });
});

describe("大厅：房主转移与假人（M2-T4，review 修复回归）", () => {
  it("房主离房：皇冠转给最早加入的真人，绝不落在假人头上", async () => {
    // 座位表：房主(0, seq1) → 假人小黄(1, seq2) → 朋友甲(2, seq3)。房主离房后皇冠应给朋友甲而非小黄
    const created = await createRoom("房主");
    const host = await connect(created.code, created.token);
    host.send({ type: "addBot" });
    await nextRoom(host); // 小黄入座广播
    const joined = await joinRoom(created.code, "朋友甲");
    const guest = await connect(created.code, joined.token);
    await nextRoom(host); // 朋友甲上线广播

    host.send({ type: "leave" });
    expect(await host.recvClose()).toBe(1000);
    await nextRoom(guest); // 离场广播（pushRoomTo）
    await nextRoom(guest); // close 事件广播

    const verify = await connect(created.code, joined.token); // 朋友甲重连读快照
    expect(verify.hello.type).toBe("room");
    if (verify.hello.type !== "room") return;
    expect(verify.hello.room.hostSeat).toBe(2);
    expect(seatOf(verify.hello.room.seats, 2).host).toBe(true);
    expect(seatOf(verify.hello.room.seats, 1).host).toBe(false); // 假人不戴皇冠
  });

  it("真人清零只剩假人：房间即销毁（假人当不了房主，不留僵尸）", async () => {
    const created = await createRoom("房主");
    const host = await connect(created.code, created.token);
    host.send({ type: "addBot" });
    await nextRoom(host); // 小黄入座
    host.send({ type: "leave" });
    expect(await host.recvClose()).toBe(1000);
    // 座位表剩 1 假人 0 真人：房间应已销毁——再进 404
    expect((await postJSON(`/api/rooms/${created.code}/join`, { name: "迟到者" })).status).toBe(404);
  });
});
