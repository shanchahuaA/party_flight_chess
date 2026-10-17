/**
 * 内核类型：状态／意图／事实／战报。内核 API 的全部形状都在这里。
 * 一切按"意图入 → 新权威状态 + 事实 + 战报 slice"的口径收口；
 * M2 时这批类型直接变成 WS 意图/事实协议（ADR 0001），形状不再变化。
 */
import type { CellType, Eco, StreetKey } from "./board";
import type { DiceMod, EffectPart } from "./data/events";
import type { Axis, RoleId } from "./data/roles";

// ---------- 战报（界面呈现定案 §三 MessageEntry，结构不动） ----------

export type MessageKind = "event" | "trap" | "item" | "malice" | "system" | "summary" | "score";

export interface MessageEntry {
  id: number;
  /** 世界回合号（分节线依据） */
  turn: number;
  kind: MessageKind;
  who?: number;
  targets?: number[];
  text: string;
  flavor?: string;
  emphasis?: "normal" | "highlight" | "target" | "big";
}

// ---------- 玩家与局状态 ----------

export interface PlayerState {
  id: number;
  name: string;
  isBot: boolean;
  colorIndex: number;
  /** 明选角色（表三；可重复选同一角色） */
  roleId: RoleId;
  /** 三轴 6 点：检定掷 1d20+对应轴加值（表三）；属性不常驻屏幕（壳层弹层纪律） */
  axes: Record<Axis, number>;
  /** 血量：开局满血，扣血/治疗密度按数值表 §5.3（T5 扣血管道消费） */
  hp: number;
  /** 皮糙肉厚的「免疫第一次扣血」剩余盾（开局 1，触发后清零；T5 消费） */
  shields: number;
  /** 护身符（表一 #14 T4b1）：免疫下一次任何伤害，触发即消耗；1=盾亮着 */
  talisman: number;
  /** 小圆盾（表一 #9 T4b1）：免疫「他人卡牌效果」的世界回合号（打出时设为 turn+1=下回合；随窗自然失效） */
  cardGuard: number;
  /** 主网位置（zone==='main' 时即所站格 id；branch 时恒为出生格 id） */
  pos: number;
  /** 上一步来向：走格惯性、排除回头、超时直行都看它 */
  from: number | null;
  /** 来路栈：退格沿它原路退回（含穿环岛不重弹） */
  trail: number[];
  /** 净步：主干进 +1、逆行 −1；≥ NET_GOAL 时前向踩出生格即入门 */
  net: number;
  zone: "main" | "branch" | "done";
  /** 终点支路步位 0..BRANCH_LEN（0=尾声门口） */
  bpos: number;
  /** 本窗已掷 */
  rolled: boolean;
  /** 本窗已确认（确认结束=进等待区） */
  confirmed: boolean;
  /** 罚停余量：下个世界回合开始时逐个消耗并轮空（T3a 卡面效果挂点） */
  stun: number;
  /** 本窗罚停轮空标记（openWindow 消耗罚停时点亮、随窗重置；柜面拒因/T4a2 隐藏入口用） */
  skipped: boolean;
  /** 出局占位（T5 挂钩） */
  dead: boolean;
  /** 自己的出生格（兼终点支路入口；按人数菜单落座，各占一角相望） */
  spawnCell: number;
  /** 暗牌：抽到的 2 条目标（表四 no）。M1 单机=战报保密口径（secret.test）；M2 联机下发时按玩家切片可见性（ADR 0001），他人不得收到 */
  secretOptions: [number, number];
  /** 选定下标（0|1）：真人选后落定；假人开局由系统代抽 */
  secretPick: number | null;
  /** 假人的窗口内日程（rollAt 到点自动掷；walk 结束后到点自动确认） */
  botSchedule: { rollAt: number; confirmAt: number };
  walk: WalkState | null;
  /** 卡面效果排队的续走（正=前进负=沿栈退）：walk 被占用时入队，走完自动接（T3a 卡面连动） */
  walkQueue: number[];
  /** 抉择卡挂起：触发者本人应答（chooseCard），超时按卡面默认项代选并标「(代选)」（T3a2 壳消费） */
  cardPending: { cardId: string; deadline: number } | null;
  /** 本窗已触发抽卡次数（连抽上限，防卡面引走格无限连环） */
  cardDraws: number;
  /** 手牌（道具卡 id 列表，**无上限**；本人可见——他人视图 M2 按玩家切片下发，T7 谎报机制前置） */
  hand: string[];
  /** 积压的走格骰修正（T4a：顺风靴/脚镣/幸运骰……下次掷骰一次性消费，多张先互抵） */
  rollMods: DiceMod[];
  /** 本回合内所有检定吃的修正批（#32 T4b2 风暴·戈壁沙暴行：行动前挂、回合开始重刷；走格骰不吃它） */
  checkMods: DiceMod[];
  /** 轻装上阵被动「穿戴类负面减半（2 层并 1）」的半分账（每次穿戴类负面 +1，满 2 折合 1 层真效果） */
  wearHalves: number;
  /** 禁道具挂账（#33 T5b 沙困行囊）：剩余禁道具的世界回合数，开窗消费进 itemBanned */
  itemBan: number;
  /** 本窗禁道具：itemPlayGate 按它拒「打道具卡」（开窗置位、随窗自然解除，不随确认重置） */
  itemBanned: boolean;
}

export interface RouteOption {
  to: number;
  street: StreetKey;
  label: string;
}

export interface WalkState {
  /** 还要走的格数（正值=前进，负值=沿来路栈退回） */
  remaining: number;
  nextStepAt: number;
  /** 环岛选路条：非空即停在岔口等人选 */
  ask: { options: RouteOption[]; deadline: number } | null;
  pendingTo: number | null;
  bounced: boolean;
  /** true=本窗走格骰发团的走（重掷只对付它）；false=卡面/off 效果发的走（重掷不管） */
  dice: boolean;
  /** 本骰总步数（掷出时的有效面；已走步数=total−remaining，时光怀表重掷对照，T4b1） */
  total: number;
  /** 本骰吃到的修正批（一次性消费后随骰带走；重掷沿用同批——时光怀表 T4b1） */
  mods?: DiceMod[];
}

export type GamePhase = "drafting" | "acting" | "rest" | "over";

/** 指向他人的卡面效果挂账：下一世界回合开始时结算（openWindow 消费；M2 随协议下发）。
 *  kind/srcPid 记效果来源（道具卡/事件卡 + 打出者）——小圆盾「免疫他人卡牌效果」的拦截判据（T4b1）。 */
export interface DeferredEffect {
  pid: number;
  parts: EffectPart[];
  /** 效果来源通道（T4b1 起必带；客户端/M2 视为协议字段） */
  kind: "item" | "event";
  /** 打出者/触发者 pid（小圆盾拦截同源不拦） */
  srcPid: number;
}

/** 场地型附着（香蕉皮/地雷……T4a）：打出即钉在格上，下一踩上者（含铺设者本人）触发判定后消失 */
export interface GroundMark {
  /** 附着格 id */
  cell: number;
  /** 道具卡 id */
  cardId: string;
  /** 铺设者（战报归因 + T4a2 角标提示） */
  owner: number;
}

export interface GameState {
  turn: number;
  phase: GamePhase;
  /** 本窗截止时间戳（仅 acting） */
  windowDeadline: number;
  /** 休息截止时间戳（仅 rest） */
  restUntil: number;
  players: PlayerState[];
  /** 通关席名次（按踩进先后） */
  finishers: number[];
  messages: MessageEntry[];
  /** 事件牌堆单池洗匀（抽完弃牌堆洗回——事件定案 §1.8；deck+discard 恒守恒） */
  deck: string[];
  discard: string[];
  /** 道具牌堆单池洗匀（同上守恒：itemDeck+itemDiscard+各人手牌 恒等于 M1 池） */
  itemDeck: string[];
  itemDiscard: string[];
  /** 场上的场地型附着（踩上触发后消失；T4a2 棋盘角标渲染数据） */
  ground: GroundMark[];
  /**
   * 现役全场环境（《生物圈 3 号》三原则，#32 T4b2）：一场同时最多 1 个环境生效——后打的顶掉前一个
   * （旧环境即时失效），打出者摸 1 张补偿。打出当回合不触发；此后每个世界回合开始结算一次
   * （按所在生态地形行），left 减到 0=气候平息自然失效。null=无气候。
   */
  ambient: { cardId: string; /** 剩余触发回合数（回合开始结算一次后 −1；0=到期失效） */ left: number } | null;
  /** 指向他人的卡面效果（world·即时）：下一世界回合开始时结算（窗口 openWindow 消费） */
  deferred: DeferredEffect[];
  /** 内部：战报 id 发号与 RNG 状态（随状态走，M2 快照恢复随机流） */
  seq: number;
  rngState: number;
}

// ---------- 意图（上行） ----------

export interface GameConfig {
  seed: number;
  /** 局长：世界回合总数（5..30，默认 15；开局定死、局中冻结） */
  turnCap: number;
  /** 血量上限（5..20，默认 10；开局定死、局中冻结；T5 扣血管道消费） */
  maxHp: number;
  /** 世界回合窗毫秒（10..90s 域、默认 30s；档位口径见一页纸规则 10/15/20/30/60/90） */
  windowMs: number;
  /** 回合间休息毫秒（0..20000 可调，默认 10000，0=直接开下一窗） */
  restMs: number;
  /** 计时模式：world=世界·即时（默认）；turn=轮班·限时（T9 完整接线，本票先收数据） */
  timerMode: "world" | "turn";
  /** 环岛选路等待毫秒（默认 10000，规格定死不可调） */
  routeAskMs: number;
  /** 逐格走格节拍毫秒（客户端动画节奏的事实事实锚，默认 140） */
  stepMs: number;
  /** 测试通道：允许 dev 意图（默认 false；单测开） */
  allowDev?: boolean;
}

export type Intent =
  | { type: "roll"; pid: number }
  | { type: "confirm"; pid: number }
  | { type: "chooseRoute"; pid: number; option: number }
  | { type: "skipRest" }
  /** 开局暗牌抽 2 选 1（真人本人选；drafting 期唯一前置动作，假人由系统代抽） */
  | { type: "chooseSecret"; pid: number; pick: number }
  /** 事件卡抉择应答：挂起本人点选项下标（超时未应答由系统按默认项代选，战报标 (代选)） */
  | { type: "chooseCard"; pid: number; option: number }
  /** 打道具卡（T4a）：确认结束之前的窗内任意时刻、张数不限；target 仅 chooseOther 类需要 */
  | { type: "playItem"; pid: number; cardId: string; target?: number }
  /** 测试/后接卡面效果专用的直调通道（allowDev=false 时拒绝） */
  | { type: "dev.back"; pid: number; steps: number }
  | { type: "dev.setPos"; pid: number; pos: number; from: number | null; net: number }
  | { type: "dev.setHp"; pid: number; hp: number }
  | { type: "dev.setDead"; pid: number }
  | { type: "dev.drawCard"; pid: number; cardId: string }
  /** 从牌堆/弃牌堆取指定道具卡塞进手牌（道具链冒烟/测试用） */
  | { type: "dev.giveItem"; pid: number; cardId: string }
  /** 直接吃 dmg 点伤害（走 applyHpDelta 完整通道：护身符/盾照拦；伤害链单测不绕弯路） */
  | { type: "dev.hit"; pid: number; dmg: number };

// ---------- 事实（下行：客户端据此动起来） ----------

export type Fact =
  | { type: "windowStart"; turn: number; deadline: number }
  | { type: "windowEnd"; turn: number; auto: boolean }
  | { type: "restStart"; turn: number; until: number }
  | { type: "gameEnd" }
  | { type: "secretPicked"; pid: number }
  | { type: "roll"; pid: number; d: number; auto: boolean; mods?: DiceMod[] }
  | { type: "confirm"; pid: number; auto: boolean }
  /** 主网逐格走（含退格步） */
  | { type: "step"; pid: number; from: number; to: number; dir: 1 | -1 }
  /** 终点支路逐格走 */
  | { type: "stepBranch"; pid: number; bpos: number; dir: 1 | -1 }
  | { type: "branchEnter"; pid: number }
  | { type: "bounce"; pid: number }
  | { type: "bounceExit"; pid: number }
  | { type: "finish"; pid: number }
  | { type: "routeAskOpen"; pid: number; options: RouteOption[]; deadline: number }
  | { type: "routeChosen"; pid: number; to: number; auto: boolean }
  /** 事件卡：抽到（T3a2 中央抉择浮层挂卡面入口）／抉择落定（auto=代选） */
  | { type: "cardDrawn"; pid: number; cardId: string }
  | { type: "cardResolved"; pid: number; cardId: string; option: number; auto: boolean }
  /** 道具卡：摸入（踩道具格/卡面/双倍惊喜；id 供本人壳层亮牌）／打出（T4a2 壳层演出） */
  | { type: "itemDrawn"; pid: number; cardId: string }
  | { type: "itemPlayed"; pid: number; cardId: string; target?: number }
  /** 棋盘联动：说明性脉冲（界面呈现定案 §四 S1 描边） */
  | { type: "pulse"; pid: number; level: "normal" | "target" | "big" };

export interface PlayerDef {
  name: string;
  isBot: boolean;
  /** 明选角色（表三 RoleId；缺省：真人=轻装上阵，假人=系统随机） */
  roleId?: RoleId;
}

/** 内核错误：意图非法/状态机拒绝。UI 捕获后静默或提示，永不崩局。 */
export class KernelError extends Error {}
