/**
 * 壳层单例播放器（M3-T2，#54 / 清单 A-01 / A-03 / A-04 / A-05 / A-07）。
 *
 * 分工：
 * - **判什么**：`game/cues.ts` 的 `deriveSounds`（T1 已交付，只播自己身上的事）——本模块**不重判**。
 * - **怎么响**：本模块。一个壳层单例负责「解锁 / 播 / 全局静音 / 震动」，组件不许各自 `new Audio()`。
 *
 * 三条硬纪律：
 * 1. **解锁**：只在用户手势内 `AudioContext.resume()`（A-03）。每次出声前检查 `state === 'running'`，
 *    不是就不播——把「待解锁」留给 `needsUnlock` 暴露出去（T3 的 ⚙ 面板显示可点的「开启音效」），
 *    **不许静默失败**。`needsUnlock` 只在「**尝试过**解锁仍不 running」时为真：冷启动还没试过时的
 *    「没 running」是常态，不是浏览器拒绝（G-17 的触发前提）。
 * 2. **全局静音**：`pfc.sfx.enabled` 存 localStorage，跨局保留（A-04）。
 * 3. **震动是音效的对偶**：同一批判定里挑 `VIBRATE_SFX` 三处（自己扣血 / 骰子落定 / 轮到自己），
 *    单次 `VIBRATE_MS ≤ 30ms`；`navigator.vibrate` 不存在 → 整行隐藏（`canVibrate=false`），不做假开关。
 *
 * 纯逻辑 + 注入依赖：Web Audio 是唯一外部边界（`AudioBackend`），Node 环境直测（`sfx.test.ts`）。
 * 真实 `AudioContext` 调用留给浏览器冒烟。
 */
import type { SfxName } from "../game/cues";
import { VIBRATE_SFX } from "../game/cues";
import {
  defaultVibrator,
  safeStore,
  setSfxEnabled,
  setVibrateEnabled,
  sfxEnabled,
  VIBRATE_MS,
  vibrateEnabled,
  vibrateSupported,
  type KeyValueStore,
  type VibratorLike,
} from "./settings";

/** 12 格音效名（= `client/public/audio/<name>.mp3` 的文件名；文件名即时机 id） */
export const SFX_NAMES: readonly SfxName[] = [
  "roll",
  "draw",
  "play",
  "hurt",
  "score",
  "beast",
  "fail",
  "win",
  "ui",
  "step",
  "turn",
  "out",
];

/** 音频后端的唯一外部边界（浏览器侧=Web Audio；测试注入假实现） */
export interface AudioBackend {
  /** 在用户手势内调用：建/恢复 AudioContext。返回是否 `running` */
  unlock(): Promise<boolean>;
  /** 当前是否 `running`（每次出声前查） */
  running(): boolean;
  /** 真正播一声（调用方已保证解锁且未静音） */
  play(name: SfxName): void;
  /** 可选：冒烟探针用的计数（已解码素材数 / 在途数 / 真正发出的声数）——A-01/A-04 的证据 */
  stats?(): { decoded: number; pending: number; played: number };
}

export interface SfxDeps {
  backend: AudioBackend;
  store: KeyValueStore | null;
  /** `navigator`（没有 `vibrate` 的 iPhone 也传进来——由 `vibrateSupported` 判） */
  nav: VibratorLike | null;
}

/** 震动判决（纯函数）：开 + 设备支持 + 本批命中三处之一，才震 */
export function shouldVibrate(
  names: readonly SfxName[],
  opts: { enabled: boolean; supported: boolean },
): boolean {
  if (!opts.enabled || !opts.supported) return false;
  return names.some((n) => VIBRATE_SFX.includes(n));
}

/**
 * Web Audio 后端：模块级单例，`AudioContext` **懒建**（构造零副作用——Node 测试 import 安全）。
 * 素材按需 fetch + decode 并缓存；任一环节失败都只静默放弃这一声（不抛、不打断牌局）。
 */
class WebAudioBackend implements AudioBackend {
  private ctx: AudioContext | null = null;
  private buffers = new Map<SfxName, AudioBuffer>();
  private pending = new Map<SfxName, Promise<AudioBuffer | null>>();
  /** 并发 unlock 去重（pointerdown 与 click 会连着来、大厅按钮也会显式调） */
  private unlockJob: Promise<boolean> | null = null;
  /** 真正开始发声的次数（冒烟探针：静音时这个数不涨=全局静音真的拦住了） */
  private playedCount = 0;

  private ensureCtx(): AudioContext | null {
    if (this.ctx) return this.ctx;
    try {
      const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor();
      return this.ctx;
    } catch {
      return null;
    }
  }

  unlock(): Promise<boolean> {
    if (!this.unlockJob) {
      this.unlockJob = this.doUnlock().finally(() => {
        this.unlockJob = null;
      });
    }
    return this.unlockJob;
  }

  private async doUnlock(): Promise<boolean> {
    const ctx = this.ensureCtx();
    if (!ctx) return false;
    try {
      if (ctx.state !== "running") await ctx.resume();
      const ok = ctx.state === "running";
      // 解锁成功即预热 12 格：素材共 116 KB，先 fetch+decode 好，掷骰那一刻才不会迟一拍
      if (ok) for (const n of SFX_NAMES) void this.buffer(ctx, n);
      return ok;
    } catch {
      return false;
    }
  }

  running(): boolean {
    return this.ctx?.state === "running";
  }

  /** 冒烟探针：已解码素材数 / 在途数 / 真正发声次数（`__pzsfx().assets` 读它） */
  stats(): { decoded: number; pending: number; played: number } {
    return { decoded: this.buffers.size, pending: this.pending.size, played: this.playedCount };
  }

  play(name: SfxName): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    void this.buffer(ctx, name).then((buf) => {
      if (!buf || ctx.state !== "running") return;
      try {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start();
        this.playedCount++;
      } catch {
        /* 单声失败不升级 */
      }
    });
  }

  /** 取（并缓存）一声的 AudioBuffer；失败返回 null（同一 name 不重复下载） */
  private buffer(ctx: AudioContext, name: SfxName): Promise<AudioBuffer | null> {
    const hit = this.buffers.get(name);
    if (hit) return Promise.resolve(hit);
    const inflight = this.pending.get(name);
    if (inflight) return inflight;
    const job = (async (): Promise<AudioBuffer | null> => {
      try {
        const res = await fetch(audioUrlOf(document.baseURI, name));
        if (!res.ok) return null;
        const data = await res.arrayBuffer();
        const buf = await ctx.decodeAudioData(data);
        this.buffers.set(name, buf);
        return buf;
      } catch {
        return null;
      } finally {
        this.pending.delete(name);
      }
    })();
    this.pending.set(name, job);
    return job;
  }
}

/**
 * `public/audio/<name>.mp3` 的绝对 URL（vite `base: "./"` 下从子路径打开也成立）。
 * - 以 `index.html` 结尾的 base：取同目录；
 * - 目录形式但**不带尾斜杠**（如 `/repo`）：补一个斜杠，否则 RFC 3986 会把 audio 解析到上一级。
 * 纯函数（入参是 base URL 字符串）——Node 环境可直测。
 */
export function audioUrlOf(baseHref: string, name: SfxName): string {
  const base = new URL(baseHref);
  if (!base.pathname.endsWith("/")) {
    const last = base.pathname.slice(base.pathname.lastIndexOf("/") + 1);
    if (!last.includes(".")) base.pathname += "/";
  }
  return new URL(`audio/${name}.mp3`, base).href;
}

/**
 * 壳层播放器。状态只有两个开关（内存态优先于坏掉的 localStorage）：
 * - `enabled`：音效总开关（全局静音）
 * - `vibrateOn`：震动开关
 * 解锁状态由后端 `running()` 现读——切后台被系统挂起会自动回落为「待解锁」（仅当已经
 * 尝试过解锁），下次手势再恢复。
 */
export class SfxPlayer {
  private readonly backend: AudioBackend;
  private readonly store: KeyValueStore | null;
  private readonly nav: VibratorLike | null;
  private sfxPref: boolean;
  private vibratePref: boolean;
  /** 是否**尝试过**解锁（`unlock()` 调过即 true）：区分「还没试」与「试了被拒」——
   *  冷启动 AudioContext 都还没建，`running()` 为 false 不代表浏览器拒绝（G-17 只要求
   *  「浏览器若拒绝」时才出可点的「开启音效」，否则每次进游戏都是一场假告警）。 */
  private unlockAttempted = false;

  constructor(deps: SfxDeps) {
    this.backend = deps.backend;
    this.store = deps.store;
    this.nav = deps.nav;
    this.sfxPref = sfxEnabled(deps.store);
    this.vibratePref = vibrateEnabled(deps.store);
  }

  /** 🔊 音效是否开（全局静音的反面） */
  get enabled(): boolean {
    return this.sfxPref;
  }

  /** 📳 震动是否开 */
  get vibrateOn(): boolean {
    return this.vibratePref;
  }

  /** 设备是否支持震动：不支持时 T3 的 ⚙ 面板整行隐藏 */
  get canVibrate(): boolean {
    return vibrateSupported(this.nav);
  }

  /** 是否已解锁（AudioContext running） */
  get ready(): boolean {
    return this.backend.running();
  }

  /** 是否处于「待解锁」：T3 面板据此显示可点的「开启音效」（不许静默失败）。
   *  判据是「**尝试过**解锁但当前不是 running」——冷启动还没试过时 AudioContext 根本不存在，
   *  `running()` 为 false 是常态而非拒绝（G-17 的触发前提是「浏览器若拒绝」）。
   *  试过被拒 / 解锁后又被系统挂起，都会落成 true。 */
  get needsUnlock(): boolean {
    return this.unlockAttempted && !this.backend.running();
  }

  /** 素材解码进度（冒烟探针；后端不提供 stats 时为 null） */
  get assetStats(): { decoded: number; pending: number; played: number } | null {
    return this.backend.stats?.() ?? null;
  }

  /** 用户手势内调（「开始游戏」/首次点按）：成功=true 之后才可能出声 */
  async unlock(): Promise<boolean> {
    this.unlockAttempted = true; // 先置位再试：拒绝≠没试过（needsUnlock 只认「试过且没 running」）
    return this.backend.unlock();
  }

  /** 写 🔊 开关：先落内存态（写不进也本次生效），再试写 localStorage */
  setEnabled(on: boolean): void {
    this.sfxPref = on;
    setSfxEnabled(this.store, on);
  }

  /** 写 📳 开关 */
  setVibrate(on: boolean): void {
    this.vibratePref = on;
    setVibrateEnabled(this.store, on);
  }

  /** 播一声（判定模块的单个输出） */
  play(name: SfxName): void {
    this.playAll([name]);
  }

  /**
   * 播一批（`gameStore.freshSfx` 一次给全）：先判震动（与音效开关独立、不等解锁），
   * 再在「未静音 + 已解锁」时逐个出声；未解锁就整批跳过——状态留在 `needsUnlock`。
   */
  playAll(names: readonly SfxName[]): void {
    if (names.length === 0) return;
    if (shouldVibrate(names, { enabled: this.vibratePref, supported: this.canVibrate })) {
      try {
        this.nav?.vibrate(VIBRATE_MS);
      } catch {
        /* 震动失败不影响出声 */
      }
    }
    if (!this.sfxPref) return;
    if (!this.backend.running()) return;
    for (const n of names) this.backend.play(n);
  }
}

let singleton: SfxPlayer | null = null;

/**
 * 壳层单例（组件只许从这里拿）：真实 Web Audio 后端 + 浏览器 localStorage/navigator。
 * 懒建：未开局的页面不碰 AudioContext（`AudioContext` 也只在 unlock 时才建）。
 */
export function sfxPlayer(): SfxPlayer {
  singleton ??= new SfxPlayer({
    backend: new WebAudioBackend(),
    store: safeStore(),
    nav: defaultVibrator(),
  });
  return singleton;
}
