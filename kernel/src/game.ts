/**
 * 规则内核（M1）：权威逻辑层，一次意图入 → 新权威状态 + 事实 + 战报 slice。
 * 参照：ADR 0001/0002、一页纸规则 v4、#13 v3 走格手感 stub（原路栈/选路/反弹机制已实玩验证）。
 *
 * 计时语义（世界·即时，单机本地计时）：
 *   输入 now 由壳层（shell 时钟）提供，内核自身不读时钟——全部对时可由 t 系列单测驱动。
 *   #7 定案：全员同窗行动、掷完立刻逐格走、全员完成提前开窗、超时替掷并自动确认（不替打卡）。
 */
import { BOARD, BRANCH_LEN, NET_GOAL, SPAWN_CELLS, STREET_NAMES, cellAt, type BoardCell } from "./board";
import { rngFrom, type Rng, type RngState } from "./rng";
import type { WalkState } from "./types";
import {
  KernelError,
  type Fact,
  type GameConfig,
  type GameState,
  type Intent,
  type MessageEntry,
  type MessageKind,
  type PlayerState,
  type RouteOption,
} from "./types";

/** 步进排拍：正常步子按“当下+步长”排；掉队补拍沿内核旧拍节奏追赶（终点仍落在当前时间轴上） */
function beatAfter(w: WalkState, now: number, stepMs: number): number {
  return (w.nextStepAt <= now ? w.nextStepAt : now) + stepMs;
}

export const GAME_DEFAULTS: Required<Omit<GameConfig, "allowDev">> = {
  seed: 20261016,
  turnCap: 15,
  windowMs: 30_000,
  restMs: 10_000,
  routeAskMs: 10_000,
  stepMs: 140,
};

/** 走格骰面数（1d10） */
const WALK_DIE = 10;

const PLAYER_DEFS: Array<{ name: string; isBot: boolean }> = [
  { name: "你", isBot: false },
  { name: "小黄", isBot: true },
  { name: "小绿", isBot: true },
  { name: "小蓝", isBot: true },
];

export class GameKernel {
  readonly config: GameConfig;
  state: GameState;

  /** 状态镜像挂接：单机壳把权威 state 换成自己的可观察代理（Vue reactive），内核读写不受影响 */
  attachStateProxy(swap: (s: GameState) => GameState): void {
    this.state = swap(this.state);
  }

  private rngHost: RngState;
  private rng: Rng;

  private constructor(config: GameConfig, defs: Array<{ name: string; isBot: boolean }>, now: number) {
    this.config = config;
    if (defs.length > SPAWN_CELLS.length) {
      throw new Error(`出生位不足：最多 ${SPAWN_CELLS.length} 人（T2 起按人数均布）`);
    }
    this.state = {
      turn: 1,
      phase: "acting",
      windowDeadline: now + config.windowMs,
      restUntil: 0,
      players: defs.map((d, i) => ({
        id: i,
        name: d.name,
        isBot: d.isBot,
        colorIndex: i,
        pos: SPAWN_CELLS[i]!,
        from: null,
        trail: [],
        net: 0,
        zone: "main",
        bpos: 0,
        rolled: false,
        confirmed: false,
        stun: 0,
        dead: false,
        spawnCell: SPAWN_CELLS[i]!,
        botSchedule: { rollAt: now, confirmAt: 0 },
        walk: null,
      })),
      finishers: [],
      messages: [],
      seq: 0,
      rngState: config.seed >>> 0,
    };
    this.rngHost = { s: config.seed >>> 0 };
    this.rng = rngFrom(config.seed, this.rngHost);
    this.msg("system", `开局。庄园路网 100 格 · 局长 ${config.turnCap} 世界回合 · 窗 ${Math.round(config.windowMs / 1000)}s`, undefined, { emphasis: "highlight" });
  }

  static create(config: Partial<GameConfig> = {}, now = 0, defs = PLAYER_DEFS): { kernel: GameKernel; facts: Fact[] } {
    if (defs.length < 2) throw new KernelError("至少 2 人开局（1 真人 + 假人由 T2 配置）");
    const kernel = new GameKernel({ ...GAME_DEFAULTS, ...config }, defs, now);
    kernel.openWindow(now);
    kernel.reserveBots(now);
    return { kernel, facts: kernel.drain() };
  }

  // ---------- 事实收集：apply/tick 内产生、调用结束即交出 ----------

  private factsBuf: Fact[] = [];

  private emit(fact: Fact): void {
    this.factsBuf.push(fact);
  }

  private drain(): Fact[] {
    const out = this.factsBuf;
    this.factsBuf = [];
    return out;
  }

  private msg(
    kind: MessageKind,
    text: string,
    who?: number,
    extra: { targets?: number[]; flavor?: string; emphasis?: MessageEntry["emphasis"] } = {},
  ): void {
    this.state.messages.push({
      id: ++this.state.seq,
      turn: this.state.turn,
      kind,
      text,
      who,
      targets: extra.targets,
      flavor: extra.flavor,
      emphasis: extra.emphasis ?? "normal",
    });
  }

  /** 消耗随机源；每次消耗都同步进 state（快照可恢复随机流） */
  private draw(): number {
    const v = this.rng.next();
    this.state.rngState = this.rngHost.s;
    return v;
  }

  private drawDie(): number {
    return Math.floor(this.draw() * WALK_DIE) + 1;
  }

  // ---------- 公开 API ----------

  /** 受理一个意图；拒绝即抛 KernelError（不产生半截状态变更） */
  apply(intent: Intent, now: number): Fact[] {
    switch (intent.type) {
      case "roll": {
        this.doRollChecked(intent.pid, now, "human");
        break;
      }
      case "confirm": {
        const p = this.player(intent.pid);
        this.checkWindowAction(p);
        if (p.confirmed) throw new KernelError("已确认，本窗不能再操作");
        this.doConfirm(p, now, "human");
        break;
      }
      case "chooseRoute": {
        this.doChooseRoute(intent.pid, intent.option, now);
        break;
      }
      case "skipRest": {
        if (this.state.phase !== "rest") throw new KernelError("只有休息期可跳过");
        this.state.restUntil = Math.min(this.state.restUntil, now);
        break;
      }
      case "dev.back": {
        if (!this.config.allowDev) throw new KernelError("dev 意图未开放");
        const p = this.player(intent.pid);
        if (intent.steps <= 0) throw new KernelError("退步数应为正");
        this.queueBack(p, intent.steps, now);
        break;
      }
      case "dev.setPos": {
        if (!this.config.allowDev) throw new KernelError("dev 意图未开放");
        const p = this.player(intent.pid);
        if (intent.pos < 0 || intent.pos >= BOARD.length) throw new KernelError("格 id 越界");
        p.pos = intent.pos;
        p.from = intent.from;
        p.net = intent.net;
        p.trail = [];
        p.walk = null;
        if (p.zone !== "main") {
          p.zone = "main";
          p.bpos = 0;
        }
        break;
      }
    }
    this.resolveAsks(now);
    this.advanceWalks(now);
    this.maybeCloseWindow(now);
    return this.drain();
  }

  /** 时钟推进：窗截止替掷、步进、选路超时、休息到点。now 由壳层时钟提供。 */
  tick(now: number): Fact[] {
    if (this.state.phase === "acting") {
      this.resolveAsks(now);
      this.fireBots(now);
      this.advanceWalks(now);
      this.maybeCloseWindow(now);
      if (now >= this.state.windowDeadline) {
        this.autoFillAndClose(now);
      }
    } else {
      this.resolveAsks(now);
      this.advanceWalks(now);
    }
    if (this.state.phase === "rest" && now >= this.state.restUntil) {
      this.openWindow(now);
    }
    return this.drain();
  }

  // ---------- 世界回合窗 ----------

  /** active = 本窗仍要行动的玩家（通关席/出局者不占窗） */
  private activePlayers(): PlayerState[] {
    return this.state.players.filter((p) => !p.dead && p.zone !== "done");
  }

  private checkWindowAction(p: PlayerState): void {
    if (this.state.phase !== "acting") throw new KernelError("窗已收口，需等下一窗");
    if (p.dead || p.zone === "done") throw new KernelError("通关席/出局者不再行动");
  }

  /** 机器人日程：开局错峰掷骰 + 走完一小拍后自动确认（#12/#26：不拖戏也不抢跑） */
  private reserveBots(now: number): void {
    for (const p of this.state.players) {
      if (!p.isBot || p.dead || p.zone === "done") continue;
      p.botSchedule.rollAt = now + 400 + p.id * 350 + Math.floor(this.draw() * 700);
      p.botSchedule.confirmAt = Number.POSITIVE_INFINITY;
    }
  }

  private openWindow(now: number): void {
    this.state.phase = "acting";
    this.state.windowDeadline = now + this.config.windowMs;
    for (const p of this.state.players) {
      if (p.dead || p.zone === "done") continue;
      p.rolled = false;
      p.confirmed = false;
      p.botSchedule = { rollAt: now, confirmAt: 0 };
    }
    this.emit({ type: "windowStart", turn: this.state.turn, deadline: this.state.windowDeadline });
    this.reserveBots(now);
  }

  private fireBots(now: number): void {
    for (const p of this.state.players) {
      if (!p.isBot || p.dead || p.zone === "done") continue;
      if (!p.rolled && now >= p.botSchedule.rollAt) {
        this.doRollChecked(p.id, now, "bot");
      }
      if (p.rolled && !p.confirmed && !p.walk && now >= p.botSchedule.confirmAt) {
        this.doConfirm(p, now, "bot");
      }
    }
  }

  /** 超窗收口：替未掷者掷骰（walk 占用中者本轮顺延，绝不让替掷抛错）、替未确认者确认（不替打卡）；然后开下一窗 */
  private autoFillAndClose(now: number): void {
    for (const p of this.activePlayers()) {
      if (!p.rolled && !p.walk) {
        this.doRoll(p.id, now, "replacement"); // 替掷（walk 仍占用者本窗顺延，下一窗自然补掷）
      }
    }
    for (const p of this.activePlayers()) {
      if (!p.confirmed) {
        this.doConfirm(p, now, "replacement"); // 替确认（确认不卡动画——走格照样走完）
      }
    }
    this.closeWindow(now, true);
  }

  private maybeCloseWindow(now: number): void {
    if (this.state.phase !== "acting") return;
    const act = this.activePlayers();
    if (act.length > 0 && act.every((p) => p.confirmed)) {
      this.closeWindow(now, false);
    }
  }

  private closeWindow(now: number, auto: boolean): void {
    this.emit({ type: "windowEnd", turn: this.state.turn, auto });
    this.state.turn += 1;
    if (this.state.turn > this.config.turnCap) {
      this.state.phase = "over";
      this.msg("system", `局长 ${this.config.turnCap} 世界回合打满——终局流程（最后一波/结算，T8 起接入）。`, undefined, { emphasis: "big" });
      this.emit({ type: "gameEnd" });
      return;
    }
    if (this.config.restMs <= 0) {
      this.openWindow(now);
      return;
    }
    this.state.phase = "rest";
    this.state.restUntil = now + this.config.restMs;
    this.emit({ type: "restStart", turn: this.state.turn - 1, until: this.state.restUntil });
  }

  // ---------- 掷骰 / 确认 ----------

  private checkRoll(pid: number): void {
    const p = this.player(pid);
    if (p.rolled) throw new KernelError("本窗已掷过骰");
    if (p.walk) throw new KernelError("走格未完成，不能掷");
    this.checkWindowAction(p);
  }

  /** 掷骰前校验＋掷（真人 UI 与机器人日程共用；replacement=超窗替掷播报专用） */
  private doRollChecked(
    pid: number,
    now: number,
    mode: "human" | "bot" | "replacement",
  ): void {
    this.checkRoll(pid);
    this.doRoll(pid, now, mode);
  }

  private doRoll(pid: number, now: number, mode: "human" | "bot" | "replacement"): void {
    const p = this.player(pid);
    p.rolled = true;
    const d = this.drawDie();
    p.walk = { remaining: d, nextStepAt: now + this.config.stepMs, ask: null, pendingTo: null, bounced: false };
    this.emit({ type: "roll", pid, d, auto: mode !== "human" });
    if (mode === "replacement") {
      this.msg("system", `系统替 ${p.name} 掷骰：${d} 点`, pid, { emphasis: "highlight" });
    }
  }

  private doConfirm(
    p: PlayerState,
    now: number,
    mode: "human" | "bot" | "replacement",
  ): void {
    p.confirmed = true;
    this.emit({ type: "confirm", pid: p.id, auto: mode !== "human" });
    if (mode === "replacement") {
      this.msg("system", `系统替 ${p.name} 自动确认`, p.id);
    }
  }

  // ---------- 图上游走 ----------

  private player(pid: number): PlayerState {
    const p = this.state.players[pid];
    if (!p) throw new KernelError(`玩家 ${pid} 不存在`);
    return p;
  }

  private cell(id: number): BoardCell {
    const c = BOARD[id];
    if (!c) throw new KernelError(`格 ${id} 不存在`);
    return c;
  }

  /** 前向可选路：排除来向；无可选（死角）时开全相邻兜底 */
  private forwardOptions(p: PlayerState): number[] {
    const cell = this.cell(p.pos);
    let opts = cell.links.filter((l) => l !== p.from);
    if (opts.length === 0) opts = cell.links.slice();
    return opts;
  }

  /** 直行候选：延长来向向量，若存在则给同一个 */
  private straightId(cellId: number, fromId: number | null): number | null {
    if (fromId == null) return null;
    const cur = this.cell(cellId);
    const pv = this.cell(fromId);
    const cand = cellAt(cur.col * 2 - pv.col, cur.row * 2 - pv.row);
    return cand && cur.links.includes(cand.id) ? cand.id : null;
  }

  private routeOptionList(p: PlayerState, ids: number[]): RouteOption[] {
    const here = this.cell(p.pos);
    return ids.map((to) => {
      const t = this.cell(to);
      const arrow = t.col > here.col ? "→" : t.col < here.col ? "←" : t.row > here.row ? "↓" : "↑";
      return { to, street: t.street, label: `${arrow} ${STREET_NAMES[t.street]}` };
    });
  }

  private advanceWalks(now: number): void {
    for (const p of this.state.players) {
      if (p.dead) continue;
      let guard = 64; // 单 tick 深度上限，防止意外不自终
      while (p.walk && p.walk.nextStepAt <= now && p.walk.ask === null && p.zone !== "done" && guard-- > 0) {
        this.stepOnce(p, now);
      }
      if (guard <= 0) throw new KernelError("walk 步进失控（invariant 兜底）");
    }
  }

  private stepOnce(p: PlayerState, now: number): void {
    const w = p.walk;
    if (!w || w.ask) return;
    if (w.pendingTo != null) {
      const to = w.pendingTo;
      w.pendingTo = null;
      this.stepMain(p, to, now);
      return;
    }
    if (w.remaining > 0) {
      if (p.zone === "main") {
        const opts = this.forwardOptions(p);
        if (opts.length === 0) {
          this.burnWalkEnd(p); // 理论死角（当前拓扑无），兜底不推进
          return;
        }
        if (opts.length === 1) {
          this.stepMain(p, opts[0]!, now);
        } else if (p.isBot) {
          this.stepMain(p, this.botPickAtJunction(p, opts), now);
        } else {
          // 真实多条路（环岛 / 零向开局）：停步弹选路条，deadline 由 tick 兜底
          w.ask = { options: this.routeOptionList(p, opts), deadline: now + this.config.routeAskMs };
          this.emit({ type: "routeAskOpen", pid: p.id, options: w.ask.options, deadline: w.ask.deadline });
          w.nextStepAt = now; // 选路期间不再步进
        }
      } else {
        this.stepBranchForward(p, now);
      }
    } else if (w.remaining < 0) {
      if (p.zone === "main") {
        if (p.trail.length > 0) {
          const back = p.trail.pop()!;
          this.stepMainBack(p, back, now);
        } else if (p.from != null) {
          // 栈空兜底：沿来向倒一步（压正来向，可继续逆行）
          const came = p.from;
          p.from = p.pos;
          this.stepMainBack(p, came, now);
        } else {
          this.burnWalkEnd(p);
        }
      } else {
        this.stepBranchBack(p, now);
      }
    } else {
      this.burnWalkEnd(p);
    }
  }

  private botPickAtJunction(p: PlayerState, opts: number[]): number {
    const straight = this.straightId(p.pos, p.from);
    const pick = straight !== null && opts.includes(straight) && this.draw() < 0.6 ? straight : this.rng.pick(opts);
    this.state.rngState = this.rngHost.s;
    return pick;
  }

  /** 主网前进一步 */
  private stepMain(p: PlayerState, to: number, now: number): void {
    const w = p.walk!;
    p.trail.push(p.pos); // 来路栈：退格沿这条链原路走回头
    const from = p.pos;
    p.from = from;
    p.pos = to;
    p.net += 1;
    this.emit({ type: "step", pid: p.id, from, to, dir: 1 });
    if (p.pos === p.spawnCell && p.net >= NET_GOAL) {
      // 前向踩上出生格 & 净步约一圈 → 进终点支路（stub 实玩机制）
      p.zone = "branch";
      p.bpos = 0;
      this.emit({ type: "branchEnter", pid: p.id });
      this.msg("system", `${p.name} 绕得够远回到自家门前——进终点支路！`, p.id, {
        flavor: "尽头刚好踩进=通关席；超出反弹。",
        emphasis: "highlight",
      });
    }
    w.remaining -= 1;
    if (w.remaining === 0) this.endWalk(p, now);
    else w.nextStepAt = beatAfter(w, now, this.config.stepMs);
  }

  /** 主网退格一步（沿来路栈原路返回；穿环岛不重弹选路条） */
  private stepMainBack(p: PlayerState, to: number, now: number): void {
    const w = p.walk!;
    const from = p.pos;
    p.pos = to;
    p.net -= 1;
    this.emit({ type: "step", pid: p.id, from, to: to, dir: -1 });
    w.remaining += 1; // 负值向 0 收
    if (w.remaining === 0) this.endWalk(p, now);
    else w.nextStepAt = beatAfter(w, now, this.config.stepMs);
  }

  /** 终点支路前进一格；尽头是墙：剩余步 >1 时反弹折返，==1 刚好踩进=通关席 */
  private stepBranchForward(p: PlayerState, now: number): void {
    const w = p.walk!;
    p.bpos += 1;
    if (p.bpos >= BRANCH_LEN) {
      if (w.remaining > 1) {
        w.remaining = -(w.remaining - 1); // 折返：反弹消耗一格
        w.bounced = true;
        w.nextStepAt = beatAfter(w, now, this.config.stepMs);
        this.emit({ type: "bounce", pid: p.id });
      } else {
        this.finishAtSeat(p, now);
      }
      return;
    }
    w.remaining -= 1;
    this.emit({ type: "stepBranch", pid: p.id, bpos: p.bpos, dir: 1 });
    if (w.remaining === 0) this.endWalk(p, now);
    else w.nextStepAt = beatAfter(w, now, this.config.stepMs);
  }

  /** 支路逆行：退格效果直达源头，或反弹折返或穿过出口（bpos=0）回主干 */
  private stepBranchBack(p: PlayerState, now: number): void {
    const w = p.walk!;
    if (p.bpos > 0) {
      p.bpos -= 1;
      p.net -= 1;
      this.emit({ type: "stepBranch", pid: p.id, bpos: p.bpos, dir: -1 });
    } else {
      // 回到支路门口：从自家园里退回主干，沿来路栈继续逆行
      p.zone = "main";
      if (w.bounced) {
        w.bounced = false;
        w.remaining = -w.remaining; // 剩余步翻正：继续前进离开家门口
        this.emit({ type: "bounceExit", pid: p.id });
        if (w.remaining > 0) {
          w.nextStepAt = beatAfter(w, now, this.config.stepMs);
          return;
        }
      }
    }
    w.remaining += 1; // 逆行一步消一
    if (w.remaining === 0) this.endWalk(p, now);
    else w.nextStepAt = beatAfter(w, now, this.config.stepMs);
  }

  private finishAtSeat(p: PlayerState, now: number): void {
    p.zone = "done";
    p.walk = null;
    p.confirmed = true; // 通关席不占确认
    this.state.finishers.push(p.id);
    const rank = this.state.finishers.length;
    this.msg("system", `${p.name} 🏁 刚好踩进终点——通关席！`, p.id, {
      flavor: `为第 ${rank} 位通关席：不再掷骰、仍可打卡（T4 起）、必须过最后一波（T8 起）。`,
      emphasis: "big",
    });
    this.emit({ type: "finish", pid: p.id });
    this.emit({ type: "pulse", pid: p.id, level: "big" });
    void now;
  }

  private endWalk(p: PlayerState, now: number): void {
    const w = p.walk;
    p.walk = null;
    if (w && w.bounced && p.zone === "branch" && p.bpos > 0) {
      this.msg("system", `${p.name} 撞旗反弹，停在支路第 ${p.bpos} 格`, p.id, { flavor: "尽头差一点就踩进。" });
    }
    if (p.isBot && !p.dead && p.zone !== "done") {
      // 假人：走完一小拍后自动确认（到点由 fireBots 消费）
      p.botSchedule.confirmAt = now + 500 + Math.floor(this.draw() * 400);
    }
  }

  /** 无处可走/步数为零的清理（拓扑死角兜底） */
  private burnWalkEnd(p: PlayerState): void {
    p.walk = null;
  }

  private queueBack(p: PlayerState, steps: number, now: number): void {
    p.walk = { remaining: -steps, nextStepAt: now + this.config.stepMs, ask: null, pendingTo: null, bounced: false };
  }

  // ---------- 环岛选路 ----------

  private doChooseRoute(pid: number, option: number, now: number): void {
    const p = this.player(pid);
    const w = p.walk;
    if (!w || !w.ask) throw new KernelError("当前没有待选的岔路");
    const opt = w.ask.options[option];
    if (!opt) throw new KernelError("选路下标越界");
    w.ask = null;
    w.pendingTo = opt.to;
    w.nextStepAt = now;
    this.emit({ type: "routeChosen", pid, to: opt.to, auto: false });
  }

  /** 选路超时兜底：优先直行，无直行取第一项 */
  private resolveAsks(now: number): void {
    for (const p of this.state.players) {
      const w = p.walk;
      if (!w || !w.ask) continue;
      if (now < w.ask.deadline) continue;
      const opts = w.ask.options;
      const straight = this.straightId(p.pos, p.from);
      const to = straight != null && opts.some((o) => o.to === straight) ? straight : opts[0]!.to;
      w.ask = null;
      w.pendingTo = to;
      w.nextStepAt = now;
      this.emit({ type: "routeChosen", pid: p.id, to, auto: true });
      this.msg("system", `${p.name} 岔口超时，自动直行`, p.id, { emphasis: "normal" });
    }
  }
}
