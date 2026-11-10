/**
 * 客户端判定模块（M3-T1，#53）：**三件事一个入口**——音效时机 / 棋盘脉冲档位 / 新战报条目高亮。
 *
 * 为什么合在一处：「自己扣血」在音效里要响、在棋盘上要红、在战报里是新的——三处各判一遍必然分叉。
 * 本模块是这三张派生表的**唯一真源**；组件只消费结果，不许自己再判一次。
 *
 * 关键口径（Spec #52 实现决策 4）：
 * - 内核只发 `target`/`big` 两档 `pulse` 事实，`normal` 一档**从不发**。G-10 的金描边只能从
 *   新战报条目的 `who === 我` 派生，不能等新事实。
 * - `target` 档：有事实就吃事实，没有就从条目的 `targets` 派生（指认型效果命中目标）。
 * - 音效只播**自己身上**的事（A-07）：判定输入的 `mePid` 是唯一视角来源（服务端重定基后恒 0）。
 *
 * 纯函数、零 Vue/零 DOM：Node 环境可直测（client/src/**\/*.test.ts）。
 */
import type { Fact, GameState, MessageEntry } from "../../../kernel/src";

/** 脉冲档位：normal=金描边（自己触发）/ target=红脉冲（被指认命中）/ big=年兽级大事件 */
export type PulseLevel = "normal" | "target" | "big";

/** 12 格音效名（=client/public/audio/<name>.mp3 的文件名，文件名即时机 id） */
export type SfxName =
  | "roll" // 1 掷骰落定
  | "draw" // 2 抽卡 / 发牌
  | "play" // 3 打出道具卡
  | "hurt" // 4 自己扣血
  | "score" // 5 得分 / 结算加分
  | "beast" // 6 年兽出场
  | "fail" // 7 群体失败
  | "win" // 8 胜利 sting
  | "ui" // 9 UI 轻点（播放器层挂，不在此判）
  | "step" // 10 走格脚步
  | "turn" // 11 轮到自己
  | "out"; // 12 自己出局

/** 震动三处（Spec 决策 11：音效的对偶，不是独立功能）——自己扣血 / 骰子落定 / 轮到自己 */
export const VIBRATE_SFX: readonly SfxName[] = ["hurt", "roll", "turn"];

const PULSE_RANK: Record<PulseLevel, number> = { normal: 1, target: 2, big: 3 };

/** 会在战报里指认/命中目标的条目类型（脉冲派生只在「真被下手」的类目上做） */
const PULSE_KINDS = new Set<MessageEntry["kind"]>(["event", "trap", "item", "malice", "beast"]);

/** 视角状态（一批事实/战报到达时的「我」） */
export interface CueView {
  /** 我的 pid：服务端重定基后恒 0；单机恒 0 */
  mePid: number;
  /** 当前相位（drafting 未开窗不发轮班音） */
  phase: GameState["phase"];
  /** 计时模式：轮到自己音效只在轮班·限时下响（world 模式没有「轮到」概念） */
  timerMode: "world" | "turn";
  /** 本批之前的行动者（判「变成我」的沿） */
  turnActorBefore: number | null;
  /** 本批之后的行动者 */
  turnActorAfter: number | null;
  /** 我已血尽出局（死人不会再扣血、不再轮到） */
  meDead: boolean;
}

/** 本批输入：事实 + 本批新增的战报条目（增量，不是全量历史） */
export interface CueBatch {
  facts: Fact[];
  newMessages: MessageEntry[];
}

export interface CueResult {
  /** 该播的音效（去重、按首次出现定序） */
  sounds: SfxName[];
  /** 每个 pid 的脉冲档位（同批多事件取最高档） */
  pulses: Record<number, PulseLevel>;
  /** 需要 2s 高亮的战报条目 id */
  highlights: number[];
}

/**
 * 棋盘脉冲派生表（G-10 / G-11 / G-12 的「该不该亮」全在这里）。
 * - 事实优先：`pulse` 事实的 level 直接用（内核只发 target/big）。
 * - `normal` 派生：本批战报里 `who === 我` 的事件/陷阱/道具条目（踩事件/陷阱、打道具落地）。
 * - `target` 派生：本批战报里带 `targets` 且 emphasis=target/big 的条目（弹弓/脚镣/惊雷一类
 *   指认型命中）——目标是谁就亮谁，别人的被命中在我的屏上也看得见。
 * - 同批多事件取最高档（big > target > normal）。
 */
export function derivePulses(batch: CueBatch, mePid: number): Record<number, PulseLevel> {
  const out: Record<number, PulseLevel> = {};
  const set = (pid: number, level: PulseLevel): void => {
    const cur = out[pid];
    if (cur == null || PULSE_RANK[level] > PULSE_RANK[cur]) out[pid] = level;
  };
  for (const f of batch.facts) {
    if (f.type === "pulse") set(f.pid, f.level);
  }
  for (const m of batch.newMessages) {
    if (!PULSE_KINDS.has(m.kind)) continue;
    if (m.who != null && m.who === mePid) set(m.who, "normal");
    if ((m.emphasis === "target" || m.emphasis === "big") && m.targets?.length) {
      for (const t of m.targets) set(t, "target");
    }
  }
  return out;
}

/**
 * 音效派生表（A-01 / A-07）：只收**自己身上**的事。
 * 别人掷骰/抽卡/打牌/扣血一律不响——输入里就只认 pid===mePid 的事实与 who===mePid 的条目。
 * 群伤（年兽怒吼、环境结算）在一条批里会落成多条 hpLost，去重保证**只响一次**。
 */
export function deriveSounds(batch: CueBatch, view: CueView): SfxName[] {
  const out: SfxName[] = [];
  const push = (n: SfxName): void => {
    if (!out.includes(n)) out.push(n);
  };
  const mine = (pid: number | undefined): boolean => pid != null && pid === view.mePid;
  for (const f of batch.facts) {
    switch (f.type) {
      case "roll":
        if (mine(f.pid)) push("roll");
        break;
      case "step":
        if (mine(f.pid)) push("step");
        break;
      case "cardDrawn":
        if (mine(f.pid)) push("draw");
        break;
      case "itemDrawn":
        if (mine(f.pid)) push("draw");
        break;
      case "itemPlayed":
        if (mine(f.pid)) push("play");
        break;
      case "eliminated":
        if (mine(f.pid)) push("out");
        break;
      case "finish":
        if (mine(f.pid)) push("score"); // 通关席=得分高光
        break;
      case "beastWave":
        push("beast"); // 年兽出场/每波开张（全桌都该听见）
        break;
      case "beastRoar":
        if (!view.meDead) push("hurt"); // 反噬全场：我挨了这一下
        break;
      case "beastSlain":
        push("win");
        break;
      case "groupFail":
        push("fail");
        break;
      case "settlement":
        push("score");
        break;
      default:
        break;
    }
  }
  for (const m of batch.newMessages) {
    if (!mine(m.who)) continue;
    if (m.tags?.includes("hpLost")) push("hurt");
  }
  // 轮到自己：轮班模式 + 本批「变成我」的沿（换人即触发；world 模式没有这一档）
  if (
    view.timerMode === "turn" &&
    view.phase === "acting" &&
    !view.meDead &&
    view.turnActorBefore !== view.mePid &&
    view.turnActorAfter === view.mePid
  ) {
    push("turn");
  }
  return out;
}

/**
 * 新条目高亮（G-09）：只高亮**增量**条目。
 * - 首帧全量批（full=true）一条都不高亮——否则一进局满屏闪。
 * - 已见最大 id 之后的才算新；重复 id（重连全量、同批重放）不重复高亮。
 */
export function deriveHighlights(newMessages: MessageEntry[], seenMaxId: number, full: boolean): number[] {
  if (full) return [];
  const out: number[] = [];
  for (const m of newMessages) {
    if (m.id <= seenMaxId) continue;
    if (!out.includes(m.id)) out.push(m.id);
  }
  return out;
}

/** 三张表的一站式入口（壳层每次事实入壳调一次；组件不再各自判） */
export function cuesOf(
  batch: CueBatch,
  view: CueView,
  seenMaxId: number,
  full = false,
): CueResult {
  return {
    sounds: deriveSounds(batch, view),
    pulses: derivePulses(batch, view.mePid),
    highlights: deriveHighlights(batch.newMessages, seenMaxId, full),
  };
}
