/** 来路栈退格：沿原路退回、穿环岛不重弹选路条 */
import { describe, expect, it } from "vitest";
import { DRAW_MOVE_TITLES, boot, bootWithDie, cell, dieOf, me, seedForScriptNoDraws, walkOut } from "./helpers";
import type { GameKernel } from "../src";

/** 沿中横街西行 6 步（两次过环岛都选「← 中横街」直行），停在 (5,10)；
 *  种子搜定：骰面 6 且全程不抽位移卡（穿格不触，落点抽到也不改停位） */
function runWest6(k: GameKernel): number[] {
  k.apply({ type: "dev.setPos", pid: 0, pos: cell(11, 10), from: cell(12, 10), net: 2 }, 0);
  const fx = k.apply({ type: "roll", pid: 0 }, 0);
  let t = 0;
  while (true) {
    const walk = me(k).walk;
    if (!walk) break;
    t += 140;
    if (t > 6_000) throw new Error("walk 卡死");
    const ask = walk.ask;
    if (ask) {
      const left = ask.options.findIndex((o) => o.label.startsWith("←"));
      k.apply({ type: "chooseRoute", pid: 0, option: left === -1 ? 0 : left }, t);
    } else {
      k.tick(t);
    }
  }
  return [dieOf(fx)];
}

/** 搜种子用的整流程：西行 6 步 + 退整条栈 6 步（退格落在 (11,10) 事件格，落点抽卡也不许位移）
 *  ——两段合起来搜，退 4 步那条（后段更浅）自动被覆盖 */
function runWest6Full(k: GameKernel): number[] {
  const faces = runWest6(k);
  k.apply({ type: "dev.back", pid: 0, steps: 6 }, 7_000);
  walkOut(k, 7_000);
  return faces;
}

/** 先沿中横街西行 6 步的盘面（脚本按同种子重放；整流程零位移卡） */
function setupWest6() {
  const k = boot({ seed: seedForScriptNoDraws(runWest6Full, [6], DRAW_MOVE_TITLES) });
  runWest6(k);
  expect(me(k).pos).toBe(cell(5, 10)); // 6 步西侧标准位
  expect(me(k).trail.length).toBe(6);
  expect(me(k).net).toBe(8); // 起点 2 + 6
  return k;
}

describe("退格（来路栈）", () => {
  it("退 4 步：原路退回 (9,10)——中途穿环岛不重弹选路条；trail 精确回吐", () => {
    const k = setupWest6();
    k.apply({ type: "dev.back", pid: 0, steps: 4 }, 7_000);
    const all = walkOut(k, 7_000);
    const steps = all.filter((f) => f.type === "step" && f.pid === 0);
    expect(steps.length).toBe(4);
    for (const s of steps) expect(s.type === "step" && s.dir === -1).toBe(true);
    // 退序：(6,10)→(7,10)→(8,10)→(9,10)，第 4 步正落环岛——全程无弹条
    expect(all.some((f) => f.type === "routeAskOpen")).toBe(false);
    expect(me(k).pos).toBe(cell(9, 10));
    expect(me(k).trail.length).toBe(2);
    expect(me(k).net).toBe(4);
  });

  it("退整条栈：6 步原路退回出发点（trail 清空、净步还原）", () => {
    const k = setupWest6();
    k.apply({ type: "dev.back", pid: 0, steps: 6 }, 7_000);
    const all = walkOut(k, 7_000);
    expect(all.filter((f) => f.type === "step" && f.pid === 0).length).toBe(6);
    expect(me(k).pos).toBe(cell(11, 10));
    expect(me(k).trail.length).toBe(0);
    expect(me(k).net).toBe(2);
    expect(all.some((f) => f.type === "routeAskOpen")).toBe(false);
  });

  it("退超出本次走格：栈空后按来向兜底（无位移消耗步数——stub 同款语义）", () => {
    // (11,10) 前进 1 步到 (10,10)，随后退 2：第 1 步原路回 (11,10)，第 2 步无路可退静息
    const k = bootWithDie(1, { pos: cell(11, 10), from: cell(12, 10), net: 2 });
    k.apply({ type: "roll", pid: 0 }, 0);
    walkOut(k, 0);
    expect(me(k).pos).toBe(cell(10, 10));
    k.apply({ type: "dev.back", pid: 0, steps: 2 }, 7_000);
    walkOut(k, 7_000);
    expect(me(k).pos).toBe(cell(11, 10));
    expect(me(k).trail.length).toBe(0);
    expect(me(k).net).toBe(1); // 2+1−2
  });
});
