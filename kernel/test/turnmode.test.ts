/** 轮班·限时（#29 T9，一页纸「计时模式」）：按座次轮流行动、轮到谁谁的倒计时才开始走、
 *  淘汰者与通关席跳过轮次、超时自动掷骰并自动确认；指他卡即时生效；年兽战不轮班（全员同波合砍）。 */
import { describe, expect, it } from "vitest";
import { NET_GOAL, type Fact, type GameKernel } from "../src";
import { boot, bootWithDie, cell, me, walkOut } from "./helpers";

/** 小窗轮班局：1s 表 + 100ms 休息（rest>0 让轮与轮有可切分的休息屏障；替掷/日程两种收棒都吃得到） */
const TURN_CFG = { timerMode: "turn" as const, windowMs: 1_000, restMs: 100 };

/** 安全首掷预定位（window.test 同款）：(7,0) 面向 (8,0) 掷 3 西行停道具格——零事件挂起 */
const SAFE_PRE = { pos: cell(7, 0), from: cell(8, 0), net: 0 };

/** 50ms 步进把当前轮推完（真人棒超时替掷、假人棒日程或替掷收棒），返回途中全部事实 */
function playRound(k: GameKernel, start: number, cap = 60_000): { facts: Fact[]; end: number } {
  const facts: Fact[] = [];
  let t = start;
  while (k.state.phase === "acting" && t <= cap) {
    t += 50;
    facts.push(...k.tick(t));
  }
  return { facts, end: t };
}

/** 把一整轮推过休息、开到下一轮，返回这轮的事实与下一轮起点 */
function roundOut(k: GameKernel, start: number): { facts: Fact[]; end: number } {
  const r = playRound(k, start);
  const facts = [...r.facts];
  let end = r.end;
  if (k.state.phase === "rest") {
    end += 200; // 越过 restMs=100
    facts.push(...k.tick(end));
  }
  return { facts, end };
}

const confirmsOf = (facts: Fact[]): number[] =>
  facts.filter((f) => f.type === "confirm").map((f) => (f.type === "confirm" ? f.pid : -1));

describe("轮班·限时：座次轮流", () => {
  it("开局第一棒=座次首位（pid 0），他的表才开始走；他人未掷", () => {
    const k = boot(TURN_CFG);
    expect(k.state.phase).toBe("acting");
    expect(k.state.turnActor).toBe(0);
    expect(k.state.windowDeadline).toBe(1_000);
    for (const p of k.state.players) {
      expect(p.rolled).toBe(false);
      expect(p.confirmed).toBe(false);
    }
  });

  it("轮到谁谁的表才走：第一棒没到点，谁的骰都没动", () => {
    const k = boot(TURN_CFG);
    k.tick(900); // 第一棒的表还差 100ms
    for (const p of k.state.players) expect(p.rolled).toBe(false);
    expect(k.state.turnActor).toBe(0);
  });

  it("超时=替掷+替确认然后让位（下一棒重开表）", () => {
    const k = boot(TURN_CFG);
    const fx = k.tick(1_000); // 第一棒到点
    expect(fx.some((f) => f.type === "roll" && f.pid === 0 && f.auto === true)).toBe(true);
    expect(fx.some((f) => f.type === "confirm" && f.pid === 0 && f.auto === true)).toBe(true);
    expect(me(k).rolled).toBe(true);
    expect(me(k).confirmed).toBe(true);
    expect(k.state.turnActor).toBe(1); // 第二棒开表
    expect(k.state.windowDeadline).toBe(2_000); // 他的表=让位时刻+窗长
    expect(k.state.players[1]!.rolled).toBe(false); // 第二棒的骰还没人替
  });

  it("确认早让位：掷完走完点确认，下一棒立刻开表（不耗满窗）", () => {
    const k = bootWithDie(3, SAFE_PRE, TURN_CFG);
    k.apply({ type: "roll", pid: 0 }, 0);
    walkOut(k, 0);
    k.apply({ type: "confirm", pid: 0 }, 600);
    expect(k.state.turnActor).toBe(1);
    expect(k.state.windowDeadline).toBe(1_600); // 600+1000——早让位省了 400ms
  });

  it("整轮按座次 0→1→2→3 走完收轮，下一轮回到 0（假人棒日程自走）", () => {
    const k = boot(TURN_CFG);
    const order: number[] = [];
    let t = 0;
    for (let round = 0; round < 2; round++) {
      const r = roundOut(k, t);
      t = r.end;
      order.push(...confirmsOf(r.facts));
    }
    expect(order).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
  });

  it("没轮到不能掷/不能确认/不能打卡（轮班闸拒因点名）", () => {
    const k = bootWithDie(3, SAFE_PRE, TURN_CFG);
    k.apply({ type: "dev.giveItem", pid: 0, cardId: "i10" }, 0); // 弹弓在手
    k.apply({ type: "roll", pid: 0 }, 0);
    walkOut(k, 0);
    k.apply({ type: "confirm", pid: 0 }, 500); // 让位给 1
    expect(() => k.apply({ type: "roll", pid: 0 }, 600)).toThrow(/还没轮到你/);
    expect(() => k.apply({ type: "confirm", pid: 0 }, 600)).toThrow(/还没轮到你/);
    expect(() => k.apply({ type: "playItem", pid: 0, cardId: "i10", target: 2 }, 600)).toThrow(/还没轮到你/);
  });

  it("淘汰者跳过轮次：1 号出局后让位直落 2 号", () => {
    const k = bootWithDie(3, SAFE_PRE, TURN_CFG);
    k.apply({ type: "dev.setDead", pid: 1 }, 0); // 还没轮到他就出局
    k.apply({ type: "roll", pid: 0 }, 0);
    walkOut(k, 0);
    k.apply({ type: "confirm", pid: 0 }, 600);
    expect(k.state.turnActor).toBe(2);
  });

  it("行动者棒上死亡=下一拍立刻让位（不耗完他的表）", () => {
    const k = boot(TURN_CFG);
    k.apply({ type: "dev.setDead", pid: 0 }, 0); // 第一棒当场暴毙
    k.tick(50);
    expect(k.state.turnActor).toBe(1);
  });

  it("棒上入席=下一拍立刻让位；下一轮整轮跳过通关席", () => {
    const k = boot(TURN_CFG);
    // 预定位支路门口（净步 90）：一路顺风（前进 2）先入支路，火箭鞋（前进 3）排队续走——
    // bpos 恰好踩到 4=通关席（不吃骰面流，确定性地在自家棒上入席）
    k.apply({ type: "dev.setPos", pid: 0, pos: cell(7, 0), from: cell(8, 0), net: NET_GOAL }, 0);
    k.apply({ type: "dev.giveItem", pid: 0, cardId: "i06" }, 0);
    k.apply({ type: "dev.drawCard", pid: 0, cardId: "e16" }, 10);
    k.apply({ type: "playItem", pid: 0, cardId: "i06" }, 20);
    walkOut(k, 30);
    expect(me(k).zone).toBe("done");
    k.tick(1_000); // 下一拍：入席者让位（zone done 过滤，不耗表）
    expect(k.state.turnActor).toBe(1);
    // 本轮走完：confirm 序不含 0（通关席跳过轮次）；下一轮同样跳过
    const r1 = roundOut(k, 1_100);
    expect(confirmsOf(r1.facts)).not.toContain(0);
    const r2 = roundOut(k, r1.end);
    expect(confirmsOf(r2.facts)).not.toContain(0);
    expect(k.state.players[0]!.rolled).toBe(false); // 通关席整局不再掷骰
  });
});

describe("轮班·限时：打卡与效果", () => {
  it("指他卡即时生效（轮班口径）：弹弓出手目标当场退，不挂 deferred", () => {
    const k = boot(TURN_CFG);
    k.apply({ type: "dev.giveItem", pid: 0, cardId: "i10" }, 0); // 弹弓
    k.apply({ type: "playItem", pid: 0, cardId: "i10", target: 1 }, 10);
    expect(k.state.deferred).toHaveLength(0); // 轮班=立刻生效，不挂账（world·即时挂账下一窗）
    expect(k.state.players[1]!.walk).not.toBeNull(); // 目标当场沿来路栈退 2
  });

  it("轮到了就能打卡（未掷骰也可——窗内任意时刻，与 world 同口径）", () => {
    const k = boot(TURN_CFG);
    k.apply({ type: "dev.giveItem", pid: 0, cardId: "i10" }, 0);
    k.apply({ type: "playItem", pid: 0, cardId: "i10", target: 1 }, 10); // 没掷骰先打卡=合法
    expect(k.state.deferred).toHaveLength(0);
  });
});

describe("轮班·限时：年兽战不轮班", () => {
  it("终局波窗 turnActor=null、假人照日程合砍、超时替砍——两种模式同规则打满收束", () => {
    const k = boot({ ...TURN_CFG, turnCap: 5 });
    // 全程挂机：5 轮 × 4 棒全替掷推进到年兽战再收束
    let t = 0;
    let guard = 0;
    while (k.state.phase !== "over" && guard++ < 1_500) {
      t += 100;
      k.tick(t);
    }
    expect(k.state.phase).toBe("over");
    expect(k.state.endgame?.beast).not.toBeNull(); // 年兽战真开过（非全员出局边角）
    expect(k.state.turnActor).toBeNull(); // 合砍不轮班
    expect(k.state.endgame?.settlement).toBeDefined();
  });
});
