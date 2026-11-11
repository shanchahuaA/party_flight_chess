/**
 * 音效 / 震动开关的本地状态（M3-T2，#54）：A-04「状态存 localStorage 跨局保留」，
 * A-05「`navigator.vibrate` 不存在时整行隐藏」。
 *
 * 纯逻辑、零 Vue：`localStorage` 与 `navigator` 都是注入进来的最小接口，Node 环境直测。
 * 降级口径照 `game/guide.ts` 的先例——**读写一律 try/catch**（隐私模式 / 配额满不许崩）：
 * - 读失败 → 按默认值「开」返回（宁可响一次，也不让一个坏键把声音永久关掉）；
 * - 写失败 → 返回 false，调用方本次会话内仍按用户选择生效（内存态优先）。
 *
 * 键名沿用 `pfc.` 前缀（先例 `pfc.token.<code>` / `pfc.nickname` / `pfc.guide.seen`）。
 */

/** 🔊 音效开关（"0"=关；缺省/其它值=开） */
export const SFX_ENABLED_KEY = "pfc.sfx.enabled";
/** 📳 震动开关（"0"=关；缺省/其它值=开） */
export const VIBRATE_ENABLED_KEY = "pfc.vibrate.enabled";

/** 单次震动时长（ms）：A-05 要求 ≤30ms——只给一记轻点，不震成来电 */
export const VIBRATE_MS = 24;

/** localStorage 的最小接口（测试注入用；浏览器侧就是 localStorage） */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** navigator 的最小震动接口（`navigator.vibrate` 在 iPhone Safari 不存在） */
export interface VibratorLike {
  vibrate(pattern: number | number[]): boolean;
}

/** 读开关：只有显式写过 "0" 才算关；读异常/无 store 都按默认开 */
export function readEnabled(store: KeyValueStore | null, key: string): boolean {
  if (!store) return true;
  try {
    return store.getItem(key) !== "0";
  } catch {
    return true;
  }
}

/** 写开关：写不进（隐私模式/配额满）返回 false，绝不抛 */
export function writeEnabled(store: KeyValueStore | null, key: string, on: boolean): boolean {
  if (!store) return false;
  try {
    store.setItem(key, on ? "1" : "0");
    return true;
  } catch {
    return false;
  }
}

/** 🔊 音效是否开（默认开） */
export function sfxEnabled(store: KeyValueStore | null): boolean {
  return readEnabled(store, SFX_ENABLED_KEY);
}

/** 📳 震动是否开（默认开） */
export function vibrateEnabled(store: KeyValueStore | null): boolean {
  return readEnabled(store, VIBRATE_ENABLED_KEY);
}

export function setSfxEnabled(store: KeyValueStore | null, on: boolean): boolean {
  return writeEnabled(store, SFX_ENABLED_KEY, on);
}

export function setVibrateEnabled(store: KeyValueStore | null, on: boolean): boolean {
  return writeEnabled(store, VIBRATE_ENABLED_KEY, on);
}

/**
 * 设备是否支持震动（A-05 / Spec 决策 11）：`navigator.vibrate` 不是可调用的函数 → 不支持。
 * T3 的设置面板按这个判据**整行隐藏**，不出灰开关。
 * 入参刻意放宽到 `{ vibrate?: unknown }`：运行时探测不看类型自证（iPhone 上这个属性根本不存在，
 * 有些嵌入式浏览器则是个数字），只认「是不是函数」。
 */
export function vibrateSupported(nav: { vibrate?: unknown } | null | undefined): boolean {
  return !!nav && typeof nav.vibrate === "function";
}

/**
 * 取浏览器 localStorage 的安全句柄：连属性访问本身都可能抛（部分隐私模式），
 * 抛了就返回 null，后续读写走 readEnabled/writeEnabled 的降级分支。
 */
export function safeStore(): KeyValueStore | null {
  try {
    const ls = (globalThis as { localStorage?: KeyValueStore }).localStorage;
    return ls ?? null;
  } catch {
    return null;
  }
}

/** 取浏览器 navigator 的震动句柄：不支持返回 null（iPhone） */
export function defaultVibrator(): VibratorLike | null {
  try {
    const nav = (globalThis as { navigator?: VibratorLike }).navigator;
    return vibrateSupported(nav) ? nav! : null;
  } catch {
    return null;
  }
}
