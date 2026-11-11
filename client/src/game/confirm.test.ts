import { describe, expect, it } from "vitest";
import { dissolvePrompt, kickPrompt, stepConfirm, type KickTarget } from "./confirm";

/**
 * 二次确认状态机（#58 / G-07 + L-05）的**可测部分**。
 *
 * 「点一下就踢」「点一下就解散」是同一个错：破坏性动作必须先开确认浮层。
 * 这里把三条行为钉死：**ask 只开浮层 / cancel 不执行 / confirm 才执行且只执行一次**。
 * 渲染形态（浮层长什么样）归 IAB 冒烟；状态机是两处共用的唯一真源。
 */

const AH: KickTarget = { seat: 1, name: "阿强" };

describe("确认状态机：点「请出」先弹确认，取消不踢、确认才踢", () => {
  it("ask：只开确认浮层，**不执行**（点一下就踢=错路径）", () => {
    const step = stepConfirm<KickTarget>(null, { type: "ask", value: AH });
    expect(step.pending).toEqual(AH);
    expect(step.fire).toBeNull();
  });

  it("cancel：收起浮层且不执行（座位不动）", () => {
    const step = stepConfirm(AH, { type: "cancel" });
    expect(step.pending).toBeNull();
    expect(step.fire).toBeNull();
  });

  it("confirm：收起浮层并对该目标执行一次", () => {
    const step = stepConfirm(AH, { type: "confirm" });
    expect(step.pending).toBeNull();
    expect(step.fire).toEqual(AH);
  });

  it("确认只作用一次：浮层已收起后再确认=空转，不重复上行", () => {
    const first = stepConfirm(AH, { type: "confirm" });
    const again = stepConfirm(first.pending, { type: "confirm" });
    expect(again.fire).toBeNull();
  });

  it("没有待确认目标时确认/取消都=空转（防幽灵执行）", () => {
    expect(stepConfirm<KickTarget>(null, { type: "confirm" })).toEqual({ pending: null, fire: null });
    expect(stepConfirm<KickTarget>(null, { type: "cancel" })).toEqual({ pending: null, fire: null });
  });

  it("浮层开着时点另一个目标：换成新目标，仍不执行", () => {
    const step = stepConfirm<KickTarget>(AH, { type: "ask", value: { seat: 3, name: "小美" } });
    expect(step.pending).toEqual({ seat: 3, name: "小美" });
    expect(step.fire).toBeNull();
  });

  it("dislike 面的解散同走一套：ask 不解散、cancel 不解散、confirm 才解散", () => {
    const room = { kind: "dissolve" as const };
    expect(stepConfirm(null, { type: "ask", value: room }).fire).toBeNull();
    expect(stepConfirm(room, { type: "cancel" }).fire).toBeNull();
    expect(stepConfirm(room, { type: "confirm" }).fire).toEqual(room);
  });
});

describe("确认文案", () => {
  it("请出：G-07 原文逐字「请出 阿强？他将失去本局，且无法再进本房间」", () => {
    expect(kickPrompt("阿强")).toBe("请出 阿强？他将失去本局，且无法再进本房间");
  });

  it("解散：一句话说清后果（全员请出 + 不可撤销）", () => {
    const text = dissolvePrompt();
    expect(text).toContain("解散");
    expect(text).toContain("不可撤销");
  });
});
