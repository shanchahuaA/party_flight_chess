/**
 * 血量口径（#23 T5a，数值表 §5.3）：血量通道单入口收账——
 * 上限 10 可调生效（开局定死、封顶与播报跟着自定义上限走）／治疗封顶不溢出／
 * 同刻多源按到达序逐笔落账（同窗连打战报同序）／事件·道具两路治疗同走一原语／
 * 血尽即淘汰（#34 T5c 接通原 T5a 分界）：死了就死了，治疗拉不起、挂账全清、
 * 手牌回弃牌堆（§5.3 定案）、两路指认跳过、已达成事实保留。
 * 护身符免疫消耗与「先符后盾」通道序已在 items.test 收口，此处不复写。
 */
import { describe, expect, it } from "vitest";
import type { GameKernel } from "../src";
import { M1_ITEM_POOL } from "../src";
import { boot, me, tryGiveItem } from "./helpers";

/** 已在手就不重复塞（尽力注入——目标卡可能被轻装开局摸走，丢一张不炸测试） */
function ensureHand(k: GameKernel, id: string): void {
  tryGiveItem(k, 0, id, 0);
}

describe("血量口径与淘汰（#23 T5a 通道 + #34 T5c 接通）", () => {
  it("上限可调生效：maxHp=6 局开局满 6、万能药从 5 封顶到 6、播报跟着自定义上限走", () => {
    const k = boot({ maxHp: 6 });
    expect(me(k).hp).toBe(6);
    expect(k.state.messages.some((m) => m.text.includes("血量上限 6"))).toBe(true);
    ensureHand(k, "i05");
    k.apply({ type: "dev.setHp", pid: 0, hp: 5 }, 0);
    k.apply({ type: "playItem", pid: 0, cardId: "i05" }, 0);
    expect(me(k).hp).toBe(6); // +4 不溢出自定义上限
    expect(k.state.messages.some((m) => m.text.includes("回 1 血（剩 6/6）"))).toBe(true); // 播报实际生效量（削到只剩 1）
  });

  it("同刻多源有序：同一窗药水→万能药连打按打出顺序逐笔落账（5→7→封 10），战报同序", () => {
    const k = boot();
    ensureHand(k, "i04");
    ensureHand(k, "i05");
    k.apply({ type: "dev.setHp", pid: 0, hp: 5 }, 0);
    const before = k.state.messages.length;
    k.apply({ type: "playItem", pid: 0, cardId: "i04" }, 0);
    expect(me(k).hp).toBe(7); // 第一剂即落账
    k.apply({ type: "playItem", pid: 0, cardId: "i05" }, 0);
    expect(me(k).hp).toBe(10); // 第二剂 7+4 应为 11，削顶 10（不溢出）
    const texts = k.state.messages.slice(before).filter((m) => m.who === 0).map((m) => m.text);
    expect(texts).toEqual([
      "你 打出「治疗药水」",
      "你 回 2 血（剩 7/10）",
      "你 打出「万能药」",
      "你 回 3 血（剩 10/10）", // 实际生效 3（+4 削顶）
    ]);
  });

  it("事件治疗同走一原语：温泉房泡一下从 9 加 2 封顶 10（回 1）；满血泡=回 0（封顶话术说真话）", () => {
    const k = boot();
    k.apply({ type: "dev.setHp", pid: 0, hp: 9 }, 0);
    k.apply({ type: "dev.drawCard", pid: 0, cardId: "e02" }, 0);
    k.apply({ type: "chooseCard", pid: 0, option: 0 }, 0);
    expect(me(k).hp).toBe(10);
    expect(k.state.messages.some((m) => m.text.includes("回 1 血（剩 10/10）"))).toBe(true);

    const before = k.state.messages.length;
    k.apply({ type: "dev.drawCard", pid: 0, cardId: "e02" }, 0);
    k.apply({ type: "chooseCard", pid: 0, option: 0 }, 0);
    expect(me(k).hp).toBe(10);
    expect(k.state.messages.slice(before).some((m) => m.text.includes("回 0 血（剩 10/10）"))).toBe(true);
  });

  it("血尽即淘汰（T5c 兑现 T5a 分界）：恰边界 hp2 吃 1 不死、hp1 吃 1 即死；死了就死了——再挨打/治疗双双 no-op", () => {
    const k = boot();
    k.apply({ type: "dev.setHp", pid: 0, hp: 2 }, 0);
    k.apply({ type: "dev.hit", pid: 0, dmg: 1 }, 0);
    expect(me(k).hp).toBe(1);
    expect(me(k).dead).toBe(false); // 边界上侧：还活着
    const fx = k.apply({ type: "dev.hit", pid: 0, dmg: 1 }, 0);
    expect(me(k).hp).toBe(0);
    expect(me(k).dead).toBe(true); // 血尽即淘汰
    expect(me(k).zone).toBe("main"); // 棋子留在原地观战（不瞬移不回出生格）
    expect(fx.some((f) => f.type === "eliminated" && f.pid === 0)).toBe(true);
    expect(k.state.messages.some((m) => m.text.includes("血尽出局") && m.text.includes("观战"))).toBe(true);
    // 死了就死了：再挨打不再掉账、卡也发不出去（ applyHpDelta / drawEventFor 对死人 no-op——治疗拉不起）
    const before = k.state.messages.length;
    k.apply({ type: "dev.hit", pid: 0, dmg: 3 }, 0);
    k.apply({ type: "dev.drawCard", pid: 0, cardId: "e02" }, 0); // 温泉房指名自己——死人无账
    expect(me(k).hp).toBe(0);
    expect(me(k).dead).toBe(true);
    expect(k.state.messages.slice(before).filter((m) => m.who === 0).map((m) => m.text)).toEqual([]); // 死人再无声息
  });

  it("淘汰即自动出窗清挂账：走格中死亡 → walk/续走队列清空、tick 不再步进；抉择挂起死亡 → cardPending 清、chooseCard 拒", () => {
    const k = boot();
    k.apply({ type: "roll", pid: 0 }, 0); // 走格骰发团（走在路上）
    expect(me(k).walk).not.toBeNull();
    k.apply({ type: "dev.hit", pid: 0, dmg: 10 }, 0);
    expect(me(k).dead).toBe(true);
    expect(me(k).walk).toBeNull(); // 出窗自动清：不再走格
    const fx = k.tick(5_000);
    expect(fx.some((f) => f.type === "step" && f.pid === 0)).toBe(false); // 死人不推进

    const k2 = boot();
    k2.apply({ type: "dev.drawCard", pid: 0, cardId: "e01" }, 0); // 穿堂风：抉择挂起
    expect(me(k2).cardPending).not.toBeNull();
    k2.apply({ type: "dev.hit", pid: 0, dmg: 10 }, 0);
    expect(me(k2).dead).toBe(true);
    expect(me(k2).cardPending).toBeNull(); // 挂起随死清空：超时不再有人代选
    expect(() => k2.apply({ type: "chooseCard", pid: 0, option: 0 }, 0)).toThrow(/待抉择/);
  });

  it("手牌全部回弃牌堆（数值表 §5.3 定案）：出局时在手之卡 → 手牌清空、itemDiscard 入账、单池守恒恒等 M1 池", () => {
    const k = boot();
    // 注入两张（条件化：轻装开局 +1 可能已把目标卡摸走——T5b 教训 ③），以到手张数为准
    tryGiveItem(k, 0, "i04", 0);
    tryGiveItem(k, 0, "i05", 0);
    const given = me(k).hand.length;
    expect(given).toBeGreaterThanOrEqual(2);
    k.apply({ type: "dev.hit", pid: 0, dmg: 10 }, 0);
    expect(me(k).hand).toEqual([]);
    expect(k.state.messages.some((m) => m.text.includes(`手牌 ${given} 张`) && m.text.includes("归还"))).toBe(true);
    // 单池守恒：堆+弃+各家手牌+场上 恒等全池
    expect(
      k.state.itemDeck.length +
        k.state.itemDiscard.length +
        k.state.players.reduce((n, p) => n + p.hand.length, 0) +
        k.state.ground.length,
    ).toBe(M1_ITEM_POOL.length);
  });

  it("指认跳过淘汰者·事件路（e19 随机指认）：同伴全灭 → 指认池只剩活人本人", () => {
    const k = boot();
    for (let i = 1; i < 4; i++) k.apply({ type: "dev.setDead", pid: i }, 0);
    k.apply({ type: "dev.drawCard", pid: 0, cardId: "e19" }, 0); // 庄园鼠横行：随机指认退 2
    const d = k.state.deferred;
    expect(d.length).toBe(1);
    expect(d[0]!.pid).toBe(0); // 唯一活人=本人进指认池（死者不进）
    expect(k.state.messages.some((m) => m.text.includes("下一世界回合开始时结算：你。"))).toBe(true);
  });

  it("已达成事实保留：淘汰不撤身份——暗牌选定/暗牌牌面/净步/在位原样（「活到结算」型失败留 T8b1 判）", () => {
    const k = boot();
    const pre = { pick: me(k).secretPick, opts: [...me(k).secretOptions], net: me(k).net, pos: me(k).pos };
    expect(pre.pick).not.toBeNull(); // 开局已选定（helpers boot 代选 0）
    k.apply({ type: "dev.hit", pid: 0, dmg: 10 }, 0);
    expect(me(k).dead).toBe(true);
    expect(me(k).secretPick).toBe(pre.pick);
    expect(me(k).secretOptions).toEqual(pre.opts); // 暗牌不撤：已达成的目标照判
    expect(me(k).net).toBe(pre.net);
    expect(me(k).pos).toBe(pre.pos);
  });
});
