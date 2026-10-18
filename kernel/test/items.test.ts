/**
 * 道具打出链（#21 T4a）：手牌（摸卡/无上限）／时机锁（确认前任意时刻、连打有序、确认即锁、替掷不替打卡）
 * ／三类目标路由（self/chooseOther/ground + 合法性校验）／场地附着（含铺设者本人、触发即消）／
 * 走格骰修正（顺风靴/幸运骰/脚镣/轻装上阵减半）／违禁字段／单池守恒。
 */
import { describe, expect, it } from "vitest";
import { back, skip } from "../src/data/primitives";
import {
  BOARD,
  CONTRABAND_TITLES,
  GameKernel,
  ITEM_CARDS,
  M1_ITEM_POOL,
  itemCard,
  itemLegalTargets,
  itemPlayGate,
  registerCards,
  type GameConfig,
  type ItemCard,
  type PlayerDef,
} from "../src";
import { boot, cell, dieOf, me, seedForFirstDie, tryGiveItem, walkOut } from "./helpers";

/** 固定盘 defs（种子搜索与测试共用同一套；小黄=黑市老板：敏 1、无盾、无穿戴减半） */
const FIXED: PlayerDef[] = [
  { name: "你", isBot: false, roleId: "light" },
  { name: "小黄", isBot: true, roleId: "boss" },
  { name: "小绿", isBot: true, roleId: "tough" },
  { name: "小蓝", isBot: true, roleId: "woe" },
];

/** auto 路由测试卡（表一外 fixture，registerCards 播种；不进 M1_ITEM_POOL） */
const AUTO_FIXTURES: ItemCard[] = [
  { id: "x01", no: 21, title: "测试·随机指认鞭", flavor: "auto 路由 fixture（不进表一）", route: "auto", autoRule: "random", parts: [back(1)] },
  { id: "x02", no: 22, title: "测试·指认最近者", flavor: "auto 路由 fixture（不进表一）", route: "auto", autoRule: "nearestToGoal", parts: [skip(1)] },
  { id: "x03", no: 23, title: "测试·指认并弹弓", flavor: "auto 路由 fixture（不进表一）", route: "auto", autoRule: "farthestFromGoal", parts: [back(2)] },
];
registerCards(AUTO_FIXTURES);

/** 把 fixture/表一卡塞进手牌（不走牌堆守恒——fixture 不在池里） */
const handPut = (k: GameKernel, pid: number, id: string): void => {
  if (!k.state.players[pid]!.hand.includes(id)) k.state.players[pid]!.hand.push(id);
};

/** 让 p0 本窗走完流程（掷→走→确认），防超窗替掷的骰面噪声打断 walk 断言 */
const playThroughP0 = (k: GameKernel, when: number): void => {
  const p0 = k.state.players[0]!;
  if (!p0.skipped && !p0.rolled) void k.apply({ type: "roll", pid: 0 }, when);
  if (p0.walk) walkOut(k, when);
  if (!p0.confirmed && !p0.skipped) {
    try {
      k.apply({ type: "confirm", pid: 0 }, when + 1_000);
    } catch {
      // 挂起抉择等边界——留窗口替掷兜底，不拦主流程断言
    }
  }
};

function bootDefs(defs: PlayerDef[], over: Partial<GameConfig> = {}): GameKernel {
  const { kernel } = GameKernel.create({ allowDev: true, ...over }, 0, defs);
  kernel.apply({ type: "chooseSecret", pid: 0, pick: 0 }, 0);
  return kernel;
}
const bootFixed = (over: Partial<GameConfig> = {}): GameKernel => bootDefs(FIXED, over);

/** 保票塞卡：已在手牌（轻装上阵开局 +1 可能撞上）就不重复塞 */
function ensureHand(k: GameKernel, pid: number, id: string): void {
  if (!k.state.players[pid]!.hand.includes(id)) k.apply({ type: "dev.giveItem", pid, cardId: id }, 0);
}

/** (7,0) 面向 (8,0)：掷 3 西行经过 S/E 停 (4,0)=道具格（穿格不触，落点零事件挂起） */
const PRE_ITEM_RUN = { pos: cell(7, 0), from: cell(8, 0), net: 0 };

/** 搜种子：跑一整段脚本后，最近一条「敏检 d20(X)」的原始面满足 want（场地卡判定共用） */
function seedForGroundCheck(script: (k: GameKernel) => void, want: (raw: number) => boolean): number {
  for (let seed = 1; seed < 6000; seed++) {
    try {
      const k = bootFixed({ seed });
      script(k);
      const m = k.state.messages
        .slice()
        .reverse()
        .find((x) => /敏检 d20\(\d+\)/.test(x.text));
      const g = m && /敏检 d20\((\d+)\)/.exec(m.text);
      if (g && want(parseInt(g[1]!, 10))) return seed;
    } catch {
      // 该种子下脚本中断，换下一粒
    }
  }
  throw new Error("找不到场地判定面的种子");
}

/** 香蕉皮/地雷共用的落点脚本：你在出生格搁卡 → 小黄从 (7,0) 退一步踩上 (6,0) */
const groundStepScript = (cardId: string) => (k: GameKernel) => {
  ensureHand(k, 0, cardId);
  k.apply({ type: "playItem", pid: 0, cardId }, 0);
  k.apply({ type: "dev.setPos", pid: 1, pos: cell(7, 0), from: cell(6, 0), net: 0 }, 0);
  k.apply({ type: "dev.back", pid: 1, steps: 1 }, 0);
  walkOut(k, 0);
};

/** 搜种子：弹弓流程（你在窗 1 指认小黄 → 窗 2 开窗落账）后，小黄恰好挂上退 2 且 trail ≥ 2 */
function seedForFlick(): number {
  for (let seed = 1; seed < 8000; seed++) {
    try {
      const k = bootFixed({ seed, windowMs: 4_000, restMs: 0 });
      ensureHand(k, 0, "i10");
      k.apply({ type: "playItem", pid: 0, cardId: "i10", target: 1 }, 0);
      let t = 0;
      while (k.state.turn === 1 && t <= 4_000) {
        t += 100;
        k.tick(t);
      }
      const p1 = k.state.players[1]!;
      if (k.state.turn === 2 && p1.walk?.remaining === -2 && p1.trail.length >= 2) return seed;
    } catch {
      // 换种子
    }
  }
  throw new Error("找不到弹弓回退 2 挂账的种子");
}

/** 搜种子：小黄在窗 2 的掷面恰为 target（不带道具的纯流程——测脚镣削面时对照） */
function seedForBot1Window2Roll(target: number): number {
  for (let seed = 1; seed < 8000; seed++) {
    try {
      const k = bootFixed({ seed, windowMs: 2_000, restMs: 0 });
      let t = 0;
      let found: number | null = null;
      while (found == null && t < 10_000) {
        t += 100;
        const fx = k.tick(t);
        if (k.state.turn < 2) continue;
        const r = fx.find((f) => f.type === "roll" && f.pid === 1);
        if (r && r.type === "roll") found = r.d;
      }
      if (found === target) return seed;
    } catch {
      // 换种子
    }
  }
  throw new Error(`找不到小黄窗 2 掷 ${target} 的种子`);
}

/** 走到道具格摸 1 张的盘面（默认 4 人盘；搜「首掷 1 步落 I 格」） */
function bootOntoItemCell(): GameKernel {
  for (const ic of BOARD) {
    if (ic.type !== "I") continue;
    for (const aId of ic.links) {
      const a = BOARD[aId]!;
      if (a.links.length !== 2) continue;
      const bId = a.links.find((x) => x !== ic.id);
      if (bId == null) continue;
      const pre = { pos: a.id, from: bId, net: 5 };
      const k = boot({ seed: seedForFirstDie(1, pre) });
      k.apply({ type: "dev.setPos", pid: 0, pos: pre.pos, from: pre.from, net: pre.net }, 0);
      return k;
    }
  }
  throw new Error("找不到道具格停靠位");
}

describe("表一 20 张全量对表（编号/路由/违禁/文案；T4b2 收口）", () => {
  const EXPECTED: Array<{ id: string; no: number; title: string; route: string; contraband?: boolean }> = [
    { id: "i01", no: 1, title: "顺风靴", route: "self" },
    { id: "i02", no: 2, title: "时光怀表", route: "self" },
    { id: "i03", no: 3, title: "香蕉皮", route: "ground", contraband: true },
    { id: "i04", no: 4, title: "治疗药水", route: "self" },
    { id: "i05", no: 5, title: "万能药", route: "self" },
    { id: "i06", no: 6, title: "火箭鞋", route: "self" },
    { id: "i07", no: 7, title: "脚镣", route: "chooseOther", contraband: true },
    { id: "i08", no: 8, title: "偷天换日", route: "chooseOther", contraband: true },
    { id: "i09", no: 9, title: "小圆盾", route: "self" },
    { id: "i10", no: 10, title: "弹弓", route: "chooseOther", contraband: true },
    { id: "i11", no: 11, title: "幸运骰", route: "self" },
    { id: "i12", no: 12, title: "双倍惊喜", route: "self" },
    { id: "i13", no: 13, title: "雷暴", route: "ambient", contraband: true },
    { id: "i14", no: 14, title: "护身符", route: "self" },
    { id: "i15", no: 15, title: "加倍骰", route: "self" },
    { id: "i16", no: 16, title: "狗笛", route: "chooseOther", contraband: true },
    { id: "i17", no: 17, title: "地雷", route: "ground", contraband: true },
    { id: "i18", no: 18, title: "清障符", route: "self" },
    { id: "i19", no: 19, title: "暴雨", route: "ambient" },
    { id: "i20", no: 20, title: "风暴", route: "ambient" },
  ];

  it("表一 20 张全量逐张对上：id/编号/卡名/路由（T4a 10 + T4b1 7 + T4b2 3 收口）", () => {
    expect(ITEM_CARDS.length).toBe(20);
    expect(M1_ITEM_POOL.length).toBe(20); // 全池到齐：单池结构不变，环境卡 3 张并入
    for (const e of EXPECTED) {
      const c = ITEM_CARDS.find((x) => x.no === e.no);
      expect(c, `表一 #${e.no}`).toBeDefined();
      expect(c!.id).toBe(e.id);
      expect(c!.title).toBe(e.title);
      expect(c!.route).toBe(e.route);
      expect(!!c!.contraband).toBe(!!e.contraband);
    }
    const byRoute = (r: string) => ITEM_CARDS.filter((c) => c.route === r).length;
    expect(byRoute("self")).toBe(11);
    expect(byRoute("chooseOther")).toBe(4);
    expect(byRoute("ground")).toBe(2);
    expect(byRoute("auto")).toBe(0); // 表一未标 auto 的道具卡——auto 路由机制 T4b1 已立，真人消费卡留后续票
    expect(byRoute("ambient")).toBe(3); // 表一环境卡 3 张（雷暴劈人/暴雨摔倒/风暴压制）
    expect(ITEM_CARDS.every((c) => c.flavor.length > 0)).toBe(true);
  });

  it("效果数值逐卡对表（表一效果列 → 原语断言）", () => {
    const cid = (no: number) => ITEM_CARDS.find((x) => x.no === no)!.id;
    expect(itemCard(cid(2)).parts).toEqual([{ type: "reroll" }]);
    expect(itemCard(cid(4)).parts).toEqual([{ type: "hp", v: 2 }]);
    expect(itemCard(cid(5)).parts).toEqual([{ type: "hp", v: 4 }]);
    expect(itemCard(cid(6)).parts).toEqual([{ type: "move", v: 3 }]);
    expect(itemCard(cid(7)).parts).toEqual([{ type: "rollMod", mods: [{ mode: "cut", v: 1, src: "脚镣", wear: true }] }]);
    expect(itemCard(cid(8)).parts).toEqual([{ type: "swap" }]);
    expect(itemCard(cid(9)).parts).toEqual([{ type: "roundShield" }]);
    expect(itemCard(cid(10)).parts).toEqual([{ type: "back", v: 2 }]);
    expect(itemCard(cid(11)).parts).toEqual([{ type: "rollMod", mods: [{ mode: "floor", v: 6, src: "幸运骰" }] }]);
    expect(itemCard(cid(12)).parts).toEqual([{ type: "drawItem", v: 2 }]);
    expect(itemCard(cid(14)).parts).toEqual([{ type: "talisman" }]);
    expect(itemCard(cid(15)).parts).toEqual([{ type: "rollMod", mods: [{ mode: "raise", v: 2, src: "加倍骰" }] }]); // 1d10→1d12
    expect(itemCard(cid(18)).parts).toEqual([{ type: "clearGround", v: 3 }]);
    // 狗笛：效果=T6b 野狗生成原语（表一 #16 接口——生成账在 dogs.test 收账）；违禁在列
    expect(itemCard(cid(16)).parts).toEqual([{ type: "dogSpawn" }]);
    expect(itemCard(cid(16)).contraband).toBe(true);
    expect(itemCard(cid(1)).parts).toEqual([{ type: "rollMod", mods: [{ mode: "flat", v: 3, src: "顺风靴" }] }]);
  });

  it("违禁 7 张全池字段贯通且全在表一走私清单内（T4b2 雷暴落池凑齐）", () => {
    const flagged = ITEM_CARDS.filter((c) => c.contraband).map((c) => c.title).sort();
    expect(flagged).toEqual(["地雷", "弹弓", "偷天换日", "狗笛", "脚镣", "香蕉皮", "雷暴"].sort());
    for (const t of flagged) expect(CONTRABAND_TITLES).toContain(t);
    expect(CONTRABAND_TITLES.length).toBe(7);
    expect([...CONTRABAND_TITLES].sort()).toEqual(flagged); // 全池对齐：走私清单=表一违禁 7 张
  });

  it("每张有场景文案；场地卡带踩上判定（香蕉皮 DC8／地雷 DC12）", () => {
    for (const c of ITEM_CARDS) expect(c.flavor.length).toBeGreaterThan(0);
    const banana = ITEM_CARDS.find((c) => c.title === "香蕉皮")!;
    const mine = ITEM_CARDS.find((c) => c.title === "地雷")!;
    expect(banana.ground!.check).toMatchObject({ axis: "agile", dc: 8 });
    expect(mine.ground!.check).toMatchObject({ axis: "agile", dc: 12 });
    expect(banana.route).toBe("ground");
  });
});

describe("摸卡链（道具格 → 手牌，单池守恒）", () => {
  it("走停道具格摸 1 张进手牌（牌堆 -1、弃牌堆不动、战报不提卡名——手牌保密 T7 前置）", () => {
    const k = bootOntoItemCell();
    const before = me(k).hand.length;
    const deckBefore = k.state.itemDeck.length;
    const fx = k.apply({ type: "roll", pid: 0 }, 0);
    expect(dieOf(fx)).toBe(1);
    walkOut(k, 0);
    expect(me(k).hand.length).toBe(before + 1);
    expect(k.state.itemDeck.length).toBe(deckBefore - 1);
    expect(k.state.itemDiscard.length).toBe(0);
    const msg = k.state.messages.find((m) => m.kind === "item" && m.text.includes("踩上道具格，摸到 1 张道具卡"));
    expect(msg?.who).toBe(0);
    // 手牌保密口径（T7 谎报前置）：播报只报张数、不提卡名
    expect(msg!.text).toBe("你 踩上道具格，摸到 1 张道具卡，收入手牌。");
  });

  it("抽空即弃牌堆整堆洗回（不丢不重）", () => {
    const k = bootOntoItemCell();
    const inHands = new Set(k.state.players.flatMap((p) => p.hand));
    const free = M1_ITEM_POOL.map((c) => c.id).filter((id) => !inHands.has(id)); // 手上已有的不算在堆里
    k.state.itemDeck = [];
    k.state.itemDiscard = [...free];
    void k.apply({ type: "roll", pid: 0 }, 0);
    walkOut(k, 0);
    expect(k.state.itemDeck.length).toBe(free.length - 1); // 洗回整堆后抽走一张
    expect(k.state.itemDiscard.length).toBe(0);
    const all = [...k.state.itemDeck, ...k.state.itemDiscard, ...k.state.players.flatMap((p) => p.hand)].sort();
    expect(all).toEqual(M1_ITEM_POOL.map((c) => c.id).sort());
  });

  it("双堆皆空：摸个空提示，手牌不变不炸", () => {
    const k = bootOntoItemCell();
    k.state.itemDeck = [];
    k.state.itemDiscard = [];
    const before = me(k).hand.length;
    void k.apply({ type: "roll", pid: 0 }, 0);
    walkOut(k, 0);
    expect(me(k).hand.length).toBe(before);
    expect(k.state.messages.some((m) => m.text.includes("道具牌堆见空") && m.text.includes("少摸了 1 张"))).toBe(true);
  });

  it("手牌无上限：连塞 6 张不拒；连打 2 张照常（选不自膨胀的效果卡）", () => {
    const k = bootFixed();
    const toGive = ["i01", "i12", "i06", "i03", "i05"]; // 效果不自膨胀手牌的卡（避开双倍惊喜摸 2）
    for (const id of toGive) ensureHand(k, 0, id);
    ensureHand(k, 0, "i04");
    expect(me(k).hand.length).toBeGreaterThan(5); // 开局 +1 且无上限
    const before = me(k).hand.length;
    k.apply({ type: "playItem", pid: 0, cardId: "i04" }, 0);
    k.apply({ type: "playItem", pid: 0, cardId: "i05" }, 0);
    expect(me(k).hand.length).toBe(before - 2); // 连打逐张出袋
  });
});

describe("时机锁（确认结束之前窗内任意时刻、张数不限；确认后锁）", () => {
  it("开局抽牌期不能打（只有世界回合窗内）", () => {
    const { kernel } = GameKernel.create({ allowDev: true }, 0);
    kernel.apply({ type: "dev.giveItem", pid: 0, cardId: "i04" }, 0);
    expect(() => kernel.apply({ type: "playItem", pid: 0, cardId: "i04" }, 0)).toThrow(/只有世界回合窗内/);
  });

  it("休息期不能打", () => {
    const k = boot({ windowMs: 100, restMs: 5_000 });
    ensureHand(k, 0, "i04");
    k.tick(200);
    expect(k.state.phase).toBe("rest");
    expect(() => k.apply({ type: "playItem", pid: 0, cardId: "i04" }, 1000)).toThrow(/只有世界回合窗内/);
  });

  it("确认结束进等待区后不能再打（掷前能打、确认即锁）", () => {
    const k = boot({ seed: seedForFirstDie(3, PRE_ITEM_RUN) });
    k.apply({ type: "dev.setPos", pid: 0, pos: PRE_ITEM_RUN.pos, from: PRE_ITEM_RUN.from, net: PRE_ITEM_RUN.net }, 0);
    ensureHand(k, 0, "i04");
    k.apply({ type: "playItem", pid: 0, cardId: "i04" }, 0); // 掷前即可打
    k.apply({ type: "roll", pid: 0 }, 0);
    walkOut(k, 0);
    k.apply({ type: "confirm", pid: 0 }, 2_000);
    expect(me(k).confirmed).toBe(true);
    ensureHand(k, 0, "i11");
    expect(() => k.apply({ type: "playItem", pid: 0, cardId: "i11" }, 3_000)).toThrow(/已确认结束/);
  });

  it("连打多张且生效有序（双倍惊喜→火箭鞋→治疗药水：打出与结算逐条同序落入战报）", () => {
    const k = bootFixed();
    k.apply({ type: "dev.setHp", pid: 0, hp: 5 }, 0);
    for (const id of ["i12", "i06", "i04"]) ensureHand(k, 0, id);
    const before = k.state.messages.length;
    const fx1 = k.apply({ type: "playItem", pid: 0, cardId: "i12" }, 0);
    expect(fx1.some((f) => f.type === "itemPlayed" && f.cardId === "i12")).toBe(true);
    k.apply({ type: "playItem", pid: 0, cardId: "i06" }, 0);
    // 火箭鞋走格中：照样能打（第 3 张）
    k.apply({ type: "playItem", pid: 0, cardId: "i04" }, 20);
    expect(me(k).hp).toBe(7);
    expect(me(k).walk?.remaining).toBe(3); // 火箭鞋立即前进 3
    const texts = k.state.messages.slice(before).filter((m) => m.who === 0).map((m) => m.text);
    expect(texts).toEqual([
      "你 打出「双倍惊喜」",
      "你 摸到 2 张道具卡，收入手牌。",
      "你 打出「火箭鞋」",
      "你 前进 3 格。",
      "你 打出「治疗药水」",
      "你 回 2 血（剩 7/10）",
    ]);
  });

  it("超时替掷不替打卡：替掷+自动确认两步走，手牌原样", () => {
    const k = bootFixed({ windowMs: 200, restMs: 0 });
    ensureHand(k, 0, "i04");
    k.apply({ type: "dev.setHp", pid: 0, hp: 5 }, 0);
    const fx = k.tick(300);
    expect(fx.some((f) => f.type === "roll" && f.pid === 0 && f.auto)).toBe(true);
    expect(fx.some((f) => f.type === "confirm" && f.pid === 0 && f.auto)).toBe(true);
    expect(fx.some((f) => f.type === "itemPlayed")).toBe(false);
    expect(me(k).hand).toContain("i04");
    expect(me(k).hp).toBe(5);
    expect(k.state.itemDiscard.length).toBe(0);
    expect(k.state.messages.some((m) => m.text.includes("系统替 你 掷骰"))).toBe(true);
  });

  it("通关席只留整蛊（chooseOther）口子（自用/场地拒）；淘汰者一律拒", () => {
    const k = bootFixed();
    const p = k.state.players[0]!;
    p.zone = "done";
    p.confirmed = true; // finishAtSeat 的落定形态
    for (const id of ["i10", "i04", "i03"]) ensureHand(k, 0, id);
    expect(() => k.apply({ type: "playItem", pid: 0, cardId: "i04" }, 0)).toThrow(/通关席/);
    expect(() => k.apply({ type: "playItem", pid: 0, cardId: "i03" }, 0)).toThrow(/通关席/); // 场地卡会搁在出生格，一并收紧
    k.apply({ type: "playItem", pid: 0, cardId: "i10", target: 1 }, 0); // 弹弓：整蛊照打
    expect(k.state.deferred.at(-1)!.pid).toBe(1);

    k.apply({ type: "dev.setDead", pid: 2 }, 0);
    k.apply({ type: "dev.giveItem", pid: 2, cardId: "i10" }, 0); // 从弃牌堆取（你刚打出的那张）
    expect(() => k.apply({ type: "playItem", pid: 2, cardId: "i10" }, 0)).toThrow(/淘汰/);
  });

  it("罚停轮空窗不能出手（拒因点名罚停而非等待区）", () => {
    const k = bootFixed({ windowMs: 100, restMs: 0 });
    ensureHand(k, 0, "i04");
    k.state.players[0]!.stun = 1;
    k.tick(150); // 窗 2 开：罚停消耗 + 轮空标记
    expect(me(k).skipped).toBe(true);
    expect(() => k.apply({ type: "playItem", pid: 0, cardId: "i04" }, 200)).toThrow(/罚停/);
  });
});

describe("三类目标路由（self / chooseOther / ground）", () => {
  it("self 立即结算：万能药回 4 封顶上限", () => {
    const k = bootFixed();
    ensureHand(k, 0, "i05");
    k.apply({ type: "dev.setHp", pid: 0, hp: 8 }, 0);
    k.apply({ type: "playItem", pid: 0, cardId: "i05" }, 0);
    expect(me(k).hp).toBe(10);
  });

  it("chooseOther 合法性：缺目标/指自己/指不存在/指淘汰/指通关席/自用卡带目标——全拒；合法目标出袋", () => {
    const k = bootFixed();
    ensureHand(k, 0, "i10");
    expect(() => k.apply({ type: "playItem", pid: 0, cardId: "i10" }, 0)).toThrow(/要先选一个目标/);
    expect(() => k.apply({ type: "playItem", pid: 0, cardId: "i10", target: 0 }, 0)).toThrow(/不可选/);
    expect(() => k.apply({ type: "playItem", pid: 0, cardId: "i10", target: 9 }, 0)).toThrow(/不存在/);
    k.apply({ type: "dev.setDead", pid: 2 }, 0);
    expect(() => k.apply({ type: "playItem", pid: 0, cardId: "i10", target: 2 }, 0)).toThrow(/不可选/);
    k.state.players[3]!.zone = "done";
    expect(() => k.apply({ type: "playItem", pid: 0, cardId: "i10", target: 3 }, 0)).toThrow(/不可选/);
    // 合法目标集合（壳层目标选择器共用口径）：剩 [1]
    expect(itemLegalTargets(k.state, 0, "i10")).toEqual([1]);
    expect(itemLegalTargets(k.state, 0, "i04")).toEqual([]); // 非 chooseOther
    k.apply({ type: "playItem", pid: 0, cardId: "i10", target: 1 }, 0);
    expect(me(k).hand).not.toContain("i10");
    expect(k.state.itemDiscard).toContain("i10");
    // self 卡带目标 → 拒
    ensureHand(k, 0, "i04");
    expect(() => k.apply({ type: "playItem", pid: 0, cardId: "i04", target: 1 }, 0)).toThrow(/不需要目标/);
    // 打出闸直查（壳层置灰共用）
    expect(itemPlayGate(k.state, 0, "i99")).toEqual({ ok: false, reason: "道具卡 i99 不在表一" });
    expect(itemPlayGate(k.state, 0, "i04").ok).toBe(true);
  });

  it("chooseOther 世界·即时：下回合生效（弹弓退 2 沿来路栈），当窗只有预告", () => {
    const seed = seedForFlick();
    const k = bootFixed({ seed, windowMs: 4_000, restMs: 0 });
    ensureHand(k, 0, "i10");
    k.apply({ type: "playItem", pid: 0, cardId: "i10", target: 1 }, 0);
    expect(k.state.deferred).toEqual([{ pid: 1, parts: [{ type: "back", v: 2 }], kind: "item", srcPid: 0, grudgeLabel: "弹弓" }]);
    expect(k.state.messages.some((m) => m.text.includes("下一世界回合开始时结算：小黄"))).toBe(true);
    let t = 0;
    while (k.state.turn === 1 && t <= 4_000) {
      t += 100;
      k.tick(t);
    }
    const p1 = k.state.players[1]!;
    expect(p1.walk?.remaining).toBe(-2); // 开窗即落账
    const trailBefore = [...p1.trail];
    const netBefore = p1.net;
    const openAt = t; // 循环退出时刻=开窗那一拍
    k.tick(openAt + 140);
    k.tick(openAt + 280);
    expect(p1.net).toBe(netBefore - 2);
    expect(p1.trail.length).toBe(trailBefore.length - 2);
    expect(p1.pos).toBe(trailBefore[trailBefore.length - 2]); // 沿来路栈原路退
  });

  it("chooseOther 轮班·限时：立刻生效（同盘 world 走挂账对照）", () => {
    const k = bootFixed({ timerMode: "turn" });
    ensureHand(k, 0, "i07");
    k.apply({ type: "playItem", pid: 0, cardId: "i07", target: 1 }, 0);
    expect(k.state.deferred).toHaveLength(0);
    expect(k.state.players[1]!.rollMods).toHaveLength(1); // 脚镣当场落账
    ensureHand(k, 0, "i10");
    k.apply({ type: "playItem", pid: 0, cardId: "i10", target: 1 }, 0);
    expect(k.state.players[1]!.walk?.remaining).toBe(-2); // 弹弓当场起走
  });
});

describe("场地型附着（香蕉皮/地雷）：踩上触发后消失", () => {
  it("他人踩上香蕉皮：敏检 DC8 败=罚停 1；触发即消失（卡片回池入弃牌堆）", () => {
    const script = groundStepScript("i03");
    const seed = seedForGroundCheck(script, (raw) => raw <= 6); // 黑市老板敏 1：raw≤6 败
    const k = bootFixed({ seed });
    script(k);
    expect(k.state.players[1]!.stun).toBe(1);
    expect(k.state.ground).toHaveLength(0);
    expect(k.state.itemDiscard).toContain("i03"); // 消耗回池（弃牌堆）
    expect(k.state.messages.some((m) => m.text.includes("小黄 一脚踩上「香蕉皮」（你 布的）——判定！"))).toBe(true);
    expect(k.state.messages.some((m) => m.text.includes("vs DC8") && m.text.includes("小黄"))).toBe(true);
    expect(k.state.messages.some((m) => m.text.includes("被罚停 1 回合"))).toBe(true);
  });

  it("他人踩上香蕉皮：过=安全；同样触发即消失", () => {
    const script = groundStepScript("i03");
    const seed = seedForGroundCheck(script, (raw) => raw >= 7);
    const k = bootFixed({ seed });
    script(k);
    expect(k.state.players[1]!.stun).toBe(0);
    expect(k.state.ground).toHaveLength(0);
  });

  it("地雷：敏检 DC12 败=扣 1 血+罚停 1；过=安全；均触发即消失", () => {
    const script = groundStepScript("i17");
    const failSeed = seedForGroundCheck(script, (raw) => raw <= 10);
    const k = bootFixed({ seed: failSeed });
    script(k);
    expect(k.state.players[1]!.hp).toBe(9);
    expect(k.state.players[1]!.stun).toBe(1);
    expect(k.state.ground).toHaveLength(0);
    expect(k.state.messages.some((m) => m.text.includes("小黄 一脚踩上「地雷」（你 布的）——判定！"))).toBe(true);
    expect(k.state.messages.some((m) => m.text.includes("vs DC12") && m.text.includes("小黄"))).toBe(true);

    const passSeed = seedForGroundCheck(script, (raw) => raw >= 11);
    const k2 = bootFixed({ seed: passSeed });
    script(k2);
    expect(k2.state.players[1]!.hp).toBe(10);
    expect(k2.state.players[1]!.stun).toBe(0);
    expect(k2.state.ground).toHaveLength(0); // 过也消失
  });

  it("含铺设者本人：自己踩回自己布的香蕉皮照吃", () => {
    const script = (k: GameKernel) => {
      ensureHand(k, 0, "i03");
      k.apply({ type: "playItem", pid: 0, cardId: "i03" }, 0); // 你（出生格 6,0）搁下
      k.apply({ type: "dev.setPos", pid: 0, pos: cell(7, 0), from: cell(6, 0), net: 0 }, 0);
      k.apply({ type: "dev.back", pid: 0, steps: 1 }, 0); // 退一步踩回
      walkOut(k, 0);
    };
    const seed = seedForGroundCheck(script, () => true);
    const k = bootFixed({ seed });
    script(k);
    expect(k.state.ground).toHaveLength(0);
    expect(k.state.messages.some((m) => m.text.includes("你 一脚踩上「香蕉皮」（自己布的）——判定！"))).toBe(true);
  });

  it("穿格不停不触发：走过香蕉皮那格、停在别处——卡还在", () => {
    // 搜种子：首掷=3 且香蕉皮没被先摸走（假人随机角色可能「轻装上阵」开局 +1——牌池扩容换流后的收口口径）
    const PRE = { pos: cell(8, 0), from: cell(9, 0), net: 0 };
    let seed = 0;
    for (let s = 1; s < 5000 && !seed; s++) {
      const k = boot({ seed: s });
      if (!tryGiveItem(k, 0, "i03", 0)) continue;
      k.apply({ type: "dev.setPos", pid: 0, pos: PRE.pos, from: PRE.from, net: PRE.net }, 0);
      const fx = k.apply({ type: "roll", pid: 0 }, 0);
      if (dieOf(fx) === 3) seed = s;
    }
    expect(seed).toBeGreaterThan(0);
    const k = boot({ seed });
    ensureHand(k, 0, "i03");
    k.apply({ type: "playItem", pid: 0, cardId: "i03" }, 0); // 出生格 (6,0) 搁下
    k.apply({ type: "dev.setPos", pid: 0, pos: cell(8, 0), from: cell(9, 0), net: 0 }, 0);
    const fx = k.apply({ type: "roll", pid: 0 }, 0);
    expect(dieOf(fx)).toBe(3);
    walkOut(k, 0);
    expect(me(k).pos).toBe(cell(5, 0)); // 3 步经过 (7,0)/(6,0) 停在 (5,0)（香蕉皮在 (6,0) 没被踩停）
    expect(k.state.ground).toHaveLength(1);
    expect(k.state.messages.some((m) => m.text.includes("一脚踩上"))).toBe(false);
  });

  it("同格叠两张：踩上按落卡先后逐张判定、逐张消失", () => {
    const script = (k: GameKernel) => {
      for (const id of ["i03", "i17"]) {
        ensureHand(k, 0, id);
        k.apply({ type: "playItem", pid: 0, cardId: id }, 0);
      }
      k.apply({ type: "dev.setPos", pid: 1, pos: cell(7, 0), from: cell(6, 0), net: 0 }, 0);
      k.apply({ type: "dev.back", pid: 1, steps: 1 }, 0);
      walkOut(k, 0);
    };
    const seed = seedForGroundCheck(script, () => true);
    const k = bootFixed({ seed });
    script(k);
    expect(k.state.ground).toHaveLength(0);
    const hits = k.state.messages.filter((m) => m.text.includes("一脚踩上")).map((m) => m.text);
    expect(hits[0]).toContain("香蕉皮");
    expect(hits[1]).toContain("地雷");
  });

  it("搁下当下不触发：踩上判定要等下一次走停落在该格（自己站着不算）；附着期间卡片不入弃牌堆", () => {
    const k = bootFixed();
    ensureHand(k, 0, "i03");
    k.apply({ type: "playItem", pid: 0, cardId: "i03" }, 0);
    expect(k.state.ground).toHaveLength(1);
    expect(k.state.itemDiscard).not.toContain("i03"); // 离池挂在格上，触发才入账
    expect(me(k).stun).toBe(0);
    expect(k.state.messages.some((m) => m.text.includes("一脚踩上"))).toBe(false);
  });
});

describe("走格骰修正（顺风靴 +3／幸运骰保底／脚镣削面／轻装上阵减半）", () => {
  it("顺风靴：下次走格骰 +3（5→8）且一次性消费", () => {
    const k = boot({ seed: seedForFirstDie(5) });
    ensureHand(k, 0, "i01");
    k.apply({ type: "playItem", pid: 0, cardId: "i01" }, 0);
    const fx = k.apply({ type: "roll", pid: 0 }, 0);
    expect(dieOf(fx)).toBe(8);
    const rollF = fx.find((f) => f.type === "roll" && f.pid === 0);
    expect(rollF?.type === "roll" && rollF.mods?.[0]).toMatchObject({ mode: "flat", v: 3, src: "顺风靴" });
    expect(me(k).walk?.remaining).toBe(8);
    expect(me(k).rollMods).toHaveLength(0);
    expect(k.state.messages.some((m) => m.text.includes("走格骰 5（顺风靴 +3）= 8 步"))).toBe(true);
  });

  it("幸运骰：保底 ≥6（低面抬到 6；高面不动）", () => {
    const k = boot({ seed: seedForFirstDie(2) });
    ensureHand(k, 0, "i11");
    k.apply({ type: "playItem", pid: 0, cardId: "i11" }, 0);
    const fx = k.apply({ type: "roll", pid: 0 }, 0);
    expect(dieOf(fx)).toBe(6);
    expect(k.state.messages.some((m) => m.text.includes("幸运骰 保底 6"))).toBe(true);

    const k2 = boot({ seed: seedForFirstDie(7) });
    ensureHand(k2, 0, "i11");
    k2.apply({ type: "playItem", pid: 0, cardId: "i11" }, 0);
    expect(dieOf(k2.apply({ type: "roll", pid: 0 }, 0))).toBe(7);
  });

  it("脚镣：目标下次走格骰削面 1（该掷 10 → 9）且一次性消费", () => {
    const seed = seedForBot1Window2Roll(10);
    const k = bootFixed({ seed, windowMs: 2_000, restMs: 0 });
    ensureHand(k, 0, "i07");
    k.apply({ type: "playItem", pid: 0, cardId: "i07", target: 1 }, 0);
    let t = 0;
    while (k.state.turn === 1 && t <= 2_000) {
      t += 100;
      k.tick(t);
    }
    const p1 = k.state.players[1]!;
    expect(p1.rollMods).toHaveLength(1); // 开窗落账
    let d: number | null = null;
    while (d == null && t < 10_000) {
      t += 100;
      const fx = k.tick(t);
      const r = fx.find((f) => f.type === "roll" && f.pid === 1);
      if (r && r.type === "roll") d = r.d;
    }
    expect(d).toBe(9);
    expect(p1.rollMods).toHaveLength(0);
    expect(k.state.messages.some((m) => m.text.includes("脚镣 削面 1"))).toBe(true);
  });

  it("轻装上阵被动：穿戴类负面减半（1 层只算半层，不立即落账）", () => {
    const k = bootDefs(
      [
        { name: "你", isBot: false, roleId: "light" },
        { name: "小黄", isBot: true, roleId: "light" },
      ],
      { restMs: 0 },
    );
    ensureHand(k, 0, "i07");
    k.apply({ type: "playItem", pid: 0, cardId: "i07", target: 1 }, 0);
    k.tick(30_000); // 满窗收口 → 窗 2 开窗落账
    const p1 = k.state.players[1]!;
    expect(p1.rollMods).toHaveLength(0);
    expect(p1.wearHalves).toBe(1);
    expect(k.state.messages.some((m) => m.text.includes("只算半层（1/2）"))).toBe(true);
  });

  it("轻装上阵被动：2 层并 1（半分账满格折 1 层真效果）", () => {
    const k = bootDefs(
      [
        { name: "你", isBot: false, roleId: "light" },
        { name: "小黄", isBot: true, roleId: "light" },
      ],
      { restMs: 0 },
    );
    k.state.players[1]!.wearHalves = 1; // 已挂一层（前一次穿戴负面）
    ensureHand(k, 0, "i07");
    k.apply({ type: "playItem", pid: 0, cardId: "i07", target: 1 }, 0);
    k.tick(30_000);
    const p1 = k.state.players[1]!;
    expect(p1.wearHalves).toBe(0);
    expect(p1.rollMods).toHaveLength(1);
    expect(k.state.messages.some((m) => m.text.includes("两层并一层"))).toBe(true);
  });
});

describe("单池守恒与 dev 闸", () => {
  it("全自动整局跑完：道具卡守恒（牌堆+弃牌堆+各人手牌+场上附着 = 全池，不丢不重）", () => {
    const k = boot({ seed: 42 });
    let t = 0;
    while (k.state.phase !== "over" && t <= 750_000) {
      t += 1_000;
      k.tick(t);
    }
    expect(k.state.phase).toBe("over");
    const all = [
      ...k.state.itemDeck,
      ...k.state.itemDiscard,
      ...k.state.players.flatMap((p) => p.hand),
      ...k.state.ground.map((g) => g.cardId),
    ].sort();
    expect(all).toEqual(M1_ITEM_POOL.map((c) => c.id).sort());
  });

  it("dev.giveItem 受 allowDev 闸；playItem 是正式意图（走手牌校验）", () => {
    const { kernel } = GameKernel.create({ seed: 42 }, 0);
    expect(() => kernel.apply({ type: "dev.giveItem", pid: 0, cardId: "i04" }, 0)).toThrow(/dev 意图未开放/);
    kernel.apply({ type: "chooseSecret", pid: 0, pick: 0 }, 0);
    const hand = kernel.state.players[0]!.hand;
    const notInHand = M1_ITEM_POOL.find((c) => !hand.includes(c.id))!;
    expect(() => kernel.apply({ type: "playItem", pid: 0, cardId: notInHand.id }, 0)).toThrow(/不在你的手牌/);
  });

  it("轻装上阵开局手牌 +1（角色被动落数）", () => {
    const k = bootFixed();
    expect(me(k).hand).toHaveLength(1);
    expect(k.state.players[1]!.hand).toHaveLength(0); // 黑市老板无手牌被动
    expect(k.state.messages.some((m) => m.text.includes("轻装上阵被动：开局手牌 +1"))).toBe(true);
  });
});

// ---------- T4b1：auto 自动指认（卡面写死指认规则；淘汰者/通关席跳过） ----------

describe("auto 自动指认路由（T4b1 fixture 卡走全链）", () => {
  it("x01 随机指认（world·即时）：系统指认+deferred 挂账+下一窗结算；打了带目标/淘汰者指不上/带 target 拒", () => {
    const k = bootFixed({ restMs: 0 });
    handPut(k, 0, "x01");
    k.apply({ type: "dev.setDead", pid: 3 }, 0); // 淘汰者先出池
    // auto 卡带 target → 拒（系统指认不吃手选）
    expect(() => k.apply({ type: "playItem", pid: 0, cardId: "x01", target: 1 }, 0)).toThrow(/系统指认/);
    expect(itemLegalTargets(k.state, 0, "x01")).toEqual([]); // auto 不出目标选择器
    k.apply({ type: "playItem", pid: 0, cardId: "x01" }, 0);
    const d = k.state.deferred.find((x) => x.parts[0]?.type === "back")!;
    expect(d.parts).toEqual([{ type: "back", v: 1 }]); // 随机指认鞭:退 1
    expect(d.srcPid).toBe(0);
    expect(d.pid).not.toBe(3); // 淘汰者不进指认池（同款断言由 x02/x03 的让位用例收账）
    expect(k.state.messages.some((m) => m.text.includes("打出「测试·随机指认鞭」（系统指认）"))).toBe(true);
    expect(me(k).hand).not.toContain("x01");
    // 下一窗开窗结算：退 1 沿来路栈（挂账完工、deferred 清空即可断）
    playThroughP0(k, 100);
    void k.tick(30_000); // 超窗收口 → 窗 2 开窗即结算 deferred
    expect(k.state.turn).toBe(2);
    expect(k.state.deferred).toHaveLength(0);
  });

  it("x02 指认最近者（world）：净步最高者吃罚停（下一窗开窗即结算、当窗轮空）；落空无虞", () => {
    const k = bootFixed({ restMs: 0 });
    handPut(k, 0, "x02");
    k.apply({ type: "dev.setPos", pid: 1, pos: k.state.players[1]!.pos, from: null, net: 50 }, 0);
    k.apply({ type: "playItem", pid: 0, cardId: "x02" }, 0);
    expect(k.state.deferred.at(-1)!.pid).toBe(1);
    playThroughP0(k, 100);
    void k.tick(30_000);
    expect(k.state.turn).toBe(2);
    // 开窗即结算挂账罚停 → 当窗轮空（stun 已消耗、标记 skipped）
    expect(k.state.players[1]!.stun).toBe(0);
    expect(k.state.players[1]!.skipped).toBe(true);
    expect(k.state.messages.some((m) => m.text.includes("罚停生效——本回合轮空"))).toBe(true);
  });

  it("x02 指认最近者（turn·轮班=立刻生效）：当场挂上罚停（下窗才消耗）；淘汰让位次高者", () => {
    const k = bootFixed({ timerMode: "turn" });
    handPut(k, 0, "x02");
    k.apply({ type: "dev.setPos", pid: 1, pos: k.state.players[1]!.pos, from: null, net: 50 }, 0);
    k.apply({ type: "playItem", pid: 0, cardId: "x02" }, 0);
    expect(k.state.deferred).toHaveLength(0);
    expect(k.state.players[1]!.stun).toBe(1); // 立刻生效：stun 池挂上下窗消耗
    // 净步最高者出局 → 指认落到次高（p2 net 10）
    handPut(k, 0, "x02");
    k.state.players[0]!.hand.push("x02"); // fixture 不守恒，直接塞第二张
    k.apply({ type: "dev.setPos", pid: 2, pos: k.state.players[2]!.pos, from: null, net: 10 }, 0);
    k.apply({ type: "dev.setDead", pid: 1 }, 0);
    void k.apply({ type: "playItem", pid: 0, cardId: "x02" }, 0);
    expect(k.state.players[2]!.stun).toBe(1); // 拿到次高名额
  });

  it("x03 指认最远者（turn·轮班）：净步最低者自家退 2（含打出者自己；淘汰出局让位）", () => {
    const k = bootFixed({ timerMode: "turn" });
    handPut(k, 0, "x03");
    k.apply({ type: "dev.setPos", pid: 1, pos: k.state.players[1]!.pos, from: null, net: 1 }, 0);
    k.apply({ type: "playItem", pid: 0, cardId: "x03" }, 0);
    // 指认池全活人净步 0/1 → 最低=p0（净步 0、id 破平）——系统指认不避打出者
    expect(k.state.players[0]!.walk?.remaining).toBe(-2);
    expect(k.state.players[1]!.walk).toBeNull();
  });

  it("通关席留 auto 整蛊口子（chooseOther/auto 放行；self/ground 拒）", () => {
    const k = bootFixed();
    const p = k.state.players[0]!;
    p.zone = "done";
    p.confirmed = true;
    handPut(k, 0, "x02");
    handPut(k, 0, "i04");
    handPut(k, 0, "i03");
    expect(itemPlayGate(k.state, 0, "x02").ok).toBe(true);
    k.apply({ type: "playItem", pid: 0, cardId: "x02" }, 0);
    expect(itemPlayGate(k.state, 0, "i04")).toEqual({ ok: false, reason: expect.stringContaining("通关席") });
    expect(itemPlayGate(k.state, 0, "i03").ok).toBe(false);
  });
});

// ---------- T4b1：7 张新卡效果 ----------

describe("时光怀表（重掷本次走格骰）", () => {
  it("重掷：先走步数照算，新面替换余步；重掷战报点名怀表", () => {
    const pre = { pos: cell(8, 0), from: cell(9, 0), net: 0 }; // 直线段 (9)→(8)→(7)→(6)→(5)（排除来路单向前走）
    const k = boot({ seed: seedForFirstDie(3, pre), restMs: 0 });
    k.apply({ type: "dev.setPos", pid: 0, pos: pre.pos, from: pre.from, net: pre.net }, 0);
    ensureHand(k, 0, "i02");
    void k.apply({ type: "roll", pid: 0 }, 0);
    k.tick(140); // 走 1 步（remaining 3→2）
    expect(me(k).walk?.remaining).toBe(2);
    const fx = k.apply({ type: "playItem", pid: 0, cardId: "i02" }, 200);
    const r = fx.find((f) => f.type === "roll" && f.pid === 0) as { type: "roll"; d: number };
    expect(r.d).toBeGreaterThan(0);
    expect(me(k).walk!.remaining).toBe(r.d - 1); // 新面替换余步：先走 1 步照算
    expect(me(k).walk!.total).toBe(r.d);
    expect(k.state.messages.some((m) => m.text.includes("「时光怀表」倒转"))).toBe(true);
  });

  it("gate：没掷骰不能重掷；骰已走完不能重掷", () => {
    // 掷 1 步、三拍内走完（140/280ms）——赶在假人 rollAt（≥750ms）之前，事件流零触发、时序全确定
    const k = boot({ seed: seedForFirstDie(1) });
    ensureHand(k, 0, "i02");
    expect(() => k.apply({ type: "playItem", pid: 0, cardId: "i02" }, 0)).toThrow(/重掷无从说起/);
    void k.apply({ type: "roll", pid: 0 }, 0);
    walkOut(k, 0);
    expect(me(k).walk).toBeNull();
    expect(() => k.apply({ type: "playItem", pid: 0, cardId: "i02" }, 300)).toThrow(/重掷窗口已过/);
  });
});

describe("偷天换日（与目标互换位置）", () => {
  it("turn 模式当场换位：pos 互换（瞬移）、来向/来路清空、净步各保留", () => {
    const k = bootFixed({ timerMode: "turn" });
    k.apply({ type: "dev.setPos", pid: 0, pos: cell(7, 0), from: cell(8, 0), net: 5 }, 0);
    k.apply({ type: "dev.setPos", pid: 1, pos: cell(9, 0), from: cell(10, 0), net: 9 }, 0);
    k.state.players[0]!.trail = [cell(8, 0)];
    ensureHand(k, 0, "i08");
    k.apply({ type: "playItem", pid: 0, cardId: "i08", target: 1 }, 0);
    expect(me(k).pos).toBe(cell(9, 0));
    expect(k.state.players[1]!.pos).toBe(cell(7, 0));
    expect(k.state.players[1]!.net).toBe(9); // 净步各保留
    expect(me(k).net).toBe(5);
    expect(me(k).from).toBeNull(); // 退格从零重审
    expect(k.state.players[1]!.from).toBeNull();
    expect(me(k).trail).toHaveLength(0);
    expect(me(k).walk).toBeNull();
    expect(k.state.messages.some((m) => m.text.includes("换了个位置"))).toBe(true);
  });

  it("world 模式：挂账下一窗结算换位；挂账后目标出局 → 挂账落空出声（效果散去）", () => {
    const k = bootFixed({ restMs: 0 });
    ensureHand(k, 0, "i08");
    k.apply({ type: "playItem", pid: 0, cardId: "i08", target: 1 }, 0);
    expect(k.state.deferred).toEqual([{ pid: 1, parts: [{ type: "swap" }], kind: "item", srcPid: 0, grudgeLabel: "偷天换日" }]);
    k.apply({ type: "dev.setDead", pid: 1 }, 0);
    playThroughP0(k, 100);
    void k.tick(30_000); // 窗 2 开窗：挂账目标已死 → 落空散去
    expect(k.state.turn).toBe(2);
    expect(k.state.messages.some((m) => m.text.includes("效果散去") && m.text.includes("小黄") && m.text.includes("已不在对局"))).toBe(true);
    expect(k.state.deferred).toHaveLength(0); // 你没被换走（挂账散去了）
  });

  it("目标在支路（branch）→ 拒（不在主干道）；打出者在支路 → 拒", () => {
    const k = bootFixed();
    ensureHand(k, 0, "i08");
    k.state.players[1]!.zone = "branch"; // 目标支路（合法目标过滤掉）
    expect(itemLegalTargets(k.state, 0, "i08")).toEqual([2, 3]);
    expect(() => k.apply({ type: "playItem", pid: 0, cardId: "i08", target: 1 }, 0)).toThrow(/不在主干道/);
    k.state.players[0]!.zone = "branch"; // 打出者在支路
    expect(() => k.apply({ type: "playItem", pid: 0, cardId: "i08", target: 2 }, 0)).toThrow(/都在主干道/);
  });
});

describe("小圆盾（下回合免疫他人卡牌效果）", () => {
  it("打出立 cardGuard=下窗；他人弹弓指认 → 下一窗结算被挡下（walk 不动）", () => {
    const k = bootFixed({ restMs: 0 });
    ensureHand(k, 0, "i09");
    k.apply({ type: "playItem", pid: 0, cardId: "i09" }, 0);
    expect(me(k).cardGuard).toBe(2); // turn 1 打出 → 窗 2 生效
    expect(k.state.messages.some((m) => m.text.includes("下一世界回合，他人卡牌效果对他无效"))).toBe(true);
    k.state.players[1]!.hand.push("i10"); // 小黄同窗打弹弓指认你（world·即时=挂账）
    k.apply({ type: "playItem", pid: 1, cardId: "i10", target: 0 }, 0);
    playThroughP0(k, 100); // 他人挂账前你走完本窗——防替掷骰面噪声
    void k.tick(30_000); // 窗 2 开窗：deferred 结算 → 小圆盾挡下
    expect(k.state.turn).toBe(2);
    expect(k.state.messages.some((m) => m.text.includes("「小圆盾」挡下 小黄 的道具卡效果！"))).toBe(true);
    expect(me(k).walk).toBeNull(); // 退 2 被整批拦下
  });

  it("自己卡牌效果不拦（srcPid=自己）：e20 系统指认打到自己身上照吃（当窗轮空）", () => {
    const k = bootFixed({ restMs: 0 });
    ensureHand(k, 0, "i09");
    k.apply({ type: "playItem", pid: 0, cardId: "i09" }, 0);
    k.apply({ type: "dev.setPos", pid: 0, pos: me(k).pos, from: null, net: 50 }, 0); // 抬净步 → e20 指到自己
    k.apply({ type: "dev.drawCard", pid: 0, cardId: "e20" }, 0);
    expect(k.state.deferred.at(-1)!.pid).toBe(0);
    playThroughP0(k, 100);
    void k.tick(30_000);
    expect(k.state.turn).toBe(2);
    expect(me(k).stun).toBe(0); // 罚停已消耗
    expect(me(k).skipped).toBe(true); // 当窗轮空=自己卡牌效果没被小圆盾拦下
  });

  it("guard 到窗自然失效：窗 3（挂账→窗 4 结算）的他人卡牌效果照常落地", () => {
    // 搜种子：牌池扩容（20→21）换流后，窗 3 的走停顿生抽卡可能给人间留续走——
    // 终态「挂账退 2 落成本人当前 walk」即筛条件（同序重放照旧）
    const script = (k: GameKernel): void => {
      ensureHand(k, 0, "i09");
      void k.apply({ type: "playItem", pid: 0, cardId: "i09" }, 0); // guard=2
      playThroughP0(k, 100);
      void k.tick(30_000);
      expect(k.state.turn).toBe(2);
      playThroughP0(k, 31_000); // 窗 2（guard 生效窗）走完
      let t = 32_000;
      while (k.state.turn < 3) {
        t += 500;
        k.tick(t);
      }
      expect(me(k).cardGuard).toBe(2);
      k.state.players[1]!.hand.push("i10");
      void k.apply({ type: "playItem", pid: 1, cardId: "i10", target: 0 }, t); // 窗 3 挂账
      playThroughP0(k, t);
      while (k.state.turn < 4) {
        t += 500;
        k.tick(t);
      }
    };
    let seed = 0;
    for (let s = 1; s < 5000 && !seed; s++) {
      try {
        const k = bootFixed({ seed: s, restMs: 0 });
        script(k);
        if (me(k).walk?.remaining === -2) seed = s;
      } catch {
        // 该种子下脚本中断（断言失败=换种子）
      }
    }
    expect(seed).toBeGreaterThan(0);
    const k = bootFixed({ seed, restMs: 0 });
    script(k);
    expect(k.state.turn).toBe(4);
    expect(me(k).walk?.remaining).toBe(-2); // 退 2 照常落地（guard 只守窗 2）
    expect(me(k).cardGuard).toBe(2); // guard 值早已不命中（turn 4 ≠ 2）
  });
});

describe("护身符（免疫下一次伤害，触发即消耗）", () => {
  it("第一伤被护身符拦（hp 不动+触发即消耗）+罚停照吃；第二伤落身真扣", () => {
    const k = bootFixed({ restMs: 0 });
    ensureHand(k, 0, "i14");
    void k.apply({ type: "playItem", pid: 0, cardId: "i14" }, 0);
    expect(me(k).talisman).toBe(1);
    me(k).stun = 0; // 排除其它罚停干扰
    const before = me(k).hp;
    k.apply({ type: "dev.hit", pid: 0, dmg: 1 }, 0);
    expect(me(k).hp).toBe(before); // 伤害被拦
    expect(me(k).talisman).toBe(0); // 触发即消耗
    expect(k.state.messages.filter((m) => m.text.includes("护身符闪金光")).length).toBe(1);
    k.apply({ type: "dev.hit", pid: 0, dmg: 1 }, 0);
    expect(me(k).hp).toBe(before - 1); // 第二伤落身（护身符已耗）
  });

  it("顺序=先护身符后再盾：双盾者第一二伤挡下、第三伤真扣", () => {
    const k = bootFixed({ restMs: 0 });
    me(k).shields = 1;
    ensureHand(k, 0, "i14");
    void k.apply({ type: "playItem", pid: 0, cardId: "i14" }, 0);
    expect(me(k).talisman).toBe(1);
    const base = me(k).hp;
    k.apply({ type: "dev.hit", pid: 0, dmg: 2 }, 0); // 第一伤 → 护身符
    expect(me(k).talisman).toBe(0);
    expect(me(k).shields).toBe(1); // 盾未动
    expect(me(k).hp).toBe(base);
    k.apply({ type: "dev.hit", pid: 0, dmg: 2 }, 0); // 第二伤 → 盾
    expect(me(k).shields).toBe(0);
    expect(me(k).hp).toBe(base);
    k.apply({ type: "dev.hit", pid: 0, dmg: 2 }, 0); // 第三伤 → 真扣
    expect(me(k).hp).toBe(base - 2);
    expect(k.state.messages.some((m) => m.text.includes("护身符闪金光"))).toBe(true);
    expect(k.state.messages.some((m) => m.text.includes("皮糙肉厚被动"))).toBe(true);
  });
});

describe("加倍骰（升面 1d10→1d12）", () => {
  /** 搜种子：打出加倍骰后的首掷原始面 >10（1d10 不可能） */
  const seedForRaisedOverTen = (): number => {
    for (let seed = 1; seed < 6_000; seed++) {
      try {
        const k = boot({ seed, restMs: 0 });
        ensureHand(k, 0, "i15");
        void k.apply({ type: "playItem", pid: 0, cardId: "i15" }, 0);
        const r = k.apply({ type: "roll", pid: 0 }, 0).find((f) => f.type === "roll" && f.pid === 0);
        if (r && r.type === "roll" && r.d > 10) return seed;
      } catch {
        // 换种子
      }
    }
    throw new Error("找不到升面 11+ 的首掷种子");
  };

  it("面数变 12：骰出 1d10 不可能的 11/12 面；战报括注加倍骰升面 2", () => {
    const seed = seedForRaisedOverTen();
    const k = boot({ seed, restMs: 0 });
    ensureHand(k, 0, "i15");
    void k.apply({ type: "playItem", pid: 0, cardId: "i15" }, 0);
    const fx = k.apply({ type: "roll", pid: 0 }, 0);
    const roll = fx.find((f) => f.type === "roll" && f.pid === 0);
    expect(roll && roll.type === "roll" && roll.d).toBeGreaterThan(10); // 1d12 才有的面
    expect(roll && roll.type === "roll" && roll.mods?.[0]).toMatchObject({ mode: "raise", v: 2, src: "加倍骰" });
    expect(k.state.messages.some((m) => m.text.includes("加倍骰 升面 2"))).toBe(true);
  });
});

describe("狗笛（表一 #16=T6b 野狗生成原语：打出链照 chooseOther 走）", () => {
  it("打出指向合法目标：卡回池、deferred 挂账带 dogSpawn、生成账到下窗开窗才落（生成本身归 dogs.test）", () => {
    const k = bootFixed();
    ensureHand(k, 0, "i16");
    k.apply({ type: "playItem", pid: 0, cardId: "i16", target: 1 }, 0);
    expect(me(k).hand).not.toContain("i16");
    expect(k.state.itemDiscard).toContain("i16"); // 晒牌照常回池
    expect(k.state.deferred).toEqual([{ pid: 1, parts: [{ type: "dogSpawn" }], kind: "item", srcPid: 0, grudgeLabel: "狗笛" }]);
    expect(k.state.malice.dogs).toHaveLength(0); // world·即时：未到结算时刻不生成
    expect(k.state.messages.some((m) => m.text.includes("打出「狗笛」"))).toBe(true);
    expect(k.state.messages.some((m) => m.kind === "item" && m.text.includes("下一世界回合开始时结算"))).toBe(true);
    expect(itemLegalTargets(k.state, 0, "i16")).toContain(2); // chooseOther 口径照常
  });
});

describe("清障符（当前格起前方 3 格收场地卡）", () => {
  it("前方 3 格（含当前格、来路作后界）全收；背后那张不动；收卡回弃牌堆", () => {
    const k = bootFixed();
    k.apply({ type: "dev.setPos", pid: 0, pos: cell(8, 0), from: cell(9, 0), net: 0 }, 0); // 直线段 (9)→(8)→(7)→(6)→(5)
    k.state.ground.push(
      { cell: cell(8, 0), cardId: "i03", owner: 0 },
      { cell: cell(7, 0), cardId: "i17", owner: 0 },
      { cell: cell(6, 0), cardId: "i03", owner: 0 },
      { cell: cell(5, 0), cardId: "i17", owner: 0 },
      { cell: cell(9, 0), cardId: "i03", owner: 0 }, // 背后（来路）不清
    );
    const discardBefore = k.state.itemDiscard.length;
    ensureHand(k, 0, "i18");
    k.apply({ type: "playItem", pid: 0, cardId: "i18" }, 0);
    expect(k.state.ground).toHaveLength(1);
    expect(k.state.ground[0]!.cell).toBe(cell(9, 0)); // 只剩背后那张
    expect(k.state.itemDiscard.length).toBe(discardBefore + 5); // 清障符本体+收走 4 张
    expect(k.state.itemDiscard.filter((x) => x === "i03").length).toBe(2);
    expect(k.state.itemDiscard.filter((x) => x === "i17").length).toBe(2);
    expect(k.state.messages.some((m) => m.text.includes("清障符") && m.text.includes("4 张场地卡"))).toBe(true);
  });

  it("前方干净：无事发生播报；ground 不变", () => {
    const k = bootFixed();
    k.apply({ type: "dev.setPos", pid: 0, pos: cell(8, 0), from: cell(9, 0), net: 0 }, 0);
    ensureHand(k, 0, "i18");
    k.apply({ type: "playItem", pid: 0, cardId: "i18" }, 0);
    expect(k.state.ground).toHaveLength(0);
    expect(k.state.messages.some((m) => m.text.includes("干干净净，无事发生"))).toBe(true);
  });
});
