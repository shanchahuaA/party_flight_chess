/**
 * 数据源（M2-T2 双源抽象，#39）：壳层与内核解耦的缝——意图出口 + 状态/事实入口。
 * - 单机源 LocalKernelSource＝本地内核原样包一层（驱动链/本地冻结钟住源里），行为与旧 store 直连一致。
 * - 联机源（M2-T6）作为第二实现接入同一接口：客户端不实例化内核，快照整体覆盖 + 服务端事实流驱动
 *   （Spec #37 实现决策 2/5）——单机模式与联机模式共用全部壳层。
 * - 壳层 store 只认 GameSource 面；构造与开局入口按大厅双入口分流（单机=LocalKernelSource.start）。
 */
import { reactive } from "vue";
import { GameKernel } from "../../../kernel/src";
import type { Fact, GameConfig, GameState, Intent, PlayerDef } from "../../../kernel/src";

/** 源 → 壳层的推送通道（构造时接好） */
export interface SourceHandlers {
  /** 事实入站（单机=内核事实流；联机=服务端事实流）——壳层演出消费的唯一入口 */
  onFacts(facts: Fact[]): void;
  /** 每个驱动拍（单机=33ms tick 链）——壳层心跳 beat 挂这里（倒计时重渲驱动） */
  onStep(): void;
  /** 驱动链致命故障（tick 抛非业务异常）——壳层提示后源停摆 */
  onCrash(err: unknown): void;
}

/** 数据源接口：壳层唯一认这张面。内核拒绝（KernelError）从 send 上抛由壳 toast；联机的非法意图=服务端 error 事实+快照对齐，不走此路 */
export interface GameSource {
  /** 意图出口：壳层一切操作的唯一上行 */
  send(intent: Intent): void;
  /** 状态入口：reactive 代理（内核深写细粒度失效；联机=快照整体覆盖）；null=未开局 */
  readonly state: GameState | null;
  /** 本局配置只读面（HUD turnCap/maxHp 等读数）；null=未开局 */
  readonly config: Partial<GameConfig> | null;
  /** 源时钟（单机=本地冻结钟；联机=服务端权威钟插值）。未开局=0 */
  now(): number;
  /** 收摊（弃局/回大厅/换局）：停驱动链、摘监听、置空状态 */
  stop(): void;
}

/**
 * 单机源：GameKernel 原样包一层（M1 行为零变化）。驱动链（33ms setTimeout 链——部分内嵌环境
 * rAF 可能整体不触发）、本地冻结钟与单机计时域（hidden 切换沿记账）都住这里；换局=新实例，
 * 冒烟钩子 hiddenOverride 随实例天然复位（旧 store 的跨局手工清零变结构保证）。
 */
export class LocalKernelSource implements GameSource {
  private kernel: GameKernel | null = null;
  private stateProxy: GameState | null = null;
  private timer = 0;
  private started = false;
  private perfBase = 0;
  /** 单机计时域（T9）：页面隐藏的起始时刻（performance 轴）；null=未隐藏 */
  private hiddenAt: number | null = null;
  /** 冒烟钩子（?dev=1 的 __pzvis）：伪造 hidden 读数——IAB 常驻 hidden 且切换沿出不来 */
  hiddenOverride: boolean | null = null;

  constructor(private h: SourceHandlers) {}

  /**
   * 开局：配置+defs（真人在内）定谳 → 一次创建即 drafting：真人暗牌选择由游戏页浮层驱动
   * （chooseSecret 意图走 send），选完内核才开第一窗。
   */
  start(config: Partial<GameConfig>, defs: PlayerDef[]): void {
    const { kernel, facts } = GameKernel.create(config, 0, defs);
    // 重要：内核之后所有读写都走代理 → 模板里直接读代理的组件获得细粒度真响应
    kernel.attachStateProxy((s) => reactive(s) as GameState);
    this.kernel = kernel;
    this.stateProxy = reactive(kernel.state) as GameState;
    this.started = true;
    this.perfBase = performance.now();
    // 单机计时域：只认 hidden 的**切换沿**（开局时不看 document.hidden——部分内嵌 webview/IAB
    // 常驻报 hidden 且永不来 visible，误信它=时钟永久冻结；用户刚点开局，页面事实上可见）
    this.hiddenAt = null;
    document.addEventListener("visibilitychange", this.onVisibility);
    this.h.onFacts(facts);
    this.loop();
  }

  get state(): GameState | null {
    return this.stateProxy;
  }

  get config(): Partial<GameConfig> | null {
    return this.kernel?.config ?? null;
  }

  send(intent: Intent): void {
    if (!this.kernel) return;
    this.h.onFacts(this.kernel.apply(intent, this.now()));
  }

  /**
   * 单机本地钟：内核时间轴（ms，0 起单调）。
   * 隐藏期间读数冻结（扣掉隐藏时长）——后台时段不从时钟轴上走，deadline 全体顺延=不补算。
   */
  now(): number {
    if (!this.started) return 0;
    const paused = this.hiddenAt != null ? performance.now() - this.hiddenAt : 0;
    return Math.round(performance.now() - this.perfBase - paused);
  }

  /**
   * 单机计时域（T9）：切后台/隐藏=本地计时暂停，回前台恢复继续（不补算后台时段——
   * 对 ADR 0001 的单机期有意偏离，M2 归位服务端权威钟）。只认 hidden 切换沿（开局时常驻
   * hidden 的内嵌环境不算——见 start 注记）。驱动链不摘（后台被节流也无妨，冻结的 now()
   * 让 tick 全是空拍），只记账。
   */
  private onVisibility = (): void => {
    if (!this.started) return;
    const hidden = this.hiddenOverride ?? document.hidden;
    if (hidden) {
      if (this.hiddenAt == null) this.hiddenAt = performance.now();
    } else if (this.hiddenAt != null) {
      this.perfBase += performance.now() - this.hiddenAt; // 隐藏时长整段剜掉
      this.hiddenAt = null;
    }
  };

  private loop(): void {
    // 内嵌环境（部分 IAB）rAF 可能整体不触发；驱动器统一走 setTimeout 链，
    // 33ms 一拍 ≈ 内核事实节拍骨感（140ms 步进）之上，真实手机上同样工作。
    const step = () => {
      if (!this.started || !this.kernel) return;
      try {
        this.h.onStep();
        this.h.onFacts(this.kernel.tick(this.now()));
      } catch (err) {
        this.h.onCrash(err);
        return; // 故障即停推进（不重排下一拍）
      }
      this.timer = window.setTimeout(step, 33);
    };
    this.timer = window.setTimeout(step, 33);
  }

  stop(): void {
    this.started = false;
    this.kernel = null;
    this.stateProxy = null;
    this.hiddenAt = null;
    this.hiddenOverride = null; // 冒烟钩子随源收摊（实例本为单局一次性，这里兜人为复用）
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.clearTimeout(this.timer);
  }
}
