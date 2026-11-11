/**
 * 新条目高亮到期表（G-09，M3-T8 / #60）：把「哪些 id 是新的」这份判定（cues.deriveHighlights，
 * 唯一真源）落成一张**带到期时刻的表**，让渲染层逐条问「这个 id 现在还在亮吗」。
 *
 * 为什么需要这张表：`freshMsgIds` 是「本批新增」的一次性列表，每批被整体替换——组件若直接
 * 绑它，下一批到达时上一批的高亮会瞬间消失（不是 2s 渐出）。判定归 cues、计时归这里，
 * 组件只读表。
 *
 * 纯函数、零 Vue/零 DOM：Node 环境可直测（client/src/**\/*.test.ts）。
 */

/** 高亮时长：约 2s（清单 G-09「新条目底色高亮，约 2s 内渐出」；T-05 点名的四处之一） */
export const HIGHLIGHT_MS = 2_000;

/** id → 高亮到期时刻（时间轴由调用方给：壳层用 performance.now()，测试给假值） */
export type HighlightTable = Readonly<Record<number, number>>;

/**
 * 把本批新 id 并进表：新 id 记 `now + HIGHLIGHT_MS`；已在表里的 id **不延长**（同一 id 只亮一次，
 * 重复消息/重连全量不会把高亮反复续命）。
 */
export function mergeHighlights(table: HighlightTable, fresh: readonly number[], now: number): HighlightTable {
  let out: Record<number, number> | null = null;
  for (const id of fresh) {
    if (table[id] != null) continue; // 已在亮：不续命、不重复
    out ??= { ...table };
    out[id] = now + HIGHLIGHT_MS;
  }
  return out ?? table; // 无新增=原表引用（壳层靠引用比较判「表有没有变」）
}

/** 摘掉已到期的项（渲染前调一次，表不随时间无限增长）。返回原表引用=无变化（省重渲）。 */
export function pruneHighlights(table: HighlightTable, now: number): HighlightTable {
  let changed = false;
  const out: Record<number, number> = {};
  for (const [idStr, until] of Object.entries(table)) {
    if (until > now) out[Number(idStr)] = until;
    else changed = true;
  }
  return changed ? out : table;
}

/** 该条目此刻是否在高亮窗内 */
export function isHighlighted(table: HighlightTable, id: number, now: number): boolean {
  const until = table[id];
  return until != null && until > now;
}
