/** 开局配置五项生效与冻结（#18 T2）：局长/血量/世界回合窗/计时模式/休息；drafting 门禁 */
import { describe, expect, it } from "vitest";
import { GameKernel, GAME_DEFAULTS } from "../src";
import { KernelError, type GameConfig } from "../src";
import { boot, cell, me, openGame } from "./helpers";

describe("配置五项 → 内核参数", () => {
  it("默认档：局长 15／血量 10／窗 30s／休息 10s／世界·即时", () => {
    const { kernel } = GameKernel.create({}, 0);
    expect(kernel.config).toEqual({ ...GAME_DEFAULTS });
    expect(me(kernel).hp).toBe(10);
    expect(kernel.config.timerMode).toBe("world");
  });

  it("五项全改：逐一落位（血量进 PlayerState、窗开窗时限、局长收口、休息间隔）", () => {
    const k = boot({ turnCap: 8, maxHp: 12, windowMs: 20_000, restMs: 0, timerMode: "turn" });
    expect(k.config.turnCap).toBe(8);
    expect(k.config.maxHp).toBe(12);
    expect(k.config.windowMs).toBe(20_000);
    expect(k.config.restMs).toBe(0);
    expect(k.config.timerMode).toBe("turn");
    expect(k.state.players.every((p) => p.hp === 12)).toBe(true);
  });

  it("选段：chooseSecret 后第一窗时限 = 该刻 + 配置窗", () => {
    const k = boot({ windowMs: 45_000 });
    expect(k.state.windowDeadline).toBe(45_000); // chooseSecret 在 now=0
  });
});

describe("配置域校验（玩家配置出界即拒；dev 通道放行模拟参数）", () => {
  const bad: Array<[string, Partial<GameConfig>]> = [
    ["局长过短", { turnCap: 4 }],
    ["局长过长", { turnCap: 31 }],
    ["血量过小", { maxHp: 4 }],
    ["血量过大", { maxHp: 21 }],
    ["窗过短", { windowMs: 9_000 }],
    ["窗过长", { windowMs: 91_000 }],
    ["休息超时", { restMs: 21_000 }],
  ];
  for (const [name, over] of bad) {
    it(name, () => {
      expect(() => GameKernel.create(over, 0)).toThrow(KernelError);
    });
  }

  it("已知计时值收口；未知值拒", () => {
    expect(GameKernel.create({ timerMode: "turn" }, 0).kernel.config.timerMode).toBe("turn");
    expect(() => GameKernel.create({ timerMode: "zombie" as never }, 0)).toThrow(KernelError);
  });

  it("allowDev 测试通道放行短窗短局（window.test 模拟口径）", () => {
    const k = boot({ turnCap: 2, windowMs: 100, restMs: 50 });
    expect(k.config.windowMs).toBe(100);
  });
});

describe("局中冻结", () => {
  it("config 冻结：局中改参直接抛（结算制纪律）", () => {
    const k = boot({});
    expect(() => {
      (k.config as { turnCap: number }).turnCap = 99;
    }).toThrow();
  });

  it("传入对象自成一体：壳层后续改入参不影响内核", () => {
    const cfg: Partial<GameConfig> = { turnCap: 7 };
    const { kernel } = GameKernel.create(cfg, 0);
    openGame(kernel);
    cfg.turnCap = 30;
    expect(kernel.config.turnCap).toBe(7);
  });
});

describe("drafting 抽牌门禁", () => {
  it("create 即 drafting：不掷不确（roll/confirm 一律拒）", () => {
    const { kernel } = GameKernel.create({ allowDev: true }, 0);
    expect(kernel.state.phase).toBe("drafting");
    expect(() => kernel.apply({ type: "roll", pid: 0 }, 0)).toThrow(KernelError);
    expect(() => kernel.apply({ type: "confirm", pid: 0 }, 0)).toThrow(KernelError);
    expect(kernel.tick(99_999)).toEqual([]); // 抽牌期时钟不推进
    expect(kernel.state.windowDeadline).toBe(0);
  });

  it("chooseSecret：pick 落定 + secretPicked 事实 + 开第一窗", () => {
    const { kernel } = GameKernel.create({ allowDev: true, windowMs: 6_000 }, 0);
    const facts = kernel.apply({ type: "chooseSecret", pid: 0, pick: 1 }, 0);
    expect(kernel.state.players[0]!.secretPick).toBe(1);
    expect(facts.some((f) => f.type === "secretPicked" && f.pid === 0)).toBe(true);
    expect(kernel.state.phase).toBe("acting");
    expect(kernel.state.windowDeadline).toBe(6_000);
    expect(kernel.state.messages.some((m) => m.text.includes("选定暗牌目标"))).toBe(true);
  });

  it("门禁细则：bot 拒人代选、二次选择拒、下标越界拒", () => {
    const { kernel } = GameKernel.create({ allowDev: true }, 0);
    expect(() => kernel.apply({ type: "chooseSecret", pid: 1, pick: 0 }, 0)).toThrow(KernelError);
    expect(kernel.apply({ type: "chooseSecret", pid: 0, pick: 0 }, 0)).toBeTruthy();
    expect(() => kernel.apply({ type: "chooseSecret", pid: 0, pick: 0 }, 0)).toThrow(KernelError);
    expect(() => kernel.apply({ type: "chooseSecret", pid: 0, pick: 2 }, 0)).toThrow(KernelError);
  });
});

describe("开局人数与出生位", () => {
  it("2 人局：对望落座（北主办园前、南客 12,17）", () => {
    const { kernel } = GameKernel.create(
      { allowDev: true },
      0,
      [{ name: "你", isBot: false }, { name: "小黄", isBot: true, roleId: "tough" }],
    );
    openGame(kernel);
    expect(kernel.state.players).toHaveLength(2);
    expect(kernel.state.players[0]!.spawnCell).toBe(cell(6, 0));
    expect(kernel.state.players[1]!.spawnCell).toBe(cell(12, 17));
  });

  it("8 人局可开局（1 真人 + 7 假人）；9 人拒", () => {
    const defs = [
      { name: "你", isBot: false },
      ...Array.from({ length: 7 }, (_, i) => ({ name: `假${i}`, isBot: true })),
    ];
    const { kernel } = GameKernel.create({ allowDev: true }, 0, defs);
    openGame(kernel);
    expect(kernel.state.players).toHaveLength(8);
    const spawns = new Set(kernel.state.players.map((p) => p.spawnCell));
    expect(spawns.size).toBe(8);
    expect(() => GameKernel.create({ allowDev: true }, 0, [...defs, { name: "多", isBot: true }])).toThrow(
      KernelError,
    );
  });
});
