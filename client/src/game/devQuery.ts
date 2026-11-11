/**
 * dev 冒烟参数的唯一判据（`?dev=1`）——三处原先各写一遍 `new URLSearchParams(location.search).has("dev")`。
 *
 * **求值时机由调用方决定，本函数只提供口径**：
 * - `audio/shell.ts` 是**模块导入期**求值一次（决定要不要挂 `__pzsfx` 探针，一次定终身）；
 * - `net/roomStore.ts` 与 `game/store.ts` 是**调用期**求值（进房/免大厅直达时才查）。
 *
 * 抽出时**不统一求值时机**：那两处仍在各自函数里调本函数，shell 仍在模块级 IIFE 里调一次。
 *
 * 取不到 `location`（非常规环境/Node 测试）一律当「没带 dev」——探针不开比崩了好。
 */
export function hasDevQuery(): boolean {
  try {
    return new URLSearchParams(location.search).has("dev");
  } catch {
    return false;
  }
}
