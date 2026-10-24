// M2-T3（#40）全生命周期主链（Spec #37 Testing Decisions 缝 2：Room DO 的 WS 协议边界）。
// 好测试=外部行为级别：HTTP/WS 进、快照/状态码/关闭码断言，不测内部函数。
// isolatedStorage 默认开：每个 it 独立存储，互不污染。共用客户端在 ./helpers（M2-T4 抽出）。
//
// 状态机三问对照（docs/脚手架约定.md；DO 单线程事件串行是结构性前提）：
// 1. 同一实体并发操作（两人抢进同座）：DO 事件串行 + 最小空位分配，无第二写者；豁免专项测试。
// 2. 标的消失后迟到操作（离房/解散后 socket 迟到消息）：webSocketMessage 的 seat==null 关线分支 +
//    本文件「解散后旧 token 重连 404」断言覆盖。
// 3. 边界重入（close 事件重入广播）：webSocketClose 的 roomRow() 判空 + 广播排除自身，末人离房/解散路径有测试。
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { connect, createRoom, joinRoom, postJSON } from "./helpers";

describe("房间生命周期主链（M2-T3）", () => {
  it("创建→加入→座位互见（含昵称/码形态）", async () => {
    const created = await createRoom("房主");
    expect(created.code).toMatch(/^[A-Z2-9]{5}$/); // 易混淆字符已剔除的 5 位码
    expect(created.seat).toBe(0);
    const joined = await joinRoom(created.code, "朋友甲");
    expect(joined.seat).toBe(1);

    const host = await connect(created.code, created.token);
    expect(host.hello.type).toBe("room");
    if (host.hello.type !== "room") return;
    expect(host.hello.you).toBe(0);
    expect(host.hello.room.code).toBe(created.code);
    expect(host.hello.room.seats).toEqual([
      { seat: 0, name: "房主", online: true, host: true, roleId: null, bot: false },
      { seat: 1, name: "朋友甲", online: false, host: false, roleId: null, bot: false },
    ]);

    const guest = await connect(created.code, joined.token);
    expect(guest.hello.type).toBe("room");
    if (guest.hello.type !== "room") return;
    expect(guest.hello.you).toBe(1);
    expect(guest.hello.room.seats.find((s) => s.seat === 0)?.online).toBe(true);

    // 房主收到广播：朋友甲转在线（座位互见）
    const m1 = await host.recv();
    expect(m1.type).toBe("room");
    if (m1.type !== "room") return;
    expect(m1.room.seats.find((s) => s.seat === 1)?.online).toBe(true);
  });

  it("同 token 双开：新连顶旧连，旧连收 replaced 后被关闭", async () => {
    const created = await createRoom("房主");
    const w1 = await connect(created.code, created.token);
    expect(w1.hello.type).toBe("room");
    if (w1.hello.type !== "room") return;
    expect(w1.hello.you).toBe(0);

    const w2 = await connect(created.code, created.token);
    const old = await w1.recv();
    expect(old.type).toBe("replaced");
    expect(await w1.recvClose()).toBe(4001);

    expect(w2.hello.type).toBe("room");
    if (w2.hello.type !== "room") return;
    expect(w2.hello.you).toBe(0);
    expect(w2.hello.room.seats).toHaveLength(1); // 顶替不产生新座位
  });

  it("满 8 人拒进（409）；加入不存在房间 404", async () => {
    const created = await createRoom("房主");
    for (let i = 1; i <= 7; i++) await joinRoom(created.code, `玩家${i}`);
    const res = await postJSON(`/api/rooms/${created.code}/join`, { name: "第九人" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("已满");

    const ghost = await postJSON("/api/rooms/ZZZZZ/join", { name: "游客" });
    expect(ghost.status).toBe(404); // 空壳 DO：无房间账即不存在
  });

  it("主动离房：座位释放且 token 作废；座位号复用给后进者", async () => {
    const created = await createRoom("房主");
    const joined = await joinRoom(created.code, "朋友甲");
    const host = await connect(created.code, created.token);
    const guest = await connect(created.code, joined.token);
    await host.recv(); // guest 上线广播

    guest.send({ type: "leave" });
    expect(await guest.recvClose()).toBe(1000);
    const m = await host.recv();
    expect(m.type).toBe("room");
    if (m.type !== "room") return;
    expect(m.room.seats).toHaveLength(1);

    // 离房者 token 作废：重连被 401 拒（connect 内部对非 101 抛错）
    await expect(connect(created.code, joined.token)).rejects.toThrow("401");

    // 座位号复用：新进者补到 1 号位
    const again = await joinRoom(created.code, "后来者");
    expect(again.seat).toBe(1);
  });

  it("房主主动离房：标记转给最早加入者（座位复用后按 joined_at 而非座位号）", async () => {
    const created = await createRoom("房主");
    const jA = await joinRoom(created.code, "朋友甲"); // 1 号位
    await joinRoom(created.code, "朋友乙"); // 2 号位（留守者）
    const host = await connect(created.code, created.token);
    const guestA = await connect(created.code, jA.token);
    await host.recv(); // guestA 上线广播（guestA 自己的直发快照已被 connect 消费）

    // 1 号位（朋友甲）离座 → 后补者补进 1 号位，但比 2 号位的朋友乙晚加入
    guestA.send({ type: "leave" });
    expect(await guestA.recvClose()).toBe(1000);
    await host.recv(); // 朋友甲离场广播
    await joinRoom(created.code, "后补者");

    host.send({ type: "leave" });
    expect(await host.recvClose()).toBe(1000);

    // 验证视角=后进的新连接：房主标记应转给朋友乙（2 号位、最早在座），不是后补者（1 号位）
    const joined = await joinRoom(created.code, "验房者");
    expect(joined.seat).toBe(0); // 房主空出的 0 号位被复用
    const verify = await connect(created.code, joined.token);
    expect(verify.hello.type).toBe("room");
    if (verify.hello.type !== "room") return;
    expect(verify.hello.room.hostSeat).toBe(2);
    expect(verify.hello.room.seats.find((s) => s.seat === 2)?.host).toBe(true);
    expect(verify.hello.room.seats.find((s) => s.seat === 1)?.host).toBe(false);
  });

  it("末人离房：房间当场销毁", async () => {
    const created = await createRoom("独行者");
    const host = await connect(created.code, created.token);
    host.send({ type: "leave" });
    expect(await host.recvClose()).toBe(1000);
    const res = await postJSON(`/api/rooms/${created.code}/join`, { name: "迟到者" });
    expect(res.status).toBe(404);
  });

  it("解散：非房主被拒；房主解散全员收 dissolved、房间不可再进", async () => {
    const created = await createRoom("房主");
    const joined = await joinRoom(created.code, "朋友甲");
    const host = await connect(created.code, created.token);
    const guest = await connect(created.code, joined.token);
    await host.recv(); // guest 上线广播

    guest.send({ type: "dissolve" });
    const err = await guest.recv();
    expect(err.type).toBe("error");
    if (err.type !== "error") return;
    expect(err.message).toContain("房主");

    host.send({ type: "dissolve" });
    expect((await host.recv()).type).toBe("dissolved");
    expect((await guest.recv()).type).toBe("dissolved");
    expect(await host.recvClose()).toBe(1000);
    expect(await guest.recvClose()).toBe(1000);

    expect((await postJSON(`/api/rooms/${created.code}/join`, { name: "x" })).status).toBe(404);
    await expect(connect(created.code, joined.token)).rejects.toThrow("404");
  });

  it("休眠唤醒等价路径：账全在 SQLite，全部连接关闭后凭 token 完整恢复", async () => {
    const created = await createRoom("房主");
    const joined = await joinRoom(created.code, "朋友甲");
    const host = await connect(created.code, created.token);
    const guest = await connect(created.code, joined.token);
    host.close();
    guest.close();

    // 直接验账：座位/token/房主标记确实落 SQLite（Hibernation 唤醒后内存即此重建来源）
    await runInDurableObject(env.ROOM.get(env.ROOM.idFromName(created.code)), (_instance, state) => {
      const seats = state.storage.sql.exec("SELECT seat, name FROM seats ORDER BY seat").toArray();
      expect(seats).toEqual([
        { seat: 0, name: "房主" },
        { seat: 1, name: "朋友甲" },
      ]);
      const room = state.storage.sql.exec("SELECT host_seat FROM room").toArray();
      expect(room).toEqual([{ host_seat: 0 }]);
    });

    // 掉线归队：新连接凭原 token 拿回原座位、名册完整（全员离线不丢座位）
    const back = await connect(created.code, created.token);
    expect(back.hello.type).toBe("room");
    if (back.hello.type !== "room") return;
    expect(back.hello.you).toBe(0);
    expect(back.hello.room.seats).toEqual([
      { seat: 0, name: "房主", online: true, host: true, roleId: null, bot: false },
      { seat: 1, name: "朋友甲", online: false, host: false, roleId: null, bot: false },
    ]);
  });

  it("昵称校验：空白拒（400）、超长截 12、缺 body 拒", async () => {
    const blank = await postJSON("/api/rooms", { name: "   " });
    expect(blank.status).toBe(400);
    const missing = await postJSON("/api/rooms", {});
    expect(missing.status).toBe(400);

    const created = await createRoom("房主");
    await joinRoom(created.code, "一二三四五六七八九十甲乙丙丁");
    const host = await connect(created.code, created.token);
    expect(host.hello.type).toBe("room");
    if (host.hello.type !== "room") return;
    expect(host.hello.room.seats.find((s) => s.seat === 1)?.name).toHaveLength(12);
  });
});
