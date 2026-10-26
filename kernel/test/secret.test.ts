/** 暗牌目标抽 2 选 1（#18 T2 / 数值表表四）：抽 2 不同、真人自选、假人代抽、战报保密 */
import { describe, expect, it } from "vitest";
import { GAME_DEFAULTS, SECRET_GOALS, GameKernel, type PlayerDef } from "../src";
import { KernelError } from "../src";
import { boot, openGame } from "./helpers";

const defs = (bots: number): PlayerDef[] => [
  { name: "你", isBot: false },
  ...Array.from({ length: bots }, (_, i) => ({ name: `假${i}`, isBot: true, roleId: "light" as const })),
];

describe("抽 2 选 1：抽取面", () => {
  it("每人恰好两条且必不相同；全部落在表四 10 条池", () => {
    const k = boot({}, 0);
    const pool = new Set(SECRET_GOALS.map((g) => g.no));
    for (const p of k.state.players) {
      const [a, b] = p.secretOptions;
      expect(pool.has(a)).toBe(true);
      expect(pool.has(b)).toBe(true);
      expect(b !== a).toBe(true);
    }
  });

  it("种子化：同种子抽到同一对（可复现随机流；M2 快照恢复语义）", () => {
    const mk = () => GameKernel.create({ seed: 20261016, allowDev: true }, 0, defs(3)).kernel;
    const a = mk();
    const b = mk();
    expect(a.state.players.map((p) => p.secretOptions)).toEqual(b.state.players.map((p) => p.secretOptions));
  });
});

describe("真人自选 vs 假人代抽", () => {
  it("真人未选=null；假人开局已定（0|1）；战报只见过场不展开内容", () => {
    const k = GameKernel.create({ allowDev: true }, 0, defs(3)).kernel; // 裸 create：真人尚未选
    expect(k.state.players[0]!.secretPick).toBeNull();
    for (const p of k.state.players.slice(1)) {
      expect(p.secretPick === 0 || p.secretPick === 1).toBe(true);
    }
    const goals = SECRET_GOALS.map((g) => g.title);
    for (const m of k.state.messages) {
      expect(goals.some((t) => m.text.includes(t))).toBe(false); // 任何人名/目标名都不进战报
    }
  });

  it("选下标与 goal 对应落定后不再改", () => {
    const k = GameKernel.create({ allowDev: true }, 0, defs(3)).kernel;
    const want = k.state.players[0]!.secretOptions[1]!;
    openGame(k, 1);
    const p = k.state.players[0]!;
    const pick = p.secretPick;
    expect(pick).toBe(1);
    expect(p.secretOptions[pick!]).toBe(want);
    expect(k.state.phase).toBe("acting");
  });
});

describe("多真人抽暗牌窗口时序（M2 T5c 前置，#42 报出）：全员选定才开窗", () => {
  /** 双真人局：M2 联机房间每个真人都抽暗牌（规格 story 9）——M1 单真人期「选完即开窗」遗留死锁 */
  const dualDefs = (): PlayerDef[] => [
    { name: "你", isBot: false },
    { name: "伴", isBot: false },
    { name: "假0", isBot: true, roleId: "light" as const },
  ];

  it("第一真人选完窗口不开张（仍 drafting／无 windowStart／turn 仍 1），第二真人才开第一窗", () => {
    const created = GameKernel.create({ allowDev: true }, 0, dualDefs());
    const k = created.kernel;
    expect(k.state.phase).toBe("drafting");
    expect(k.state.turn).toBe(1);
    expect(k.state.players.filter((p) => !p.isBot)).toHaveLength(2);
    expect(k.state.players[0]!.secretPick).toBeNull();
    expect(k.state.players[1]!.secretPick).toBeNull();
    expect(created.facts.some((f) => f.type === "windowStart")).toBe(false);

    // 第一真人选定：secretPicked 照收，但不开张——drafting 期无时限，tick 不催不替掷
    const fx1 = k.apply({ type: "chooseSecret", pid: 0, pick: 0 }, 0);
    expect(fx1.some((f) => f.type === "secretPicked" && f.pid === 0)).toBe(true);
    expect(fx1.some((f) => f.type === "windowStart")).toBe(false);
    expect(k.state.phase).toBe("drafting");
    expect(k.state.turn).toBe(1);
    expect(k.state.windowDeadline).toBe(0);
    expect(k.tick(9_000)).toEqual([]);

    // 第二真人（最后一拍）：同拍既收 secretPicked 也开第一窗
    const fx2 = k.apply({ type: "chooseSecret", pid: 1, pick: 1 }, 0);
    expect(fx2.some((f) => f.type === "secretPicked" && f.pid === 1)).toBe(true);
    const ws = fx2.find((f) => f.type === "windowStart");
    if (!ws || ws.type !== "windowStart") throw new Error("最后一拍未见 windowStart 事实");
    expect(ws.turn).toBe(1);
    expect(ws.deadline).toBe(GAME_DEFAULTS.windowMs);
    expect(k.state.phase).toBe("acting");
    expect(k.state.turn).toBe(1);
    expect(k.state.windowDeadline).toBe(GAME_DEFAULTS.windowMs);
  });

  it("最后一拍开的第一窗=旧单真人语义等价：同 seed 观开窗后三态（不赌随机值）", () => {
    const single = (): PlayerDef[] => [{ name: "你", isBot: false }, { name: "假0", isBot: true, roleId: "light" as const }];
    const now = 1234;
    const ref = GameKernel.create({ seed: 7, allowDev: true }, 0, single()).kernel;
    ref.apply({ type: "chooseSecret", pid: 0, pick: 0 }, now); // 单真人：唯一真人选完即开（M1 语义）
    const dual = GameKernel.create({ seed: 7, allowDev: true }, 0, dualDefs()).kernel;
    dual.apply({ type: "chooseSecret", pid: 0, pick: 0 }, now); // 早到人：只等，不耗时钟
    dual.apply({ type: "chooseSecret", pid: 1, pick: 1 }, now); // 末拍=开张（与 ref 同一 now 起）
    expect(ref.state.phase).toBe("acting");
    expect(dual.state.turn).toBe(ref.state.turn);
    expect(dual.state.turnActor).toBe(ref.state.turnActor);
    expect(dual.state.windowDeadline).toBe(ref.state.windowDeadline);
    expect(dual.state.restUntil).toBe(ref.state.restUntil);
    // 开窗重刷口径全员同位（尚未行动）：rolled/confirmed/skipped 全 false
    for (const p of [...ref.state.players, ...dual.state.players]) {
      expect([p.rolled, p.confirmed, p.skipped]).toEqual([false, false, false]);
    }
  });

  it("重复送已选定真人照旧拒（既有提示），另一真人仍可继续到全员齐", () => {
    const k = GameKernel.create({ allowDev: true }, 0, dualDefs()).kernel;
    k.apply({ type: "chooseSecret", pid: 0, pick: 0 }, 0);
    expect(() => k.apply({ type: "chooseSecret", pid: 0, pick: 1 }, 0)).toThrow(/已选定暗牌目标/);
    expect(k.state.phase).toBe("drafting"); // 拒绝不异常，等窗语义不受扰
    k.apply({ type: "chooseSecret", pid: 1, pick: 0 }, 0);
    expect(k.state.phase).toBe("acting");
  });

  it("M1 单真人口径逐党对照：唯一真人选完=全员齐，第一窗照旧当拍开张", () => {
    const k = GameKernel.create({ allowDev: true }, 0, defs(3)).kernel;
    const fx = k.apply({ type: "chooseSecret", pid: 0, pick: 0 }, 500);
    expect(fx.some((f) => f.type === "secretPicked" && f.pid === 0)).toBe(true);
    const ws = fx.find((f) => f.type === "windowStart");
    if (!ws || ws.type !== "windowStart") throw new Error("单真人首拍未见 windowStart 事实");
    expect(ws.deadline).toBe(500 + GAME_DEFAULTS.windowMs);
    expect(k.state.phase).toBe("acting");
  });
});
