/** 环岛选路：真实多路才弹条、10 秒超时自动直行、bot 自动走直行偏好 */
import { describe, expect, it } from "vitest";
import { KernelError } from "../src";
import type { Fact } from "../src";
import { boot, bootWithDie, cell, me } from "./helpers";

describe("环岛选路", () => {
  it("开局岔口：出生格两条环向都算真实多路 → 弹选路条（选项带方向+街名）", () => {
    const k = boot();
    k.apply({ type: "roll", pid: 0 }, 0);
    const t140 = k.tick(140); // 第一格起手：出生格两个环向即真实岔口 → 弹条
    const ask = me(k).walk?.ask;
    expect(ask).not.toBeNull();
    expect(ask!.options.length).toBe(2);
    expect(ask!.options.map((o) => o.label)).toEqual(["← 外环", "→ 外环"]);
    const open = t140.filter((f) => f.type === "routeAskOpen" && f.pid === 0);
    expect(open.length).toBe(1);
  });

  it("点选一条路：剩余步数继续走完；routeChosen auto=false", () => {
    const k = bootWithDie(4); // 第一掷 4 步
    k.apply({ type: "roll", pid: 0 }, 0);
    k.tick(140); // 弹条（打开下行前的第一个岔口）
    const ask = me(k).walk!.ask!;
    const right = ask.options.findIndex((o) => o.label === "→ 外环");
    const fx = k.apply({ type: "chooseRoute", pid: 0, option: right }, 2_000);
    expect(fx.some((f) => f.type === "routeChosen" && f.pid === 0 && f.auto === false)).toBe(true);
    // 掷 4 步：起点(6,0)→(7,0)[选路那一格]→…→(10,0)，walk 自行走完
    const deadline = 2_000 + 140 * 4;
    let t = 2_000;
    while (me(k).walk) {
      t += 140;
      if (t > deadline + 5_000) throw new Error("walk 未自行走完");
      k.tick(t);
    }
    expect(me(k).pos).toBe(cell(10, 0));
    expect(me(k).trail.length).toBe(4); // 全部 4 步来路栈齐全
    expect(me(k).net).toBe(4);
  });

  it("10 秒不选：自动直行（无直行才取第一项），并播报", () => {
    const k = boot();
    k.apply({ type: "roll", pid: 0 }, 0);
    k.tick(140); // 岔口弹条，deadline = 10000+140
    k.tick(10_000 + 140 - 1);
    expect(me(k).walk!.ask).not.toBeNull(); // 还没到点
    const fx = k.tick(10_000 + 140);
    const chosen = fx.find((f) => f.type === "routeChosen" && f.pid === 0);
    expect(chosen).toBeTruthy();
    expect(chosen && chosen.type === "routeChosen" && chosen.auto).toBe(true);
    // 起点 from=null 无直行方向：取第一项（← 外环，即 (5,0)）
    expect(chosen && chosen.type === "routeChosen" && chosen.to).toBe(cell(5, 0));
    const msg = k.state.messages.find((m) => m.text.includes("自动直行"));
    expect(msg?.text).toContain("岔口超时");
  });

  it("选路下标越界拒绝", () => {
    const k = boot();
    k.apply({ type: "roll", pid: 0 }, 0);
    k.tick(140);
    expect(() => k.apply({ type: "chooseRoute", pid: 0, option: 9 }, 1_000)).toThrow(KernelError);
    expect(() => k.apply({ type: "chooseRoute", pid: 9, option: 0 }, 1_000)).toThrow(KernelError);
  });

  it("直行格不弹条；真岔口才弹（环岛 (9,10) 途经弹一次、离开后不再叠弹）", () => {
    // 从 (11,10) 向西滚 6 步：(10,10)→ 环岛 (9,10) 弹条 → (8,10)(7,10)→ 环岛 (6,10) 再弹条
    const k = bootWithDie(6, { pos: cell(11, 10), from: cell(12, 10), net: 2 });
    k.apply({ type: "roll", pid: 0 }, 0);
    const all: Fact[] = [];
    for (const t of [140, 280, 420, 560, 700, 840, 980, 1120]) all.push(...k.tick(t));
    const asks = all.filter((f) => f.type === "routeAskOpen" && f.pid === 0);
    // 途经 (9,10) 停步弹一次；行动东行向翠写不停在无岔直格
    expect(asks.length).toBe(1);
    expect(me(k).walk!.ask!.options.map((o) => o.label)).toEqual(["← 中横街", "↓ 东巷"]);
    // 选直行西行继续
    k.apply({ type: "chooseRoute", pid: 0, option: 0 }, 1_130);
    // 继续 tick 直至下一次弹条（(6,10)）
    let t = 1_270;
    while (!me(k).walk?.ask && t <= 3_200) {
      t += 140;
      const tf = k.tick(t);
      if (tf.some((f) => f.type === "routeAskOpen" && f.pid === 0)) {
        expect(me(k).walk!.ask!.options.map((o) => o.label)).toEqual(["← 中横街", "↓ 中竖街"]);
        return;
      }
    }
    throw new Error("没有在 (6,10) 弹第二张条");
  });

  it("bot 走岔口从不弹条（自动按直行偏好走）", () => {
    const k = boot();
    for (let t = 0; t <= 8_000; t += 140) k.tick(t);
    const botAsk = k.state.players.some((p) => p.isBot && p.walk?.ask);
    expect(botAsk).toBe(false);
    // 假人也确实走到过环岛 >= 一格（已离家/已入岔口至少一次）
    const moved = k.state.players.filter((p) => p.isBot && p.trail.length > 0).length;
    expect(moved).toBeGreaterThanOrEqual(1);
  });
});
