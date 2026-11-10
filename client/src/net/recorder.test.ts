import { describe, expect, it } from "vitest";
import {
  buildExport,
  expandGame,
  mergeDedup,
  recEnabled,
  RingBuffer,
  storageKey,
  type RecEntry,
} from "./recorder";

function entry(over: Partial<RecEntry> = {}): RecEntry {
  return { t: 1, sn: 1, k: "game", d: "fact", f: "roll", ...over };
}

describe("环形缓冲（#51 缓冲与导出）", () => {
  it("未满时按序铺平", () => {
    const b = new RingBuffer<number>(3);
    b.push(1);
    b.push(2);
    expect(b.toArray()).toEqual([1, 2]);
    expect(b.length).toBe(2);
  });

  it("超上限丢最旧", () => {
    const b = new RingBuffer<number>(3);
    for (const n of [1, 2, 3, 4, 5]) b.push(n);
    expect(b.toArray()).toEqual([3, 4, 5]);
    expect(b.dropped).toBe(2);
  });

  it("clear 后计数归零", () => {
    const b = new RingBuffer<number>(2);
    b.push(1);
    b.clear();
    expect(b.toArray()).toEqual([]);
    expect(b.length).toBe(0);
  });
});

describe("localStorage 键位", () => {
  it("按房号分桶、无房用 solo", () => {
    expect(storageKey("ABCDE")).toBe("pfc.rec.ABCDE");
    expect(storageKey(null)).toBe("pfc.rec.solo");
  });
});

describe("去重合并（锁屏重载后不重复）", () => {
  it("同 t+sn+k+d+f 视为同一条", () => {
    const a = [entry({ t: 100 }), entry({ t: 200 })];
    const b = [entry({ t: 200 }), entry({ t: 300 })];
    expect(mergeDedup(a, b).map((r) => r.t)).toEqual([100, 200, 300]);
  });

  it("保留 base 的顺序（旧账在前）", () => {
    const a = [entry({ t: 50, f: "x" })];
    const b = [entry({ t: 10, f: "y" })];
    expect(mergeDedup(a, b).map((r) => r.f)).toEqual(["x", "y"]);
  });

  it("error 原文参与去重键（同毫秒两条不同 error 不合并）", () => {
    const a = [entry({ d: "msg", k: "error", e: "甲" })];
    const b = [entry({ d: "msg", k: "error", e: "乙" })];
    expect(mergeDedup(a, b)).toHaveLength(2);
  });
});

describe("game 消息展开（#51 每条记录的字段）", () => {
  const base = { t: 1000, sn: 990, mySeat: 2, ws: "open" };

  it("facts 逐条展开成独立记录，type 提到 f、其余进 v", () => {
    const rows = expandGame(
      { facts: [{ type: "roll", pid: 0, d: 5, auto: false }, { type: "windowEnd", turn: 3, auto: true }] },
      base,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ k: "game", d: "fact", f: "roll", v: { pid: 0, d: 5, auto: false } });
    expect(rows[1]).toMatchObject({ f: "windowEnd", v: { turn: 3, auto: true } });
    expect(rows[0]!.sn).toBe(990);
    expect(rows[0]!.t).toBe(1000);
  });

  it("战报条目整批挂一条 state 记录，并带心跳快照", () => {
    const rows = expandGame(
      {
        facts: [],
        messages: [{ id: 1, text: "x" }],
        state: { turn: 4, phase: "acting", players: [{ hp: 7, hand: ["a", "b"] }] },
      },
      base,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ d: "state" });
    expect((rows[0]!.m as unknown[]).length).toBe(1);
    expect(rows[0]!.st).toMatchObject({ turn: 4, phase: "acting", seat: 2, hp: 7, hand: 2, ws: "open" });
  });

  it("无战报时也留一条心跳快照（判「这台还在收消息」）", () => {
    const rows = expandGame({ facts: [], messages: [], state: { turn: 1, phase: "acting", players: [{}] } }, base);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.d).toBe("state");
    expect(rows[0]!.m).toBeUndefined();
    expect(rows[0]!.st?.turn).toBe(1);
  });

  it("无 state 的极小载荷不崩", () => {
    const rows = expandGame({ facts: [{ type: "gameEnd" }] }, base);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.f).toBe("gameEnd");
  });
});

describe("?rec=1 门控", () => {
  it("带 rec 参数启用（与 dev 可共存）", () => {
    expect(recEnabled("?rec=1")).toBe(true);
    expect(recEnabled("?rec&dev=1")).toBe(true);
    expect(recEnabled("?rec=1&room=ABCDE")).toBe(true);
  });

  it("不带 rec 一律不启用", () => {
    expect(recEnabled("")).toBe(false);
    expect(recEnabled("?dev=1")).toBe(false);
    expect(recEnabled("?room=ABCDE")).toBe(false);
  });
});

describe("导出对象形状", () => {
  it("顶层含 v/ua/screen/launchedAt/room/seat/recs", () => {
    const out = buildExport([entry()], {
      ua: "UA",
      screen: "390x844@3",
      launchedAt: 123,
      room: "ABCDE",
      seat: 1,
    });
    expect(out).toMatchObject({ v: 1, ua: "UA", screen: "390x844@3", launchedAt: 123, room: "ABCDE", seat: 1 });
    expect(out.recs).toHaveLength(1);
  });
});
