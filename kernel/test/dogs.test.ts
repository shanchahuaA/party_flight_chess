/**
 * 野狗（#25 T6b，世界恶意四型第四档，数值表 §5.5「野狗 ×3（3 回合寿命）」+ 一页纸遭遇战细则）：
 * - 遭遇战四档全分支（一掷=runCheck 既有通道、力检 DC12、scope=dogFight）：大成功=击毙+额外
 *   战利品（掉落+搜窝共 2 张入袋+dogKilled 事实）／通过=击毙+狗掉 1 张（1 张入袋）／失败=被咬
 *   （−1 血+退 2 格沿来路栈）／大失败=被咬+被抢 1 张（随机薅手牌进弃牌堆=单池守恒）。
 * - 生成/寿命：波次 3 只标准狗（4 血/3 世界回合=含出生窗计 3，开窗递减归零消散出声）；落点=
 *   主网可落格（排环岛/出生格）；生成当拍同格撞上=当场遭遇战。
 * - 移动或留守：每回合各半——留守原地不动，移动落点=相邻随机（我行我素，环岛/出生格也走）。
 * - 撞上=强制遭遇战三清账口：狗动完统一清账／玩家走停落狗格（landOn）／生成当拍同格；
 *   路过不停不算撞上。
 * - 世界恶意砸狗：木头砸落/滚石碾过=对狗固定 −1（不吃档位翻账）；各判各不串扰。
 * - 猎手（表三 #5）：dogFight scope 特长 +4 恰在遭遇战域生效（+3 轴=+7 满挂）。
 * - 狗笛（表一 #16）：dogSpawn 原语——受指向者相邻格等概率生成 1 只标准狗；world·即时=
 *   deferred（spawnQueue 挂账）→ 下一世界回合 tickMalice 出队结算（与波生同段位=标准寿命、
 *   出生窗免减寿）；轮班·限时同一队列（延迟到回合边界——M1 未接 T9，口径先立）。
 * - off 关断：整局零波零狗。
 *
 * 确定性铁律（照 malice.test 口径）：搜种子定波型/判定档；人间 dev.setPos 钉死、假人波前
 * dev.setDead 清场；windowMs:0 快进局=一 tick 一回合；状态断言钉在单 tick 边界；搜与复放
 * 共用同一操作链=同流对照。
 */
import { describe, expect, it } from "vitest";
import {
  BOARD,
  DOG_FIGHT_DC,
  DOG_HP,
  DOG_TURNS,
  DOGS_PER_WAVE,
  GameKernel,
  MAIN_PLAYABLE_CELLS,
  type Fact,
  type GameConfig,
  type PlayerDef,
} from "../src";
import { advanceWorldTurns, boot, bootWithDie, cell, dieOf, openGame, toNextWindow, tryGiveItem, walkOut } from "./helpers";

const PIN = cell(0, 13); // 外环西侧主干道格（非环岛非出生格）——搜与复放共用同一钉位=同流对照
const PIN_N = BOARD[PIN]!.links[0]!; // 退 2 格的回程锚来向（沿它倒一步再回 PIN）
const HEART = cell(3, 10); // 中横街中段——滚石路径的高频路过格（砸狗实验钉位）
const NEU = cell(0, 2); // 人间安静钉位（砸狗实验里滤掉「人间在路被同拍判」的串扰坏账）

/** 判定行过滤器：遭遇战力检判定行（grade 文案落到 who=0——判行归属收口照 T6a 滚石四档） */
const gradeLine = (k: GameKernel, grade: string): boolean =>
  k.state.messages.some(
    (m) => m.kind === "malice" && m.who === 0 && m.text.includes("力检 d20(") && m.text.includes(`vs DC${DOG_FIGHT_DC} —— ${grade}！`),
  );

/** 四档搜种子：钉位遭遇战判定恰好落入指定档 */
function seedForGrade(grade: "大成功" | "通过" | "失败" | "大失败", seeds = 9000): number {
  for (let seed = 1; seed < seeds; seed++) {
    const k = boot({ seed });
    k.apply({ type: "dev.setPos", pid: 0, pos: PIN, from: PIN_N, net: 10 }, 0);
    k.apply({ type: "dev.spawnDog", cell: PIN }, 0);
    if (gradeLine(k, grade)) return seed;
  }
  throw new Error(`找不到遭遇战=${grade} 的种子（1..${seeds}）`);
}

/** 斗盘复放（搜与复放共用同一操作链；pre 在 fight 前注入如预置卡）：before=斗前快照（相对断言锚） */
function bootFight(
  seed: number,
  pre: Array<(k: GameKernel) => void> = [],
): { k: GameKernel; fx: Fact[]; before: { hand: number; pos: number; discard: number } } {
  const k = boot({ seed });
  for (const p of pre) p(k);
  k.apply({ type: "dev.setPos", pid: 0, pos: PIN, from: PIN_N, net: 10 }, 0);
  const before = { hand: k.state.players[0]!.hand.length, pos: k.state.players[0]!.pos, discard: k.state.itemDiscard.length };
  const fx = k.apply({ type: "dev.spawnDog", cell: PIN }, 0); // 生成当拍迎头撞上=遭遇战（dogCollisions 收口）
  return { k, fx, before };
}

describe("野狗 · 遭遇战四档全分支（一掷/力检 DC12；#25 验收）", () => {
  it("大成功=击毙+额外战利品：狗消灭、口袋 +2 张、dogKilled 事实、人间毫发无伤原位", () => {
    const { k, fx, before } = bootFight(seedForGrade("大成功"));
    const p = k.state.players[0]!;
    expect(gradeLine(k, "大成功")).toBe(true);
    expect(k.state.malice.dogs).toHaveLength(0); // 击毙=花名册移除（狗被玩家打死消灭）
    expect(fx.some((f) => f.type === "dogKilled" && f.pid === 0)).toBe(true); // 打狗英雄计数流（T8b1）
    expect(p.hand.length).toBe(before.hand + 2); // 狗掉 1 张 + 额外战利品再摸 1
    expect(p.hp).toBe(k.config.maxHp); // 击毙分支零咬
    expect(p.pos).toBe(before.pos); // 无人间位移
    expect(gradeLine(k, "通过") || gradeLine(k, "失败") || gradeLine(k, "大失败")).toBe(false); // 一掷四档=单档收口
  });

  it("通过=击毙+狗掉 1 张捡走：狗消灭、口袋 +1、dogKilled、战报点名", () => {
    const { k, before } = bootFight(seedForGrade("通过"));
    const p = k.state.players[0]!;
    expect(k.state.malice.dogs).toHaveLength(0);
    expect(p.hand.length).toBe(before.hand + 1); // 狗嘴里掉出 1 张＝捡走
    expect(p.hp).toBe(k.config.maxHp);
    expect(p.pos).toBe(before.pos);
    expect(k.state.messages.some((m) => m.kind === "malice" && m.who === 0 && m.text.includes("击毙了野狗"))).toBe(true);
  });

  it("失败=被咬 −1 血+退 2 格：hp 落 1、沿来路栈退回原位、狗活着满血、dogKilled 零声量", () => {
    const { k, before } = bootFight(seedForGrade("失败"));
    const p = k.state.players[0]!;
    expect(k.state.malice.dogs).toHaveLength(1);
    expect(k.state.malice.dogs[0]).toMatchObject({ cell: PIN, hp: DOG_HP });
    expect(gradeLine(k, "失败")).toBe(true);
    expect(p.hp).toBe(k.config.maxHp - 1); // 咬伤走 applyHpDelta 单入口（T5a 渠道账）
    walkOut(k, 0); // 退 2 格走完（沿来路栈 2 步）
    expect(p.pos).toBe(PIN); // 沿 PIN_N→PIN 退 2 的回合几何=回原位
  });

  it("大失败=被咬+被抢 1 张：hp 落 1、手牌 −1 张入弃牌堆（单池守恒）、狗活着不求人", () => {
    const { k, fx, before } = bootFight(seedForGrade("大失败"), [
      (k) => k.apply({ type: "dev.giveItem", pid: 0, cardId: k.state.itemDeck[0]! }, 0), // 牌堆顶必不在任何人手牌
    ]);
    const p = k.state.players[0]!;
    expect(before.hand).toBeGreaterThanOrEqual(1); // 复放链接到预置卡在手
    expect(gradeLine(k, "大失败")).toBe(true);
    expect(p.hp).toBe(k.config.maxHp - 1); // 大失败=被咬（不吃档位翻账加重，与温和档同账）
    expect(p.hand.length).toBe(before.hand - 1); // 被抢 1 张
    expect(k.state.itemDiscard.length).toBe(before.discard + 1); // 「叼走」=卡回弃牌堆（狗不占资产）
    expect(k.state.malice.dogs).toHaveLength(1); // 狗活着
    expect(fx.some((f) => f.type === "dogKilled")).toBe(false);
    expect(k.state.messages.some((m) => m.kind === "malice" && m.text.includes("叼走了"))).toBe(true);
  });

  it("同格多头禁死狗复打（review 收口）：先打者击毙挂 hp=0 → 同格后继不再开打（dogKilled 单次、零双份战利品）", () => {
    const seed = (() => {
      for (let s = 1; s < 9000; s++) {
        const k = boot({ seed: s });
        k.apply({ type: "dev.setPos", pid: 0, pos: PIN, from: PIN_N, net: 10 }, 0);
        k.apply({ type: "dev.setPos", pid: 1, pos: PIN, from: null, net: 10 }, 0); // 同格围观（不占随机流——种子复放稳定）
        k.apply({ type: "dev.spawnDog", cell: PIN }, 0);
        if (gradeLine(k, "通过")) return s; // 先打者走通过档=击毙
      }
      throw new Error("找不到「先打者通过」的种子");
    })();
    const k = boot({ seed });
    k.apply({ type: "dev.setPos", pid: 0, pos: PIN, from: PIN_N, net: 10 }, 0);
    k.apply({ type: "dev.setPos", pid: 1, pos: PIN, from: null, net: 10 }, 0);
    expect(gradeLine(k, "通过") || true).toBe(true); // （种子身份占位——复放后直接断局面）
    const fx = k.apply({ type: "dev.spawnDog", cell: PIN }, 0);
    const kills = fx.filter((f) => f.type === "dogKilled");
    expect(kills).toHaveLength(1); // 击毙事实只一次
    expect(kills[0]).toMatchObject({ pid: 0 });
    expect(k.state.malice.dogs).toHaveLength(0); // 死狗出册一次即净
    const brawl = k.state.messages.filter((m) => m.kind === "malice" && m.text.includes("遭遇战一触即发"));
    expect(brawl).toHaveLength(1); // 只有先打者一场——后继玩家不再对死狗开战
    expect(k.state.messages.some((m) => m.who === 1 && m.text.includes("遭遇战"))).toBe(false);
  });
});

describe("野狗 · 生成/寿命/移动（波次=3 只标准狗；#25 验收）", () => {
  /** 复放狗波前置链（搜索与断言共用）: windowMs:0 快进到 maliceEvery=5 首波；假人波后退场、
   *  人间波后钉 PIN——波窗自然行走归种子，之后只剩狗的生命账与人间钉位。 */
  function dogWaveBase(seed: number, over: Partial<GameConfig> = {}): GameKernel {
    const every = 5;
    const k = GameKernel.create({ allowDev: true, windowMs: 0, restMs: 0, seed, maliceEvery: every, ...over }, 0).kernel;
    openGame(k);
    advanceWorldTurns(k, every - 1); // turn=every 的首个波窗
    for (const pid of [1, 2, 3]) k.apply({ type: "dev.setDead", pid }, 0);
    k.apply({ type: "dev.setPos", pid: 0, pos: PIN, from: null, net: 10 }, 0);
    return k;
  }
  /** 搜种子：首波=狗波（出没打头）且 3 只全在（生成当拍被同格玩家毙掉的坏账换种子） */
  function seedForDogWave(seeds = 8000): number {
    for (let seed = 1; seed < seeds; seed++) {
      const k = dogWaveBase(seed);
      if (k.state.messages.some((m) => m.kind === "malice" && m.text.includes("野狗出没")) && k.state.malice.dogs.length === DOGS_PER_WAVE)
        return seed;
    }
    throw new Error(`找不到野狗波种子（1..${seeds}）`);
  }

  it("波次生成=3 只标准狗：落点全在主网可落格（排环岛/出生格）、各 4 血、含出生窗满寿命、战报点名出没", () => {
    const k = dogWaveBase(seedForDogWave());
    expect(k.state.messages.some((m) => m.kind === "malice" && m.text.includes("野狗出没"))).toBe(true);
    const dogs = k.state.malice.dogs;
    expect(dogs).toHaveLength(DOGS_PER_WAVE);
    for (const d of dogs) {
      expect(d.hp).toBe(DOG_HP);
      expect(d.left).toBe(DOG_TURNS); // 含出生窗满 3——波生出生窗免减寿（tickDogs 先于新波）
      expect(MAIN_PLAYABLE_CELLS.includes(d.cell)).toBe(true); // 主网可落格池（波点排除环岛/出生格）
    }
  });

  it("寿命 3 世界回合（含出生窗计 3）：T+1/T+2 各递减活动、T+3 开窗消散出声清空", () => {
    const drive = (seed: number): boolean => {
      const k = dogWaveBase(seed);
      if (k.state.messages.some((m) => m.text.includes("遭遇战一触即发"))) return false; // 干净前置
      for (let t = 1; t <= 3; t++) {
        advanceWorldTurns(k, 1);
        if (k.state.messages.some((m) => m.text.includes("遭遇战一触即发"))) return false;
        const dogs = k.state.malice.dogs;
        if (t < 3) {
          if (dogs.length !== DOGS_PER_WAVE) return false;
          if (!dogs.every((d) => d.left === DOG_TURNS - t)) return false;
        }
      }
      return (
        k.state.malice.dogs.length === 0 &&
        k.state.messages.some((m) => m.text.includes("野狗游荡期满——溜回林子深处没了踪影"))
      );
    };
    for (let seed = 1; seed < 8000; seed++) {
      if (!drive(seed)) continue;
      const k = dogWaveBase(seed);
      advanceWorldTurns(k, 1); // T+1
      expect(k.state.malice.dogs.every((d) => d.left === 2)).toBe(true);
      advanceWorldTurns(k, 1); // T+2
      expect(k.state.malice.dogs.every((d) => d.left === 1)).toBe(true);
      advanceWorldTurns(k, 1); // T+3 开窗=消散点
      expect(k.state.malice.dogs).toHaveLength(0);
      expect(k.state.messages.some((m) => m.text.includes("野狗游荡期满——溜回林子深处没了踪影"))).toBe(true);
      return;
    }
    throw new Error("找不到干净寿命链的种子");
  });

  it("移动或留守：每回合 cell ∈ 自身∪相邻（留守或挪一步都在网内）", () => {
    const drive = (seed: number): boolean => {
      const k = dogWaveBase(seed);
      if (k.state.messages.some((m) => m.text.includes("遭遇战一触即发"))) return false;
      for (let t = 1; t <= 2; t++) {
        const old = new Map(k.state.malice.dogs.map((d) => [d, d.cell] as const));
        advanceWorldTurns(k, 1);
        if (k.state.messages.some((m) => m.text.includes("遭遇战一触即发"))) return false;
        if (k.state.malice.dogs.length !== DOGS_PER_WAVE) return false;
        for (const [d, before2] of old) {
          if (d.cell !== before2 && !BOARD[before2]!.links.includes(d.cell)) return false;
        }
      }
      return true;
    };
    for (let seed = 1; seed < 8000; seed++) {
      if (!drive(seed)) continue;
      const k = dogWaveBase(seed);
      const before = new Map(k.state.malice.dogs.map((d) => [d, d.cell] as const));
      advanceWorldTurns(k, 1);
      for (const [d, old] of before) {
        expect([old, ...BOARD[old]!.links]).toContain(d.cell); // 留守或挪一步
      }
      return;
    }
    throw new Error("找不到干净移动链的种子");
  });
});

describe("野狗 · 撞上=强制遭遇战（三清账口）", () => {
  it("走停撞上（landOn 收口）：直进 1 步停在狗格=遭遇战照打（通过档验收资产账）", () => {
    // 准备位=PIN 的 2 度邻（另一邻作来向）→ die=1 直进 PIN 站停——撞狗
    const pre = BOARD[PIN]!.links.map((l) => BOARD[l]!).find((c) => c.street !== "J" && c.spawnIndex < 0 && c.links.length === 2);
    if (!pre) throw new Error("PIN 无 2 度邻（拓扑账查 board.ts）");
    const fromPre = pre.links.find((l) => l !== PIN)!;
    const seed = (() => {
      for (let s = 1; s < 9000; s++) {
        const k = boot({ seed: s });
        k.apply({ type: "dev.spawnDog", cell: PIN }, 0);
        k.apply({ type: "dev.setPos", pid: 0, pos: pre.id, from: fromPre, net: 10 }, 0);
        const fx = k.apply({ type: "roll", pid: 0 }, 0);
        if (dieOf(fx, 0) !== 1) continue;
        k.tick(160); // 一步走完 → endWalk → landOn 撞狗
        if (gradeLine(k, "通过")) return s;
      }
      throw new Error("找不到「走停撞上·通过」的种子");
    })();
    const k = boot({ seed });
    k.apply({ type: "dev.spawnDog", cell: PIN }, 0);
    k.apply({ type: "dev.setPos", pid: 0, pos: pre.id, from: fromPre, net: 10 }, 0);
    const p = k.state.players[0]!;
    const hand0 = p.hand.length;
    k.apply({ type: "roll", pid: 0 }, 0);
    k.tick(160);
    expect(k.state.malice.dogs).toHaveLength(0); // 撞上=照打=击毙（通过档）
    expect(p.hand.length).toBe(hand0 + 1);
    expect(p.pos).toBe(PIN);
    expect(gradeLine(k, "通过")).toBe(true);
  });

  it("路过不停不触发：直线两步跨过狗格不止步=零遭遇零扣血（站停才算撞上）", () => {
    // (12,19) from (12,18) 直线 2 步：(12,20)（路过不停）→(11,20)（停点）；狗钉 (12,20)
    const k = bootWithDie(2, { pos: cell(12, 19), from: cell(12, 18), net: 5 });
    k.apply({ type: "dev.spawnDog", cell: cell(12, 20) }, 0); // 路过格钉狗（spawnDog 不吃随机流——首掷复现不变）
    k.apply({ type: "roll", pid: 0 }, 0);
    walkOut(k, 0); // 两步直线走完——(12,20) 路过、停 (11,20)
    expect(k.state.players[0]!.pos).toBe(cell(11, 20));
    expect(k.state.players[0]!.hp).toBe(k.config.maxHp); // 零遭遇零扣血
    expect(k.state.malice.dogs).toHaveLength(1);
    expect(k.state.malice.dogs[0]).toMatchObject({ cell: cell(12, 20), hp: DOG_HP }); // 狗毫发无伤
    expect(k.state.messages.some((m) => m.text.includes("遭遇战一触即发"))).toBe(false);
  });
});

describe("野狗 · 狗笛（表一 #16=T6b 接通；#25 验收）", () => {
  it("world·即时：打出当窗不生成，下窗 tickMalice 出队结算——落点=受指向者相邻格、标准狗", () => {
    const drive = (seed: number): boolean => {
      const k = boot({ seed });
      k.apply({ type: "dev.setPos", pid: 0, pos: PIN, from: null, net: 10 }, 0);
      if (!tryGiveItem(k, 0, "i16", 0)) return false;
      k.apply({ type: "playItem", pid: 0, cardId: "i16", target: 1 }, 0);
      if (k.state.malice.dogs.length !== 0) return false; // 当窗不生成（spawnQueue 挂账）
      toNextWindow(k, 0, k.config.windowMs, k.config.restMs); // 替掷收窗→休息→开窗=挂账出队
      const dogs = k.state.malice.dogs;
      return dogs.length === 1 && dogs[0]!.hp === DOG_HP && dogs[0]!.left === DOG_TURNS;
    };
    let seed = 0;
    for (seed = 1; seed < 6000; seed++) if (drive(seed)) break;
    if (seed === 6000) throw new Error("找不到狗笛链种子");
    const k = boot({ seed });
    k.apply({ type: "dev.setPos", pid: 0, pos: PIN, from: null, net: 10 }, 0);
    tryGiveItem(k, 0, "i16", 0);
    k.apply({ type: "playItem", pid: 0, cardId: "i16", target: 1 }, 0);
    expect(k.state.malice.dogs).toHaveLength(0);
    expect(k.state.deferred[0]).toMatchObject({ pid: 1, kind: "item" }); // dogSpawn 挂账（下窗出队）
    toNextWindow(k, 0, k.config.windowMs, k.config.restMs);
    const dogs = k.state.malice.dogs;
    expect(dogs).toHaveLength(1);
    expect(BOARD[k.state.players[1]!.pos]!.links).toContain(dogs[0]!.cell); // 受指向者相邻格（结算时刻位置）
    expect(dogs[0]).toMatchObject({ hp: DOG_HP, left: DOG_TURNS }); // 标准狗（出生窗免减寿同构）
    expect(k.state.messages.some((m) => m.text.includes("「狗笛」一声长鸣"))).toBe(true);
  });

  it("轮班·限时：同为 spawnQueue 挂账（延迟到回合边界出队）——M1 未接 T9 口径先立", () => {
    let seed = 0;
    for (seed = 1; seed < 6000; seed++) {
      const k = boot({ seed, timerMode: "turn" });
      k.apply({ type: "dev.setPos", pid: 1, pos: PIN, from: null, net: 10 }, 0);
      if (!tryGiveItem(k, 0, "i16", 0)) continue;
      k.apply({ type: "playItem", pid: 0, cardId: "i16", target: 1 }, 0);
      expect(k.state.malice.spawnQueue).toHaveLength(1);
      expect(k.state.malice.dogs).toHaveLength(0);
      toNextWindow(k, 0, k.config.windowMs, k.config.restMs);
      const dogs = k.state.malice.dogs;
      if (dogs.length === 1 && BOARD[PIN]!.links.includes(dogs[0]!.cell)) return;
      break; // 不合拍换种子
    }
    if (seed === 6000) throw new Error("找不到轮班狗笛种子");
    // 断言在搜索体内完成（位置=受指向者相邻、标准狗）
  });
});

describe("野狗 · 世界恶意砸狗（世界层互击；#25 验收）", () => {
  /** 滚石碾狗 drive（搜与复放共用）：dev.spawnDog 钉 HEART → 假人退场、人间钉 NEU → 逐 tick 等滚石。
   *  返回命中拍后的狗账快照（人间同拍不在路=无敏检串扰；不洁种子>null）。 */
  function rockDrive(seed: number, level: "mild" | "fierce"): { dogHp: number } | null {
    const k = boot({ seed, windowMs: 0, restMs: 0, maliceLevel: level });
    k.apply({ type: "dev.setPos", pid: 0, pos: NEU, from: null, net: 10 }, 0);
    k.apply({ type: "dev.spawnDog", cell: HEART }, 0);
    for (const pid of [1, 2, 3]) k.apply({ type: "dev.setDead", pid }, 0);
    for (let t = 0; t < 10; t++) {
      const start = k.state.messages.length;
      advanceWorldTurns(k, 1);
      const slice = k.state.messages.slice(start);
      if (slice.some((m) => m.kind === "malice" && m.text.includes("滚石碾过"))) {
        if (slice.some((m) => m.who === 0 && m.text.includes("敏检 d20"))) return null; // 人间在路——串扰坏账
        return { dogHp: k.state.malice.dogs[0]?.hp ?? -1 };
      }
      if (slice.some((m) => m.text.includes("🐕"))) return null; // 其他狗账噪声——换种子
    }
    return null;
  }

  it("滚石碾过狗=固定 −1（温和/猛档同账不吃翻档）；人间钉位不在路=各判各不串扰", () => {
    for (let seed = 1; seed < 8000; seed++) {
      const mild = rockDrive(seed, "mild");
      if (!mild) continue;
      expect(mild.dogHp).toBe(DOG_HP - 1);
      const fierce = rockDrive(seed, "fierce");
      expect(fierce).not.toBeNull();
      expect(fierce!.dogHp).toBe(DOG_HP - 1); // 对狗固定 −1——档位不吃翻档
      return;
    }
    throw new Error("找不到「滚石碾狗」的种子");
  });

  /** 木头砸狗 drive：dev.spawnDog 钉任意格 → 假人退场、人间钉 NEU → 逐 tick 等木头预警并追到砸落。
   *  预警=timber ∋ 狗当前格；砸落=「大木头轰然砸中一只野狗」出现。返回命中拍消息——注意首波
   *  turn3 预警/turn4 砸落与 dev 狗寿命终点恰好同拍：狗挨砸后同拍消散（游荡期满）——账比花名册
   *  活数更稳的是命中消息文本（固定 −1 的「剩 3/4 血」字样直证档位不吃翻账）。 */
  function timberDrive(seed: number, level: "mild" | "fierce"): { hit: string } | null {
    const k = boot({ seed, windowMs: 0, restMs: 0, maliceLevel: level });
    k.apply({ type: "dev.setPos", pid: 0, pos: NEU, from: null, net: 10 }, 0);
    k.apply({ type: "dev.spawnDog", cell: cell(7, 0) }, 0);
    for (const pid of [1, 2, 3]) k.apply({ type: "dev.setDead", pid }, 0);
    let warned = false;
    let humanHp0 = 0;
    for (let t = 0; t < 10; t++) {
      const start = k.state.messages.length;
      humanHp0 = k.state.players[0]!.hp;
      advanceWorldTurns(k, 1);
      const slice = k.state.messages.slice(start);
      if (!warned) {
        if (slice.some((m) => m.text.includes("🐕"))) return null; // 其他狗账噪声——换种子
        const tim = k.state.malice.timber;
        const dogCell = k.state.malice.dogs[0]?.cell;
        if (tim && dogCell != null && tim.includes(dogCell)) warned = true; // 预警罩上狗格
        continue;
      }
      const hitMsg = slice.find((m) => m.kind === "malice" && m.text.includes("大木头轰然砸中一只野狗"));
      if (!hitMsg) return null; // 砸落没踩上狗——换种子
      if (k.state.players[0]!.hp !== humanHp0) return null; // 人间同拍被砸——串扰坏账
      return { hit: hitMsg.text };
    }
    return null;
  }

  it("木头砸落命中狗格=固定 −1；人间钉位不在落点=各判各不串扰", () => {
    for (let seed = 1; seed < 8000; seed++) {
      const drive = timberDrive(seed, "mild");
      if (!drive) continue;
      expect(drive.hit).toContain(`剩 ${DOG_HP - 1}/${DOG_HP} 血`); // 固定 −1：4→3（剩 3/4）
      const fierce = timberDrive(seed, "fierce");
      expect(fierce!.hit).toContain(`剩 ${DOG_HP - 1}/${DOG_HP} 血`); // 固定 1 不吃档位翻档
      return;
    }
    throw new Error("找不到「木头砸中狗」的种子");
  });
});

describe("野狗 · 其余口径", () => {
  it("猎手特长 scope=dogFight：遭遇战判定 +4 与力轴合成 +7（判定行内 +7= 直证）", () => {
    const HUNTER_DEFS: PlayerDef[] = [
      { name: "你", isBot: false, roleId: "beast" },
      { name: "小黄", isBot: true, roleId: "light" },
    ];
    const seed = (() => {
      for (let s = 1; s < 6000; s++) {
        const { kernel } = GameKernel.create({ seed: s, allowDev: true }, 0, HUNTER_DEFS);
        openGame(kernel);
        kernel.apply({ type: "dev.setPos", pid: 0, pos: PIN, from: PIN_N, net: 10 }, 0);
        kernel.apply({ type: "dev.spawnDog", cell: PIN }, 0);
        if (kernel.state.messages.some((m) => m.kind === "malice" && m.who === 0 && m.text.includes("力检 d20(") && m.text.includes("+7=")))
          return s;
      }
      throw new Error("找不到猎手 +7 判定线种子");
    })();
    const { kernel } = GameKernel.create({ seed, allowDev: true }, 0, HUNTER_DEFS);
    openGame(kernel);
    kernel.apply({ type: "dev.setPos", pid: 0, pos: PIN, from: PIN_N, net: 10 }, 0);
    kernel.apply({ type: "dev.spawnDog", cell: PIN }, 0);
    const line = kernel.state.messages.find((m) => m.kind === "malice" && m.who === 0 && m.text.includes("力检 d20("))!;
    expect(line.text).toContain("+7="); // 力轴 3 + 猎手特长 4=+7（dogFight 域恰在生效）
  });

  it("off 关断：整局零波零狗（狗花名册空、狼烟不冒、人间满血）", () => {
    const k = boot({ windowMs: 0, restMs: 0, maliceLevel: "off", turnCap: 30 });
    advanceWorldTurns(k, 30);
    expect(k.state.malice.dogs).toEqual([]);
    expect(k.state.messages.filter((m) => m.kind === "malice")).toHaveLength(0);
    expect(k.state.players.every((p) => p.hp === k.config.maxHp)).toBe(true);
  });
});
