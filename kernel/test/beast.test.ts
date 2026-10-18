/**
 * 最后一波·年兽战（#27 T8a2，数值表 §5.5「最后一波 B」+ 一页纸「群体失败闸门」）：
 * - 共享血条=基础 25+每玩家 15（2 人=55／4 人=85）；人人掷伤害骰 1d12；收束波数可测（固定种子钉账）；
 * - 反噬每波 −1（猛 −2，走 applyHpDelta 单入口）；安慰奖=每波每个存活参战者摸 1 张（胜负皆有 Loot）；
 * - 递卡给队友（giveItem=T7 转让管线同源）与直砸年兽（hitBeast=任意卡 +1d12）；
 * - 全员没撑过=群体失败标记落库（endgame.groupFail）；终局无死结（invariant 套件全自动穿过年兽战）。
 *
 * 确定性铁律：windowMs=5 的「凝滞世界」——走格节拍（140ms）永远赶不上一窗（5ms），15 窗推完人人
 * 仍在原地（无陷阱/事件搅局、血量与手牌纯净、牌池不饿），年兽战开张时 startLastWave 定格在途走格；
 * 波窗超时替砍驱动（一 tick 跳到截止+1=一波）；伤害骰面从 beastHit 事实读（不重算实现表达式）；
 * 胜利/群体失败用 dev.setBeast/dev.setHp 钉位；全员 light（无开局盾）；通关席=2 人局脚本+种子搜索配准。
 */
import { describe, expect, it } from "vitest";
import { BEAST_BASE_HP, BEAST_DIE, BEAST_HP_PER_PLAYER, BRANCH_LEN, ITEM_CARDS, NET_GOAL, GameKernel, giveTargets, hitBeastGate, strikeGate } from "../src";
import type { Fact, GameConfig, PlayerDef } from "../src";
import { advanceWorldTurns, cell, dieOf, toNextWindow, walkOut } from "./helpers";

const msg = (k: GameKernel, text: string): boolean =>
  k.state.messages.some((m) => m.text.includes(text) || m.flavor?.includes(text) === true);

/** 战局 crew：人间 + 3 假人（全员 light=无开局盾；假人到点自砍——真实节奏的波窗有人接招） */
const CREW: PlayerDef[] = [
  { name: "你", isBot: false, roleId: "light" },
  { name: "阿二", isBot: true, roleId: "light" },
  { name: "阿三", isBot: true, roleId: "light" },
  { name: "阿四", isBot: true, roleId: "light" },
];
/** 双人真人局（通关席脚本用；2 人菜单的 pid1 出生格=(12,17)——door1 才是它的支路门口） */
const PAIR: PlayerDef[] = [
  { name: "你", isBot: false, roleId: "light" },
  { name: "阿二", isBot: false, roleId: "light" },
];
const bootCrew = (over: Partial<GameConfig> = {}, defs: PlayerDef[] = CREW): GameKernel => {
  const { kernel } = GameKernel.create({ allowDev: true, seed: 7, maliceLevel: "off", ...over }, 0, defs);
  kernel.apply({ type: "chooseSecret", pid: 0, pick: 0 }, 0);
  return kernel;
};

/** 逐窗推 n 个世界回合（任意窗长）：一 tick 跳到当前截止+1=收一窗；返回收完后的截止钟 */
const advanceWindows = (k: GameKernel, n: number): number => {
  for (let i = 0; i < n; i++) k.tick(Math.max(k.state.windowDeadline, k.state.restUntil) + 1);
  return Math.max(k.state.windowDeadline, k.state.restUntil);
};

/** 打进最后一波（凝滞世界=windowMs 5ms）：常规 15 窗推完→年兽战第 1 波开张、无人砍过 */
const bootFight = (over: Partial<GameConfig> = {}): { k: GameKernel; now: number } => {
  const k = bootCrew({ windowMs: 5, restMs: 0, ...over });
  const now = advanceWindows(k, 15);
  expect(k.state.endgame?.beast != null).toBe(true);
  expect(k.state.phase).toBe("acting");
  return { k, now };
};

/** 把年兽战打到收束：波窗超时替砍驱动（每次 tick 跳到当前截止+1——一 tick 一波） */
const fightToEnd = (k: GameKernel): { waves: number; groupFail: boolean } => {
  let guard = 60;
  while (k.state.phase !== "over" && guard-- > 0) {
    k.tick(Math.max(k.state.windowDeadline, k.state.restUntil) + 1);
  }
  expect(k.state.phase).toBe("over");
  const e = k.state.endgame!;
  return { waves: e.beast?.wave ?? 0, groupFail: e.groupFail };
};

/** 「人先砍、替砍收波」的标准波拍：返回收波+反噬+下一波开张的合并事实 */
const strikeWave = (k: GameKernel, now: number): Fact[] => {
  k.apply({ type: "strike", pid: 0 }, now);
  return k.tick(now + 6); // 波窗截止+1：没砍的替砍→收波→反噬→下一波开张
};

const hitsFor = (fx: Fact[], pid: number): number[] =>
  fx.filter((f) => f.type === "beastHit" && f.pid === pid).map((f) => (f.type === "beastHit" ? f.dmg : 0));

const poolSize = (k: GameKernel): number =>
  k.state.itemDeck.length + k.state.itemDiscard.length + k.state.players.reduce((n, p) => n + p.hand.length, 0) + k.state.ground.length;

describe("开张与血条公式（数值表 §5.5）", () => {
  it("年兽现身：血条=基础 25+每玩家 15（4 人=85／2 人=55），战报带公式，beastWave 事实开张", () => {
    const { k } = bootFight();
    const b = k.state.endgame!.beast!;
    expect(b.maxHp).toBe(BEAST_BASE_HP + BEAST_HP_PER_PLAYER * 4);
    expect(b.maxHp).toBe(85);
    expect(b.wave).toBe(1);
    expect(b.hp).toBe(85);
    expect(msg(k, "年兽现身")).toBe(true);
    expect(msg(k, `基础 ${BEAST_BASE_HP}+每玩家 ${BEAST_HP_PER_PLAYER}×4`)).toBe(true);
    // 二人局=55（票面字面口径）
    const two = bootCrew({ windowMs: 0, restMs: 0 }, PAIR);
    advanceWorldTurns(two, 15);
    expect(two.state.endgame!.beast!.maxHp).toBe(55);
  });

  it("参战名册接管波窗：fight 在册可砍；常规对局三件套（掷骰/确认/打牌）全拒+拒因点名最后一波", () => {
    const { k, now } = bootFight();
    expect(k.state.players.every((p) => p.endgame === "fight")).toBe(true);
    expect(() => k.apply({ type: "roll", pid: 0 }, now)).toThrow("最后一波不走格");
    expect(() => k.apply({ type: "confirm", pid: 0 }, now)).toThrow("最后一波无需确认");
    const card = k.state.players[0]!.hand[0]!;
    expect(() => k.apply({ type: "playItem", pid: 0, cardId: card }, now)).toThrow("最后一波");
    // 砍击闸：没砍过=放行；淘汰者=拒
    expect(strikeGate(k.state, 0)).toEqual({ ok: true });
    k.apply({ type: "dev.setDead", pid: 3 }, now);
    expect(strikeGate(k.state, 3).ok).toBe(false);
  });
});

describe("收束数学（胜利）", () => {
  it("伤害骰 1d12：每刀面 ∈[1,12]；钉血 1 → 首刀收束（死兽不反噬——当波无人掉血）", () => {
    const { k, now } = bootFight();
    k.apply({ type: "dev.setBeast", hp: 1 }, now);
    const hpBefore = k.state.players.map((p) => p.hp);
    const fx = k.apply({ type: "strike", pid: 0 }, now);
    const dmg = hitsFor(fx, 0)[0]!;
    expect(dmg).toBeGreaterThanOrEqual(1);
    expect(dmg).toBeLessThanOrEqual(BEAST_DIE);
    expect(k.state.phase).toBe("over"); // 击杀即收束（beast.hp 钳 0）
    expect(k.state.endgame!.beast!.hp).toBe(0);
    expect(k.state.endgame!.beast!.wave).toBe(1);
    expect(fx.some((f) => f.type === "beastSlain" && f.wave === 1)).toBe(true);
    expect(fx.some((f) => f.type === "gameEnd")).toBe(true);
    expect(msg(k, "年兽轰然倒地")).toBe(true);
    // 死兽不反噬：全场血量纹丝不动
    expect(k.state.players.map((p) => p.hp)).toEqual(hpBefore);
  });

  it("收束波数可测（固定种子钉账）：4 人 85 血打到收束；反噬行数=收束波数−1（末波砍死不反噬）", () => {
    const { k } = bootFight();
    const { waves, groupFail } = fightToEnd(k);
    expect(groupFail).toBe(false);
    // 种子 7 的骰面流钉账（T8a1 同纪律：钉具体字面值，不拿实现重算）
    expect(waves).toBe(3);
    expect(k.state.endgame!.beast!.wave).toBe(3);
    expect(k.state.endgame!.beast!.hp).toBe(0);
    // 战报对账：开张报 85 血；每波收口有反噬行（第 3 波砍死=不反噬）——注意开张横幅文案里也有
    // 「反噬全场」四字，故按反噬行的专有前缀「年兽反噬全场——」数
    expect(msg(k, "血条 85")).toBe(true);
    expect(k.state.messages.filter((m) => m.text.includes("年兽反噬全场——")).length).toBe(waves - 1);
    expect(k.state.endgame!.beast!.maxHp).toBe(85);
  });

  it("每波伤害和的算术带：4 人每波 ∈[4,48]（每刀 ≥1、≤1d12），收束 3–6 波量级", () => {
    const { k } = bootFight();
    const waveDmgs: number[] = [];
    let guard = 60;
    while (k.state.phase !== "over" && guard-- > 0) {
      const fx = k.tick(Math.max(k.state.windowDeadline, k.state.restUntil) + 1);
      const hits = fx.filter((f) => f.type === "beastHit");
      if (hits.length > 0) waveDmgs.push(hits.reduce((n, f) => n + (f.type === "beastHit" ? f.dmg : 0), 0));
    }
    expect(k.state.phase).toBe("over");
    expect(waveDmgs.length).toBeGreaterThanOrEqual(3);
    for (const d of waveDmgs) {
      expect(d).toBeGreaterThanOrEqual(4); // 4 人每刀 ≥1
      expect(d).toBeLessThanOrEqual(4 * BEAST_DIE);
    }
  });
});

describe("反噬与安慰奖", () => {
  it("反噬每波 −1（温和）：挂两波每个存活参战者恰好 −2；猛档 −2（两波 −4）", () => {
    const { k, now } = bootFight();
    for (const p of k.state.players) k.apply({ type: "dev.setHp", pid: p.id, hp: 10 }, now); // 前路账清零（凝滞世界本就满血——钉位自证）
    k.apply({ type: "dev.setBeast", hp: 999 }, now);
    strikeWave(k, now);
    expect(k.state.endgame!.beast!.wave).toBe(2);
    expect(k.state.players.map((p) => p.hp)).toEqual([9, 9, 9, 9]);
    // 再挂一波：温和平账
    strikeWave(k, now + 6);
    expect(k.state.players.map((p) => p.hp)).toEqual([8, 8, 8, 8]);
    // 猛档对照：−2/波（同样清前路账——猛档世界 15 凝滞窗里恶意真咬人，别让它混进反噬账）
    const { k: kf, now: nf } = bootFight({ maliceLevel: "fierce" });
    for (const p of kf.state.players) kf.apply({ type: "dev.setHp", pid: p.id, hp: 10 }, nf);
    kf.apply({ type: "dev.setBeast", hp: 999 }, nf);
    strikeWave(kf, nf);
    expect(kf.state.players.map((p) => p.hp)).toEqual([8, 8, 8, 8]);
  });

  it("反噬走 applyHpDelta 单入口：战前打出的护身符拦下反噬（触发即消耗），队友照扣", () => {
    const k = bootCrew({ windowMs: 5, restMs: 0, seed: 16 });
    // 种子 16（五流拆分后重钉）：pid0 开局手牌恰为「护身符」——第 1 窗常规打出
    expect(k.state.players[0]!.hand.includes("i14")).toBe(true);
    k.apply({ type: "playItem", pid: 0, cardId: "i14" }, 0);
    expect(k.state.players[0]!.talisman).toBe(1);
    const now = advanceWindows(k, 15); // 15 窗推完→年兽战第 1 波开张（护身符是计数不随窗走）
    expect(k.state.endgame?.beast != null).toBe(true);
    k.apply({ type: "dev.setBeast", hp: 999 }, now);
    strikeWave(k, now); // 收波→反噬：护身符替人间挡下 −1
    expect(k.state.players[0]!.hp).toBe(10);
    expect(k.state.players[0]!.talisman).toBe(0);
    expect(k.state.players.slice(1).map((p) => p.hp)).toEqual([9, 9, 9]);
    expect(msg(k, "护身符闪金光")).toBe(true);
  });

  it("安慰奖：每波开张每个存活参战者摸 1 张（胜负皆有 Loot）；单池守恒不破", () => {
    const { k, now } = bootFight();
    const handsBefore = k.state.players.map((p) => p.hand.length);
    const poolBefore = poolSize(k);
    // 第 1 波开张已发过一轮（startLastWave→openWave）——收波开第 2 波=再发一轮
    strikeWave(k, now);
    expect(k.state.endgame!.beast!.wave).toBe(2);
    expect(k.state.players.map((p) => p.hand.length)).toEqual(handsBefore.map((n) => n + 1));
    expect(poolSize(k)).toBe(poolBefore);
    expect(msg(k, "波间补给（安慰奖——输了也有 Loot）")).toBe(true);
  });
});

describe("递卡与直砸（T7 转让管线同源）", () => {
  it("递卡给队友：手→手平移单池守恒；目标=参战名册；自己/出局者拒收", () => {
    const { k, now } = bootFight();
    expect(giveTargets(k.state, 0)).toEqual([1, 2, 3]);
    const card = k.state.players[0]!.hand[0]!; // 安慰奖已在手——直接拿手牌首张（不赌牌池）
    expect(() => k.apply({ type: "giveItem", pid: 0, cardId: card, to: 0 }, now)).toThrow("要选别人");
    k.apply({ type: "dev.setDead", pid: 2 }, now);
    expect(() => k.apply({ type: "giveItem", pid: 0, cardId: card, to: 2 }, now)).toThrow("已淘汰");
    const hand0 = k.state.players[0]!.hand.length;
    k.apply({ type: "giveItem", pid: 0, cardId: card, to: 1 }, now);
    expect(k.state.players[0]!.hand.length).toBe(hand0 - 1);
    expect(k.state.players[1]!.hand.includes(card)).toBe(true);
    expect(msg(k, "递给 阿二")).toBe(true);
    expect(poolSize(k)).toBe(ITEM_CARDS.length); // 转移不增不减
  });

  it("非年兽战递卡/直砸/砍击全拒（口子只开在最后一波）", () => {
    const k = bootCrew({ windowMs: 30_000, restMs: 0 });
    const now = toNextWindow(k, 0, 30_000, 0); // 常规对局中段（第 2 窗）
    const card = k.state.players[0]!.hand[0]!;
    expect(() => k.apply({ type: "giveItem", pid: 0, cardId: card, to: 1 }, now)).toThrow("最后一波");
    expect(() => k.apply({ type: "hitBeast", pid: 0, cardId: card }, now)).toThrow("没有年兽战");
    expect(() => k.apply({ type: "strike", pid: 0 }, now)).toThrow("没有年兽战");
  });

  it("直砸年兽：任意卡=多掷一刀（卡回弃牌堆+beastHit 事实）；钉血 1 → 砸必收束；离手的卡不能再砸", () => {
    const { k, now } = bootFight();
    const card = k.state.players[0]!.hand[0]!; // 手牌首张砸年兽（治疗/护身符也通用——票面例证）
    k.apply({ type: "dev.setBeast", hp: 1 }, now);
    const discardBefore = k.state.itemDiscard.length;
    const fx = k.apply({ type: "hitBeast", pid: 0, cardId: card }, now);
    expect(hitsFor(fx, 0)[0]).toBeGreaterThanOrEqual(1);
    expect(k.state.itemDiscard.length).toBe(discardBefore + 1); // 卡回弃牌堆（单池守恒）
    expect(k.state.players[0]!.hand.includes(card)).toBe(false);
    expect(k.state.phase).toBe("over");
    expect(fx.some((f) => f.type === "beastSlain")).toBe(true);
    expect(hitBeastGate(k.state, 0, card).ok).toBe(false); // 收束后闸门关死
  });
});

describe("群体失败闸门", () => {
  it("群体失败：反噬把队伍磨光 → groupFail 落库+groupFail 事实+phase over；收束后世界静默（无死结）", () => {
    const { k, now } = bootFight();
    k.apply({ type: "dev.setBeast", hp: 999 }, now); // 兽不死——看反噬把队伍磨光
    for (const p of k.state.players) k.apply({ type: "dev.setHp", pid: p.id, hp: 1 }, now);
    let fx: Fact[] = [];
    let guard = 30;
    while (k.state.phase !== "over" && guard-- > 0) {
      fx = k.tick(Math.max(k.state.windowDeadline, k.state.restUntil) + 1);
    }
    expect(k.state.phase).toBe("over");
    expect(k.state.endgame!.groupFail).toBe(true);
    expect(k.state.endgame!.beast).not.toBeNull(); // 兽活着站到最后——血条定格供 T8b1 读
    expect(fx.some((f) => f.type === "groupFail")).toBe(true);
    expect(msg(k, "群体失败")).toBe(true);
    expect(msg(k, "找战犯")).toBe(true);
    expect(k.state.players.every((p) => p.dead)).toBe(true);
    const seq = k.state.seq;
    k.tick(now + 2);
    k.tick(now + 3);
    expect(k.state.seq).toBe(seq); // 收束后无新战报=无新账
  });

  it("终局启动时无人应战（全员已出局）：不开战直接群体失败（年兽战不挂账——无死结边角）", () => {
    const k = bootCrew({ windowMs: 0, restMs: 0 });
    for (const p of k.state.players) k.apply({ type: "dev.setDead", pid: p.id }, 0);
    advanceWorldTurns(k, 15);
    expect(k.state.phase).toBe("over");
    expect(k.state.endgame!.groupFail).toBe(true);
    expect(k.state.endgame!.beast).toBeNull();
  });

  it("群体失败波照发安慰奖：最后一波的卡随淘汰散回牌堆（单池守恒——输了也有 Loot 的账面）", () => {
    const { k } = bootFight();
    const now = Math.max(k.state.windowDeadline, k.state.restUntil);
    k.apply({ type: "dev.setBeast", hp: 999 }, now);
    for (const p of k.state.players) k.apply({ type: "dev.setHp", pid: p.id, hp: 1 }, now);
    fightToEnd(k);
    expect(poolSize(k)).toBe(ITEM_CARDS.length);
    expect(msg(k, "波间补给")).toBe(true);
  });

  it("血尽淘汰即时翻 out：反噬咬死的人不参下一波（waveFighters 出册），幸存者继续砍", () => {
    const { k, now } = bootFight();
    k.apply({ type: "dev.setBeast", hp: 999 }, now);
    k.apply({ type: "dev.setHp", pid: 0, hp: 1 }, now);
    strikeWave(k, now); // 反噬 −1 → pid0 血尽
    expect(k.state.players[0]!.dead).toBe(true);
    expect(k.state.players[0]!.endgame).toBe("out");
    expect(k.state.endgame!.beast!.wave).toBe(2); // 第 2 波照开（幸存 3 人）
    expect(strikeGate(k.state, 0).ok).toBe(false);
  });
});

describe("通关席参战（T8a1 名册 × T8a2 波本体）", () => {
  /** pid1 的支路门口（2 人菜单：出生格 (12,17) 西侧邻格，掷 1 前向踩上=进支路）——T8a1 同款脚本 */
  const door1 = () => ({ pos: cell(12, 16), from: cell(12, 15), net: NET_GOAL });
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
  /** 搜+重放：pid1 先后入席、pid0 活着走到局长打满（全流程一次跑齐——种子确定性下探针=正片） */
  const bootSeat1Fight = (): { k: GameKernel; now: number } => {
    for (let seed = 1; seed < 20000; seed++) {
      try {
        const probe = bootCrew({ seed, windowMs: 30_000, restMs: 10_000 }, PAIR);
        const faces = seat1Script(probe);
        if (faces[0] !== 1 || faces[1] !== BRANCH_LEN) continue;
        let guard = 30;
        while (probe.state.endgame === null && guard-- > 0) {
          probe.tick(Math.max(probe.state.windowDeadline, probe.state.restUntil) + 1);
        }
        if (probe.state.endgame === null || probe.state.players[0]!.dead) continue;
        // 重放（同种子同全序流）
        const k = bootCrew({ seed, windowMs: 30_000, restMs: 10_000 }, PAIR);
        seat1Script(k);
        guard = 30;
        while (k.state.endgame === null && guard-- > 0) {
          k.tick(Math.max(k.state.windowDeadline, k.state.restUntil) + 1);
        }
        return { k, now: Math.max(k.state.windowDeadline, k.state.restUntil) };
      } catch {
        // 换下一粒
      }
    }
    throw new Error("找不到 pid1 入席且人间存活的种子（1..19999）");
  };

  it("通关席必参战=波本体接管：seat 态可砍（strikeGate 放行+砍击落账）", () => {
    const { k, now } = bootSeat1Fight();
    expect(k.state.players[1]!.endgame).toBe("seat");
    expect(k.state.players[0]!.endgame).toBe("fight");
    // seat 可砍：闸门放行+砍击落账（checkWindowAction 的「通关席不再行动」不拦砍击——波窗自有闸）
    expect(strikeGate(k.state, 1)).toEqual({ ok: true });
    k.apply({ type: "dev.setBeast", hp: 1 }, now);
    const fx = k.apply({ type: "strike", pid: 1 }, now);
    expect(hitsFor(fx, 1).length).toBe(1);
    expect(k.state.phase).toBe("over"); // 钉血 1=一刀收束
  });
});
