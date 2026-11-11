import { describe, expect, it } from "vitest";
import {
  readEnabled,
  safeStore,
  setSfxEnabled,
  setVibrateEnabled,
  SFX_ENABLED_KEY,
  sfxEnabled,
  VIBRATE_ENABLED_KEY,
  vibrateEnabled,
  vibrateSupported,
  writeEnabled,
  type KeyValueStore,
  type VibratorLike,
} from "./settings";

/** 内存版 localStorage（可注入读写异常；与 guide.test.ts 同一口径） */
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

describe("音效/震动开关的本地读写（A-04 / A-05 / Spec 决策 12）", () => {
  it("缺省（键不存在）一律按「开」——两个开关默认开", () => {
    const store = memStore();
    expect(sfxEnabled(store)).toBe(true);
    expect(vibrateEnabled(store)).toBe(true);
    expect(sfxEnabled(null)).toBe(true);
    expect(vibrateEnabled(null)).toBe(true);
  });

  it("只有显式写过 \"0\" 才算关；\"1\" 与损坏值都按开（默认开）", () => {
    const store = memStore();
    store.data.set(SFX_ENABLED_KEY, "0");
    store.data.set(VIBRATE_ENABLED_KEY, "1");
    expect(sfxEnabled(store)).toBe(false);
    expect(vibrateEnabled(store)).toBe(true);
    store.data.set(SFX_ENABLED_KEY, "garbage");
    expect(sfxEnabled(store)).toBe(true);
  });

  it("写回后能读回，且跨实例保留（同一 store 重新读）", () => {
    const store = memStore();
    expect(setSfxEnabled(store, false)).toBe(true);
    expect(store.data.get(SFX_ENABLED_KEY)).toBe("0");
    expect(sfxEnabled(store)).toBe(false);
    expect(setSfxEnabled(store, true)).toBe(true);
    expect(sfxEnabled(store)).toBe(true);

    expect(setVibrateEnabled(store, false)).toBe(true);
    expect(vibrateEnabled(store)).toBe(false);
  });

  it("底层读不可用（隐私模式）→ 按默认开，不抛", () => {
    const store = memStore({ failGet: true });
    expect(() => readEnabled(store, SFX_ENABLED_KEY)).not.toThrow();
    expect(sfxEnabled(store)).toBe(true);
    expect(vibrateEnabled(store)).toBe(true);
  });

  it("底层写不可用（配额满）→ 返回 false 且不抛，读回仍是默认开", () => {
    const store = memStore({ failSet: true });
    expect(() => writeEnabled(store, SFX_ENABLED_KEY, false)).not.toThrow();
    expect(setSfxEnabled(store, false)).toBe(false);
    expect(setVibrateEnabled(store, false)).toBe(false);
    expect(sfxEnabled(store)).toBe(true);
  });

  it("无 store（极端环境）→ 读默认开、写返回 false", () => {
    expect(readEnabled(null, SFX_ENABLED_KEY)).toBe(true);
    expect(writeEnabled(null, SFX_ENABLED_KEY, false)).toBe(false);
  });
});

describe("震动支持探测（A-05：不支持时整行隐藏，不做假开关）", () => {
  it("navigator.vibrate 不存在 / 不是函数 / 无 navigator → 不支持", () => {
    expect(vibrateSupported(null)).toBe(false);
    expect(vibrateSupported(undefined)).toBe(false);
    expect(vibrateSupported({})).toBe(false);
    expect(vibrateSupported({ vibrate: 1 as unknown as (p: number) => boolean })).toBe(false);
  });

  it("navigator.vibrate 是函数 → 支持（iPhone Safari 没有此 API）", () => {
    const nav: VibratorLike = { vibrate: () => true };
    expect(vibrateSupported(nav)).toBe(true);
  });
});

describe("安全 localStorage 句柄（隐私模式不许崩）", () => {
  it("能拿到时返回可用句柄（读写走同一份底层）", () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const data = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
      },
    });
    try {
      const store = safeStore();
      expect(store).not.toBeNull();
      store!.setItem(SFX_ENABLED_KEY, "0");
      expect(store!.getItem(SFX_ENABLED_KEY)).toBe("0");
    } finally {
      if (desc) Object.defineProperty(globalThis, "localStorage", desc);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it("访问 localStorage 本身抛异常 → 返回 null，不崩", () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError: access denied");
      },
    });
    try {
      expect(() => safeStore()).not.toThrow();
      expect(safeStore()).toBeNull();
    } finally {
      if (desc) Object.defineProperty(globalThis, "localStorage", desc);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
