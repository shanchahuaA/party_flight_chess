/**
 * 规则内核（M1）：权威逻辑层，一次意图入 → 新权威状态 + 事实 + 战报 slice。
 * 参照：ADR 0001/0002、一页纸规则 v4、#13 v3 走格手感 stub（原路栈/选路/反弹机制已实玩验证）。
 *
 * 计时语义（世界·即时，单机本地计时）：
 *   输入 now 由壳层（shell 时钟）提供，内核自身不读时钟——全部对时可由 t 系列单测驱动。
 *   #7 定案：全员同窗行动、掷完立刻逐格走、全员完成提前开窗、超时替掷并自动确认（不替打卡）。
 */
import { BOARD, BRANCH_LEN, ECO_NAMES, NET_GOAL, SPAWN_SLOTS, STREET_NAMES, cellAt, spawnMenu, type BoardCell } from "./board";
import { M1_EVENT_POOL, EVENT_CARD_BY_ID, type CardEffect, type CheckSpec, type DiceMod, type EffectPart, type EventCard } from "./data/events";
import { ITEM_CARD_BY_ID, M1_ITEM_POOL, itemCard, itemHasPart } from "./data/items";
import { AXIS_NAMES, ROLES, roleDef } from "./data/roles";
import { SECRET_GOALS } from "./data/goals";
import { CHECK_FACES, effectiveValue, netMods, resolveCheck, roleCheckMods, roleOneToCrit, rollD20, rollDice, type CheckGrade, type CheckMods } from "./check";
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

/** 骰面修正四原语 → 检定修正通道（检定骰与走格骰共用一份互抵口径：#19 卡面 DSL） */
function toCheckMods(mods: DiceMod[]): CheckMods[] {
  return mods.map((m) =>
    m.mode === "cut" ? { face: -m.v } : m.mode === "raise" ? { face: m.v } : m.mode === "floor" ? { floor: m.v } : { bonus: m.v },
  );
}

/** 走格骰修正的战报括注（「顺风靴 +3」「脚镣 削面 1」） */
function modDetail(mods: DiceMod[]): string {
  const txt = (m: DiceMod): string =>
    m.mode === "flat" ? (m.v >= 0 ? `+${m.v}` : `${m.v}`) : m.mode === "cut" ? `削面 ${m.v}` : m.mode === "raise" ? `升面 ${m.v}` : `保底 ${m.v}`;
  return mods.map((m) => (m.src ? `${m.src} ${txt(m)}` : txt(m))).join("、");
}

/** 单项修正播报值（−2/+4 全宽负号播报——气候挂账从 WeatherSpec 数据取值，不硬写） */
function modSigned(v: number): string {
  return v < 0 ? `−${-v}` : `+${v}`;
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

/** 卡牌效果来源上下文（T4b1）：kind=道具卡/事件卡通道、srcPid=打出者——小圆盾「免疫他人卡牌效果」的拦截判据 */
type GuardCtx = { kind: "item" | "event"; srcPid: number };

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

/** 环境卡全桌气候持续的世界回合数（表一 #13/#19/#20 拍板 2） */
const AMBIENT_TURNS = 2;

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
          talisman: 0,
          cardGuard: 0,
          pos: SPAWN_SLOTS[menu[i]!]!.cell,
          from: null,
          trail: [],
          net: 0,
          zone: "main",
          bpos: 0,
          rolled: false,
          confirmed: false,
          stun: 0,
          skipped: false,
          dead: false,
          spawnCell: SPAWN_SLOTS[menu[i]!]!.cell,
          secretOptions: draftPair(),
          secretPick: d.isBot ? this.rng.int(2) : null,
          botSchedule: { rollAt: now, confirmAt: 0 },
          walk: null,
          walkQueue: [],
          cardPending: null,
          cardDraws: 0,
          hand: [],
          rollMods: [],
          checkMods: [],
          wearHalves: 0,
        };
      }),
      finishers: [],
      messages: [],
      // 事件牌堆：单池洗匀（表二 20 张；'window' 卡 T7 放行——事件定案 §1.8 抽完即洗回弃牌堆）
      deck: this.rng.shuffle(M1_EVENT_POOL.map((c) => c.id)),
      discard: [],
      // 道具牌堆：单池洗匀（表一 20 张全量，T4b2 收口——事件定案 §1.8 同口径）
      itemDeck: this.rng.shuffle(M1_ITEM_POOL.map((c) => c.id)),
      itemDiscard: [],
      ground: [],
      ambient: null,
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
    // 轻装上阵被动「开局手牌 +1」：逐人补进手牌（T4a 摸牌链首家消费者）
    for (const p of this.state.players) {
      const plus = roleDef(p.roleId).flags.handPlus ?? 0;
      if (plus <= 0) continue;
      let got = 0;
      for (let i = 0; i < plus; i++) {
        const id = this.popItem();
        if (!id) break;
        p.hand.push(id);
        this.emit({ type: "itemDrawn", pid: p.id, cardId: id });
        got += 1;
      }
      if (got > 0) this.msg("system", `${p.name} 轻装上阵被动：开局手牌 +${got}。`, p.id);
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
      case "playItem": {
        this.doPlayItem(intent.pid, intent.cardId, intent.target, now);
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
      case "dev.giveItem": {
        if (!this.config.allowDev) throw new KernelError("dev 意图未开放");
        const p = this.player(intent.pid);
        const card = itemCard(intent.cardId);
        // 从牌堆/弃牌堆取出（单池守恒：手牌多一张，牌堆就少一张）
        const inDeck = this.state.itemDeck.indexOf(card.id);
        if (inDeck >= 0) {
          this.state.itemDeck.splice(inDeck, 1);
        } else {
          const inDiscard = this.state.itemDiscard.indexOf(card.id);
          if (inDiscard < 0) throw new KernelError(`「${card.title}」不在牌堆/弃牌堆（已在手牌或场上）`);
          this.state.itemDiscard.splice(inDiscard, 1);
        }
        p.hand.push(card.id);
        this.emit({ type: "itemDrawn", pid: p.id, cardId: card.id });
        break;
      }
      case "dev.hit": {
        if (!this.config.allowDev) throw new KernelError("dev 意图未开放");
        if (intent.dmg <= 0) throw new KernelError("伤害数应为正");
        this.applyHpDelta(this.player(intent.pid), -intent.dmg);
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
      p.skipped = false;
      p.cardDraws = 0; // 连抽上限按世界回合重计
      p.checkMods = []; // 风暴·沙暴的 −4 只属本回合：回合开始重刷（T4b2）
      p.botSchedule = { rollAt: now, confirmAt: 0 };
    }
    // 指向他人的卡面效果：下一世界回合开始时结算（事件定案 §1.6——被整蛊者有预判窗口）
    // 先于罚停标记：此刻结算出的罚停当窗生效（=被指认者的「下一回合」即本窗）
    const due = this.state.deferred;
    this.state.deferred = [];
    for (const d of due) {
      const p = this.player(d.pid);
      if (p.dead || p.zone === "done") {
        // 挂账一回合后目标已不在对局（淘汰/入席）——整蛊落空要出声，不静默吞
        this.msg(d.kind, `挂账的${d.kind === "item" ? "道具卡" : "事件卡"}效果散去——${p.name} 已不在对局。`, d.srcPid, {
          targets: [d.pid],
        });
        continue;
      }
      this.applyParts(p, d.parts, now, { kind: d.kind, srcPid: d.srcPid });
    }
    // 罚停：消耗并轮空（不掷不确认，不占窗；T3a 卡面挂点）
    for (const p of this.state.players) {
      if (p.dead || p.zone === "done" || p.stun <= 0) continue;
      p.stun -= 1;
      p.rolled = true;
      p.confirmed = true;
      p.skipped = true;
      this.msg("event", `${p.name} 罚停生效——本回合轮空。`, p.id, { emphasis: "normal" });
    }
    // 环境卡气候（《生物圈 3 号》三原则，#32 T4b2）：每个世界回合「行动前」结算一次——
    // 雷暴=随机劈人；暴雨/风暴按所在生态地形行上判定/修正。轮空者无行动不判（罚停消耗之后。
    this.tickAmbient(now);
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

  // ---------- 环境卡气候（《生物圈 3 号》三原则，#32 T4b2） ----------

  /** 全场环境每世界回合「行动前」结算（打出的当回合已过时点、从下一回合开始；left 减到 0=平息失效）：
   *  雷暴=回合开始随机劈 1 名在场者回退（按被劈者生态取行）；暴雨/风暴=各行动者按所在生态地形行
   *  掷摔倒判定或上修正批。通道全走既有原语（applyParts/addWalkMods/checkMods）——与其他扣血/扣面渠道互抵不串扰。 */
  private tickAmbient(now: number): void {
    const amb = this.state.ambient;
    if (!amb) return;
    const card = itemCard(amb.cardId);
    const w = card.weather!;
    if (w.strike) {
      // 雷暴：随机劈 1 名在场者（含打出者自己——天灾无主）；回退步数按被劈者所在格生态取行
      const act = this.state.players.filter((q) => !q.dead && q.zone !== "done");
      const victim = act[Math.floor(this.draw() * act.length)];
      if (victim) {
        const eco = this.cell(victim.pos).zone; // 支路里的人 pos=出生格（平原）——行军地貌按所在格统一口径
        const steps = w.strike[eco] ?? 0;
        if (steps > 0) {
          this.msg("item", `⛈ 雷暴劈下——${victim.name} 在${ECO_NAMES[eco]}被劈中，回退 ${steps} 步。`, victim.id, {
            emphasis: "target",
          });
          this.startWalk(victim, -steps, now);
        }
      }
    }
    // 行动者逐人取行（罚停轮空者本回合无行动——不判不挂）
    for (const p of this.state.players) {
      if (p.dead || p.zone === "done" || p.skipped) continue;
      const eco = this.cell(p.pos).zone;
      const slip = w.slip?.[eco];
      if (slip) this.weatherCheck(p, card.title, slip, now);
      const wind = w.wind?.[eco];
      if (wind) {
        if (wind.walkMod) {
          this.addWalkMods(p, [wind.walkMod]);
          this.msg("item", `🌪 「${card.title}」狂风扑面——${p.name} 在${ECO_NAMES[eco]}的下次走格骰 ${modSigned(wind.walkMod.v)}（顶风逆行）。`, p.id);
        }
        if (wind.checkMod) {
          p.checkMods.push(wind.checkMod);
          this.msg("item", `🌪 「${card.title}」沙暴漫天——${p.name} 在${ECO_NAMES[eco]}本回合所有检定 ${modSigned(wind.checkMod.v)}。`, p.id, {
            emphasis: "normal",
          });
        }
        if (wind.check) this.weatherCheck(p, card.title, wind.check, now);
      }
    }
    amb.left -= 1;
    if (amb.left <= 0) {
      this.state.ambient = null;
      this.msg("item", `「${card.title}」天色放晴——全桌气候平息（${AMBIENT_TURNS} 世界回合到期）。`, undefined, {
        emphasis: "normal",
      });
    }
  }

  /** 环境判定骰（暴雨/风暴摔倒行共用）：掷 faces 面骰 ≤guard=摔倒；没摔不出声，摔了后果走 applyParts 原通道 */
  private weatherCheck(p: PlayerState, cardTitle: string, row: { faces: number; guard: number; onFall: EffectPart[] }, now: number): void {
    const raw = rollDice(this.rng, { adv: 0, advCount: 0 }, row.faces);
    this.syncRng();
    if (raw > row.guard) return;
    this.msg("item", `⚖ 「${cardTitle}」摔倒判定 d${row.faces}(${raw})≤${row.guard}——${p.name} 摔倒了！`, p.id, {
      emphasis: "target",
    });
    if (row.onFall.length > 0) this.applyParts(p, row.onFall, now);
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

  /** 走格骰一次掷出（修正四原语互抵→面数±→掷→有效值）：doRoll 首掷与 doReroll 重掷共用一段（T4a/T4b1） */
  private tossWalkRoll(mods: DiceMod[]): { raw: number; d: number } {
    const net = netMods(toCheckMods(mods));
    // 脚镣削面：1d10→1d9（cut 1）；加倍骰升面：1d10→1d12（raise 2，T4b1 落卡）——面数通道同一出口
    const faces = Math.max(2, WALK_DIE + net.face);
    const raw = rollDice(this.rng, net, faces);
    this.syncRng();
    return { raw, d: effectiveValue(raw, net.bonus, net.floor) }; // 顺风靴 +3 → 幸运骰保底 ≥6
  }

  private doRoll(pid: number, now: number, mode: "human" | "bot" | "replacement"): void {
    const p = this.player(pid);
    p.rolled = true;
    // 走格骰修正（T4a 道具）：积压的修正一次性消费，四原语先全量互抵再掷再判（与检定同口径）
    const mods = p.rollMods;
    p.rollMods = [];
    const { raw, d } = this.tossWalkRoll(mods);
    p.walk = {
      remaining: d,
      total: d, // 本骰总步数（时光怀表重掷的「已走步数」对照基准，T4b1）
      dice: true, // 走格骰发团的走——重掷只对付它
      nextStepAt: now + this.config.stepMs,
      ask: null,
      pendingTo: null,
      bounced: false,
      ...(mods.length > 0 ? { mods } : {}),
    };
    this.emit({ type: "roll", pid, d, auto: mode !== "human", ...(mods.length > 0 ? { mods } : {}) });
    const calc = mods.length > 0 ? `${raw}（${modDetail(mods)}）= ${d}` : `${d}`;
    if (mode === "replacement") {
      this.msg("system", `系统替 ${p.name} 掷骰：${calc} 点`, pid, { emphasis: "highlight" });
    } else if (mods.length > 0) {
      this.msg("item", `${p.name} 走格骰 ${calc} 步`, pid, { emphasis: "highlight" });
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
          // 来路空空（出生未动/被传送）：退步落空，报一声再收（弹弓/鼠横行指认新人的边角）
          this.msg("event", `${p.name} 身后来路空空，退步落了空。`, p.id);
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
      // 卡面连动续走：接队首（不再调度确认——还在走；下一拍自然步进）。效果轨（dice=false）
      const next = p.walkQueue.shift()!;
      p.walk = { remaining: next, total: next, dice: false, nextStepAt: now + this.config.stepMs, ask: null, pendingTo: null, bounced: false };
      return;
    }
    if (p.isBot && !p.dead && p.zone !== "done") {
      // 假人：走完一小拍后自动确认（到点由 fireBots 消费）
      p.botSchedule.confirmAt = now + 500 + Math.floor(this.draw() * 400);
    }
  }

  /** 无处可走/步数为零的清理（拓扑死角兜底；卡面续走照排）。效果轨接队（dice=false） */
  private burnWalkEnd(p: PlayerState): void {
    p.walk = null;
    if (p.walkQueue.length > 0) {
      const next = p.walkQueue.shift()!;
      p.walk = { remaining: next, total: next, dice: false, nextStepAt: 0, ask: null, pendingTo: null, bounced: false };
    }
  }

  /** 卡面/表效果发起的一次走格（正=前进负=沿来路栈退回）；walk 被占用则入队（T3a 卡面连动）。非骰走（dice=false）——重掷不管 */
  private startWalk(p: PlayerState, steps: number, now: number): void {
    if (p.dead || p.zone === "done" || steps === 0) return;
    if (p.walk) {
      p.walkQueue.push(steps);
      return;
    }
    p.walk = { remaining: steps, total: steps, dice: false, nextStepAt: now + this.config.stepMs, ask: null, pendingTo: null, bounced: false };
  }

  private queueBack(p: PlayerState, steps: number, now: number): void {
    p.walk = { remaining: -steps, total: -steps, dice: false, nextStepAt: now + this.config.stepMs, ask: null, pendingTo: null, bounced: false };
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

  /** 落格结算（走停即触发，前进/退格一视同仁；终点支路与净底格不触发）：
   *  场地型附着先判（踩上即踩上），再按格型——道具格摸卡／事件格抽卡。 */
  private landOn(p: PlayerState, now: number): void {
    if (p.dead || p.zone !== "main") return;
    const c = this.cell(p.pos);
    this.triggerGround(p, now);
    if (c.type === "I") {
      this.drawItems(p, 1, "踩上道具格");
    } else if (c.type === "E") {
      this.drawEventFor(p, now);
    }
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
      this.syncRng();
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

  /** 指认/指向他人的卡面效果统一按计时模式出发（#22 T4b1 收口）：轮班·限时=立刻生效（无同时行动，无竞态；M1 未接线 T9，口径先立）；world·即时=挂账下一窗开窗结算（被整蛊者有预判窗口）。 */
  private dispatchToOthers(targets: PlayerState[], parts: EffectPart[], now: number, ctx: GuardCtx): void {
    if (this.config.timerMode === "turn") {
      for (const q of targets) this.applyParts(q, parts, now, ctx);
      return;
    }
    for (const q of targets) this.state.deferred.push({ pid: q.id, parts, kind: ctx.kind, srcPid: ctx.srcPid });
    this.msg(ctx.kind, `下一世界回合开始时结算：${targets.map((q) => q.name).join("、")}。`, ctx.srcPid, {
      targets: targets.map((q) => q.id),
    });
  }

  /** 卡面效果：self 即时；others 系统指认后按计时模式分流（world=下回合生效挂 deferred）。
   *  指认通路带 GuardCtx（kind/srcPid）——小圆盾「免疫他人卡牌效果」按打出者判他我（T4b1）。 */
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
      this.dispatchToOthers(targets, t.parts, now, { kind: "event", srcPid: p.id });
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

  /**
   * 原语结算：一类一个出口，血量/罚停/走格/摸卡/走格骰修正都走统一通道（T5 陷阱/T6 遭遇战复用）。
   * ctx=卡牌效果来源（kind/srcPid，T4b1）：小圆盾按它拦「他人卡牌效果」；恶意/陷阱/野怪等非卡通路不传。
   */
  private applyParts(p: PlayerState, parts: EffectPart[], now: number, ctx?: GuardCtx): void {
    if (p.dead || p.zone === "done") return;
    if (ctx && p.cardGuard === this.state.turn && ctx.srcPid !== p.id) {
      // 小圆盾（表一 #9）：下一世界回合免疫他人卡牌效果——整批效果拦下（触发者自己的卡牌不拦）
      const src = this.player(ctx.srcPid);
      this.msg(ctx.kind, `${p.name} 「小圆盾」挡下 ${src.name} 的${ctx.kind === "item" ? "道具卡" : "事件卡"}效果！`, p.id, {
        targets: [ctx.srcPid],
        emphasis: "highlight",
      });
      return;
    }
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
          if (part.v > 0) this.drawItems(p, part.v);
          break;
        case "rollMod":
          this.addWalkMods(p, part.mods);
          break;
        case "trial":
          this.drawEventFor(p, now);
          break;
        case "check":
          this.runCheck(p, part.spec, now, ctx);
          break;
        case "reroll":
          // 时光怀表（表一 #2）：重掷本次走格骰（骰走在路上才可重掷——gate 前置校验，此为数据兜底）
          this.doReroll(p, now);
          break;
        case "swap":
          this.doSwap(p, ctx);
          break;
        case "talisman":
          p.talisman += 1;
          this.msg("item", `${p.name} 带上护身符——下一次任何伤害被挡下（触发即消耗）。`, p.id, { emphasis: "highlight" });
          break;
        case "roundShield": {
          // 下回合免疫他人卡牌效果：记失效线=turn+1，随窗自然过期（turn 比较即判）
          p.cardGuard = this.state.turn + 1;
          this.msg("item", `${p.name} 举起小圆盾——下一世界回合，他人卡牌效果对他无效。`, p.id, { emphasis: "highlight" });
          break;
        }
        case "clearGround": {
          if (!(part.v > 0)) break;
          const n = this.clearGroundForward(p, part.v);
          if (n === 0) {
            this.msg("item", `${p.name} 烧开一道清障符——前方 ${part.v} 格干干净净，无事发生。`, p.id);
          } else {
            this.msg("item", `${p.name} 烧开一道清障符——前方 ${part.v} 格里的 ${n} 张场地卡收走入弃牌堆。`, p.id, {
              emphasis: "highlight",
            });
          }
          break;
        }
        case "none":
          break;
      }
    }
  }

  /** 血量通道：扣血先过护身符（表一 #14，触发即消耗）再过盾（皮糙肉厚，T5 陷阱同款），回血封顶上限，归零只播报（淘汰流程 T5c） */
  private applyHpDelta(p: PlayerState, delta: number): void {
    if (delta === 0) return;
    if (delta < 0 && p.talisman > 0) {
      p.talisman -= 1;
      this.msg("item", `${p.name} 护身符闪金光——免疫这次伤害！（触发即消耗）`, p.id, { emphasis: "highlight" });
      return;
    }
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
   * ctx 透传给分支原语（小圆盾判「他人卡牌效果」的依据，T4b1）。
   */
  private runCheck(p: PlayerState, spec: CheckSpec, now: number, ctx?: GuardCtx): void {
    const role = roleDef(p.roleId);
    const mods: CheckMods[] = [
      ...toCheckMods(p.checkMods), // 风暴·沙暴等气候挂的本回合检定修正（T4b2）——与卡面/特长同一互抵批（走格骰不吃它）
      ...toCheckMods(spec.mods ?? []),
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
      // 前途骰（无 dc）：修正括注与 dc 分支同形；档位结果由 bands 分支的 move/back 播报自报，此处只报面
      const mods =
        res.mods === 0 ? "" : res.mods > 0 ? `（+${res.mods}）` : `（−${-res.mods}）`;
      this.msg("event", `${p.name} ${axisName}掷出 ${res.raw}${mods}。`, p.id, {
        emphasis: "normal",
      });
    }
    let parts: EffectPart[] | undefined;
    if (res.grade === "crit") {
      parts = spec.onCrit ?? spec.onPass; // 大成功当卡自带额外正面；缺省回落通过分支
    } else if (res.grade === "critfail") {
      parts = spec.onCritFail ?? spec.onFail; // 大失败当卡自带额外负面；缺省回落失败分支
    } else if (spec.bands) {
      // 分档按判定用有效面 used（与 dc 判读同源）；命运之骰无轴无 mods 下 used=raw，与表二「掷 1d20」面值语义等价
      const band = spec.bands.find((b) => (b.min == null || res.used >= b.min) && (b.max == null || res.used <= b.max));
      parts = band?.parts;
    } else {
      parts = res.grade === "pass" ? spec.onPass : spec.onFail;
    }
    if (parts?.length) this.applyParts(p, parts, now, ctx);
  }

  // ---------- 道具卡打出链（#21 T4a：手牌+时机锁+三类路由+场地附着；#22 T4b1：auto 指认+新原语+两模式语境） ----------

  /** 打出一张道具卡：时机锁/手牌/目标合法性全过才落账（拒绝即抛，不产生半截状态变更） */
  private doPlayItem(pid: number, cardId: string, target: number | undefined, now: number): void {
    const gate = itemPlayGate(this.state, pid, cardId);
    if (!gate.ok) throw new KernelError(gate.reason);
    const p = this.player(pid);
    const card = itemCard(cardId);
    const isSwap = itemHasPart(card, "swap");
    // 目标校验先行：chooseOther 必带合法目标；auto/self 路由不得带目标（auto 由卡面规则系统指认）
    let q: PlayerState | null = null;
    if (card.route === "chooseOther") {
      if (target == null) throw new KernelError(`「${card.title}」要先选一个目标`);
      q = this.player(target);
      if (!itemLegalTargets(this.state, pid, cardId).includes(q.id)) {
        throw new KernelError(`${q.name} 不可选（本人/已淘汰/通关席${isSwap ? "/不在主干道" : ""}）`);
      }
    } else if (card.route === "auto") {
      if (target != null) throw new KernelError(`「${card.title}」是系统指认——不用带目标`);
    } else if (card.route === "ambient") {
      if (target != null) throw new KernelError(`「${card.title}」是全场气候——不用带目标`);
    } else if (target != null) {
      throw new KernelError(`「${card.title}」不需要目标`);
    }
    // 偷天换日双向主干道：打出者也不能在支路/通关席（通关席已被 gate 拦；这里拦支路）
    if (isSwap && p.zone !== "main") {
      throw new KernelError(`「${card.title}」要和目标都在主干道上才能换位`);
    }
    // —— 校验全过：出袋落账（单池守恒：离手即入弃牌堆；场地卡离池挂在格上，触发才入账） ——
    p.hand.splice(p.hand.indexOf(cardId), 1);
    this.emit({ type: "itemPlayed", pid, cardId, ...(q ? { target: q.id } : {}) });
    if (card.route === "chooseOther") {
      this.state.itemDiscard.push(cardId);
      // 目标自选=公开信息：打出与指认都进战报
      this.msg("item", `${p.name} 打出「${card.title}」→ 指向 ${q!.name}`, pid, {
        targets: [q!.id],
        flavor: card.flavor,
        emphasis: "target",
      });
      // 效果挂后续票的占位卡（狗笛=T6b 野狗生成）：晒牌照常入池，效果先扣住
      if (card.tbd) {
        this.msg("item", `「${card.title}」的效果要等 ${card.tbd} 起接入——${q!.name} 的相邻格届时生成，本张先记账。`, pid, {
          targets: [q!.id],
        });
        return;
      }
      if (this.config.timerMode === "turn") {
        // 轮班·限时：立刻生效（无同时行动，无竞态）
        this.applyParts(q!, card.parts!, now, { kind: "item", srcPid: pid });
      } else {
        // world·即时：下一世界回合开始时结算（被整蛊者有预判窗口——与事件卡同口径）
        this.state.deferred.push({ pid: q!.id, parts: card.parts!, kind: "item", srcPid: pid });
        this.msg("item", `下一世界回合开始时结算：${q!.name}。`, pid, { targets: [q!.id] });
      }
      return;
    }
    if (card.route === "auto") {
      // 卡面写死指认规则：系统自动选目标（identifyTargets 跳过淘汰者/通关席），无目标=落空散去
      this.state.itemDiscard.push(cardId);
      const targets = this.identifyTargets(p, card.autoRule!);
      const names = targets.map((t) => t.name).join("、");
      this.msg("item", `${p.name} 打出「${card.title}」（系统指认）${targets.length > 0 ? `→ ${names}` : "——落空"}`, pid, {
        ...(targets.length > 0 ? { targets: targets.map((t) => t.id) } : {}),
        flavor: card.flavor,
        emphasis: "target",
      });
      if (targets.length === 0) {
        this.msg("item", "指认落空——没有可指认的目标，效果散去。", pid);
        return;
      }
      this.dispatchToOthers(targets, card.parts!, now, { kind: "item", srcPid: pid });
      return;
    }
    if (card.route === "ambient") {
      // 《生物圈 3 号》三原则（#32 T4b2）：出袋即回弃牌堆（气候只挂状态——单池守恒式自动成立）；
      // 一场最多 1 个环境生效——现役旧环境计时失效（状态当场撤掉、下一回合起不再触发）；打出者摸 1 张补偿。
      this.state.itemDiscard.push(cardId);
      const old = this.state.ambient;
      this.state.ambient = { cardId, left: AMBIENT_TURNS };
      const scene = old
        ? `${p.name} 打出「${card.title}」，压掉旧气候「${itemCard(old.cardId).title}」（旧环境即时失效）——全桌气候 ${AMBIENT_TURNS} 世界回合`
        : `${p.name} 打出「${card.title}」——全桌气候 ${AMBIENT_TURNS} 世界回合`;
      this.msg("item", `${scene}（下一回合起按所在生态逐行结算）。`, pid, {
        flavor: card.flavor,
        emphasis: old ? "big" : "highlight",
      });
      this.drawItems(p, 1, "打出环境补偿");
      return;
    }
    if (card.route === "self") {
      this.state.itemDiscard.push(cardId);
      this.msg("item", `${p.name} 打出「${card.title}」`, pid, { flavor: card.flavor, emphasis: "highlight" });
      this.applyParts(p, card.parts!, now);
      return;
    }
    // ground：附着当前格；下一踩上者（含铺设者本人）触发判定后消失。
    // 附着期间卡片离池不入弃牌堆（否则弃牌堆洗回会抽出第二张同卡，与场上的那张重复）
    this.state.ground.push({ cell: p.pos, cardId, owner: pid });
    this.msg("item", `${p.name} 把「${card.title}」搁在脚下——下一踩上的人要吃苦头了。`, pid, {
      flavor: card.flavor,
      emphasis: "highlight",
    });
  }

  /** 场地型附着触发（走停即踩上）：判定前先摘牌（结算引走格不回触），判定后消失；含铺设者本人 */
  private triggerGround(p: PlayerState, now: number): void {
    const hits = this.state.ground.filter((g) => g.cell === p.pos);
    if (hits.length === 0) return;
    this.state.ground = this.state.ground.filter((g) => g.cell !== p.pos);
    for (const g of hits) {
      const card = itemCard(g.cardId);
      const owner = this.player(g.owner);
      const by = g.owner === p.id ? "自己布的" : `${owner.name} 布的`;
      this.msg("item", `${p.name} 一脚踩上「${card.title}」（${by}）——判定！`, p.id, {
        flavor: card.flavor,
        emphasis: "target",
        ...(g.owner === p.id ? {} : { targets: [g.owner] }),
      });
      this.state.itemDiscard.push(g.cardId); // 触发即消耗：卡片回池（弃牌堆）
      // 踩上判定=他人卡牌效果（小圆盾拦；自铺不拦——srcPid=owner 同源不拦）
      this.runCheck(p, card.ground!.check, now, { kind: "item", srcPid: g.owner });
    }
  }

  /** 摸道具卡（踩道具格/卡面/双倍惊喜共用）：单池抽卡入袋，抽空即弃牌堆洗回 */
  private drawItems(p: PlayerState, count: number, why?: string): void {
    let got = 0;
    for (let i = 0; i < count; i++) {
      const id = this.popItem();
      if (!id) break;
      p.hand.push(id);
      this.emit({ type: "itemDrawn", pid: p.id, cardId: id });
      got += 1;
    }
    if (got > 0) {
      this.msg("item", `${p.name} ${why ? `${why}，` : ""}摸到 ${got} 张道具卡，收入手牌。`, p.id);
    }
    if (got < count) {
      this.msg("item", `道具牌堆见空——${p.name} 少摸了 ${count - got} 张。`, p.id);
    }
  }

  /** 从道具牌堆顶抽一张（空则弃牌堆整堆洗回——单池守恒：deck+discard+手牌 恒等于 M1 池） */
  private popItem(): string | null {
    if (this.state.itemDeck.length === 0) {
      this.state.itemDeck = this.rng.shuffle([...this.state.itemDiscard]);
      this.state.itemDiscard = [];
      this.syncRng();
    }
    return this.state.itemDeck.pop() ?? null;
  }

  /** 走格骰修正落账：穿戴类负面（脚镣/削面）遇轻装上阵被动「减半（2 层并 1）」——半分账满 2 折 1 */
  private addWalkMods(p: PlayerState, mods: DiceMod[]): void {
    const halved = roleDef(p.roleId).flags.wearHalved === true;
    for (const m of mods) {
      if (!halved || !m.wear) {
        p.rollMods.push(m);
        continue;
      }
      p.wearHalves += 1;
      if (p.wearHalves >= 2) {
        p.wearHalves -= 2;
        p.rollMods.push(m);
        this.msg("item", `${p.name} 轻装上阵被动：两层并一层，「${m.src ?? "穿戴负面"}」照实结算。`, p.id);
      } else {
        this.msg("item", `${p.name} 轻装上阵被动：穿戴类负面减半——「${m.src ?? "穿戴负面"}」只算半层（1/2）。`, p.id);
      }
    }
  }

  // ---------- T4b1 新原语执行（重掷/换位/清障） ----------

  /** 时光怀表（表一 #2）：重掷本次走格骰——沿用本骰修正批重抛，新面替换余步（先走步数照算；
   *  新面小于已走时余步为负=沿来路栈倒回补差，走格机制天然吸收） */
  private doReroll(p: PlayerState, now: number): void {
    const w = p.walk;
    if (!w || !w.dice || w.remaining <= 0) {
      // itemPlayGate 已前置校验；此处兜底不打断状态（数据坏账也不炸局）
      this.msg("item", `${p.name} 的重掷落了空——本次走格骰不在路上。`, p.id);
      return;
    }
    const mods = w.mods ?? [];
    const { raw, d } = this.tossWalkRoll(mods);
    const walked = w.total - w.remaining; // 先走步数照算
    const old = w.total;
    w.total = d;
    w.remaining = d - walked;
    this.emit({ type: "roll", pid: p.id, d, auto: false, ...(mods.length > 0 ? { mods } : {}) });
    const calc = mods.length > 0 ? `${raw}（${modDetail(mods)}）= ${d}` : `${d}`;
    this.msg("item", `${p.name} 「时光怀表」倒转——走格骰重掷 ${calc}（原 ${old} 点）：先走 ${walked} 步照算，余 ${w.remaining} 步。`, p.id, {
      emphasis: "highlight",
    });
  }

  /** 偷天换日（表一 #8）：与打出者互换位置——双方须在主干道（执行时复校：挂账一回合后状态可能已变）；
   *  来向/来路栈清空（退格从零重审），净步（行进进度）各保留。 */
  private doSwap(p: PlayerState, ctx: GuardCtx | undefined): void {
    const kindOf = ctx?.kind ?? "item";
    if (!ctx) {
      this.msg(kindOf, `${p.name} 的换位落空——没有换位对象，效果散去。`, p.id);
      return;
    }
    const src = this.player(ctx.srcPid);
    const ok = (r: PlayerState) => !r.dead && r.zone === "main";
    if (!ok(p) || !ok(src)) {
      this.msg(kindOf, `${src.name} 与 ${p.name} 的换位落空（有人不在主干道上），效果散去。`, p.id);
      return;
    }
    const a = p.pos;
    p.pos = src.pos;
    src.pos = a;
    for (const r of [p, src]) {
      r.from = null;
      r.trail = [];
    }
    this.msg(kindOf, `${src.name} 与 ${p.name} 换了个位置——天地对调！（净步各保留）`, p.id, {
      ...(p.id === ctx.srcPid ? {} : { targets: [src.id] }),
      emphasis: "big",
    });
  }

  /** 清障符（表一 #18）：清除当前格起前方 v 格内全部场地型卡（含当前格；来路格作「前方」的后界——
   *  只挡扩张、不清除）。收走同踩中即消的口径回池（弃牌堆），防弃牌堆洗回抽双。返回收走张数。 */
  private clearGroundForward(p: PlayerState, depth: number): number {
    const swept = new Set<number>([p.pos]); // 清除范围
    const visited = new Set<number>([p.pos, ...(p.from != null ? [p.from] : [])]); // 防重访（来路是背后——不扩张也不清）
    let frontier = [p.pos];
    for (let d = 0; d < depth; d++) {
      const next: number[] = [];
      for (const id of frontier) {
        for (const link of this.cell(id).links) {
          if (visited.has(link)) continue;
          visited.add(link);
          swept.add(link);
          next.push(link);
        }
      }
      frontier = next;
    }
    const hit = this.state.ground.filter((g) => swept.has(g.cell));
    if (hit.length > 0) {
      this.state.ground = this.state.ground.filter((g) => !swept.has(g.cell));
      for (const g of hit) this.state.itemDiscard.push(g.cardId);
    }
    return hit.length;
  }
}

// ---------- 道具打出闸与合法目标（内核执行 + 壳层 T4a2 置灰共用一份口径） ----------

/** 打出闸结果：拒绝时带玩家向原因（壳层 toast/置灰提示） */
export type PlayGate = { ok: true } | { ok: false; reason: string };

/** 打出时机锁：确认结束之前的窗内任意时刻（含未掷/走格中）、张数不限。
 *  淘汰=观战不出手；罚停轮空窗不出手；通关席按一页纸/GLOSSARY「仍可打卡整蛊」留 chooseOther/auto 两个口子
 *  （auto=系统指认的整蛊通道，T4b1 扩口；自用类无意义、场地卡会搁其出生格、ambient 气候无指认口子——
 *  三类一并收紧，T4a2 壳层亦隐藏入口；若实玩想放行 ambient 整蛊，改这一行即可）。重掷类（时光怀表）：
 *  走格骰发团的走在路上才可打。 */
export function itemPlayGate(state: GameState, pid: number, cardId: string): PlayGate {
  const p = state.players[pid];
  if (!p) return { ok: false, reason: `玩家 ${pid} 不存在` };
  if (state.phase !== "acting") return { ok: false, reason: "只有世界回合窗内可以打道具卡" };
  if (p.dead) return { ok: false, reason: "已淘汰观战，不能再出手" };
  const card = ITEM_CARD_BY_ID.get(cardId);
  if (!card) return { ok: false, reason: `道具卡 ${cardId} 不在表一` };
  if (!p.hand.includes(cardId)) return { ok: false, reason: "这张卡不在你的手牌里" };
  if (p.skipped) return { ok: false, reason: "本回合罚停轮空——不能出手" };
  if (p.zone === "done") {
    if (card.route === "chooseOther" || card.route === "auto") {
      return { ok: true };
    }
    return { ok: false, reason: "通关席不再行动——只留指认他人的整蛊卡出手" };
  }
  if (p.confirmed) return { ok: false, reason: "已确认结束（等待区），本窗不能再打" };
  if (itemHasPart(card, "reroll")) {
    // 时光怀表：重掷说的是「本次走格骰」——骰发团的走在路上才可打
    if (!p.walk) {
      if (p.rolled) return { ok: false, reason: "本次走格骰已走完——重掷窗口已过" };
      return { ok: false, reason: "走格骰还没掷出或不在路上——重掷无从说起" };
    }
    if (!p.walk.dice) return { ok: false, reason: "本次走在效果轨上——重掷无从说起" };
    if (p.walk.remaining <= 0) return { ok: false, reason: "本次走格骰已走完——重掷窗口已过" };
  }
  return { ok: true };
}

/** 合法目标集合（chooseOther 类；其余路由空数组）：未淘汰、未通关席、非本人（T4a2 目标选择器消费）；
 *  偷天换日（swap）额外要求目标在主干道——支路/通关席态不能换位（T4b1）。 */
export function itemLegalTargets(state: GameState, pid: number, cardId: string): number[] {
  const card = ITEM_CARD_BY_ID.get(cardId);
  if (!card || card.route !== "chooseOther") return [];
  const swap = itemHasPart(card, "swap");
  return state.players
    .filter((q) => !q.dead && q.zone !== "done" && q.id !== pid)
    .filter((q) => !swap || q.zone === "main")
    .map((q) => q.id);
}
