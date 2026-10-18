/** 事件格抽卡闭环（#19 T3a）：单池洗匀守恒／抉择挂起与代选／纯效果自动结算／检定三态+极值／指认跳过淘汰者／罚停轮空／指认下回合生效 */
import { describe, expect, it } from "vitest";
import { EVENT_CARDS, GameKernel, KernelError, M1_EVENT_POOL, type EventCard, type GameConfig, type PlayerDef } from "../src";
import { boot, cell, dieOf, me, seedForFirstDie, walkOut } from "./helpers";

/** 自定义 defs 开局（角色/人数测试用） */
function bootDefs(defs: PlayerDef[], over: Partial<GameConfig> = {}): GameKernel {
  const { kernel } = GameKernel.create({ allowDev: true, ...over }, 0, defs);
  kernel.apply({ type: "chooseSecret", pid: 0, pick: 0 }, 0);
  return kernel;
}

/** (1,0) 西邻位：掷 1 东行踩 (2,0)=事件格（青草平原） */
const PRE_PLAIN_E = () => ({ pos: cell(1, 0), from: cell(0, 0), net: 5 });
/** (10,10) 西邻位：掷 1 东行踩 (11,10)=事件格（霜顶雪山生态） */
const PRE_SNOW_E = () => ({ pos: cell(10, 10), from: cell(9, 10), net: 5 });

/** 搜种子：dev.drawCard+chooseCard 后人间检定原始面命中 want（返回首个命中并断言非负）。
 *  赌狗/断桥共用；兼容两种播报形态——dc 型「d20(X)」与前途骰（无 dc）「前途骰掷出 X」 */
function seedForDrawCheck(cardId: string, want: (raw: number) => boolean): number {
  const pat = /(?:d20\(|前途骰掷出 )(\d+)/;
  for (let seed = 1; seed < 4000; seed++) {
    const k = boot({ seed });
    k.apply({ type: "dev.drawCard", pid: 0, cardId }, 0);
    k.apply({ type: "chooseCard", pid: 0, option: 1 }, 0);
    const m = k.state.messages
      .slice()
      .reverse()
      .find((x) => x.who === 0 && pat.test(x.text));
    const g = m && pat.exec(m.text);
    if (g && want(parseInt(g[1]!, 10))) return seed;
  }
  throw new Error(`找不到 ${cardId} 检定原始面命中的种子`);
}

/** 直发卡+选第二项（即选项 B=检定项）的盘面（种子由 seedForDrawCheck 搜定）；赌狗/抉择检定分支对表共用 */
function bootCardCheck(cardId: string, want: (raw: number) => boolean): GameKernel {
  const k = boot({ seed: seedForDrawCheck(cardId, want) });
  k.apply({ type: "dev.drawCard", pid: 0, cardId }, 0);
  k.apply({ type: "chooseCard", pid: 0, option: 1 }, 0);
  return k;
}

const POOL_IDS = M1_EVENT_POOL.map((c) => c.id);

describe("牌堆单池守恒（事件定案 §1.8）", () => {
  it("开局 deck+discard 恰好是 20 张池各一张（多种子洗匀序互异）", () => {
    const orders: string[] = [];
    for (const seed of [1, 7, 42, 20261016]) {
      const k = boot({ seed });
      expect([...k.state.deck, ...k.state.discard].sort()).toEqual([...POOL_IDS].sort());
      orders.push(k.state.deck.join(","));
    }
    expect(new Set(orders).size).toBeGreaterThan(1);
  });

  it("弃牌堆洗回：抽空后整循环不丢不重（真实落格抽取路径）", () => {
    const k = boot({ seed: seedForFirstDie(1, PRE_PLAIN_E()), windowMs: 60_000 }, 0);
    k.apply({ type: "dev.setPos", pid: 0, pos: PRE_PLAIN_E().pos, from: PRE_PLAIN_E().from, net: 5 }, 0);
    // 牌堆抽空手术：20 张全进弃牌堆
    k.state.deck = [];
    k.state.discard = [...POOL_IDS];
    const fx = k.apply({ type: "roll", pid: 0 }, 0);
    expect(dieOf(fx)).toBe(1);
    k.tick(140); // 一步走到 (2,0)E → 落格抽卡（此刻假人未到 400ms+ 日程，无人抢牌）
    expect(k.state.deck.length).toBe(POOL_IDS.length - 1); // 洗回整堆后抽走一张
    // 守恒：deck + discard = 全池（抽出的卡已入弃牌堆，回归牌堆有账）
    expect(k.state.discard.length).toBe(1);
    const missing = POOL_IDS.filter((id) => !k.state.deck.includes(id));
    expect(missing.length).toBe(1);
    expect(k.state.discard).toEqual(missing);
  });
});

describe("抉择卡挂起与代选（事件定案 §1.7）", () => {
  it("真人抽到抉择卡：cardPending 挂起 + 手动 chooseCard 走选中分支", () => {
    const k = boot();
    k.apply({ type: "dev.drawCard", pid: 0, cardId: "e01" }, 0);
    expect(me(k).cardPending?.cardId).toBe("e01");
    expect(me(k).cardPending!.deadline).toBe(k.config.routeAskMs);
    k.apply({ type: "chooseCard", pid: 0, option: 1 }, 5_000);
    expect(me(k).cardPending).toBeNull();
    expect(me(k).walk?.remaining).toBe(2); // 顶风前行：前进 2
    expect(k.state.messages.some((m) => m.text.includes("踩上事件格，抽到「穿堂风」"))).toBe(true);
    expect(k.state.messages.some((m) => m.text.includes("选择：「顶风前行」"))).toBe(true);
  });

  it("选默认项=蹲下无事（选项 0 无位移）", () => {
    const k = boot();
    k.apply({ type: "dev.drawCard", pid: 0, cardId: "e01" }, 0);
    k.apply({ type: "chooseCard", pid: 0, option: 0 }, 0);
    expect(me(k).walk).toBeNull();
  });

  it("超时未应答 → 到点按默认项代选并标「(代选)」（断桥默认绕远路=退 2）", () => {
    const k = boot();
    k.apply({ type: "dev.drawCard", pid: 0, cardId: "e03" }, 0);
    expect(me(k).cardPending?.cardId).toBe("e03");
    k.tick(k.config.routeAskMs + 1);
    expect(me(k).cardPending).toBeNull();
    expect(me(k).walk?.remaining).toBe(-2);
    const msg = k.state.messages.slice().reverse().find((m) => m.text.includes("超时未选"));
    expect(msg?.text).toContain("(代选)");
    expect(msg?.text).toContain("绕远路");
  });

  it("挂起未应答期间不能确认；应答后可确认", () => {
    const k = boot();
    k.apply({ type: "roll", pid: 0 }, 0);
    walkOut(k, 0);
    // 走完后抽卡（挂起 10s）：确认必须被闸
    k.apply({ type: "dev.drawCard", pid: 0, cardId: "e01" }, 1_000);
    expect(me(k).cardPending?.cardId).toBe("e01");
    expect(() => k.apply({ type: "confirm", pid: 0 }, 5_000)).toThrow(/事件卡抉择未应答/);
    k.apply({ type: "chooseCard", pid: 0, option: 0 }, 5_000);
    k.apply({ type: "confirm", pid: 0 }, 5_000);
    expect(me(k).confirmed).toBe(true);
  });

  it("chooseCard 越界/无挂起拒绝", () => {
    const k = boot();
    expect(() => k.apply({ type: "chooseCard", pid: 0, option: 0 }, 0)).toThrow(/没有待抉择的事件卡/);
    k.apply({ type: "dev.drawCard", pid: 0, cardId: "e01" }, 0);
    expect(() => k.apply({ type: "chooseCard", pid: 0, option: 9 }, 0)).toThrow(/选项下标越界/);
  });

  it("假人抽到抉择卡 → 即时按默认项代选（不挂起）", () => {
    const k = boot();
    k.apply({ type: "dev.drawCard", pid: 1, cardId: "e01" }, 0);
    expect(k.state.players[1]!.cardPending).toBeNull();
    expect(k.state.messages.some((m) => m.text.includes("系统替 小黄 代选") && m.text.includes("(代选)"))).toBe(true);
  });
});

describe("纯效果卡自动结算进战报流", () => {
  it("「新年红包」摸 1 道具（T4a 起入袋）＋「一路顺风」前进 2 直接起走", () => {
    const k = boot();
    k.apply({ type: "dev.drawCard", pid: 0, cardId: "e15" }, 0);
    expect(k.state.messages.some((m) => m.kind === "item" && m.text.includes("摸到 1 张道具卡"))).toBe(true);
    expect(me(k).walk).toBeNull();
    k.apply({ type: "dev.drawCard", pid: 0, cardId: "e16" }, 0);
    expect(me(k).walk?.remaining).toBe(2);
  });

  it("「全员拜年」含抽取者：本人即时前进 1，他人下回合生效", () => {
    const k = boot();
    k.apply({ type: "dev.drawCard", pid: 0, cardId: "e17" }, 0);
    expect(me(k).walk?.remaining).toBe(1);
    expect(k.state.deferred.length).toBe(3);
    expect(k.state.deferred.every((d) => d.parts[0]!.type === "move" && d.parts[0]!.v === 1)).toBe(true);
    expect(k.state.messages.some((m) => m.text.includes("下一世界回合开始时结算"))).toBe(true);
  });

  it("「主楼停电」指认净步最近者：下回合生效=开窗即结算罚停，当窗轮空", () => {
    const k = boot({ windowMs: 200, restMs: 0 });
    k.apply({ type: "dev.setPos", pid: 1, pos: k.state.players[1]!.pos, from: null, net: 5 }, 0);
    k.apply({ type: "dev.drawCard", pid: 0, cardId: "e20" }, 0);
    // 窗 1：只标记（deferred），被指认者照常行动
    expect(k.state.deferred).toEqual([{ pid: 1, parts: [{ type: "skip", v: 1 }], kind: "event", srcPid: 0, grudgeLabel: "主楼停电" }]);
    expect(k.state.players[1]!.stun).toBe(0);
    // 窗 2 开窗：deferred 罚停即结算即消耗 → 本窗轮空（不掷不确认）
    void k.tick(200);
    expect(k.state.players[1]!.stun).toBe(0);
    expect(k.state.players[1]!.rolled).toBe(true);
    expect(k.state.players[1]!.confirmed).toBe(true);
    expect(k.state.messages.some((m) => m.text.includes("罚停生效——本回合轮空"))).toBe(true);
    // 未被指认者不受连坐
    expect(k.state.players[2]!.stun).toBe(0);
    expect(k.state.players[2]!.rolled).toBe(false);
  });
});

describe("系统指认：跳过淘汰者（事件定案 §5.2）", () => {
  it("「庄园鼠横行」随机指认永不落淘汰者（12 种子收账）", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const k = boot({ seed });
      k.apply({ type: "dev.setDead", pid: 1 }, 0);
      const before = k.state.deferred.length;
      k.apply({ type: "dev.drawCard", pid: 0, cardId: "e19" }, 0);
      const d = k.state.deferred[before]!;
      expect(d.pid).not.toBe(1); // 淘汰者不进指认池
      expect(d.parts[0]).toMatchObject({ type: "back", v: 2 });
    }
  });

  it("净步最高者出局 → 指认落到活人身上（排序+过滤协同；罚停走下回合标记）", () => {
    const k = boot();
    k.apply({ type: "dev.setPos", pid: 2, pos: k.state.players[2]!.pos, from: null, net: 999 }, 0);
    k.apply({ type: "dev.setDead", pid: 2 }, 0); // 净步最高者被淘汰
    k.apply({ type: "dev.drawCard", pid: 0, cardId: "e20" }, 0);
    // 指认池=[0,1,3]（净步全 0，id 序破平 → 0）；2 已出局所以整轮不被指认
    expect(k.state.deferred).toEqual([{ pid: 0, parts: [{ type: "skip", v: 1 }], kind: "event", srcPid: 0, grudgeLabel: "主楼停电" }]);
    expect(k.state.players[0]!.stun).toBe(0);
    void k.tick(30_000); // now≥deadline → 替掷收口 + rest（restUntil=40k）
    void k.tick(40_000); // rest 到点 → 开窗 2：deferral 罚停结算即消耗 → 你本窗轮空
    expect(k.state.players[0]!.stun).toBe(0);
    expect(k.state.players[0]!.rolled).toBe(true);
    expect(k.state.players[0]!.confirmed).toBe(true);
    expect(k.state.messages.some((m) => m.text.includes("罚停生效——本回合轮空"))).toBe(true);
    expect(k.state.players[2]!.stun).toBe(0); // 淘汰者永不入账
    expect(k.state.players[2]!.rolled).toBe(false);
  });
});

describe("赌狗时刻 · 命运之骰前途骰四分支（表二 e13；无 dc 走 bands）", () => {
  it("骰 20 大成功 → 前进 6（当卡极值正面分支）", () => {
    const k = bootCardCheck("e13", (raw) => raw === 20);
    expect(me(k).walk?.remaining).toBe(6);
  });

  it("骰 1 大失败 → 回退 4（当卡极值负面分支）", () => {
    const k = bootCardCheck("e13", (raw) => raw === 1);
    expect(me(k).walk?.remaining).toBe(-4);
  });

  it("11..19 → 前进 4（bands 首条 min:11）", () => {
    const k = bootCardCheck("e13", (raw) => raw >= 11 && raw <= 19);
    expect(me(k).walk?.remaining).toBe(4);
    expect(k.state.messages.some((m) => m.text.includes("前途骰掷出"))).toBe(true);
  });

  it("2..10 → 回退 3（bands 末条兜底=「≤10」表述）", () => {
    const k = bootCardCheck("e13", (raw) => raw >= 2 && raw <= 10);
    expect(me(k).walk?.remaining).toBe(-3);
  });
});

describe("赌狗时刻 · 孤注一掷（表二 e14；赌运 DC16 高险高收益）", () => {
  it("运检 DC16 通过（轻装运轴 +2，raw ≥14 即过）→ 前进 5 + 摸 1 道具", () => {
    const k = bootCardCheck("e14", (raw) => raw >= 14 && raw < 20);
    expect(me(k).walk?.remaining).toBe(5);
    expect(me(k).hp).toBe(10);
    expect(me(k).stun).toBe(0);
    expect(k.state.messages.some((m) => m.kind === "item" && m.text.includes("摸到 1 张道具卡"))).toBe(true);
    expect(k.state.messages.some((m) => m.text.includes("vs DC16"))).toBe(true);
  });

  it("DC16 失败 → 扣 2 血 + 罚停 1 回合（罚停标记开窗轮空）", () => {
    const k = bootCardCheck("e14", (raw) => raw >= 2 && raw <= 13);
    expect(me(k).walk).toBeNull();
    expect(me(k).hp).toBe(8);
    expect(me(k).stun).toBe(1);
    expect(k.state.messages.some((m) => m.text.includes("被罚停 1 回合"))).toBe(true);
  });
});

describe("表二 21 张逐张对表（T3b 收账）", () => {
  it("编号 1..21 完整、id 唯一、kind 分布 = 14 抉择 + 6 纯效果 + 1 自由窗口", () => {
    expect(EVENT_CARDS.length).toBe(21);
    expect(EVENT_CARDS.map((c) => c.no).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 21 }, (_, i) => i + 1),
    );
    expect(new Set(EVENT_CARDS.map((c) => c.id)).size).toBe(21);
    const by = (kind: EventCard["kind"]) => EVENT_CARDS.filter((c) => c.kind === kind).length;
    expect(by("choice")).toBe(14);
    expect(by("effect")).toBe(6);
    expect(by("window")).toBe(1);
  });

  it("每张卡都有场景 flavor（叙事皮收账）", () => {
    for (const c of EVENT_CARDS) expect(c.flavor.length).toBeGreaterThan(0);
  });

  it("生态特殊卡 3 张挂对生态（温泉房=平原 / 熔岩喷口=戈壁 / 冰面滑道=雪山）", () => {
    expect(EVENT_CARDS.find((c) => c.title === "温泉房")?.region).toBe("plain");
    expect(EVENT_CARDS.find((c) => c.title === "熔岩喷口")?.region).toBe("gobi");
    expect(EVENT_CARDS.find((c) => c.title === "冰面滑道")?.region).toBe("snow");
    expect(EVENT_CARDS.filter((c) => c.region).length).toBe(3);
  });

  it("赌狗 3 张全挂 gamble 标且都是抉择卡（表二显式卡牌类型兑现）", () => {
    const gambles = EVENT_CARDS.filter((c) => c.gamble);
    expect(gambles.map((c) => c.title)).toEqual(["猜拳机器人", "命运之骰", "孤注一掷"]);
    expect(gambles.every((c) => c.kind === "choice")).toBe(true);
  });

  it("M1 牌池 = 21 张全量（#26 T7 放行 window 卡「黑市开张」进池）", () => {
    const w = EVENT_CARDS.find((c) => c.kind === "window");
    expect(w?.title).toBe("黑市开张");
    expect(M1_EVENT_POOL.length).toBe(21);
    expect(M1_EVENT_POOL.includes(w!)).toBe(true);
  });

  it("抉择 14 张每张 ≥2 选项 + 合法默认项；纯效果 6 张每张有 effect", () => {
    for (const c of EVENT_CARDS) {
      if (c.kind === "choice") {
        expect(c.options!.length).toBeGreaterThanOrEqual(2);
        expect(c.defaultOption!).toBeGreaterThanOrEqual(0);
        expect(c.defaultOption!).toBeLessThan(c.options!.length);
      } else if (c.kind === "effect") {
        expect(c.effect).toBeDefined();
      }
    }
  });

  it("全池 20 张逐张直发结算不炸（dev 通道；真实落格/region 洗回/弃牌堆路径另在上方两组收账）", () => {
    const k = boot();
    for (const card of M1_EVENT_POOL) {
      k.apply({ type: "dev.drawCard", pid: 0, cardId: card.id }, 0);
      if (me(k).cardPending?.cardId === card.id) {
        k.apply({ type: "chooseCard", pid: 0, option: card.defaultOption ?? 0 }, 0);
      }
    }
    const seen = k.state.messages.filter((m) => m.who === 0 && m.text.includes("踩上事件格，抽到「"));
    expect(seen.length).toBe(M1_EVENT_POOL.length);
    for (const c of M1_EVENT_POOL) {
      expect(seen.some((m) => m.text.includes(`「${c.title}」`))).toBe(true);
    }
  });

  it("window 卡 dev 直发=开海关风云（#26 T7 真账：警长指派+查验次数挂账）", () => {
    const k = boot();
    k.apply({ type: "dev.drawCard", pid: 0, cardId: "e21" }, 0);
    expect(k.state.customs).not.toBeNull();
    expect(k.state.customs!.checksLeft).toBe(2); // 4 人局=≤2 次（6+ 人在场 3 次）
    expect(k.state.messages.some((m) => m.text.includes("海关风云"))).toBe(true);
  });
});

describe("抉择卡逐张效果对表（AC1 运行时收账；非结构层）", () => {
  it("e02 温泉房（region preserved 直发）：泡一下=回 2 血；泡个够=回 3 血+罚停 1", () => {
    const k = boot();
    k.apply({ type: "dev.setHp", pid: 0, hp: 1 }, 0);
    k.apply({ type: "dev.drawCard", pid: 0, cardId: "e02" }, 0);
    k.apply({ type: "chooseCard", pid: 0, option: 0 }, 0);
    expect(me(k).hp).toBe(3);
    expect(me(k).stun).toBe(0);

    const k2 = boot();
    k2.apply({ type: "dev.setHp", pid: 0, hp: 1 }, 0);
    k2.apply({ type: "dev.drawCard", pid: 0, cardId: "e02" }, 0);
    k2.apply({ type: "chooseCard", pid: 0, option: 1 }, 0);
    expect(me(k2).hp).toBe(4);
    expect(me(k2).stun).toBe(1);
  });

  it("e06 电梯还是楼梯：走楼梯（默认）=无事；乘电梯=前进 3+罚停 1", () => {
    const k = boot();
    k.apply({ type: "dev.drawCard", pid: 0, cardId: "e06" }, 0);
    k.apply({ type: "chooseCard", pid: 0, option: 0 }, 0);
    expect(me(k).walk).toBeNull();
    expect(me(k).stun).toBe(0);

    const k2 = boot();
    k2.apply({ type: "dev.drawCard", pid: 0, cardId: "e06" }, 0);
    k2.apply({ type: "chooseCard", pid: 0, option: 1 }, 0);
    expect(me(k2).walk?.remaining).toBe(3);
    expect(me(k2).stun).toBe(1);
  });

  it("e11 岔路口·宝箱与陷阱：险路（默认）=摸 1 道具+退 2；稳路=原地不动", () => {
    const k = boot();
    k.apply({ type: "dev.drawCard", pid: 0, cardId: "e11" }, 0);
    k.apply({ type: "chooseCard", pid: 0, option: 0 }, 0);
    expect(me(k).walk?.remaining).toBe(-2);
    expect(k.state.messages.some((m) => m.kind === "item" && m.text.includes("摸到 1 张道具卡"))).toBe(true);

    const k2 = boot();
    k2.apply({ type: "dev.drawCard", pid: 0, cardId: "e11" }, 0);
    k2.apply({ type: "chooseCard", pid: 0, option: 1 }, 0);
    expect(me(k2).walk).toBeNull();
  });

  it("e09 熔岩喷口（region gobi）：踏岩而过=敏检 DC12——过=前进 3；败=扣 1 血停原地", () => {
    const k = bootCardCheck("e09", (raw) => raw + 3 >= 12 && raw > 1 && raw < 20); // 轻装 agile3
    expect(me(k).walk?.remaining).toBe(3);
    expect(me(k).hp).toBe(10);
    expect(k.state.messages.some((m) => m.text.includes("力检 d20") === false && m.text.includes("敏检 d20") && m.text.includes("vs DC12"))).toBe(true);

    const k2 = bootCardCheck("e09", (raw) => raw + 3 < 12 && raw > 1);
    expect(me(k2).walk).toBeNull();
    expect(me(k2).hp).toBe(9);
  });

  it("e10 冰面滑道（region snow）：坐滑道=敏检 DC10——过=前进 4；败=滑倒退 2", () => {
    const k = bootCardCheck("e10", (raw) => raw + 3 >= 10 && raw > 1 && raw < 20); // 轻装 agile3
    expect(me(k).walk?.remaining).toBe(4);

    const k2 = bootCardCheck("e10", (raw) => raw + 3 < 10 && raw > 1);
    expect(me(k2).walk?.remaining).toBe(-2);
  });

  it("e08 猜拳机器人普通通过（非极值）=前进 3——与骰 20 献宝分支区分", () => {
    const k = bootCardCheck("e08", (raw) => raw >= 8 && raw < 20); // 轻装 luck2 vs DC10
    expect(me(k).walk?.remaining).toBe(3);
    expect(k.state.messages.some((m) => m.who === 0 && m.text.includes("—— 大成功"))).toBe(false);
  });
});

describe("血量/盾通道", () => {
  it("「岔路口·近路与远路」A 抄近路：前进 2 + 扣 1 血", () => {
    const k = boot();
    k.apply({ type: "dev.drawCard", pid: 0, cardId: "e12" }, 0);
    k.apply({ type: "chooseCard", pid: 0, option: 0 }, 0);
    expect(walkOut(k, 0).filter((f) => f.type === "step" && f.pid === 0).length).toBe(2);
    expect(me(k).net).toBe(2); // 出生净步 0 + 2 步
    expect(me(k).hp).toBe(9);
    expect(k.state.messages.some((m) => m.text.includes("扣 1 血（剩 9/10）"))).toBe(true);
  });

  it("皮糙肉厚盾：第一次扣血免疫，第二次真扣", () => {
    const defs: PlayerDef[] = [
      { name: "厚皮", isBot: false, roleId: "tough" },
      { name: "伴", isBot: true, roleId: "light" },
    ];
    const k = bootDefs(defs);
    expect(me(k).shields).toBe(1);
    k.apply({ type: "dev.drawCard", pid: 0, cardId: "e12" }, 0);
    k.apply({ type: "chooseCard", pid: 0, option: 0 }, 0);
    walkOut(k, 0);
    expect(me(k).shields).toBe(0);
    expect(me(k).hp).toBe(10); // 盾顶住
    expect(k.state.messages.some((m) => m.text.includes("免疫这次扣血"))).toBe(true);
    k.apply({ type: "dev.drawCard", pid: 0, cardId: "e12" }, 40_000);
    k.apply({ type: "chooseCard", pid: 0, option: 0 }, 40_000);
    walkOut(k, 40_000);
    expect(me(k).hp).toBe(9);
  });
});

describe("检定三态（1d20+轴 vs 卡面 DC）与极值分支", () => {
  it("断桥跳桥力检 DC12：过=前进 3；败=扣 1 血停原地", () => {
    // wants 收紧极值档（20=大成功/1=大失败走分支用例）——普通过/败档不被极值播报顶穿
    const passSeed = seedForDrawCheck("e03", (raw) => raw + 1 >= 12 && raw < 20); // 轻装 might1
    const k = boot({ seed: passSeed });
    k.apply({ type: "dev.drawCard", pid: 0, cardId: "e03" }, 0);
    k.apply({ type: "chooseCard", pid: 0, option: 1 }, 0);
    expect(me(k).walk?.remaining).toBe(3);
    expect(me(k).hp).toBe(10);
    expect(k.state.messages.some((m) => m.text.includes("力检 d20") && m.text.includes("—— 通过"))).toBe(true);

    const failSeed = seedForDrawCheck("e03", (raw) => raw + 1 < 12 && raw > 1);
    const k2 = boot({ seed: failSeed });
    k2.apply({ type: "dev.drawCard", pid: 0, cardId: "e03" }, 0);
    k2.apply({ type: "chooseCard", pid: 0, option: 1 }, 0);
    expect(me(k2).walk).toBeNull(); // 停原地
    expect(me(k2).hp).toBe(9);
    expect(k2.state.messages.some((m) => m.text.includes("—— 失败"))).toBe(true);
  });

  it("猜拳机器人（运检 DC10）：骰 20 大成功分支前进 6；骰 1 大失败回落失败分支", () => {
    const critSeed = seedForDrawCheck("e08", (raw) => raw === 20);
    const k = boot({ seed: critSeed });
    k.apply({ type: "dev.drawCard", pid: 0, cardId: "e08" }, 0);
    k.apply({ type: "chooseCard", pid: 0, option: 1 }, 0);
    expect(me(k).walk?.remaining).toBe(6); // 机器人献宝
    expect(k.state.messages.some((m) => m.text.includes("—— 大成功"))).toBe(true);

    const cfSeed = seedForDrawCheck("e08", (raw) => raw === 1);
    const k2 = boot({ seed: cfSeed });
    k2.apply({ type: "dev.drawCard", pid: 0, cardId: "e08" }, 0);
    k2.apply({ type: "chooseCard", pid: 0, option: 1 }, 0);
    expect(me(k2).walk?.remaining).toBe(-2); // 无自带大失败分支 → 回落败=回退 2
    expect(k2.state.messages.some((m) => m.text.includes("—— 大失败"))).toBe(true);
  });
});

describe("地区特殊卡（事件定案 §1.8）", () => {
  it("雪山卡在平原抽到 → 洗回重抽命中下一张（新年红包）", () => {
    const seed = seedForFirstDie(1, PRE_PLAIN_E());
    const k = boot({ seed });
    k.apply({ type: "dev.setPos", pid: 0, pos: PRE_PLAIN_E().pos, from: PRE_PLAIN_E().from, net: 5 }, 0);
    k.state.deck = ["e15", "e10"]; // 栈顶 e10=冰面滑道（region snow），下一张 e15
    k.state.discard = [];
    void k.apply({ type: "roll", pid: 0 }, 0);
    k.tick(140);
    expect(k.state.messages.some((m) => m.text.includes("在青草平原不适用，洗回牌堆重抽"))).toBe(true);
    const mine = k.state.messages.filter((m) => /踩上事件格，抽到/.test(m.text) && m.who === 0);
    expect(mine.length).toBe(1);
    expect(mine[0]!.text).toContain("新年红包");
  });

  it("抽卡者在雪山生态：地区卡正常结算（无洗回）", () => {
    const seed = seedForFirstDie(1, PRE_SNOW_E());
    const k = boot({ seed });
    k.apply({ type: "dev.setPos", pid: 0, pos: PRE_SNOW_E().pos, from: PRE_SNOW_E().from, net: 5 }, 0);
    k.state.deck = ["e15", "e10"];
    k.state.discard = [];
    void k.apply({ type: "roll", pid: 0 }, 0);
    k.tick(140);
    expect(k.state.messages.some((m) => m.text.includes("不适用"))).toBe(false);
    expect(me(k).cardPending?.cardId).toBe("e10"); // 冰面滑道=抉择卡挂起
  });
});

describe("dev 通道防误用（allowDev 闸）", () => {
  it("dev.drawCard/setDead/setHp 在正式配置（allowDev=false）被拒", () => {
    const k = GameKernel.create({ seed: 42 }, 0).kernel;
    k.apply({ type: "chooseSecret", pid: 0, pick: 0 }, 0);
    expect(() => k.apply({ type: "dev.drawCard", pid: 0, cardId: "e15" }, 0)).toThrow(KernelError);
    expect(() => k.apply({ type: "dev.setDead", pid: 1 }, 0)).toThrow(KernelError);
    expect(() => k.apply({ type: "dev.setHp", pid: 0, hp: 1 }, 0)).toThrow(KernelError);
  });
});
