/**
 * 单机壳 ↔ 内核接线（M1）：
 * - 内核为权威，全部推进走 GameKernel.tick / apply；rAF 心跳喂时。
 * - 本地计时：单机本地钟（performance 基线）。M2 时换 WS 事实流；本文件是两种模式的换接点。
 * - 演出：逐格动画靠 .tkMain 的 CSS transform 过渡（内核 140ms 节拍的事实驱动）。
 */
import { reactive, ref, shallowRef } from "vue";
import { GameKernel } from "../../../kernel/src";
import type { Fact, GameConfig, GameState, Intent, PlayerDef } from "../../../kernel/src";

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
  /** 最后一次掷面（dock 掷骰钮上显示） */
  lastFace = ref<number | null>(null);
  /** 错误提示（KernelError 等，短暂展示） */
  toast = ref<string | null>(null);
  /** 道具卡目标选择中（T4a2）：chooseOther 打出即进入，棋盘点头像收口；null=未在选 */
  targeting = ref<string | null>(null);
  private toastSeq = 0;

  private perfBase = 0;
  private started = false;

  /**
   * 开局（T2 起由大厅页调用）：配置+ defs（真人在内）定谳 → 一次创建即 drafting：
   * 真人暗牌选择由游戏页浮层驱动（chooseSecret），选完内核才开第一窗。
   */
  boot(config: Partial<GameConfig>, defs: PlayerDef[]): void {
    const { kernel, facts } = GameKernel.create(config, 0, defs);
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

  /** 真人（pid 0，M1 单机壳约定）；响应式（state 代理） */
  get human() {
    return this.state.value?.players[0] ?? null;
  }

  apply(intent: Intent): void {
    const k = this.kernel.value;
    if (!k) return;
    try {
      this.handle(k.apply(intent, this.now()));
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : String(err));
    }
  }

  /** 进入 chooseOther 目标选择（T4a2）：棋盘头像收口；合法性由 itemLegalTargets 给 */
  startTargeting(cardId: string): void {
    this.targeting.value = cardId;
  }

  cancelTargeting(): void {
    this.targeting.value = null;
  }

  /** 棋盘点头像提交目标（T4a2）：内核拒（非法/已锁）即抛——不发 itemPlayed 事实，选择态保留可供换点 */
  pickTarget(target: number): void {
    const cardId = this.targeting.value;
    if (!cardId) return;
    this.playItem(cardId, target);
  }

  /** 打道具卡单出口（kernel 拒绝即抛走 toast；打出成功由 itemPlayed 事实收账） */
  playItem(cardId: string, target?: number): void {
    this.apply(target == null ? { type: "playItem", pid: 0, cardId } : { type: "playItem", pid: 0, cardId, target });
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
        case "itemPlayed":
          // 打出成功的事实收账（T4a2）：目卡不在手=已出袋；targeting 属于目卡即退场（内核拒时不发此事实）
          if (f.pid === 0 && this.targeting.value === f.cardId) this.cancelTargeting();
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

/** 调试冒烟通道（?fast=）：免大厅直达一局短窗局（10s 窗/无休息），暗牌自动代选；
 *  追加 ?dev=1 时开局 allowDev 局并挂 window.__pzcard（强抽指定事件卡，浮层冒烟用） */
export function maybeBootFastPath(): void {
  if (gameStore.kernel.value) return;
  const params = new URLSearchParams(location.search);
  if (!params.has("fast")) return;
  const dev = params.has("dev");
  // ?slow=1：60s 慢窗（壳层冒烟用——10s 快窗手速赛会与逐格走/替掷竞速）
  const windowMs = params.has("slow") ? 60_000 : 10_000;
  gameStore.boot(
    { allowDev: dev, windowMs, restMs: 0, stepMs: 90, seed: (Math.random() * 2 ** 31) | 0 },
    [
      { name: "你", isBot: false, roleId: "light" },
      { name: "小黄", isBot: true },
      { name: "小绿", isBot: true },
    ],
  );
  gameStore.apply({ type: "chooseSecret", pid: 0, pick: 0 });
  if (dev) bindDevChannels();
  bindDevSnapshot();
}

/** 调试卡牌通道（?dev=1）：window.__pzcard("e03", pid?) → dev.drawCard 强抽（抉择/效果/地区卡冒烟）；
 *  __pzgive(道具卡 id, pid?) 塞手牌；__pzplay(道具卡 id, target?) 打出手（T4a 打出链冒烟）；
 *  __pzdead(pid?) 出局占位（T4a2 淘汰观战态冒烟） */
function bindDevChannels(): void {
  const w = window as unknown as Record<string, unknown>;
  w.__pzcard = (cardId: string, pid = 0) => gameStore.apply({ type: "dev.drawCard", pid, cardId });
  w.__pzgive = (cardId: string, pid = 0) => gameStore.apply({ type: "dev.giveItem", pid, cardId });
  w.__pzplay = (cardId: string, target?: number) => gameStore.playItem(cardId, target);
  w.__pzdead = (pid = 0) => gameStore.apply({ type: "dev.setDead", pid });
}

/** 开发期只读快照钩子（window.__pz()）：内核态随手可查 */
function bindDevSnapshot(): void {
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
      hand: me.hand.join(","),
      ground: s.ground.map((g) => `${g.cell}:${g.cardId}`).join(" "),
      items: `堆${s.itemDeck.length}/弃${s.itemDiscard.length}`,
      msgs: s.messages.slice(-2).map((m) => m.text),
    };
  };
}
