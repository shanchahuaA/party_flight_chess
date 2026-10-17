/**
 * 血量口径（#23 T5a，数值表 §5.3）：血量通道单入口收账——
 * 上限 10 可调生效（开局定死、封顶与播报跟着自定义上限走）／治疗封顶不溢出／
 * 同刻多源按到达序逐笔落账（同窗连打战报同序）／事件·道具两路治疗同走一原语／
 * 血尽归零只播报不淘汰（淘汰流程=T5c 分界，本票不接）。
 * 护身符免疫消耗与「先符后盾」通道序已在 items.test 收口，此处不复写。
 */
import { describe, expect, it } from "vitest";
import { GameKernel } from "../src";
import { boot, me } from "./helpers";

/** 保票塞卡：已在手牌（轻装上阵开局 +1 可能撞上）就不重复塞 */
function ensureHand(k: GameKernel, id: string): void {
  if (!me(k).hand.includes(id)) k.apply({ type: "dev.giveItem", pid: 0, cardId: id }, 0);
}

describe("血量口径（#23 T5a）", () => {
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

  it("血尽归零只播报不淘汰（T5a/T5c 分界）：hp1 吃 1 → 0、dead 不翻转、战报点名血尽；归零仍可被治疗拉起", () => {
    const k = boot();
    k.apply({ type: "dev.setHp", pid: 0, hp: 1 }, 0);
    k.apply({ type: "dev.hit", pid: 0, dmg: 1 }, 0);
    expect(me(k).hp).toBe(0);
    expect(me(k).dead).toBe(false); // 淘汰流程=T5c，本票只播报
    expect(me(k).zone).toBe("main");
    expect(k.state.messages.some((m) => m.text.includes("血尽=淘汰"))).toBe(true);
    k.apply({ type: "dev.drawCard", pid: 0, cardId: "e02" }, 0);
    k.apply({ type: "chooseCard", pid: 0, option: 0 }, 0);
    expect(me(k).hp).toBe(2); // 归零非吸收态：治疗照常拉起
  });
});
