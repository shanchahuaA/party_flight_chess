/** 角色明选与被动挂接（#18 T2 / 数值表表三）：三轴落位、被动数据位、可重复选、假人随机分派 */
import { describe, expect, it } from "vitest";
import { ROLES, roleDef, type RoleId } from "../src";
import { GameKernel, type PlayerDef } from "../src";
import { bootWithDie, me, openGame, toNextWindow } from "./helpers";

const defsFor = (roles: RoleId[]): PlayerDef[] =>
  roles.map((roleId, i) => ({ name: i === 0 ? "你" : `假${i}`, isBot: i === 0 ? false : true, roleId }));

describe("明选落位", () => {
  it("五角色三轴 6 点逐一进 PlayerState（表三数值）", () => {
    const five: RoleId[] = ["light", "tough", "boss", "woe", "beast"];
    const k = GameKernel.create({ allowDev: true }, 0, defsFor(five)).kernel;
    openGame(k);
    expect(k.state.players.map((p) => p.roleId)).toEqual(five);
    expect(k.state.players[0]!.axes).toEqual({ might: 1, agile: 3, luck: 2 });
    expect(k.state.players[1]!.axes).toEqual({ might: 4, agile: 1, luck: 1 });
    expect(k.state.players[2]!.axes).toEqual({ might: 1, agile: 1, luck: 4 });
    expect(k.state.players[3]!.axes).toEqual({ might: 2, agile: 1, luck: 3 });
    expect(k.state.players[4]!.axes).toEqual({ might: 3, agile: 2, luck: 1 });
    // 血量上限默认 10
    expect(k.state.players.every((p) => p.hp === 10)).toBe(true);
  });

  it("同角色可重复明选（互不干扰）", () => {
    const k = GameKernel.create({ allowDev: true }, 0, defsFor(["tough", "tough", "tough"])).kernel;
    openGame(k);
    expect(k.state.players.every((p) => p.roleId === "tough")).toBe(true);
    expect(k.state.players.every((p) => p.shields === 1)).toBe(true);
  });
});

describe("被动/特长数据位（行为消费点随 T4a/T5/T6b/T7 逐票上线）", () => {
  it("表三逐条可对应：特长与被动数据位齐备", () => {
    expect(roleDef("light").specialty).toBeNull();
    expect(roleDef("light").flags).toMatchObject({ wearHalved: true, handPlus: 1 });
    expect(roleDef("tough").specialty).toMatchObject({ kind: "adv2", axis: "might" });
    expect(roleDef("boss").specialty).toMatchObject({ kind: "adv2", axis: "luck" });
    expect(roleDef("woe").specialty).toMatchObject({ kind: "oneToCrit" });
    expect(roleDef("woe").flags).toMatchObject({ trapWalk10Safe: true });
    expect(roleDef("beast").specialty).toMatchObject({ kind: "flat", bonus: 4, scope: "dogFight" });
    expect(roleDef("boss").flags).toMatchObject({ customsTransferDraw: true });
    expect(roleDef("beast").flags).toMatchObject({ dogBiteDiscard: true });
    expect(ROLES).toHaveLength(5);
  });

  it("皮糙肉厚：免疫第一次扣血的盾挂 PlayerState（T5 消费），他人为 0", () => {
    const k = GameKernel.create(
      { allowDev: true },
      0,
      defsFor(["tough", "light"]), // 2 人菜单对望
    ).kernel;
    openGame(k);
    expect(me(k).shields).toBe(1);
    expect(k.state.players[1]!.shields).toBe(0);
  });

  it("假人角色由系统随机分派（同种子确定性；真人缺省=轻装上阵）", () => {
    const defs: PlayerDef[] = [
      { name: "你", isBot: false },
      { name: "小黄", isBot: true },
      { name: "小绿", isBot: true },
    ];
    const k1 = GameKernel.create({ seed: 7, allowDev: true }, 0, defs).kernel;
    const k2 = GameKernel.create({ seed: 7, allowDev: true }, 0, defs).kernel;
    expect(k1.state.players.slice(1).map((p) => p.roleId)).toEqual(
      k2.state.players.slice(1).map((p) => p.roleId),
    );
    expect(k1.state.players.slice(1).every((p) => ROLES.some((r) => r.id === p.roleId))).toBe(true);
    expect(k1.state.players[0]!.roleId).toBe("light");
  });
});

describe("抽牌期不占用窗", () => {
  it("chooseSecret 后立即开窗（drafting 期 clock 冻结，窗循环照旧）", () => {
    const k = bootWithDie(1, null, { windowMs: 10_000 });
    expect(k.state.phase).toBe("acting");
    void toNextWindow(k, 0, 10_000, 10_000);
    expect(k.state.phase).toBe("acting"); // 第二窗已开（局长未满）
  });
});
