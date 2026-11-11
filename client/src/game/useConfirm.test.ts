import { describe, expect, it, vi } from "vitest";
import { useConfirm } from "./useConfirm";

/**
 * `useConfirm` 薄适配的行为（#58 / G-07 + L-05）。
 *
 * 状态机本体在 `game/confirm.ts`（`confirm.test.ts` 已钉）；这里钉的是**接到 Vue ref 上的那一层**
 * 仍保持同一契约——四处入口（⚙ 请出 / ⚙ 解散 / 大厅 🥾 / 大厅页脚与对局面角落解散）都经它调用，
 * 适配层一旦把「ask 直接执行」写回去，等于所有入口集体失效。这是可执行的外部行为断言，
 * 不测 ref 内部结构、不测调用次数以外的实现细节。
 */

describe("useConfirm：ask 只开浮层、cancel 不执行、confirm 执行一次", () => {
  it("ask 后 pending 有值但没执行；cancel 后 pending 清空且仍没执行", () => {
    const run = vi.fn();
    const box = useConfirm<{ seat: number }>(run);
    box.ask({ seat: 2 });
    expect(box.pending.value).toEqual({ seat: 2 });
    expect(run).not.toHaveBeenCalled();
    box.cancel();
    expect(box.pending.value).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("confirm 把待确认目标交给回调一次并收起", () => {
    const run = vi.fn();
    const box = useConfirm<{ seat: number }>(run);
    box.ask({ seat: 2 });
    box.confirm();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ seat: 2 });
    expect(box.pending.value).toBeNull();
  });

  it("浮层已收起后再 confirm 不重复执行（防双击发两次 kick）", () => {
    const run = vi.fn();
    const box = useConfirm<{ seat: number }>(run);
    box.ask({ seat: 2 });
    box.confirm();
    box.confirm();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("空态 confirm/cancel 都空转", () => {
    const run = vi.fn();
    const box = useConfirm<{ seat: number }>(run);
    box.confirm();
    box.cancel();
    expect(run).not.toHaveBeenCalled();
  });
});
