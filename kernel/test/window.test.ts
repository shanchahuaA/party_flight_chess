/** 世界回合窗：全员同窗、确认等待区、提前开窗、超窗替掷、休息期 */
import { describe, expect, it } from "vitest";
import { KernelError, type GameKernel } from "../src";
import { boot, bootWithDie, bootWithDiesPure, cell, dieOf, DRAW_MOVE_TITLES, me, walkOut } from "./helpers";

describe("世界回合窗（世界·即时）", () => {
  it("开局即窗：turn1、默认窗 30s、全员待掷", () => {
    const k = boot();
    expect(k.state.turn).toBe(1);
    expect(k.state.phase).toBe("acting");
    expect(k.state.windowDeadline).toBe(30_000);
    for (const p of k.state.players) {
      expect(p.rolled).toBe(false);
      expect(p.confirmed).toBe(false);
    }
  });

  it("全员确认 → 提前开窗（不用等满窗；T3a 起零位移卡种子）", () => {
    // 预定位 (7,0) 面向 (8,0)：掷 3 西行停在 (4,0)=道具格（穿 S/E 皆不停，零事件挂起）
    const firstRoll = (k: GameKernel): number[] => {
      k.apply({ type: "dev.setPos", pid: 0, pos: cell(7, 0), from: cell(8, 0), net: 0 }, 0);
      const fx = k.apply({ type: "roll", pid: 0 }, 0);
      walkOut(k, 0);
      return [dieOf(fx)];
    };
    const k = bootWithDiesPure(firstRoll, [3], {}, DRAW_MOVE_TITLES);
    firstRoll(k);
    k.apply({ type: "confirm", pid: 0 }, 2_000);
    // 假人按日程 ~1-3s 掷 + 走完 + 0.5s 拍确认——推到全员确认触发提前开窗
    let t = 3_000;
    while (k.state.phase === "acting" && t <= 30_000) {
      k.tick(t);
      t += 500;
    }
    expect(k.state.phase).toBe("rest");
    expect(k.state.turn).toBe(2);
    // 提前收口证据：收口点在满窗（30s）之前——restUntil 早于「满窗+休息」
    expect(k.state.restUntil).toBeLessThan(30_000 + k.config.restMs);
    // rest 默认 10s：过了 restUntil 开窗 2
    k.tick(k.state.restUntil + 1);
    expect(k.state.turn).toBe(2);
    expect(k.state.phase).toBe("acting");
  });

  it("超窗替掷：没掷的人被替掷并自动确认，windowEnd.auto=true（含播报）", () => {
    const k = boot();
    // 真人：窗内不动，也不确认
    const fx = k.tick(30_000);
    expect(fx.some((f) => f.type === "roll" && f.pid === 0 && f.auto === true)).toBe(true);
    expect(fx.some((f) => f.type === "confirm" && f.pid === 0 && f.auto === true)).toBe(true);
    expect(fx.some((f) => f.type === "windowEnd" && f.auto === true)).toBe(true);
    expect(k.state.turn).toBe(2);
    expect(k.state.phase).toBe("rest");
    const msg = k.state.messages.find((m) => m.text.includes("替 你 掷骰"));
    expect(msg?.text).toContain("点");
  });

  it("超窗时若有 walk 未完：替掷顺延不抛错，窗照常收口（贴窗掷 10 步跨窗回归）", () => {
    // 29.9s 才掷 10 步：walk 必然跨过 30s deadline
    const k = bootWithDie(10, { pos: cell(7, 0), from: cell(8, 0), net: 0 });
    k.apply({ type: "roll", pid: 0 }, 29_900);
    let t = 30_000;
    while (k.state.phase === "acting") {
      k.tick(t);
      t += 1_000;
      if (t > 40_000) throw new Error("窗未收口（替掷卡死）");
    }
    expect(k.state.phase).toBe("rest");
    // 跨窗 walk 在 rest 里照样走完
    k.tick(60_000);
    expect(me(k).walk).toBeNull();
    expect(me(k).net).toBe(10);
    // 下一窗开窗后可正常再掷（替掷顺延不吞掷）
    k.tick(61_000);
    expect(k.state.phase).toBe("acting");
    expect(k.state.players[0]!.rolled).toBe(false);
  });

  it("确认后进等待区：本窗不能再任何操作（roll/confirm 均拒；T3a 起零位移卡种子）", () => {
    // 预定位 (7,0) 面向 (8,0)：掷 3 西行停在 (4,0)=道具格（穿 S/E 皆不停，零事件挂起）
    const firstRoll = (k: GameKernel): number[] => {
      k.apply({ type: "dev.setPos", pid: 0, pos: cell(7, 0), from: cell(8, 0), net: 0 }, 0);
      const fx = k.apply({ type: "roll", pid: 0 }, 0);
      walkOut(k, 0);
      return [dieOf(fx)];
    };
    const k = bootWithDiesPure(firstRoll, [3], {}, DRAW_MOVE_TITLES);
    // 硬规格 ①：掷骰与确认分离——没掷骰不能先确认（防静默吞骰）
    expect(() => k.apply({ type: "confirm", pid: 0 }, 0)).toThrow(KernelError);
    firstRoll(k);
    k.apply({ type: "confirm", pid: 0 }, 2_000);
    expect(() => k.apply({ type: "roll", pid: 0 }, 3_000)).toThrow(KernelError);
    expect(() => k.apply({ type: "confirm", pid: 0 }, 3_000)).toThrow(KernelError);
  });

  it("确认与走格解耦：走格途中确认，走格照样走完（确认结束不卡动画）", () => {
    // 预定位 (7,0) 面向 (8,0)：掷出去无岔口，走格中途点确认
    const k = bootWithDie(4, { pos: cell(7, 0), from: cell(8, 0), net: 0 });
    k.apply({ type: "roll", pid: 0 }, 0);
    k.tick(140);
    expect(me(k).walk).not.toBeNull();
    k.apply({ type: "confirm", pid: 0 }, 1_000);
    let t = 1_000;
    while (me(k).walk) {
      t += 140;
      if (t > 6_000) throw new Error("确认后 walk 卡死");
      k.tick(t);
    }
    expect(me(k).trail.length).toBe(4);
    expect(me(k).pos).toBe(cell(3, 0));
  });

  it("休息期：默认 10s 后自动开下一窗；skipRest 可提前", () => {
    const k = boot({ windowMs: 100, restMs: 5_000 });
    k.tick(200);
    expect(k.state.phase).toBe("rest");
    k.tick(3_000);
    expect(k.state.phase).toBe("rest");
    k.apply({ type: "skipRest" }, 3_100);
    k.tick(3_200);
    expect(k.state.phase).toBe("acting");
    expect(k.state.turn).toBe(2);
  });

  it("休息期里跳过：skipRest 只在 rest 有效", () => {
    const k = boot();
    expect(() => k.apply({ type: "skipRest" }, 0)).toThrow(KernelError);
  });

  it("窗内 bot 替掷同路径：bot 日程到点自动掷（不弹条不卡窗）", () => {
    const k = boot({ windowMs: 10_000 });
    k.tick(1_550); // bot1 日程 ∈ [750,1450] + 起始拍
    expect(k.state.players[1]!.rolled).toBe(true);
    // bot 掷出的走格不弹选路条（bot 在 tick 循环里已由内核自行走置）
    let asked = false;
    for (let t = 1_600; t <= 6_000; t += 140) {
      if (k.state.players.some((p) => p.isBot && p.walk?.ask)) asked = true;
      k.tick(t);
    }
    expect(asked).toBe(false);
  });
});
