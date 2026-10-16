/** 走格意图序列：掷骰→逐格走→完成（种子 RNG，无 IO） */
import { describe, expect, it } from "vitest";
import { KernelError } from "../src";
import { boot, bootWithDie, cell, me, walkOut } from "./helpers";

describe("掷骰走格", () => {
  it("同种子确定性：两次 boot 同一骰面", () => {
    const a = boot({ seed: 42 });
    const b = boot({ seed: 42 });
    const fa = a.apply({ type: "roll", pid: 0 }, 10);
    const fb = b.apply({ type: "roll", pid: 0 }, 10);
    expect(fa.find((f) => f.type === "roll" && f.pid === 0)).toEqual(fb.find((f) => f.type === "roll" && f.pid === 0));
  });

  it("掷完立刻逐格走：步数=骰面，净步=骰面，trail 同长", () => {
    const d = 6;
    // (7,0) 面向 (6,0)（from=(8,0)）掷 d 步：沿外环向左直走，途中无环岛岔口
    const k = bootWithDie(d, { pos: cell(7, 0), from: cell(8, 0), net: 10 });
    const fx = k.apply({ type: "roll", pid: 0 }, 10);
    expect(fx.some((f) => f.type === "roll" && f.pid === 0 && f.d === d && f.auto === false)).toBe(true);

    let t = 10;
    for (let i = 0; i < 40; i++) {
      t += 140;
      const tf = k.tick(t);
      if (!k.state.players.some((p) => p.walk)) break;
      const steps = tf.filter((f) => f.type === "step" && f.pid === 0);
      for (const s of steps) expect(s.type === "step" && s.dir === 1).toBe(true);
    }
    expect(me(k).walk).toBeNull();
    expect(me(k).net).toBe(16); // 10 起点 + 6 步
    expect(me(k).trail.length).toBe(6);
    // 终点落格：(7,0) 向左 6 步 → (1,0)
    expect(me(k).pos).toBe(cell(1, 0));
  });

  it("停格后下一掷继续，行进惯性无选路条（真实岔口才弹）", () => {
    const k = bootWithDie(2, { pos: cell(7, 0), from: cell(8, 0), net: 0 });
    k.apply({ type: "roll", pid: 0 }, 0);
    walkOut(k, 0);
    expect(me(k).pos).toBe(cell(5, 0));
    // 跨窗（30s 满 + 10s 休）：第二窗再掷，纯外环直格继续 → 不弹选路条；终点随掷面定
    k.tick(30_000);
    const t2 = 40_000;
    k.tick(t2);
    const fx = k.apply({ type: "roll", pid: 0 }, t2);
    const r2 = fx.find((f) => f.type === "roll" && f.pid === 0);
    const d2 = r2 && r2.type === "roll" ? r2.d : 0;
    walkOut(k, t2);
    expect(fx.some((f) => f.type === "routeAskOpen")).toBe(false);
    // 簿记：第二掷净步/来路栈累计正确（第二掷可能拐进 (0,1) 下行，不锁停在 row0）
    expect(me(k).net).toBe(2 + d2);
    expect(me(k).trail.length).toBe(2 + d2);
    expect(me(k).walk).toBeNull();
  });

  it("走格未完成不能再掷（互斥）", () => {
    const k = bootWithDie(10, { pos: cell(7, 0), from: cell(8, 0), net: 0 });
    k.apply({ type: "roll", pid: 0 }, 0);
    // 一格没走完就掷 → 拒
    expect(() => k.apply({ type: "roll", pid: 0 }, 0)).toThrow(KernelError);
    walkOut(k, 0);
  });

  it("window 以外不能掷（休息期拒绝，全链真实走法）", () => {
    // 100ms 窗：全员超窗替掷收口 → 直接进休息期；rest 期掷骰必须被拒
    const k = boot({ windowMs: 100 });
    k.tick(200);
    // 下一窗尚未开（rest 10s），此时任何人掷骰都应拒绝
    expect(() => k.apply({ type: "roll", pid: 0 }, 300)).toThrow(KernelError);
  });

  it("确认与掷骰分离：确认后不能再掷（硬规格 ①）", () => {
    const k = bootWithDie(3, { pos: cell(7, 0), from: cell(8, 0), net: 0 });
    k.apply({ type: "roll", pid: 0 }, 0);
    walkOut(k, 0);
    k.apply({ type: "confirm", pid: 0 }, 9_000);
    expect(() => k.apply({ type: "roll", pid: 0 }, 9_500)).toThrow(KernelError);
  });
});
