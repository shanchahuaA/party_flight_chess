/**
 * 内核类型：状态／意图／事实／战报。内核 API 的全部形状都在这里。
 * 一切按"意图入 → 新权威状态 + 事实 + 战报 slice"的口径收口；
 * M2 时这批类型直接变成 WS 意图/事实协议（ADR 0001），形状不再变化。
 */
import type { CellType, Eco, StreetKey } from "./board";

// ---------- 战报（界面呈现定案 §三 MessageEntry，结构不动） ----------

export type MessageKind = "event" | "trap" | "item" | "malice" | "system" | "summary" | "score";

export interface MessageEntry {
  id: number;
  /** 世界回合号（分节线依据） */
  turn: number;
  kind: MessageKind;
  who?: number;
  targets?: number[];
  text: string;
  flavor?: string;
  emphasis?: "normal" | "highlight" | "target" | "big";
}

// ---------- 玩家与局状态 ----------

export interface PlayerState {
  id: number;
  name: string;
  isBot: boolean;
  colorIndex: number;
  /** 主网位置（zone==='main' 时即所站格 id；branch 时恒为出生格 id） */
  pos: number;
  /** 上一步来向：走格惯性、排除回头、超时直行都看它 */
  from: number | null;
  /** 来路栈：退格沿它原路退回（含穿环岛不重弹） */
  trail: number[];
  /** 净步：主干进 +1、逆行 −1；≥ NET_GOAL 时前向踩出生格即入门 */
  net: number;
  zone: "main" | "branch" | "done";
  /** 终点支路步位 0..BRANCH_LEN（0=尾声门口） */
  bpos: number;
  /** 本窗已掷 */
  rolled: boolean;
  /** 本窗已确认（确认结束=进等待区） */
  confirmed: boolean;
  /** 罚停（本票恒 0，T5 挂钩） */
  stun: number;
  /** 出局占位（T5 挂钩） */
  dead: boolean;
  /** 自己的出生格（兼终点支路入口） */
  spawnCell: number;
  /** 假人的窗口内日程（rollAt 到点自动掷；walk 结束后到点自动确认） */
  botSchedule: { rollAt: number; confirmAt: number };
  walk: WalkState | null;
}

export interface RouteOption {
  to: number;
  street: StreetKey;
  label: string;
}

export interface WalkState {
  /** 还要走的格数（正值=前进，负值=沿来路栈退回） */
  remaining: number;
  nextStepAt: number;
  /** 环岛选路条：非空即停在岔口等人选 */
  ask: { options: RouteOption[]; deadline: number } | null;
  pendingTo: number | null;
  bounced: boolean;
}

export type GamePhase = "acting" | "rest" | "over";

export interface GameState {
  turn: number;
  phase: GamePhase;
  /** 本窗截止时间戳（仅 acting） */
  windowDeadline: number;
  /** 休息截止时间戳（仅 rest） */
  restUntil: number;
  players: PlayerState[];
  /** 通关席名次（按踩进先后） */
  finishers: number[];
  messages: MessageEntry[];
  /** 内部：战报 id 发号与 RNG 状态（随状态走，M2 快照恢复随机流） */
  seq: number;
  rngState: number;
}

// ---------- 意图（上行） ----------

export interface GameConfig {
  seed: number;
  /** 局长：世界回合总数（默认 15） */
  turnCap: number;
  /** 世界回合窗毫秒（默认 30000） */
  windowMs: number;
  /** 回合间休息毫秒（默认 10000，0=直接开下一窗） */
  restMs: number;
  /** 环岛选路等待毫秒（默认 10000） */
  routeAskMs: number;
  /** 逐格走格节拍毫秒（客户端动画节奏的事实事实锚，默认 140） */
  stepMs: number;
  /** 测试通道：允许 dev 意图（默认 false；单测开） */
  allowDev?: boolean;
}

export type Intent =
  | { type: "roll"; pid: number }
  | { type: "confirm"; pid: number }
  | { type: "chooseRoute"; pid: number; option: number }
  | { type: "skipRest" }
  /** 测试/后接卡面效果专用的直调通道（allowDev=false 时拒绝） */
  | { type: "dev.back"; pid: number; steps: number }
  | { type: "dev.setPos"; pid: number; pos: number; from: number | null; net: number };

// ---------- 事实（下行：客户端据此动起来） ----------

export type Fact =
  | { type: "windowStart"; turn: number; deadline: number }
  | { type: "windowEnd"; turn: number; auto: boolean }
  | { type: "restStart"; turn: number; until: number }
  | { type: "gameEnd" }
  | { type: "roll"; pid: number; d: number; auto: boolean }
  | { type: "confirm"; pid: number; auto: boolean }
  /** 主网逐格走（含退格步） */
  | { type: "step"; pid: number; from: number; to: number; dir: 1 | -1 }
  /** 终点支路逐格走 */
  | { type: "stepBranch"; pid: number; bpos: number; dir: 1 | -1 }
  | { type: "branchEnter"; pid: number }
  | { type: "bounce"; pid: number }
  | { type: "bounceExit"; pid: number }
  | { type: "finish"; pid: number }
  | { type: "routeAskOpen"; pid: number; options: RouteOption[]; deadline: number }
  | { type: "routeChosen"; pid: number; to: number; auto: boolean }
  /** 棋盘联动：说明性脉冲（界面呈现定案 §四 S1 描边） */
  | { type: "pulse"; pid: number; level: "normal" | "target" | "big" };

export interface PlayerDef {
  name: string;
  isBot: boolean;
}

/** 内核错误：意图非法/状态机拒绝。UI 捕获后静默或提示，永不崩局。 */
export class KernelError extends Error {}
