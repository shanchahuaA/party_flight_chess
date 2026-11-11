import { describe, expect, it } from "vitest";
import { deriveSounds, VIBRATE_SFX, type SfxName } from "../game/cues";
import {
  audioUrlOf,
  SFX_NAMES,
  SfxPlayer,
  shouldVibrate,
  type AudioBackend,
  type SfxDeps,
} from "./sfx";
import { SFX_ENABLED_KEY, VIBRATE_ENABLED_KEY, VIBRATE_MS, type KeyValueStore, type VibratorLike } from "./settings";

/** 内存版 localStorage（与 settings.test.ts 同一口径） */
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

/** 假音频后端：记录真正播出去的名字（Web Audio 是外部边界，测试只替换它） */
interface FakeBackend extends AudioBackend {
  played: SfxName[];
  /** 测试用：模拟系统挂起/切后台后 AudioContext 不再 running */
  setRunning(v: boolean): void;
}

function fakeBackend(opts: { failFirstUnlock?: boolean } = {}): FakeBackend {
  const played: SfxName[] = [];
  let running = false;
  let failNext = opts.failFirstUnlock ?? false;
  return {
    played,
    unlock: async () => {
      if (failNext) {
        failNext = false;
        running = false;
        return false;
      }
      running = true;
      return true;
    },
    running: () => running,
    play: (name: SfxName) => {
      played.push(name);
    },
    setRunning(v: boolean) {
      running = v;
    },
  };
}

function fakeNav(): VibratorLike & { calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    vibrate: (pattern: number | number[]) => {
      calls.push(Array.isArray(pattern) ? (pattern[0] ?? 0) : pattern);
      return true;
    },
  };
}

function player(over: Partial<SfxDeps> = {}): {
  p: SfxPlayer;
  backend: ReturnType<typeof fakeBackend>;
  store: ReturnType<typeof memStore>;
  nav: ReturnType<typeof fakeNav>;
} {
  const backend = fakeBackend();
  const store = memStore();
  const nav = fakeNav();
  const p = new SfxPlayer({ backend, store, nav, ...over });
  return { p, backend, store, nav };
}

describe("播放器状态机（A-03：未解锁不出声、不静默失败）", () => {
  it("未解锁时 play 不出声，且「待解锁」可读（供 T3 面板显示可点的「开启音效」）", () => {
    const { p, backend } = player();
    expect(p.needsUnlock).toBe(true);
    p.playAll(["roll"]);
    expect(backend.played).toEqual([]);
  });

  it("unlock 成功后 ready 为真、play 出声、待解锁消失", async () => {
    const { p, backend } = player();
    expect(await p.unlock()).toBe(true);
    expect(p.ready).toBe(true);
    expect(p.needsUnlock).toBe(false);
    p.playAll(["roll", "turn"]);
    expect(backend.played).toEqual(["roll", "turn"]);
  });

  it("浏览器拒绝解锁 → 仍待解锁、不出声；下一次手势可重试成功", async () => {
    const backend = fakeBackend({ failFirstUnlock: true });
    const p = new SfxPlayer({ backend, store: memStore(), nav: fakeNav() });
    expect(await p.unlock()).toBe(false);
    expect(p.ready).toBe(false);
    expect(p.needsUnlock).toBe(true);
    p.playAll(["roll"]);
    expect(backend.played).toEqual([]);
    // 下一次手势重试（同一实例）
    expect(await p.unlock()).toBe(true);
    p.playAll(["roll"]);
    expect(backend.played).toEqual(["roll"]);
  });

  it("每次出声前检查 AudioContext 仍 running（切后台被系统挂起后不出声）", async () => {
    const backend = fakeBackend();
    const p = new SfxPlayer({ backend, store: memStore(), nav: fakeNav() });
    await p.unlock();
    p.playAll(["roll"]);
    backend.setRunning(false);
    p.playAll(["turn"]);
    expect(backend.played).toEqual(["roll"]);
    expect(p.ready).toBe(false); // 状态回落为待解锁，T3 面板可再点「开启音效」
  });
});

describe("全局静音（A-04：关闭后全局静音、状态跨局保留）", () => {
  it("静音时 play 不出声（已解锁也不响）", async () => {
    const { p, backend } = player();
    await p.unlock();
    p.setEnabled(false);
    p.playAll(["roll", "hurt"]);
    expect(backend.played).toEqual([]);
  });

  it("开关状态写 localStorage（pfc.sfx.enabled = 1/0），读回一致", () => {
    const { p, store } = player();
    expect(p.enabled).toBe(true);
    p.setEnabled(false);
    expect(store.data.get(SFX_ENABLED_KEY)).toBe("0");
    expect(p.enabled).toBe(false);
    p.setEnabled(true);
    expect(store.data.get(SFX_ENABLED_KEY)).toBe("1");
  });

  it("静音状态跨实例保留（新播放器读同一份 localStorage）", async () => {
    const store = memStore();
    const a = new SfxPlayer({ backend: fakeBackend(), store, nav: fakeNav() });
    a.setEnabled(false);
    const backend2 = fakeBackend();
    const b = new SfxPlayer({ backend: backend2, store, nav: fakeNav() });
    expect(b.enabled).toBe(false);
    await b.unlock();
    b.playAll(["roll"]);
    expect(backend2.played).toEqual([]);
  });

  it("localStorage 写不进（配额满）→ 本次会话仍静音、不抛", async () => {
    const backend = fakeBackend();
    const store = memStore({ failSet: true });
    const p = new SfxPlayer({ backend, store, nav: fakeNav() });
    expect(() => p.setEnabled(false)).not.toThrow();
    expect(p.enabled).toBe(false);
    await p.unlock();
    p.playAll(["roll"]);
    expect(backend.played).toEqual([]);
  });

  it("关闭音效不影响震动（两个开关独立）", async () => {
    const { p, nav } = player();
    await p.unlock();
    p.setEnabled(false);
    p.playAll(["hurt"]);
    expect(nav.calls).toEqual([VIBRATE_MS]);
  });
});

describe("震动（A-05：三处短震 ≤30ms / 不支持整行隐藏 / 可关）", () => {
  it("震动常量不超过 30ms", () => {
    expect(VIBRATE_MS).toBeLessThanOrEqual(30);
  });

  it("三处触发：自己扣血 / 骰子落定 / 轮到自己——各震一次", () => {
    for (const name of VIBRATE_SFX) {
      const { p, nav } = player();
      p.playAll([name]);
      expect(nav.calls, name).toEqual([VIBRATE_MS]);
    }
  });

  it("其余音效不震（抽卡/打牌/得分/年兽/胜负/出局/脚步/UI）", () => {
    const { p, nav } = player();
    const others = SFX_NAMES.filter((n) => !VIBRATE_SFX.includes(n));
    expect(others.length).toBe(SFX_NAMES.length - 3);
    p.playAll(others);
    expect(nav.calls).toEqual([]);
  });

  it("一批里多个触发只震一次（同一批判定不连震）", () => {
    const { p, nav } = player();
    p.playAll(["hurt", "roll", "turn"]);
    expect(nav.calls).toEqual([VIBRATE_MS]);
  });

  it("navigator.vibrate 不存在 → 不支持（整行隐藏判据）、三处触发也不假震", () => {
    const p = new SfxPlayer({ backend: fakeBackend(), store: memStore(), nav: null });
    expect(p.canVibrate).toBe(false);
    expect(() => p.playAll(["hurt", "roll", "turn"])).not.toThrow();
  });

  it("震动关掉后不震；开关写 pfc.vibrate.enabled", () => {
    const { p, store, nav } = player();
    p.setVibrate(false);
    expect(store.data.get(VIBRATE_ENABLED_KEY)).toBe("0");
    p.playAll(["hurt"]);
    expect(nav.calls).toEqual([]);
    expect(p.vibrateOn).toBe(false);
  });

  it("shouldVibrate 纯判决：开+支持+命中三处才震", () => {
    expect(shouldVibrate(["hurt"], { enabled: true, supported: true })).toBe(true);
    expect(shouldVibrate(["roll", "ui"], { enabled: true, supported: true })).toBe(true);
    expect(shouldVibrate(["ui", "step"], { enabled: true, supported: true })).toBe(false);
    expect(shouldVibrate(["hurt"], { enabled: false, supported: true })).toBe(false);
    expect(shouldVibrate(["hurt"], { enabled: true, supported: false })).toBe(false);
    expect(shouldVibrate([], { enabled: true, supported: true })).toBe(false);
  });
});

describe("素材 URL 推导（A-01：文件名即时机 id；子路径部署也要命中）", () => {
  it("根路径：<base>/audio/<name>.mp3", () => {
    expect(audioUrlOf("http://localhost:5173/", "roll")).toBe("http://localhost:5173/audio/roll.mp3");
  });

  it("GitHub Pages 子路径（带尾斜杠）：拼在子路径下，不掉到域名根", () => {
    expect(audioUrlOf("https://u.github.io/repo/", "win")).toBe("https://u.github.io/repo/audio/win.mp3");
  });

  it("以 index.html 结尾的 base：取同目录，不当成文件名", () => {
    expect(audioUrlOf("https://u.github.io/repo/index.html", "step")).toBe(
      "https://u.github.io/repo/audio/step.mp3",
    );
  });

  it("目录形式但不带尾斜杠（/repo）：按目录补斜杠，不掉到上一级", () => {
    expect(audioUrlOf("https://u.github.io/repo", "turn")).toBe("https://u.github.io/repo/audio/turn.mp3");
  });
});

describe("12 格音效名与判定模块对齐（A-01）", () => {
  it("12 格逐个都能播（已解锁、未静音时每一格都落到后端）", async () => {
    for (const name of SFX_NAMES) {
      const { p, backend } = player();
      await p.unlock();
      p.playAll([name]);
      expect(backend.played, name).toEqual([name]);
    }
  });

  it("SFX_NAMES 恰为 12 个、无重复，且判定模块的每个输出都有素材格", () => {
    expect(SFX_NAMES).toHaveLength(12);
    expect(new Set(SFX_NAMES).size).toBe(12);
    // 判定模块能产出的每个名字都必须有一格素材；反向：12 格都在表里
    const produced = new Set<SfxName>();
    const cases: Array<Parameters<typeof deriveSounds>[0]> = [
      { facts: [{ type: "roll", pid: 0, d: 1, auto: false }], newMessages: [] },
      { facts: [{ type: "cardDrawn", pid: 0, cardId: "e01" }], newMessages: [] },
      { facts: [{ type: "itemPlayed", pid: 0, cardId: "i01" }], newMessages: [] },
      { facts: [{ type: "eliminated", pid: 0 }], newMessages: [] },
      { facts: [{ type: "finish", pid: 0 }], newMessages: [] },
      { facts: [{ type: "beastWave", wave: 1, hp: 30, maxHp: 30 }], newMessages: [] },
      { facts: [{ type: "beastRoar", dmg: 1 }], newMessages: [] },
      { facts: [{ type: "beastSlain", wave: 3 }], newMessages: [] },
      { facts: [{ type: "groupFail" }], newMessages: [] },
      { facts: [{ type: "settlement", result: {} as never }], newMessages: [] },
      { facts: [{ type: "step", pid: 0, from: 0, to: 1, dir: 1 }], newMessages: [] },
    ];
    for (const c of cases) {
      for (const n of deriveSounds(c, {
        mePid: 0,
        phase: "acting",
        timerMode: "world",
        turnActorBefore: null,
        turnActorAfter: null,
        meDead: false,
      })) {
        produced.add(n);
      }
    }
    produced.add("turn");
    produced.add("ui");
    for (const n of produced) expect(SFX_NAMES, n).toContain(n);
  });
});
