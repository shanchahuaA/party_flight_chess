/** 出生槽池与按人数均布（#18 T2）：8 槽围圈、支路/旗全空地无碰撞、人数菜单互距下限 */
import { describe, expect, it } from "vitest";
import { BOARD, SPAWN_CELLS, SPAWN_SLOTS, YARDS, branchTails, cellXY, spawnMenu } from "../src";
import type { BoardCell } from "../src";

/** 曼哈顿距离（出生位均布的直观度量） */
const manhattan = (a: BoardCell, b: BoardCell) => Math.abs(a.col - b.col) + Math.abs(a.row - b.row);

describe("出生槽池（8 位）", () => {
  it("8 个出生槽全在路网上、非环岛、净底 S；支路旗与朝向齐备", () => {
    expect(SPAWN_CELLS.length).toBe(8);
    expect(SPAWN_SLOTS.length).toBe(8);
    const byId = new Map(BOARD.map((c) => [c.id, c]));
    for (const slot of SPAWN_SLOTS) {
      const c = byId.get(slot.cell)!;
      expect(c).toBeTruthy();
      expect(c.type).toBe("S");
      expect(c.street).not.toBe("J");
      expect(c.spawnIndex).toBeGreaterThanOrEqual(0);
      expect(slot.dir).toHaveLength(2);
    }
  });

  it("支路与旗：全空地（不与 100 格任何主干格重合）且互不重合", () => {
    const boardKeys = new Set(BOARD.map((c) => `${c.col},${c.row}`));
    const seen = new Set<string>();
    for (const tail of branchTails) {
      expect(tail.cells.length).toBe(4);
      for (const key of [...tail.spots, tail.flag]) {
        expect(boardKeys.has(`${key.col},${key.row}`)).toBe(false);
        const k = `${key.col},${key.row}`;
        expect(seen.has(k)).toBe(false); // 任意两槽之间不撞
        seen.add(k);
      }
    }
  });

  it("支路不进内园地皮（Yards 占位区）", () => {
    for (const tail of branchTails) {
      for (const key of [...tail.spots, tail.flag]) {
        for (const y of YARDS) {
          const inYard =
            key.col >= y.col && key.col < y.col + y.w && key.row >= y.row && key.row < y.row + y.h;
          expect(inYard).toBe(false);
        }
      }
    }
  });
});

describe("按人数均布菜单", () => {
  const LOWER: Record<number, number> = { 2: 23, 3: 15, 4: 10, 5: 7, 6: 5, 7: 5, 8: 3 };

  it("2..8 人各档：无重复、全在槽池内、最小两两互距达到均布下限", () => {
    const byIndex = new Map(SPAWN_SLOTS.map((s, i) => [i, s]));
    for (let n = 2; n <= 8; n++) {
      const menu = spawnMenu(n);
      expect(menu.length).toBe(n);
      expect(new Set(menu).size).toBe(n);
      const cells = menu.map((i) => BOARD[byIndex.get(i)!.cell]!);
      let minDist = Infinity;
      for (let a = 0; a < cells.length; a++) {
        for (let b = a + 1; b < cells.length; b++) {
          minDist = Math.min(minDist, manhattan(cells[a]!, cells[b]!));
        }
      }
      expect(minDist).toBeGreaterThanOrEqual(LOWER[n]!);
      // 玩家序 → 出生格逐线落位（i 号玩家 = 菜单第 i 槽）
      const cells2 = menu.map((i) => BOARD[SPAWN_SLOTS[i]!.cell]!);
      expect(cells2).toEqual(cells);
    }
  });

  it("4 人档 = stub 实玩四角；独童出生位有家号（spawnIndex）", () => {
    const menu4 = spawnMenu(4).map((i) => BOARD[SPAWN_SLOTS[i]!.cell]!);
    const keys = menu4.map((c) => `${c.col},${c.row}`);
    expect(keys).toEqual(["6,0", "12,4", "0,17", "12,17"]);
    for (const c of menu4) expect(c.spawnIndex).toBeGreaterThanOrEqual(0);
  });

  it("2 人档/3 人档的对望抽查", () => {
    const menu2 = spawnMenu(2).map((i) => BOARD[SPAWN_SLOTS[i]!.cell]!);
    expect(menu2.map((c) => `${c.col},${c.row}`)).toEqual(["6,0", "12,17"]);
    const menu3 = spawnMenu(3).map((i) => BOARD[SPAWN_SLOTS[i]!.cell]!);
    expect(menu3.map((c) => `${c.col},${c.row}`)).toEqual(["6,0", "12,9", "0,17"]);
  });
});
