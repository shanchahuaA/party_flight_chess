import { describe, expect, it } from "vitest";
import { HIGHLIGHT_MS, isHighlighted, mergeHighlights, pruneHighlights, type HighlightTable } from "./highlight";

/**
 * 新条目高亮到期表（G-09）的纯逻辑面：判定「哪些 id 是新的」归 cues.deriveHighlights，
 * 这里只做「并进表 / 到期摘掉 / 查」的计时——票面 Testing Decisions 点名的缝。
 * 纯函数、零 Vue/零 DOM（client vitest 是 node 环境）。
 */
describe("高亮到期表：并入", () => {
  it("新 id 并入后到期时刻 = 现在 + 2s（约 2s 高亮是票面数字）", () => {
    const t = mergeHighlights({}, [7], 1_000);
    expect(t).toEqual({ 7: 3_000 });
  });

  it("同一 id 重复并入不延长高亮（重复消息/重连全量不重复高亮）", () => {
    const t1: HighlightTable = { 7: 3_000 };
    const t2 = mergeHighlights(t1, [7], 1_500);
    expect(t2).toEqual({ 7: 3_000 });
  });

  it("空批不改表（每拍都会并一次，没新消息时表原样返回）", () => {
    const t1: HighlightTable = { 7: 3_000 };
    expect(mergeHighlights(t1, [], 1_000)).toEqual({ 7: 3_000 });
  });
});

describe("高亮到期表：到期摘除与查询", () => {
  it("2s 内还在亮，过了到期时刻就不亮", () => {
    const t = mergeHighlights({}, [7], 1_000);
    expect(isHighlighted(t, 7, 1_000)).toBe(true);
    expect(isHighlighted(t, 7, 1_000 + HIGHLIGHT_MS - 1)).toBe(true);
    expect(isHighlighted(t, 7, 1_000 + HIGHLIGHT_MS)).toBe(false);
  });

  it("不在表里的 id 永远不亮（旧条目/首次全量的历史条目）", () => {
    expect(isHighlighted({}, 42, 5_000)).toBe(false);
  });

  it("到期项被摘掉，未到期项保留；无变化时返回原表引用", () => {
    const t: HighlightTable = { 1: 1_500, 2: 4_000 };
    expect(pruneHighlights(t, 2_000)).toEqual({ 2: 4_000 });
    expect(pruneHighlights(t, 1_000)).toBe(t);
  });

  it("并发批次各算各的到期（上一批不因下一批到达而消失）", () => {
    let table: HighlightTable = {};
    table = mergeHighlights(table, [1], 0); // 第 1 批：0..2000
    table = mergeHighlights(table, [2], 1_000); // 第 2 批：1000..3000
    // 第 2 批刚到（1000ms）：第 1 批仍在亮
    expect(isHighlighted(pruneHighlights(table, 1_000), 1, 1_000)).toBe(true);
    expect(isHighlighted(pruneHighlights(table, 1_000), 2, 1_000)).toBe(true);
    // 2500ms：第 1 批已灭、第 2 批还亮
    const t2 = pruneHighlights(table, 2_500);
    expect(isHighlighted(t2, 1, 2_500)).toBe(false);
    expect(isHighlighted(t2, 2, 2_500)).toBe(true);
    // 3000ms 后全灭
    expect(pruneHighlights(table, 3_000)).toEqual({});
  });
});
