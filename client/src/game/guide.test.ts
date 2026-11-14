import { describe, expect, it } from "vitest";
import {
  GUIDE_CLOSED,
  GUIDE_KEY,
  GUIDE_STEPS,
  guideSeen,
  markGuideSeen,
  nextStep,
  shouldShowGuide,
  stepGuide,
  type GuideTriggerState,
  type GuideView,
  type KeyValueStore,
} from "./guide";

/** 内存版 localStorage（可注入异常） */
function memStore(opts: { failGet?: boolean; failSet?: boolean } = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem(k) {
      if (opts.failGet) throw new Error("SecurityError");
      return data.get(k) ?? null;
    },
    setItem(k, v) {
      if (opts.failSet) throw new Error("QuotaExceededError");
      data.set(k, v);
    },
  };
}

const TRIGGER: GuideTriggerState = {
  seen: false,
  phase: "acting",
  turn: 1,
  turnActor: null,
  rolled: false,
  confirmed: false,
  dead: false,
  zone: "main",
};

describe("引导状态机（#56 验收：未看过 → 弹 / 跳过 → 不弹 / 走完 → 不弹 / 键损坏或不可写 → 不弹不崩）", () => {
  it("未看过 → 第一局第一窗掷骰前该弹", () => {
    expect(shouldShowGuide(TRIGGER)).toBe(true);
  });

  it("已看过 → 不弹", () => {
    expect(shouldShowGuide({ ...TRIGGER, seen: true })).toBe(false);
  });

  it("非第一回合不弹（只认第一窗）", () => {
    expect(shouldShowGuide({ ...TRIGGER, turn: 2 })).toBe(false);
  });

  it("已掷骰 / 已确认 不弹（掷骰前才弹）", () => {
    expect(shouldShowGuide({ ...TRIGGER, rolled: true })).toBe(false);
    expect(shouldShowGuide({ ...TRIGGER, confirmed: true })).toBe(false);
  });

  it("非 acting（drafting/rest/over）不弹", () => {
    for (const phase of ["drafting", "rest", "over"]) {
      expect(shouldShowGuide({ ...TRIGGER, phase })).toBe(false);
    }
  });

  it("轮班模式没轮到我不弹；轮到我弹", () => {
    expect(shouldShowGuide({ ...TRIGGER, turnActor: 2 })).toBe(false);
    expect(shouldShowGuide({ ...TRIGGER, turnActor: 0 })).toBe(true);
  });

  it("出局 / 通关席不弹", () => {
    expect(shouldShowGuide({ ...TRIGGER, dead: true })).toBe(false);
    expect(shouldShowGuide({ ...TRIGGER, zone: "done" })).toBe(false);
  });

  it("跳过（写 seen）之后本设备不再弹", () => {
    const store = memStore();
    expect(guideSeen(store)).toBe(false);
    expect(markGuideSeen(store)).toBe(true);
    expect(store.data.get(GUIDE_KEY)).toBe("1");
    expect(guideSeen(store)).toBe(true);
    expect(shouldShowGuide({ ...TRIGGER, seen: guideSeen(store) })).toBe(false);
  });

  it("走完 3 步之后同样不再弹（nextStep 返回 null 时调用方落 seen）", () => {
    expect(nextStep(0)).toBe(1);
    expect(nextStep(1)).toBe(2);
    expect(nextStep(2)).toBeNull();
    const store = memStore();
    markGuideSeen(store);
    expect(guideSeen(store)).toBe(true);
  });

  it("localStorage 不可读（隐私模式）→ 当作已看过，不崩", () => {
    const store = memStore({ failGet: true });
    expect(() => guideSeen(store)).not.toThrow();
    expect(guideSeen(store)).toBe(true);
    expect(shouldShowGuide({ ...TRIGGER, seen: guideSeen(store) })).toBe(false);
  });

  it("localStorage 不可写 → 不抛，返回值 false（本次会话由组件兜住）", () => {
    const store = memStore({ failSet: true });
    expect(() => markGuideSeen(store)).not.toThrow();
    expect(markGuideSeen(store)).toBe(false);
  });

  it("无 store（极端环境）→ 默认不弹、不崩", () => {
    expect(guideSeen(null)).toBe(true);
    expect(markGuideSeen(null)).toBe(false);
  });

  it("键值损坏（不是 1）→ 当作没看过（弹一次，写回后就不弹）", () => {
    const store = memStore();
    store.data.set(GUIDE_KEY, "garbage");
    expect(guideSeen(store)).toBe(false);
  });
});

describe("引导三步内容（G-05：每步一句话不超两行）", () => {
  it("恰好 3 步，每步都有图标/标题/正文", () => {
    expect(GUIDE_STEPS).toHaveLength(3);
    for (const s of GUIDE_STEPS) {
      expect(s.icon).toBeTruthy();
      expect(s.title).toBeTruthy();
      expect(s.body.length).toBeGreaterThan(0);
    }
  });

  it("每步正文在 390px 竖屏下不超两行（按 ~22 字/行、≤44 字）", () => {
    for (const s of GUIDE_STEPS) {
      expect(s.body.length).toBeLessThanOrEqual(60);
    }
  });
});

/**
 * 引导让位（视觉拍板 B）：玩家主动点开 📖 帮助 / ⚙ 设置时，引导先收起。
 *
 * 口径三条（票面）：
 * ① 收起 ≠ 跳过——**不落 seen**（否则第一次点 📖 就永久丢掉引导）；
 * ② 收起后本局不再自动弹（否则 autoReady 仍成立会立刻弹回来）；
 * ③ 换新局闸重置——仍未看过时第一窗照常自动弹。
 */
describe("引导让位（主动点开查看类浮层时收起，不消耗「已看过」闸）", () => {
  /** 自动弹已发生的状态（模拟第一窗轮到自己） */
  const opened = (): GuideView => stepGuide(GUIDE_CLOSED, { type: "auto" }).view;

  it("自动条件成立 → 开在第一步，且置本局一次性闸", () => {
    const v = opened();
    expect(v.open).toBe(true);
    expect(v.step).toBe(0);
    expect(v.autoOpened).toBe(true);
  });

  it("收起：open=false、不记 seen（writeSeen=false）、dismissed 不置位", () => {
    const st = stepGuide(opened(), { type: "close" });
    expect(st.view.open).toBe(false);
    expect(st.writeSeen).toBe(false);
    expect(st.view.dismissed).toBe(false);
  });

  it("引导没开着时的让位信号=空转（不白吞本局 G-05 的自动弹）", () => {
    const st = stepGuide(GUIDE_CLOSED, { type: "close" });
    expect(st.writeSeen).toBe(false);
    expect(st.view.autoOpened).toBe(false);
    expect(stepGuide(st.view, { type: "auto" }).view.open).toBe(true);
  });

  it("收起后自动条件仍成立也不再弹（一次性闸挡住 re-auto）", () => {
    const closed = stepGuide(opened(), { type: "close" }).view;
    expect(stepGuide(closed, { type: "auto" }).view.open).toBe(false);
  });

  it("换新局（reset）闸重置：仍未看过 → 第一窗仍自动弹", () => {
    const closed = stepGuide(opened(), { type: "close" }).view;
    const fresh = stepGuide(closed, { type: "reset" }).view;
    expect(fresh.dismissed).toBe(false);
    expect(fresh.autoOpened).toBe(false);
    expect(stepGuide(fresh, { type: "auto" }).view.open).toBe(true);
  });

  it("跳过 / 走完仍落 seen（与让位区分：这两种才是「本设备不再弹」）", () => {
    expect(stepGuide(opened(), { type: "skip" }).writeSeen).toBe(true);
    let v = opened();
    v = stepGuide(v, { type: "next" }).view;
    v = stepGuide(v, { type: "next" }).view;
    expect(v.step).toBe(2);
    const last = stepGuide(v, { type: "next" });
    expect(last.writeSeen).toBe(true);
    expect(last.view.dismissed).toBe(true);
    expect(last.view.open).toBe(false);
  });

  it("跳过之后本次会话不再自动弹", () => {
    const skipped = stepGuide(opened(), { type: "skip" }).view;
    expect(stepGuide(skipped, { type: "auto" }).view.open).toBe(false);
  });

  it("重看（reopen）不受 seen 闸限制，且不改变一次性闸", () => {
    const skipped = stepGuide(opened(), { type: "skip" }).view;
    const again = stepGuide(skipped, { type: "reopen" });
    expect(again.view.open).toBe(true);
    expect(again.view.step).toBe(0);
    expect(again.writeSeen).toBe(false);
  });

  it("收起后重看仍可打开（让位只关浮层，不封入口）", () => {
    const closed = stepGuide(opened(), { type: "close" }).view;
    expect(stepGuide(closed, { type: "reopen" }).view.open).toBe(true);
  });
});
