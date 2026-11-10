/**
 * 测试记录器的运行时壳（M3 #51）：纯逻辑在 recorder.ts，本文件只做
 * 「缓冲实例 + DOM 生命周期挂钩 + 挂载点」——零 UI（悬浮条在 ui/RecBar.vue）。
 *
 * 挂载纪律：`?rec=1` 才生效；未启用时**零行为差异、零额外全局变量**——
 * 不挂 window 句柄、不监听 pagehide、不碰 localStorage。
 */
import { ref } from "vue";
import type { Downstream } from "../../../shared/protocol";
import {
  buildExport,
  expandGame,
  mergeDedup,
  persist,
  recEnabled,
  restore,
  RingBuffer,
  type RecEntry,
  type RecExport,
} from "./recorder";

/** 记录器上下文（roomStore 每收一条下行时提供） */
export interface RecContext {
  /** 服务端权威钟读数（跨设备对齐的唯一轴） */
  serverNow: number;
  /** 我的座位号 */
  mySeat: number | null;
  /** WS 连接状态（回放断线窗口用） */
  ws: string;
}

class RecLog {
  /** ?rec=1 门控（构造时定死——运行中不改） */
  readonly on: boolean;
  /** 悬浮条显示的条数（响应式；只在启用时有人读） */
  count = ref(0);
  /** 缓冲被丢弃的条数（超出 3000 上限） */
  dropped = ref(0);
  /** 启动时刻（导出元数据） */
  readonly launchedAt = Date.now();
  private buf = new RingBuffer<RecEntry>(3000);
  private room: string | null = null;
  private restoredFor: string | null = null;
  private hookBound = false;
  /** 最近一次已知座位（落盘时导出元数据用；capture 随下行刷新） */
  private lastSeat: number | null = null;
  /** 已记过的战报条目 id（重连全量/刷新后重放同一条不重复记——#51「无重复条目」） */
  private seenMsgIds = new Set<number>();

  constructor() {
    this.on = recEnabled();
  }

  /**
   * 切房：换房先把旧房缓冲落盘、再回捞新房（刷新后战报不丢）。
   * 首次调用时若缓冲里已有记录（没进房就收到的东西），一并搬到新房键下。
   */
  setRoom(code: string | null): void {
    if (!this.on || code === this.room) return;
    if (this.room != null) persist(this.room, this.snapshot());
    this.room = code;
    if (code != null && this.restoredFor !== code) {
      const saved = restore(code);
      if (saved && saved.recs.length > 0) {
        // 落盘→重载：恢复旧账在前，内存里若是空就从它续起；非空则去重合并
        const merged = mergeDedup(saved.recs, this.buf.toArray());
        this.buf = new RingBuffer<RecEntry>(3000);
        for (const r of merged) this.buf.push(r);
        this.count.value = this.buf.length;
        this.rebuildSeen();
      }
      this.restoredFor = code;
    }
    this.bindLifecycle();
  }

  /** 从缓冲里的战报增量记录重建「已记条目 id」集合（重连全量不复记） */
  private rebuildSeen(): void {
    this.seenMsgIds.clear();
    for (const r of this.buf.toArray()) {
      if (r.d !== "state" || !Array.isArray(r.m)) continue;
      for (const m of r.m as Array<{ id?: number }>) {
        if (typeof m.id === "number") this.seenMsgIds.add(m.id);
      }
    }
  }

  /** roomStore 每条下行调一次（未启用时 is a no-op） */
  capture(msg: Downstream, ctx: RecContext): void {
    if (!this.on) return;
    if (ctx.mySeat != null) this.lastSeat = ctx.mySeat;
    const t = Date.now();
    if (msg.type === "game") {
      // 战报条目去重（#51 验收：锁屏/重连全量后「无重复条目」）——只记真正没见过 id 的
      const fresh = (msg.messages ?? []).filter((m) => !this.seenMsgIds.has(m.id));
      for (const m of fresh) this.seenMsgIds.add(m.id);
      const rows = expandGame(
        {
          facts: msg.facts as unknown as Array<Record<string, unknown>>,
          messages: fresh,
          state: msg.state as unknown as Record<string, unknown>,
        },
        { t, sn: ctx.serverNow, mySeat: ctx.mySeat, ws: ctx.ws },
      );
      for (const r of rows) this.push(r);
      return;
    }
    const st = {
      seat: ctx.mySeat,
      ws: ctx.ws,
      ...(msg.type === "room" ? { phase: msg.room.phase } : {}),
    };
    this.push({
      t,
      sn: ctx.serverNow,
      k: msg.type,
      d: "msg",
      ...(msg.type === "error" ? { e: msg.message } : {}),
      st,
    });
  }

  private push(r: RecEntry): void {
    this.buf.push(r);
    this.count.value = this.buf.length;
    this.dropped.value = this.buf.dropped;
  }

  /** 当前缓冲的导出对象 */
  snapshot(): RecExport {
    return buildExport(this.buf.toArray(), {
      ua: safeUA(),
      screen: safeScreen(),
      launchedAt: this.launchedAt,
      room: this.room,
      seat: this.lastSeat,
    });
  }

  /** 手动导出（按钮调）：顺手落一次盘再给对象 */
  exportNow(seat: number | null): RecExport {
    const data = buildExport(this.buf.toArray(), {
      ua: safeUA(),
      screen: safeScreen(),
      launchedAt: this.launchedAt,
      room: this.room,
      seat,
    });
    persist(this.room, data);
    return data;
  }

  /** 导出 JSON 文本（复制/下载共用同一份序列化） */
  exportJSON(seat: number | null): string {
    return JSON.stringify(this.exportNow(seat));
  }

  /** pagehide / visibilitychange(hidden)：落盘防锁屏杀进程 */
  private bindLifecycle(): void {
    if (this.hookBound) return;
    this.hookBound = true;
    const flush = (): void => {
      persist(this.room, this.snapshot());
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
  }
}

function safeUA(): string {
  try {
    return navigator.userAgent;
  } catch {
    return "";
  }
}
function safeScreen(): string {
  try {
    return `${window.screen.width}x${window.screen.height}@${window.devicePixelRatio}`;
  } catch {
    return "";
  }
}

/** 模块级单例（未启用时 on=false，capture 是空转） */
export const recLog = new RecLog();
