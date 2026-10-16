/**
 * 单机壳 ↔ 内核接线（M1）：
 * - 内核为权威，全部推进走 GameKernel.tick / apply；rAF 心跳喂时。
 * - 本地计时：单机本地钟（performance 基线）。M2 时换 WS 事实流；本文件是两种模式的换接点。
 * - 演出：逐格动画靠 .tkMain 的 CSS transform 过渡（内核 140ms 节拍的事实驱动）。
 */
import { reactive, ref, shallowRef } from "vue";
import { GameKernel } from "../../../kernel/src";
import type { Fact, GameConfig, GameState, Intent, MessageEntry } from "../../../kernel/src";

export interface PulseLit {
  level: "normal" | "target" | "big";
  until: number;
}

/**
 * 快照策略：内核持有普通对象（权威）；对它包一层 reactive 代理给 UI 读。
 * 内核深写 → 模板里直接读代理的组件自动失效重渲（细粒度、无需 version 通道）。
 */
class GameStore {
  kernel = shallowRef<GameKernel | null>(null);
  state = shallowRef<GameState | null>(null); // reactive 代理
  /** 事实侧的瞬时演出：棋子脉冲（level 熄灭时间戳） */
  pulses = reactive<Record<number, PulseLit>>({});
  /** 最近战报一条（T1 简版：单行常显，T3 起变战报流水） */
  lastMessage = shallowRef<MessageEntry | null>(null);
  /** 最后一次掷面（dock 掷骰钮上显示） */
  lastFace = ref<number | null>(null);
  /** 错误提示（KernelError 等，短暂展示） */
  toast = ref<string | null>(null);
  private toastSeq = 0;

  private perfBase = 0;
  private started = false;

  boot(config: Partial<GameConfig> = {}): void {
    const { kernel, facts } = GameKernel.create(config, 0);
    // 重要：内核之后所有读写都走代理 → 模板里直接读代理的组件获得细粒度真响应
    kernel.attachStateProxy((s) => reactive(s) as GameState);
    this.kernel.value = kernel;
    this.state.value = reactive(kernel.state) as GameState;
    this.started = true;
    this.perfBase = performance.now();
    this.handle(facts);
    this.loop();
  }

  /** 单机本地钟：内核时间轴（ms，0 起单调） */
  now(): number {
    return this.started ? Math.round(performance.now() - this.perfBase) : 0;
  }

  /** 心跳：纯时间读数（倒计时）用它声明依赖，每驱动拍+1 */
  beat = ref(0);

  apply(intent: Intent): void {
    const k = this.kernel.value;
    if (!k) return;
    try {
      this.handle(k.apply(intent, this.now()));
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : String(err));
    }
  }

  private showToast(text: string): void {
    this.toast.value = text;
    const seq = ++this.toastSeq;
    window.setTimeout(() => {
      if (seq === this.toastSeq) this.toast.value = null;
    }, 1800);
  }

  private loop(): void {
    // 内嵌环境（部分 IAB）rAF 可能整体不触发；驱动器统一走 setTimeout 链，
    // 33ms 一拍 ≈ 内核事实节拍骨感（140ms 步进）之上，真实手机上同样工作。
    let stopped = () => !this.started || !this.kernel.value;
    const step = () => {
      if (stopped()) return;
      try {
        this.beat.value++;
        this.handle(this.kernel.value!.tick(this.now()));
      } catch (err) {
        console.error("[kernel-tick]", err);
        this.showToast(err instanceof Error ? `内核故障已停推进：${err.message}` : String(err));
        return;
      }
      GameStore.timer = window.setTimeout(step, 33);
    };
    GameStore.timer = window.setTimeout(step, 33);
  }

  private static timer = 0;

  private handle(facts: Fact[]): void {
    for (const f of facts) {
      switch (f.type) {
        case "roll":
          if (f.pid === 0) this.lastFace.value = f.d;
          break;
        case "pulse":
          this.pulses[f.pid] = {
            level: f.level,
            until: performance.now() + (f.level === "big" ? 1_600 : 1_000),
          };
          break;
        default:
          break;
      }
    }
    const msgs = this.kernel.value?.state.messages ?? [];
    const last = msgs[msgs.length - 1];
    if (last && (!this.lastMessage.value || last.id > this.lastMessage.value.id)) {
      this.lastMessage.value = last;
    }
  }

  /** 演出清理：过期的脉冲熄灭（读时算，无状态） */
  isLit(pid: number): "normal" | "target" | "big" | null {
    const lit = this.pulses[pid];
    return lit && lit.until > performance.now() ? lit.level : null;
  }

  dispose(): void {
    this.started = false;
    this.kernel.value = null;
    this.state.value = null;
    window.clearTimeout(GameStore.timer);
  }
}

export const gameStore = new GameStore();

/** 惰性启动：App 挂载后调用（?fast=调试短窗：6s 窗/2s 休息，冒烟与演示用） */
export function ensureBooted(): void {
  if (gameStore.kernel.value) return;
  const fast = typeof location !== "undefined" && new URLSearchParams(location.search).has("fast");
  const cfg: Partial<GameConfig> = fast
    ? { allowDev: false, windowMs: 6_000, restMs: 2_000, routeAskMs: 6_000, stepMs: 90, seed: (Math.random() * 2 ** 31) | 0 }
    : { allowDev: false, seed: (Math.random() * 2 ** 31) | 0 }; // 单机局默认换新种子（#16 故事 31 的精神；内核默认种子留给测试）
  gameStore.boot(cfg);
  // 开发期只读快照钩子（window.__pz()）
  (window as unknown as Record<string, unknown>).__pz = () => {
    const k = gameStore.kernel.value;
    if (!k) return null;
    const s = k.state;
    const me = s.players[0]!;
    return {
      now: gameStore.now(),
      turn: s.turn,
      phase: s.phase,
      me: `${me.pos}${me.zone[0]} net${me.net}${me.rolled ? "R" : ""}${me.confirmed ? "C" : ""} trail${me.trail.length}${me.walk ? ` w${me.walk.remaining}${me.walk.ask ? " ❓选路" : ""}${me.walk.pendingTo != null ? " ▶" : ""}` : ""}`,
      bots: s.players.slice(1).map((p) => `${p.pos}${p.zone[0]}${p.rolled ? "R" : ""}${p.confirmed ? "C" : ""}${p.walk ? "w" : ""}`).join(" "),
      finishers: s.finishers,
      msgs: s.messages.slice(-2).map((m) => m.text),
    };
  };
}
