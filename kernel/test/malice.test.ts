/**
 * 世界恶意（#24 T6a，数值表 §5.5）：
 * - 管道节奏：每 N 世界回合一波（2/3/5 档与 off 关断）；世界层不打断操作——走格跨窗的玩家
 *   在波结算时步数纹丝不动、波窗内照常走完落格。
 * - 三型：🪵 木头=落点提前定（3 格预警、全主网可落格）下一世界回合砸落、落点可测（砸落=挂账一致）
 *   与预警窗空砸「上空无人」；🪨 滚石=直线街段随机切 10 格一次滚完，主干道活人被追上敏检 DC12
 *   三态（过=侧身一闪 hp 不动／败=扣血）；🕳 塌陷=种子 BFS 6 格（环岛/出生格不裂）挂账 2 世界回合、
 *   裂开即咬＋踩进（landOn）各判一咬、到期复原出声。
 * - 强度档：同种子同随机流温和 −1／猛 −2（档位不吃随机流——A/B 对照成立）。
 * - 死了就死了：波结算对死人零声量（hp 定格 0、不再被咬）。
 *
 * 确定性铁律（照 traps.test 口径）：搜种子定波型/判定档；人间位置 dev.setPos 钉死、假人波前
 * dev.setDead 清场；windowMs:0 快进局=一 tick 一回合（autoFillAndClose 替掷收口）。
 * 状态断言钉在单 tick 边界；跨拍状态不回读。
 */
import { describe, expect, it } from "vitest";
import { BOARD, GameKernel, MAIN_PLAYABLE_CELLS, STREET_RUNS, type GameConfig } from "../src";
import { advanceWorldTurns, boot, bootWithDie, cell, dieOf, toNextWindow, walkOut } from "./helpers";

type WaveKeyword = "大木头悬空" | "塌坡滚石" | "地面蛋壳般裂开";
const WAVE_MARKERS: readonly WaveKeyword[] = ["大木头悬空", "塌坡滚石", "地面蛋壳般裂开"];

const PINNED = (): number => cell(0, 13); // 外环西侧主干道格（塌陷 BFS 的高频落点区；非环岛非出生格）——搜与复放用同一钉位=同流对照

/** 建一局（windowMs=0 快进）直达 turn=every 波窗：chooseSecret→可选钉位人间→快进（搜与复放共用同一链=同流对照） */
function bootWave(seed: number, opts: { every?: number; pin?: number | null } = {}): GameKernel {
  const every = opts.every ?? 3;
  const k = GameKernel.create({ allowDev: true, windowMs: 0, restMs: 0, seed, maliceEvery: every }, 0).kernel;
  k.apply({ type: "chooseSecret", pid: 0, pick: 0 }, 0);
  if (opts.pin != null) k.apply({ type: "dev.setPos", pid: 0, pos: opts.pin, from: null, net: 10 }, 0);
  advanceWorldTurns(k, every - 1);
  return k;
}

/** 搜种子：钉位后在首波（turn=every 回合窗）为指定型（按波内播报关键词判） */
function seedForFirstWave(keyword: WaveKeyword, every = 3, seeds = 8000): number {
  for (let seed = 1; seed < seeds; seed++) {
    const k = bootWave(seed, { every, pin: PINNED() });
    if (k.state.messages.some((m) => m.kind === "malice" && m.text.includes(keyword))) return seed;
  }
  throw new Error(`找不到首波=「${keyword}」的种子（1..${seeds}）`);
}

/** 按搜种子的同一时序重建到波窗（种子确定 → 波型重现） */
const bootPinnedAtWave = (seed: number, every = 3, over: Partial<GameConfig> = {}): GameKernel => {
  const k = boot({ ...over, seed, maliceEvery: every, windowMs: 0, restMs: 0 });
  k.apply({ type: "dev.setPos", pid: 0, pos: PINNED(), from: null, net: 10 }, 0);
  advanceWorldTurns(k, every - 1);
  return k;
};

describe("世界恶意 · 管道（#24 T6a 数值表 §5.5）", () => {
  it("节奏边界：every=2/3/5 在 N/2N/3N 世界回合一波；off 整局零波零扣血", () => {
    for (const ev of [2, 3, 5]) {
      const k = boot({ windowMs: 0, restMs: 0, maliceEvery: ev, turnCap: ev * 3 });
      advanceWorldTurns(k, ev * 3);
      const waveTurns = [...new Set(k.state.messages.filter((m) => m.text.includes("世界恶意第")).map((m) => m.turn))];
      expect(waveTurns).toEqual([ev, ev * 2, ev * 3]);
    }
    const off = boot({ windowMs: 0, restMs: 0, maliceLevel: "off", turnCap: 30 });
    advanceWorldTurns(off, 30);
    expect(off.state.messages.filter((m) => m.kind === "malice")).toHaveLength(0);
    expect(off.state.players.every((p) => p.hp === off.config.maxHp)).toBe(true);
  });

  it("三型均分池：同一局满 10 波（默认种子）三型各至少出现一次", () => {
    const k = boot({ windowMs: 0, restMs: 0, maliceEvery: 3, turnCap: 30 });
    advanceWorldTurns(k, 30);
    const text = k.state.messages.filter((m) => m.kind === "malice").map((m) => m.text).join("\n");
    for (const mark of WAVE_MARKERS) expect(text).toContain(mark);
  });

  it("世界层不打断操作：走格跨窗的玩家在波结算时保持余步不变、波窗内照常走完落格", () => {
    // 预备位=外环底边直线头（(12,19)→(12,20)→沿 y=20 直行零岔零出生格偏行）：10 步走完不撞选路条
    const k = bootWithDie(10, { pos: cell(12, 19), from: cell(12, 18), net: 5 }, { windowMs: 1000, restMs: 0, maliceEvery: 2, routeAskMs: 5 });
    k.apply({ type: "roll", pid: 0 }, 0); // 10 步 walk：10×140=1400ms 跨 1000ms 的窗——收窗时人在路上
    toNextWindow(k, 0, 1000, 0); // tick(1000)：已走 7 步→替确认收窗→开 turn2 波窗（walk 顺延）
    expect(k.state.players[0]!.walk?.remaining).toBe(3);
    expect(k.state.messages.some((m) => m.text.includes("世界恶意第 1 波"))).toBe(true); // turn2=every 点
    walkOut(k, 1000); // 波窗内把余下 3 步走完——落格照常结算
    expect(k.state.players[0]!.walk).toBeNull();
  });

  it("末回合让位：turn==turnCap 波点只出滚石（木头预警下一回合砸不出、塌陷复原也赶不上——即时赶路一条，死账零悬挂）", () => {
    for (let seed = 1; seed < 8000; seed++) {
      const k = GameKernel.create({ allowDev: true, windowMs: 0, restMs: 0, seed, maliceEvery: 3, turnCap: 3 }, 0).kernel;
      k.apply({ type: "chooseSecret", pid: 0, pick: 0 }, 0);
      advanceWorldTurns(k, 2); // turn=3=唯一波点（恰为 turnCap）
      if (!k.state.messages.some((m) => m.turn === 3 && m.kind === "malice" && m.text.includes("塌坡滚石"))) continue;
      expect(k.state.malice.timber).toBeNull();
      expect(k.state.malice.sink).toBeNull();
      expect(k.state.messages.some((m) => m.kind === "malice" && m.text.includes("大木头悬空"))).toBe(false);
      return;
    }
    throw new Error("找不到「末回合波=滚石」的种子（选型域恒滚石——首粒即中）");
  });
});

describe("世界恶意 · 木头（预警阴影→砸落）", () => {
  /** 搜木头波且钉位格不在落点里（假人已清场=「空砸」条件在铁序上成立）的种子 */
  function seedForTimberAwayFromPin(seeds = 8000): number {
    const pin = PINNED();
    for (let seed = 1; seed < seeds; seed++) {
      const k = GameKernel.create({ allowDev: true, windowMs: 0, restMs: 0, seed }, 0).kernel;
      k.apply({ type: "chooseSecret", pid: 0, pick: 0 }, 0);
      k.apply({ type: "dev.setPos", pid: 0, pos: pin, from: null, net: 10 }, 0);
      advanceWorldTurns(k, 2);
      if (!k.state.messages.some((m) => m.kind === "malice" && m.text.includes("大木头悬空"))) continue;
      if (k.state.malice.timber?.includes(pin)) continue;
      return seed;
    }
    throw new Error(`找不到「木头波且钉位不在落点」的种子（1..${seeds}）`);
  }

  it("落点提前定可测：波首挂 3 格预警（全主网可落格）；下回合被钉在落点上的人吃档位伤害、砸完清账", () => {
    const seed = seedForFirstWave("大木头悬空");
    const k = bootPinnedAtWave(seed);
    // 假人清场：世界层只可能咬到钉位的人间——账目全对人间
    k.apply({ type: "dev.setDead", pid: 1 }, 3);
    k.apply({ type: "dev.setDead", pid: 2 }, 3);
    k.apply({ type: "dev.setDead", pid: 3 }, 3);
    const cells = k.state.malice.timber!;
    expect(cells).toHaveLength(3);
    for (const id of cells) {
      const c = BOARD[id]!;
      expect(c.street).not.toBe("J");
      expect(c.spawnIndex).toBe(-1);
      expect(MAIN_PLAYABLE_CELLS.includes(id)).toBe(true);
    }
    // 预警窗内赖着不离开：钉到首个落点——下回合砸落吃温和档 −1
    k.apply({ type: "dev.setPos", pid: 0, pos: cells[0]!, from: null, net: 10 }, 3);
    const hpBefore = k.state.players[0]!.hp;
    advanceWorldTurns(k, 1); // turn=4：砸落
    expect(k.state.malice.timber).toBeNull();
    expect(k.state.players[0]!.hp).toBe(hpBefore - 1);
    expect(k.state.messages.some((m) => m.kind === "malice" && m.text.includes("大木头轰然砸中 你 所在的落点！"))).toBe(true);
    expect(k.state.messages.some((m) => m.kind === "malice" && m.text.includes("扣 1 血"))).toBe(true);
  });

  it("预警窗空砸：钉位不在落点且无人站着——砸落只出「上空无人」声、不进任何人的血账", () => {
    const seed = seedForTimberAwayFromPin();
    const k = bootPinnedAtWave(seed);
    k.apply({ type: "dev.setDead", pid: 1 }, 3);
    k.apply({ type: "dev.setDead", pid: 2 }, 3);
    k.apply({ type: "dev.setDead", pid: 3 }, 3);
    const cells = k.state.malice.timber!;
    expect(cells.includes(PINNED())).toBe(false);
    advanceWorldTurns(k, 1); // turn=4 砸落
    expect(k.state.malice.timber).toBeNull();
    expect(k.state.messages.some((m) => m.kind === "malice" && m.text.includes("还好上空无人"))).toBe(true);
    expect(k.state.messages.some((m) => m.text.includes("大木头轰然砸中"))).toBe(false);
    expect(k.state.players.filter((p) => !p.dead).every((p) => p.hp === k.config.maxHp)).toBe(true);
  });
});

describe("世界恶意 · 滚石（路段+被追上可躲）", () => {
  /** 搜「首波=滚石+路径命中钉位+**人间本人**判定落入指定档」的种子。gradeText：通过/大成功=闪开、失败/大失败=被咬 */
  function seedForRockGrade(grade: "通过" | "大成功" | "失败" | "大失败", seeds = 8000): number {
    const pin = PINNED();
    for (let seed = 1; seed < seeds; seed++) {
      const k = bootWave(seed, { pin });
      if (!k.state.messages.some((m) => m.kind === "malice" && m.text.includes("塌坡滚石"))) continue;
      if (!k.state.malice.rock?.includes(pin)) continue;
      if (!k.state.messages.some((m) => m.kind === "malice" && m.who === 0 && m.text.includes("敏检 d20") && m.text.includes(`DC12 —— ${grade}！`))) continue;
      return seed;
    }
    throw new Error(`找不到滚石判定=${grade} 的种子（1..${seeds}）`);
  }

  it("敏检 DC12 逃脱四档全账：通过/大成功=侧身一闪 hp 不动；失败/大失败=被追上扣血（温和 −1 · 大失败不吃加重）；路径=直线街段的连续 10 格", () => {
    for (const grade of ["通过", "大成功", "失败", "大失败"] as const) {
      const k = bootPinnedAtWave(seedForRockGrade(grade));
      const me = k.state.players[0]!;
      const dodge = grade === "通过" || grade === "大成功";
      expect(me.hp).toBe(dodge ? k.config.maxHp : k.config.maxHp - 1);
      const myLine = (needle: string): boolean =>
        k.state.messages.some((m) => m.kind === "malice" && m.who === 0 && m.text.includes(needle));
      expect(myLine("侧身一闪")).toBe(dodge);
      expect(myLine("没躲开，被滚石追上")).toBe(!dodge);
      if (!dodge) {
        expect(myLine("扣 1 血")).toBe(true);
      }
      // 路径落账：必须落在某条直线街段的连续 10 格窗口上
      const rock = k.state.malice.rock!;
      expect(rock).toHaveLength(10);
      expect(rockHostRun(rock)).toBeDefined();
      expect(k.state.messages.some((m) => m.kind === "malice" && m.text.includes("滚石滚过 10 格路段"))).toBe(true);
    }
  });
});

describe("世界恶意 · 塌陷（6 格×2 世界回合窗口）", () => {
  it("裂开即咬：波时站进裂开区者立即负伤（实现期定案：裂了人还站着是无声怪事）", () => {
    for (let seed = 1; seed < 8000; seed++) {
      const k = bootWave(seed, { pin: PINNED() });
      if (!k.state.messages.some((m) => m.kind === "malice" && m.text.includes("地面蛋壳般裂开"))) continue;
      const sink = k.state.malice.sink!;
      expect(sink.cells).toHaveLength(6);
      if (!sink.cells.includes(PINNED())) continue;
      expect(k.state.players[0]!.hp).toBe(k.config.maxHp - 1);
      expect(k.state.messages.some((m) => m.kind === "malice" && m.text.includes("踏进塌陷区"))).toBe(true);
      return;
    }
    throw new Error("找不到「首波=塌陷且裂开区命中钉位」的种子");
  });

  it("裂开区合规：6 格全排除环岛与出生格（出生位=开局/传送不动点，不塌不咬）", () => {
    for (let seed = 1; seed < 8000; seed++) {
      const k = bootWave(seed);
      const sink = k.state.malice.sink;
      if (!sink) continue;
      for (const id of sink.cells) {
        const c = BOARD[id]!;
        expect(c.street).not.toBe("J");
        expect(c.spawnIndex).toBe(-1);
      }
      return;
    }
    throw new Error("找不到塌陷波种子");
  });

  it("存续窗口：left 2→1→0 递减到期复原出声（周期域 ≥2 guarantees 旧区先复原后开波、不叠加）", () => {
    for (let seed = 1; seed < 8000; seed++) {
      const k = bootWave(seed);
      if (!k.state.messages.some((m) => m.kind === "malice" && m.text.includes("地面蛋壳般裂开"))) continue;
      expect(k.state.malice.sink!.left).toBe(2);
      advanceWorldTurns(k, 1); // turn=4：递减
      expect(k.state.malice.sink!.left).toBe(1);
      advanceWorldTurns(k, 1); // turn=5：归 0 复原
      expect(k.state.malice.sink).toBeNull();
      expect(k.state.messages.some((m) => m.text.includes("地面重新结好"))).toBe(true);
      return;
    }
    throw new Error("找不到塌陷波种子");
  });
});

describe("世界恶意 · 踩进与档位", () => {
  it("踩进扣血：存续窗内走 1 步 landOn 踩进裂开区（B 格）=「踏进塌陷区」扣 1 血", () => {
    for (let seed = 1; seed < 8000; seed++) {
      const k = bootWave(seed);
      if (!k.state.messages.some((m) => m.kind === "malice" && m.text.includes("地面蛋壳般裂开"))) continue;
      const sink = k.state.malice.sink!;
      // 挑 B 格（空格）做靶：landOn 只走塌陷账，无事件/陷阱/道具侧账掺和
      const target = sink.cells.map((id) => BOARD[id]!).find((c) => c.type === "B");
      if (!target) continue;
      // 安全邻：2 度格（另一邻作为来向——forwardOptions 只剩 target，die=1 直遂无岔无选路条）
      const pre = target.links.map((l) => BOARD[l]!).find((c) => c.street !== "J" && c.spawnIndex < 0 && c.links.length === 2);
      if (!pre) continue;
      const fromOfPre = pre.links.find((l) => l !== target.id)!;
      k.apply({ type: "dev.setPos", pid: 0, pos: pre.id, from: fromOfPre, net: 5 }, 3);
      const fx = k.apply({ type: "roll", pid: 0 }, 3);
      if (dieOf(fx, 0) !== 1) continue;
      const before = k.state.players[0]!.hp;
      k.tick(3 + 140 + 10); // 一步走完 → endWalk → 踏进塌陷（含余量）
      expect(k.state.messages.some((m) => m.kind === "malice" && m.text.includes("踏进塌陷区"))).toBe(true);
      expect(k.state.players[0]!.hp).toBe(before - 1);
      return;
    }
    throw new Error("找不到「踩进塌陷」的种子");
  });

  it("温和/猛档切换：同种子同随机流同波同落点，伤害账 −1/−2 切换干净", () => {
    const seed = seedForFirstWave("大木头悬空");
    const timberHpAfter = (level: "mild" | "fierce"): number => {
      // 同种子同钉位同波窗+波后钉到落点=同一场景；档位只换伤害数、不吃随机流——A/B 净对照
      const k = bootPinnedAtWave(seed, 3, { maliceLevel: level });
      k.apply({ type: "dev.setDead", pid: 1 }, 3);
      k.apply({ type: "dev.setDead", pid: 2 }, 3);
      k.apply({ type: "dev.setDead", pid: 3 }, 3);
      const cells = k.state.malice.timber!;
      k.apply({ type: "dev.setPos", pid: 0, pos: cells[0]!, from: null, net: 10 }, 3);
      advanceWorldTurns(k, 1);
      return k.state.players[0]!.hp;
    };
    expect(timberHpAfter("mild")).toBe(9); // 温和 −1
    expect(timberHpAfter("fierce")).toBe(8); // 猛 −2
  });
});

describe("世界恶意 · 死了就死了", () => {
  it("dev.setDead 后波结算对死人零声量：hp 定格 0、无任何命中行（不再被砸/咬/追上）", () => {
    const k = boot({ windowMs: 0, restMs: 0, maliceEvery: 2, turnCap: 10 });
    k.apply({ type: "dev.setDead", pid: 0 }, 0);
    advanceWorldTurns(k, 10);
    expect(k.state.players[0]!.dead).toBe(true);
    expect(k.state.players[0]!.hp).toBe(0);
    const meLines = k.state.messages.filter((m) => m.kind === "malice" && m.who === 0);
    expect(meLines).toHaveLength(0);
  });
});

/** 滚石路径归属对账：必须落在某条直线街段的连续 10 格窗口上 */
function rockHostRun(rock: readonly number[]) {
  return STREET_RUNS.find((r) => {
    for (let o = 0; o + 10 <= r.cells.length; o++) {
      if (r.cells.slice(o, o + 10).every((c, i) => c === rock[i])) return true;
    }
    return false;
  });
}
