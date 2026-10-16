/** 棋盘静态数据落位断言（#17 验收：100 格路网与格类型/生态三区落位，比例与数值表 §5.6 一致） */
import { describe, expect, it } from "vitest";
import { BOARD, BRANCH_LEN, ECO_NAMES, SPAWN_CELLS, STREET_NAMES, branchTails, cellAt } from "../src";
import type { CellType, Eco } from "../src";

const countBy = <T, K extends string>(rows: readonly T[], key: (t: T) => K): Record<K, number> => {
  const out = {} as Record<K, number>;
  for (const r of rows) out[key(r)] = (out[key(r)] ?? 0) + 1;
  return out;
};

describe("庄园路网 100 格", () => {
  it("恰好 100 格；13×21 网格内-building", () => {
    expect(BOARD.length).toBe(100);
    for (const c of BOARD) {
      expect(c.col).toBeGreaterThanOrEqual(0);
      expect(c.col).toBeLessThanOrEqual(12);
      expect(c.row).toBeGreaterThanOrEqual(0);
      expect(c.row).toBeLessThanOrEqual(20);
    }
  });

  it("格型配额：事件 38／道具 18／陷阱 14／空格 15／环岛 7·出生 8（§5.6/§5.7 T2 扩槽后全一致）", () => {
    const types = countBy(BOARD, (c) => c.type);
    expect(types.E).toBe(38);
    expect(types.I).toBe(18);
    expect(types.T).toBe(14);
    expect(types.B).toBe(15);
    expect(types.J).toBe(7);
    expect(types.S).toBe(8);
    expect((types.B ?? 0) + (types.J ?? 0) + (types.S ?? 0)).toBe(30);
  });

  it("生态三区：青草平原 64／霜顶雪山 20／鸣沙戈壁 16（外环/中街捷径/巷弄）", () => {
    const zones = countBy(BOARD, (c) => c.zone as Eco);
    expect(zones.plain).toBe(64);
    expect(zones.snow).toBe(20);
    expect(zones.gobi).toBe(16);
    // 生态归属抽查：外环角（6,0）平原、中横街（3,10）雪山、西巷（3,13）戈壁、中竖街（6,13）雪山
    expect(cellAt(6, 0)!.zone).toBe("plain");
    expect(cellAt(3, 10)!.zone).toBe("snow");
    expect(cellAt(3, 13)!.zone).toBe("gobi");
    expect(cellAt(6, 13)!.zone).toBe("snow");
    expect(cellAt(6, 16)!.zone).toBe("snow"); // 四岔环岛归建成它的中竖街（雪山）
  });

  it("陷阱配额 §5.4：平原 4／雪山 4／戈壁 6", () => {
    const traps = countBy(
      BOARD.filter((c) => c.type === "T"),
      (c) => c.zone as Eco,
    );
    expect(traps.plain).toBe(4);
    expect(traps.snow).toBe(4);
    expect(traps.gobi).toBe(6);
  });

  it("7 座环岛 = 6 三岔 + (6,16) 四岔；交叉格即环岛", () => {
    const junc = BOARD.filter((c) => c.type === "J");
    const byDeg = countBy(
      junc.map((c) => ({ deg: c.links.length })),
      (j) => String(j.deg),
    );
    expect(byDeg["3"]).toBe(6);
    expect(byDeg["4"]).toBe(1);
    expect(junc.some((c) => c.col === 6 && c.row === 16 && c.links.length === 4)).toBe(true);
    // 三岔代表：中横街与外环交汇 (0,10)、与西巷交汇 (3,10)
    expect(cellAt(0, 10)!.links.length).toBe(3);
    expect(cellAt(3, 10)!.links.length).toBe(3);
  });

  it("8 个出生槽全在环上、均非环岛（互距离均布断言在 spawn.test）", () => {
    expect(SPAWN_CELLS.length).toBe(8);
    const cells = SPAWN_CELLS.map((id) => BOARD[id]!);
    for (const c of cells) {
      expect(c.street).not.toBe("J");
      expect(c.type).not.toBe("J");
      expect(c.spawnIndex).toBeGreaterThanOrEqual(0);
    }
  });

  it("路网连通：任一格可达；双向链接；格点度 2..4；无孤立格", () => {
    const seen = new Set<number>([SPAWN_CELLS[0]!]);
    const queue = [SPAWN_CELLS[0]!];
    while (queue.length) {
      const id = queue.pop()!;
      for (const l of BOARD[id]!.links) {
        expect(BOARD[l]!.links.includes(id)).toBe(true); // 双向
        if (!seen.has(l)) {
          seen.add(l);
          queue.push(l);
        }
      }
    }
    expect(seen.size).toBe(100);
    for (const c of BOARD) {
      expect(c.links.length).toBeGreaterThanOrEqual(2);
      expect(c.links.length).toBeLessThanOrEqual(4);
    }
  });

  it("街名齐全（外环/中横街/中竖街/西巷/东巷/下横巷/环岛）", () => {
    const streets = new Set(BOARD.map((c) => c.street));
    expect(streets.size).toBe(7);
    for (const k of Object.keys(STREET_NAMES)) expect(streets.has(k as keyof typeof STREET_NAMES)).toBe(true);
  });

  it("终点支路：4 格小路 + 旗位，随出生位向园内伸出、不与主干格重合（8 槽）", () => {
    expect(branchTails.length).toBe(8);
    for (const tail of branchTails) {
      expect(tail.cells.length).toBe(BRANCH_LEN);
      const ids = new Set(BOARD.map((c) => `${c.x},${c.y}`));
      for (const tc of tail.cells) expect(ids.has(`${tc.x},${tc.y}`)).toBe(false);
      expect(ids.has(`${tail.flag.x},${tail.flag.y}`)).toBe(false);
    }
  });
});
