/**
 * 陷阱格 14 格全检定定制（#33 T5b，数值表 §5.4）：
 * - 配额守恒与分布对账（§5.4 生态配额逐格对上：平 4=扣血1/滑倒回退2/罚停1/弃卡1；雪 4=滑倒回退3×2/摔伤1/削面1；
 *   戈 6=扣血2/传送回出生格2/下回合禁道具1/赌运检定1）＋定案收口参数（DC 生态梯度 平8/雪10/戈12、轴分布、大失败加重一档）；
 * - 检定逃生三态逐类落账（通过=免伤／失败=吃负面／骰 1 大失败=加重一档）——种子搜定+同序重放；
 * - 负面通路：扣血=applyHpDelta 单入口（护身符照拦）、退格/罚停/弃卡/传送/削面/禁道具各走原语通道；
 * - 倒霉蛋「踩陷阱走格骰 10 无事」（表三 trapWalk10Safe 数据位消费）。
 * 确定性铁律：受难者钉到人间、假人 dev.setDead 退场（防替掷日程随机流让窗偷偷推进）；
 * 状态断言钉在单意图边界（landOn 一拍内 / roll 后即时），跨拍状态不回读。
 */
import { describe, expect, it } from "vitest";
import type { GameConfig, PlayerDef } from "../src";
import { BOARD, DC_TIERS, GameKernel } from "../src";
import { TRAP_DEFS, TRAP_PLANS } from "../src/data/traps";
import { dieOf, me, toNextWindow, tryGiveItem, walkOut } from "./helpers";

/** 陷阱格号 → 对应 def（TRAP_DEFS 按生态组序+格 id 序一一咬合；测试用格 id 辅记） */
const trapCellOf = (defId: string): number => {
  const t = TRAP_DEFS.find((x) => x.def.id === defId)!;
  return t.cellId;
};

const TRAP = {
  荆棘丛: trapCellOf("t01"), // 扣血 −1/−2
  青苔石阶: trapCellOf("t02"), // 退 2/退 3
  巡园捕兽夹: trapCellOf("t03"), // 罚停 1/2（力检）
  贼赃房: trapCellOf("t04"), // 弃 1/弃 2
  寒风削骨: trapCellOf("t08"), // 削面 1/2
  流沙坑: trapCellOf("t11"), // 传送/传送+罚停（力检）
  沙困行囊: trapCellOf("t13"), // 禁道具 1/2
  赌运石: trapCellOf("t14"), // 过=摸 2 / 败=−1 血
  灼热石板: trapCellOf("t09"), // 扣血 −1/−2（戈壁 DC12）
} as const;

/** 陷阱 1 步落点的预备位（邻居取 2 度格、来向=其另一邻）：掷 1 即踩格 */
const preForTrap = (cellId: number): { pos: number; from: number } => {
  const c = BOARD[cellId]!;
  if (c.type !== "T") throw new Error(`格 ${cellId} 不是陷阱格`);
  const q = c.links.find((l) => BOARD[l]!.links.length === 2);
  if (!q) throw new Error(`陷阱格 ${cellId} 没有可用的 2 度邻居`);
  return { pos: q, from: BOARD[q]!.links.find((l) => l !== cellId)! };
};

/** 搜种子：受难者 1 步踩上陷阱格，陷阱检定命中指定档（grade 词按战报裁）。dev.setPos+roll 顺序=重放同一段。 */
function bootTrapGrade(
  cellId: number,
  grade: "通过" | "失败" | "大失败",
  over: Partial<GameConfig> = {},
): { k: GameKernel; landAt: number; pre: { pos: number; from: number } } {
  const pre = preForTrap(cellId);
  for (let seed = 1; seed < 6000; seed++) {
    const k = GameKernel.create({ allowDev: true, windowMs: 60_000, restMs: 0, seed, ...over }, 0).kernel;
    k.apply({ type: "chooseSecret", pid: 0, pick: 0 }, 0);
    k.apply({ type: "dev.setPos", pid: 0, pos: pre.pos, from: pre.from, net: 5 }, 0);    const fx = k.apply({ type: "roll", pid: 0 }, 0);
    if (dieOf(fx, 0) !== 1) continue;
    k.tick(140); // 骰 1 一步走完 → endWalk → 踩上陷阱 → 检定结算整链
    if (!k.state.messages.some((m) => m.who === 0 && m.text.includes("踩上「"))) continue;
    if (k.state.messages.some((m) => m.who === 0 && m.text.includes(`—— ${grade}！`))) {
      return { k, landAt: 140, pre };
    }
  }
  throw new Error(`找不到陷阱格 ${cellId} 判定 ${grade} 的种子（1..6000）`);
}

/** 搜种子（带 1 步前手牌注入）：同 bootTrapGrade，但先发牌再掷（条件注入不耗随机流——切块序零漂移）；
 *  返回掷前的手牌快照（丢牌账对齐用）。 */
function bootTrapGradeWithHand(
  cellId: number,
  grade: "通过" | "失败" | "大失败",
  hand: readonly string[],
): { k: GameKernel; landAt: number; pre: { pos: number; from: number }; beforeHand: readonly string[] } {
  const pre = preForTrap(cellId);
  for (let seed = 1; seed < 6000; seed++) {
    const k = GameKernel.create({ allowDev: true, windowMs: 60_000, restMs: 0, seed }, 0).kernel;
    k.apply({ type: "chooseSecret", pid: 0, pick: 0 }, 0);
    k.apply({ type: "dev.setPos", pid: 0, pos: pre.pos, from: pre.from, net: 5 }, 0);
    if (!hand.every((id) => tryGiveItem(k, 0, id, 0))) continue; // 注入缺卡=换种子（账面要凑齐）
    const beforeHand = [...k.state.players[0]!.hand];
    const fx = k.apply({ type: "roll", pid: 0 }, 0);
    if (dieOf(fx, 0) !== 1) continue;
    k.tick(140);
    if (k.state.messages.some((m) => m.who === 0 && m.text.includes(`—— ${grade}！`))) {
      return { k, landAt: 140, pre, beforeHand };
    }
  }
  throw new Error(`找不到陷阱格 ${cellId}（手牌 ${hand.join(",")}）判定 ${grade} 的种子（1..6000）`);
}

/** 2 人局（受难者=倒霉蛋 p0）：本文件专用开局（defs 不同=随机流全不同，不能与默认 boots 混搜） */
const bootWoe = (seed: number): GameKernel => {
  const defs: PlayerDef[] = [
    { name: "你", isBot: false, roleId: "woe" },
    { name: "小黄", isBot: true },
  ];
  const { kernel } = GameKernel.create({ allowDev: true, windowMs: 60_000, restMs: 0, seed }, 0, defs);
  kernel.apply({ type: "chooseSecret", pid: 0, pick: 0 }, 0);
  return kernel;
};

/** 假人退场（不耗随机流）：替掷/日程随机流再也推不动窗 */
const restBots = (k: GameKernel, now: number): void => {
  for (const p of k.state.players) if (p.isBot) void k.apply({ type: "dev.setDead", pid: p.id }, now);
};

// tryGiveItem（条件注入道具）已收回公共 helpers（hp.test 同款用）

// ---------- 配额守恒与逐格分布（§5.4 对账；纯数据，零随机流） ----------

describe("陷阱 14 格：配额与效果分布 = 数值表 §5.4", () => {
  it("生态配额 平4/雪4/戈6，14 格与棋盘陷阱格一一配对（格 id 序）", () => {
    for (const [eco, want] of [["plain", 4], ["snow", 4], ["gobi", 6]] as const) {
      const cells = BOARD.filter((c) => c.type === "T" && c.zone === eco);
      expect(cells.length).toBe(want);
      expect(TRAP_PLANS[eco].length).toBe(want);
    }
    expect(TRAP_DEFS.length).toBe(14);
    const ids = TRAP_DEFS.map((t) => t.cellId);
    expect(new Set(ids).size).toBe(14); // 每格恰一枚 def（配对不过量）
    for (const t of TRAP_DEFS) {
      const ecoCells = BOARD.filter((c) => c.type === "T" && c.zone === t.eco).map((c) => c.id);
      expect(ecoCells).toContain(t.cellId);
    }
  });

  it("§5.4 效果分布逐格对上（失败分支原语类别 × 生态；赌运检定败支单独对账）", () => {
    // 赌运石=？位（过支带 drawItem）：其败支 hp(−1) 与普通扣血格分开计
    const gobiRegular = TRAP_PLANS.gobi.filter((d) => !d.check.onPass?.some((p) => p.type === "drawItem"));
    const count = (eco: "plain" | "snow" | "gobi", kind: string) =>
      TRAP_PLANS[eco].filter((d) => d.check.onFail?.some((p) => p.type === kind)).length;
    const countGobiNoGamble = (kind: string) =>
      gobiRegular.filter((d) => d.check.onFail?.some((p) => p.type === kind)).length;
    expect(count("plain", "hp")).toBe(1); // 扣血1
    expect(count("plain", "back")).toBe(1); // 滑倒回退（回退2）
    expect(count("plain", "skip")).toBe(1); // 罚停1
    expect(count("plain", "discard")).toBe(1); // 弃卡1
    expect(count("snow", "back")).toBe(2); // 滑倒回退3×2
    expect(count("snow", "hp")).toBe(1); // 摔伤1
    expect(count("snow", "rollMod")).toBe(1); // 削面1
    const gamble = TRAP_PLANS.gobi.filter((d) => d.check.onPass?.some((p) => p.type === "drawItem"));
    expect(gamble.length).toBe(1); // ？1=赌运检定（过=摸 2 张道具卡）
    expect(gamble[0]!.id).toBe("t14");
    expect(gamble[0]!.check.onFail).toEqual([{ type: "hp", v: -1 }]); // 败=扣 1 血（候选格 §5.4 拍板落地）
    expect(countGobiNoGamble("hp")).toBe(2); // 扣血2
    expect(countGobiNoGamble("teleport")).toBe(2); // 传送回出生格2
    expect(countGobiNoGamble("itemBan")).toBe(1); // 下回合禁道具1
  });

  it("DC 生态梯度定案：平全 8／雪全 10／戈全 12；档锚（易/中）与 DC 一致", () => {
    for (const [eco, dc] of [["plain", 8], ["snow", 10], ["gobi", 12]] as const) {
      for (const d of TRAP_PLANS[eco]) expect(d.check.dc).toBe(dc);
    }
    for (const d of TRAP_PLANS.plain) expect(d.check.tier === "easy" && DC_TIERS.easy === d.check.dc).toBe(true);
    for (const d of TRAP_PLANS.gobi) expect(d.check.tier === "mid" && DC_TIERS.mid === d.check.dc).toBe(true);
  });

  it("轴分布：默认敏检，个别改轴——力 2（捕兽夹/流沙坑）运 1（赌运石）敏 11", () => {
    const axes = TRAP_DEFS.map((t) => t.def.check.axis);
    const count = (a: string) => axes.filter((x) => x === a).length;
    expect(count("agile")).toBe(11);
    expect(count("might")).toBe(2);
    expect(count("luck")).toBe(1);
  });

  it("大失败加重一档（单格自带）：每格 onCritFail 真实存在；抽样钉账（扣血 −1→−2、传送→传送+罚停）", () => {
    for (const t of TRAP_DEFS) expect(t.def.check.onCritFail?.length).toBeGreaterThan(0);
    expect(TRAP_PLANS.plain.find((d) => d.id === "t01")!.check.onFail).toEqual([{ type: "hp", v: -1 }]);
    expect(TRAP_PLANS.plain.find((d) => d.id === "t01")!.check.onCritFail).toEqual([{ type: "hp", v: -2 }]);
    expect(TRAP_PLANS.gobi.find((d) => d.id === "t11")!.check.onFail).toEqual([{ type: "teleport" }]);
    expect(TRAP_PLANS.gobi.find((d) => d.id === "t11")!.check.onCritFail).toEqual([{ type: "teleport" }, { type: "skip", v: 1 }]);
  });
});

// ---------- 检定逃生三态（种子搜定 + 同序重放；状态断言都钉在 landOn 一拍内） ----------

describe("三态逐类（踩上即检定，通过=免伤）", () => {
  it("荆棘丛（扣血）：通过免伤／失败 −1 血／大失败 −2 血", () => {
    const a = bootTrapGrade(TRAP.荆棘丛, "通过");
    expect(a.k.state.players[0]!.hp).toBe(a.k.config.maxHp);
    expect(a.k.state.messages.some((m) => m.who === 0 && m.text.includes("踩上「荆棘丛」"))).toBe(true);
    const b = bootTrapGrade(TRAP.荆棘丛, "失败");
    expect(b.k.state.players[0]!.hp).toBe(b.k.config.maxHp - 1);
    expect(b.k.state.messages.some((m) => m.who === 0 && m.text.includes("扣 1 血"))).toBe(true);
    const c = bootTrapGrade(TRAP.荆棘丛, "大失败");
    expect(c.k.state.players[0]!.hp).toBe(c.k.config.maxHp - 2);
    expect(c.k.state.messages.some((m) => m.who === 0 && m.text.includes("扣 2 血"))).toBe(true);
  });

  it("灼热石板（戈壁扣血 DC12）：失败 −1 血、检定行 vs DC12 逐格识别", () => {
    const b = bootTrapGrade(TRAP.灼热石板, "失败");
    expect(b.k.state.players[0]!.hp).toBe(b.k.config.maxHp - 1);
    expect(b.k.state.messages.some((m) => m.who === 0 && m.text.includes("踩上「灼热石板」"))).toBe(true);
    expect(b.k.state.messages.some((m) => m.who === 0 && m.text.includes("vs DC12"))).toBe(true);
  });

  it("寒风削骨（削面）：失败=下次走格骰削面 1；大失败=削面 2（rollMod cut 批）", () => {
    const f = bootTrapGrade(TRAP.寒风削骨, "失败");
    expect(f.k.state.players[0]!.rollMods).toEqual([{ mode: "cut", v: 1, src: "寒风削骨" }]);
    const cf = bootTrapGrade(TRAP.寒风削骨, "大失败");
    expect(cf.k.state.players[0]!.rollMods).toEqual([{ mode: "cut", v: 2, src: "寒风削骨" }]);
  });

  it("流沙坑（传送）：失败=传送回出生格（净步保留+来路清空）；大失败=传送+罚停 1", () => {
    const f = bootTrapGrade(TRAP.流沙坑, "失败");
    const p = f.k.state.players[0]!;
    expect(p.pos).toBe(p.spawnCell); // 身在自家门前
    expect(p.from).toBeNull();
    expect(p.trail).toEqual([]);
    expect(p.net).toBe(6); // 净步保留=偷天换日同口径：踩格那步的 +1 不被传送折损（5 进坑 → 6 回门）
    expect(f.k.state.messages.some((m) => m.who === 0 && m.text.includes("被卷回了自家门前"))).toBe(true);
    const cf = bootTrapGrade(TRAP.流沙坑, "大失败");
    expect(cf.k.state.players[0]!.pos).toBe(cf.k.state.players[0]!.spawnCell);
    expect(cf.k.state.players[0]!.stun).toBe(1); // 加重一档：受惊罚停
  });

  it("贼赃房（弃卡）：失败=随机薅 1 张进弃牌堆（单池守恒）；手头无卡=落空出声；大失败=薅 2 张", () => {
    // 有牌：随机薅走（条件注入不耗随机流；掷前快照对账「薅走的正是手里有的」）
    const b = bootTrapGradeWithHand(TRAP.贼赃房, "失败", ["i01", "i05"]);
    for (const id of b.beforeHand) {
      if (b.k.state.players[0]!.hand.includes(id)) {
        // 留在手里
      } else {
        expect(b.k.state.itemDiscard).toContain(id); // 丢的那张进了弃牌堆（单池守恒）
      }
    }
    expect(b.k.state.players[0]!.hand.length).toBe(b.beforeHand.length - 1);
    expect(b.k.state.messages.some((m) => m.who === 0 && m.text.includes("被薅走 1 张"))).toBe(true);
    expect(b.k.state.players[0]!.hp).toBe(b.k.config.maxHp); // 弃卡格不伤血
    // 大失败：加重一档=薅走 2 张
    const c = bootTrapGradeWithHand(TRAP.贼赃房, "大失败", ["i01", "i05", "i04"]);
    expect(c.k.state.messages.some((m) => m.who === 0 && m.text.includes("被薅走 2 张"))).toBe(true);
    expect(c.k.state.players[0]!.hand.length).toBe(c.beforeHand.length - 2);
    for (const id of c.beforeHand) {
      if (!c.k.state.players[0]!.hand.includes(id)) expect(c.k.state.itemDiscard).toContain(id);
    }

    // 手头无卡：轻装开手那 1 张被事前抽干（截流手术）——负面落空出声，不暗示免灾
    {
      const pre = preForTrap(TRAP.贼赃房);
      for (let seed = 1; seed < 6000; seed++) {
        const k = GameKernel.create({ allowDev: true, windowMs: 60_000, restMs: 0, seed }, 0).kernel;
        k.apply({ type: "chooseSecret", pid: 0, pick: 0 }, 0);
        k.apply({ type: "dev.setPos", pid: 0, pos: pre.pos, from: pre.from, net: 5 }, 0);
        const fx = k.apply({ type: "roll", pid: 0 }, 0);
        if (dieOf(fx, 0) !== 1) continue;
        // 事前工序：trap 判定发生在 landOn 一拍内——掷后、踩前清袋（同帧截流，只模拟「无牌」世界线）
        k.state.players[0]!.hand = [];
        k.state.itemDiscard = [];
        k.tick(140);
        if (!k.state.messages.some((m) => m.who === 0 && m.text.includes("手头无卡可弃"))) continue;
        expect(k.state.players[0]!.hp).toBe(k.config.maxHp);
        return;
      }
      throw new Error("找不到贼赃房无卡可弃种子");
    }
  });

  it("沙困行囊（禁道具）：失败=下回合禁道具（当窗可打）、开窗消费、随窗解除；大失败=连禁 2 回合", () => {
    const f = bootTrapGrade(TRAP.沙困行囊, "失败");
    const k = f.k;
    expect(me(k).itemBan).toBe(1);
    expect(k.state.messages.some((m) => m.who === 0 && m.text.includes("行囊灌满沙——接下来 1 个回合"))).toBe(true);
    const w1card = tryGiveItem(k, 0, "i04", f.landAt) ? "i04" : me(k).hand[0]!; // 当窗照样能打（下回合才生效）
    const before = me(k).hand.length;
    void k.apply({ type: "playItem", pid: 0, cardId: w1card }, f.landAt);
    expect(me(k).hand.length).toBe(before - 1);
    restBots(k, f.landAt);
    void k.apply({ type: "confirm", pid: 0 }, f.landAt + 1_000); // 收窗 → 开窗时消费禁道具（restMs=0 开窗连在确认后）
    expect(me(k).itemBanned).toBe(true);
    expect(me(k).itemBan).toBe(0);
    const w2card = (["i05", "i03", "i06"] as const).find((id) => tryGiveItem(k, 0, id, f.landAt + 1_100))!; // 注入失败换下一张（牌池有量）
    expect(() => k.apply({ type: "playItem", pid: 0, cardId: w2card }, f.landAt + 1_100)).toThrow(/禁道具/);
    const now2 = toNextWindow(k, f.landAt + 1_200, 60_000, 0); // 推进到窗 3：随窗自然解除
    expect(me(k).itemBanned).toBe(false);
    void k.apply({ type: "playItem", pid: 0, cardId: w2card }, now2);
    expect(me(k).hand.length).toBe(before - 1); // 解除后照常打出：开手账 −1 落袋（w1/w2 已打、w2 在窗 2 注入先在袋中）

    const cf = bootTrapGrade(TRAP.沙困行囊, "大失败");
    const k2 = cf.k;
    expect(me(k2).itemBan).toBe(2);
    expect(k2.state.messages.some((m) => m.who === 0 && m.text.includes("接下来 2 个回合"))).toBe(true);
    restBots(k2, cf.landAt);
    void k2.apply({ type: "confirm", pid: 0 }, cf.landAt + 1_000); // → 窗 2：吃掉第 1 个
    expect(me(k2).itemBanned).toBe(true);
    expect(me(k2).itemBan).toBe(1);
    k2.tick(cf.landAt + 61_500); // 窗 2 截止一拍收口 → 替掷替确认 → 窗 3 开窗吃第 2 个
    expect(me(k2).itemBanned).toBe(true);
    expect(me(k2).itemBan).toBe(0);
  });

  it("赌运石（戈壁？位定案=赌运检定 DC12 运）：过=摸 2 张道具卡／败=扣 1 血／大失败=扣 2 血——三态全对", () => {
    const a = bootTrapGrade(TRAP.赌运石, "通过");
    expect(a.k.state.players[0]!.hand.length).toBe(3); // 轻装开手 +1 → 赌赢 +2
    expect(a.k.state.messages.some((m) => m.who === 0 && m.text.includes("摸到 2 张道具卡"))).toBe(true);
    const b = bootTrapGrade(TRAP.赌运石, "失败");
    expect(b.k.state.players[0]!.hp).toBe(b.k.config.maxHp - 1);
    const c = bootTrapGrade(TRAP.赌运石, "大失败");
    expect(c.k.state.players[0]!.hp).toBe(c.k.config.maxHp - 2); // 赌输了还摔：加重一档
  });

  it("青苔石阶（滑倒回退）：失败=沿来路栈退 2 格（退格走=T1 原路归返）", () => {
    const f = bootTrapGrade(TRAP.青苔石阶, "失败");
    const w = f.k.state.players[0]!.walk;
    expect(w?.remaining).toBe(-2); // 滑倒那笔挂上退格走
    walkOut(f.k, f.landAt);
    expect(f.k.state.players[0]!.pos).toBe(f.pre.pos); // 原路退回预备位
    expect(f.k.state.messages.some((m) => m.who === 0 && m.text.includes("退 2 格"))).toBe(true);
  });

  it("巡园捕兽夹（力检）：失败=罚停 1 回合挂账；大失败=罚停 2（加重一档）", () => {
    const f = bootTrapGrade(TRAP.巡园捕兽夹, "失败");
    expect(f.k.state.players[0]!.stun).toBe(1);
    expect(f.k.state.messages.some((m) => m.who === 0 && m.text.includes("vs DC8"))).toBe(true); // 同 DC 档位逐格识别
    const cf = bootTrapGrade(TRAP.巡园捕兽夹, "大失败");
    expect(cf.k.state.players[0]!.stun).toBe(2);
  });
});

// ---------- 通路对账：护身符拦陷阱扣血（T5a 血量通道全渠道同吃） ----------

describe("扣血通路走 applyHpDelta 单入口（#23 T5a 收账）", () => {
  it("护身符挡陷阱扣血：失败支的 −1 血被符拦下（触发即消耗），不旁路改 hp", () => {
    const pre = preForTrap(TRAP.荆棘丛);
    let hit: GameKernel | null = null;
    for (let seed = 1; seed < 6500; seed++) {
      const kl = GameKernel.create({ allowDev: true, windowMs: 60_000, restMs: 0, seed }, 0).kernel;
      kl.apply({ type: "chooseSecret", pid: 0, pick: 0 }, 0);
      kl.apply({ type: "dev.setPos", pid: 0, pos: pre.pos, from: pre.from, net: 5 }, 0);
      if (!tryGiveItem(kl, 0, "i14", 0)) continue; // 护身符可能在假人手里——换种子
      void kl.apply({ type: "playItem", pid: 0, cardId: "i14" }, 0); // 先符：免疫下一次任何伤害（T5a 通道序）
      const fx = kl.apply({ type: "roll", pid: 0 }, 0);
      if (dieOf(fx, 0) !== 1) continue;
      kl.tick(140);
      if (!kl.state.messages.some((m) => m.who === 0 && m.text.includes("—— 失败！") && m.text.includes("vs DC"))) continue;
      hit = kl;
      break;
    }
    const k = hit ?? (() => { throw new Error("找不到荆棘丛失败+护身符种子"); })();
    expect(k.state.players[0]!.hp).toBe(k.config.maxHp); // 符拦下扣血：血满如初
    expect(k.state.players[0]!.talisman).toBe(0); // 触发即消耗
    expect(k.state.messages.some((m) => m.who === 0 && m.text.includes("护身符闪金光"))).toBe(true);
  });
});

// ---------- 倒霉蛋求生直觉（表三 trapWalk10Safe：走格骰 10 整格无事） ----------

describe("倒霉蛋：踩陷阱走格骰掷出 10 则无事", () => {
  it("骰 10 踩陷阱：不掷检定、整格无事（一行播报；不触发任何负面）", () => {
    const pre = { pos: 10, from: 11, net: 5 }; // (10,0)向西——10 格走廊尽头即 (0,0)=荆棘丛（2 度格全走，无需选路）
    for (let seed = 1; seed < 6000; seed++) {
      const k = bootWoe(seed);
      k.apply({ type: "dev.setPos", pid: 0, pos: pre.pos, from: pre.from, net: 5 }, 0);
      const fx = k.apply({ type: "roll", pid: 0 }, 0);
      if (dieOf(fx, 0) !== 10) continue;
      walkOut(k, 0);
      expect(k.state.players[0]!.pos).toBe(0);
      expect(k.state.players[0]!.hp).toBe(k.config.maxHp);
      expect(k.state.players[0]!.stun).toBe(0);
      expect(k.state.players[0]!.rollMods).toEqual([]);
      expect(k.state.messages.some((m) => m.who === 0 && m.text.includes("走格骰掷出 10"))).toBe(true);
      expect(k.state.messages.some((m) => m.who === 0 && m.text.includes("vs DC"))).toBe(false); // 一检不发
      return;
    }
    throw new Error("找不到倒霉蛋骰 10 的种子");
  });

  it("对照：倒霉蛋骰非 10 踩陷阱照样吃检定（个人项不是万能免死牌）", () => {
    const pre = preForTrap(TRAP.荆棘丛);
    for (let seed = 1; seed < 6000; seed++) {
      const k = bootWoe(seed);
      k.apply({ type: "dev.setPos", pid: 0, pos: pre.pos, from: pre.from, net: 5 }, 0);
      const fx = k.apply({ type: "roll", pid: 0 }, 0);
      if (dieOf(fx, 0) !== 1) continue;
      k.tick(140);
      expect(k.state.messages.some((m) => m.who === 0 && m.text.includes("踩上「荆棘丛」"))).toBe(true);
      expect(k.state.messages.some((m) => m.who === 0 && m.text.includes("vs DC8"))).toBe(true); // 检定照行
      return;
    }
    throw new Error("找不到倒霉蛋非 10 的种子");
  });
});
