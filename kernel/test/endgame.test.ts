/**
 * 终局流程启动与通关席行为约束（#35 T8a1，一页纸「局长/通关席」节）：
 * - 局长打满（默认 15 世界回合，5–30 可调）→ 终局流程启动——没有「首名冲线提前结束」；
 * - 通关席三句：棋子停在终点不再掷骰／仍可打整蛊卡（chooseOther 口子）／必参最后一波（名册态 seat）；
 * - 入席先后序=finishers（踩进先后，T1 基座）×FINISH_SCORES 分位（首通 +10／次通 +8／第三 +6，数值表 §5.1 真源）；
 * - 终局名册态（fight/seat/out）供 T9 轮班·限时跳过消费；局中淘汰即时翻 out。
 *
 * 确定性铁律：入席路全程只踩出生格/支路格（无事件/陷阱落点、无位移卡搅局）；恶意关档（无世界层伤害）；
 * 双人真人局铺先后入席（骰面走种子搜索配准，无假人日程抢跑）。
 */
import { describe, expect, it } from "vitest";
import { BRANCH_LEN, FINISH_SCORES, GameKernel, NET_GOAL, ITEM_CARDS, finishScore, itemLegalTargets, itemPlayGate } from "../src";
import type { Fact, GameConfig, PlayerDef } from "../src";
import { advanceWorldTurns, boot, cell, dieOf, me, toNextWindow, tryGiveItem, walkOut } from "./helpers";

const msg = (k: GameKernel, text: string): boolean =>
  k.state.messages.some((m) => m.text.includes(text) || m.flavor?.includes(text) === true);

/** 双人真人局（无假人：无日程抢跑、无世界层之外的随机死亡）；恶意关档 */
const TWO: PlayerDef[] = [
  { name: "你", isBot: false, roleId: "light" },
  { name: "阿二", isBot: false, roleId: "tough" },
];
const boot2 = (seed: number, over: Partial<GameConfig> = {}): GameKernel => {
  const { kernel } = GameKernel.create({ allowDev: true, seed, maliceLevel: "off", ...over }, 0, TWO);
  kernel.apply({ type: "chooseSecret", pid: 0, pick: 0 }, 0);
  return kernel;
};

/** pid1 的支路门口（出生格 (12,17) 西侧邻格，掷 1 前向踩上=进支路） */
const door1 = () => ({ pos: cell(12, 16), from: cell(12, 15), net: NET_GOAL });

/** 给 pid 塞一张指定 route 的道具卡（被别家摸走的跳过——customs.test giveFrom 同式）；返回卡 id */
const giveByRoute = (k: GameKernel, pid: number, route: string): string => {
  for (const c of ITEM_CARDS) {
    if (c.route !== route) continue;
    if (tryGiveItem(k, pid, c.id, 0)) return c.id;
  }
  throw new Error(`没有可塞的 ${route} 卡`);
};

describe("终局启动边界（局长打满）", () => {
  it("默认局长 15：第 14 窗收口不启动，第 15 窗收口才启动（endgame 挂账+endgameStart/gameEnd 事实+大战报）", () => {
    const k = boot({ windowMs: 0, restMs: 0 });
    const now = advanceWorldTurns(k, 14);
    expect(k.state.turn).toBe(15);
    expect(k.state.phase).toBe("acting");
    expect(k.state.endgame).toBeNull();
    const fx = k.tick(now); // 收第 15 窗 → 终局启动
    expect(k.state.phase).toBe("over");
    expect(k.state.endgame).toEqual({ turn: 16 });
    expect(fx.some((f) => f.type === "endgameStart" && f.turn === 16)).toBe(true);
    expect(fx.some((f) => f.type === "gameEnd")).toBe(true);
    expect(msg(k, "终局流程启动")).toBe(true);
    // 名册态域完整（具体 fight/seat/out 落账由受控场景钉死）
    expect(k.state.players.every((p) => p.endgame === "fight" || p.endgame === "seat" || p.endgame === "out")).toBe(true);
  });

  it("可调生效：turnCap 5 → 第 5 窗收口启动；turnCap 30 → 16 窗后仍在局", () => {
    const k5 = boot({ turnCap: 5, windowMs: 0, restMs: 0 });
    const now = advanceWorldTurns(k5, 4);
    expect(k5.state.endgame).toBeNull();
    k5.tick(now);
    expect(k5.state.phase).toBe("over");
    expect(k5.state.endgame).toEqual({ turn: 6 });
    const k30 = boot({ turnCap: 30, windowMs: 0, restMs: 0 });
    advanceWorldTurns(k30, 16);
    expect(k30.state.phase).not.toBe("over");
    expect(k30.state.endgame).toBeNull();
  });
});

describe("无人被提前收束+入席先后序+分位", () => {
  /** 先后入席脚本：双双钉门口（掷 1 进支路）→ 同窗各掷 BRANCH_LEN 踩进=先后通关席 */
  const twoSeatScript = (k: GameKernel): number[] => {
    const faces: number[] = [];
    k.apply({ type: "dev.setPos", pid: 0, pos: cell(7, 0), from: cell(8, 0), net: NET_GOAL }, 0);
    const d1 = door1();
    k.apply({ type: "dev.setPos", pid: 1, pos: d1.pos, from: d1.from, net: d1.net }, 0);
    faces.push(dieOf(k.apply({ type: "roll", pid: 0 }, 0), 0));
    faces.push(dieOf(k.apply({ type: "roll", pid: 1 }, 0), 1));
    walkOut(k, 0);
    const t2 = toNextWindow(k, 0, 30_000, 10_000);
    faces.push(dieOf(k.apply({ type: "roll", pid: 0 }, t2), 0));
    faces.push(dieOf(k.apply({ type: "roll", pid: 1 }, t2), 1));
    walkOut(k, t2);
    return faces;
  };

  /** 搜种子：四人骰面流 [1,1,BRANCH_LEN,BRANCH_LEN]（双方先后入席；确定性铁律见文件头） */
  const seedForTwoSeats = (): number => {
    for (let seed = 1; seed < 20000; seed++) {
      try {
        const k = boot2(seed);
        const faces = twoSeatScript(k);
        if (faces.length === 4 && faces[0] === 1 && faces[1] === 1 && faces[2] === BRANCH_LEN && faces[3] === BRANCH_LEN) return seed;
      } catch {
        // 该种子下脚本中断，换下一粒
      }
    }
    throw new Error("找不到双人先后入席的种子（1..19999）");
  };

  /** 铺好先后入席的新盘（重放同脚本——同种子全流程确定） */
  const bootTwoSeats = (): { k: GameKernel; t2: number } => {
    const seed = seedForTwoSeats();
    const k = boot2(seed);
    twoSeatScript(k);
    // 重放后窗钟与搜索局一致：两个窗口耗时各 40s
    return { k, t2: 40_000 };
  };

  it("首名冲线不收局：双双入席后不进终局，finishers 先后序保留，战报带 10/8 分位", () => {
    const { k } = bootTwoSeats();
    expect(k.state.finishers).toEqual([0, 1]);
    expect(k.state.phase).not.toBe("over"); // 无人被提前收束——入席不收局（全员入席窗自然收口）
    expect(k.state.endgame).toBeNull();
    expect(me(k).zone).toBe("done");
    expect(msg(k, "为第 1 位通关席（结算分位 +10）")).toBe(true);
    expect(msg(k, "为第 2 位通关席（结算分位 +8）")).toBe(true);
  });

  it("入席后照常走到局长打满才进终局：endgame 挂账+名册 seat/fight 落定", () => {
    const { k } = bootTwoSeats();
    let guard = 30;
    while (k.state.phase !== "over" && guard-- > 0) {
      const now = Math.max(k.state.windowDeadline, k.state.restUntil) + 1;
      k.tick(now);
    }
    expect(k.state.phase).toBe("over");
    expect(k.state.endgame).toEqual({ turn: 16 });
    expect(k.state.players[0]!.endgame).toBe("seat");
    expect(k.state.players[1]!.endgame).toBe("seat");
    expect(msg(k, "通关席 2")).toBe(true);
  });
});

describe("通关席三句", () => {
  /** 单人入席脚本（pid1 入席，pid0 留在局里让窗口开着）：faces=[进门 1, 踩进 BRANCH_LEN] */
  const seat1Script = (k: GameKernel): number[] => {
    const d1 = door1();
    k.apply({ type: "dev.setPos", pid: 1, pos: d1.pos, from: d1.from, net: d1.net }, 0);
    const f1 = dieOf(k.apply({ type: "roll", pid: 1 }, 0), 1);
    walkOut(k, 0);
    const t2 = toNextWindow(k, 0, 30_000, 10_000);
    const f2 = dieOf(k.apply({ type: "roll", pid: 1 }, t2), 1);
    walkOut(k, t2);
    return [f1, f2];
  };
  const seedForSeat1 = (): number => {
    for (let seed = 1; seed < 20000; seed++) {
      try {
        const k = boot2(seed);
        const faces = seat1Script(k);
        if (faces[0] === 1 && faces[1] === BRANCH_LEN) return seed;
      } catch {
        // 换下一粒
      }
    }
    throw new Error("找不到 pid1 入席的种子（1..19999）");
  };
  const bootSeat1 = (): { k: GameKernel; t2: number } => {
    const seed = seedForSeat1();
    const k = boot2(seed);
    seat1Script(k);
    return { k, t2: 40_000 };
  };

  it("不再掷骰：入席者掷骰意图被拒（通关席/出局者不再行动）", () => {
    const { k, t2 } = bootSeat1();
    expect(k.state.players[1]!.zone).toBe("done");
    expect(() => k.apply({ type: "roll", pid: 1 }, t2)).toThrow("通关席");
  });

  it("仍可打整蛊卡：chooseOther 口子开（闸放行+真打一张落账），自用卡被收紧", () => {
    const { k, t2 } = bootSeat1();
    const trick = giveByRoute(k, 1, "chooseOther");
    expect(itemPlayGate(k.state, 1, trick)).toEqual({ ok: true });
    const self = giveByRoute(k, 1, "self");
    expect(itemPlayGate(k.state, 1, self).ok).toBe(false);
    // 端到端：入席者真打一张指认卡（目标池天然跳过通关席自己）
    const target = itemLegalTargets(k.state, 1, trick)[0]!;
    const fx: Fact[] = k.apply({ type: "playItem", pid: 1, cardId: trick, target }, t2);
    expect(fx.some((f) => f.type === "itemPlayed" && f.pid === 1 && f.cardId === trick)).toBe(true);
    expect(k.state.players[1]!.hand.includes(trick)).toBe(false);
  });

  it("必参最后一波：终局启动后通关席名册态=seat（参战侧），不在 out 跳过名单——T9 消费口径", () => {
    const { k } = bootSeat1();
    let guard = 30;
    while (k.state.phase !== "over" && guard-- > 0) {
      const now = Math.max(k.state.windowDeadline, k.state.restUntil) + 1;
      k.tick(now);
    }
    expect(k.state.players[1]!.endgame).toBe("seat");
    expect(k.state.players[1]!.endgame).not.toBe("out");
    expect(k.state.players[0]!.endgame).toBe("fight");
  });
});

describe("终局名册态·淘汰翻账", () => {
  it("局中淘汰即时翻 out（不待终局启动）；终局启动时成批落定幂等重落", () => {
    const k = boot({ windowMs: 0, restMs: 0, maliceLevel: "off" });
    k.apply({ type: "dev.setDead", pid: 1 }, 0);
    expect(k.state.players[1]!.endgame).toBe("out");
    expect(k.state.players[0]!.endgame).toBeNull();
    advanceWorldTurns(k, 15);
    expect(k.state.endgame).not.toBeNull();
    expect(k.state.players[1]!.endgame).toBe("out"); // 启动成批重落=同账
    expect(k.state.players[0]!.endgame).toBe("fight");
    expect(k.state.players[2]!.endgame).toBe("fight");
    expect(k.state.players[3]!.endgame).toBe("fight");
  });
});

describe("通关分分位（数值表 §5.1 真源）", () => {
  it("FINISH_SCORES=[10,8,6]；finishScore 名次映射：首通 10／次通 8／第三 6／第四位起无分位", () => {
    expect(FINISH_SCORES).toEqual([10, 8, 6]);
    expect(finishScore(1)).toBe(10);
    expect(finishScore(2)).toBe(8);
    expect(finishScore(3)).toBe(6);
    expect(finishScore(4)).toBe(0);
    expect(finishScore(8)).toBe(0);
  });
});
