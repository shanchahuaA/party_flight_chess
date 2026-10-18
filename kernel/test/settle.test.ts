/**
 * 结算判定核（#36 T8b1，数值表 §5.1 五项积分 + 表四十条称号 + 找战犯聚合）——纯聚合层：
 * - 计数真源=战报流 MsgTag 折叠（foldTags）；本文件给的是**标签账边界**（合成战报+状态钉位）；
 *   发射点真的会打标签（grudge/gamble/dog/customs/ambient/hp/retiredHand/itemPlayed）由 settle-flow.test 实流验证；
 * - 口径：进度分负净步 0 保底；淘汰者已达成照判、「活到结算」型自然失败；群体失败=全员称号作废（整蛊分不折损）；
 *   海关清白=窗存在过且零谎报；环境负面=任一来源都算吃了。
 */
import { describe, expect, it } from "vitest";
import { FINISH_SCORES, GameKernel, computeSettlement, foldTags, finishScore, GRUDGE_SCORE, PROGRESS_DIVISOR, SURVIVE_SCORE, TITLE_SCORE, SECRET_GOALS } from "../src";
import type { MsgTag } from "../src";
import { boot } from "./helpers";

/** 给战报流追一条合成计数条目（发射点真容由 settle-flow 验证——本文件只喂纯折叠的口粮） */
const tagMsg = (k: GameKernel, tag: MsgTag, who: number, cards?: string[]): number => {
  k.state.messages.push({ id: ++k.state.seq, turn: k.state.turn, kind: "system", text: `[测试标签] ${tag}`, who, tags: [tag], ...(cards ? { cards } : {}) });
  return k.state.seq;
};
const goalNo = (counter: string): number => SECRET_GOALS.find((g) => g.counter === counter)!.no;
const rowOf = (k: GameKernel, pid: number) => computeSettlement(k.state).rows[pid]!;

describe("积分五项（数值表 §5.1 逐条）", () => {
  it("进度分=净步÷10 向下取整；边界 0/9/10/99/100 → 0/0/1/9/10；负净步 0 保底不倒扣", () => {
    const k = boot();
    for (const [net, want] of [[0, 0], [9, 0], [10, 1], [99, 9], [100, 10], [-7, 0]] as const) {
      k.apply({ type: "dev.setPos", pid: 0, pos: k.state.players[0]!.pos, from: null, net }, 0);
      expect(rowOf(k, 0).progress).toBe(want);
    }
  });

  it("通关分=入席名次分位（第 1..4 位 → 10/8/6/0）；未入席=0", () => {
    const k = boot();
    k.state.finishers = [2, 1, 3]; // 名次钉位（zone 同步——达成事实看在位）
    k.state.players[0]!.zone = "main";
    k.state.players[1]!.zone = "done";
    k.state.players[2]!.zone = "done";
    k.state.players[3]!.zone = "done";
    const rows = computeSettlement(k.state).rows;
    expect(rows[2]!.finishRank).toBe(1);
    expect(rows[2]!.finish).toBe(10);
    expect(rows[1]!.finishRank).toBe(2);
    expect(rows[1]!.finish).toBe(8);
    expect(rows[3]!.finishRank).toBe(3);
    expect(rows[3]!.finish).toBe(6);
    expect(rows[0]!.finishRank).toBeNull();
    expect(rows[0]!.finish).toBe(0);
  });

  it("存活分：活到结算 +4；终局里倒下=0（淘汰通关席也照倒）", () => {
    const k = boot();
    k.apply({ type: "dev.setDead", pid: 1 }, 0);
    expect(rowOf(k, 1).survive).toBe(0);
    expect(rowOf(k, 0).survive).toBe(SURVIVE_SCORE);
  });

  it("称号分=+8×达成条数；整蛊分=+2×成功次数（标签计数）", () => {
    const k = boot();
    tagMsg(k, "grudge", 0);
    tagMsg(k, "grudge", 0);
    for (let i = 0; i < 5; i++) k.state.players[0]!.hand.push(`x${i}`); // 囤积癖达成（hand ≥5）
    const r0 = rowOf(k, 0);
    expect(r0.grudgeCount).toBe(2);
    expect(r0.grudgeScore).toBe(2 * GRUDGE_SCORE);
    expect(r0.goalNos).toContain(goalNo("handAtEnd"));
    expect(r0.titleScore).toBe(r0.goalNos.length * TITLE_SCORE); // 达成数×8（轻装活人自带幸存者/暴发户——账自洽即可）
    expect(r0.total).toBe(r0.progress + r0.finish + r0.survive + r0.titleScore + r0.grudgeScore);
  });

  it("总分行恒等式：total＝五项之和（全体逐行对账）", () => {
    const k = boot();
    tagMsg(k, "grudge", 1);
    tagMsg(k, "dogKilled", 1);
    tagMsg(k, "gambleWin", 2);
    k.apply({ type: "dev.hit", pid: 1, dmg: 1 }, 0);
    const result = computeSettlement(k.state);
    for (const r of result.rows) {
      expect(r.total).toBe(r.progress + r.finish + r.survive + r.titleScore + r.grudgeScore);
    }
  });

  it("分位真源单一导出：FINISH_SCORES=[10,8,6]、finishScore 名次映射第四位起无分位", () => {
    expect(FINISH_SCORES).toEqual([10, 8, 6]);
    expect(finishScore(1)).toBe(10);
    expect(finishScore(4)).toBe(0);
  });
});

describe("十条称号逐条边界（表四）", () => {
  it("🛡 幸存者：活到结算=达成；淘汰=自然失败（「活到结算」型）", () => {
    const k = boot();
    expect(rowOf(k, 0).goalNos).toContain(goalNo("survive"));
    k.apply({ type: "dev.setDead", pid: 0 }, 0);
    expect(rowOf(k, 0).goalNos).not.toContain(goalNo("survive"));
  });

  it("🏃 马拉松：踩进旗位（通关席）=达成；淘汰的通关席达成保留（事实不撤）", () => {
    const k = boot();
    expect(rowOf(k, 0).goalNos).not.toContain(goalNo("finish"));
    k.apply({ type: "dev.setDead", pid: 0 }, 0); // 先淘汰
    k.state.players[0]!.zone = "done"; // 在位原样（T5c：淘汰不撤身份）
    k.state.finishers.push(0);
    expect(rowOf(k, 0).goalNos).toContain(goalNo("finish"));
  });

  it("😈 整蛊王：≥3 次达成；2 次差一口气", () => {
    const k = boot();
    for (let i = 0; i < 2; i++) tagMsg(k, "grudge", 0);
    expect(rowOf(k, 0).goalNos).not.toContain(goalNo("grudge"));
    tagMsg(k, "grudge", 0);
    expect(rowOf(k, 0).goalNos).toContain(goalNo("grudge"));
  });

  it("🎒 囤积癖：结算时手牌 ≥5=达成；4 张不够；淘汰者手牌散尽=自然失败", () => {
    const k = boot();
    k.state.players[0]!.hand = []; // 清开局手牌（轻装上阵 +1——边界只看本测试塞的数）
    for (let i = 0; i < 4; i++) k.state.players[0]!.hand.push(`x${i}`);
    expect(rowOf(k, 0).goalNos).not.toContain(goalNo("handAtEnd"));
    k.state.players[0]!.hand.push("x4");
    expect(rowOf(k, 0).goalNos).toContain(goalNo("handAtEnd"));
    // 淘汰者：手牌已回弃牌堆（T5c）=0 张——「结算时攒 ≥5」自然失败
    k.apply({ type: "dev.setDead", pid: 1 }, 0);
    expect(rowOf(k, 1).goalNos).not.toContain(goalNo("handAtEnd"));
  });

  it("🎲 赌狗：赌狗卡赢 ≥2 次=达成；只赢 1 次=差一口气", () => {
    const k = boot();
    tagMsg(k, "gambleWin", 0);
    expect(rowOf(k, 0).goalNos).not.toContain(goalNo("gamble"));
    tagMsg(k, "gambleWin", 0);
    expect(rowOf(k, 0).goalNos).toContain(goalNo("gamble"));
  });

  it("🧣 海关清白：开过海关窗且零「命中谎报」=达成；被抓一次=没了；查错人白赔=记录不清白；整局无海关窗=无处全程（不发空头清白）", () => {
    const k = boot();
    expect(rowOf(k, 0).goalNos).not.toContain(goalNo("customs")); // 没开过窗
    tagMsg(k, "customsOpen", 0);
    expect(rowOf(k, 0).goalNos).toContain(goalNo("customs"));
    tagMsg(k, "customsLied", 1); // 别家被抓——自家仍清白
    expect(rowOf(k, 0).goalNos).toContain(goalNo("customs"));
    tagMsg(k, "customsLied", 0); // 自家命中谎报
    expect(rowOf(k, 0).goalNos).not.toContain(goalNo("customs"));
    // 查错人（警长白赔卡）同样非清白——与找战犯「查验查错人」同账（评审收口：又赔卡又拿清白=矛盾）
    const k2 = boot();
    tagMsg(k2, "customsOpen", 0);
    tagMsg(k2, "customsClean", 0);
    expect(rowOf(k2, 0).goalNos).not.toContain(goalNo("customs"));
  });

  it("🐕 打狗英雄：击毙野狗 ≥2 只=达成；1 只不够；淘汰者的战果照判保留", () => {
    const k = boot();
    tagMsg(k, "dogKilled", 0);
    expect(rowOf(k, 0).goalNos).not.toContain(goalNo("dogs"));
    tagMsg(k, "dogKilled", 0);
    expect(rowOf(k, 0).goalNos).toContain(goalNo("dogs"));
    k.apply({ type: "dev.setDead", pid: 0 }, 0); // 战后淘汰——已达成不撤
    expect(rowOf(k, 0).goalNos).toContain(goalNo("dogs"));
  });

  it("💰 暴发户：结算时血量 ≥8=达成；7 血差一口气；淘汰者血尽 0=失败", () => {
    const k = boot();
    k.apply({ type: "dev.setHp", pid: 0, hp: 8 }, 0);
    expect(rowOf(k, 0).goalNos).toContain(goalNo("hpAtEnd"));
    k.apply({ type: "dev.setHp", pid: 0, hp: 7 }, 0);
    expect(rowOf(k, 0).goalNos).not.toContain(goalNo("hpAtEnd"));
    // 淘汰者：血尽定格 0（retirePlayer 清零）——「结算时血量 ≥8」不成立
    k.apply({ type: "dev.setHp", pid: 1, hp: 10 }, 0);
    k.apply({ type: "dev.setDead", pid: 1 }, 0);
    expect(k.state.players[1]!.hp).toBe(0);
    expect(rowOf(k, 1).goalNos).not.toContain(goalNo("hpAtEnd"));
  });

  it("🪨 硬骨头：承受 ≥3 次扣血仍活着=达成；2 次不够；第 3 口咬死=「仍活着」不成立", () => {
    const k = boot();
    k.apply({ type: "dev.hit", pid: 0, dmg: 1 }, 0);
    k.apply({ type: "dev.hit", pid: 0, dmg: 1 }, 0);
    expect(rowOf(k, 0).goalNos).not.toContain(goalNo("hitsTaken"));
    k.apply({ type: "dev.hit", pid: 0, dmg: 1 }, 0); // 第三口——还活着（剩 7）
    expect(rowOf(k, 0).goalNos).toContain(goalNo("hitsTaken"));
    k.apply({ type: "dev.hit", pid: 0, dmg: 7 }, 0); // 血尽
    expect(rowOf(k, 0).goalNos).not.toContain(goalNo("hitsTaken"));
  });

  it("🌦 风调雨顺：打出 ≥2 张环境卡且未吃环境负面=达成；1 张不够；吃了负面（任一来源）=作废", () => {
    const k = boot();
    tagMsg(k, "ambientPlayed", 0);
    expect(rowOf(k, 0).goalNos).not.toContain(goalNo("ambient"));
    tagMsg(k, "ambientPlayed", 0);
    expect(rowOf(k, 0).goalNos).toContain(goalNo("ambient"));
    tagMsg(k, "ambientDown", 0); // 被雷暴劈中/摔倒/顶风——吃了
    expect(rowOf(k, 0).goalNos).not.toContain(goalNo("ambient"));
  });
});

describe("群体失败闸门消费（T8a2 → T8b1）", () => {
  it("群体失败=全员暗牌目标作废（含已达成）：goalNos 全空+称号分 0；整蛊分不折损；通关分保留", () => {
    const k = boot();
    // 铺一张「本来达成」的账：通关席+打狗英雄+整蛊×2
    k.state.players[1]!.zone = "done";
    k.state.finishers = [1];
    tagMsg(k, "dogKilled", 1);
    tagMsg(k, "dogKilled", 1);
    tagMsg(k, "grudge", 1);
    tagMsg(k, "grudge", 1);
    tagMsg(k, "grudge", 1);
    k.state.endgame = { turn: 16, beast: null, groupFail: true };
    const result = computeSettlement(k.state);
    expect(result.groupFail).toBe(true);
    expect(result.rows.every((r) => r.goalsVoided && r.goalNos.length === 0 && r.titleScore === 0)).toBe(true);
    expect(result.rows[1]!.finish).toBe(10); // 通关分=已达成事实保留
    expect(result.rows[1]!.grudgeScore).toBe(3 * GRUDGE_SCORE); // 整蛊分不折损
  });

  it("非群体失败：达成照判（goalsVoided=false）", () => {
    const k = boot();
    tagMsg(k, "dogKilled", 0);
    tagMsg(k, "dogKilled", 0);
    const r = rowOf(k, 0);
    expect(r.goalsVoided).toBe(false);
    expect(r.goalNos).toContain(goalNo("dogs"));
  });
});

describe("找战犯三类聚合（只给数据不做裁决）", () => {
  it("整局没打过卡：0 次 itemPlayed=点名；出过手的豁免", () => {
    const k = boot();
    tagMsg(k, "itemPlayed", 0);
    const result = computeSettlement(k.state);
    const kinds = result.culprits.filter((c) => c.kind === "noCardsPlayed").map((c) => c.pid);
    expect(kinds).not.toContain(0); // 出过手
    expect(kinds).toContain(1); // 没出过手
  });

  it("治疗吞到死：出局手里还揣着治疗卡=点名（证据=散落战报条目）；手里没治疗的死者不出", () => {
    const k = boot();
    k.apply({ type: "dev.setHp", pid: 1, hp: 1 }, 0);
    k.apply({ type: "dev.giveItem", pid: 1, cardId: "i04" }, 0); // 治疗药水揣着
    k.apply({ type: "dev.giveItem", pid: 1, cardId: "i05" }, 0); // 万能药也揣着
    k.apply({ type: "dev.setDead", pid: 1 }, 0); // 血尽——手牌散落
    const result = computeSettlement(k.state);
    const c = result.culprits.find((x) => x.kind === "healedToDeath" && x.pid === 1);
    expect(c).toBeTruthy();
    expect(c!.detail).toContain("治疗药水");
    expect(c!.detail).toContain("万能药");
    const deathMsg = k.state.messages.find((m) => m.id === c!.evidence[0]);
    expect(deathMsg?.text).toContain("散落归还牌堆"); // 证据可溯源=就是那条战报
  });

  it("查验查错人：白赔卡的警长=点名（次数+证据条目）；没查错的警长不出", () => {
    const k = boot();
    tagMsg(k, "customsClean", 0);
    tagMsg(k, "customsClean", 0);
    tagMsg(k, "customsClean", 1);
    const result = computeSettlement(k.state);
    const c0 = result.culprits.find((x) => x.kind === "wrongCheck" && x.pid === 0)!;
    expect(c0.detail).toContain("2 次");
    expect(c0.evidence.length).toBe(2);
    expect(c0.evidence[0]! < c0.evidence[1]!).toBe(true); // 按战报序可溯源
  });

  it("查无战犯：人人出过手、没人揣治疗死、没查错过=空表", () => {
    const k = boot();
    for (const p of k.state.players) tagMsg(k, "itemPlayed", p.id);
    const result = computeSettlement(k.state);
    expect(result.culprits).toEqual([]);
  });

  it("活人手里揣治疗不算（「吞到死」=出局时点）；治疗卡已打出的死者不出", () => {
    const k = boot();
    k.apply({ type: "dev.giveItem", pid: 1, cardId: "i04" }, 0); // 活着揣着药水——不算战犯
    let result = computeSettlement(k.state);
    expect(result.culprits.some((x) => x.kind === "healedToDeath")).toBe(false);
    // 死者但药水已在手外（打掉了）——也不出
    k.apply({ type: "dev.setDead", pid: 2 }, 0);
    result = computeSettlement(k.state);
    expect(result.culprits.some((x) => x.kind === "healedToDeath" && x.pid === 2)).toBe(false);
  });
});

describe("foldTags 折叠边界", () => {
  it("无标签战报=空账；同人同标签多条=逐条计数+证据按战报序", () => {
    const k = boot();
    const t = foldTags(k.state.messages);
    expect(t.count("grudge", 0)).toBe(0);
    tagMsg(k, "grudge", 0);
    tagMsg(k, "grudge", 0);
    const t2 = foldTags(k.state.messages);
    expect(t2.count("grudge", 0)).toBe(2);
    expect(t2.evidence("grudge", 0).length).toBe(2);
  });
});
