/**
 * 规则内核（M1）：权威逻辑层，一次意图入 → 新权威状态 + 事实 + 战报 slice。
 * 参照：ADR 0001/0002、一页纸规则 v4、#13 v3 走格手感 stub（原路栈/选路/反弹机制已实玩验证）。
 *
 * 计时语义（世界·即时，单机本地计时）：
 *   输入 now 由壳层（shell 时钟）提供，内核自身不读时钟——全部对时可由 t 系列单测驱动。
 *   #7 定案：全员同窗行动、掷完立刻逐格走、全员完成提前开窗、超时替掷并自动确认（不替打卡）。
 */
import { BOARD, BRANCH_LEN, ECO_NAMES, MAIN_PLAYABLE_CELLS, NET_GOAL, SPAWN_SLOTS, STREET_NAMES, STREET_RUNS, cellAt, spawnMenu, type BoardCell } from "./board";
import { DC_TIERS, M1_EVENT_POOL, EVENT_CARD_BY_ID, type CardEffect, type CheckSpec, type DiceMod, type EffectPart, type EventCard } from "./data/events";
import { ITEM_CARD_BY_ID, LEGIT_ITEM_CARDS, M1_ITEM_POOL, itemCard, itemHasPart } from "./data/items";
import { trapDefAt } from "./data/traps";
import { AXIS_NAMES, ROLES, roleDef } from "./data/roles";
import { SECRET_GOALS, secretGoal } from "./data/goals";
import { computeSettlement, finishScore } from "./settle";
import { CHECK_FACES, effectiveValue, netMods, resolveCheck, roleCheckMods, roleOneToCrit, rollD20, rollDice, type CheckGrade, type CheckMods, type CheckResolve } from "./check";
import { rngStatesFrom, rngStream, RNG_STREAM_NAMES, type Rng, type RngStates, type RngStreamName, type RngState } from "./rng";
import type { BeastState, WalkState } from "./types";
import {
  KernelError,
  type CustomsGiveReason,
  type DogState,
  type Fact,
  type GameConfig,
  type GameState,
  type Intent,
  type MessageEntry,
  type MessageKind,
  type MsgTag,
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
  maliceEvery: 3,
  maliceLevel: "mild",
};

/** 卡牌效果来源上下文（T4b1）：kind=道具卡/事件卡通道、srcPid=打出者——小圆盾「免疫他人卡牌效果」的拦截判据 */
type GuardCtx = { kind: "item" | "event"; srcPid: number };

/** 配置域（#16 问题陈述 2：局长 5–30／血量 5–20／窗 10–90s／休息 0–20s／恶意周期 2–5 波间隔）。
 *  壳层表单（大厅滑条）直接消费这份常量，域改一处即全端生效。 */
export const CONFIG_LIMITS = {
  turnCap: [5, 30],
  maxHp: [5, 20],
  windowMs: [10_000, 90_000],
  restMs: [0, 20_000],
  maliceEvery: [2, 5],
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

/** 世界恶意四型定案参数（数值表 §5.5「四型均分」；野狗=T6b 第四型并入）。
 *  客户端文案（大厅提示/棋盘 title）引用常量不硬编——改一处全端生效。 */
export const TIMBER_CELLS = 3; // 🪵 木头砸落的格数（预警阴影=这 3 格）
export const ROCK_LEN = 10; // 🪨 滚石沿街滚过的路段格数
export const SINK_CELLS = 6; // 🕳 塌陷一次裂开的格数
export const SINK_TURNS = 2; // 塌陷区存续的世界回合数（开窗递减，归零复原）
export const DOGS_PER_WAVE = 3; // 🐕 野狗一波生成的只数（数值表「野狗 ×3」）
export const DOG_HP = 4; // 🐕 单只野狗血量（世界恶意/遭遇战各可扣）
export const DOG_TURNS = 3; // 🐕 野狗寿命（世界回合数，含出生窗：出生那窗=第 1 个世界回合）
export const DOG_FIGHT_DC = DC_TIERS.mid; // 🐕 遭遇战力检 DC（表五中档 12——无一色加值时通过率 45%）

/** 警长查货窗（#26 T7，一页纸「警长查货窗」节）定案参数：
 *  查验 ≤2 次（**6 人以上局** 3 次——按局人数，票面字面口径）；罚没/赔付无卡回退 3 格；
 *  查验窗口=15s 不查即退化（每查验一次续期——「超时不查→自由转让」的时钟口径，绝不阻塞操作）。 */
export const CUSTOMS_CHECKS = 2;
export const CUSTOMS_CHECKS_BIG = 3;
export const CUSTOMS_BIG_AT = 6;
export const CUSTOMS_RETREAT = 3;
export const CUSTOMS_CHECK_MS = 15_000;

/** 通关分分位（#35 T8a1 落定、#36 T8b1 迁位——数值表 §5.1 真源现居 settle.ts 单一导出，
 *  game.ts 经它消费 finishAtSeat 的 flavor 分位）：首通 +10／次通 +8／第三 +6，第四位起无分位。
 *  入席先后序=state.finishers（踩进先后，T1 基座）。 */

/** 最后一波·年兽战（#27 T8a2，数值表 §5.5「最后一波 B」用户拍）：共享血条按人数自平衡——
 *  基础 25+每玩家 15（2 人=55／4 人=85／6 人=115／8 人=145）；伤害骰 1d12（爆 12 爽点）。
 *  4 人期望 26/波 → 约 3–3.5 波收束。客户端文案（Dock/HandDock/大厅）引常量不硬编。 */
export const BEAST_BASE_HP = 25;
export const BEAST_HP_PER_PLAYER = 15;
export const BEAST_DIE = 12;

/** 明面正货清单（报备校验域/壳层报备名池共用——单一来源=data/items 的 LEGIT_ITEM_CARDS） */
const LEGIT_ITEM_IDS: readonly string[] = LEGIT_ITEM_CARDS.map((c) => c.id);

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

  /** 五条命名 RNG 流（rng.ts）：setup=开局分发／deck=事件牌堆／items=道具牌堆／dice=走格骰+检定／world=世界恶意+野狗 */
  private rngHosts: Record<RngStreamName, RngState>;
  private rngs: Record<RngStreamName, Rng>;
  /** 🐕 当局野狗编号发号（DogState.id=壳层 token 稳定 key） */
  private dogSeq = 0;
  /** 🚢 当局海关报备单号发号（CustomsShipment.id=查验意图的指单 key） */
  private customsSeq = 0;

  private constructor(config: GameConfig, defs: PlayerDef[], now: number) {
    // 随机源先立：假人角色分派与暗牌抽取都消耗它（顺序固定=同种子全序流；五流拆分见 rng.ts）
    this.config = config;
    this.rngHosts = {} as Record<RngStreamName, RngState>;
    this.rngs = {} as Record<RngStreamName, Rng>;
    for (const n of RNG_STREAM_NAMES) {
      const { rng, host } = rngStream(config.seed, n);
      this.rngs[n] = rng;
      this.rngHosts[n] = host;
    }
    // 人数域与落座菜单都在 create（2..8 校验+spawnMenu 档位）先行拦截，此处不再重复
    const menu = spawnMenu(defs.length);
    /** 暗牌逐人独立抽（10 条池内抽 2 且必不相同；不同玩家之间可同条——不互斥） */
    const draftPair = (): [number, number] => {
      const a = SECRET_GOALS[this.rngs.setup.int(SECRET_GOALS.length)]!.no;
      let b = SECRET_GOALS[this.rngs.setup.int(SECRET_GOALS.length)]!.no;
      while (b === a) b = SECRET_GOALS[this.rngs.setup.int(SECRET_GOALS.length)]!.no;
      return [a, b];
    };
    this.state = {
      turn: 1,
      // 开局暗牌抽 2 选 1 挂起（drafting）：真人选定后 openWindow 开第一窗
      phase: "drafting",
      windowDeadline: 0,
      restUntil: 0,
      players: defs.map((d, i) => {
        const rd = roleDef(d.roleId ?? (d.isBot ? ROLES[this.rngs.setup.int(ROLES.length)]!.id : "light"));
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
          secretPick: d.isBot ? this.rngs.setup.int(2) : null,
          botSchedule: { rollAt: now, confirmAt: 0 },
          walk: null,
          walkQueue: [],
          cardPending: null,
          cardDraws: 0,
          hand: [],
          rollMods: [],
          checkMods: [],
          wearHalves: 0,
          itemBan: 0,
          itemBanned: false,
          endgame: null,
        };
      }),
      finishers: [],
      messages: [],
      // 事件牌堆：单池洗匀（表二 20 张；'window' 卡 T7 放行——事件定案 §1.8 抽完即洗回弃牌堆）
      deck: this.rngs.deck.shuffle(M1_EVENT_POOL.map((c) => c.id)),
      discard: [],
      // 道具牌堆：单池洗匀（表一 20 张全量，T4b2 收口——事件定案 §1.8 同口径）
      itemDeck: this.rngs.items.shuffle(M1_ITEM_POOL.map((c) => c.id)),
      itemDiscard: [],
      ground: [],
      ambient: null,
      deferred: [],
      customs: null,
      endgame: null,
      malice: { timber: null, sink: null, rock: null, spawnQueue: [], dogs: [] },
      seq: 0,
      rngStates: rngStatesFrom(config.seed),
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
    this.syncRng();
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
    if (merged.maliceLevel !== "mild" && merged.maliceLevel !== "fierce" && merged.maliceLevel !== "off") {
      throw new KernelError("世界恶意档位未知（mild=温和 / fierce=猛 / off=关闭）");
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
    extra: { targets?: number[]; flavor?: string; emphasis?: MessageEntry["emphasis"]; tags?: MsgTag[]; cards?: string[] } = {},
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
      ...(extra.tags?.length ? { tags: extra.tags } : {}),
      ...(extra.cards?.length ? { cards: extra.cards } : {}),
    });
  }

  /** 消耗指定流的随机源；每次消耗都同步进 state（快照可恢复随机流）。
   *  流必填=新增消费点必须自觉归流（五流口径见 rng.ts：骰=dice、牌堆序=deck/items、其余世界层随机=world）。 */
  private draw(stream: RngStreamName): number {
    const v = this.rngs[stream].next();
    this.state.rngStates[stream] = this.rngHosts[stream].s;
    return v;
  }

  /** 批量消耗后的一次性同步（走 rollDice/shuffle 等直接吃流的路径用） */
  private syncRng(): void {
    for (const n of RNG_STREAM_NAMES) this.state.rngStates[n] = this.rngHosts[n].s;
  }

  // ---------- 公开 API ----------

  /** 受理一个意图；拒绝即抛 KernelError（不产生半截状态变更） */
  apply(intent: Intent, now: number): Fact[] {
    switch (intent.type) {
      case "roll": {
        if (this.fighting()) throw new KernelError("最后一波不走格——掷伤害骰砍年兽（strike）");
        this.doRollChecked(intent.pid, now, "human");
        break;
      }
      case "confirm": {
        if (this.fighting()) throw new KernelError("最后一波无需确认——砍了就算完");
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
      case "customsShip": {
        this.doCustomsShip(intent.pid, intent.cardId, intent.to, intent.declared);
        break;
      }
      case "customsCheck": {
        this.doCustomsCheck(intent.pid, intent.shipment, now);
        break;
      }
      case "customsGive": {
        this.doCustomsGive(intent.pid, intent.cardId, now);
        break;
      }
      case "strike": {
        this.doStrikeChecked(intent.pid, "human");
        break;
      }
      case "giveItem": {
        this.doGiveItem(intent.pid, intent.cardId, intent.to);
        break;
      }
      case "hitBeast": {
        this.doHitBeast(intent.pid, intent.cardId);
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
        // 直接走淘汰流程单口径（T5c）：挂账清理/手牌回弃/播报/事实与真实血尽同构——
        // 测试用它造假人退场时，撞上的便是淘汰后真实可复现的棋盘状态
        this.retirePlayer(this.player(intent.pid));
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
      case "dev.spawnDog": {
        if (!this.config.allowDev) throw new KernelError("dev 意图未开放");
        if (!Number.isInteger(intent.cell) || intent.cell < 0 || intent.cell >= BOARD.length)
          throw new KernelError("格 id 越界");
        this.spawnDogAt(intent.cell);
        this.dogCollisions(now); // 生成当拍撞上=遭遇战照打（与真波生成同口径）
        break;
      }
      case "dev.customs": {
        if (!this.config.allowDev) throw new KernelError("dev 意图未开放");
        this.openCustoms(this.eventCard("e21"), now, intent.sheriff);
        break;
      }
      case "dev.setBeast": {
        if (!this.config.allowDev) throw new KernelError("dev 意图未开放");
        const b = this.state.endgame?.beast;
        if (!b) throw new KernelError("年兽战未开张——dev.setBeast 无处落账");
        if (!Number.isInteger(intent.hp) || intent.hp < 0) throw new KernelError("年兽血量应为非负整数");
        b.hp = intent.hp;
        if (b.hp === 0) this.slayBeast(); // 钉 0=当场击杀（胜利收束的确定性通道）
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
      this.tickCustoms(now); // 海关风云（#26 T7）：假人报备排程/罚没代选/超时退化
      this.advanceWalks(now);
      this.maybeCloseWindow(now);
      // 全员确认已被 maybeCloseWindow 收走的窗不再二次收口（一 tick 双吞世界回合——T8a1 收局边界实测踩中）
      if (this.state.phase === "acting" && now >= this.state.windowDeadline) {
        if (this.fighting()) this.autoStrikeAndClose(now); // 年兽战波窗：超时替砍（T8a2）
        else this.autoFillAndClose(now);
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
      p.botSchedule.rollAt = now + 400 + p.id * 350 + Math.floor(this.draw("world") * 700);
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
      const landed = this.applyParts(p, d.parts, now, { kind: d.kind, srcPid: d.srcPid });
      // 自我整蛊守卫与 turn 分支同款（当前调用图不可达——挂账仅自 dispatchToOthers 的排除后目标；护栏保一致）
      if (landed && d.grudgeLabel && d.srcPid !== p.id) this.grudgeLanded(d.srcPid, p, d.kind, d.grudgeLabel);
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
    // 禁道具：挂账逐窗消费（#33 T5b 沙困行囊）——置位本窗打不出道具，出窗自然解除
    for (const p of this.state.players) {
      p.itemBanned = p.itemBan > 0;
      if (p.itemBan > 0) {
        p.itemBan -= 1;
        if (!p.dead) {
          this.msg("trap", `${p.name} 行囊灌满沙——本回合禁道具。`, p.id, { emphasis: "target" });
        }
      }
    }
    // 环境卡气候（《生物圈 3 号》三原则，#32 T4b2）：每个世界回合「行动前」结算一次——
    // 雷暴=随机劈 1 名在场者回退（按所在格生态地形行）；暴雨/风暴按所在生态地形行上判定/修正。轮空者无行动不判（罚停消耗之后。
    this.tickAmbient(now);
    // 世界恶意（#24 T6a，数值表 §5.5 管道）：气候之后、windowStart 之前——同为世界层「行动前」
    // 结算：先落旧账（木头砸落/塌陷计时），再按周期起新波。全程不打断操作。
    this.tickMalice(now);
    // 海关风云（#26 T7）：休息期抽到的（走路跨窗尾）在本窗正式摆摊——计时/假人排程从此起算
    if (this.state.customs && !this.state.customs.armed) this.armCustoms(now);
    this.emit({ type: "windowStart", turn: this.state.turn, deadline: this.state.windowDeadline });
    this.reserveBots(now);
  }

  private fireBots(now: number): void {
    const fight = this.fighting(); // 年兽战（T8a2）：假人日程=到点砍击（无走格无确认——砍了就算完）；通关席假人也必参战
    for (const p of this.state.players) {
      if (!p.isBot || p.dead || (!fight && p.zone === "done")) continue;
      if (!p.rolled && now >= p.botSchedule.rollAt) {
        if (fight) {
          this.doStrike(p.id, "bot");
          if (this.state.phase !== "acting") break; // 这一刀砍死了年兽——收束已落，后续假人不再补刀
          continue;
        }
        if (p.walk || p.walkQueue.length > 0) {
          // 卡面/指认造成的续走在路上：稍候重试，不让掷骰撞 KernelError
          p.botSchedule.rollAt = now + BOT_WALK_RETRY_MS;
        } else {
          this.doRollChecked(p.id, now, "bot");
        }
      }
      if (!fight && p.rolled && !p.confirmed && !p.walk && p.cardPending == null && now >= p.botSchedule.confirmAt) {
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
      const victim = act[Math.floor(this.draw("world") * act.length)];
      if (victim) {
        const eco = this.cell(victim.pos).zone; // 支路里的人 pos=出生格（平原）——行军地貌按所在格统一口径
        const steps = w.strike[eco] ?? 0;
        if (steps > 0) {
          this.msg("item", `⛈ 雷暴劈下——${victim.name} 在${ECO_NAMES[eco]}被劈中，回退 ${steps} 步。`, victim.id, {
            emphasis: "target",
            tags: ["ambientDown"],
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
          this.msg("item", `🌪 「${card.title}」狂风扑面——${p.name} 在${ECO_NAMES[eco]}的下次走格骰 ${modSigned(wind.walkMod.v)}（顶风逆行）。`, p.id, {
            ...(wind.walkMod.v < 0 ? { tags: ["ambientDown" as const] } : {}),
          });
        }
        if (wind.checkMod) {
          p.checkMods.push(wind.checkMod);
          this.msg("item", `🌪 「${card.title}」沙暴漫天——${p.name} 在${ECO_NAMES[eco]}本回合所有检定 ${modSigned(wind.checkMod.v)}。`, p.id, {
            ...(wind.checkMod.v < 0 ? { tags: ["ambientDown" as const] } : {}),
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
    const raw = rollDice(this.rngs.dice, { adv: 0, advCount: 0 }, row.faces);
    this.syncRng();
    if (raw > row.guard) return;
    this.msg("item", `⚖ 「${cardTitle}」摔倒判定 d${row.faces}(${raw})≤${row.guard}——${p.name} 摔倒了！`, p.id, {
      emphasis: "target",
      tags: ["ambientDown"],
    });
    if (row.onFall.length > 0) this.applyParts(p, row.onFall, now);
  }

  // ---------- 世界恶意（#24 T6a，数值表 §5.5 管道与三型） ----------

  /** 世界恶意伤害（强度档）：温和 −1／猛 −2——三型（滚石追命/木头砸落/塌陷踩入）同一档位账。 */
  private maliceDmg(): number {
    return this.config.maliceLevel === "fierce" ? 2 : 1;
  }

  /** 战报里的落点点名：生态·街名（同街多格同名可接受——落点的视觉真锚在棋盘阴影/图皮上） */
  private cellTag(id: number): string {
    const c = this.cell(id);
    return `${ECO_NAMES[c.zone]}·${STREET_NAMES[c.street]}`;
  }

  /** 世界层「咬一口」三连收口（T6a 三型共享的结算形）：战报点名 + applyHpDelta（档位伤害·malice 分色）
   *  + 受害者脉冲事实。非卡通道不传 ctx——小圆盾不拦天灾。 */
  private maliceStrike(p: PlayerState, text: string): void {
    this.msg("malice", text, p.id, { targets: [p.id], emphasis: "target" });
    this.applyHpDelta(p, -this.maliceDmg(), "malice");
    this.emit({ type: "pulse", pid: p.id, level: "target" });
  }

  /** 世界回合开始的世界层结算（openWindow 在气候之后调用）：先落旧账（上一波挂的木头砸落、
   *  塌陷存续计数、野狗花名册生活账），再按周期起新波（每 maliceEvery 世界回合一波；四型 rng
   *  均分——野狗=T6b 第四型）。管道纪律（数值表 §5.5)：世界层**全程不打断操作**——不碰
   *  rolled/confirmed/walk/cardPending，一切经战报 🌲 条目承载；扣血一律走 applyHpDelta
   *  单入口（T5a 后备渠道口径，护身符/皮糙肉厚盾照拦）。 */
  private tickMalice(now: number): void {
    // —— 旧账 1：木头砸落。预警窗=1 个世界回合（挂账于上一波，本窗开始即砸）：
    //    窗内移动离开落点=天然免伤，预警才真的有用。砸中=对落点上每个主干道活人各判各扣；
    //    落点上的野狗也挨砸（世界层互击——对狗固定 −1，不吃档位翻账）。
    const timber = this.state.malice.timber;
    if (timber) {
      this.state.malice.timber = null;
      let hit = 0;
      for (const c of timber) {
        for (const p of this.state.players) {
          if (p.dead || p.zone !== "main" || p.pos !== c) continue;
          this.maliceStrike(p, `🪵 大木头轰然砸中 ${p.name} 所在的落点！`);
          hit += 1;
        }
        this.dogsHitAt(c, "大木头轰然砸中");
      }
      if (hit === 0) {
        this.msg("malice", `🪵 大木头轰然砸在预定的 ${timber.length} 个落点上——还好上空无人。`);
      }
    }
    // —— 旧账 2：塌陷存续计数（开窗递减；归零=复原出声） ——
    const sink = this.state.malice.sink;
    if (sink) {
      sink.left -= 1;
      if (sink.left <= 0) {
        this.state.malice.sink = null;
        this.msg("malice", `🕳 塌陷区终于平复——地面重新结好（${SINK_TURNS} 世界回合到期）。`);
      }
    }
    // —— 旧账 3：野狗花名册生活账（#25 T6b）：寿命递减→消散出声→存活者随机移动或留守→撞上玩家照打遭遇战
    this.tickDogs(now);
    // —— 旧账 4：狗笛挂账出队（无条件——狗是道具起的狗，世界恶意 off 档也不吃它的悬挂账）
    this.consumeDogQueue(now);
    // —— 新波：周期到点（turn 从 1 起：turn%every==0 的那个回合开窗时触发——默认第 3 回合起波） ——
    if (this.config.maliceLevel === "off") return;
    if (this.state.turn % this.config.maliceEvery !== 0) return;
    this.msg("malice", `🌲 世界恶意第 ${Math.floor(this.state.turn / this.config.maliceEvery)} 波——庄园上的不测之祸又来了。`, undefined, {
      emphasis: "highlight",
    });
    // 选型：木头需要「下一世界回合砸落」的预警窗——局末波点（turn==turnCap，下一回合即进 T8 终局）压成滚石赶路，
    // 遇免预警悬挂到结算的死账；狗/塌陷挂到终局也无人再结——同账全体让位。终局份量由 T8 的「最后一波」加强档接管。
    // 四型=下标 0..3 一张共表（木头/滚石/塌陷/野狗，rng 均分）；末回合取滚石=下标 1，无魔法数字散落。
    const timberable = this.state.turn < this.config.turnCap;
    const kind = timberable ? this.rngs.world.int(4) : 1;
    this.syncRng();
    const kinds: Array<(now: number) => void> = [
      () => this.waveTimber(),
      (n) => this.waveRock(n),
      (n) => this.waveSink(n),
      (n) => this.waveDogs(n),
    ];
    kinds[kind]!(now);
  }

  /** 🐕 野狗每世界回合生活账（tickMalice 旧账位）：寿命递减→归零消散出声；存活者每回合随机移动或
   *  留守（各半；落点=相邻等概率，环岛/出生格也走——野狗我行我素）；动完做一次同格撞上清账。
   *  排序纪律：狗先动再清账——「挪走了就当没撞上」，狗与玩家的遭遇账不回头追溯既有同格。 */
  private tickDogs(now: number): void {
    const dogs = this.state.malice.dogs;
    if (dogs.length === 0) return;
    const dissipated: DogState[] = [];
    const survivors: DogState[] = [];
    for (const d of dogs) {
      d.left -= 1;
      if (d.left <= 0) dissipated.push(d);
      else survivors.push(d);
    }
    this.state.malice.dogs = survivors;
    if (dissipated.length > 0) {
      this.msg("malice", `🐕 ${dissipated.length} 只野狗游荡期满——溜回林子深处没了踪影。`);
    }
    for (const d of survivors) {
      if (this.rngs.world.int(2) === 0) continue; // 留守：趴着不走（各半，实现期定案）
      const links = this.cell(d.cell).links;
      d.cell = links[Math.floor(this.draw("world") * links.length)]!;
    }
    this.dogCollisions(now);
  }

  /** 狗笛挂账出队结算（dogSpawn 原语入队 → 本窗 tickDogs 之后消费）：出队即入册=标准狗
   *  （出生窗免减寿——与波生同段位）；出队当拍同格撞上=遭遇战照打。 */
  private consumeDogQueue(now: number): void {
    const queue = this.state.malice.spawnQueue;
    if (queue.length === 0) return;
    this.state.malice.spawnQueue = [];
    for (const req of queue) {
      this.spawnDogAt(req.cell);
      const tgt = this.player(req.target);
      this.msg("item", `🐕 「狗笛」一声长鸣——一只野狗循声现身在 ${tgt.name} 旁边的 ${this.cellTag(req.cell)}！`, req.target, {
        emphasis: "target",
      });
    }
    this.dogCollisions(now);
  }

  /** 同格撞上清账：每一只狗逐只与格上主干道活人各判各打（一狗可被同格多头围打——先打死狗，
   *  死狗 hp=0 的守卫拦下后来者的复打零双份战利品；血尽淘汰者当场退出不再接咬）。 */
  private dogCollisions(now: number): void {
    for (const d of [...this.state.malice.dogs]) {
      if (d.hp <= 0) continue;
      for (const p of this.state.players) {
        if (d.hp <= 0) break; // 被上一位打死——按快照循环里跳死狗（kill 清账见 dogFight）
        if (p.dead || p.zone !== "main" || p.pos !== d.cell) continue;
        this.dogFight(d, p, now);
      }
    }
    this.removeDeadDogs();
  }

  /** 🪵 木头：落点提前定并挂预警阴影（3 个 主网可落格），下一世界回合开始砸落。 */
  private waveTimber(): void {
    const cells = this.rngs.world.shuffle([...MAIN_PLAYABLE_CELLS]).slice(0, TIMBER_CELLS).sort((a, b) => a - b);
    this.syncRng();
    this.state.malice.timber = cells;
    this.msg(
      "malice",
      `🪵 大木头悬空！预警阴影罩上 ${cells.map((id) => this.cellTag(id)).join("、")}——下一世界回合开始砸落，正在格上的人速离。`,
      undefined,
      { emphasis: "highlight" },
    );
  }

  /** 🪨 滚石：从一条够长的直线街段随机切出 10 格连续路段一次滚完——滚到的格上有主干道活人
   *  =被追上，敏检 DC12（同一检定通道：沙暴修正批/轴系特长同吃互抵）：通过（含大成功）=
   *  闪开不伤；失败（含大失败）=扣血。世界层判定不吃力检特长的 dogFight scope（scope 缺省=全检定生效——
   *  猎手不适用，蛮力/狡运对应轴不沾）。滚到的格上有野狗=世界层互击（狗也挨砸，dogHit 随路判）。 */
  private waveRock(now: number): void {
    const runs = STREET_RUNS.filter((r) => r.cells.length >= ROCK_LEN);
    const run = runs[this.rngs.world.int(runs.length)]!;
    const offset = this.rngs.world.int(run.cells.length - ROCK_LEN + 1);
    const path = run.cells.slice(offset, offset + ROCK_LEN);
    this.syncRng();
    this.state.malice.rock = path;
    this.msg(
      "malice",
      `🪨 塌坡滚石！从 ${this.cellTag(path[0]!)} 轰隆启程，沿街滚过 ${ROCK_LEN} 格路段——被追上要扣血，敏检 DC12 可躲开。`,
      undefined,
      { emphasis: "highlight" },
    );
    for (const c of path) {
      for (const p of this.state.players) {
        if (p.dead || p.zone !== "main" || p.pos !== c) continue;
        const res = this.runCheck(p, { axis: "agile", dc: 12 }, now, undefined, "malice");
        if (res.grade === "pass" || res.grade === "crit") {
          this.msg("malice", `${p.name} 侧身一闪——滚石擦身而过，毫发无伤。`, p.id, { targets: [p.id], emphasis: "target" });
        } else {
          this.maliceStrike(p, `${p.name} 没躲开，被滚石追上！`);
        }
      }
      this.dogsHitAt(c, "滚石碾过");
    }
    this.msg("malice", `🪨 滚石滚过 ${ROCK_LEN} 格路段，怼出庄园外扬长而去。`);
  }

  /** 🕳 塌陷区：随机种子格 BFS 扩 6 格（环岛/出生格不裂也不占配额继续找），裂开挂账塌
   *  SINK_TURNS 世界回合；裂开当时站进裂开区的人立即负伤（实现期定案——「塌了人还站着」是无声怪事，
   *  收账注记回表），此后踩入走 landOn 通道（sinkHit）。周期域 2..5 ≥ SINK_TURNS=2：新波开波前
   *  旧区必然已在 tickMalice 旧账处递减到 0 复原清账，塌陷区永不叠加。 */
  private waveSink(now: number): void {
    const cells = this.sinkCells();
    this.state.malice.sink = { cells, left: SINK_TURNS };
    this.msg(
      "malice",
      `🕳 地面蛋壳般裂开！${this.cellTag(cells[0]!)} 一带塌陷 ${cells.length} 格，塌 ${SINK_TURNS} 世界回合——踩进去要吃亏。`,
      undefined,
      { emphasis: "highlight" },
    );
    for (const p of this.state.players) {
      if (!p.dead && p.zone === "main" && cells.includes(p.pos)) this.sinkHit(p);
    }
    for (const c of cells) {
      this.dogsHitAt(c, "塌方裂开时吞了进去");
    }
  }

  /** 选塌陷区：洗匀的种子池从首个能凑满 SINK_CELLS 的种子格 BFS（邻域扩时跳过环岛与出生格）。 */
  private sinkCells(): number[] {
    const pool = this.rngs.world.shuffle([...MAIN_PLAYABLE_CELLS]);
    for (const seed of pool) {
      const seen = new Set<number>([seed]);
      const cells = [seed];
      let frontier = [seed];
      while (frontier.length > 0 && cells.length < SINK_CELLS) {
        const next: number[] = [];
        for (const id of frontier) {
          for (const l of this.cell(id).links) {
            if (seen.has(l)) continue;
            const c = this.cell(l);
            if (c.street === "J" || c.spawnIndex >= 0) continue;
            seen.add(l);
            cells.push(l);
            next.push(l);
            if (cells.length >= SINK_CELLS) break;
          }
          if (cells.length >= SINK_CELLS) break;
        }
        frontier = next;
      }
      if (cells.length >= SINK_CELLS) return cells.sort((a, b) => a - b);
    }
    return pool.slice(0, SINK_CELLS).sort((a, b) => a - b); // 兜底理论不可达（主网稠密连通，逐种子试必成）
  }

  /** 踩入塌陷区（#24 T6a）：裂开当刻的在场者与此后每次 landOn 踩进的人各判一咬（每次踩进各算各的）；
   *  无检定直扣（数值表 §5.5「踩进扣血」纯损格式）；扣血走 applyHpDelta 单入口（护身符/盾照拦）。 */
  private sinkHit(p: PlayerState): void {
    const sink = this.state.malice.sink;
    if (!sink || !sink.cells.includes(p.pos)) return;
    this.maliceStrike(p, `🕳 ${p.name} 踏进塌陷区——塌方的边缘啃了他一口！`);
  }

  // ---------- 世界恶意 · 野狗（四型第四档，#25 T6b） ----------

  /** 🐕 野狗出没：一波生成 DOGS_PER_WAVE 只标准野狗——落点=主网可落格洗匀（同木头池照片矩：
   *  排环岛与出生格——出生格是开局/传送回复位不动点）。生成当拍同格撞上=当场遭遇战（强制）。 */
  private waveDogs(now: number): void {
    const cells = this.rngs.world.shuffle([...MAIN_PLAYABLE_CELLS]).slice(0, DOGS_PER_WAVE);
    this.syncRng();
    for (const c of cells) this.spawnDogAt(c);
    this.msg(
      "malice",
      `🐕 野狗出没！${DOGS_PER_WAVE} 只野狗从林子里窜上游荡庄园（${cells.map((id) => this.cellTag(id)).join("、")}）——撞上就是一场遭遇战（力检 DC${DOG_FIGHT_DC}），无路可逃。`,
      undefined,
      { emphasis: "highlight" },
    );
    this.dogCollisions(now);
  }

  /** 单只标准野狗入册（波次生成/狗笛出队/dev 通道共用）：DOG_HP 血、寿命 DOG_TURNS 世界回合、
   *  当局自增 id（壳层 token 稳定 key） */
  private spawnDogAt(cellId: number): void {
    this.state.malice.dogs.push({ id: ++this.dogSeq, cell: cellId, hp: DOG_HP, left: DOG_TURNS });
  }

  /** 死狗清册（消灭即离册的唯一收口）：狗被恶意/玩家打死或沦为 0 血后，从这里出册 */
  private removeDeadDogs(): void {
    this.state.malice.dogs = this.state.malice.dogs.filter((d) => d.hp > 0);
  }

  /** 🐕 世界恶意砸中野狗（世界层互击）：对狗固定 −1（数值表「砸中野狗也对狗扣 1 血」——
   *  不吃档位翻账）；DOG_HP 血归零=消灭（狗被恶意/玩家打死均消灭，removeDeadDogs 出册）。 */
  private dogHit(d: DogState, cause: string): void {
    if (d.hp <= 0) return;
    d.hp -= 1;
    if (d.hp <= 0) {
      this.removeDeadDogs();
      this.msg("malice", `🐕 ${cause}一只野狗——它哀鸣着倒了下去（世界恶意也能打死狗）。`);
    } else {
      this.msg("malice", `🐕 ${cause}一只野狗——疼得它嗷了一声（剩 ${d.hp}/${DOG_HP} 血）。`);
    }
  }

  /** 🐕 某格上的野狗吃负（世界层互击收口：木头/滚石/塌陷三处共用）：随格判，一狗一咬 */
  private dogsHitAt(cellId: number, cause: string): void {
    for (const d of [...this.state.malice.dogs]) {
      if (d.cell === cellId) this.dogHit(d, cause);
    }
  }

  /** 随机薅手牌 v 张进弃牌堆（贼赃房 discard/野性直觉被咬免伤/野狗被抢三处共用账）——
   *  单池守恒：离手即入弃牌堆；无卡可薅=落空不出声（文案留给调用方）。返回薅走的卡名。 */
  private snatchCards(p: PlayerState, v: number): string[] {
    const titles: string[] = [];
    while (p.hand.length > 0 && titles.length < v) {
      const id = p.hand.splice(Math.floor(this.draw("world") * p.hand.length), 1)[0]!;
      this.state.itemDiscard.push(id);
      titles.push(itemCard(id).title);
    }
    return titles;
  }

  /** 🐕 强制遭遇战（一页纸「遭遇战细则」）：一掷四档、力检 DC12（同一检定通道走 runCheck——
   *  checkMods 沙暴批/三轴加值同吃互抵；scope=dogFight 让猎手特长恰在此域生效，滚石闪躲不吃）。
   *  四档：大成功=击毙+额外战利品再摸 1（掉落+搜窝共 2 张入袋）／通过=击毙（狗掉 1 张道具卡捡走）／
   *  失败=被咬（−1 血+退 2 格；野性直觉被动：有卡改弃 1 张免伤、无卡才扣血）／大失败=被咬+被抢
   *  1 张道具卡（随机薅手牌进弃牌堆——狗不占资产，单池守恒）。无逃跑选项；咬人照走 applyHpDelta
   *  单入口（护身符/皮糙肉厚盾照拦，T5a 渠道账）；击毙走 dogKilled 事实（暗牌「打狗英雄」T8b1 计数流）。 */
  private dogFight(d: DogState, p: PlayerState, now: number): void {
    this.msg("malice", `🐕 ${p.name} 撞上一只游荡的野狗——遭遇战一触即发！`, p.id, {
      targets: [p.id],
      emphasis: "target",
    });
    const res = this.runCheck(p, { axis: "might", dc: DOG_FIGHT_DC, tier: "mid", scope: "dogFight" }, now, undefined, "malice");
    const kill = (): void => {
      d.hp = 0; // 击毙挂血尽标记——同格后继玩家对死狗的复打被 dogCollisions 的 hp 守卫拦下（零双份战利品）
      this.removeDeadDogs();
      this.emit({ type: "dogKilled", pid: p.id });
    };
    const killMsg = (text: string, extra: { emphasis: MessageEntry["emphasis"] }): void => {
      this.msg("malice", text, p.id, { targets: [p.id], tags: ["dogKilled"], ...extra });
    };
    const bite = (): void => {
      // 野性直觉被动（表三 #5）：被咬 −1 血改弃 1 张道具卡（随机薅手牌进弃牌堆=贼赃房同口径；无卡才扣血）
      const dodge = roleDef(p.roleId).flags.dogBiteDiscard === true ? this.snatchCards(p, 1) : null;
      if (dodge) {
        this.msg("malice", `🐕 ${p.name} 被咬了一口——野性直觉让他甩下「${dodge[0]}」引开狗牙，免了这 1 血。`, p.id, {
          targets: [p.id],
        });
      } else {
        this.applyHpDelta(p, -1, "malice");
      }
      if (!p.dead) {
        this.msg("malice", `🐕 ${p.name} 连滚带爬，向后退了 2 格。`, p.id, { targets: [p.id] });
        this.startWalk(p, -2, now); // 沿来路栈退 2；走格未完则入队（世界层不打断操作）
        this.emit({ type: "pulse", pid: p.id, level: "target" });
      }
    };
    switch (res.grade) {
      case "crit": {
        kill();
        killMsg(`🐕 ${p.name} 大成功——一击毙命，野狗当场被打死，还翻出额外战利品！`, { emphasis: "target" });
        this.drawItems(p, 1, "狗嘴里掉落的"); // 击毙掉落卡捡走
        this.drawItems(p, 1, "搜出的额外战利品"); // 大成功：额外战利品再摸 1
        break;
      }
      case "pass": {
        kill();
        killMsg(`🐕 ${p.name} 击毙了野狗——狗嘴里掉出 1 张道具卡。`, { emphasis: "target" });
        this.drawItems(p, 1, "狗嘴里掉落的");
        break;
      }
      case "fail": {
        this.msg("malice", `🐕 ${p.name} 没打过野狗——挨了它结结实实的一口！`, p.id, {
          targets: [p.id],
          emphasis: "target",
        });
        bite();
        break;
      }
      case "critfail": {
        this.msg("malice", `🐕 ${p.name} 被野狗咬得人仰马翻——它还叼着东西撒欢！`, p.id, {
          targets: [p.id],
          emphasis: "target",
        });
        bite();
        const stolen = this.snatchCards(p, 1);
        if (stolen.length > 0) {
          this.msg("malice", `🐕 野狗叼走了 ${p.name} 手里的一张「${stolen[0]}」（被抢 1 张——卡回弃牌堆，狗不占资产）。`, p.id, {
            targets: [p.id],
            emphasis: "target",
          });
        } else {
          this.msg("malice", `🐕 野狗凑上来抢——${p.name} 手头无卡，野狗叼了个空。`, p.id, { targets: [p.id] });
        }
        break;
      }
    }
  }

  /** 走停落上狗格：撞上=强制遭遇战（站停才算撞上——路过不停不算；一只只轮到打，同格多头挨打）。 */
  private dogFightHere(p: PlayerState, now: number): void {
    for (const d of [...this.state.malice.dogs]) {
      if (d.hp <= 0 || d.cell !== p.pos) continue;
      if (p.dead) break; // 被前面的狗咬死了就死了——后面不再接咬
      this.dogFight(d, p, now);
    }
    this.removeDeadDogs();
  }

  // ---------- 警长查货窗（#26 T7，自由窗口唯一一张：事件卡「黑市开张」） ----------

  /** 海关风云开张（landOn 抽到「黑市开张」；dev.customs 钉位通道同走本收口）：
   *  随机指派 1 名在场玩家当警长（淘汰者/通关席除外；dev 通道可钉定），其余为偷渡者；
   *  本世界回合窗转为海关风云——报备转让随时可做、警长查验 ≤2 次（6 人在场及以上 3 次）。
   *  假警长=不查验（直接退化自由转让，验收 AC5）；真人警长超时不查（CUSTOMS_CHECK_MS）也退化，绝不阻塞。
   *  计时起算：窗内抽到=立即起算；走路跨窗尾（休息期）抽到=下个世界回合开窗时正式摆摊（armed）。
   *  同窗二次抽到（牌堆洗回转出）不重开——海关风云仍在。 */
  private openCustoms(card: EventCard, now: number, sheriffForce?: number): void {
    if (this.state.customs) {
      this.msg("system", `「${card.title}」——海关风云仍在，窗口不重开。`);
      return;
    }
    const act = this.activePlayers();
    if (act.length === 0) {
      this.msg("system", `「${card.title}」夜市悄悄开张——可惜庄园里没人在场，作罢。`);
      return;
    }
    let sheriff: PlayerState;
    if (sheriffForce != null) {
      const forced = this.player(sheriffForce);
      if (forced.dead || forced.zone === "done") throw new KernelError("警长要在场（非淘汰/非通关席）");
      sheriff = forced;
    } else {
      sheriff = act[Math.floor(this.draw("world") * act.length)]!;
    }
    const checks = this.state.players.length >= CUSTOMS_BIG_AT ? CUSTOMS_CHECKS_BIG : CUSTOMS_CHECKS; // 6 人以上局（局人数）
    const botSheriff = sheriff.isBot;
    const armed = this.state.phase === "acting";
    this.state.customs = {
      sheriff: sheriff.id,
      armed,
      checksLeft: checks,
      degraded: botSheriff, // 假警长不查验=直接退化（验收 AC5）
      checkDeadline: 0,
      shipments: [],
      pending: null,
      botPlans: [],
    };
    this.msg(
      "system",
      armed
        ? `🚢 海关风云！${sheriff.name} 被指命为警长——本窗玩家间可报备转让道具卡（明面只许运正货，违禁品只能谎报）；警长有 ${checks} 次查验，${Math.round(CUSTOMS_CHECK_MS / 1000)} 秒内不查就撤岗（退化为自由转让）。`
        : `🚢 海关风云悄悄开张！${sheriff.name} 被指命为警长——正在休息间隙，下个世界回合正式摆摊（报备转让/查验从那时起）。`,
      sheriff.id,
      { flavor: card.flavor, tags: ["customsOpen"], emphasis: "big" },
    );
    if (botSheriff) {
      this.msg("system", `🚢 警长 ${sheriff.name}（系统）摆摆手不打算查验——本窗退化为自由转让（照常报备转让）。`);
    }
    if (armed) this.armCustoms(now);
    this.emit({ type: "customsStart", sheriff: sheriff.id, checks });
  }

  /** 海关风云计时起算与假人排程（开窗当拍 or 下个世界回合正式开始共用）：查验截止
   *  =now+CUSTOMS_CHECK_MS；假偷渡者各排一拍（0.2–1s 错峰——赶在假人自走自确认之前，
   *  确认进等待区就没法出手了；到点执行一次规则化转让）。 */
  private armCustoms(now: number): void {
    const c = this.state.customs!;
    c.armed = true;
    c.checkDeadline = now + CUSTOMS_CHECK_MS;
    c.botPlans = this.activePlayers()
      .filter((q) => q.isBot && q.id !== c.sheriff)
      .map((q) => ({ pid: q.id, at: now + 200 + Math.floor(this.draw("world") * 800) }));
  }

  /** 报备转让（#26 T7）：报备校验（明面只许正货——declared 必须是表一正货，报备违禁品即拒）→
   *  报备单入册（谎报=declared≠实际箱货；运违禁品因报备校验必然成为谎报）→ 卡移交收货人。
   *  黑市老板被动（表三 #3）：警长窗转让（报备合格）时摸 1 张——转让即兑现。 */
  private doCustomsShip(pid: number, cardId: string, to: number, declared: string): void {
    const gate = customsShipGate(this.state, pid, cardId, to);
    if (!gate.ok) throw new KernelError(gate.reason);
    const decl = ITEM_CARD_BY_ID.get(declared);
    if (!decl) throw new KernelError(`报备货名 ${declared} 不在表一`);
    if (decl.contraband) throw new KernelError(`「${decl.title}」是违禁品——明面只许运正货，运违禁品只能报个别的名`);
    const p = this.player(pid);
    const q = this.player(to);
    p.hand.splice(p.hand.indexOf(cardId), 1);
    q.hand.push(cardId);
    const id = ++this.customsSeq;
    this.state.customs!.shipments.push({ id, from: pid, to, cardId, declared, checked: false });
    this.msg("system", `📦 ${p.name} 向 ${q.name} 报备转让 1 张道具卡——报备货名「${decl.title}」。`, pid, {
      targets: [q.id],
      emphasis: "normal",
    });
    if (roleDef(p.roleId).flags.customsTransferDraw) this.drawItems(p, 1, "黑市老板的门路");
  }

  /** 查验（#26 T7）：开箱对单——命中谎报=偷渡者交 1 张自选卡给警长（无卡回退 3 格）；
   *  清白=警长赔 1 张（无卡回退 3 格）。谎报判读=declared≠实际箱货（contraband 字段驱动的报备
   *  校验让违禁品无法如实报备——运违禁品必命中；正货报错名也是谎话，照罚）。查验成果走
   *  customsChecked 事实（表四 #6 海关清白 / T8b1 找战犯「查验打脸」计数流）。 */
  private doCustomsCheck(pid: number, shipmentId: number, now: number): void {
    this.degradeCustomsIfDue(now); // 超时后再点查验=先撤岗再拒（时钟口径统一）
    const gate = customsCheckGate(this.state, pid, shipmentId);
    if (!gate.ok) throw new KernelError(gate.reason);
    const c = this.state.customs!;
    const s = c.shipments.find((x) => x.id === shipmentId)!;
    const sheriff = this.player(pid);
    const f = this.player(s.from);
    c.checksLeft -= 1;
    s.checked = true;
    c.checkDeadline = now + CUSTOMS_CHECK_MS; // 查一次续期（下一个查验窗口）
    const lied = s.declared !== s.cardId;
    this.emit({ type: "customsChecked", pid, target: s.from, lied });
    if (lied) {
      this.msg("system", `🔎 警长 ${sheriff.name} 开箱查验——箱里是「${itemCard(s.cardId).title}」！报备的「${itemCard(s.declared).title}」是谎话。`, undefined, {
        emphasis: "highlight",
      });
      this.msg("system", `⚖ ${f.name} 命中谎报——交 1 张自选道具卡给警长（无卡回退 ${CUSTOMS_RETREAT} 格）。`, f.id, {
        targets: [sheriff.id],
        tags: ["customsLied"],
      });
      this.scheduleCustomsGive(f, sheriff, "caught", now);
    } else {
      this.msg("system", `🔎 警长 ${sheriff.name} 开箱查验——箱里确实是「${itemCard(s.cardId).title}」，报备清白。`, undefined, {
        emphasis: "highlight",
      });
      this.msg("system", `⚖ 查错了要赔——警长 ${sheriff.name} 赔 1 张自选道具卡给 ${f.name}（无卡回退 ${CUSTOMS_RETREAT} 格）。`, sheriff.id, {
        targets: [f.id],
        tags: ["customsClean"],
      });
      this.scheduleCustomsGive(sheriff, f, "clean", now);
    }
    if (c.checksLeft <= 0) {
      this.msg("system", "🚢 警长的查验次数用尽——本窗只剩自由转让。");
    }
  }

  /** 罚没/赔付移交发起：有卡=自选（真人挂账等 customsGive 应答、到点/收窗代选；假人即刻随机代选）；
   *  无卡=按海关规矩回退 CUSTOMS_RETREAT 格（startWalk 沿来路栈，走格占用即入队——绝不阻塞）。 */
  private scheduleCustomsGive(from: PlayerState, to: PlayerState, reason: CustomsGiveReason, now: number): void {
    if (from.hand.length === 0) {
      this.msg("system", `🚢 ${from.name} 手头无卡——按海关规矩回退 ${CUSTOMS_RETREAT} 格。`, from.id, { emphasis: "target" });
      this.startWalk(from, -CUSTOMS_RETREAT, now);
      return;
    }
    if (from.isBot) {
      this.customsGivePick(from, to, reason, now, true);
      return;
    }
    this.state.customs!.pending = { from: from.id, to: to.id, reason, deadline: now + this.config.routeAskMs };
  }

  /** 罚没移交落账（自选/代选唯一收口）：human=本人点的卡；auto=随机薅一张（超时/假人）；
   *  挂账期间把最后一张转走/打掉（或自选时手已空）＝按「无卡回退 CUSTOMS_RETREAT 格」落账
   *  （无卡判定在落账时复校——挂账人转移资产是合法躲法，绝不阻塞也绝不崩）；
   *  收方已不在对局=卡收归弃牌堆（单池守恒）。落账即清挂账。 */
  private customsGivePick(giver: PlayerState, to: PlayerState, reason: CustomsGiveReason, now: number, auto: boolean, cardId?: string): void {
    let id: string | null = null;
    if (giver.hand.length === 0) {
      id = null; // 无卡：走回退
    } else if (auto) {
      id = giver.hand.splice(Math.floor(this.draw("world") * giver.hand.length), 1)[0]!;
    } else {
      if (cardId == null || !giver.hand.includes(cardId)) throw new KernelError("这张卡不在待交者的手牌里");
      id = giver.hand.splice(giver.hand.indexOf(cardId), 1)[0]!;
    }
    if (id === null) {
      this.msg("system", `🚢 ${giver.name} 手头无卡——按海关规矩回退 ${CUSTOMS_RETREAT} 格。`, giver.id, { emphasis: "target" });
      this.startWalk(giver, -CUSTOMS_RETREAT, now);
    } else {
      const why = reason === "caught" ? "海关罚没" : "海关赔账";
      if (to.dead) {
        this.state.itemDiscard.push(id);
        this.msg("system", `🚢 ${why}——${to.name} 已不在对局，「${itemCard(id).title}」收归牌堆。`, giver.id);
      } else {
        to.hand.push(id);
        this.msg("system", `🚢 ${auto ? "系统替" : ""}${giver.name} ${auto ? "代选" : "交出"}「${itemCard(id).title}」交给 ${to.name}（${why}）。`, giver.id, {
          targets: [to.id],
        });
      }
    }
    if (this.state.customs) this.state.customs.pending = null;
  }

  /** 海关罚没·自选交卡（#26 T7）：仅挂账人本人可应答（同一时刻至多一单，一人一单互不干扰；
   *  挂账期间转走/打掉仅剩的卡＝落账时按无卡回退——见 customsGivePick 复校） */
  private doCustomsGive(pid: number, cardId: string, now: number): void {
    const c = this.state.customs;
    if (!c?.pending) throw new KernelError("没有待交的罚没卡");
    if (c.pending.from !== pid) throw new KernelError("这一单不是你要交的卡");
    this.customsGivePick(this.player(pid), this.player(c.pending.to), c.pending.reason, now, false, cardId);
  }

  /** 海关风云时钟账（tick 行动拍）：罚没自选到点代选 → 超时/警长离场退化 → 假人报备排程执行。
   *  全是「时间到了就自己了结」的账——绝不阻塞操作。未起算（休息期抽到）时整段跳过。 */
  private tickCustoms(now: number): void {
    const c = this.state.customs;
    if (!c || !c.armed) return;
    if (c.pending && now >= c.pending.deadline) {
      this.customsGivePick(this.player(c.pending.from), this.player(c.pending.to), c.pending.reason, now, true);
    }
    this.degradeCustomsIfDue(now);
    this.fireBotShipments(now);
  }

  /** 退化判读（tick 与查验前置共用的时钟口径）：警长离场=立即退化；已起算且余次未用尽而超时=退化 */
  private degradeCustomsIfDue(now: number): void {
    const c = this.state.customs;
    if (!c || !c.armed || c.degraded) return;
    const sheriff = this.player(c.sheriff);
    if (sheriff.dead || sheriff.zone === "done") {
      this.degradeCustoms(`警长 ${sheriff.name} 已不在对局`);
      return;
    }
    if (c.checksLeft > 0 && now >= c.checkDeadline) {
      this.degradeCustoms(`警长 ${sheriff.name} 迟迟没查验`);
    }
  }

  private degradeCustoms(why: string): void {
    this.state.customs!.degraded = true;
    this.msg("system", `🚢 ${why}——本窗退化为自由转让（无查验），想运什么运什么。`, undefined, { emphasis: "highlight" });
  }

  /** 假偷渡者报备排程执行（开窗排 1–3s 错峰、到点一次）：随机抽 1 张手牌转让给随机一名在场玩家；
   *  报备跟随规则——正货如实报、违禁品谎报为随机一张正货（明面校验只放行正货；假人跟规则走，验收 AC5）。
   *  gate 不过（已确认/轮空/手牌空）＝放弃这单，不重试。 */
  private fireBotShipments(now: number): void {
    const c = this.state.customs!;
    if (c.botPlans.length === 0) return;
    const due = c.botPlans.filter((x) => x.at <= now);
    if (due.length === 0) return;
    c.botPlans = c.botPlans.filter((x) => x.at > now);
    for (const plan of due) {
      const p = this.player(plan.pid);
      if (p.hand.length === 0) continue;
      const cardId = p.hand[Math.floor(this.draw("world") * p.hand.length)]!;
      const others = this.activePlayers().filter((q) => q.id !== p.id);
      if (others.length === 0) continue;
      const to = others[Math.floor(this.draw("world") * others.length)]!;
      const card = itemCard(cardId);
      const declared = card.contraband ? LEGIT_ITEM_IDS[Math.floor(this.draw("world") * LEGIT_ITEM_IDS.length)]! : cardId;
      if (!customsShipGate(this.state, p.id, cardId, to.id).ok) continue;
      this.doCustomsShip(p.id, cardId, to.id, declared);
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
    if (this.fighting()) {
      // 年兽战（T8a2）：全员砍完即收波（无需确认——砍了就算完；act 空=理论边角照收）
      const fighters = this.waveFighters();
      if (fighters.every((p) => p.rolled)) this.closeWave(now, false);
      return;
    }
    const act = this.activePlayers();
    // act 空（全员淘汰/全入席）时 every 本真=照常收窗——血尽横扫后回合钟不卡死（T5c）
    if (act.every((p) => p.confirmed)) {
      this.closeWindow(now, false);
    }
  }

  private closeWindow(now: number, auto: boolean): void {
    // 海关风云收窗即散（#26 T7）：挂账中的自选交卡先代选落账（绝不阻塞——「本世界回合窗」是海关的边界）
    if (this.state.customs) {
      const c = this.state.customs;
      if (c.pending) {
        const giver = this.player(c.pending.from);
        const to = this.player(c.pending.to);
        this.customsGivePick(giver, to, c.pending.reason, now, true);
      }
      this.state.customs = null;
      this.msg("system", "🚢 海关风云散去——庄园回常规节奏。");
      this.emit({ type: "customsEnd" });
    }
    this.emit({ type: "windowEnd", turn: this.state.turn, auto });
    this.state.turn += 1;
    if (this.state.turn > this.config.turnCap) {
      this.startEndgame(now);
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

  /**
   * 终局流程启动（#35 T8a1）：局长打满即启动——没有「首名冲线提前结束」，常规回合钟走完才算数。
   * 全桌成批落终局名册态（p.endgame：通关席必参最后一波／淘汰者不参战——T9 轮班·限时跳过消费；
   * 局中淘汰已在 retirePlayer 即时翻 out，此处成批为幂等重落）。
   * 最后一波年兽战本体在 T8a2 接入（startLastWave）：开战即挂 state.endgame.beast。
   */
  private startEndgame(now: number): void {
    this.state.endgame = { turn: this.state.turn, beast: null, groupFail: false };
    for (const p of this.state.players) {
      p.endgame = p.dead ? "out" : p.zone === "done" ? "seat" : "fight";
    }
    const seat = this.state.players.filter((p) => p.endgame === "seat");
    const out = this.state.players.filter((p) => p.endgame === "out");
    this.msg(
      "system",
      `🏁 局长 ${this.config.turnCap} 世界回合打满——终局流程启动！参战 ${this.state.players.length - seat.length - out.length} · 通关席 ${seat.length} · 观战 ${out.length}`,
      undefined,
      {
        flavor: "最后一波将至：通关席不再掷骰但必参战，出局者隔岸观火。",
        emphasis: "big",
      },
    );
    this.emit({ type: "endgameStart", turn: this.state.turn });
    this.startLastWave(now);
  }

  // ---------- 最后一波·年兽战（#27 T8a2，数值表 §5.5「最后一波 B」+一页纸「群体失败闸门」） ----------

  /** 年兽战进行中（开战到收束之间）——波窗复用 acting 相位，靠它分流掷骰/打牌/收窗三处语义 */
  private fighting(): boolean {
    return this.state.endgame?.beast != null;
  }

  /** 参战名册（最后一波的波窗主角）：名册态 fight+seat 且活着——seat 必参战（T8a1 口径）、淘汰者 out 不参战（T5c） */
  private waveFighters(): PlayerState[] {
    return this.state.players.filter((p) => !p.dead && (p.endgame === "fight" || p.endgame === "seat"));
  }

  /** 年兽反噬伤害（数值表 §5.5「反噬：每波全体 −1（猛 −2）」）：猛 −2、其余 −1——**不吃 off 档**
   *  （年兽=终局本体，世界恶意的整局关断不豁免它的兽性；与世界恶意 maliceDmg 分开单列=口径显式）。 */
  private beastRoarDmg(): number {
    return this.config.maliceLevel === "fierce" ? 2 : 1;
  }

  /** 最后一波开战（T8a2）：年兽现身挂共享血条（基础 25+每玩家 15）；行走定格在脚下（终局一至，
   *  半路的那步不再落格结算——走到一半=停住，末窗的落格收益让位给年兽战）。全员已出局=没开打就输了
   *  （群体失败直通，无死结）。 */
  private startLastWave(now: number): void {
    // 行走定格：清走格与续走队列（含未决选路条——walk 置 null 即散），落格结算不触发
    for (const p of this.state.players) {
      p.walk = null;
      p.walkQueue = [];
    }
    if (this.waveFighters().length === 0) {
      this.state.endgame!.groupFail = true;
      this.msg("beast", `🐉 年兽的咆哮在庄园上空回荡——但已无人应战。全员出局，直接盖棺「群体失败」。`, undefined, {
        emphasis: "big",
      });
      this.emit({ type: "groupFail" });
      this.finishEndgame();
      return;
    }
    const n = this.state.players.length;
    const hp = BEAST_BASE_HP + BEAST_HP_PER_PLAYER * n;
    const beast: BeastState = { hp, maxHp: hp, wave: 0, waveDmg: 0 };
    this.state.endgame!.beast = beast;
    this.msg(
      "beast",
      `🐉 最后一波——年兽现身！全员合力合砍它的共享血条 ${hp}（基础 ${BEAST_BASE_HP}+每玩家 ${BEAST_HP_PER_PLAYER}×${n} 人）：人人掷伤害骰 1d${BEAST_DIE}，砍出面值就是伤害；年兽每波反噬全场。`,
      undefined,
      { emphasis: "big" },
    );
    this.openWave(now);
  }

  /** 开一波（T8a2）：参战者掷/确认/轮空态按波重刷；罚停逐波消耗（轮空=本波不砍——与 openWindow
   *  同序同账）；假人排到点砍击日程；**安慰奖**=每个存活参战者摸 1 张道具卡（胜负皆有 Loot——
   *  群体失败打完的这波照发，卡随淘汰散回牌堆=单池守恒；死人摸卡被 T5c 天然拦下）。 */
  private openWave(now: number): void {
    const beast = this.state.endgame!.beast!;
    beast.wave += 1;
    beast.waveDmg = 0;
    this.state.phase = "acting";
    this.state.windowDeadline = now + this.config.windowMs; // 波=一个世界回合窗（超时替砍，绝不阻塞）
    for (const p of this.state.players) {
      if (p.dead || p.endgame === "out") continue;
      p.rolled = false;
      p.confirmed = false;
      p.skipped = false;
      if (p.stun > 0) {
        p.stun -= 1;
        p.rolled = true;
        p.skipped = true;
        this.msg("beast", `${p.name} 罚停生效——本波轮空（年兽面前动弹不得）。`, p.id, { emphasis: "normal" });
      }
      if (p.isBot) {
        p.botSchedule = { rollAt: now + 400 + p.id * 350 + Math.floor(this.draw("world") * 700), confirmAt: Number.POSITIVE_INFINITY };
      }
    }
    for (const p of this.waveFighters()) {
      this.drawItems(p, 1, "波间补给（安慰奖——输了也有 Loot）");
    }
    this.msg("beast", `⚔ 第 ${beast.wave} 波——参战 ${this.waveFighters().length} 人，砍！`, undefined, { emphasis: "highlight" });
    this.emit({ type: "beastWave", wave: beast.wave, hp: beast.hp, maxHp: beast.maxHp });
  }

  /** 砍击闸（内核执行+壳层置灰共用一份口径，strikeGate 落在文件尾的闸门区） */
  private doStrikeChecked(pid: number, mode: "human" | "bot" | "replacement"): void {
    const gate = strikeGate(this.state, pid);
    if (!gate.ok) throw new KernelError(gate.reason);
    this.doStrike(pid, mode);
  }

  /** 一刀落账：伤害骰 1d12（爆 12 爽点）→ 年兽共享血条递减 → 击杀即收束。 */
  private doStrike(pid: number, mode: "human" | "bot" | "replacement"): void {
    const p = this.player(pid);
    p.rolled = true;
    const d = Math.floor(this.draw("dice") * BEAST_DIE) + 1;
    const auto = mode !== "human";
    this.msg("beast", `${auto ? "系统替 " : ""}${p.name} 掷伤害骰——砍出 ${d} 伤！`, pid, {
      emphasis: d === BEAST_DIE ? "highlight" : "normal",
    });
    this.beastDamage(p, d);
  }

  /** 递卡给队友（T8a2）：T7 转让管线同源接口——手→手平移（单池守恒自动成立），无海关无报备。
   *  战场合作口：递治疗/护身符给前排、递加倍骰给大刀。闸门=giveItemGate（文件尾闸门区）。 */
  private doGiveItem(pid: number, cardId: string, to: number): void {
    const gate = giveItemGate(this.state, pid, cardId, to);
    if (!gate.ok) throw new KernelError(gate.reason);
    const p = this.player(pid);
    const q = this.player(to);
    p.hand.splice(p.hand.indexOf(cardId), 1);
    q.hand.push(cardId);
    this.msg("beast", `🎁 ${p.name} 把「${itemCard(cardId).title}」递给 ${q.name}——生死与共。`, pid, {
      targets: [q.id],
      emphasis: "normal",
    });
  }

  /** 直砸年兽（T8a2）：任意道具卡砸向年兽=当场多掷一次伤害骰 1d12（票面列举的治疗/护身符/
   *  加倍骰/弹弓/加倍卡全数可用=通用口子的例证——爽点=多掷一刀，卡回弃牌堆单池守恒）。
   *  砍死的收束与普通砍击同账（beastDamage→slayBeast）。出手=打过卡（T8b1 itemPlayed 计数通道）。 */
  private doHitBeast(pid: number, cardId: string): void {
    const gate = hitBeastGate(this.state, pid, cardId);
    if (!gate.ok) throw new KernelError(gate.reason);
    const p = this.player(pid);
    p.hand.splice(p.hand.indexOf(cardId), 1);
    this.state.itemDiscard.push(cardId);
    const d = Math.floor(this.draw("dice") * BEAST_DIE) + 1;
    this.msg("beast", `💥 ${p.name} 把「${itemCard(cardId).title}」砸向年兽——轰出 ${d} 伤！`, pid, {
      tags: ["itemPlayed"],
      emphasis: d === BEAST_DIE ? "highlight" : "normal",
    });
    this.beastDamage(p, d);
  }

  /** 年兽吃刀唯一收口：血条递减+战报+事实；血尽=击杀收束（死兽不反噬——当波已砍的其余人不再挨咬）。 */
  private beastDamage(p: PlayerState, d: number): void {
    const beast = this.state.endgame!.beast!;
    beast.hp = Math.max(0, beast.hp - d);
    beast.waveDmg += d;
    this.emit({ type: "beastHit", pid: p.id, dmg: d, hp: beast.hp });
    if (beast.hp <= 0) this.slayBeast();
  }

  /** 胜利收束（T8a2）：年兽倒在庄园门口——phase over+gameEnd（结算 T8b1 消费 finishers 分位）。 */
  private slayBeast(): void {
    const beast = this.state.endgame!.beast!;
    beast.hp = 0;
    this.msg("beast", `🐉 年兽轰然倒地——最后一波赢了！（第 ${beast.wave} 波收束）`, undefined, {
      emphasis: "big",
    });
    this.emit({ type: "beastSlain", wave: beast.wave });
    this.finishEndgame();
  }

  /** 波收口（T8a2）：年兽还活着就反噬全场（温和 −1／猛 −2——走 applyHpDelta 单入口，
   *  护身符/皮糙肉厚盾照拦，扣血行分色 malice）；反噬后全灭=群体失败闸门落库+盖棺；
   *  还有人站着=开下一波。波间无休息（一鼓作气）。 */
  private closeWave(now: number, auto: boolean): void {
    const beast = this.state.endgame!.beast!;
    const roar = this.beastRoarDmg();
    this.emit({ type: "beastRoar", dmg: roar });
    this.msg(
      "beast",
      `🐉 年兽反噬全场——第 ${beast.wave} 波${auto ? "（超时替砍）" : ""}合计砍出 ${beast.waveDmg} 伤，没砍倒它，它怒吼着扑回来（每人 −${roar}）！`,
      undefined,
      { emphasis: "highlight" },
    );
    for (const p of this.waveFighters()) {
      this.applyHpDelta(p, -roar, "beast");
      this.emit({ type: "pulse", pid: p.id, level: "target" });
    }
    if (this.waveFighters().length === 0) {
      this.state.endgame!.groupFail = true;
      this.msg(
        "beast",
        `💀 全员倒下——群体失败！全员暗牌目标作废，结算盖章「群体失败」，进入找战犯环节。`,
        undefined,
        { emphasis: "big" },
      );
      this.emit({ type: "groupFail" });
      this.finishEndgame();
      return;
    }
    this.openWave(now);
  }

  /** 波窗超时替砍（T8a2 对 autoFillAndClose 的年兽战版）：没砍的逐一替砍（波内必有伤害——不替=拖延坐大），
   *  然后收波。替砍砍死年兽=收束已落（phase over），不再收波。 */
  private autoStrikeAndClose(now: number): void {
    for (const p of this.waveFighters()) {
      if (!p.rolled) {
        this.doStrike(p.id, "replacement");
        if (this.state.phase !== "acting") return; // 这一刀砍死了年兽——slayBeast 已盖棺
      }
    }
    this.closeWave(now, true);
  }

  /** 终局盖棺（T8a2 胜利/群体失败共用）+终局结算（#36 T8b1）：phase over → 纯聚合一次
   *  （五项积分/称号十条/找战犯——计数真源=战报流 MsgTag 折叠，见 settle.ts）落账：
   *  result 先行 settlement 事实与 state.endgame.settlement（呈现=T8b2 结算页消费），
   *  战报分行留史（GLOSSARY「找战犯的素材源」），gameEnd 压尾=「进结算页」的最后一枚事实。 */
  private finishEndgame(): void {
    this.state.phase = "over";
    const result = computeSettlement(this.state);
    this.state.endgame!.settlement = result;
    this.emit({ type: "settlement", result });
    const ranked = [...result.rows].sort((a, b) => b.total - a.total || a.pid - b.pid);
    const top = ranked[0]!;
    const stamp = result.groupFail ? "（群体失败盖章——全员称号作废）" : "";
    this.msg("score", `🏁 终局结算——「${this.player(top.pid).name}」以 ${top.total} 分登顶！${stamp}`, top.pid, {
      emphasis: "big",
    });
    for (const r of ranked) {
      const titles = r.goalNos.map((no) => secretGoal(no).title).join("、");
      const titleSeg = r.goalsVoided ? "称号——（作废）" : titles ? `称号 ${r.titleScore}（${titles}）` : `称号 0`;
      this.msg(
        "score",
        `🧮 ${this.player(r.pid).name} 总分 ${r.total}＝进度 ${r.progress}＋通关 ${r.finish}${r.finishRank ? `（第 ${r.finishRank} 位）` : ""}＋存活 ${r.survive}＋${titleSeg}＋整蛊 ${r.grudgeScore}（${r.grudgeCount} 次）`,
        r.pid,
        { emphasis: "highlight" },
      );
    }
    if (result.culprits.length === 0) {
      this.msg("score", "🧾 找战犯——查无战犯，皆大欢喜。", undefined, { emphasis: "highlight" });
    } else {
      for (const c of result.culprits) {
        const ev = c.evidence.length > 0 ? `（证据：战报 #${c.evidence.join("、#")}）` : "（整局无出手记录）";
        this.msg("score", `🧾 找战犯——${c.detail}${ev}`, c.pid, { emphasis: "highlight" });
      }
    }
    this.emit({ type: "gameEnd" });
  }

  // ---------- 掷骰 / 确认 ----------

  private checkRoll(pid: number): void {
    const p = this.player(pid);
    // 成员资格先行（与窗内动作资格阶梯同序）：通关席/出局者拒「不再行动」，而非误导性的「已掷过骰」
    this.checkWindowAction(p);
    if (p.rolled) throw new KernelError("本窗已掷过骰");
    if (p.walk) throw new KernelError("走格未完成，不能掷");
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
    const raw = rollDice(this.rngs.dice, net, faces);
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
    if (straight !== null && opts.includes(straight) && this.draw("world") < 0.6) {
      return straight; // 顺直行偏好（六成概率）
    }
    return opts[Math.floor(this.draw("world") * opts.length)]!;
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
    const score = finishScore(rank);
    this.msg("system", `${p.name} 🏁 刚好踩进终点——通关席！`, p.id, {
      flavor: `为第 ${rank} 位通关席${score > 0 ? `（结算分位 +${score}）` : ""}：不再掷骰、仍可打整蛊卡、必参最后一波。`,
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
    this.landOn(p, now, w); // 落格结算：事件格抽卡（走停即触发，双向一视同仁）
    if (p.walkQueue.length > 0) {
      // 卡面连动续走：接队首（不再调度确认——还在走；下一拍自然步进）。效果轨（dice=false）
      const next = p.walkQueue.shift()!;
      p.walk = { remaining: next, total: next, dice: false, nextStepAt: now + this.config.stepMs, ask: null, pendingTo: null, bounced: false };
      return;
    }
    if (p.isBot && !p.dead && p.zone !== "done") {
      // 假人：走完一小拍后自动确认（到点由 fireBots 消费）
      p.botSchedule.confirmAt = now + 500 + Math.floor(this.draw("world") * 400);
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
   *  世界层塌陷先判（踩进即咬），再场地型附着（踩上即踩上），再按格型——道具格摸卡／
   *  事件格抽卡／陷阱格检定逃生。
   *  w=刚走完的这段（触发本格的来路）：陷阱格消费「倒霉蛋走格骰 10 无事」按它识别发团骰。 */
  private landOn(p: PlayerState, now: number, w: WalkState | null): void {
    if (p.dead || p.zone !== "main") return;
    const c = this.cell(p.pos);
    this.sinkHit(p);
    this.dogFightHere(p, now); // 撞上狗=强制遭遇战（#25 T6b：走停即触发）
    this.triggerGround(p, now);
    if (c.type === "I") {
      this.drawItems(p, 1, "踩上道具格");
    } else if (c.type === "E") {
      this.drawEventFor(p, now);
    } else if (c.type === "T") {
      this.triggerTrap(p, now, w);
    }
  }

  /** 陷阱格踩中（#33 T5b，数值表 §5.4 全检定制）：踩上先掷对应轴检定逃生——通过=免伤或仅小惩罚、
   *  失败=吃该格负面、骰 1 大失败=负面加重一档（单格自带）。检定修正批（沙暴 −4）与轴系特长
   *  同吃互抵口径。扣血走 hp 原语=applyHpDelta 单入口（护身符/盾照拦，T5a）；退/罚停/弃卡/传送/
   *  禁道具各走既有与新原语通道。战报 kind=trap。
   *  倒霉蛋求生直觉（表三 trapWalk10Safe）：把你送进来的走格骰掷出 10（有效面）则整格无事。 */
  private triggerTrap(p: PlayerState, now: number, w: WalkState | null): void {
    if (roleDef(p.roleId).flags.trapWalk10Safe && w?.dice && w.total === WALK_DIE) {
      this.msg("trap", `${p.name} 走格骰掷出 10——一步跨过陷阱，浑然不觉（倒霉蛋直觉）。`, p.id, { emphasis: "highlight" });
      return;
    }
    const def = trapDefAt(this.cell(p.pos));
    this.msg("trap", `${p.name} 踩上「${def.name}」！`, p.id, { flavor: def.flavor, emphasis: "target" });
    this.runCheck(p, def.check, now, undefined, "trap");
  }

  /**
   * 抽卡链路：单池洗匀抽一 → 抉择卡挂起供触发者本人应答（超时/假人按默认项代选并标「(代选)」）
   * → 纯效果卡即时结算 → 指认他人的部分下一世界回合生效（world·即时口径）。
   * tries/连抽上限都是防循环的保守熔断，正常对局不触发。
   */
  private drawEventFor(p: PlayerState, now: number, forced?: EventCard): void {
    if (p.dead) return; // 死了就死了（T5c）：强发通道也不给死人发卡出声
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
          const at = Math.floor(this.draw("deck") * (this.state.deck.length + 1));
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
      this.applyCardEffect(p, card.effect!, now, card.title);
    } else if (card.kind === "choice") {
      if (p.isBot) {
        this.resolveChoice(p, card.id, card.defaultOption ?? 0, now, true);
      } else {
        // 抉择挂起：卡面应答窗口沿用选路口径 10s（规格定死）；T3a2 中央浮层消费
        p.cardPending = { cardId: card.id, deadline: now + this.config.routeAskMs };
      }
    } else {
      // kind='window'（#26 T7 警长查货窗）：抽到即把本世界回合窗变为海关风云
      this.openCustoms(card, now);
    }
  }

  /** 从牌堆顶抽一张（空则弃牌堆整堆洗回——单池守恒：deck+discard 恒等价于 M1_EVENT_POOL） */
  private popCard(): EventCard | null {
    if (this.state.deck.length === 0) {
      this.state.deck = this.rngs.deck.shuffle([...this.state.discard]);
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
    if (opt.effect) this.applyCardEffect(p, opt.effect, now, card.title);
  }

  /** 指认/指向他人的卡面效果统一按计时模式出发（#22 T4b1 收口）：轮班·限时=立刻生效（无同时行动，无竞态；M1 未接线 T9，口径先立）；world·即时=挂账下一窗开窗结算（被整蛊者有预判窗口）。
   *  grudgeLabel=整蛊手段的卡名（T8b1 计数通道：event 卡必指认、道具卡仅违禁品——落账当拍出「整蛊得手」条目）。 */
  private dispatchToOthers(targets: PlayerState[], parts: EffectPart[], now: number, ctx: GuardCtx, grudgeLabel?: string): void {
    if (this.config.timerMode === "turn") {
      for (const q of targets) {
        const landed = this.applyParts(q, parts, now, ctx);
        if (landed && grudgeLabel && ctx.srcPid !== q.id) this.grudgeLanded(ctx.srcPid, q, ctx.kind, grudgeLabel);
      }
      return;
    }
    for (const q of targets) this.state.deferred.push({ pid: q.id, parts, kind: ctx.kind, srcPid: ctx.srcPid, ...(grudgeLabel ? { grudgeLabel } : {}) });
    this.msg(ctx.kind, `下一世界回合开始时结算：${targets.map((q) => q.name).join("、")}。`, ctx.srcPid, {
      targets: targets.map((q) => q.id),
    });
  }

  /** 整蛊得手收口（#36 T8b1 三通道同一条计数账：指认/违禁卡/场地卡——手段在目标身上实际生效）：
   *  战报出「得手」条目挂 grudge 标签（who=整蛊者）——终局整蛊王计数 × 整蛊分折算的真源。 */
  private grudgeLanded(srcPid: number, victim: PlayerState, kind: MessageKind, label: string): void {
    const src = this.player(srcPid);
    this.msg(kind, `😈 「${label}」在 ${victim.name} 身上生效——${src.name} 整蛊得手！`, srcPid, {
      targets: [victim.id],
      tags: ["grudge"],
      emphasis: "target",
    });
  }

  /** 卡面效果：self 即时；others 系统指认后按计时模式分流（world=下回合生效挂 deferred）。
   *  指认通路带 GuardCtx（kind/srcPid）——小圆盾「免疫他人卡牌效果」按打出者判他我（T4b1）。
   *  label=手段卡名（T8b1 整蛊通道归因——event 卡=「系统指认」通道、道具卡仅违禁品传入）。 */
  private applyCardEffect(p: PlayerState, eff: CardEffect, now: number, label?: string): void {
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
      this.dispatchToOthers(targets, t.parts, now, { kind: "event", srcPid: p.id }, label);
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
        return [act[Math.floor(this.draw("world") * act.length)]!];
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
   * 返回**效果真落账**=true（目标在场且未被小圆盾拦下——T8b1 整蛊成功的「生效」判据，调用方归因计数）。
   */
  private applyParts(p: PlayerState, parts: EffectPart[], now: number, ctx?: GuardCtx): boolean {
    if (p.dead || p.zone === "done") return false;
    if (ctx && p.cardGuard === this.state.turn && ctx.srcPid !== p.id) {
      // 小圆盾（表一 #9）：下一世界回合免疫他人卡牌效果——整批效果拦下（触发者自己的卡牌不拦）
      const src = this.player(ctx.srcPid);
      this.msg(ctx.kind, `${p.name} 「小圆盾」挡下 ${src.name} 的${ctx.kind === "item" ? "道具卡" : "事件卡"}效果！`, p.id, {
        targets: [ctx.srcPid],
        emphasis: "highlight",
      });
      return false;
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
        case "mark":
          // 对局计数标记（T8b1）：打一条 tag 战报承载「得手」——结算对战报流聚合计数（行为级，无副作用）
          this.msg(ctx?.kind ?? "event", part.text, p.id, { tags: [part.tag], emphasis: "highlight" });
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
        case "teleport": {
          // 传送回自己出生格（#33 陷阱流沙坑/回旋沙柱）：净步保留（行进账不折损——与偷天换日「净步各保留」同口径）、
          // 来向/来路栈清空（退格从零重审）。落点=出生格净底，不二次触发 landOn。
          const to = p.spawnCell;
          p.pos = to;
          p.from = null;
          p.trail = [];
          if (p.zone !== "main") {
            p.zone = "main";
            p.bpos = 0;
          }
          this.msg("trap", `${p.name} 被卷回了自家门前——传送回出生格（净步保留）。`, p.id, { emphasis: "big" });
          break;
        }
        case "discard": {
          // 随机弃手牌 v 张（#33 贼赃房；野性直觉/野狗被抢同账共用 snatchCards）：单池守恒——离手即入弃牌堆；无卡可弃=落空出声
          const titles = this.snatchCards(p, part.v);
          if (titles.length === 0) {
            this.msg("trap", `${p.name} 手头无卡可弃——贼赃房也薅了个空。`, p.id);
          } else {
            this.msg("trap", `${p.name} 被薅走 ${titles.length} 张道具卡：${titles.join("、")}。`, p.id, { emphasis: "target" });
          }
          break;
        }
        case "itemBan": {
          // 禁道具挂账（#33 沙困行囊）：记忆 v 个世界回合，开窗消费到 itemBanned（当窗打不出的道具闸在 itemPlayGate）
          if (part.v > 0) p.itemBan += part.v;
          this.msg("trap", `${p.name} 行囊灌满沙——接下来 ${part.v} 个回合打不出任何道具卡。`, p.id, { emphasis: "target" });
          break;
        }
        case "dogSpawn": {
          // 狗笛（表一 #16，T6b 接通）：在受指向者相邻格生成 1 只标准野狗——相邻候选全体
          // 等概率取一（含环岛/出生格——整蛊无豁免，喇叭一响野狗循声就来）。
          // 生成**入挂账队列**（state.malice.spawnQueue）：deferred 结算先于本窗 tickMalice 的
          // 狗账——直接入册会被同窗减寿一回合（寿命少一拍），挂账让波生与笛生同段位收口
          // （出队结算在 tickDogs 之后=出生窗不减寿、标准 3 世界回合）。
          const links = this.cell(p.pos).links;
          if (links.length === 0) break; // 理论不可达（每格 ≥1 邻）——落空无害
          const to = links[Math.floor(this.draw("world") * links.length)]!;
          this.state.malice.spawnQueue.push({ cell: to, target: p.id });
          break;
        }
        case "none":
          break;
      }
    }
    return true;
  }

  /**
   * 血量通道（#23 T5a，数值表 §5.3）：全部扣血/治疗的**唯一结算入口**——
   *   已接渠道=卡面 hp 原语（事件：断桥/熔岩/近路/孤注一掷、温泉；道具：药水+2/万能药+4/地雷失败支）
   *   ＋陷阱（#33 全渠道同吃：护身符/盾照拦）＋dev.hit 测试通道；后备渠道=恶意/滚石/塌陷/
   *   野狗咬/年兽反噬（T6 落卡时一律走本原语——逐渠道调 this.applyHpDelta，不得旁路改 p.hp）。
   * 结算序：扣血先过护身符（表一 #14，触发即消耗）再过盾（皮糙肉厚）；同刻多源按到达序逐笔落账；
   *   回血封顶 maxHp 不溢出；血尽归零=淘汰（#34 T5c retirePlayer 单入口：死了就死了——
   *   死后本通道对死人 no-op，治疗拉不起、挂账扣血也不复播）。
   */
  private applyHpDelta(p: PlayerState, delta: number, tone: MessageKind = "event"): void {
    if (p.dead) return; // 死了就死了（T5c）：不再扣血也不再进账——治疗拉不起死人
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
    const before = p.hp;
    p.hp = Math.max(0, Math.min(this.config.maxHp, p.hp + delta));
    const real = p.hp - before; // 播报实际生效量（削顶/兜底按真账记「逐笔落账」，#23 T5a review）
    if (delta < 0) {
      this.msg(tone, `${p.name} 扣 ${-real} 血（剩 ${p.hp}/${this.config.maxHp}）`, p.id, { tags: ["hpLost"], emphasis: "target" });
      if (before > 0 && p.hp === 0) {
        this.retirePlayer(p);
      }
    } else {
      this.msg("event", `${p.name} 回 ${real} 血（剩 ${p.hp}/${this.config.maxHp}）`, p.id);
    }
  }

  /**
   * 淘汰流程（#34 T5c，一页纸「血量与淘汰」修订 1.4：血尽=淘汰，死了就死了）：
   *   挂起态全清（走格/续走队列/抉择挂起/骰面与检定修正批——不再占窗不再消费），
   *   手牌按数值表 §5.3 定案全数回道具弃牌堆（单池守恒——与贼赃房 discard「离手即入弃牌堆」同口径；
   *   事件牌从不入手、无此负担），暗牌不撤（淘汰不免除已达成的事实，「活到结算」型留 T8b1 判）。
   * 进入观战：留在游戏页（棋子原地变暗+☠锁标，壳层 T5c 贴皮）；不再掷骰/打卡/被指认——
   *   四闸同滤 dead 已在位：activePlayers/checkWindowAction/itemPlayGate/identifyTargets。
   * dev.setDead 测试通道同走本口径（同一套清账，不旁开第二份淘汰语义）。
   */
  private retirePlayer(p: PlayerState): void {
    if (p.dead) return;
    p.dead = true;
    p.hp = 0; // 血尽定格 0（dev.setDead 测试通道同到此清零——观战血条空槽）
    p.endgame = "out"; // 终局名册态即时翻 out（#35 T8a1）：死了就是终局外的人——T9 跳过/最后一波不参战
    p.walk = null;
    p.walkQueue = [];
    p.cardPending = null;
    p.rollMods = [];
    p.checkMods = [];
    p.stun = 0;
    p.talisman = 0;
    p.itemBan = 0; // itemBanned 由下窗 openWindow 从 itemBan 重导出（死于途中自然落 false），不另设值
    p.botSchedule = { rollAt: 0, confirmAt: 0 };
    // 海关罚没挂账涉及死者（#26 T7）：作罢出声——手牌已散、罚无可罚（绝不阻塞；警长离场由 tickCustoms 退化）
    const cp = this.state.customs?.pending;
    if (cp && (cp.from === p.id || cp.to === p.id)) {
      this.state.customs!.pending = null;
      this.msg("system", `🚢 海关罚没作罢——${p.name} 已不在对局。`);
    }
    if (p.hand.length > 0) {
      const n = p.hand.length;
      const titles = p.hand.map((id) => itemCard(id).title);
      this.state.itemDiscard.push(...p.hand);
      this.msg("system", `${p.name} 手牌 ${n} 张散落归还牌堆：${titles.join("、")}。`, p.id, {
        // 散落=公开信息（卡进全桌弃牌堆）——落 cards 供找战犯「治疗吞到死」按条目溯源（摸牌不落它=手牌保密口径）
        cards: [...p.hand],
        tags: ["retiredHand"],
      });
      p.hand = [];
    }
    this.msg("system", `☠ ${p.name} 血尽出局——死了就死了，进入观战（不再掷骰、打卡，不再被指认）。`, p.id, {
      emphasis: "big",
    });
    this.emit({ type: "eliminated", pid: p.id });
    this.emit({ type: "pulse", pid: p.id, level: "big" });
  }

  /**
   * 检定三态（1d20+轴 vs 卡面 DC）：修正四原语与角色特长先全量互抵再掷再判；
   * 极值挂原始面 20/1（升面骰出的 21+ 只算大数，不算大成功——保持「极值不随面宽翻动」口径）。
   * 无 dc 的前途骰走 bands 分档（命运之骰：20/1 极值 → 余面按 min/max 首中，末条兜底）。
   * ctx 透传给分支原语（小圆盾判「他人卡牌效果」的依据，T4b1）；kind=战报类别
   * （卡面检定默认 event；陷阱格踩中传 trap——同一结算通道、战报分色，T5b）。
   */
  private runCheck(p: PlayerState, spec: CheckSpec, now: number, ctx?: GuardCtx, kind: MessageKind = "event"): CheckResolve {
    const role = roleDef(p.roleId);
    const mods: CheckMods[] = [
      ...toCheckMods(p.checkMods), // 风暴·沙暴等气候挂的本回合检定修正（T4b2）——与卡面/特长同一互抵批（走格骰不吃它）
      ...toCheckMods(spec.mods ?? []),
      // 轴系特长（蛮力/狡运）只跟有轴检定走；无轴前途骰（命运之骰）不吃特长；
      // scope（T6b）：dogFight 域=猎手遭遇战特长恰在此域生效，其余域（滚石闪躲等）不吃
      ...(spec.axis ? roleCheckMods(role, spec.axis, spec.scope) : []),
    ];
    const net = netMods(mods); // 互抵：先全量合账（D&D 原则）
    const faces = Math.max(3, CHECK_FACES + net.face);
    const raw = rollD20(this.rngs.dice, { adv: net.adv, advCount: net.advCount }, faces);
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
        kind,
        `${p.name} ${axisName}检 d20(${res.raw})${res.mods >= 0 ? "+" : "−"}${Math.abs(res.mods)}=${res.used} vs DC${spec.dc} —— ${gradeText[res.grade]}！`,
        p.id,
        { emphasis: res.grade === "crit" || res.grade === "critfail" ? "highlight" : "normal" },
      );
    } else {
      // 前途骰（无 dc）：修正括注与 dc 分支同形；档位结果由 bands 分支的 move/back 播报自报，此处只报面
      const mods =
        res.mods === 0 ? "" : res.mods > 0 ? `（+${res.mods}）` : `（−${-res.mods}）`;
      this.msg(kind, `${p.name} ${axisName}掷出 ${res.raw}${mods}。`, p.id, {
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
    return res;
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
        tags: ["itemPlayed"],
        emphasis: "target",
      });
      // 计时模式分流在 dispatchToOthers 收口（轮班=立刻生效；world·即时=挂账下一窗开窗结算——被整蛊者有预判窗口）；
      // 违禁品才走整蛊计数通道（表五 §5.1 整蛊分：明面正货的指认不算整蛊——当前池内自选卡全是违禁品）
      this.dispatchToOthers([q!], card.parts!, now, { kind: "item", srcPid: pid }, card.contraband ? card.title : undefined);
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
        tags: ["itemPlayed"],
        emphasis: "target",
      });
      if (targets.length === 0) {
        this.msg("item", "指认落空——没有可指认的目标，效果散去。", pid);
        return;
      }
      this.dispatchToOthers(targets, card.parts!, now, { kind: "item", srcPid: pid }, card.contraband ? card.title : undefined);
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
        tags: ["itemPlayed", "ambientPlayed"],
        emphasis: old ? "big" : "highlight",
      });
      this.drawItems(p, 1, "打出环境补偿");
      return;
    }
    if (card.route === "self") {
      this.state.itemDiscard.push(cardId);
      this.msg("item", `${p.name} 打出「${card.title}」`, pid, { flavor: card.flavor, tags: ["itemPlayed"], emphasis: "highlight" });
      this.applyParts(p, card.parts!, now);
      return;
    }
    // ground：附着当前格；下一踩上者（含铺设者本人）触发判定后消失。
    // 附着期间卡片离池不入弃牌堆（否则弃牌堆洗回会抽出第二张同卡，与场上的那张重复）
    this.state.ground.push({ cell: p.pos, cardId, owner: pid });
    this.msg("item", `${p.name} 把「${card.title}」搁在脚下——下一踩上的人要吃苦头了。`, pid, {
      flavor: card.flavor,
      tags: ["itemPlayed"],
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
      // 踩中=整蛊通道（表五 §5.1 整蛊分三通道之一：「场地卡被踩中」——踩上判定才走判定骰；
      // 自铺自踩不算得手，铺设者出局后的遗留手段照样记账=已达成事实保留口径）
      if (g.owner !== p.id) this.grudgeLanded(g.owner, p, "item", card.title);
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
      this.state.itemDeck = this.rngs.items.shuffle([...this.state.itemDiscard]);
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
  if (state.endgame?.beast != null) {
    return { ok: false, reason: "最后一波——道具卡递给队友或直砸年兽，不按常规打法" };
  }
  if (p.dead) return { ok: false, reason: "已淘汰观战，不能再出手" };
  const card = ITEM_CARD_BY_ID.get(cardId);
  if (!card) return { ok: false, reason: `道具卡 ${cardId} 不在表一` };
  if (!p.hand.includes(cardId)) return { ok: false, reason: "这张卡不在你的手牌里" };
  if (p.skipped) return { ok: false, reason: "本回合罚停轮空——不能出手" };
  if (p.itemBanned) return { ok: false, reason: "本回合禁道具——陷阱的余劲还缠着你，打不出卡" };
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

/** 窗内动作资格阶梯（#26 T7 海关两闸共用；道具打出闸（itemPlayGate）阶梯序与拒因文案不同——不并）：
 *  阶段在窗 → 出局观战／通关席／等待区／罚停轮空各拒。通过把玩家一并交出（省二次查找）。 */
function windowActGate(state: GameState, pid: number, phaseReason: string): { ok: true; player: PlayerState } | { ok: false; reason: string } {
  if (state.phase !== "acting") return { ok: false, reason: phaseReason };
  const p = state.players[pid];
  if (!p) return { ok: false, reason: `玩家 ${pid} 不存在` };
  if (p.dead) return { ok: false, reason: "已淘汰观战，不能再出手" };
  if (p.zone === "done") return { ok: false, reason: "通关席不再行动" };
  if (p.confirmed) return { ok: false, reason: "已确认结束（等待区），本窗不能再操作" };
  if (p.skipped) return { ok: false, reason: "本回合罚停轮空——不能出手" };
  return { ok: true, player: p };
}

/** 海关报备转让闸（#26 T7；内核执行 + 壳层置灰共用一份口径）：海关风云在窗 + 窗内动作资格 +
 *  卡在手 + 收货方在场。**明面只许正货的报备货名校验**在结算侧（违禁品报备即拒）。
 *  沙困行囊（禁道具）不管转让——那是「打不出卡」，不是「运不了货」（实现期定案，实玩复查回表）。 */
export function customsShipGate(state: GameState, pid: number, cardId: string, to: number): PlayGate {
  if (!state.customs) return { ok: false, reason: "当前没有海关风云（先抽到「黑市开张」）" };
  const act = windowActGate(state, pid, "只有世界回合窗内可以报备转让");
  if (!act.ok) return act;
  if (!act.player.hand.includes(cardId)) return { ok: false, reason: "这张卡不在你的手牌里" };
  const q = state.players[to];
  if (!q || q.id === pid) return { ok: false, reason: "转让对象要选别人" };
  if (q.dead) return { ok: false, reason: `${q.name} 已淘汰——不能再收货` };
  if (q.zone === "done") return { ok: false, reason: `${q.name} 已在通关席——不着陆` };
  return { ok: true };
}

/** 海关查验闸（#26 T7）：警长本人（先判身份再走资格阶梯）+ 未退化、有余次、无未了结罚没；
 *  目标报备单未查过、非警长自己经手、报备人仍在场（一单限查一次）。 */
export function customsCheckGate(state: GameState, pid: number, shipment: number): PlayGate {
  const c = state.customs;
  if (!c) return { ok: false, reason: "当前没有海关风云" };
  if (pid !== c.sheriff) return { ok: false, reason: "只有警长可以查验" };
  const act = windowActGate(state, pid, "只有世界回合窗内可以查验");
  if (!act.ok) return act;
  if (c.degraded) return { ok: false, reason: "警长已撤岗——本窗退化为自由转让（无查验）" };
  if (c.checksLeft <= 0) return { ok: false, reason: "查验次数已用尽" };
  if (c.pending) return { ok: false, reason: "上一单的罚没了结前不能再查" };
  const s = c.shipments.find((x) => x.id === shipment);
  if (!s) return { ok: false, reason: "没有这张报备单" };
  if (s.checked) return { ok: false, reason: "这单已经查过了" };
  if (s.from === pid) return { ok: false, reason: "不能查验自己经手的报备" };
  const f = state.players[s.from];
  if (!f || f.dead || f.zone === "done") return { ok: false, reason: "报备人已不在对局——这单查不着了" };
  return { ok: true };
}

// ---------- 最后一波·年兽战三闸（#27 T8a2；内核执行 + 壳层置灰共用一份口径） ----------

/** 砍击闸（T8a2）：年兽战波窗内+参战名册（fight/seat——seat 必参战）+本波未砍+非罚停轮空——
 *  资格阶梯与递卡/直砸同走 fighterActGate（三闸一套账）。 */
export function strikeGate(state: GameState, pid: number): PlayGate {
  const act = fighterActGate(state, pid);
  if (!act.ok) return act;
  if (act.player.rolled) return { ok: false, reason: "本波已砍过——等年兽反噬后下一波" };
  return { ok: true };
}

/** 递卡闸（T8a2）：年兽战波窗内+递卡人参战+卡在手+收卡人=另一名参战者（通关席可收——
 *  递治疗给通关席是正经合作；淘汰者不收货）。 */
export function giveItemGate(state: GameState, pid: number, cardId: string, to: number): PlayGate {
  if (state.phase !== "acting" || state.endgame?.beast == null) return { ok: false, reason: "只有最后一波的波窗内可以递卡" };
  const act = fighterActGate(state, pid);
  if (!act.ok) return act;
  if (!act.player.hand.includes(cardId)) return { ok: false, reason: "这张卡不在你的手牌里" };
  const q = state.players[to];
  if (!q || q.id === pid) return { ok: false, reason: "递卡对象要选别人" };
  if (q.dead) return { ok: false, reason: `${q.name} 已淘汰——不能再收货` };
  if (q.endgame !== "fight" && q.endgame !== "seat") return { ok: false, reason: `${q.name} 不在参战名册` };
  return { ok: true };
}

/** 递卡合法目标集合（T8a2，HandDock 递卡按钮消费）：活着且在参战名册的其他人 */
export function giveTargets(state: GameState, pid: number): number[] {
  return state.players
    .filter((q) => !q.dead && q.id !== pid && (q.endgame === "fight" || q.endgame === "seat"))
    .map((q) => q.id);
}

/** 直砸闸（T8a2）：年兽战波窗内+砸卡人参战+卡在手——任意卡通用（多掷一刀伤害骰）。 */
export function hitBeastGate(state: GameState, pid: number, cardId: string): PlayGate {
  if (state.phase !== "acting" || state.endgame?.beast == null) return { ok: false, reason: "当前没有年兽战" };
  const act = fighterActGate(state, pid);
  if (!act.ok) return act;
  if (!act.player.hand.includes(cardId)) return { ok: false, reason: "这张卡不在你的手牌里" };
  return { ok: true };
}

/** 年兽战动作资格（giveItem/hitBeast 共用的前置阶梯）：波窗内+活着+参战名册+非罚停轮空 */
function fighterActGate(state: GameState, pid: number): { ok: true; player: PlayerState } | { ok: false; reason: string } {
  if (state.phase !== "acting" || state.endgame?.beast == null) return { ok: false, reason: "当前没有年兽战" };
  const p = state.players[pid];
  if (!p) return { ok: false, reason: `玩家 ${pid} 不存在` };
  if (p.dead) return { ok: false, reason: "已淘汰观战——不参战" };
  if (p.endgame !== "fight" && p.endgame !== "seat") return { ok: false, reason: "不在参战名册" };
  if (p.skipped) return { ok: false, reason: "本波罚停轮空——不能出手" };
  return { ok: true, player: p };
}
