/**
 * 首次引导状态机（M3-T4，#56）：**每设备一次**，进房开局第一回合掷骰前自动弹 3 步。
 *
 * 纯逻辑（Node 可测）：本地键 `pfc.guide.seen` 的读写与降级、触发判据、三步定义。
 * 组件（ui/GuideSheet.vue）只负责渲染与转发「跳过 / 下一步 / 开始游戏」。
 *
 * 降级口径（票面验收）：键损坏或 localStorage 不可写（隐私模式/配额满）→ **不弹且不崩**。
 * 因此「读不到」不能当成「没看过」——读异常一律按「已看过」处理（宁可少弹一次，不许每次进局都弹）。
 */

/** 本地键：引导是否已看过（跳过或走完都写） */
export const GUIDE_KEY = "pfc.guide.seen";

/** 引导的一步：一句话，不超两行（G-05 文案口径：只讲会踩的坑，不复述规则书） */
export interface GuideStep {
  icon: string;
  title: string;
  body: string;
}

/** 3 步：①掷骰之后还没结束 ②战报在顶上 ③底下一条龙 */
export const GUIDE_STEPS: readonly GuideStep[] = [
  {
    icon: "🎲",
    title: "掷骰之后还没结束",
    body: "掷完会走格，但你还能继续打牌、做任务——直到点「✔ 确认结束」才进等待区。不用急着确认。",
  },
  {
    icon: "📜",
    title: "战报在顶上",
    body: "谁抽了什么卡、挨了什么打，都在顶部那两条流水里；点一下能翻全量战报，往前翻到开局第一条。",
  },
  {
    icon: "🎯",
    title: "底下一条龙",
    body: "左边大圆钮掷骰，右边的条确认；上面的手牌横滑点开就能打。没轮到你时按钮会灰着，等倒计时就好。",
  },
];

/** localStorage 的最小接口（测试注入用；浏览器侧就是 localStorage） */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 读「已看过」：键存在且为 "1" 才算；读异常（隐私模式）按已看过处理——不弹也不崩 */
export function guideSeen(store: KeyValueStore | null): boolean {
  if (!store) return true;
  try {
    return store.getItem(GUIDE_KEY) === "1";
  } catch {
    return true;
  }
}

/** 写「已看过」（跳过/走完都调）：写不进就算了（本次会话内由调用方兜住不再弹），绝不抛 */
export function markGuideSeen(store: KeyValueStore | null): boolean {
  if (!store) return false;
  try {
    store.setItem(GUIDE_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

/** 触发判据的输入（从 gameStore 当前态摘出来的最小面） */
export interface GuideTriggerState {
  /** 本设备是否已看过（guideSeen） */
  seen: boolean;
  /** 内核相位：只有 acting 才有「掷骰前」可言 */
  phase: string;
  /** 世界回合号：只认第一回合（第一窗） */
  turn: number;
  /** 轮班模式下当前行动者（null=world 模式全员可动） */
  turnActor: number | null;
  /** 我是否已掷骰 / 已确认 */
  rolled: boolean;
  confirmed: boolean;
  /** 我是否已出局 / 已通关（这两种都不再「掷骰前」） */
  dead: boolean;
  zone: string;
}

/**
 * 该不该弹：第一局第一窗 + 轮到我 + 掷骰前 + 没看过。
 * 「第一局」不需要单独判——seen 键就是跨局/跨设备的一次性闸，看过就永远不再自动弹。
 */
export function shouldShowGuide(s: GuideTriggerState): boolean {
  if (s.seen) return false;
  if (s.phase !== "acting") return false;
  if (s.turn !== 1) return false;
  if (s.dead || s.zone === "done") return false;
  if (s.rolled || s.confirmed) return false;
  if (s.turnActor != null && s.turnActor !== 0) return false; // 轮班模式：没轮到我不弹
  return true;
}

/** 步进：0..2，走完返回 null（=该关掉并记 seen） */
export function nextStep(cur: number): number | null {
  return cur + 1 < GUIDE_STEPS.length ? cur + 1 : null;
}

/**
 * 引导浮层的可见态（组件渲染只读这一份；状态机是替换制，纯值进纯值出）。
 */
export interface GuideView {
  /** 浮层是否开着 */
  open: boolean;
  /** 当前步（0..2） */
  step: number;
  /** 已跳过/走完（真落 seen；localStorage 写不进时本会话兜底） */
  dismissed: boolean;
  /**
   * 自动弹的一次性闸：本局只自动弹一次。
   * 收起引导也置位——否则 autoReady 仍成立，下一拍就弹回来。换局由 reset 清掉。
   */
  autoOpened: boolean;
}

/** 初始态：没开、第一步、两闸都松 */
export const GUIDE_CLOSED: GuideView = { open: false, step: 0, dismissed: false, autoOpened: false };

/** 状态机事件（组件只发这几个；判断条件仍由调用方用 shouldShowGuide 算） */
export type GuideEvent =
  | { type: "auto" } // 自动弹条件刚成立
  | { type: "reopen" } // 重看入口（guideReq）
  | { type: "close" } // 让位：玩家主动点开 📖/⚙，引导先收起——**不写 seen**
  | { type: "skip" } // 跳过（写 seen）
  | { type: "next" } // 下一步 / 开始游戏（末步=收尾并写 seen）
  | { type: "reset" }; // 换局：闸重置

/** 一次迁移的结果：view=下一态；writeSeen=调用方是否该写「已看过」 */
export interface GuideTransition {
  view: GuideView;
  writeSeen: boolean;
}

/**
 * 引导状态机（唯一入口）。关键区分：
 * - `close`（让位）**不写 seen**——玩家只是暂时遮住，不该消耗「本设备已看过」的一次性闸，
 *   否则第一次点 📖 就永久丢掉引导；但它置 `autoOpened`，让本局不再自动弹回来。
 * - `skip` / 末步 `next` 才是「本设备之后不再自动弹」，由调用方落 `markGuideSeen`。
 */
export function stepGuide(cur: GuideView, ev: GuideEvent): GuideTransition {
  switch (ev.type) {
    case "auto":
      if (cur.dismissed || cur.autoOpened) return { view: cur, writeSeen: false };
      return { view: { ...cur, open: true, step: 0, autoOpened: true }, writeSeen: false };
    case "reopen":
      // 重看不吃 seen 闸（跳过之后也能再看），也不动一次性闸
      return { view: { ...cur, open: true, step: 0 }, writeSeen: false };
    case "close":
      // 让位只对「正压在上面的引导」生效（票面口径：玩家主动点开 📖/⚙ 时引导先收起）。
      // 没开着=空转：开局前点过帮助不该把本局 G-05 的自动弹永久吃掉。
      // 关掉后置 autoOpened：否则 autoReady 仍成立，下一拍就弹回来。
      if (!cur.open) return { view: cur, writeSeen: false };
      return { view: { ...cur, open: false, autoOpened: true }, writeSeen: false };
    case "skip":
      return { view: { ...cur, open: false, dismissed: true, autoOpened: true }, writeSeen: true };
    case "next": {
      const n = nextStep(cur.step);
      if (n == null) {
        return { view: { ...cur, open: false, dismissed: true, autoOpened: true }, writeSeen: true };
      }
      return { view: { ...cur, step: n }, writeSeen: false };
    }
    case "reset":
      // 换局只松两闸；open/step 保持（真正的可见性由下一拍 auto 决定）
      return { view: { ...cur, dismissed: false, autoOpened: false }, writeSeen: false };
  }
}

