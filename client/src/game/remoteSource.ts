/**
 * 联机源（M2-T6，#43）：GameSource 第二实现——服务端=唯一权威，客户端零内核实例。
 * - feed(game)：每条胖消息整体覆盖。**先替 state 再派 facts**（#39「状态先于事实入壳」不变式：
 *   stateProxy=reactive(game.state) 之后才 h.onFacts(game.facts)，壳层镜像与事实消费都读得到新态）；
 *   演出语义（pulses/lastFace/eliminated/targeting 清账）由壳层 handle(facts) 原样复用——
 *   远端事实与单机内核事实同形状（服务端 gameView 只做重定基+裁剪，不换形状）。
 * - send(intent)：通道上行 {type:"intent",turn,intent}。pid 恒 0=发送者视角（协议规定，服务端
 *   gameView 替视角折算——壳层与游戏组件的「自己=players[0]」零改动；这是本源的契约枢纽）；
 *   turn=本地已知的内核回合号（state?.turn ?? 1，DO 对账，过期=error+快照对齐）。死线：
 *   wsSend 返回 false=抛错，走壳层 apply 的 catch→toast（与 KernelError 同路）；服务端拒
 *   （非法意图）走 Downstream error+快照对齐，不进此路。
 * - now()：服务端权威钟朴素插值——每条 game 消息记录 (localPerf, serverNow) 对，
 *   now()=serverNow+(performance.now()-localPerf)。服务端内核时钟轴=epoch ms（room.now()=
 *   Date.now()+clockOffset，生产 offset 恒 0；协议 now 字段/windowDeadline 等时限同轴），
 *   插值读数与全部时限直接对得上。**倒计时连续性：本票刻意朴素，跨消息漂移修正不作——
 *   多采样对时/页面隐藏可见性恢复=T7(#44) 的计时域正解，此处不预埋。**
 * - config：建源时透传房间快照的 LobbyConfig（HUD turnCap/maxHp 读数照常）；对局期服务端冻结不改。
 * - 驱动链：33ms 一拍只做 h.onStep()（壳层 beat 增量→倒计时/演出读数重渲），**不调任何 tick**——
 *   推进权威全在服务端 Alarm；stop()=清链+摘 feed（alive 门闸）+通知 roomStore 摘名。
 */
import { reactive } from "vue";
import type { GameState, GameConfig, Intent } from "../../../kernel/src";
import type { Downstream, LobbyConfig, Upstream } from "../../../shared/protocol";
import type { GameSource, SourceHandlers } from "./source";

/** 下行 game 胖消息（本源的入料形状=shared/protocol 的 game 分支） */
export type DownstreamGame = Extract<Downstream, { type: "game" }>;

export class RemoteRoomSource implements GameSource {
  private stateProxy: GameState | null = null;
  /** 最近一次对时锚（per 消息单对=T6 期朴素插值；见 now() 注释） */
  private clockRef: { localPerf: number; serverNow: number } | null = null;
  private alive = false;
  private timer = 0;

  constructor(
    private h: SourceHandlers,
    /** 上行出口（roomStore 供给，死线守卫）：返回 false=连接断了（send 抛错走壳层 toast） */
    private wsSend: (msg: Upstream) => boolean,
    /** 收摊通知（roomStore 摘名）：stop() 时必调一次；此后 game 消息由 roomStore 重建源 */
    private onDisposed: () => void,
    /** 开局配置=房间快照 LobbyConfig 透传（HUD 读数；实现期定案：契约原文「构造收三样」，
     *  config 系 HUD 读数必需的第四样——来源仍是房间快照，见交付说明） */
    private lobbyConfig: LobbyConfig | null,
  ) {
    this.alive = true;
    this.loop();
  }

  get state(): GameState | null {
    return this.stateProxy;
  }

  get config(): Partial<GameConfig> | null {
    return this.lobbyConfig;
  }

  /** 服务端胖消息入源（唯一入口；roomStore 的 case "game" 喂） */
  feed(game: DownstreamGame): void {
    if (!this.alive) return; // 已收摊（摘 feed）：迟到的旧消息静默丢弃
    try {
      // 状态先于事实入壳（#39 不变式）：先整体覆盖 state、对时锚更新，再派 facts——
      // 壳层镜像（roomStore 的 onFacts 首 mirror）与 pulse/掷面语义都读得到最新态
      this.stateProxy = reactive(game.state) as GameState;
      this.clockRef = { localPerf: performance.now(), serverNow: game.now };
      this.h.onFacts(game.facts);
    } catch (err) {
      this.h.onCrash(err); // 畸形载荷等致命故障：壳层提示，源即停摆（下条 game 消息 roomStore 重建）
      this.stop();
    }
  }

  send(intent: Intent): void {
    if (!this.alive) return;
    const ok = this.wsSend({ type: "intent", turn: this.stateProxy?.turn ?? 1, intent });
    if (!ok) throw new Error("连接已断开，请先重连再操作");
  }

  now(): number {
    const c = this.clockRef;
    return Math.round(c != null ? c.serverNow + (performance.now() - c.localPerf) : 0);
  }

  stop(): void {
    this.alive = false;
    this.stateProxy = null;
    this.clockRef = null;
    window.clearTimeout(this.timer);
    this.onDisposed();
  }

  /** 33ms 驱动链（与单机源同拍）：只给壳层心跳 h.onStep()（beat 增量驱动倒计时重渲），
   *  不 tick——推进权威全在服务端 Alarm；onStep 只落读数，异常不中断链 */
  private loop(): void {
    const step = () => {
      if (!this.alive) return;
      try {
        this.h.onStep();
      } catch {
        /* 心跳读数异常不破链 */
      }
      this.timer = window.setTimeout(step, 33);
    };
    this.timer = window.setTimeout(step, 33);
  }
}
