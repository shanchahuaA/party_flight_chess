/**
 * 房间连接与视图状态（M2-T3，#40）：进房/大厅双入口的客户端侧——
 * - 视图机：home（单机大厅）/ join（进房页）/ room（房间大厅），App.vue 按此切换三页。
 * - HTTP 面：创建（POST /api/rooms）与加入（POST /api/rooms/:code/join）签发 token；
 *   WS 面：/ws/:code?token= 连上即认座，下行全量快照整体覆盖（胖消息口径）。
 * - token 存 localStorage（pfc.token.<code>），刷新/断线免重输；同 token 新连接顶旧连
 *   （replaced）由服务端裁决，旧页收到通知即失效。
 * - 断线治理（自动重连/转移/踢人）在 T7/T8 落，本票只有手动重连一条缝。
 */
import { ref } from "vue";
import type { Downstream, RoomSnapshot, Upstream } from "../../../shared/protocol";

const TOKEN_KEY_PREFIX = "pfc.token.";
const NICK_KEY = "pfc.nickname";

export type RoomView = "home" | "join" | "room";
export type JoinMode = "create" | "join";

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

  private ws: WebSocket | null = null;
  /** 主动离房标记：离房的 close 是预期行为，不出「连接断开」横幅 */
  private leaving = false;

  /** 首页 → 进房页（创建=只填昵称；加入=码+昵称）。codeParam=分享链接 ?room= 直跳预填 */
  openJoin(mode: JoinMode, codeParam?: string | null): void {
    this.joinMode.value = mode;
    this.joinError.value = null;
    this.pendingCode.value = codeParam ?? null;
    this.view.value = "join";
  }

  backHome(): void {
    this.disconnect();
    this.view.value = "home";
    this.snapshot.value = null;
    this.code.value = null;
    this.mySeat.value = null;
    this.banner.value = null;
    this.joinError.value = null;
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

  /** 手动重连（掉线横幅按钮）：token 还在座位上，重连即归队 */
  async reconnect(): Promise<void> {
    if (!this.code.value) return;
    const token = loadToken(this.code.value);
    if (!token) return;
    this.banner.value = null;
    await this.connect(this.code.value, token);
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

  /** leave/dissolve 共用动作形：死线守卫 → 清本机 token → 上行 → 回首页 → 提示 */
  private roomAction(msg: Upstream, toastText: string): void {
    if (this.wsState.value !== "open" || !this.ws) {
      this.showToast("连接已断开，请先重连再操作");
      return;
    }
    if (this.code.value) clearToken(this.code.value);
    this.leaving = true;
    this.sendUpstream(msg);
    this.backHome();
    this.showToast(toastText);
  }

  /** 上行唯一出口：与 shared/protocol.ts 的 Upstream 对型（协议纪律：禁手写消息形状） */
  private sendUpstream(msg: Upstream): void {
    this.ws?.send(JSON.stringify(msg));
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
      if (this.leaving) return; // 自己发的 leave：backHome 已走，别出横幅
      this.banner.value = "连接已断开";
    };
    this.wsState.value = "open";
    return true;
  }

  private disconnect(): void {
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
      case "room":
        this.snapshot.value = msg.room;
        if (msg.you != null) this.mySeat.value = msg.you;
        break;
      case "replaced":
        // 同 token 新连接顶掉本页（双开防漂移）：本页失效——清 token、回进房页让用户决断。
        // 不留在房间页出「重新连接」：那会反向顶掉最新连接，双开互踢打乒乓；以最新连接为准。
        this.disconnect();
        this.wsState.value = "closed";
        if (this.code.value) clearToken(this.code.value);
        this.openJoin("join", this.code.value);
        this.snapshot.value = null;
        this.showToast("房间在其他窗口被打开，本页已让位");
        break;
      case "dissolved":
        if (this.code.value) clearToken(this.code.value);
        this.backHome();
        this.showToast("房主解散了房间");
        break;
      case "error":
        this.showToast(msg.message);
        break;
    }
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

/** 模块级单例（与 gameStore 同风格：class 持 ref，组件经 computed/script 读 .value）；房间状态与对局状态互不隶属 */
export const roomStore = new RoomStore();

/** 首屏引导：链接带 ?room=CODE 直跳进房页（自动填码） */
export function bootFromUrl(): void {
  const code = new URLSearchParams(location.search).get("room");
  if (code) roomStore.openJoin("join", code.toUpperCase());
}
