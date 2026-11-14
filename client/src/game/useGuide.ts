/**
 * 首次引导的 Vue 薄适配（视觉拍板 B：引导让位）。
 *
 * 状态机本身住 `game/guide.ts`（`stepGuide`，纯函数、有测试）；本文件只把它接到 ref 与
 * localStorage 上——组件（`ui/GuideSheet.vue`）不必各自实现一遍开关账。
 *
 * 为什么值得单拆：让位（玩家主动点开 📖/⚙ 时收起引导）**绝不能顺手写 seen**——写一次就等于
 * 玩家第一次点 📖 就永久丢掉引导。这条错路径只在「状态机 + 持久化」接线处才看得出，
 * 所以它单独有一份 `useGuide.test.ts`。
 *
 * 用法：
 *   const guide = useGuide(localStorage);
 *   guide.autoOpen()  // 自动弹条件成立时（本局只生效一次）
 *   guide.reopen()    // 重看入口（大厅页脚 / 帮助浮层入口）
 *   guide.close()     // 玩家点开 📖/⚙：让位，不写 seen
 *   guide.reset()     // 换局：两闸重置
 */
import { computed, ref, type ComputedRef } from "vue";
import { GUIDE_CLOSED, markGuideSeen, stepGuide, type GuideEvent, type GuideView, type KeyValueStore } from "./guide";

export interface GuideBox {
  /** 浮层是否开着（模板 `v-if`）——由状态机派生，不另存一份布尔 */
  open: ComputedRef<boolean>;
  /** 当前步（0..2） */
  step: ComputedRef<number>;
  /** 自动弹条件成立：只在本局第一次生效（已让位/已跳过/已走完都不再开） */
  autoOpen: () => void;
  /** 重看入口：不受「已看过」闸限制 */
  reopen: () => void;
  /** 让位：玩家主动点开 📖/⚙，引导先收起——不写 seen，但本局不再自动弹 */
  close: () => void;
  /** 跳过：写 seen，本设备之后不再自动弹 */
  skip: () => void;
  /** 下一步 / 开始游戏（末步=收尾并写 seen） */
  next: () => void;
  /** 换局：两闸重置（仍未看过 → 新局第一窗照常自动弹） */
  reset: () => void;
}

/** 把引导状态机接到 ref 与 localStorage（`writeSeen` 只在跳过/走完时为真） */
export function useGuide(store: KeyValueStore | null): GuideBox {
  const view = ref<GuideView>({ ...GUIDE_CLOSED });

  function send(ev: GuideEvent): void {
    const t = stepGuide(view.value, ev);
    view.value = t.view;
    if (t.writeSeen) markGuideSeen(store);
  }

  return {
    open: computed(() => view.value.open),
    step: computed(() => view.value.step),
    autoOpen: () => send({ type: "auto" }),
    reopen: () => send({ type: "reopen" }),
    close: () => send({ type: "close" }),
    skip: () => send({ type: "skip" }),
    next: () => send({ type: "next" }),
    reset: () => send({ type: "reset" }),
  };
}
