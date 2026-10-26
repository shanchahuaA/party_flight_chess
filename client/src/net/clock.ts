/**
 * 客户端对时正解（M2-T7，#44；ADR-0001 §5）：纯客户端计时权威折算器——服务端 epoch 是唯一
 * 权威，客户端多采样取最低 RTT 算 offset，再在**纯 performance.now 轴**上单调插值维护 serverNow。
 * 铁则：与 Date.now/本机墙钟解耦（改本机时钟演示不漂——performance.now 与墙钟不同源，本类无一处
 * 读 Date.now）；任何时刻读数绝不倒行（倒计时与步进演出都锚在这条轴上）。
 *
 * - sample(localSendPerf, serverNow)：sync 探针应到达时喂（roomStore 维护发送侧 pending 序），
 *   RTT=performance.now()-localSendPerf、offset=serverNow-(localSendPerf+RTT/2)；多采样取**最低
 *   RTT** 的样本为现行 offset（相同 RTT 取新）。
 * - offset 更替只在「插值不停摆」的前提下吸收：小跳差（<200ms）立即生效（可见小跳），大跳差
 *   或任何倒退都连续吸收（读数原地续走、新 offset 线从此刻起用）——大跳差的**整段重置**只留给
 *   幂等恢复点（重连/refresh 的 room 回包随你回发、其语义上的「全量快照到达」，见
 *   resetAnchor——那一刻 state.windowDeadline 同时被覆盖，读数可以整段跳）。
 * - adoptGameBaseline(serverNow)：对时样本缺席时的弱基线（最近 game 消息的 now，单向偏差≈网络
 *   往返前半程，无 RTT/2 折算——弱点注释在案）；一旦有 sync 样本立即取替（此后 no-op）。
 * - resetAnchor(serverNow)：**整段重置缝**——room 回包（you 非空=单发对齐：upgrade hello /
 *   refresh 回包）时 roomStore 调它，与快照覆盖同拍；构造可传 now 读数函数（缺省 performance.now）
 *   roomStore 在 room 回包（you 非空=单发对齐：upgrade hello / refresh 回包）时调用。
 *
 * 客户端无测试包（沿 #43 口径：typecheck/build 撑绿）；所有可测性都在纯函数形状与注入缝里，
 * 冒烟断读走 roomStore 的 ?dev=1 探针 __pztime()（offset/rttBest/samples 全量亮出）。
 */

/** 单调吸收的跳差门限：小于它的小前跳立即生效（可见跳 ≤200ms），到达或超过的（含一切倒退）
 *  连续吸收读数原地续走——line up with 契约「小跳差立即生效，大跳差只在幂等恢复点整段重置」。 */
const JUMP_ADOPT_MS = 200;
/** 超长 RTT 样本判废（锁屏恢复期挂出的陈年探针等）：不污染 bestRtt 也不吃进 offset。 */
const SANE_RTT_MS = 30_000;

export class ServerClock {
  /** 时间读数缝（缺省 performance.now；构造可传——冒烟/未来测试用，未私开测试包） */
  private readonly nowFn: () => number;
  /** 现行读数轴：origin=在 nowFn()==originPerf 时刻的 serverNow 读数（读数=origin+(nowFn()-originPerf)）。
   *  null=无任何锚（此前 serverNow()=0，与单机源未开局=0 同口径）。 */
  private origin: number | null = null;
  private originPerf = 0;
  /** 现行 offset（serverNow-localPerf，RTT/2 已折算）——探针读数面，插值与它不必恒等（吸收后差一截） */
  private offsetValue: number | null = null;
  /** 现行 offset 所背样本的 RTT（null=尚无 sync 样本） */
  private rttBestValue: number | null = null;
  /** sync 样本累计（探针读数面） */
  private samplesValue = 0;

  constructor(nowFn?: () => number) {
    this.nowFn = nowFn ?? (() => performance.now());
  }

  /** 探针读数面：已采 sync 样本数 */
  get samples(): number {
    return this.samplesValue;
  }

  /** 探针读数面：现行 offset 背书的最低 RTT（null=尚无 sync 样本） */
  get rttBest(): number | null {
    return this.rttBestValue;
  }

  /** 探针读数面：现行 offset（最后一个样本定义的粗偏移；插值吸收后与 serverNow()-nowFn() 可差一截） */
  get offset(): number | null {
    return this.offsetValue;
  }

  /** 单调插值读数（ms，服务端 epoch 轴）：无锚=0； inhabited 后恒非倒行。 */
  serverNow(): number {
    if (this.origin == null) return 0;
    return Math.round(this.origin + (this.nowFn() - this.originPerf));
  }

  /**
   * sync 探针应答喂点（roomStore 按 pending 序配对调）：rtt 与 offset 见文件头。
   * 更差 RTT 的样本只计数不改 offset（最低 RTT=现行权威）；更优/同 RTT 走单调吸收采纳。
   */
  sample(localSendPerf: number, serverNow: number): void {
    if (!(serverNow > 0) || !Number.isFinite(localSendPerf)) return;
    const perf = this.nowFn();
    const rtt = Math.max(0, perf - localSendPerf);
    if (rtt > SANE_RTT_MS) return; // 陈年挂出样本（恢复期早段等）：判废
    this.samplesValue += 1;
    if (this.rttBestValue != null && rtt > this.rttBestValue) return;
    this.rttBestValue = rtt;
    // 合成读数重心的即时读数：serverNow 已含发送前半程、再往后拨半个 RTT≈样本窗口中点
    this.adoptOffset(serverNow - (localSendPerf + rtt / 2));
  }

  /**
   * 幂等恢复点的整段重置（M2-T7 契约 C/E）：room 回包（you 非空=upgrade hello / refresh 回包）
   * 自带 epoch now——那一刻全量快照同时覆盖 state.windowDeadline，读数允许整段可见跳（无须
   * 连续吸收的门限钳制）。push 消息无发送时刻可折 RTT/2，offset=serverNow-perf（单向偏差≈
   * 半个 RTT，弱点与 adoptGameBaseline 同文——紧随其后的 sync 探针做精确修正）。
   */
  resetAnchor(serverNow: number): void {
    if (!(serverNow > 0)) return;
    const perf = this.nowFn();
    this.origin = serverNow;
    this.originPerf = perf;
    this.offsetValue = serverNow - perf;
  }

  /**
   * game 消息弱基线（M2-T7 契约 C/D）：仅当尚无 sync 样本时用最近一条 game 消息的 now 建锚——
   * 单向偏差≈网络往返前半程（now 是服务端**发送**时刻，我们读到它已晚一程，无时刻可折 RTT/2，
   * 偏差方向=读数略滞后）——弱点在案；一旦有 sync 样本立即取替（此后本调用 no-op）。
   */
  adoptGameBaseline(serverNow: number): void {
    if (!(serverNow > 0)) return;
    if (this.samplesValue > 0) return;
    this.adoptOffset(serverNow - this.nowFn());
  }

  /**
   * 带「读数绝不倒行」钳制的 offset 采纳（sample/adoptGameBaseline 共用）：
   * - 无现行轴：直接立轴（首锚）。
   * - 靶读数小幅前跳（<200ms）：立即生效，可见小跳。
   * - 靶读数倒退或大跳差（≥200ms）：连续吸收——origin 钉在当前读数原地、新 offset 线从此刻起估
   *   （读数零跳、插值不停摆）；整段可见重置只留给 resetAnchor 的幂等恢复点（实现期定案 1）。
   */
  private adoptOffset(offset: number): void {
    const perf = this.nowFn();
    this.offsetValue = offset;
    if (this.origin == null) {
      this.origin = offset + perf; // 首锚（无现行轴，直接立轴）
      this.originPerf = perf;
      return;
    }
    const current = this.serverNow(); // 现行读数（本轮 perf 同源，必非倒行）
    const target = offset + perf;
    const delta = target - current;
    if (delta > 0 && delta < JUMP_ADOPT_MS) {
      this.origin = target; // 小前跳立即生效
      this.originPerf = perf;
    } else {
      // 倒退/大跳差：连续吸收（读数原地续走，新 offset 线从此刻接上）
      this.origin = current;
      this.originPerf = perf;
    }
  }
}
