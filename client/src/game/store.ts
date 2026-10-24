/**
 * 壳层 store ↔ 数据源接线（M2-T2 双源抽象）：
 * - 壳层只认 GameSource 接口（source.ts）：意图出口 send + 状态入口 state/config + 事实入口 onFacts。
 *   单机源=LocalKernelSource（本地内核包一层）；联机源=M2-T6 快照+事实流接同一面，共用全部壳层。
 * - 单机计时：本地冻结钟住源里（performance 基线）；单机计时域（T9）页面切后台/隐藏=时钟冻结
 *   （不补算后台时段——对 ADR 0001 的单机期有意偏离，M2 归位为服务端权威钟），回前台从冻结值继续。
 * - 演出：逐格动画靠 .tkMain 的 CSS transform 过渡（内核 140ms 节拍的事实驱动）。
 */
import { reactive, ref, shallowRef, watch } from "vue";
import { BOARD } from "../../../kernel/src";
import type { Fact, GameConfig, GameState, Intent, PlayerDef } from "../../../kernel/src";
import { LocalKernelSource, type GameSource } from "./source";

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
  /** 当前数据源（单机=LocalKernelSource；联机=M2-T6 远程源接同一接口）；null=未开局 */
  source = shallowRef<GameSource | null>(null);
  state = shallowRef<GameState | null>(null); // reactive 代理（源侧状态入口的镜像引用）
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

  /** 「轮到你了」提示的响应式解绑把手（换局/收摊要摘） */
  private stopTurnWatch: (() => void) | null = null;

  /** 本局配置只读面（HUD turnCap/maxHp 等读数）——源侧 config 的透传 */
  get config(): Partial<GameConfig> | null {
    return this.source.value?.config ?? null;
  }

  /**
   * 开局（T2 起由大厅页调用）：配置+ defs（真人在内）定谳 → 一次创建即 drafting：
   * 真人暗牌选择由游戏页浮层驱动（chooseSecret），选完内核才开第一窗。
   * 单机入口：建 LocalKernelSource（驱动链/冻结钟/初始事实随源起），壳层只接住状态引用。
   */
  boot(config: Partial<GameConfig>, defs: PlayerDef[]): void {
    this.dispose(); // 防御：boot 前收掉任何残留源（正常入口均已先收摊）——源实例自持驱动链，不收会双链驱动
    let src: LocalKernelSource;
    src = new LocalKernelSource({
      onFacts: (facts) => {
        // 状态引用先于事实入壳挂好（旧序不变式）：初始事实的壳层消费读得到 state
        if (this.state.value !== src.state) this.state.value = src.state;
        this.handle(facts);
      },
      onStep: () => {
        this.beat.value++;
      },
      onCrash: (err) => {
        console.error("[kernel-tick]", err);
        this.showToast(err instanceof Error ? `内核故障已停推进：${err.message}` : String(err));
      },
    });
    this.lastBoot = { config: { ...config }, defs: defs.map((d) => ({ ...d })) };
    this.resetShellState(); // 开新局即清上一局瞬时态；hiddenOverride 不在此列——换局=新源实例，天然复位
    src.start(config, defs); // 建内核+挂代理+初始事实+驱动链（本地冻结钟/visibility 监听随源起）；建局被拒=此处抛，壳层零污染
    this.source.value = src;
    this.bindTurnWatch();
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
  }

  /** 战报抽屉开启请求（T8b2）：at=定位到指定条目（找战犯溯源），缺省只开抽屉滚到最新 */
  openReport(at?: number): void {
    this.reportJump.value = at ?? null;
    this.reportReq.value++;
  }

  /** 源时钟透传（单机=本地冻结钟；联机=服务端钟插值）。未开局=0 */
  now(): number {
    return this.source.value?.now() ?? 0;
  }

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
    const src = this.source.value;
    if (!src) return;
    try {
      src.send(intent);
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
    this.source.value?.stop();
    this.source.value = null;
    this.state.value = null;
    this.stopTurnWatch?.();
    this.stopTurnWatch = null;
  }
}

export const gameStore = new GameStore();

/** 调试冒烟通道（?fast=）：免大厅直达一局短窗局（10s 窗/无休息），暗牌自动代选；
 *  追加 ?dev=1 时开局 allowDev 局并挂 window.__pzcard（强抽指定事件卡，浮层冒烟用）；
 *  ?win=秒 自定义窗长（冒烟多步交互防收窗——T7 海关窗任务条组冒烟用）；
 *  ?turn=N 自定义局长（≥5，T8a2 年兽战冒烟用——短局快进到最后一波）；
 *  ?mode=turn 轮班·限时（T9 冒烟——按座次轮流行动）。 */
export function maybeBootFastPath(): void {
  if (gameStore.source.value) return;
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
    const src = gameStore.source.value;
    if (src instanceof LocalKernelSource) src.hiddenOverride = hidden; // instanceof 穿缝：hiddenOverride 是单机源冒烟钩子，不上接口（联机源无此概念）
    document.dispatchEvent(new Event("visibilitychange"));
  };
  w.__pzdog = (cell?: number) => {
    const me = gameStore.state.value?.players[0];
    if (!me) return;
    gameStore.apply({ type: "dev.spawnDog", cell: cell ?? BOARD[me.pos]!.links[0]! }); // 缺省钉人间相邻格=过一拍可能撞上
  };
}

/** 开发期只读快照钩子（window.__pz()）：内核态随手可查 */
function bindDevSnapshot(): void {
  (window as unknown as Record<string, unknown>).__pz = () => {
    const s = gameStore.state.value;
    if (!s) return null;
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
