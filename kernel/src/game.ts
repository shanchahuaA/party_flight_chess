/**
 * 规则内核（M1）：权威逻辑层，一次意图入 → 新权威状态 + 事实 + 战报 slice。
 * 参照：ADR 0001/0002、一页纸规则 v4、#13 v3 走格手感 stub（原路栈/选路/反弹机制已实玩验证）。
 *
 * 计时语义（世界·即时，单机本地计时）：
 *   输入 now 由壳层（shell 时钟）提供，内核自身不读时钟——全部对时可由 t 系列单测驱动。
 *   #7 定案：全员同窗行动、掷完立刻逐格走、全员完成提前开窗、超时替掷并自动确认（不替打卡）。
 */
import { BOARD, BRANCH_LEN, ECO_NAMES, NET_GOAL, SPAWN_SLOTS, STREET_NAMES, cellAt, spawnMenu, type BoardCell } from "./board";
import { M1_EVENT_POOL, EVENT_CARD_BY_ID, type CardEffect, type CheckSpec, type EffectPart, type EventCard } from "./data/events";
import { AXIS_NAMES, ROLES, roleDef } from "./data/roles";
import { SECRET_GOALS } from "./data/goals";
import { CHECK_FACES, netMods, resolveCheck, roleCheckMods, roleOneToCrit, rollD20, type CheckGrade, type CheckMods } from "./check";
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
  type PlayerDef,
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
  maxHp: 10,
  windowMs: 30_000,
  restMs: 10_000,
  timerMode: "world",
  routeAskMs: 10_000,
  stepMs: 140,
};

/** 配置五项的合法域（#16 问题陈述 2：局长 5–30／血量 5–20／窗 10–90s／休息 0–20s）。
 *  壳层表单（大厅滑条）直接消费这份常量，域改一处即全端生效。 */
export const CONFIG_LIMITS = {
  turnCap: [5, 30],
  maxHp: [5, 20],
  windowMs: [10_000, 90_000],
  restMs: [0, 20_000],
} as const;

const PLAYER_DEFS: PlayerDef[] = [
  { name: "你", isBot: false },
  { name: "小黄", isBot: true },
  { name: "小绿", isBot: true },
  { name: "小蓝", isBot: true },
];

/** 走格骰面数（1d10） */
const WALK_DIE = 10;

/** 单名玩家单窗抽卡上限（卡面引走格→落格重触发抽卡的连环熔断） */
const EVENT_CHAIN_CAP = 4;

/** 卡面/指认造成续走占用时，假人掷骰日程的重试间隔（避让而非放弃） */
const BOT_WALK_RETRY_MS = 700;

export class GameKernel {
  readonly config: GameConfig;
  state: GameState;

  /** 状态镜像挂接：单机壳把权威 state 换成自己的可观察代理（Vue reactive），内核读写不受影响 */
  attachStateProxy(swap: (s: GameState) => GameState): void {
    this.state = swap(this.state);
  }

  private rngHost: RngState;
  private rng: Rng;

  private constructor(config: GameConfig, defs: PlayerDef[], now: number) {
    // 随机源先立：假人角色分派与暗牌抽取都消耗它（顺序固定=同种子全序流）
    this.config = config;
    this.rngHost = { s: config.seed >>> 0 };
    this.rng = rngFrom(config.seed, this.rngHost);
    // 人数域与落座菜单都在 create（2..8 校验+spawnMenu 档位）先行拦截，此处不再重复
    const menu = spawnMenu(defs.length);
    /** 暗牌逐人独立抽（10 条池内抽 2 且必不相同；不同玩家之间可同条——不互斥） */
    const draftPair = (): [number, number] => {
      const a = SECRET_GOALS[this.rng.int(SECRET_GOALS.length)]!.no;
      let b = SECRET_GOALS[this.rng.int(SECRET_GOALS.length)]!.no;
      while (b === a) b = SECRET_GOALS[this.rng.int(SECRET_GOALS.length)]!.no;
      return [a, b];
    };
    this.state = {
      turn: 1,
      // 开局暗牌抽 2 选 1 挂起（drafting）：真人选定后 openWindow 开第一窗
      phase: "drafting",
      windowDeadline: 0,
      restUntil: 0,
      players: defs.map((d, i) => {
        const rd = roleDef(d.roleId ?? (d.isBot ? ROLES[this.rng.int(ROLES.length)]!.id : "light"));
        return {
          id: i,
          name: d.name,
          isBot: d.isBot,
          colorIndex: i,
          roleId: rd.id,
          axes: { ...rd.axes },
          hp: config.maxHp,
          shields: rd.flags.firstBloodShield ? 1 : 0,
          pos: SPAWN_SLOTS[menu[i]!]!.cell,
          from: null,
          trail: [],
          net: 0,
          zone: "main",
          bpos: 0,
          rolled: false,
          confirmed: false,
          stun: 0,
          dead: false,
          spawnCell: SPAWN_SLOTS[menu[i]!]!.cell,
          secretOptions: draftPair(),
          secretPick: d.isBot ? this.rng.int(2) : null,
          botSchedule: { rollAt: now, confirmAt: 0 },
          walk: null,
          walkQueue: [],
          cardPending: null,
          cardDraws: 0,
        };
      }),
      finishers: [],
      messages: [],
      // 事件牌堆：单池洗匀（表二 20 张；'window' 卡 T7 放行——事件定案 §1.8 抽完即洗回弃牌堆）
      deck: this.rng.shuffle(M1_EVENT_POOL.map((c) => c.id)),
      discard: [],
      deferred: [],
      seq: 0,
      rngState: this.rngHost.s,
    };
    const bots = this.state.players.filter((p) => p.isBot);
    this.msg(
      "system",
      `开局。庄园路网 100 格 · ${defs.length} 人局 · 局长 ${config.turnCap} 世界回合 · 窗 ${Math.round(config.windowMs / 1000)}s · 休息 ${Math.round(config.restMs / 1000)}s · 血量上限 ${config.maxHp}`,
      undefined,
      { emphasis: "highlight" },
    );
    this.msg("system", "开局抽暗牌目标：每人抽 2 选 1，对局内保密。", undefined, { emphasis: "normal" });
    if (bots.length > 0) {
      this.msg("system", "假人目标由系统代抽落定。", undefined, { emphasis: "normal" });
    }
    this.state.rngState = this.rngHost.s;
  }

  static create(
    config: Partial<GameConfig> = {},
    now = 0,
    defs: PlayerDef[] = PLAYER_DEFS,
  ): { kernel: GameKernel; facts: Fact[] } {
    if (defs.length < 2) throw new KernelError("至少 2 人开局（1 真人 + 假人）");
    if (defs.length > 8) throw new KernelError("开局最多 8 人（1 真人 + 7 假人）");
    // 配置五项域校验（#16 问题陈述 2）：玩家配置出界即拒——壳层先验，内核兜底。
    // dev 测试通道（allowDev）放行短窗/短局等模拟参数。
    const merged = { ...GAME_DEFAULTS, ...config };
    if (!merged.allowDev) {
      for (const [key, [lo, hi]] of Object.entries(CONFIG_LIMITS)) {
        const v = merged[key as keyof typeof CONFIG_LIMITS] as number;
        if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) {
          throw new KernelError(`配置 ${key}=${v} 超出 ${lo}..${hi}`);
        }
      }
    }
    if (merged.timerMode !== "world" && merged.timerMode !== "turn") {
      throw new KernelError("计时模式未知（world=世界·即时 / turn=轮班·限时）");
    }
    // 冻结：配置开局定死、局中不可改（局间配置=下一局新 kernel）
    const kernel = new GameKernel(Object.freeze(merged) as GameConfig, defs, now);
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

  /** 批量消耗后的一次性同步（走 rollD20/shuffle 等直接吃 rng 的路径用） */
  private syncRng(): void {
    this.state.rngState = this.rngHost.s;
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
        if (!p.rolled) throw new KernelError("先掷骰，再确认结束");
        if (p.cardPending) throw new KernelError("事件卡抉择未应答（本人先选，或等超时代选）");
        this.doConfirm(p, now, "human");
        break;
      }
      case "chooseCard": {
        // 事件卡抉择应答：仅触发者本人可应答自己名下的挂起卡（一人一卡互不干扰）
        const p = this.player(intent.pid);
        if (this.state.phase !== "acting" && this.state.phase !== "rest") {
          throw new KernelError("当前阶段无法应答事件卡");
        }
        if (!p.cardPending) throw new KernelError("没有待抉择的事件卡");
        const card = this.eventCard(p.cardPending.cardId);
        if (intent.option < 0 || intent.option >= (card.options?.length ?? 0)) {
          throw new KernelError("卡面选项下标越界");
        }
        this.resolveChoice(p, p.cardPending.cardId, intent.option, now, false);
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
      case "chooseSecret": {
        // 开局暗牌抽 2 选 1：真人本人选（drafting 期唯一前置动作），假人已在 create 代抽
        if (this.state.phase !== "drafting") throw new KernelError("非开局抽牌阶段");
        const p = this.player(intent.pid);
        if (p.isBot) throw new KernelError("假人目标由系统代抽，无需选择");
        if (p.secretPick != null) throw new KernelError("已选定暗牌目标");
        if (intent.pick !== 0 && intent.pick !== 1) throw new KernelError("暗牌选项下标越界");
        p.secretPick = intent.pick;
        this.emit({ type: "secretPicked", pid: p.id });
        this.msg("system", `${p.name} 选定暗牌目标——第一窗开张！`, p.id, { emphasis: "highlight" });
        this.openWindow(now);
        break;
      }
      case "dev.back": {
        if (!this.config.allowDev) throw new KernelError("dev 意图未开放");
        const p = this.player(intent.pid);
        if (intent.steps <= 0) throw new KernelError("退步数应为正");
        this.queueBack(p, intent.steps, now);
        break;
      }
      case "dev.setHp": {
        if (!this.config.allowDev) throw new KernelError("dev 意图未开放");
        const p = this.player(intent.pid);
        if (intent.hp < 0 || intent.hp > this.config.maxHp) throw new KernelError("hp 越界");
        p.hp = intent.hp;
        break;
      }
      case "dev.setDead": {
        if (!this.config.allowDev) throw new KernelError("dev 意图未开放");
        const p = this.player(intent.pid);
        p.dead = true;
        p.hp = 0;
        p.walk = null;
        p.walkQueue = [];
        p.cardPending = null;
        this.msg("system", `${p.name} 出局（测试通道），进入观战——不再被指认。`, p.id, { emphasis: "big" });
        break;
      }
      case "dev.drawCard": {
        if (!this.config.allowDev) throw new KernelError("dev 意图未开放");
        const p = this.player(intent.pid);
        const card = this.eventCard(intent.cardId);
        if (p.cardPending) throw new KernelError("该玩家已有挂起抉择");
        this.drawEventFor(p, now, card);
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

  /** 时钟推进：窗截止替掷、步进、选路超时、抉择代选超时、休息到点。now 由壳层时钟提供。 */
  tick(now: number): Fact[] {
    // 开局抽牌期不推进：真人选暗牌（chooseSecret）后才有窗口钟
    if (this.state.phase === "drafting") return this.drain();
    if (this.state.phase === "acting") {
      this.resolveAsks(now);
      this.resolvePendingTimers(now);
      this.fireBots(now);
      this.advanceWalks(now);
      this.maybeCloseWindow(now);
      if (now >= this.state.windowDeadline) {
        this.autoFillAndClose(now);
      }
    } else {
      this.resolveAsks(now);
      this.resolvePendingTimers(now);
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
      p.cardDraws = 0; // 连抽上限按世界回合重计
      p.botSchedule = { rollAt: now, confirmAt: 0 };
    }
    // 指向他人的卡面效果：下一世界回合开始时结算（事件定案 §1.6——被整蛊者有预判窗口）
    // 先于罚停标记：此刻结算出的罚停当窗生效（=被指认者的「下一回合」即本窗）
    const due = this.state.deferred;
    this.state.deferred = [];
    for (const d of due) {
      const p = this.player(d.pid);
      this.applyParts(p, d.parts, now);
    }
    // 罚停：消耗并轮空（不掷不确认，不占窗；T3a 卡面挂点）
    for (const p of this.state.players) {
      if (p.dead || p.zone === "done" || p.stun <= 0) continue;
      p.stun -= 1;
      p.rolled = true;
      p.confirmed = true;
      this.msg("event", `${p.name} 罚停生效——本回合轮空。`, p.id, { emphasis: "normal" });
    }
    this.emit({ type: "windowStart", turn: this.state.turn, deadline: this.state.windowDeadline });
    this.reserveBots(now);
  }

  private fireBots(now: number): void {
    for (const p of this.state.players) {
      if (!p.isBot || p.dead || p.zone === "done") continue;
      if (!p.rolled && now >= p.botSchedule.rollAt) {
        if (p.walk || p.walkQueue.length > 0) {
          // 卡面/指认造成的续走在路上：稍候重试，不让掷骰撞 KernelError
          p.botSchedule.rollAt = now + BOT_WALK_RETRY_MS;
        } else {
          this.doRollChecked(p.id, now, "bot");
        }
      }
      if (p.rolled && !p.confirmed && !p.walk && p.cardPending == null && now >= p.botSchedule.confirmAt) {
        this.doConfirm(p, now, "bot");
      }
    }
  }

  /** 窗内挂起抉择到点代选：超时未应答按卡面默认项结算并标注（事件定案 §1.7） */
  private resolvePendingTimers(now: number): void {
    for (const p of this.state.players) {
      const pend = p.cardPending;
      if (pend && now >= pend.deadline) {
        this.resolveChoice(p, pend.cardId, this.eventCard(pend.cardId).defaultOption ?? 0, now, true);
      }
    }
  }

  /** 超窗收口：先按默认项代选仍挂起的抉择（代选），再替未掷者掷骰（walk 占用者顺延，绝不让替掷抛错）、替未确认者确认（不替打卡）；然后开下一窗 */
  private autoFillAndClose(now: number): void {
    // 名下仍有挂起者按默认项代选（抉择截止晚于窗截止的兜底）
    for (const p of this.activePlayers()) {
      if (p.cardPending) {
        const pend = p.cardPending;
        this.resolveChoice(p, pend.cardId, this.eventCard(pend.cardId).defaultOption ?? 0, now, true);
      }
    }
    for (const p of this.activePlayers()) {
      if (!p.rolled && !p.walk && p.walkQueue.length === 0) {
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
    if (straight !== null && opts.includes(straight) && this.draw() < 0.6) {
      return straight; // 顺直行偏好（六成概率）
    }
    return opts[Math.floor(this.draw() * opts.length)]!;
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
        this.finishAtSeat(p);
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

  private finishAtSeat(p: PlayerState): void {
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
  }

  private endWalk(p: PlayerState, now: number): void {
    const w = p.walk;
    p.walk = null;
    if (w && w.bounced && p.zone === "branch" && p.bpos > 0) {
      this.msg("system", `${p.name} 撞旗反弹，停在支路第 ${p.bpos} 格`, p.id, { flavor: "尽头差一点就踩进。" });
    }
    this.landOn(p, now); // 落格结算：事件格抽卡（走停即触发，双向一视同仁）
    if (p.walkQueue.length > 0) {
      // 卡面连动续走：接队首（不再调度确认——还在走；下一拍自然步进）
      const next = p.walkQueue.shift()!;
      p.walk = { remaining: next, nextStepAt: now + this.config.stepMs, ask: null, pendingTo: null, bounced: false };
      return;
    }
    if (p.isBot && !p.dead && p.zone !== "done") {
      // 假人：走完一小拍后自动确认（到点由 fireBots 消费）
      p.botSchedule.confirmAt = now + 500 + Math.floor(this.draw() * 400);
    }
  }

  /** 无处可走/步数为零的清理（拓扑死角兜底；卡面续走照排） */
  private burnWalkEnd(p: PlayerState): void {
    p.walk = null;
    if (p.walkQueue.length > 0) {
      const next = p.walkQueue.shift()!;
      p.walk = { remaining: next, nextStepAt: 0, ask: null, pendingTo: null, bounced: false };
    }
  }

  /** 卡面/表效果发起的一次走格（正=前进负=沿来路栈退回）；walk 被占用则入队（T3a 卡面连动） */
  private startWalk(p: PlayerState, steps: number, now: number): void {
    if (p.dead || p.zone === "done" || steps === 0) return;
    if (p.walk) {
      p.walkQueue.push(steps);
      return;
    }
    p.walk = { remaining: steps, nextStepAt: now + this.config.stepMs, ask: null, pendingTo: null, bounced: false };
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

  // ---------- 事件格抽卡与卡面结算（#19 T3a；呈现=T3a2 中央抉择浮层+战报框） ----------

  private eventCard(id: string): EventCard {
    const c = EVENT_CARD_BY_ID.get(id);
    if (!c) throw new KernelError(`事件卡 ${id} 不在表二`);
    return c;
  }

  /** 落格结算：事件格抽卡（走停即触发，前进/退格一视同仁；终点支路与净底格不触发） */
  private landOn(p: PlayerState, now: number): void {
    if (p.dead || p.zone !== "main") return;
    const c = this.cell(p.pos);
    if (c.type !== "E") return;
    this.drawEventFor(p, now);
  }

  /**
   * 抽卡链路：单池洗匀抽一 → 抉择卡挂起供触发者本人应答（超时/假人按默认项代选并标「(代选)」）
   * → 纯效果卡即时结算 → 指认他人的部分下一世界回合生效（world·即时口径）。
   * tries/连抽上限都是防循环的保守熔断，正常对局不触发。
   */
  private drawEventFor(p: PlayerState, now: number, forced?: EventCard): void {
    if (p.cardPending) return; // 挂起中的抉择不叠新卡
    if (!forced) {
      if (p.cardDraws >= EVENT_CHAIN_CAP) {
        this.msg("event", `${p.name} 事件连抽过载——本回合暂歇。`, p.id);
        return;
      }
      p.cardDraws += 1;
    }
    let card = forced ?? null;
    if (!card) {
      // 地区特殊卡：抽卡者不在该生态 → 直排洗回牌堆重抽（事件定案 §1.8——按「地区特殊卡即权重修正」实现）
      for (let tries = 0; tries < 8 && !card; tries++) {
        const drawn = this.popCard();
        if (!drawn) return;
        if (!drawn.region || this.cell(p.pos).zone === drawn.region) {
          card = drawn;
        } else {
          this.msg("event", `「${drawn.title}」在${ECO_NAMES[this.cell(p.pos).zone]}不适用，洗回牌堆重抽。`, p.id);
          const at = Math.floor(this.draw() * (this.state.deck.length + 1));
          this.state.deck.splice(at, 0, drawn.id);
        }
      }
      if (!card) {
        // 理论不可达（池内非地区卡 ≥17 张）；兜底不吞卡
        this.msg("event", `${p.name} 这一抽没摸到适用的地区卡——本格无事。`, p.id);
        return;
      }
    }
    this.emit({ type: "cardDrawn", pid: p.id, cardId: card.id });
    // 单池守恒（事件定案 §1.8）：结算过的卡入弃牌堆，抽空即整堆洗回；挂起中的抉择卡也先入账（对局信息全公开）
    if (!forced) {
      this.state.discard.push(card.id);
    }
    this.msg("event", `${p.name} 踩上事件格，抽到「${card.title}」`, p.id, {
      flavor: card.flavor,
      emphasis: "highlight",
    });
    if (card.kind === "effect") {
      this.applyCardEffect(p, card.effect!, now);
    } else if (card.kind === "choice") {
      if (p.isBot) {
        this.resolveChoice(p, card.id, card.defaultOption ?? 0, now, true);
      } else {
        // 抉择挂起：卡面应答窗口沿用选路口径 10s（规格定死）；T3a2 中央浮层消费
        p.cardPending = { cardId: card.id, deadline: now + this.config.routeAskMs };
      }
    } else {
      // kind='window'（警长查货窗）：M1 牌池不含，仅 dev 强发路径能到
      this.msg("system", `「${card.title}」查货窗暂缓开张（T7 起接入），本格无事。`, p.id);
    }
  }

  /** 从牌堆顶抽一张（空则弃牌堆整堆洗回——单池守恒：deck+discard 恒等价于 M1_EVENT_POOL） */
  private popCard(): EventCard | null {
    if (this.state.deck.length === 0) {
      this.state.deck = this.rng.shuffle([...this.state.discard]);
      this.state.discard = [];
    }
    const id = this.state.deck.pop();
    return id ? (EVENT_CARD_BY_ID.get(id) ?? null) : null;
  }

  /** 抉择落定（option 已由调用方验过界）：战报 + 效果结算。auto=超时/假人代选。
   *  挂起路径传 pend.cardId（落定时顺带清除挂起）；假人/即时路径直接传卡 id。 */
  private resolveChoice(p: PlayerState, cardId: string, option: number, now: number, auto: boolean): void {
    const card = this.eventCard(cardId);
    const opt = card.options?.[option];
    if (!opt) throw new KernelError("卡面选项下标越界");
    p.cardPending = null;
    if (!auto) {
      this.msg("event", `${p.name} 选择：「${opt.label}」`, p.id, { emphasis: "target" });
    } else if (p.isBot) {
      this.msg("event", `系统替 ${p.name} 代选：「${opt.label}」(代选)`, p.id);
    } else {
      this.msg("event", `${p.name} 超时未选，按默认项代选：「${opt.label}」(代选)`, p.id);
    }
    this.emit({ type: "cardResolved", pid: p.id, cardId: card.id, option, auto });
    if (opt.effect) this.applyCardEffect(p, opt.effect, now);
  }

  /** 卡面效果：self 即时；others 系统指认后按计时模式分流（world=下回合生效挂 deferred） */
  private applyCardEffect(p: PlayerState, eff: CardEffect, now: number): void {
    if (eff.self?.length) this.applyParts(p, eff.self, now);
    for (const t of eff.others ?? []) {
      let targets = this.identifyTargets(p, t.target);
      if (targets.length === 0) {
        this.msg("event", `指认落空——没有可指认的目标，效果散去。`, p.id);
        continue;
      }
      if (t.target === "all") {
        // 「全员」含抽取者（表二口径）：本人即时，其余他人按下回合生效
        this.applyParts(p, t.parts, now);
        targets = targets.filter((q) => q.id !== p.id);
        if (targets.length === 0) continue;
      }
      if (this.config.timerMode === "turn") {
        // 轮班·限时：立刻生效（无同时行动，无竞态）；M1 未接线（T9），口径先立
        for (const q of targets) this.applyParts(q, t.parts, now);
      } else {
        // world·即时：下一世界回合开始时结算（被整蛊者有预判窗口）
        for (const q of targets) this.state.deferred.push({ pid: q.id, parts: t.parts });
        this.msg("event", `下一世界回合开始时结算：${targets.map((q) => q.name).join("、")}。`, p.id, {
          targets: targets.map((q) => q.id),
        });
      }
    }
  }

  /** 系统指认：跳过淘汰者与通关席（事件定案 §5.2）；nearest/farthest 以净步为先、id 破平 */
  private identifyTargets(drawer: PlayerState, target: "nearestToGoal" | "farthestFromGoal" | "previous" | "random" | "all"): PlayerState[] {
    const act = this.state.players.filter((q) => !q.dead && q.zone !== "done");
    if (act.length === 0) return [];
    switch (target) {
      case "all":
        return act;
      case "random":
        return [act[Math.floor(this.draw() * act.length)]!];
      case "nearestToGoal":
        return [act.slice().sort((a, b) => b.net - a.net || a.id - b.id)[0]!];
      case "farthestFromGoal":
        return [act.slice().sort((a, b) => a.net - b.net || a.id - b.id)[0]!];
      case "previous": {
        const cand = this.player((drawer.id + this.state.players.length - 1) % this.state.players.length);
        return !cand.dead && cand.zone !== "done" ? [cand] : [];
      }
    }
  }

  /** 原语结算：一类一个出口，血量/罚停/走格都走统一通道（T5 陷阱/T6 遭遇战复用） */
  private applyParts(p: PlayerState, parts: EffectPart[], now: number): void {
    if (p.dead || p.zone === "done") return;
    for (const part of parts) {
      switch (part.type) {
        case "move":
          if (part.v > 0) {
            this.msg("event", `${p.name} 前进 ${part.v} 格。`, p.id);
            this.startWalk(p, part.v, now);
          }
          break;
        case "back":
          if (part.v > 0) {
            this.msg("event", `${p.name} 退 ${part.v} 格。`, p.id);
            this.startWalk(p, -part.v, now);
          }
          break;
        case "skip":
          if (part.v > 0) {
            p.stun += part.v;
            this.msg("event", `${p.name} 被罚停 ${part.v} 回合。`, p.id, { emphasis: "target" });
          }
          break;
        case "hp":
          this.applyHpDelta(p, part.v);
          break;
        case "drawItem":
          if (part.v > 0) {
            this.msg("item", `${p.name} 摸到 ${part.v} 张道具卡（手牌 T4a 起入袋）。`, p.id);
          }
          break;
        case "trial":
          this.drawEventFor(p, now);
          break;
        case "check":
          this.runCheck(p, part.spec, now);
          break;
        case "none":
          break;
      }
    }
  }

  /** 血量通道：扣血先过盾（皮糙肉厚，T5 陷阱同款），回血封顶上限，归零只播报（淘汰流程 T5c） */
  private applyHpDelta(p: PlayerState, delta: number): void {
    if (delta === 0) return;
    if (delta < 0 && p.shields > 0) {
      p.shields -= 1;
      this.msg("event", `${p.name} 皮糙肉厚被动：免疫这次扣血！`, p.id, { emphasis: "highlight" });
      return;
    }
    p.hp = Math.max(0, Math.min(this.config.maxHp, p.hp + delta));
    if (delta < 0) {
      this.msg("event", `${p.name} 扣 ${-delta} 血（剩 ${p.hp}/${this.config.maxHp}）`, p.id, { emphasis: "target" });
      if (p.hp === 0) {
        this.msg("event", `${p.name} 血量归零——血尽=淘汰（观战；流程 T5c 起接入）。`, p.id, { emphasis: "big" });
      }
    } else {
      this.msg("event", `${p.name} 回 ${delta} 血（剩 ${p.hp}/${this.config.maxHp}）`, p.id);
    }
  }

  /**
   * 检定三态（1d20+轴 vs 卡面 DC）：修正四原语与角色特长先全量互抵再掷再判；
   * 极值挂原始面 20/1（升面骰出的 21+ 只算大数，不算大成功——保持「极值不随面宽翻动」口径）。
   * 无 dc 的前途骰走 bands 分档（命运之骰：20/1 极值 → 余面按 min/max 首中，末条兜底）。
   */
  private runCheck(p: PlayerState, spec: CheckSpec, now: number): void {
    const role = roleDef(p.roleId);
    const mods: CheckMods[] = [
      ...(spec.mods ?? []).map((m): CheckMods => {
        if (m.mode === "cut") return { face: -m.v };
        if (m.mode === "raise") return { face: m.v };
        if (m.mode === "floor") return { floor: m.v };
        return { bonus: m.v };
      }),
      // 轴系特长（蛮力/狡运）只跟有轴检定走；无轴前途骰（命运之骰）不吃特长
      ...(spec.axis ? roleCheckMods(role, spec.axis) : []),
    ];
    const net = netMods(mods); // 互抵：先全量合账（D&D 原则）
    const faces = Math.max(3, CHECK_FACES + net.face);
    const raw = rollD20(this.rng, { adv: net.adv, advCount: net.advCount }, faces);
    this.syncRng(); // 批量消耗后的状态回账（draw() 的逐粒同步在此批量化）
    const res = resolveCheck({
      raw,
      axisBonus: spec.axis ? p.axes[spec.axis] : 0,
      dc: spec.dc ?? 0,
      mods,
      oneToCrit: roleOneToCrit(role),
    });
    const gradeText: Record<CheckGrade, string> = { crit: "大成功", pass: "通过", fail: "失败", critfail: "大失败" };
    const axisName = spec.axis ? AXIS_NAMES[spec.axis] : "前途骰";
    if (spec.dc != null) {
      this.msg(
        "event",
        `${p.name} ${axisName}检 d20(${res.raw})${res.mods >= 0 ? "+" : "−"}${Math.abs(res.mods)}=${res.used} vs DC${spec.dc} —— ${gradeText[res.grade]}！`,
        p.id,
        { emphasis: res.grade === "crit" || res.grade === "critfail" ? "highlight" : "normal" },
      );
    } else {
      this.msg("event", `${p.name} ${axisName}掷出 ${res.raw}${res.mods ? `（+${res.mods}）` : ""} —— ${res.raw}。`, p.id, {
        emphasis: "normal",
      });
    }
    let parts: EffectPart[] | undefined;
    if (res.grade === "crit") {
      parts = spec.onCrit ?? spec.onPass; // 大成功当卡自带额外正面；缺省回落通过分支
    } else if (res.grade === "critfail") {
      parts = spec.onCritFail ?? spec.onFail; // 大失败当卡自带额外负面；缺省回落失败分支
    } else if (spec.bands) {
      const band = spec.bands.find((b) => (b.min == null || res.used >= b.min) && (b.max == null || res.used <= b.max));
      parts = band?.parts;
    } else {
      parts = res.grade === "pass" ? spec.onPass : spec.onFail;
    }
    if (parts?.length) this.applyParts(p, parts, now);
  }
}
