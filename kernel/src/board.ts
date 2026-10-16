/**
 * 庄园路网棋盘静态数据（#13 v3 定案 + #14 生态配额）。
 *
 * 拓扑（大富翁 11 参考图裁决，stub 实玩版原样）：
 *   外环 64 + 中横街 11 + 中竖街 9 + 西巷 6 + 东巷 6 + 下横巷 4 = 100 格；
 *   7 座 ✛ 环岛（6 三岔 + (6,16) 四岔）。
 * 生态三区（#14 §5.6）：青草平原=外环 64／霜顶雪山=中街捷径 20（中横街+中竖街）／
 *   鸣沙戈壁=巷弄 16（西巷+东巷+下横巷）。
 * 格位类型（#14 §5.6 + #17 棋盘重排落位，见内容数值表 §5.7）：
 *   事件 38／道具 18／陷阱 14／空格 19，环岛与出生格 11 净底（不参与类型）；
 *   陷阱配额按 §5.4：平原 4／雪山 4／戈壁 6。
 *
 * 本模块是纯数据：无 DOM/IO 依赖，内核与两端共享；x/y 投影仅供渲染消费。
 */

import { rngFrom } from "./rng";

export type StreetKey = "ring" | "MH" | "MV" | "V2" | "V3" | "DH" | "J";

export const STREET_NAMES: Record<StreetKey, string> = {
  ring: "外环",
  MH: "中横街",
  MV: "中竖街",
  V2: "西巷",
  V3: "东巷",
  DH: "下横巷",
  J: "环岛",
};

export type Eco = "plain" | "snow" | "gobi";

export const ECO_NAMES: Record<Eco, string> = {
  plain: "青草平原",
  snow: "霜顶雪山",
  gobi: "鸣沙戈壁",
};

export type CellType = "E" | "I" | "T" | "B";

/** 格位标记：四类格型之外，J=环岛稳底、S=出生格稳底（#14 §5.6 的 11 格净底） */
export type CellMark = CellType | "J" | "S";

/** 终点支路长度（自家门前小路，第 BRANCH_LEN 格为尽头旗位） */
export const BRANCH_LEN = 4;

/** 净步入支路门槛（≈一圈；1d10 口径下通关率 ~6% 的数学锚点） */
export const NET_GOAL = 90;

export interface BoardCell {
  id: number;
  col: number;
  row: number;
  /** SVG 投影坐标（渲染用） */
  x: number;
  y: number;
  links: number[];
  street: StreetKey;
  zone: Eco;
  /** 'J'=环岛稳底，'S'=出生格稳底（不参与四类格型） */
  type: CellMark;
  /** ≥0 时为第几个出生位（兼终点支路入口） */
  spawnIndex: number;
}

// ---- SVG 投影（与 stub 实玩版一致：22px 方砖，画布 360×472） ----
export const CELL_PX = 22;
export const GX0 = 48;
export const GY0 = 16;
export const cellXY = (col: number, row: number) => ({
  x: GX0 + col * CELL_PX,
  y: GY0 + row * CELL_PX,
});

interface RunSpec {
  street: StreetKey;
  from: [number, number];
  to: [number, number];
}

// 建图次序即生态归属：后建段的格归后建段生态（环岛格归建成它的段）
const RUNS: RunSpec[] = [
  { street: "ring", from: [0, 0], to: [12, 0] },
  { street: "ring", from: [12, 0], to: [12, 20] },
  { street: "ring", from: [12, 20], to: [0, 20] },
  { street: "ring", from: [0, 20], to: [0, 0] },
  { street: "MH", from: [0, 10], to: [12, 10] },
  { street: "MV", from: [6, 10], to: [6, 20] },
  { street: "V2", from: [3, 10], to: [3, 16] },
  { street: "V3", from: [9, 10], to: [9, 16] },
  { street: "DH", from: [3, 16], to: [9, 16] },
];

const CELL_W = 12; // 列数（0..12）
const CELL_H = 20; // 行数（0..20）

function buildTopology(): { cells: BoardCell[]; at: Map<string, BoardCell> } {
  const cells: BoardCell[] = [];
  const at = new Map<string, BoardCell>();
  const key = (c: number, r: number) => `${c},${r}`;

  const add = (c: number, r: number, street: StreetKey, zone: Eco): BoardCell => {
    const k = key(c, r);
    let n = at.get(k);
    if (!n) {
      const { x, y } = cellXY(c, r);
      n = {
        id: cells.length,
        col: c,
        row: r,
        x,
        y,
        links: [],
        street,
        zone,
        type: "B",
        spawnIndex: -1,
      };
      cells.push(n);
      at.set(k, n);
    }
    return n;
  };
  const link = (a: BoardCell, b: BoardCell) => {
    if (!a.links.includes(b.id)) a.links.push(b.id);
    if (!b.links.includes(a.id)) b.links.push(a.id);
  };

  for (const run of RUNS) {
    const zone: Eco = run.street === "ring" ? "plain" : run.street === "MH" || run.street === "MV" ? "snow" : "gobi";
    const [c0, r0] = run.from;
    const [c1, r1] = run.to;
    const dc = Math.sign(c1 - c0);
    const dr = Math.sign(r1 - r0);
    const len = Math.abs(c1 - c0) + Math.abs(r1 - r0);
    let prev: BoardCell | null = null;
    for (let i = 0; i <= len; i++) {
      const n = add(c0 + dc * i, r0 + dr * i, run.street, zone);
      if (prev) link(prev, n);
      prev = n;
    }
  }

  // 环岛：岔度 ≥3 的交叉格标记为稳底，深度不改（生态归属保持建成段）
  for (const n of cells) {
    if (n.links.length >= 3) n.street = "J";
  }

  // 出生格：庄园围一圈均布（槽号沿外环顺时针从正北起；4 人菜单恰落 stub 四角）
  const SPAWNS: Array<readonly [number, number]> = [
    [6, 0],
    [12, 1],
    [12, 4],
    [12, 9],
    [12, 17],
    [0, 17],
    [0, 9],
    [0, 1],
  ];
  for (let i = 0; i < SPAWNS.length; i++) {
    const [c, r] = SPAWNS[i]!;
    const n = at.get(key(c, r));
    if (!n) throw new Error(`出生格 (${c},${r}) 不在路网上`);
    if (n.links.length >= 3) throw new Error(`出生格 (${c},${r}) 不可落在环岛`);
    n.spawnIndex = i;
    n.type = "S";
  }
  for (const n of cells) {
    if (n.street === "J") n.type = "J";
  }

  if (cells.length !== 100) throw new Error(`庄园路网应为 100 格，实际 ${cells.length}`);
  return { cells, at };
}

// ---- 类型灌装：确定性洗匀（固定种子，任何环境构建出同一张盘） ----
// 各生态的格型配额（#17 棋盘重排落位；T2 起出生槽 4→8，平原空格 4 个腾给出生位，回填数值表 §5.6/§5.7）：
//   E 事件：平 28 / 雪 8 / 戈 2     —— 平原事件丰富
//   I 道具：平 9 / 雪 2 / 戈 7     —— 戈壁宝物扎堆
//   T 陷阱：平 4 / 雪 4 / 戈 6     —— §5.4 拍死
//   B 空格：平 12 / 雪 2 / 戈 1     —— 余量（合计 15）
// 配额和：平 53（64 − 3 环岛 − 8 出生）、雪 16（20 − 4 环岛）、戈 16（0 环岛 0 出生）
const TYPE_QUOTA: Record<Eco, Record<CellType, number>> = {
  plain: { E: 28, I: 9, T: 4, B: 12 },
  snow: { E: 8, I: 2, T: 4, B: 2 },
  gobi: { E: 2, I: 7, T: 6, B: 1 },
};
const BOARD_SEED = 20261015;

function assignTypes(cells: BoardCell[]) {
  const rng = rngFrom(BOARD_SEED);
  const byZone: Record<Eco, BoardCell[]> = { plain: [], snow: [], gobi: [] };
  for (const n of cells) {
    if (n.street === "J" || n.spawnIndex >= 0) continue;
    byZone[n.zone].push(n);
  }
  const quotaSum = (z: Eco) => (Object.keys(TYPE_QUOTA[z]) as CellType[]).reduce((s, t) => s + TYPE_QUOTA[z][t], 0);
  for (const zone of ["plain", "snow", "gobi"] as const) {
    const pool = rng.shuffle(byZone[zone]);
    if (quotaSum(zone) !== pool.length) {
      throw new Error(`生态 ${zone} 配额 ${quotaSum(zone)} ≠ 可用格 ${pool.length}`);
    }
    let i = 0;
    for (const t of ["E", "I", "T", "B"] as const) {
      for (let k = 0; k < TYPE_QUOTA[zone][t]; k++) {
        const cell = pool[i++];
        if (!cell) throw new Error(`生态 ${zone} 类型 ${t} 灌装溢出`);
        cell.type = t;
      }
    }
  }
}

const { cells, at } = buildTopology();
assignTypes(cells);

export const BOARD: readonly BoardCell[] = Object.freeze(cells);

const key = (c: number, r: number) => `${c},${r}`;
export const cellAt = (col: number, row: number): BoardCell | undefined => at.get(key(col, row));

export const SPAWN_CELLS: readonly number[] = Object.freeze(
  cells.filter((n) => n.spawnIndex >= 0).sort((a, b) => a.spawnIndex - b.spawnIndex).map((n) => n.id),
);

/** 出生位对应屋前小路的朝向（向园内伸，绝不与他人重叠——渲染用；槽序同出生位） */
const SPAWN_DIRS: Array<readonly [number, number]> = [
  [0, 1],
  [-1, 0],
  [-1, 0],
  [-1, 0],
  [-1, 0],
  [1, 0],
  [1, 0],
  [1, 0],
];

export interface BranchTail {
  /** bpos 1..4 的支路格（col,row，玩法级占位：绝不与他人支路/主干格重叠） */
  spots: Array<{ col: number; row: number }>;
  /** bpos 1..4 的渲染坐标 */
  cells: Array<{ x: number; y: number }>;
  /** 🏁 旗位（不在走格图上） */
  flag: { x: number; y: number; col: number; row: number };
}

export const branchTails: readonly BranchTail[] = Object.freeze(
  SPAWN_CELLS.map((sid) => {
    const n0 = cells[sid]!;
    const d = SPAWN_DIRS[n0.spawnIndex]!;
    const spots: BranchTail["spots"] = [];
    const cellsOut: BranchTail["cells"] = [];
    for (let k = 1; k <= BRANCH_LEN; k++) {
      const col = n0.col + d[0] * k;
      const row = n0.row + d[1] * k;
      spots.push({ col, row });
      cellsOut.push(cellXY(col, row));
    }
    const fcol = n0.col + d[0] * (BRANCH_LEN + 1);
    const frow = n0.row + d[1] * (BRANCH_LEN + 1);
    const fp = cellXY(fcol, frow);
    return {
      spots,
      cells: cellsOut,
      flag: { x: fp.x, y: fp.y, col: fcol, row: frow },
    };
  }),
);

/** 出生槽 = 出生格 + 屋前小路朝向（8 位池；按人数从 spawnMenu 取档落座） */
export interface SpawnSlot {
  /** 槽号 0..7 */
  index: number;
  /** 出生格 id */
  cell: number;
  /** 屋前小路朝向（col/row 步进） */
  dir: readonly [number, number];
}

export const SPAWN_SLOTS: readonly SpawnSlot[] = Object.freeze(
  SPAWN_CELLS.map((cid, i) => ({ index: i, cell: cid, dir: SPAWN_DIRS[i]! })),
);

// ---- 渲染装饰数据（本票只渲染不触发）：内园地皮占位、街名路牌 ----
export interface Yard {
  col: number;
  row: number;
  w: number;
  h: number;
  icon?: string;
  name?: string;
}
export const YARDS: readonly Yard[] = Object.freeze([
  { col: 1, row: 2, w: 4, h: 7, icon: "🏰", name: "庄园主楼" },
  { col: 9, row: 5, w: 3, h: 3, icon: "🌳" }, // T2 让位：东带 (12,9) 支路横带 r9 + 东上支路 r4
  { col: 4, row: 14, w: 2, h: 2, icon: "🌳" }, // T2 让位：西带 (0,9) 支路横带 r9（原 (4,12,2,4) 缩挪）
  { col: 10, row: 12, w: 2, h: 4, icon: "🐑" },
  { col: 1, row: 18, w: 2, h: 2, icon: "🌳" },
  { col: 10, row: 18, w: 2, h: 2, icon: "🌾" },
]);

/** 按人数取哪些出生位（槽号表，2..8 人各一档）：
 *  从 8 槽围圈槽位池中取互距最远的组合；4 人档即 stub 实玩四角（(6,0)/(12,4)/(0,17)/(12,17)）。 */
const SPAWN_MENU: Record<number, readonly number[]> = {
  2: [0, 4],
  3: [0, 3, 5],
  4: [0, 2, 5, 4],
  5: [0, 2, 5, 4, 7],
  6: [0, 2, 5, 4, 7, 3],
  7: [0, 2, 5, 4, 7, 3, 6],
  8: [0, 1, 2, 3, 4, 5, 6, 7],
};

export const spawnMenu = (players: number): readonly number[] => {
  const line = SPAWN_MENU[players];
  if (!line) throw new Error(`人数 ${players} 无出生槽档位（支票 2..8 人局）`);
  return line;
};

/** 街名路牌位 [街名, col, row, ox, oy]（stub 校准值） */
export const STREET_TAGS: ReadonlyArray<readonly [string, number, number, number, number]> = Object.freeze([
  ["中横街", 4.5, 10, 0, -13],
  ["中竖街", 6, 15.5, 14, 0],
  ["西巷", 3, 13, -14, 0],
  ["东巷", 9, 13, 14, 0],
  ["下横巷", 6, 16, 15, 0],
  ["外环", 6, 20, 0, 14],
  ["外环", 0, 4.5, -14, 0],
  ["外环", 12, 8, 14, 0],
]);

// 看尺寸：SVG 画布宽高由投影自动推出（336+边距 / 440+边距）
export const BOARD_W = GX0 * 2 + CELL_PX * CELL_W; // 360
export const BOARD_H = GY0 * 2 + CELL_PX * CELL_H; // 472
