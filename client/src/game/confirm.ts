/**
 * 二次确认的统一状态机与文案（M3-T6，#58 / G-07 + L-05）。
 *
 * 「点一下就把人请出去 / 把房间炸了」是同一个错：**任何破坏性动作都要先开确认浮层，
 * 取消什么都不发生，确认才发一次上行**。把这层判据收成一个泛型状态机，两处（请出、解散）
 * 与将来的第三处都走它——各写一遍 reducer 迟早分叉。
 *
 * 状态迁移（纯函数，零 Vue/零 DOM）：
 * - `ask`    → 待确认目标换成新值，**fire=null**（只开浮层，绝不执行）
 * - `cancel` → 收起浮层，fire=null（**取消不执行**）
 * - `confirm`→ 有目标才 fire 并收起；无目标=空转（防幽灵执行、防重复上行）
 */

/** 确认浮层事件：ask=点了某入口（带上即将执行的目标）；confirm/cancel=浮层两钮 */
export type ConfirmEvent<T> =
  | { type: "ask"; value: T }
  | { type: "confirm" }
  | { type: "cancel" };

/** 一次迁移的结果：pending=下一态待确认目标（null=浮层收起）；fire=真要执行的目标（null=不执行） */
export interface ConfirmStep<T> {
  pending: T | null;
  fire: T | null;
}

/** 二次确认状态机（唯一入口） */
export function stepConfirm<T>(cur: T | null, ev: ConfirmEvent<T>): ConfirmStep<T> {
  switch (ev.type) {
    case "ask":
      return { pending: ev.value, fire: null };
    case "cancel":
      return { pending: null, fire: null };
    case "confirm":
      return cur ? { pending: null, fire: cur } : { pending: null, fire: null };
  }
}

/** 请出确认的目标（待确认对象的全部信息：座位号用于上行、名字用于文案） */
export interface KickTarget {
  seat: number;
  name: string;
}

/** 请出文案（G-07 原文逐字：「请出 阿强？他将失去本局，且无法再进本房间」） */
export function kickPrompt(name: string): string {
  return `请出 ${name}？他将失去本局，且无法再进本房间`;
}

/** 解散文案（复核 #55 的误触面：页底那颗钮点错=全房解散） */
export function dissolvePrompt(): string {
  return "解散房间？全员都会被请出，房间立即销毁——此操作不可撤销";
}
