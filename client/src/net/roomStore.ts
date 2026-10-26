/**
 * 房间连接与视图状态（M2-T3，#40）：进房/大厅双入口的客户端侧——
 * - 视图机：home（单机大厅）/ join（进房页）/ room（房间大厅），App.vue 按此切换三页。
 * - HTTP 面：创建（POST /api/rooms）与加入（POST /api/rooms/:code/join）签发 token；
 *   WS 面：/ws/:code?token= 连上即认座，下行全量快照整体覆盖（胖消息口径）。
 * - token 存 localStorage（pfc.token.<code>），刷新/断线免重输；同 token 新连接顶旧连
 *   （replaced）由服务端裁决，旧页收到通知即失效。
 * - 对局面（M2-T6，#43）：room 快照 phase 演变=生命周期钩子（lobby 常态 / playing 首现不动——
 *   主动等第一条 game 消息再建源；intermission 首现=收对局壳+结算缓存）；case "game"=建源
 *   （开局 hello 与 Hibernation 重连全量 hello 同一条路）→ feed 胖消息进壳。
 *   RemoteRoomSource 的上行出口/收摊通知（disposeHook）都挂在本 store 上。
 * - 对时正解（M2-T7，#44）：ServerClock（本包 clock.ts）住本 store——生命周期=连接域，比源长
 *   （源收摊/重建复用同一只钟）。建连成功(open)→多采样 sync 探针（4 条@150ms，pending 严格按
 *   到达序配对喂钟）+ 每 60s 幂等 refresh 保鲜；回前台 visible 沿/pageshow(persisted)/手动重连
 *   成功→refresh+采样一次（幂等重对时+全量快照覆盖本地——绝不补算锁屏期间的事，自动重连=T8）；
 *   room 回包（you 非空=单发对齐）走 resetAnchor 整段重置缝，game 消息走源内 adoptGameBaseline
 *   弱基线——倒计时=windowDeadline-clock.serverNow() 全靠 store.now() 现行线（HUD 组件零改动）。
 * - 断线治理（自动重连/转移/踢人）在 T8 落，本票只有手动重连一条缝；重连后 game hello 照 feed
 *   （源活着直接吃新快照）。
 */
import { ref } from "vue";
import type {
  GameState,
  RoleId,
  SettlementResult,
} from "../../../kernel/src";
import type { Downstream, LobbyConfig, RoomSnapshot, Upstream } from "../../../shared/protocol";
import { ServerClock } from "./clock";
import { bindDevSnapshot, gameStore } from "../game/store";
import { RemoteRoomSource, type DownstreamGame } from "../game/remoteSource";

const TOKEN_KEY_PREFIX = "pfc.token.";
const NICK_KEY = "pfc.nickname";

/** 建连成功后的对时采样阵（M2-T7 契约 E）：4 条 sync 探针、间隔 150ms——给 ServerClock 挑
 *  最低 RTT 的原料；pending 严格按发送序入队、到达序一一配对（服务端按受理序回，顺序不换）
 *  ——shift 消化（实现期定案 1：契约「LIFO」按「严格按发送序逐一消化」执行，字面后进先出会
 *  把首答配上末送时刻、RTT 必错——配对语义优先）。 */
const SYNC_SAMPLE_N = 4;
const SYNC_SAMPLE_STEP_MS = 150;
/** 可选保鲜面（M2-T7 契约 E④，实现期定案 3 落实）：每 60s 自动 refresh 一次——长局不掉观测、
 *  幂等重对时；死线时静默 no-op。不做自动重连（那是 T8 的域）。 */
const SYNC_REFRESH_EVERY_MS = 60_000;

export type RoomView = "home" | "join" | "room";
export type JoinMode = "create" | "join";

/** 上一局终局缓存（局间回看，M2-T6）：intermission 首现时从灭源前的态里摘账——
 *  持当前收者视角（服务端 rebase=我恒 pid 0）的结算账+终局态快照（战报尾片+名册）。 */
export interface LastSettlement {
  settlement: SettlementResult;
  /** 终局态（回看 sheet 的名字解析与文字流数据源；下一步开局提要会清空） */
  state: GameState;
}


function loadToken(code: string): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY_PREFIX + code);
  } catch {
    return null;
  }
}

function saveToken(code: string, token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY_PREFIX + code, token);
  } catch {
    /* 隐私模式等存不进就算了：顶多每次重输昵称 */
  }
}

function clearToken(code: string): void {
  try {
    localStorage.removeItem(TOKEN_KEY_PREFIX + code);
  } catch {
    /* 同上 */
  }
}

export function loadNickname(): string {
  try {
    return localStorage.getItem(NICK_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveNickname(name: string): void {
  try {
    localStorage.setItem(NICK_KEY, name);
  } catch {
    /* 同上 */
  }
}

/** 房间 WS 生命周期：open=在房；closed=掉线/被顶（界面出横幅，手动重连或回首页） */
export type WsState = "connecting" | "open" | "closed";

class RoomStore {
  view = ref<RoomView>("home");
  /** 进房页模式（创建=只填昵称；加入=码+昵称）与链接带来的预填码 */
  joinMode = ref<JoinMode>("join");
  pendingCode = ref<string | null>(null);

  code = ref<string | null>(null);
  mySeat = ref<number | null>(null);
  snapshot = ref<RoomSnapshot | null>(null);
  wsState = ref<WsState>("closed");
  /** 进房页的一次性错误（404/409 等，内联展示不 toast） */
  joinError = ref<string | null>(null);
  /** 房间页横幅文案（被顶/掉线），null=无横幅 */
  banner = ref<string | null>(null);
  toast = ref<string | null>(null);
  private toastSeq = 0;

  /** 上一局终局缓存（局间回看：RoomLobby 摘要卡/回看战况 sheet；下一局建源即清） */
  lastSettlement = ref<LastSettlement | null>(null);

  private ws: WebSocket | null = null;
  /** 主动离房标记：离房的 close 是预期行为，不出「连接断开」横幅 */
  private leaving = false;
  /** 联机源句柄（对局面活着时非空）：game 消息 feed 入口；收摊走源 stop→disposeHook 回来摘名 */
  private remoteSource: RemoteRoomSource | null = null;
  /** 服务端权威钟（M2-T7，#44）：生命周期=连接域，比源长——源收摊/重建复用同一只 */
  readonly clock = new ServerClock();
  /** 对时会话缝：采样定时器、pending 发送时刻（到达序配对）、60s 保鲜心跳——stopClockSession 统一收场 */
  private syncTimers: number[] = [];
  private syncPending: number[] = [];
  private syncHeartbeat = 0;

  constructor() {
    // 恢复触发面（M2-T7 契约 E①②）：回前台 visible 沿 + bfcache 恢复（persisted）——幂等重对时
    // +全量快照覆盖本地。绑定一次全生命周期有效；死线时 recover 静默 no-op（自动重连=T8 域）。
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.recoverClockSession();
    });
    window.addEventListener("pageshow", (e) => {
      if (e.persisted) this.recoverClockSession();
    });
  }

  /** 首页 → 进房页（创建=只填昵称；加入=码+昵称）。codeParam=分享链接 ?room= 直跳预填 */
  openJoin(mode: JoinMode, codeParam?: string | null): void {
    this.joinMode.value = mode;
    this.joinError.value = null;
    this.pendingCode.value = codeParam ?? null;
    this.view.value = "join";
  }

  backHome(): void {
    this.disconnect();
    // 房间面退场=对局壳一并收摊（联机源 stop→disposeHook 摘名；单机链不经此路零影响）
    gameStore.dispose();
    this.view.value = "home";
    this.snapshot.value = null;
    this.code.value = null;
    this.mySeat.value = null;
    this.banner.value = null;
    this.joinError.value = null;
    this.lastSettlement.value = null;
  }

  /** 创建房间：创建者即房主即座位 0，token 落本机后连 WS 进房间大厅 */
  async createRoom(name: string): Promise<void> {
    saveNickname(name);
    this.joinError.value = null;
    const resp = await fetch("/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!resp.ok) {
      this.joinError.value = (await errorText(resp)) ?? "创建失败，请重试";
      return;
    }
    const data = (await resp.json()) as { code: string; token: string; seat: number };
    this.enterRoom(data.code, data.token, data.seat);
  }

  /** 输码加入：满 8 拒、房间不存在拒（HTTP 状态直译成中文）。
   *  本机已有此房 token 先试静默归队——旧座位还在就不领新座位（否则旧座位成无人认领的幽灵，
   *  白占容量）；归队失败（token 失效/房间没了）会顺手清 token，落回正常 join。 */
  async joinRoom(code: string, name: string): Promise<void> {
    if (loadToken(code) && (await this.resumeWithToken(code))) return;
    saveNickname(name);
    this.joinError.value = null;
    const resp = await fetch(`/api/rooms/${encodeURIComponent(code)}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!resp.ok) {
      this.joinError.value = (await errorText(resp)) ?? "加入失败，请重试";
      return;
    }
    const data = (await resp.json()) as { token: string; seat: number };
    this.enterRoom(code, data.token, data.seat);
  }

  /**
   * 凭本机 token 静默归队（进房页挂载时调用）：有 token 就直接连 WS，连上即回座位——
   * 刷新/断线免重输的通路。房间没了/token 失效=静默清 token 落回表单（返回 false）。
   */
  async resumeWithToken(code: string): Promise<boolean> {
    const token = loadToken(code);
    if (!token) return false;
    this.joinError.value = null;
    const opened = await this.connect(code, token);
    if (!opened) {
      clearToken(code);
      return false;
    }
    this.code.value = code; // 房码回填（复制链接/重连都靠它）；座位号由首条快照的 you 带回
    markUrlWithRoom(code);
    this.view.value = "room";
    return true;
  }

  /** 手动重连（掉线横幅按钮）：token 还在座位上，重连即归队。重连成功=T7 恢复触发面③：升级
   *  hello 已整段重置对时+burst 已采样，再补一发 refresh 幂等对齐（等价重连 hello 的拉快照）。 */
  async reconnect(): Promise<void> {
    if (!this.code.value) return;
    const token = loadToken(this.code.value);
    if (!token) return;
    this.banner.value = null;
    if (await this.connect(this.code.value, token)) this.recoverClockSession();
  }

  /** 主动离房：座位即刻释放、token 作废（服务端关线确认后回首页）。死线时拒绝假离房——
   *  座位释放必须经服务端；连接没了就先重连（座位还在，凭 token 即归队）再离房 */
  leave(): void {
    this.roomAction({ type: "leave" }, "已离房");
  }

  /** 房主解散：全员请出、房间销毁（死线守卫同 leave） */
  dissolve(): void {
    this.roomAction({ type: "dissolve" }, "房间已解散");
  }

  // ── 大厅动作（M2-T4，#41）：服务端校验房主/phase/配额，被拒收 error 事实走 toast ──

  /** 明选角色（可重复选/换选；可多人同角色） */
  pickRole(roleId: RoleId): void {
    this.roomSend({ type: "pickRole", roleId });
  }

  /** 房主改开局配置（全量上行；非房主被服务端拒） */
  setConfig(config: LobbyConfig): void {
    this.roomSend({ type: "setConfig", config });
  }

  addBot(): void {
    this.roomSend({ type: "addBot" });
  }

  removeBot(): void {
    this.roomSend({ type: "removeBot" });
  }

  /** 房主开始：房间转开局流程（对局主链路 T5/T6 接线） */
  startGame(): void {
    this.roomSend({ type: "start" });
  }

  /** 上行统一守卫：死线（断开/未连）拒绝假动作并提示。返回 false=没发出去 */
  private roomSend(msg: Upstream): boolean {
    if (!this.sendUpstreamGuarded(msg)) {
      this.showToast("连接已断开，请先重连再操作");
      return false;
    }
    return true;
  }

  /** 上行守卫出口（共享给源的上行，M2-T6）：死线即拒返回 false，提示由调方定——房间动作
   *  这里直接 toast；游戏意图走 RemoteRoomSource.send 的抛错路（壳层 apply catch→toast） */
  private sendUpstreamGuarded(msg: Upstream): boolean {
    if (this.wsState.value !== "open" || !this.ws) return false;
    this.sendUpstream(msg);
    return true;
  }

  /** leave/dissolve 共用动作形：死线守卫 → 清本机 token → 上行 → 回首页 → 提示 */
  private roomAction(msg: Upstream, toastText: string): void {
    if (!this.roomSend(msg)) return;
    if (this.code.value) clearToken(this.code.value);
    this.leaving = true;
    this.backHome();
    this.showToast(toastText);
  }

  /** 上行唯一出口：与 shared/protocol.ts 的 Upstream 对型（协议纪律：禁手写消息形状） */
  private sendUpstream(msg: Upstream): void {
    this.ws?.send(JSON.stringify(msg));
  }

  // ── 对时会话（M2-T7，#44）：建连采样阵/60s 保鲜心跳/恢复触发面（全死线安全——不开线即 no-op）──

  /** 建连成功(open)即开一轮对时会话：4×150ms 采样阵 + 60s 保鲜心跳。旧会话先清场（重连竞态
   *  防双跑）；定时回调校验 ws 身份（旧定时器绝不打到新线）。 */
  private startClockSession(ws: WebSocket): void {
    this.stopClockSession();
    for (let i = 0; i < SYNC_SAMPLE_N; i++) {
      this.syncTimers.push(
        window.setTimeout(() => {
          if (this.ws !== ws) return; // 旧会话定时器与新线错开
          this.sendSyncProbe();
        }, i * SYNC_SAMPLE_STEP_MS),
      );
    }
    this.syncHeartbeat = window.setInterval(() => {
      if (this.ws !== ws) return;
      this.recoverClockSession();
    }, SYNC_REFRESH_EVERY_MS);
  }

  /** 会话收场：定时器/心跳全清、pending 废对（跨连接配对绝不串帐） */
  private stopClockSession(): void {
    for (const id of this.syncTimers) window.clearTimeout(id);
    this.syncTimers.length = 0;
    if (this.syncHeartbeat !== 0) {
      window.clearInterval(this.syncHeartbeat);
      this.syncHeartbeat = 0;
    }
    this.syncPending.length = 0;
  }

  /** 恢复触发面共用（visible 沿/pageshow persisted/手动重连成功/60s 心跳）：幂等快照拉取
   *  + 立即再对时采样一次（契约 E 触发时序）；开着的 ws 才发，死线静默（自动重连=T8）。 */
  private recoverClockSession(): void {
    if (this.wsState.value !== "open" || this.ws == null) return;
    this.sendUpstream({ type: "refresh" });
    this.sendSyncProbe();
  }

  /** 单条对时探针：发送时刻先入 pending 队尾，随后上行 sync（应答按队头配对=严格到达序；
   *  单线程事件模型下「先记账后发出」与应答事件不会倒序交错） */
  private sendSyncProbe(): void {
    if (this.wsState.value !== "open" || this.ws == null) return;
    this.syncPending.push(performance.now());
    this.sendUpstream({ type: "sync" });
  }

  copyInvite(): void {
    if (!this.code.value) return;
    const link = `${location.origin}${location.pathname}?room=${this.code.value}`;
    navigator.clipboard
      ?.writeText(link)
      .then(() => this.showToast("邀请链接已复制"))
      .catch(() => this.showToast(link)); // 剪贴板不可用（内嵌环境）：把链接亮出来手动复制
  }

  // ── 内部 ──

  private enterRoom(code: string, token: string, seat: number): void {
    saveToken(code, token);
    this.disconnect();
    this.code.value = code;
    this.mySeat.value = seat;
    this.banner.value = null;
    markUrlWithRoom(code); // 房码写回地址栏：房主/加入者刷新本页即走 ?room= 归队通路
    void this.connect(code, token);
    this.view.value = "room";
  }

  /** 连 WS；返回是否升级成功（HTTP 401/404=token/房间失效） */
  private async connect(code: string, token: string): Promise<boolean> {
    this.disconnect();
    this.leaving = false;
    this.wsState.value = "connecting";
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${scheme}://${location.host}/ws/${encodeURIComponent(code)}?token=${encodeURIComponent(token)}`);
    } catch {
      this.wsState.value = "closed";
      return false;
    }
    this.ws = ws;
    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
      // 401/404 在升级前拒绝：浏览器以 error+close 呈现，onerror 已 resolve(false)
    });
    if (!opened || this.ws !== ws) {
      this.wsState.value = "closed";
      return false;
    }
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.handleDownstream(JSON.parse(String(ev.data)) as Downstream);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return; // 已被新连接取代的旧 socket
      this.ws = null;
      this.wsState.value = "closed";
      this.stopClockSession(); // 对时会话随线收场（心跳/定时器/pending 全清）
      if (this.leaving) return; // 自己发的 leave：backHome 已走，别出横幅
      this.banner.value = "连接已断开";
    };
    this.wsState.value = "open";
    this.startClockSession(ws); // T7：建连成功即开对时会话（采样阵+60s 保鲜心跳）
    return true;
  }

  private disconnect(): void {
    this.stopClockSession(); // 对时会话随线收场（旧 pending 配对与新连接互不串帐）
    const old = this.ws;
    this.ws = null;
    if (old) {
      old.onclose = null; // 摘回调防旧 socket 的 close 误报横幅
      try {
        old.close();
      } catch {
        /* 已关闭 */
      }
    }
  }

  private handleDownstream(msg: Downstream): void {
    switch (msg.type) {
      case "room": {
        const prevPhase = this.snapshot.value?.phase ?? null;
        // 单发对齐回包（you 非空=upgrade hello / refresh 回包 / error 补差包）=幂等恢复点——
        // 整段重置缝（契约 C「重连/refresh 全量快照到达时可整段 reset」），与快照覆盖同拍；
        // 广播 room（you=null）不带我的身份，不吃它（避免被广播时序扰动读数）
        if (msg.you != null) this.clock.resetAnchor(msg.now);
        this.snapshot.value = msg.room;
        if (msg.you != null) this.mySeat.value = msg.you;
        // phase 生命周期钩子（M2-T6）：intermission 首现=收对局壳+结算缓存（App 视图翻回
        // RoomLobby 局间真形）。playing 首现不动作——game 消息（hello）才是建源保险栓，
        // 防「快照先到但对局 hello 未到」造出悬空源。
        if (msg.room.phase === "intermission" && prevPhase !== "intermission") {
          this.enterIntermission();
        }
        break;
      }
      case "syncNow": {
        // 对时应答（M2-T7）：pending 队头配对（到达序=发送序，服务端按受理序回）——喂钟做
        // 最低 RTT 选取；队空（迟到跨会话的应答）静默丢弃。绝不广播：别的连接收不到它。
        const sentAt = this.syncPending.shift();
        if (sentAt != null) this.clock.sample(sentAt, msg.now);
        break;
      }
      case "game": {
        // 对局胖消息（M2-T6）：有源直接 feed（源活着吃新快照=重连 hello 同路）；无源=
        // 开场 hello/Hibernation 重连全量 hello——现场建源上壳后 feed（同一条路）。
        const remote = this.remoteSource ?? this.buildRemoteSource();
        remote.feed(msg);
        break;
      }
      case "replaced":
        // 同 token 新连接顶掉本页（双开防漂移）：本页失效——清 token、回进房页让用户决断。
        // 不留在房间页出「重新连接」：那会反向顶掉最新连接，双开互踢打乒乓；以最新连接为准。
        gameStore.dispose(); // 对局壳一并收摊（M2-T6：被顶后别留死局画面）
        this.disconnect();
        this.wsState.value = "closed";
        if (this.code.value) clearToken(this.code.value);
        this.openJoin("join", this.code.value);
        this.snapshot.value = null;
        this.showToast("房间在其他窗口被打开，本页已让位");
        break;
      case "dissolved":
        if (this.code.value) clearToken(this.code.value);
        this.backHome(); // 内含 gameStore.dispose+lastSettlement 清账
        this.showToast("房主解散了房间");
        break;
      case "error":
        this.showToast(msg.message);
        break;
    }
  }

  // ── 对局源接拆（M2-T6，#43）：建源上壳 / 局间钩子 / roomStore 上行出口挂线 ──

  /**
   * 现场建源并上壳（首条 game 消息=开局 hello 或 Hibernation 重连全量 hello——两条路同进）：
   * 建源→gameStore.bootRemote 挂壳→返回源（caller 随即 feed）。
   * 防御：意外重复进室（双开顶替回环等）先收老源；下一局启动=局间缓存退场；
   * dev=1 挂同款 __pz 快照（单机 bindDevSnapshot 函数化复用，不双挂不复制）。
   */
  private buildRemoteSource(): RemoteRoomSource {
    const dead = this.remoteSource;
    if (dead) {
      dead.stop(); // disposeHook 原地摘名
      this.remoteSource = null;
    }
    this.lastSettlement.value = null;
    let src!: RemoteRoomSource;
    src = new RemoteRoomSource(
      {
        // 状态引用先于事实入壳（#39 不变式，与单机 boot 同形）：源侧 feed 先替 src.state
        // 再调这里，此处先镜像壳层 state、后走 handle 的演出语义
        onFacts: (facts) => {
          if (gameStore.state.value !== src.state) gameStore.state.value = src.state;
          gameStore.handle(facts);
        },
        onStep: () => {
          gameStore.beat.value++;
        },
        onCrash: (err) => {
          console.error("[remote-source]", err);
          this.showToast("对局数据异常——已停止接收，重连可恢复");
        },
      },
      // 源的上行出口=本 store 的死线守卫出口（intent 的死线拼写/对时/turn 全在源侧）
      (msg) => this.sendUpstreamGuarded(msg),
      // disposeHook：源被收摊（gameStore.dispose/stop）时主动摘名——此后 game 消息走重建
      () => {
        this.remoteSource = null;
      },
      this.snapshot.value?.config ?? null,
      // 服务端权威钟（M2-T7）：store 持有的连接域钟——源收摊/重建复用同一只，插值不重筑
      this.clock,
    );
    gameStore.bootRemote(src);
    this.remoteSource = src;
    if (isDevQuery()) bindDevSnapshot();
    return src;
  }

  /** intermission 首现（M2-T6 生命周期钩子）：摘账（先于收摊砌——从灭源前的态里拿结算/尾片）
   *  →收对局壳（App 视图翻回 RoomLobby 局间真形）。 */
  private enterIntermission(): void {
    const s = gameStore.state.value;
    if (s?.endgame?.settlement) {
      // 服务端每条 game 消息已 rebase（我恒 pid 0）——缓存原样可回看
      this.lastSettlement.value = { settlement: s.endgame.settlement, state: s };
    }
    gameStore.dispose(); // 源 stop→disposeHook 摘名；App 对局分支翻回 RoomLobby 局间真形
  }


  showToast(text: string): void {
    this.toast.value = text;
    const seq = ++this.toastSeq;
    window.setTimeout(() => {
      if (seq === this.toastSeq) this.toast.value = null;
    }, 2200);
  }
}

async function errorText(resp: Response): Promise<string | null> {
  try {
    const data = (await resp.json()) as { error?: string };
    return data.error ?? null;
  } catch {
    return null;
  }
}

/** 把 ?room=码 写进当前地址（不产生历史记录）：刷新/转发本链接都能直达归队 */
function markUrlWithRoom(code: string): void {
  try {
    const url = new URL(location.href);
    url.searchParams.set("room", code);
    history.replaceState(null, "", url);
  } catch {
    /* 非常规环境取不到 location 就算了 */
  }
}

/** dev 冒烟命中判据（?dev=1）：链接参数一查即真（?room= 链接可带 &dev=1 同用） */
function isDevQuery(): boolean {
  try {
    return new URLSearchParams(location.search).has("dev");
  } catch {
    return false;
  }
}

/** 联机只读探针（M2-T6 起挂 __pzroom；M2-T7 #44 追加 __pztime，均 ?dev=1）：房间面快照摘要——
 *  code/phase/mySeat/hostSeat/ws 状态/座位列/config + ServerClock 对时读数，联机冒烟的断言口。
 *  （对局内的 __pz 仍是 gameStore 的：bindDevSnapshot 单函数双挂位，见 buildRemoteSource。） */
export function bindRoomProbe(): void {
  if (!isDevQuery()) return;
  (window as unknown as Record<string, unknown>).__pzroom = () => {
    const snap = roomStore.snapshot.value;
    if (!snap) return null;
    return {
      code: snap.code,
      phase: snap.phase,
      mySeat: roomStore.mySeat.value,
      hostSeat: snap.hostSeat,
      ws: roomStore.wsState.value,
      seats: snap.seats.map(
        (s) =>
          `${s.seat}${s.host ? "👑" : ""}${s.bot ? "🤖" : ""} ${s.name}` +
          `${s.bot ? "" : s.online ? "" : "(离线)"}${s.roleId ? ` @${s.roleId}` : ""}`,
      ),
      config: snap.config,
    };
  };
  // 对时探针（M2-T7，#44；?dev=1 挂 window.__pztime）：ServerClock 读数全量亮出——
  // 冒烟判据：serverNow 与本机墙钟解耦（改本机时钟只动 localWallDelta、serverNow 纹丝不动）；
  // samplesN>0=重对时面到齐（重开?room= 归队后必现）；rttBest 为 null=还无样本（fallback 线在跑）。
  (window as unknown as Record<string, unknown>).__pztime = () => {
    const clock = roomStore.clock;
    const serverNow = clock.serverNow();
    return {
      serverNow, // 单调插值读数（epoch ms；任何时刻不倒行、与本机墙钟不可调和的钟漂无关）
      localWallDelta: serverNow - Date.now(), // 读数-本机墙钟差（改本机时钟=它跟着动，其余钉死）
      rttBest: clock.rttBest, // 最低 RTT 样本（ms，null=尚无 sync 样本）
      offset: clock.offset, // 现行 offset（ms，null=尚无 sync 样本）
      samplesN: clock.samples, // 已采 sync 样本数（重对时后 >0）
    };
  };
}

/** 模块级单例（与 gameStore 同风格：class 持 ref，组件经 computed/script 读 .value）；
 *  房间面与对局面各有归属——对局壳生命周期由本 store 钩子驱动（bootRemote/dispose），
 *  对局内事实演出全走 gameStore（壳层零感知房间）。 */
export const roomStore = new RoomStore();

/** 首屏引导：链接带 ?room=CODE 直跳进房页（自动填码） */
export function bootFromUrl(): void {
  const code = new URLSearchParams(location.search).get("room");
  if (code) roomStore.openJoin("join", code.toUpperCase());
}
