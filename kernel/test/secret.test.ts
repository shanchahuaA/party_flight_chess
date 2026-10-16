/** 暗牌目标抽 2 选 1（#18 T2 / 数值表表四）：抽 2 不同、真人自选、假人代抽、战报保密 */
import { describe, expect, it } from "vitest";
import { SECRET_GOALS, GameKernel, type PlayerDef } from "../src";
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
