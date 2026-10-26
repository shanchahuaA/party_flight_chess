/**
 * 结算计数发射点实流（#36 T8b1）：settle.test 给的是标签账边界（合成口粮），本文件验证**发射点真的
 * 会把 MsgTag 打在真战报上**——每个标签至少一条真实内核场景（违禁整蛊/事件指认/小圆盾拦下/场地卡
 * 被踩中/赌狗赢输/遭遇战连毙/扣血三态/海关三账/环境双账/四路由出手/直砸/出局散落/群体失败结算组），
 * 断言 computeSettlement 从真 log 读出计数。
 *
 * 确定性铁律：恶意关档（无世界层搅局）；假人冻走格（freezeBots=rollAt∞，窗内测试不收窗）；种子搜索
 * 配准骰面——读结构化事实/状态，禁解析战报文案（检定原始面的兼容读法沿 events.test 既有 pat）。
 */
import { describe, expect, it } from "vitest";
import {
  NET_GOAL,
  SECRET_GOALS,
  GameKernel,
  computeSettlement,
  finishScore,
  TITLE_SCORE,
  type Fact,
  type GameConfig,
  type GameState,
  type MsgTag,
  type PlayerDef,
} from "../src";
import { boot, dieOf, me, toNextWindow, tryGiveItem, walkOut } from "./helpers";

const msg = (k: GameKernel, text: string): boolean => k.state.messages.some((m) => m.text.includes(text));
const tagsOf = (k: GameKernel, tag: MsgTag, who: number): number[] =>
  k.state.messages.filter((m) => m.tags?.includes(tag) && m.who === who).map((m) => m.id);
const noOf = (counter: string): number => SECRET_GOALS.find((g) => g.counter === counter)!.no;

/** 检定原始面的兼容读法（events.test 既有 pat——dc 型「d20(X)」与前途骰「前途骰掷出 X」） */
const pat = /(?:d20\(|前途骰掷出 )(\d+)/;
const lastRaw = (k: GameKernel, who: number): number | null => {
  const m = k.state.messages.slice().reverse().find((x) => x.who === who && pat.test(x.text));
  if (!m) return null;
  return parseInt(pat.exec(m.text)![1]!, 10);
};

/** 出局手牌散落条目（找战犯证据源） */
const retiredMsg = (k: GameKernel, pid: number): GameState["messages"][number] =>
  k.state.messages.find((x) => x.tags?.includes("retiredHand") && x.who === pid)!;

// ---------- 整蛊三通道 ----------

describe("整蛊三通道（grudge 标签）", () => {
  const FIXED: PlayerDef[] = [
    { name: "你", isBot: false, roleId: "light" },
    { name: "小黄", isBot: false, roleId: "light" },
    { name: "小绿", isBot: true, roleId: "woe" },
    { name: "小蓝", isBot: true, roleId: "woe" },
  ];
  const boot2h = (over: Partial<GameConfig> = {}): GameKernel => {
    const { kernel } = GameKernel.create({ allowDev: true, maliceLevel: "off", restMs: 0, ...over }, 0, FIXED);
    // 驱动扩展（T5c 前置）：双真人都抽暗牌，全员选定才开窗——只补齐选牌，断言不动
    kernel.apply({ type: "chooseSecret", pid: 0, pick: 0 }, 0);
    for (const q of kernel.state.players.filter((x) => !x.isBot && x.secretPick == null)) kernel.apply({ type: "chooseSecret", pid: q.id, pick: 0 }, 0);
    return kernel;
  };

  it("违禁卡指认得手：弹弓退 2 落账当拍出「整蛊得手」+grudge 标签（who=整蛊者）", () => {
    const k = boot2h({ windowMs: 4_000 });
    tryGiveItem(k, 0, "i10", 0); // 弹弓（违禁）
    k.apply({ type: "playItem", pid: 0, cardId: "i10", target: 1 }, 0);
    expect(k.state.deferred[0]!.grudgeLabel).toBe("弹弓"); // 计数通道随挂账走
    k.tick(4_001); // 下窗：deferred 落账
    expect(msg(k, "整蛊得手")).toBe(true);
    expect(tagsOf(k, "grudge", 0)).toHaveLength(1);
    const r = computeSettlement(k.state).rows[0]!;
    expect(r.grudgeCount).toBe(1);
    expect(r.grudgeScore).toBe(2);
  });

  it("事件卡系统指认得手：主楼停电罚停落账=grudge（event 卡=「系统指认」通道）", () => {
    const k = boot2h({ windowMs: 4_000 });
    k.apply({ type: "dev.setPos", pid: 1, pos: k.state.players[1]!.pos, from: null, net: 5 }, 0);
    k.apply({ type: "dev.drawCard", pid: 0, cardId: "e20" }, 0);
    expect(k.state.deferred[0]!.grudgeLabel).toBe("主楼停电"); // event 卡必指认
    k.tick(4_001);
    expect(tagsOf(k, "grudge", 0)).toHaveLength(1);
  });

  it("小圆盾拦下=整蛊失败：不落 grudge 标签（「实际生效」判据）", () => {
    const k = boot2h({ windowMs: 4_000 });
    tryGiveItem(k, 1, "i09", 0); // 小圆盾给 P1
    k.apply({ type: "playItem", pid: 1, cardId: "i09" }, 0); // P1 举起盾（下一回合免疫他人卡牌效果）
    expect(k.state.players[1]!.cardGuard).toBe(2);
    tryGiveItem(k, 0, "i10", 0);
    k.apply({ type: "playItem", pid: 0, cardId: "i10", target: 1 }, 0);
    k.tick(4_001); // 下窗：小圆盾拦下
    expect(msg(k, "小圆盾」挡下")).toBe(true);
    expect(tagsOf(k, "grudge", 0)).toHaveLength(0);
    expect(computeSettlement(k.state).rows[0]!.grudgeCount).toBe(0);
  });

  it("场地卡被踩中=整蛊通道（踩中即生效）", () => {
    const k = boot2h({ windowMs: 30_000 });
    for (const p of k.state.players) if (p.isBot) p.botSchedule.rollAt = Number.POSITIVE_INFINITY; // 冻假人（不搅路）
    dieOf(k.apply({ type: "roll", pid: 1 }, 0), 1); // P1 真走一段（来路栈 ≥2 格——搜索配准骰面）
    walkOut(k, 0);
    expect(k.state.players[1]!.trail.length).toBeGreaterThanOrEqual(2);
    // P0 钉到 P1 来路第 2 格（沿来路原路倒 2 步的停点），香蕉皮搁在那儿
    const stop = k.state.players[1]!.trail.at(-2)!;
    k.apply({ type: "dev.setPos", pid: 0, pos: stop, from: null, net: 0 }, 0);
    tryGiveItem(k, 0, "i03", 0);
    k.apply({ type: "playItem", pid: 0, cardId: "i03" }, 0);
    // P1 沿原路栈倒 2 步=正好停在香蕉皮上
    k.apply({ type: "dev.back", pid: 1, steps: 2 }, 0);
    walkOut(k, 0);
    expect(k.state.players[1]!.pos).toBe(stop);
    expect(msg(k, "整蛊得手")).toBe(true);
    expect(tagsOf(k, "grudge", 0)).toHaveLength(1);
  });
});

// ---------- 赌狗 / 打狗 / 硬骨头 ----------

describe("赌狗/dogKilled/hpLost（行为级计数）", () => {
  it("赌狗赢一局=e08 应战通过：mark 原语打 gambleWin 标签；赢 2 次=称号（表四目标值 2）", () => {
    for (let seed = 1; seed < 4000; seed++) {
      const k = boot({ seed });
      k.apply({ type: "dev.drawCard", pid: 0, cardId: "e08" }, 0);
      k.apply({ type: "chooseCard", pid: 0, option: 1 }, 0); // 应战（运检 DC10）
      const raw = lastRaw(k, 0);
      if (raw != null && raw >= 8 && raw <= 19) {
        expect(tagsOf(k, "gambleWin", 0)).toHaveLength(1);
        expect(computeSettlement(k.state).rows[0]!.goalNos).not.toContain(noOf("gamble")); // 1 次差一口气
        // 第二掷：再抽一张 e08 应战（丢牌堆强制重发——同种子的第二颗骰面）
        k.apply({ type: "dev.drawCard", pid: 0, cardId: "e08" }, 0);
        k.apply({ type: "chooseCard", pid: 0, option: 1 }, 0);
        const raw2 = lastRaw(k, 0);
        const won = raw2 != null && raw2 >= 8;
        expect(tagsOf(k, "gambleWin", 0).length).toBe(won ? 2 : 1);
        expect(computeSettlement(k.state).rows[0]!.goalNos.includes(noOf("gamble"))).toBe(won);
        if (won) return; // 赢 2 次的种子定谳；没赢的种子继续搜
      }
    }
    throw new Error("找不到赌狗连赢两局的种子");
  });

  it("打狗英雄：dev.spawnDog 当拍遭遇战通过 ×2 = dogKilled 标签×2+称号达成", () => {
    for (let seed = 1; seed < 4000; seed++) {
      const { kernel: k } = GameKernel.create({ allowDev: true, seed, maliceLevel: "off", restMs: 0 }, 0, [
        { name: "你", isBot: false, roleId: "beast" }, // 野性直觉=猎手特长：dogFight 域 +4+力 3 → DC12 用 raw ≥5
        { name: "小黄", isBot: true, roleId: "woe" },
      ]);
      k.apply({ type: "chooseSecret", pid: 0, pick: 0 }, 0);
      k.apply({ type: "dev.spawnDog", cell: me(k).pos }, 0);
      if (k.state.malice.dogs.length > 0) continue; // 第一掷没过=被咬（狗还在）——换种子
      k.apply({ type: "dev.spawnDog", cell: me(k).pos }, 0);
      if (k.state.malice.dogs.length > 0) continue; // 第二掷也没过
      expect(tagsOf(k, "dogKilled", 0)).toHaveLength(2);
      expect(computeSettlement(k.state).rows[0]!.goalNos).toContain(noOf("dogs"));
      return;
    }
    throw new Error("找不到连毙两狗的种子");
  });

  it("硬骨头：承受 3 次扣血=达成（hpLost×3）；第 3 口咬死则「仍活着」不成立", () => {
    const k = boot({ maliceLevel: "off" });
    for (let i = 0; i < 2; i++) k.apply({ type: "dev.hit", pid: 0, dmg: 1 }, 0);
    expect(computeSettlement(k.state).rows[0]!.goalNos).not.toContain(noOf("hitsTaken"));
    k.apply({ type: "dev.hit", pid: 0, dmg: 1 }, 0); // 第三口（还活着）
    expect(tagsOf(k, "hpLost", 0)).toHaveLength(3);
    expect(computeSettlement(k.state).rows[0]!.goalNos).toContain(noOf("hitsTaken"));
    k.apply({ type: "dev.hit", pid: 0, dmg: 7 }, 0); // 血尽
    expect(computeSettlement(k.state).rows[0]!.goalNos).not.toContain(noOf("hitsTaken"));
  });

  it("扣血标签只落真账：护身符拦下的不落 hpLost", () => {
    const k = boot({ maliceLevel: "off" });
    tryGiveItem(k, 0, "i14", 0);
    k.apply({ type: "playItem", pid: 0, cardId: "i14" }, 0);
    k.apply({ type: "dev.hit", pid: 0, dmg: 2 }, 0);
    expect(msg(k, "护身符闪金光")).toBe(true);
    expect(tagsOf(k, "hpLost", 0)).toHaveLength(0);
  });
});

// ---------- 海关三账 ----------

describe("海关三账（customsOpen/customsLied/customsClean）", () => {
  const FIXED: PlayerDef[] = [
    { name: "你", isBot: false, roleId: "light" },
    { name: "小黄", isBot: false, roleId: "light" },
    { name: "小绿", isBot: true, roleId: "woe" },
  ];
  const bootK = (over: Partial<GameConfig> = {}): GameKernel => {
    const { kernel } = GameKernel.create({ allowDev: true, maliceLevel: "off", restMs: 0, ...over }, 0, FIXED);
    // 驱动扩展（T5c 前置）：双真人都抽暗牌，全员选定才开窗——只补齐选牌，断言不动
    kernel.apply({ type: "chooseSecret", pid: 0, pick: 0 }, 0);
    for (const q of kernel.state.players.filter((x) => !x.isBot && x.secretPick == null)) kernel.apply({ type: "chooseSecret", pid: q.id, pick: 0 }, 0);
    return kernel;
  };

  it("海关清白/命中谎报/查错人：违禁谎报被抓 / 清白单查错白赔（各交卡落账）", () => {
    const k = bootK({ windowMs: 30_000 });
    k.apply({ type: "dev.customs", sheriff: 0 }, 0); // 警长=人间
    expect(tagsOf(k, "customsOpen", 0)).toHaveLength(1); // 窗存在过判据
    // 货 1：违禁品谎报为正货名 → 被抓
    tryGiveItem(k, 1, "i10", 0); // 弹弓（违禁）
    k.apply({ type: "customsShip", pid: 1, cardId: "i10", to: 2, declared: "i04" }, 0);
    const lied1 = k.state.customs!.shipments.at(-1)!.id;
    k.apply({ type: "customsCheck", pid: 0, shipment: lied1 }, 0);
    expect(tagsOf(k, "customsLied", 1)).toHaveLength(1);
    // 抓谎后的罚没自选（挂账中——先了结再查下一单）
    k.apply({ type: "customsGive", pid: 1, cardId: k.state.players[1]!.hand[0]! }, 0);
    // 货 2：正货如实报 → 警长白赔 1 张
    tryGiveItem(k, 1, "i05", 0);
    k.apply({ type: "customsShip", pid: 1, cardId: "i05", to: 2, declared: "i05" }, 0);
    const clean1 = k.state.customs!.shipments.at(-1)!.id;
    k.apply({ type: "customsCheck", pid: 0, shipment: clean1 }, 0);
    expect(tagsOf(k, "customsClean", 0)).toHaveLength(1);
    k.apply({ type: "customsGive", pid: 0, cardId: k.state.players[0]!.hand[0]! }, 0);
    const result = computeSettlement(k.state);
    expect(result.rows[1]!.goalNos).not.toContain(noOf("customs")); // 命中谎报过
    expect(result.rows[2]!.goalNos).toContain(noOf("customs")); // 全程没被查验抓到
    expect(result.rows[0]!.goalNos).not.toContain(noOf("customs")); // 警长查错白赔=记录不清白（评审收口口径）
    const wc = result.culprits.find((c) => c.kind === "wrongCheck" && c.pid === 0);
    expect(wc).toBeTruthy(); // 找战犯「查验查错人」
    expect(wc!.evidence[0]).toBe(tagsOf(k, "customsClean", 0)[0]); // 证据=那条战报
  });

  it("整局无海关窗=不发空头清白", () => {
    const k = bootK();
    expect(computeSettlement(k.state).rows[0]!.goalNos).not.toContain(noOf("customs"));
  });
});

// ---------- 环境双账 ----------

describe("环境双账（ambientPlayed/ambientDown）", () => {
  it("雷暴 ×2 打出+四拍劈不到自己=风调雨顺；受害者吃到 ambientDown", () => {
    for (let seed = 1; seed < 4000; seed++) {
      const k = boot({ seed, maliceLevel: "off", restMs: 0 }); // restMs=0=逐窗开张（与 toNextWindow 链同钟）
      tryGiveItem(k, 0, "i13", 0);
      k.apply({ type: "playItem", pid: 0, cardId: "i13" }, 0); // 雷暴（打出当回合不触发）
      let t = toNextWindow(k, 0, 30_000, 0); // 劈 1
      t = toNextWindow(k, t, 30_000, 0); // 劈 2（气候到期）
      tryGiveItem(k, 0, "i13", 0);
      k.apply({ type: "playItem", pid: 0, cardId: "i13" }, 0); // 再上 2 拍
      t = toNextWindow(k, t, 30_000, 0);
      t = toNextWindow(k, t, 30_000, 0);
      expect(k.state.ambient).toBeNull(); // 平息
      if (tagsOf(k, "ambientDown", 0).length > 0) continue; // 自己被劈了——换种子
      expect(tagsOf(k, "ambientPlayed", 0)).toHaveLength(2);
      expect(computeSettlement(k.state).rows[0]!.goalNos).toContain(noOf("ambient"));
      const anyVictim = k.state.players.some((p) => tagsOf(k, "ambientDown", p.id).length > 0);
      expect(anyVictim).toBe(true); // 四拍总得劈中点谁
      return;
    }
    throw new Error("找不到自己四拍免劈的种子");
  });

  it("环境负面=任一来源都算：别人打的雷暴劈到自己同样作废", () => {
    for (let seed = 1; seed < 4000; seed++) {
      const k = boot({ seed, maliceLevel: "off", restMs: 0 });
      tryGiveItem(k, 1, "i13", 0);
      k.apply({ type: "playItem", pid: 1, cardId: "i13" }, 0); // P1 打的雷暴
      k.tick(30_001); // 劈 1 人（随机——世界流）
      if (tagsOf(k, "ambientDown", 0).length === 0) continue; // 没劈到 P0——换种子
      // P0 也打出两张环境卡，但吃过别人气候的负面照样作废
      tryGiveItem(k, 0, "i19", 0);
      k.apply({ type: "playItem", pid: 0, cardId: "i19" }, 0); // 暴雨（压掉 P1 的雷暴）
      tryGiveItem(k, 0, "i20", 0);
      k.apply({ type: "playItem", pid: 0, cardId: "i20" }, 0); // 风暴（再压掉暴雨）
      expect(tagsOf(k, "ambientPlayed", 0)).toHaveLength(2);
      expect(computeSettlement(k.state).rows[0]!.goalNos).not.toContain(noOf("ambient"));
      return;
    }
    throw new Error("找不到 P0 被别人雷暴劈中的种子");
  });

  it("风调雨顺的「未吃负面」只看自己的账：别人吃 Down 不折损我的达成", () => {
    for (let seed = 1; seed < 4000; seed++) {
      const k = boot({ seed, maliceLevel: "off", restMs: 0 });
      tryGiveItem(k, 0, "i13", 0);
      k.apply({ type: "playItem", pid: 0, cardId: "i13" }, 0); // P0 打的雷暴
      const t = toNextWindow(k, 0, 30_000, 0); // 劈 1 人
      const victim = [0, 1, 2, 3].find((i) => tagsOf(k, "ambientDown", i).length > 0);
      if (victim == null || victim === 0) continue; // 劈了 P0 自家=作废；没劈中=换种子
      expect(computeSettlement(k.state).rows[0]!.goalNos).not.toContain(noOf("ambient")); // 才 1 张
      tryGiveItem(k, 0, "i19", 0);
      k.apply({ type: "playItem", pid: 0, cardId: "i19" }, 0); // 第 2 张环境卡
      expect(computeSettlement(k.state).rows[0]!.goalNos).toContain(noOf("ambient")); // 别人吃了不算我的账
      return;
    }
    throw new Error("找不到劈中他人的种子");
  });
});

// ---------- 出手账 / 散落账 / 群体失败结算组 ----------

describe("itemPlayed/retiredHand（找战犯素材源）", () => {
  it("出手逐张计数：self/ground/ambient/chooseOther 四路由各打一条 itemPlayed", () => {
    const k = boot({ maliceLevel: "off", windowMs: 30_000, restMs: 0 });
    tryGiveItem(k, 0, "i01", 0); // 顺风靴（self）
    k.apply({ type: "playItem", pid: 0, cardId: "i01" }, 0);
    tryGiveItem(k, 0, "i03", 0); // 香蕉皮（ground）
    k.apply({ type: "playItem", pid: 0, cardId: "i03" }, 0);
    tryGiveItem(k, 0, "i13", 0); // 雷暴（ambient）
    k.apply({ type: "playItem", pid: 0, cardId: "i13" }, 0);
    tryGiveItem(k, 0, "i10", 0); // 弹弓（chooseOther）
    k.apply({ type: "playItem", pid: 0, cardId: "i10", target: 1 }, 0);
    k.tick(30_001); // 指认落账（grudge 计账同拍）
    expect(tagsOf(k, "itemPlayed", 0)).toHaveLength(4);
    expect(computeSettlement(k.state).culprits.some((c) => c.kind === "noCardsPlayed" && c.pid === 0)).toBe(false);
  });

  it("直砸年兽也算出手（最后一波的卡=打过卡）", () => {
    const k = boot({ windowMs: 5, restMs: 0, maliceLevel: "off" });
    for (let i = 0; i < 15; i++) k.tick(Math.max(k.state.windowDeadline, k.state.restUntil) + 1); // 凝滞逐窗跳（jump 驱动）
    expect(k.state.endgame?.beast != null).toBe(true);
    const now = Math.max(k.state.windowDeadline, k.state.restUntil);
    const card = k.state.players[0]!.hand[0]!;
    k.apply({ type: "hitBeast", pid: 0, cardId: card }, now);
    expect(tagsOf(k, "itemPlayed", 0)).toHaveLength(1);
  });

  it("出局手牌散落=retiredHand+cards 落账（治疗吞到死的证据源）", () => {
    const k = boot({ maliceLevel: "off" });
    tryGiveItem(k, 1, "i04", 0);
    tryGiveItem(k, 1, "i05", 0);
    k.apply({ type: "dev.setDead", pid: 1 }, 0);
    const m = retiredMsg(k, 1);
    expect(m.cards).toEqual(["i04", "i05"]);
    expect(m.text).toContain("治疗药水");
    expect(computeSettlement(k.state).culprits.find((c) => c.kind === "healedToDeath" && c.pid === 1)).toBeTruthy();
  });
});

describe("群体失败结算组（T8a2 闸门 × T8b1 结算真账）", () => {
  it("反噬磨光全场 → settlement：goalsVoided 全员真账+称号空+全倒下+大战报「群体失败盖章」", () => {
    const k = boot({ windowMs: 5, restMs: 0, maliceLevel: "mild" });
    for (let i = 0; i < 15; i++) k.tick(Math.max(k.state.windowDeadline, k.state.restUntil) + 1); // 凝滞逐窗跳
    const now = Math.max(k.state.windowDeadline, k.state.restUntil);
    k.apply({ type: "dev.setBeast", hp: 999 }, now);
    for (const p of k.state.players) k.apply({ type: "dev.setHp", pid: p.id, hp: 1 }, now);
    let fx: Fact[] = [];
    let guard = 30;
    while (k.state.phase !== "over" && guard-- > 0) {
      fx = k.tick(Math.max(k.state.windowDeadline, k.state.restUntil) + 1);
    }
    expect(k.state.phase).toBe("over");
    const s = k.state.endgame!.settlement!;
    expect(s.groupFail).toBe(true);
    expect(s.rows.every((r) => r.goalsVoided && r.goalNos.length === 0 && r.titleScore === 0)).toBe(true);
    expect(s.rows.every((r) => r.survive === 0)).toBe(true);
    expect(fx.some((f) => f.type === "settlement" && f.result === s)).toBe(true); // 事实与落账同账
    expect(msg(k, "群体失败盖章")).toBe(true);
    expect(msg(k, "终局结算")).toBe(true);
    expect(msg(k, "找战犯")).toBe(true);
  });
});

// ---------- 样局验收（AC1） ----------

/**
 * 样局（验收 AC1）：4 人各得 15–25 分带目标干净的整局真账。
 * 配方=凝滞世界（windowMs 5ms 走格永远赶不上一窗——T8a2 同款凝滞纪律）：15 窗推完人人原地无陷阱/事件
 * 搅局，年兽战开张后钉净步/血量/兽血，一刀收束——全账无种子依赖（任意种子同账）：
 *   P0 弹弓整蛊 1 次（+2 整蛊分）；四血量钉 7（暴发户不触发）；四活人=幸存者线各 1 条称号。
 *   分账：P0 19＝进度 5＋存活 4＋称号 8＋整蛊 2；P1 16／P2 17／P3 18 同式。
 */
describe("样局验收：4 人各得 15–25 分（五项逐条+目标干净）", () => {
  it("凝滞整局真账：总分带 15..25、五项恒等式、幸存者线/整蛊分逐条对", () => {
    for (const seed of [1, 7, 42, 20261016]) {
      const k = boot({ seed, windowMs: 5, restMs: 0, maliceLevel: "off" });
      // 窗 1 开张即打整蛊：弹弓（违禁）指向阿三——下窗开窗落账
      tryGiveItem(k, 0, "i10", 0);
      k.apply({ type: "playItem", pid: 0, cardId: "i10", target: 2 }, 0);
      // 15 窗凝滞推完 → 年兽战开张（人人 fight，无人砍过）
      const now = beastTestAdvance(k, 15);
      expect(k.state.endgame?.beast != null).toBe(true);
      // 收束钉位：净步 51/46/55/63（进度 5/4/5/6）+血量全 7（暴发户不触发）+兽血 1
      const nets = [51, 46, 55, 63];
      for (const p of k.state.players) k.apply({ type: "dev.setPos", pid: p.id, pos: p.pos, from: null, net: nets[p.id]! }, now);
      for (const p of k.state.players) k.apply({ type: "dev.setHp", pid: p.id, hp: 7 }, now);
      k.apply({ type: "dev.setBeast", hp: 1 }, now);
      const fx = k.apply({ type: "strike", pid: 0 }, now); // 一刀收束（d≥1）
      expect(fx.some((f) => f.type === "beastSlain")).toBe(true);
      const result = k.state.endgame!.settlement!;
      expect(result.groupFail).toBe(false);
      const want = [19, 16, 17, 18];
      result.rows.forEach((r, i) => {
        expect(r.total).toBe(want[i]); // 逐人逐分（§5.1 逐条：进度+通关+存活+称号+整蛊）
        expect(r.total).toBe(r.progress + r.finish + r.survive + r.titleScore + r.grudgeScore);
        expect(r.finishRank).toBeNull(); // 凝滞局无人通关（通关分边界由 settle.test 钉位覆盖）
        expect(r.progress).toBe(nets[i]! < 0 ? 0 : Math.floor(nets[i]! / 10));
        expect(r.survive).toBe(4);
        expect(r.goalNos).toEqual([1]); // 幸存者线（表四 no=1）
        expect(r.titleScore).toBe(TITLE_SCORE);
      });
      expect(result.rows[0]!.grudgeCount).toBe(1); // 弹弓得手 1 次
      expect(result.culprits.filter((c) => c.kind === "noCardsPlayed").map((c) => c.pid)).toEqual([1, 2, 3]); // P0 出过手
    }
  });
});

/** 逐窗凝滞推进（beast.test advanceWindows 同式）：一 tick 跳到当前截止+1=收一窗；返回收完后的截止钟 */
function beastTestAdvance(k: GameKernel, n: number): number {
  for (let i = 0; i < n; i++) k.tick(Math.max(k.state.windowDeadline, k.state.restUntil) + 1);
  return Math.max(k.state.windowDeadline, k.state.restUntil);
}
