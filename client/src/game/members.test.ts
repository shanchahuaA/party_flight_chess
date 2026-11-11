import { describe, expect, it } from "vitest";
import { kickableSeats, memberRows, seatsOf, type SeatLike } from "./members";

/**
 * 成员管理派生（#58 / G-07）的**可测部分**：
 * `(座位列, mySeat, hostSeat) → 成员行`——谁身边该有「请出」钮只有这一处判据，
 * ⚙ 成员管理节与大厅 🥾 同吃。渲染形态（浮层长什么样、假人行实际上不出按钮）归 IAB 冒烟。
 *
 * 判据来源（票面 AC + GLOSSARY「踢人」）：
 * - 假人没有身份可拉黑 → 没有「请出」钮（服务端也直接拒）；
 * - 自己不能踢自己（服务端同样拒）；
 * - 非房主看不到成员管理节 → 整表无人可请出；
 * - 离线真人仍可请出（房主对掉线赖座者的处置面）。
 */

const SEATS: SeatLike[] = [
  { seat: 0, name: "小黄", online: true, bot: false, host: true },
  { seat: 1, name: "阿强", online: true, bot: false, host: false },
  { seat: 2, name: "机器人甲", online: false, bot: true, host: false },
  { seat: 3, name: "小美", online: false, bot: false, host: false },
];

describe("成员行派生（G-07）：谁能被请出", () => {
  it("房主视角：真人且非自己的座位可请出——自己与假人都不行", () => {
    expect(kickableSeats({ seats: SEATS, mySeat: 0, hostSeat: 0 })).toEqual([1, 3]);
  });

  it("假人永远不可请出（假人没有身份可拉黑，服务端也直接拒）", () => {
    const botRow = memberRows({ seats: SEATS, mySeat: 0, hostSeat: 0 }).find((r) => r.bot);
    expect(botRow).toBeDefined();
    expect(botRow!.canKick).toBe(false);
    // 假人仍应出现在成员列表里（房主要看得见桌上有谁），只是没有「请出」钮
    expect(botRow!.seat).toBe(2);
  });

  it("非房主：整表无人可请出（成员管理节本来也不显示）", () => {
    expect(kickableSeats({ seats: SEATS, mySeat: 1, hostSeat: 0 })).toEqual([]);
  });

  it("自己永远不能请出自己（即便 hostSeat 因快照错位指向我）", () => {
    for (const seat of [0, 1, 3]) {
      const rows = memberRows({ seats: SEATS, mySeat: seat, hostSeat: seat });
      expect(rows.find((r) => r.seat === seat)!.canKick).toBe(false);
    }
  });

  it("座位未定（mySeat=null）或快照未到：一律不可请出，不崩", () => {
    expect(kickableSeats({ seats: SEATS, mySeat: null, hostSeat: 0 })).toEqual([]);
    expect(kickableSeats({ seats: [], mySeat: 0, hostSeat: 0 })).toEqual([]);
  });

  it("离线真人仍可请出（房主对掉线赖座者的处置面）", () => {
    expect(kickableSeats({ seats: SEATS, mySeat: 0, hostSeat: 0 })).toContain(3);
  });

  it("按座位号升序给行（与大厅座位列同序，快照乱序也不抖）", () => {
    const shuffled = [SEATS[2]!, SEATS[0]!, SEATS[3]!, SEATS[1]!];
    expect(memberRows({ seats: shuffled, mySeat: 0, hostSeat: 0 }).map((r) => r.seat)).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it("行内带名字/在线态/标记位（渲染只照单画，不再自己判）", () => {
    const rows = memberRows({ seats: SEATS, mySeat: 0, hostSeat: 0 });
    expect(rows[0]).toEqual({
      seat: 0,
      name: "小黄",
      online: true,
      bot: false,
      me: true,
      host: true,
      canKick: false,
    });
    expect(rows[3]).toMatchObject({ name: "小美", online: false, me: false, canKick: true });
  });
});

describe("快照座位列 → 派生输入（类型桥）", () => {
  it("原样保留座位/名字/在线/假人/房主五个字段", () => {
    expect(
      seatsOf([
        { seat: 1, name: "阿强", online: true, host: false, roleId: "light", bot: false },
      ]),
    ).toEqual([{ seat: 1, name: "阿强", online: true, bot: false, host: false }]);
  });
});
