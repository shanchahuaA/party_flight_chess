import { describe, expect, it } from "vitest";
import { GUIDE_KEY, guideSeen, type KeyValueStore } from "./guide";
import { useGuide } from "./useGuide";

/**
 * `useGuide` 薄适配的行为（视觉拍板 B：引导让位）。
 *
 * 状态机本体在 `game/guide.ts`（`guide.test.ts` 已钉）；这里钉的是**接到 Vue ref 与
 * localStorage 上的那一层**——最容易写错的一步是让位时顺手 `markGuideSeen`，
 * 那等于玩家第一次点 📖 就永久丢掉引导。这条测试就是这个错路径的守卫。
 */

/** 内存版 localStorage（可注入异常） */
function memStore(opts: { failSet?: boolean } = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      if (opts.failSet) throw new Error("QuotaExceededError");
      data.set(k, v);
    },
  };
}

describe("useGuide：让位只收浮层，不落 seen", () => {
  it("自动弹后让位：浮层收起，且 localStorage 里没有 guideseen 键", () => {
    const store = memStore();
    const g = useGuide(store);
    g.autoOpen();
    expect(g.open.value).toBe(true);

    g.close();
    expect(g.open.value).toBe(false);
    expect(store.data.has(GUIDE_KEY)).toBe(false);
    expect(guideSeen(store)).toBe(false); // 仍未看过 → 下次开新局还能弹
  });

  it("让位后本局不再自动弹（再触发 autoOpen 也不开）", () => {
    const store = memStore();
    const g = useGuide(store);
    g.autoOpen();
    g.close();
    g.autoOpen();
    expect(g.open.value).toBe(false);
  });

  it("换新局（reset）后仍未看过 → 第一窗仍会自动弹", () => {
    const store = memStore();
    const g = useGuide(store);
    g.autoOpen();
    g.close();
    g.reset();
    g.autoOpen();
    expect(g.open.value).toBe(true);
    expect(store.data.has(GUIDE_KEY)).toBe(false);
  });

  it("跳过才写 seen（本设备之后不再自动弹）", () => {
    const store = memStore();
    const g = useGuide(store);
    g.autoOpen();
    g.skip();
    expect(g.open.value).toBe(false);
    expect(store.data.get(GUIDE_KEY)).toBe("1");
    expect(guideSeen(store)).toBe(true);
  });

  it("走完三步也写 seen", () => {
    const store = memStore();
    const g = useGuide(store);
    g.autoOpen();
    g.next();
    g.next();
    expect(store.data.has(GUIDE_KEY)).toBe(false); // 中途不写
    g.next();
    expect(store.data.get(GUIDE_KEY)).toBe("1");
    expect(g.open.value).toBe(false);
  });

  it("让位之后重看入口仍可打开（让位不封入口）", () => {
    const store = memStore();
    const g = useGuide(store);
    g.autoOpen();
    g.close();
    g.reopen();
    expect(g.open.value).toBe(true);
    expect(g.step.value).toBe(0);
    expect(store.data.has(GUIDE_KEY)).toBe(false);
  });

  it("键不可写时不崩（让位/跳过都不抛）", () => {
    const store = memStore({ failSet: true });
    const g = useGuide(store);
    expect(() => {
      g.autoOpen();
      g.close();
      g.skip();
    }).not.toThrow();
  });

  it("无 store（极端环境）时不崩，且跳过仍收起", () => {
    const g = useGuide(null);
    expect(() => {
      g.autoOpen();
      g.skip();
    }).not.toThrow();
    expect(g.open.value).toBe(false);
  });
});
