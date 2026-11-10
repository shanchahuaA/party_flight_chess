/**
 * 测试记录器（M3 #51）：**只读**下行消息日志，`?rec=1` 门控。真机测试当天用。
 *
 * 三条硬纪律：
 * - **零定时器**：只在「下行消息到达」那一刻落一条。`Fact`/`MessageEntry` 都没有时间戳字段，
 *   「几点」只能由记录器在到达时刻读。心跳型定时采样收益不抵成本（卡死判定靠两台日志交叉比对：
 *   本台空窗 + 另一台照常推进 = 客户端问题；两台都空 = 服务端停摆）。
 * - **只读**：绝不改 gameStore / roomStore 状态、不发任何上行意图。
 * - **不联网**：不开服务端端点、不碰 WS 协议；导出走本地下载/剪贴板。
 *
 * 本文件是无 UI 纯逻辑（环形缓冲/序列化/localStorage 落盘），Node 环境直测；DOM 挂钩在 recLog.ts。
 */

/** 单条记录（字段名短——手机端 localStorage 配额紧） */
export interface RecEntry {
  /** 本机墙钟 Date.now()（ms） */
  t: number;
  /** serverNow（读 roomStore.clock）——**跨设备对齐只能靠它**，两台手机墙钟可能差几十秒 */
  sn: number;
  /** 消息种类：game / room / syncNow / error / kicked / dissolved / replaced */
  k: string;
  /** 记录类型细分：game 消息里 facts 逐条展开记 `fact`，其余记 `msg` */
  d?: "msg" | "fact" | "state";
  /** fact 的 type */
  f?: string;
  /** fact 全字段（去掉 type/f，其余原样） */
  v?: unknown;
  /** 战报增量条目（game 消息带的本批新条目） */
  m?: unknown;
  /** error 消息原文 */
  e?: string;
  /** 心跳型快照：turn / phase / mySeat / 我的 hp / 手牌数 / ws 状态 */
  st?: {
    turn?: number;
    phase?: string;
    seat?: number | null;
    hp?: number;
    hand?: number;
    ws?: string;
  };
}

/** 导出文件顶层形状（v=1 版本号；将来加字段靠它分流） */
export interface RecExport {
  v: 1;
  ua: string;
  screen: string;
  launchedAt: number;
  room: string | null;
  seat: number | null;
  recs: RecEntry[];
}

/** 环形缓冲上限（超出丢最旧——手机长局消息量大，3000 条 ≈ 一次真机局的上限） */
export const REC_CAP = 3000;

/**
 * 环形缓冲：定长、超出丢最旧。刻意不用 shift()（O(n)）——用「起始下标 + 覆盖写」。
 * 导出时按时间序铺平成普通数组。
 */
export class RingBuffer<T> {
  private buf: Array<T | undefined>;
  private head = 0; // 最旧元素下标
  private size = 0;
  /** 累计被丢弃的条数（导出时报告「日志不完整」用） */
  dropped = 0;

  constructor(readonly cap: number = REC_CAP) {
    this.buf = new Array<T | undefined>(cap);
  }

  get length(): number {
    return this.size;
  }

  push(item: T): void {
    if (this.size < this.cap) {
      this.buf[(this.head + this.size) % this.cap] = item;
      this.size += 1;
      return;
    }
    // 满了：覆盖最旧
    this.buf[this.head] = item;
    this.head = (this.head + 1) % this.cap;
    this.dropped += 1;
  }

  /** 时间序（最旧→最新）铺平 */
  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.size; i++) {
      const v = this.buf[(this.head + i) % this.cap];
      if (v !== undefined) out.push(v);
    }
    return out;
  }

  clear(): void {
    this.buf = new Array<T | undefined>(this.cap);
    this.head = 0;
    this.size = 0;
  }
}

/** localStorage 键（沿用 pfc. 前缀风格）：按房号分桶，防两台/两房串账 */
export function storageKey(room: string | null): string {
  return `pfc.rec.${room ?? "solo"}`;
}

/**
 * 落盘（pagehide / visibilitychange(hidden) 时调）：把缓冲整体写进 localStorage。
 * 隐私模式/配额满一律静默降级——不许崩。
 * 返回是否写成功（调用方只用于调试读数，不改变行为）。
 */
export function persist(room: string | null, data: RecExport): boolean {
  try {
    localStorage.setItem(storageKey(room), JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

/**
 * 回捞（页面加载时调）：把上次落盘的记录读回来「续上」而不是重开一份。
 * 键损坏/不可读=返回 null（降级为从零开始，不崩）。
 */
export function restore(room: string | null): RecExport | null {
  try {
    const raw = localStorage.getItem(storageKey(room));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RecExport;
    if (parsed?.v !== 1 || !Array.isArray(parsed.recs)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 去重合并：落盘→重载时，同一批记录可能既在 localStorage 里、又被重新收一遍。
 * 判据=「t + k + d + f + e」复合键（同一毫秒内同类同事实视为同一条）——
 * 不用对象引用/JSON 全串（序列化字段序不稳，且战报条目体积大）。
 */
export function mergeDedup(base: RecEntry[], add: RecEntry[]): RecEntry[] {
  const seen = new Set<string>();
  const key = (r: RecEntry): string =>
    `${r.t}|${r.sn}|${r.k}|${r.d ?? ""}|${r.f ?? ""}|${r.e ?? ""}`;
  const out: RecEntry[] = [];
  for (const r of base) {
    const k = key(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  for (const r of add) {
    const k = key(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/**
 * 从一条 game 胖消息里拆出记录（facts 逐条展开 + 战报增量 + 心跳快照）。
 * 纯函数：不读 store，一切从载荷里取（调用方补 t/sn）。
 */
export function expandGame(
  msg: {
    facts?: Array<Record<string, unknown>>;
    messages?: unknown[];
    state?: Record<string, unknown> | null;
  },
  base: { t: number; sn: number; mySeat: number | null; ws: string },
): RecEntry[] {
  const out: RecEntry[] = [];
  const state = msg.state ?? null;
  const me = state ? ((state.players as Array<Record<string, unknown>> | undefined)?.[0] ?? null) : null;
  const st = state
    ? {
        turn: state.turn as number | undefined,
        phase: state.phase as string | undefined,
        seat: base.mySeat,
        hp: me?.hp as number | undefined,
        hand: Array.isArray(me?.hand) ? (me!.hand as unknown[]).length : undefined,
        ws: base.ws,
      }
    : undefined;
  // 每条 fact 单独一条记录（分析时按 f 过滤最常用）
  for (const f of msg.facts ?? []) {
    const { type, ...rest } = f;
    out.push({ t: base.t, sn: base.sn, k: "game", d: "fact", f: String(type), v: rest });
  }
  // 战报增量：整批挂一条（不逐条拆——条目本身是完整对象，拆了反而丢上下文）
  if (msg.messages && msg.messages.length > 0) {
    out.push({ t: base.t, sn: base.sn, k: "game", d: "state", m: msg.messages, ...(st ? { st } : {}) });
  } else if (st) {
    // 没战报也要留心跳快照（判断「这台还在收消息」）
    out.push({ t: base.t, sn: base.sn, k: "game", d: "state", st });
  }
  return out;
}

/** 是否启用记录器（?rec=1；与 ?dev=1 可共存、互不依赖） */
export function recEnabled(search?: string): boolean {
  try {
    const q = search ?? location.search;
    return new URLSearchParams(q).has("rec");
  } catch {
    return false;
  }
}

/** 组装导出对象 */
export function buildExport(
  recs: RecEntry[],
  meta: { ua: string; screen: string; launchedAt: number; room: string | null; seat: number | null },
): RecExport {
  return { v: 1, ua: meta.ua, screen: meta.screen, launchedAt: meta.launchedAt, room: meta.room, seat: meta.seat, recs };
}
