import { describe, expect, it } from "vitest";
import {
  cardFaceById,
  cardFaceOf,
  effectLines,
  flavorUniquenessReport,
  partText,
} from "./cardFace";
import { M1_EVENT_POOL, M1_ITEM_POOL, TRAP_DEFS } from "../../../kernel/src";

describe("卡面索引：flavor 唯一性守门（#59 的数据面前提）", () => {
  it("事件/道具/陷阱三池 flavor 两两不同（重复=按 flavor 反查会静默配错卡）", () => {
    const r = flavorUniquenessReport();
    expect(r.dups).toEqual([]);
    expect(r.total).toBe(M1_EVENT_POOL.length + M1_ITEM_POOL.length + TRAP_DEFS.length);
  });
});

describe("卡面索引：flavor → 卡面", () => {
  it("事件池每张都能反查到（标题/叙事皮齐全）", () => {
    for (const c of M1_EVENT_POOL) {
      const f = cardFaceOf(c.flavor);
      expect(f, c.id).not.toBeNull();
      expect(f!.title).toBe(c.title);
      expect(f!.pool).toBe("event");
    }
  });

  it("道具池每张都能反查到，且带路由标签", () => {
    for (const c of M1_ITEM_POOL) {
      const f = cardFaceOf(c.flavor);
      expect(f, c.id).not.toBeNull();
      expect(f!.title).toBe(c.title);
      expect(f!.pool).toBe("item");
      expect(f!.routeLabel).toBeTruthy();
    }
  });

  it("陷阱池每张都能反查到", () => {
    for (const { def } of TRAP_DEFS) {
      const f = cardFaceOf(def.flavor);
      expect(f, def.id).not.toBeNull();
      expect(f!.pool).toBe("trap");
      expect(f!.title).toBe(def.name);
    }
  });

  it("无 flavor / 未收录的 flavor → null（组件不出空卡面）", () => {
    expect(cardFaceOf(undefined)).toBeNull();
    expect(cardFaceOf(null)).toBeNull();
    expect(cardFaceOf("")).toBeNull();
    expect(cardFaceOf("这不是任何一张卡的叙事皮")).toBeNull();
  });
});

describe("卡面索引：id → 卡面（按 pool 路由）", () => {
  it("事件卡/道具卡/陷阱各自命中正确池", () => {
    const e = M1_EVENT_POOL[0]!;
    const i = M1_ITEM_POOL[0]!;
    const t = TRAP_DEFS[0]!.def;
    expect(cardFaceById(e.id)!.pool).toBe("event");
    expect(cardFaceById(i.id)!.pool).toBe("item");
    expect(cardFaceById(t.id)!.pool).toBe("trap");
    expect(cardFaceById("nope")).toBeNull();
  });
});

describe("效果投影（机械真话）", () => {
  it("常见原语都能投影成中文", () => {
    expect(partText({ type: "move", v: 3 })).toContain("前进 3");
    expect(partText({ type: "back", v: 2 })).toContain("后退 2");
    expect(partText({ type: "hp", v: -1 })).toContain("掉血 -1");
    expect(partText({ type: "hp", v: 1 })).toContain("回血 +1");
    expect(partText({ type: "skip", v: 1 })).toContain("罚停 1");
    expect(partText({ type: "drawItem", v: 2 })).toContain("摸 2");
    expect(partText({ type: "teleport" })).toContain("出生格");
    expect(partText({ type: "none" })).toBe("无事");
  });

  it("自有效果 + 指向他人的效果都会出", () => {
    const lines = effectLines({
      self: [{ type: "move", v: 1 }],
      others: [{ target: "all", parts: [{ type: "hp", v: -1 }] }],
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("前进 1");
    expect(lines[1]).toContain("全体");
  });

  it("抉择卡的选项各自带效果行", () => {
    const choice = M1_EVENT_POOL.find((c) => c.kind === "choice");
    expect(choice).toBeTruthy();
    const f = cardFaceOf(choice!.flavor)!;
    expect(f.options.length).toBeGreaterThan(0);
    for (const o of f.options) expect(o.label).toBeTruthy();
  });
});
