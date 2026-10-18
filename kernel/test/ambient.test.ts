/**
 * 环境卡三张（#32 T4b2）：《生物圈 3 号》三原则（全场唯一/后打顶掉=旧环境即时失效/打出者摸 1 补偿）
 * ＋三行地形表按所在生态分支（雷暴 劈人回退 平2/雪3/戈1；暴雨 摔跌判定 平 d4 削面/雪罚停/戈 1d8 细雨减半；
 * 风暴 平狂风骰 −2/雪暴风雪摔倒削面/戈沙暴检定 −4）＋2 世界回合到期平息＋与其它扣血/扣面渠道不串扰。
 * 确定性铁律（本文件全体用例）：restMs=0（跨窗绝不卡休息期）、窗 30s~60s；钉位在跨窗前完成；
 * 种子搜索+同序重放。
 */
import { describe, expect, it } from "vitest";
import type { Eco, GameConfig, PlayerDef } from "../src";
import { BOARD, ECO_NAMES, GameKernel, ITEM_CARDS } from "../src";
import { toNextWindow, walkOut } from "./helpers";

/** 固定盘 defs（与 items.test 同型） */
const FIXED: PlayerDef[] = [
  { name: "你", isBot: false, roleId: "light" },
  { name: "小黄", isBot: true, roleId: "boss" },
  { name: "小绿", isBot: true, roleId: "tough" },
  { name: "小蓝", isBot: true, roleId: "woe" },
];

const bootFixed = (over: Partial<GameConfig> = {}): GameKernel => {
  const { kernel } = GameKernel.create({ allowDev: true, restMs: 0, ...over }, 0, FIXED);
  kernel.apply({ type: "chooseSecret", pid: 0, pick: 0 }, 0);
  return kernel;
};

/** 从牌堆取指定卡塞进手牌（dev 冒烟通道，单池守恒照扣） */
const ensureHand = (k: GameKernel, pid: number, id: string): void => {
  if (!k.state.players[pid]!.hand.includes(id)) k.apply({ type: "dev.giveItem", pid, cardId: id }, 0);
};

/** 真人本窗走完流程（先走完劈/退格残步再掷），防超窗替掷的骰面噪声打断断言 */
const playThroughP0 = (k: GameKernel, when: number): void => {
  const p0 = k.state.players[0]!;
  if (p0.walk) walkOut(k, when); // 气候劈出的退格（或其他位移）先走完
  if (!p0.skipped && !p0.rolled) {
    try {
      void k.apply({ type: "roll", pid: 0 }, when);
    } catch {
      // 内核拒（走格未完成等边界）——留窗口替掷兜底
    }
  }
  if (p0.walk) walkOut(k, when);
  if (!p0.confirmed && !p0.skipped) {
    try {
      k.apply({ type: "confirm", pid: 0 }, when + 1_000);
    } catch {
      // 边界（挂起抉择等）：留窗口替掷兜底
    }
  }
};

/** 窗 1 只行动不确认（把收窗留给 30s 整点 deadline）：牌池扩容后走停顿生抽卡会把窗提前收掉，
 *  「钉位在跨窗前完成」的铁律要靠人间不确认来兜住（假人全确认也不收窗）。 */
const playNoConfirmP0 = (k: GameKernel, when: number): void => {
  const p0 = k.state.players[0]!;
  if (p0.walk) walkOut(k, when);
  if (!p0.skipped && !p0.rolled) {
    try {
      void k.apply({ type: "roll", pid: 0 }, when);
    } catch {
      // 走格未完成等边界——留窗口替掷兜底
    }
  }
  if (p0.walk) walkOut(k, when);
};

/** 同生态位（优先带同生态邻居=退一步仍在同行），setPos 全员钉位用 */
const ecoSpot = (zone: Eco): { pos: number; from: number } => {
  const c = BOARD.find((x) => x.zone === zone)!;
  const mate = c.links.find((l) => BOARD[l]!.zone === zone);
  return { pos: c.id, from: mate ?? c.links[0]! };
};
const pinAll = (k: GameKernel, zone: Eco, now = 0): void => {
  const s = ecoSpot(zone);
  for (const p of k.state.players) k.apply({ type: "dev.setPos", pid: p.id, pos: s.pos, from: s.from, net: 10 }, now);
};

describe("《生物圈 3 号》三原则", () => {
  it("打出环境卡：ambient 挂账、出卡回弃牌堆、打出者摸 1 张补偿（手牌不缩水）", () => {
    const k = bootFixed();
    ensureHand(k, 0, "i19");
    const before = k.state.players[0]!.hand.length;
    void k.apply({ type: "playItem", pid: 0, cardId: "i19" }, 0);
    expect(k.state.ambient).toEqual({ cardId: "i19", left: 2 });
    expect(k.state.players[0]!.hand.length).toBe(before); // −1 出卡 +1 补偿
    expect(k.state.players[0]!.hand.includes("i19")).toBe(false);
    expect(k.state.itemDiscard.includes("i19")).toBe(true);
    expect(k.state.messages.some((m) => m.kind === "item" && m.text.includes("打出环境补偿"))).toBe(true);
  });

  it("顶掉：窗内后打顶掉前一张——ambient 转新卡、旧卡从未触发即夭折（即时失效）；新气候窗 2 照常首爆", () => {
    const k = bootFixed({ windowMs: 60_000 });
    ensureHand(k, 0, "i13");
    ensureHand(k, 0, "i19");
    void k.apply({ type: "playItem", pid: 0, cardId: "i13" }, 0);
    void k.apply({ type: "playItem", pid: 0, cardId: "i19" }, 1);
    expect(k.state.ambient).toEqual({ cardId: "i19", left: 2 });
    expect(k.state.messages.some((m) => m.text.includes("旧环境即时失效"))).toBe(true);
    playThroughP0(k, 0);
    toNextWindow(k, 0, 60_000, 0); // 窗 2：tickAmbient 只跑新气候（settle 直接开窗，restMs=0）
    expect(k.state.messages.filter((m) => m.turn === 2 && m.text.includes("雷暴劈下")).length).toBe(0);
    expect(k.state.ambient).toEqual({ cardId: "i19", left: 1 });
  });

  it("顶掉截断：已触发过 1 回合的旧气候，窗内被新卡顶掉后旧卡不再触发", () => {
    const k = bootFixed({ windowMs: 30_000 });
    ensureHand(k, 0, "i13");
    void k.apply({ type: "playItem", pid: 0, cardId: "i13" }, 0);
    playThroughP0(k, 0);
    let now = toNextWindow(k, 0, 30_000, 0); // 窗 2：雷暴首爆
    expect(k.state.ambient).toEqual({ cardId: "i13", left: 1 });
    expect(k.state.messages.filter((m) => m.turn === 2 && m.text.includes("雷暴劈下")).length).toBe(1);
    ensureHand(k, 0, "i19"); // 窗 2 中段顶掉（确认前任意时刻）
    void k.apply({ type: "playItem", pid: 0, cardId: "i19" }, now + 1_000);
    expect(k.state.ambient).toEqual({ cardId: "i19", left: 2 });
    playThroughP0(k, now);
    now = toNextWindow(k, now, 30_000, 0); // 窗 3：只触发新气候
    expect(k.state.messages.filter((m) => m.turn === 3 && m.text.includes("雷暴劈下")).length).toBe(0);
    expect(k.state.ambient).toEqual({ cardId: "i19", left: 1 });
  });

  it("打出闸：淘汰观战不出手（三原则挂在既有 itemPlayGate 之下）", () => {
    const k = bootFixed();
    ensureHand(k, 0, "i19");
    k.apply({ type: "dev.setDead", pid: 0 }, 0);
    expect(() => k.apply({ type: "playItem", pid: 0, cardId: "i19" }, 0)).toThrow(/观战/);
  });
});

describe("雷暴（表一 #13，劈人系）三行地形表", () => {
  const cases: Array<[Eco, number]> = [
    ["plain", 2],
    ["snow", 3],
    ["gobi", 1],
  ];
  for (const [zone, steps] of cases) {
    it(`${ECO_NAMES[zone]}行：回合开始随机劈 1 人回退 ${steps} 步（窗 1 行动完再全员钉位——劈到谁都同行）`, () => {
      const k = bootFixed({ windowMs: 30_000 });
      ensureHand(k, 0, "i13");
      void k.apply({ type: "playItem", pid: 0, cardId: "i13" }, 0);
      playNoConfirmP0(k, 0); // 窗 1：roll/走（人间不确认——把收窗留给 30s 整点）
      pinAll(k, zone, 2_000); // 窗 1 末钉位：窗 2 tickAmbient 按「所在生态」全体同行走行
      toNextWindow(k, 0, 30_000, 0);
      const struck = k.state.players.find((p) => p.walk?.remaining === -steps || p.walkQueue.includes(-steps));
      expect(struck, `有人被劈回退 ${steps}`).toBeDefined();
      expect(
        k.state.messages.some((m) => m.turn === 2 && m.kind === "item" && m.text.includes("雷暴劈下") && m.text.includes(`回退 ${steps} 步`)),
      ).toBe(true);
      expect(k.state.ambient).toEqual({ cardId: "i13", left: 1 });
    });
  }
});

/** 搜种子（摔倒类通用）：窗 1 打出 cardId 并走完 → **全员钉位到 pin 生态**（视=走格收.locus 一概钉）
 *  → 跨窗判定 → 任一人摔倒 → 交 check(k, fellWho, now) 续跑给真伪；命中回 seed（正文同序重放） */
const seedForFall = (
  cardId: string,
  pin: Eco,
  check: (k: GameKernel, fellWho: number, now: number) => boolean,
): number => {
  for (let seed = 1; seed < 9000; seed++) {
    try {
      const k = bootFixed({ seed, windowMs: 60_000 });
      ensureHand(k, 0, cardId);
      void k.apply({ type: "playItem", pid: 0, cardId }, 0);
      playThroughP0(k, 0); // 窗 1 全场走完（此后钉位=绝对位置锚）
      pinAll(k, pin, 2_000);
      const now = toNextWindow(k, 0, 60_000, 0); // 窗 2 tickAmbient：按所在生态判定
      const fell = k.state.messages.find((m) => m.turn === 2 && m.text.includes("摔倒了"));
      if (!fell) continue;
      if (check(k, fell.who!, now)) return seed;
    } catch {
      // 换种子
    }
  }
  throw new Error(`找不到 ${cardId} 的${ECO_NAMES[pin]}摔跌种子`);
};

/** 按上面搜得的 seed 重放同段，返回窗 2 起点与摔倒者 */
const bootWithFall = (seed: number, cardId: string, pin: Eco): { k: GameKernel; now: number; fellWho: number } => {
  const k = bootFixed({ seed, windowMs: 60_000 });
  ensureHand(k, 0, cardId);
  void k.apply({ type: "playItem", pid: 0, cardId }, 0);
  playThroughP0(k, 0);
  pinAll(k, pin, 2_000);
  const now = toNextWindow(k, 0, 60_000, 0);
  const fell = k.state.messages.find((m) => m.turn === 2 && m.text.includes("摔倒了"))!;
  return { k, now, fellWho: fell.who! };
};

describe("暴雨（表一 #19，湿滑系）三行地形表", () => {
  it("平原行：摔跌判定 d4≤1（25%）——摔倒=下次走格骰削面 1（rollMods cut 下一次掷骰一次消费）", () => {
    // 受难者钉到人间：替掷/假人日程的随机流噪声不再让窗偷偷提前闭合（T5b 起陷阱格触发消耗随机流，
    // 「同窗 rollMods 清零」类状态断言必须钉在单意图边界上，防窗 3 气候第二判定混入）
    const seed = seedForFall("i19", "plain", (k, who, now) => {
      if (who !== 0) return false;
      playThroughP0(k, now); // 受难者（=人间）掷骰：战报让「暴雨·湿滑 削面 1」现身（重放内逐拍照抄）
      return k.state.messages.some((m) => m.turn === 2 && m.who === 0 && m.text.includes("暴雨·湿滑 削面 1"));
    });
    const { k, now } = bootWithFall(seed, "i19", "plain");
    const fell = k.state.messages.find((m) => m.turn === 2 && m.who === 0 && m.text.includes("摔倒了"))!;
    expect(fell.text).toContain("摔倒判定 d4("); // 平原行环境判定骰=1d4
    for (const p of k.state.players) if (p.isBot) void k.apply({ type: "dev.setDead", pid: p.id }, now);
    expect(k.state.players[0]!.rollMods.some((m) => m.src === "暴雨·湿滑" && m.mode === "cut" && m.v === 1)).toBe(true);
    void k.apply({ type: "roll", pid: 0 }, now); // 削面批在本骰消费（doRoll 顺手清空 rollMods）
    expect(k.state.messages.some((m) => m.turn === 2 && m.who === 0 && m.text.includes("暴雨·湿滑 削面 1"))).toBe(true);
    expect(k.state.players[0]!.rollMods.filter((m) => m.src === "暴雨·湿滑").length).toBe(0); // 一次消费不重挂
  });

  it("雪山行：冻雨摔跌=罚停 1 回合（stun 挂账）——窗 3 开窗「罚停生效——本回合轮空」", () => {
    const seed = seedForFall("i19", "snow", (k, who, now) => {
      if (who !== 0) return false;
      playThroughP0(k, now); // 受难者（=人间）替掷链路同款（重放内逐拍照抄）
      return k.state.messages.some((m) => m.turn === 2 && m.who === 0 && m.text.includes("被罚停 1 回合"));
    });
    const { k, now } = bootWithFall(seed, "i19", "snow");
    expect(k.state.messages.some((m) => m.turn === 2 && m.who === 0 && m.text.includes("被罚停 1 回合"))).toBe(true);
    for (const p of k.state.players) if (p.isBot) void k.apply({ type: "dev.setDead", pid: p.id }, now);
    expect(k.state.players[0]!.stun).toBe(1);
    k.tick(now + 60_000); // 窗 2 截止一拍收口：替掷替确认→关窗→窗 3 开窗时消耗罚停（stun 只拍一次，断言不跨拍）
    expect(k.state.messages.some((m) => m.turn === 3 && m.who === 0 && m.text.includes("罚停生效——本回合轮空"))).toBe(true);
    expect(k.state.players[0]!.skipped).toBe(true);
  });

  it("戈壁行：细雨摔跌改掷 1d8≤1（12.5% 减半）；摔倒后果表文未标=回落平原削面（T4b2 实现期定案）", () => {
    const seed = seedForFall(
      "i19",
      "gobi",
      (k, who, now) => {
        playThroughP0(k, now);
        const d8fell = k.state.messages.find((m) => m.turn === 2 && m.text.includes("摔倒判定 d8(") && m.text.includes("摔倒了"));
        if (!d8fell) return false;
        const fellWho = d8fell.who!;
        return k.state.messages.some((m) => m.turn === 2 && m.who === fellWho && m.text.includes("暴雨·湿滑 削面 1"));
      },
    );
    const { k, now } = bootWithFall(seed, "i19", "gobi");
    playThroughP0(k, now);
    const d8fell = k.state.messages.find((m) => m.turn === 2 && m.text.includes("摔倒判定 d8(") && m.text.includes("摔倒了"))!;
    expect(d8fell.who).toBeTypeOf("number"); // 戈壁行改掷 1d8（概率减半口径）——摔跌判定公布=该行生效
    const fellWho = d8fell.who!;
    expect(k.state.messages.some((m) => m.turn === 2 && m.who === fellWho && m.text.includes("暴雨·湿滑 削面 1"))).toBe(true);
  });
});

describe("风暴（表一 #20，风压系）三行地形表", () => {
  it("平原行：狂风——下次走格骰 −2 挂账（walkMod 通道），掷骰一次消费不重挂", () => {
    const k = bootFixed({ windowMs: 60_000 });
    ensureHand(k, 0, "i20");
    void k.apply({ type: "playItem", pid: 0, cardId: "i20" }, 0);
    playThroughP0(k, 0);
    const now2 = toNextWindow(k, 0, 60_000, 0);
    expect(k.state.players[0]!.rollMods.some((m) => m.mode === "flat" && m.v === -2 && m.src === "风暴·狂风")).toBe(true);
    expect(k.state.messages.some((m) => m.turn === 2 && m.text.includes("狂风扑面"))).toBe(true);
    void k.apply({ type: "roll", pid: 0 }, now2);
    expect(k.state.players[0]!.rollMods.filter((m) => m.src === "风暴·狂风").length).toBe(0);
  });

  it("雪山行：暴风雪摔跌判定 d4≤2（50%）——摔倒=削面 1（同暴雨削面通道）", () => {
    const seed = seedForFall("i20", "snow", (k, who, now) => {
      playThroughP0(k, now);
      return k.state.messages.some((m) => m.turn === 2 && m.who === who && m.text.includes("风暴·暴风雪 削面 1"));
    });
    const { k, now, fellWho } = bootWithFall(seed, "i20", "snow");
    const fell = k.state.messages.find((m) => m.turn === 2 && m.who === fellWho && m.text.includes("摔倒了"))!;
    expect(fell.text).toContain("摔倒判定 d4(");
    playThroughP0(k, now);
    expect(k.state.messages.some((m) => m.turn === 2 && m.who === fellWho && m.text.includes("风暴·暴风雪 削面 1"))).toBe(true);
  });

  it("戈壁行：沙暴——本回合所有检定 −4（checkMods 批；走格骰不并入），回合开始重刷不叠加", () => {
    const k = bootFixed({ windowMs: 60_000 });
    ensureHand(k, 0, "i20");
    void k.apply({ type: "playItem", pid: 0, cardId: "i20" }, 0);
    playNoConfirmP0(k, 0); // 窗 1：人间不确认——把收窗留给 60s 整点（钉位时序铁律同雷暴）
    pinAll(k, "gobi", 2_000); // 窗 1 行动完再钉到戈壁——窗 2 判定按位置=全员沙暴行
    const now2 = toNextWindow(k, 0, 60_000, 0);
    expect(k.state.players[0]!.checkMods).toEqual([{ mode: "flat", v: -4, src: "风暴·沙暴" }]);
    expect(k.state.messages.some((m) => m.turn === 2 && m.text.includes("沙暴漫天"))).toBe(true);
    // 用前途骰（e13 无轴前途骰）实测：checkMods 合入修正批——播报应见「前途骰掷出 X（−4）」
    void k.apply({ type: "dev.drawCard", pid: 0, cardId: "e13" }, now2 + 500);
    void k.apply({ type: "chooseCard", pid: 0, option: 1 }, now2 + 500);
    expect(k.state.messages.some((m) => m.turn === 2 && m.who === 0 && /前途骰掷出 \d+（−4）/.test(m.text))).toBe(true);
    // 回合开始重刷（窗 3 tickAmbient 再挂=重置非叠加）：窗 2 走完重新钉回戈壁再跨窗
    playThroughP0(k, now2);
    pinAll(k, "gobi", now2 + 1_000);
    toNextWindow(k, now2 + 2_000, 60_000, 0);
    expect(k.state.players[0]!.checkMods).toEqual([{ mode: "flat", v: -4, src: "风暴·沙暴" }]);
  });
});

describe("2 世界回合到期平息", () => {
  it("窗 2 首爆（left→1）、窗 3 二爆后平息（left→0）、窗 4 无再触发", () => {
    const k = bootFixed({ windowMs: 30_000 });
    ensureHand(k, 0, "i13");
    void k.apply({ type: "playItem", pid: 0, cardId: "i13" }, 0);
    playThroughP0(k, 0);
    let now = toNextWindow(k, 0, 30_000, 0);
    expect(k.state.ambient).toEqual({ cardId: "i13", left: 1 });
    expect(k.state.messages.filter((m) => m.turn === 2 && m.text.includes("雷暴劈下")).length).toBe(1);
    playThroughP0(k, now);
    now = toNextWindow(k, now, 30_000, 0);
    expect(k.state.ambient).toBeNull();
    expect(k.state.messages.some((m) => m.turn === 3 && m.text.includes("天色放晴"))).toBe(true);
    expect(k.state.messages.filter((m) => m.turn === 3 && m.text.includes("雷暴劈下")).length).toBe(1);
    playThroughP0(k, now);
    now = toNextWindow(k, now, 30_000, 0);
    expect(k.state.ambient).toBeNull();
    expect(k.state.messages.filter((m) => m.turn === 4 && m.text.includes("雷暴劈下")).length).toBe(0);
  });
});

describe("不串扰", () => {
  it("修正批互抵：风暴狂风 −2 与顺风靴 +3 同骰全量互抵净 +1（一次掷骰一次消费）", () => {
    const k = bootFixed({ windowMs: 60_000 });
    ensureHand(k, 0, "i20");
    void k.apply({ type: "playItem", pid: 0, cardId: "i20" }, 0);
    playThroughP0(k, 0);
    const now2 = toNextWindow(k, 0, 60_000, 0);
    ensureHand(k, 0, "i01"); // 窗 2 roll 前再打顺风靴（+3 与气候 −2 同批互抵）
    void k.apply({ type: "playItem", pid: 0, cardId: "i01" }, now2 + 500);
    const fx = k.apply({ type: "roll", pid: 0 }, now2 + 600);
    const rf = fx.find((f) => f.type === "roll" && f.pid === 0) as { type: "roll"; d: number; mods?: { mode: string; v: number; src?: string }[] };
    expect(rf.mods).toEqual([
      { mode: "flat", v: -2, src: "风暴·狂风" },
      { mode: "flat", v: 3, src: "顺风靴" },
    ]);
    const line = k.state.messages.find(
      (m) => m.turn === 2 && m.who === 0 && /走格骰 \d+（[^）]*）= \d+ 步/.test(m.text) && m.text.includes("顺风靴"),
    )!; // 走格骰战报（排除「打出「顺风靴」」本卡播报——同词撞车）
    const mm = /走格骰 (\d+)（[^）]*）= (\d+) 步/.exec(line.text)!;
    expect(Number(mm[2])).toBe(Number(mm[1]) + 1); // −2+3 全量互抵=净 +1
  });

  it("环境卡三张不扣血（气候只改装/位移——与陷阱恶意等其它扣血渠道井水不犯河水）", () => {
    const hasHp = (parts: ReadonlyArray<{ type: string; v?: number }> | undefined) =>
      (parts ?? []).some((x) => x.type === "hp" && (x.v ?? 0) < 0);
    for (const c of ITEM_CARDS.filter((x) => x.route === "ambient")) {
      const w = c.weather!;
      for (const key of ["plain", "snow", "gobi"] as const) {
        expect(hasHp(w.slip?.[key]?.onFall as never), `${c.title} ${key} 行不扣血`).toBe(false);
        if (w.wind?.[key]?.check) expect(hasHp(w.wind![key]!.check!.onFall as never), `${c.title} wind 行不扣血`).toBe(false);
      }
    }
  });
});
