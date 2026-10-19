/**
 * 单机壳 ↔ 内核接线（M1）：
 * - 内核为权威，全部推进走 GameKernel.tick / apply；setTimeout 链喂时。
 * - 本地计时：单机本地钟（performance 基线）。M2 时换 WS 事实流；本文件是两种模式的换接点。
 * - 单机计时域（T9）：页面切后台/隐藏=本地时钟冻结（不补算后台时段——对 ADR 0001 的
 *   单机期有意偏离，M2 归位为服务端权威钟），回前台从冻结值继续。
 * - 演出：逐格动画靠 .tkMain 的 CSS transform 过渡（内核 140ms 节拍的事实驱动）。
 */
import { reactive, ref, shallowRef, watch } from "vue";
import { BOARD, GameKernel } from "../../../kernel/src";
import type { Fact, GameConfig, GameState, Intent, PlayerDef } from "../../../kernel/src";

/** 新随机种子（单机局默认换新种子——内核默认种子留给测试）：三处同形表达式的单一来源 */
export function newSeed(): number {
  return (Math.random() * 2 ** 31) | 0;
}

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
  /** 战报抽屉开启请求（T8b2）： Settlement 页跳转/回看用——计数器，WorldMessage watch 它开抽屉 */
  reportReq = ref(0);
  /** 跳转定位的目标条目 id（null=只开抽屉不定位）；抽屉关闭时清回 null */
  reportJump = ref<number | null>(null);
  /** 上一次开局的配置与名册快照（T8b2 再来一局：全套配置保留、只换种子） */
  private lastBoot: { config: Partial<GameConfig>; defs: PlayerDef[] } | null = null;
  private toastSeq = 0;

  private perfBase = 0;
  private started = false;
  /** 单机计时域（T9）：页面隐藏的起始时刻（performance 轴）；null=未隐藏 */
  private hiddenAt: number | null = null;
  /** 「轮到你了」提示的响应式解绑把手（换局/收摊要摘） */
  private stopTurnWatch: (() => void) | null = null;

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
    this.lastBoot = { config: { ...config }, defs: defs.map((d) => ({ ...d })) };
    this.resetShellState();
    this.started = true;
    this.perfBase = performance.now();
    // 单机计时域：只认 hidden 的**切换沿**（boot 时不看 document.hidden——部分内嵌 webview/IAB
    // 常驻报 hidden 且永不来 visible，误信它=时钟永久冻结；用户刚点开局，页面事实上可见）
    this.hiddenAt = null;
    document.addEventListener("visibilitychange", this.onVisibility);
    this.bindTurnWatch();
    this.handle(facts);
    this.loop();
  }

  /** 再来一局（T8b2）：上一次的全套配置与名册原样重开，只换新随机种子——新内核即无状态残留。 */
  restart(): void {
    const last = this.lastBoot;
    if (!last) return;
    this.dispose();
    this.boot({ ...last.config, seed: newSeed() }, last.defs);
  }

  /** 回大厅（T8b2）：弃局收摊，配置在大厅重调。 */
  toLobby(): void {
    this.dispose();
  }

  /** 壳层瞬时演出清零（开新局即清——上一局的掷面/选择态/脉冲不许带进新局） */
  private resetShellState(): void {
    for (const k of Object.keys(this.pulses)) delete this.pulses[Number(k)];
    this.lastFace.value = null;
    this.targeting.value = null;
    this.toast.value = null;
    this.reportReq.value = 0;
    this.reportJump.value = null;
    this.hiddenOverride = null; // 计时域冒烟钩子不跨局（上一局伪造的 hidden 不许冻住新局）
  }

  /** 战报抽屉开启请求（T8b2）：at=定位到指定条目（找战犯溯源），缺省只开抽屉滚到最新 */
  openReport(at?: number): void {
    this.reportJump.value = at ?? null;
    this.reportReq.value++;
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
   * 对 ADR 0001 的单机期有意偏离，M2 归位服务端权威钟）。只认 hidden 切换沿（boot 时常驻
   * hidden 的内嵌环境不算——见 boot 注记）。驱动链不摘（后台被节流也无妨，冻结的 now()
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

  /** 冒烟钩子（?dev=1 的 __pzvis）：伪造 hidden 读数——IAB 常驻 hidden 且切换沿出不来 */
  hiddenOverride: boolean | null = null;

  /** 轮班·限时（T9）：轮到真人=提示一声（他的表刚开始走；换人即触发，含下一轮回到自己） */
  private bindTurnWatch(): void {
    this.stopTurnWatch = watch(
      () => this.state.value?.turnActor ?? null,
      (to) => {
        if (to === 0) this.showToast("轮到你了——倒计时开始！");
      },
    );
  }

  /** 心跳：纯时间读数（倒计时）用它声明依赖，每驱动拍+1 */
  beat = ref(0);

  /** 真人（pid 0，M1 单机壳约定）；响应式（state 代理） */
  get human() {
    return this.state.value?.players[0] ?? null;
  }

  /** 轮班·限时（T9）：当前行动者的名字——HUD「轮到 X」徽标与「轮到你了」提示共用一份读数（world 模式/波窗合砍=null） */
  get turnActorName(): string | null {
    const s = this.state.value;
    if (!s || s.turnActor == null || s.phase !== "acting") return null;
    return s.players[s.turnActor]?.name ?? null;
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
        case "beastHit":
          // 年兽战砍面（T8a2）：dock 砍击钮上显示本刀伤害（与掷面同槽——都是「我掷出的点」）
          if (f.pid === 0) this.lastFace.value = f.dmg;
          break;
        case "itemPlayed":
          // 打出成功的事实收账（T4a2）：目卡不在手=已出袋；targeting 属于目卡即退场（内核拒时不发此事实）
          if (f.pid === 0 && this.targeting.value === f.cardId) this.cancelTargeting();
          break;
        case "eliminated":
          // 血尽淘汰（T5c）：观战提示用 toast 不弹窗打断（界面呈现定案 §六：棋盘变暗+锁标是本体）；
          // 本人出局时打牌目标选择若还挂着，一并收掉（死人不出手）
          if (f.pid === 0 && this.targeting.value) this.cancelTargeting();
          this.showToast(`☠ ${this.state.value?.players[f.pid]?.name ?? "有人"} 血尽出局——进入观战`);
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
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.hiddenAt = null;
    this.stopTurnWatch?.();
    this.stopTurnWatch = null;
    window.clearTimeout(GameStore.timer);
  }
}

export const gameStore = new GameStore();

/** 调试冒烟通道（?fast=）：免大厅直达一局短窗局（10s 窗/无休息），暗牌自动代选；
 *  追加 ?dev=1 时开局 allowDev 局并挂 window.__pzcard（强抽指定事件卡，浮层冒烟用）；
 *  ?win=秒 自定义窗长（冒烟多步交互防收窗——T7 海关窗任务条组冒烟用）；
 *  ?turn=N 自定义局长（≥5，T8a2 年兽战冒烟用——短局快进到最后一波）；
 *  ?mode=turn 轮班·限时（T9 冒烟——按座次轮流行动）。 */
export function maybeBootFastPath(): void {
  if (gameStore.kernel.value) return;
  const params = new URLSearchParams(location.search);
  if (!params.has("fast")) return;
  const dev = params.has("dev");
  // ?slow=1：60s 慢窗（壳层冒烟用——10s 快窗手速赛会与逐格走/替掷竞速）；?win=秒 再放长（多步冒烟）
  const winParam = Number(params.get("win"));
  const windowMs = Number.isFinite(winParam) && winParam > 0 ? winParam * 1000 : params.has("slow") ? 60_000 : 10_000;
  const turnParam = Number(params.get("turn"));
  const turnCap = Number.isInteger(turnParam) && turnParam >= 5 ? turnParam : undefined;
  gameStore.boot(
    {
      allowDev: dev,
      windowMs,
      restMs: 0,
      stepMs: 90,
      seed: newSeed(),
      ...(turnCap ? { turnCap } : {}),
      ...(params.get("mode") === "turn" ? { timerMode: "turn" as const } : {}),
    },
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
 *  __pzdead(pid?) 出局占位（T4a2 淘汰观战态冒烟）；__pzdog(cell?) 生成野狗钉位（T6b 遭遇战/棋盘贴皮冒烟——
 *  缺省钉人间相邻格=过一拍就可能撞上）；__pzcustoms(sheriff?) 钉位开海关风云（T7 警长窗冒烟——
 *  缺省同真抽=随机警长，传 0 钉人间当警长）；__pzbeast(hp) 钉年兽血量（T8a2 冒烟——钉 1=下一刀必杀、
 *  钉大数=挂机看反噬/团灭） */
function bindDevChannels(): void {
  const w = window as unknown as Record<string, unknown>;
  w.__pzcard = (cardId: string, pid = 0) => gameStore.apply({ type: "dev.drawCard", pid, cardId });
  w.__pzgive = (cardId: string, pid = 0) => gameStore.apply({ type: "dev.giveItem", pid, cardId });
  w.__pzplay = (cardId: string, target?: number) => gameStore.playItem(cardId, target);
  w.__pzdead = (pid = 0) => gameStore.apply({ type: "dev.setDead", pid });
  w.__pzcustoms = (sheriff?: number) => gameStore.apply(sheriff == null ? { type: "dev.customs" } : { type: "dev.customs", sheriff });
  w.__pzbeast = (hp: number) => gameStore.apply({ type: "dev.setBeast", hp });
  // 单机计时域冒烟（T9）：伪造 hidden 切换沿——__pzvis(true)=切后台时钟冻结 / __pzvis(false)=回前台恢复
  w.__pzvis = (hidden: boolean) => {
    gameStore.hiddenOverride = hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  };
  w.__pzdog = (cell?: number) => {
    const k = gameStore.kernel.value;
    if (!k) return;
    const me = k.state.players[0]!;
    gameStore.apply({ type: "dev.spawnDog", cell: cell ?? BOARD[me.pos]!.links[0]! }); // 缺省钉人间相邻格=过一拍可能撞上
  };
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
      dogs: s.malice.dogs.map((d) => `${d.cell}:hp${d.hp}:life${d.left}`).join(" ") || "无", // T6b 狗账快照
      customs: s.customs
        ? `警长${s.customs.sheriff}·查${s.customs.checksLeft}${s.customs.degraded ? "·撤岗" : ""}·单${s.customs.shipments.length}${s.customs.pending ? `·挂账${s.customs.pending.from}→${s.customs.pending.to}` : ""}`
        : "无", // T7 海关账快照
      items: `堆${s.itemDeck.length}/弃${s.itemDiscard.length}`,
      msgs: s.messages.slice(-8).map((m) => m.text),
    };
  };
}
