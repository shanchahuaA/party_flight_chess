import { describe, expect, it } from "vitest";
import type { Fact, MessageEntry } from "../../../kernel/src";
import { cuesOf, deriveHighlights, derivePulses, deriveSounds, type CueView } from "./cues";

/** 极简战报条目（只填判定读的字段：id/turn/kind/text/who/targets/emphasis/tags） */
function msg(over: Partial<MessageEntry> & { id: number }): MessageEntry {
  return { turn: 1, kind: "event", text: "", ...over } as MessageEntry;
}

const VIEW: CueView = {
  mePid: 0,
  phase: "acting",
  timerMode: "world",
  turnActorBefore: null,
  turnActorAfter: null,
  meDead: false,
};

describe("脉冲判定（G-10 / G-11）", () => {
  it("who===0 的条目派生出 normal（自己踩事件/陷阱）", () => {
    const p = derivePulses({ facts: [], newMessages: [msg({ id: 1, who: 0 })] }, 0);
    expect(p[0]).toBe("normal");
  });

  it("别人 who 的条目不为我产生脉冲", () => {
    const p = derivePulses({ facts: [], newMessages: [msg({ id: 1, who: 2 })] }, 0);
    expect(p[0]).toBeUndefined();
  });

  it("targets 含我且 emphasis=target → target", () => {
    const p = derivePulses(
      { facts: [], newMessages: [msg({ id: 1, who: 3, targets: [0], emphasis: "target" })] },
      0,
    );
    expect(p[0]).toBe("target");
  });

  it("别人的被命中在我屏上也亮（目标不等于我时亮目标）", () => {
    const p = derivePulses(
      { facts: [], newMessages: [msg({ id: 1, who: 3, targets: [2], emphasis: "target" })] },
      0,
    );
    expect(p[2]).toBe("target");
    expect(p[3]).toBeUndefined();
  });

  it("既有事实的 target/big 优先于派生", () => {
    const facts: Fact[] = [{ type: "pulse", pid: 0, level: "big" }];
    const p = derivePulses({ facts, newMessages: [msg({ id: 1, who: 0 })] }, 0);
    expect(p[0]).toBe("big");
  });

  it("同批多事件取最高档（normal → target → big）", () => {
    // 派生只到 target 档：big 只能从事实来（内核年兽/大灾难才是 big）
    const facts: Fact[] = [
      { type: "pulse", pid: 0, level: "target" },
      { type: "pulse", pid: 0, level: "big" },
    ];
    const p = derivePulses(
      {
        facts,
        newMessages: [
          msg({ id: 1, who: 0 }),
          msg({ id: 2, who: 1, targets: [0], emphasis: "target" }),
          msg({ id: 3, who: 0 }),
        ],
      },
      0,
    );
    expect(p[0]).toBe("big");
  });

  it("系统/summary/score 类条目不产生脉冲", () => {
    const p = derivePulses(
      {
        facts: [],
        newMessages: [
          msg({ id: 1, kind: "system", who: 0 }),
          msg({ id: 2, kind: "summary", who: 0 }),
          msg({ id: 3, kind: "score", who: 0 }),
        ],
      },
      0,
    );
    expect(p).toEqual({});
  });

  it("未带 targets 的 target 条目不为任何人产生 target（防误亮）", () => {
    const p = derivePulses({ facts: [], newMessages: [msg({ id: 1, who: 2, emphasis: "target" })] }, 0);
    expect(p).toEqual({});
  });
});

describe("音效判定（A-01 / A-07）", () => {
  it("自己掷骰响 roll，别人掷骰不响", () => {
    expect(deriveSounds({ facts: [{ type: "roll", pid: 0, d: 5, auto: false }], newMessages: [] }, VIEW)).toEqual(["roll"]);
    expect(deriveSounds({ facts: [{ type: "roll", pid: 1, d: 5, auto: false }], newMessages: [] }, VIEW)).toEqual([]);
  });

  it("自己踩事件格抽卡响 draw，别人抽卡不响", () => {
    expect(deriveSounds({ facts: [{ type: "cardDrawn", pid: 0, cardId: "e01" }], newMessages: [] }, VIEW)).toEqual(["draw"]);
    expect(deriveSounds({ facts: [{ type: "cardDrawn", pid: 2, cardId: "e01" }], newMessages: [] }, VIEW)).toEqual([]);
  });

  it("自己打牌响 play", () => {
    expect(deriveSounds({ facts: [{ type: "itemPlayed", pid: 0, cardId: "i01" }], newMessages: [] }, VIEW)).toEqual(["play"]);
  });

  it("自己扣血响 hurt（战报 hpLost 标签）；别人扣血不响", () => {
    expect(
      deriveSounds({ facts: [], newMessages: [msg({ id: 1, who: 0, tags: ["hpLost"] })] }, VIEW),
    ).toEqual(["hurt"]);
    expect(
      deriveSounds({ facts: [], newMessages: [msg({ id: 1, who: 1, tags: ["hpLost"] })] }, VIEW),
    ).toEqual([]);
  });

  it("群伤只响一次（年兽反噬 + 多条 hpLost 去重）", () => {
    const s = deriveSounds(
      {
        facts: [{ type: "beastRoar", dmg: 1 }],
        newMessages: [
          msg({ id: 1, who: 0, tags: ["hpLost"] }),
          msg({ id: 2, who: 0, tags: ["hpLost"] }),
        ],
      },
      VIEW,
    );
    expect(s).toEqual(["hurt"]);
  });

  it("年兽出场响 beast；击杀响 win；群体失败响 fail", () => {
    expect(deriveSounds({ facts: [{ type: "beastWave", wave: 1, hp: 30, maxHp: 30 }], newMessages: [] }, VIEW)).toEqual(["beast"]);
    expect(deriveSounds({ facts: [{ type: "beastSlain", wave: 3 }], newMessages: [] }, VIEW)).toEqual(["win"]);
    expect(deriveSounds({ facts: [{ type: "groupFail" }], newMessages: [] }, VIEW)).toEqual(["fail"]);
  });

  it("结算得分响 score", () => {
    expect(deriveSounds({ facts: [{ type: "settlement", result: {} as never }], newMessages: [] }, VIEW)).toEqual(["score"]);
  });

  it("自己出局响 out", () => {
    expect(deriveSounds({ facts: [{ type: "eliminated", pid: 0 }], newMessages: [] }, VIEW)).toEqual(["out"]);
    expect(deriveSounds({ facts: [{ type: "eliminated", pid: 1 }], newMessages: [] }, VIEW)).toEqual([]);
  });

  it("轮到自己：仅轮班模式且确实变成我时响", () => {
    const turnView: CueView = { ...VIEW, timerMode: "turn", turnActorBefore: 2, turnActorAfter: 0 };
    expect(deriveSounds({ facts: [], newMessages: [] }, turnView)).toEqual(["turn"]);
    // world 模式没有「轮到」概念
    expect(deriveSounds({ facts: [], newMessages: [] }, { ...turnView, timerMode: "world" })).toEqual([]);
    // 本来就是我（未换人）不再响
    expect(deriveSounds({ facts: [], newMessages: [] }, { ...turnView, turnActorBefore: 0 })).toEqual([]);
    // 换成别人
    expect(deriveSounds({ facts: [], newMessages: [] }, { ...turnView, turnActorAfter: 3 })).toEqual([]);
  });

  it("已出局的我不再听见轮到自己/反噬", () => {
    const dead: CueView = { ...VIEW, timerMode: "turn", turnActorBefore: 1, turnActorAfter: 0, meDead: true };
    expect(deriveSounds({ facts: [{ type: "beastRoar", dmg: 1 }], newMessages: [] }, dead)).toEqual([]);
    expect(deriveSounds({ facts: [], newMessages: [] }, dead)).toEqual([]);
  });
});

describe("新条目高亮（G-09）", () => {
  it("首帧全量批一条都不高亮", () => {
    expect(deriveHighlights([msg({ id: 1 }), msg({ id: 2 })], 0, true)).toEqual([]);
  });

  it("增量批里 id > 已见最大 id 的全部高亮", () => {
    expect(deriveHighlights([msg({ id: 4 }), msg({ id: 5 })], 3, false)).toEqual([4, 5]);
  });

  it("重复 id 不重复高亮", () => {
    expect(deriveHighlights([msg({ id: 6 }), msg({ id: 6 })], 5, false)).toEqual([6]);
  });

  it("重连全量（id 全部 <= 已见）不高亮", () => {
    expect(deriveHighlights([msg({ id: 1 }), msg({ id: 2 })], 2, false)).toEqual([]);
  });
});

describe("cuesOf 一站式入口", () => {
  it("三张表一次算出，且互不串味", () => {
    const r = cuesOf(
      {
        facts: [{ type: "roll", pid: 0, d: 4, auto: false }],
        newMessages: [msg({ id: 9, who: 0, tags: ["hpLost"] })],
      },
      VIEW,
      8,
    );
    expect(r.sounds).toEqual(["roll", "hurt"]);
    expect(r.pulses).toEqual({ 0: "normal" });
    expect(r.highlights).toEqual([9]);
  });

  it("full=true 时高亮清空、音效与脉冲照常", () => {
    const r = cuesOf(
      { facts: [{ type: "pulse", pid: 0, level: "big" }], newMessages: [msg({ id: 9, who: 0 })] },
      VIEW,
      0,
      true,
    );
    expect(r.sounds).toEqual([]);
    expect(r.pulses).toEqual({ 0: "big" });
    expect(r.highlights).toEqual([]);
  });
});
