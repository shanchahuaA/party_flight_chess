/**
 * 二次确认的 Vue 薄适配（M3-T6，#58 / G-07 + L-05）。
 *
 * 状态机本身住 `game/confirm.ts`（纯函数、有测试）；本文件只把它接到一个 `ref` 与一个
 * 「真要做的事」回调上——组件不必各自实现一遍 `pending` 的开关账。
 *
 * 用法：
 *   const { pending, ask, confirm, cancel } = useConfirm<KickTarget>((t) => roomStore.kick(t.seat));
 *   // 模板：@click="ask({ seat, name })" / ConfirmSheet @confirm="confirm" @cancel="cancel"
 *
 * 行为契约由 `confirm.test.ts` 钉死：`ask` 只开浮层不执行、`cancel` 不执行、`confirm` 执行一次。
 */
import { shallowRef, type ShallowRef } from "vue";
import { stepConfirm, type ConfirmEvent } from "./confirm";

export interface ConfirmBox<T> {
  /** 待确认目标（null=浮层收起）；模板里直接用 `v-if="pending"` */
  pending: ShallowRef<T | null>;
  /** 点了某个破坏性入口：只开确认浮层 */
  ask: (value: T) => void;
  /** 浮层上点「确认」：执行一次并收起 */
  confirm: () => void;
  /** 点「取消」或遮罩：收起，什么都不做 */
  cancel: () => void;
}

/** 把确认状态机接到 ref + 执行回调（`run` 只在 confirm 且有待确认目标时被调用一次） */
export function useConfirm<T>(run: (value: T) => void): ConfirmBox<T> {
  // shallowRef：待确认目标只是「原样携带」的载荷（不解包、不深响应），用 ref 反而会被
  // UnwrapRef 改型；状态机是替换制（整值换掉），不需要深层响应。
  const pending = shallowRef<T | null>(null);

  function send(ev: ConfirmEvent<T>): void {
    const step = stepConfirm(pending.value, ev);
    pending.value = step.pending;
    if (step.fire !== null) run(step.fire);
  }

  return {
    pending,
    ask: (value: T) => send({ type: "ask", value }),
    confirm: () => send({ type: "confirm" }),
    cancel: () => send({ type: "cancel" }),
  };
}
