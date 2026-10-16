/** 终点支路：入门（净步 ≥90 前向踩出生格）→ 尽头刚好踩进=通关席 / 超出反弹 */
import { describe, expect, it } from "vitest";
import { BRANCH_LEN, NET_GOAL } from "../src";
import { bootWithDie, bootWithDies, cell, dieOf, me, toNextWindow, walkOut } from "./helpers";
import type { GameKernel } from "../src";

/** 支路门口：(7,0) from (8,0) net=NET_GOAL，掷 1 即前向踩上出生格 (6,0) */
const doorPre = () => ({ pos: cell(7, 0), from: cell(8, 0), net: NET_GOAL });

/** 门内两掷脚本：掷 1 进支路并跨窗，第二掷走路；返回骰面流 */
const doorScript = (k: GameKernel): number[] => {
  p0: {
    const pre = doorPre();
    k.apply({ type: "dev.setPos", pid: 0, pos: pre.pos, from: pre.from, net: pre.net }, 0);
  }
  const fx1 = k.apply({ type: "roll", pid: 0 }, 0);
  walkOut(k, 0);
  const t2 = toNextWindow(k, 0, 30_000, 10_000);
  const fx2 = k.apply({ type: "roll", pid: 0 }, t2);
  walkOut(k, t2);
  return [dieOf(fx1), dieOf(fx2)];
};

describe("入支路门槛", () => {
  it("净步 ≥90 前向踩上出生格 → 进支路（事实+播报+bpos0）", () => {
    const k = bootWithDie(1, doorPre());
    k.apply({ type: "roll", pid: 0 }, 0);
    walkOut(k, 0);
    expect(me(k).zone).toBe("branch");
    expect(me(k).bpos).toBe(0);
    expect(me(k).pos).toBe(cell(6, 0));
    expect(k.state.messages.some((m) => m.text.includes("进终点支路"))).toBe(true);
  });

  it("净步不足 90 踩上出生格不进支路（入门步也计入净步——stub 同口径）", () => {
    // 门口净 88，踩上出生格后净 89 <90 → 仍为主网
    const k = bootWithDie(1, { pos: cell(7, 0), from: cell(8, 0), net: NET_GOAL - 2 });
    k.apply({ type: "roll", pid: 0 }, 0);
    walkOut(k, 0);
    expect(me(k).zone).toBe("main");
    expect(me(k).pos).toBe(cell(6, 0));
    expect(me(k).net).toBe(NET_GOAL - 1);
  });
});

describe("支路尽头与反弹", () => {
  it("尽头刚好踩进：门口掷 1 进支路，跨窗再掷 BRANCH_LEN → 通关席（done/名次/pulse.big/确认免占）", () => {
    const k = bootWithDies(doorScript, [1, BRANCH_LEN]);
    const pre = doorPre();
    k.apply({ type: "dev.setPos", pid: 0, pos: pre.pos, from: pre.from, net: pre.net }, 0);
    k.apply({ type: "roll", pid: 0 }, 0);
    walkOut(k, 0);
    expect(me(k).zone).toBe("branch");
    const t2 = toNextWindow(k, 0, 30_000, 10_000);
    const fx = k.apply({ type: "roll", pid: 0 }, t2);
    const all = [...walkOut(k, t2)];
    for (const one of fx) all.push(one);
    expect(fx.find((f) => f.type === "roll" && f.pid === 0 && f.auto === false)).toBeTruthy();
    // 支路逐格：bpos 1..3 三步 + 第 4 步踩墙判分
    const branchSteps = all.filter((f) => f.type === "stepBranch" && f.pid === 0);
    expect(branchSteps.length).toBe(3);
    expect(all.some((f) => f.type === "finish" && f.pid === 0)).toBe(true);
    expect(all.some((f) => f.type === "pulse" && f.pid === 0 && f.level === "big")).toBe(true);
    expect(me(k).zone).toBe("done");
    expect(me(k).bpos).toBe(BRANCH_LEN);
    expect(k.state.finishers).toEqual([0]);
    expect(k.state.messages.some((m) => m.text.includes("通关席"))).toBe(true);
    // 通关席不再掷骰（新窗替掷也不会为它掷/确认）
    void toNextWindow(k, t2, 30_000, 10_000);
  });

  it("超出反弹：门口掷 1 进支路，跨窗掷 9 → 撞旗折返，溢出步从家门口前向走出（(5,0)）", () => {
    const k = bootWithDies(doorScript, [1, 9]);
    const pre = doorPre();
    k.apply({ type: "dev.setPos", pid: 0, pos: pre.pos, from: pre.from, net: pre.net }, 0);
    k.apply({ type: "roll", pid: 0 }, 0);
    walkOut(k, 0);
    const t2 = toNextWindow(k, 0, 30_000, 10_000);
    k.apply({ type: "roll", pid: 0 }, t2);
    let all: import("../src").Fact[] = [];
    let t = t2;
    for (let i = 0; i < 80; i++) {
      t += 140;
      if (!me(k).walk) break;
      all = all.concat(k.tick(t));
    }
    const bounce = all.find((f) => f.type === "bounce");
    const exit = all.find((f) => f.type === "bounceExit");
    expect(bounce).toBeTruthy();
    expect(exit).toBeTruthy();
    // 追踪：掷 9 → 支路前进 4 格撞旗 → 反弹 4 步回门口 → 剩 1 步从家门口前向走 1 格到 (5,0)
    expect(me(k).pos).toBe(cell(5, 0));
    expect(me(k).zone).toBe("main");
    expect(me(k).net).toBe(NET_GOAL + 1 - BRANCH_LEN + 1); // 91 进网 → −4 反弹 → +1 前进 = 88
  });
});
