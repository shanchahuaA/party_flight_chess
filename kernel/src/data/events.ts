/**
 * 事件卡表（内容数值表 · 表二，21 张）+ 卡面 DSL（事件卡系统定案 §二 跑团化扩展）。
 *
 * DSL 口径（#19 T3a）：
 * - EffectPart 原语：move/back/skip/hp/drawItem/trial/check/none；check 内含检定三态
 *   （1d20+对应轴 vs 卡面 DC）+ 骰 20/骰 1 极值分支（当卡自带行为级分支，缺省回落过/败）。
 * - 骰面修正四原语（cut 削面／raise 升面／floor 保底／flat 加值）：同一次检定先互相抵消再结算。
 * - gamble 标签：赌狗时刻 3 张（表二显式卡牌类型兑现），T8 暗牌「赌狗」计数走战报流。
 * - 地区特殊卡：region 挂生态——抽卡者不在该生态时洗牌堆重抽（事件定案 §1.8）。
 * - kind='window'（黑市开张/警长查货窗）：M1 牌池不含，T7 起接入。
 * 目标六类/道具卡表（ItemCard）T4a 起落在 data/items.ts，共用本文件的 EffectPart/DiceMod 原语。
 */
import type { Eco } from "../board";
import type { Axis } from "./roles";
import { back, drawItem, hp, move, noEffect, skip } from "./primitives";

export type { Axis } from "./roles";

/** 检定 DC 参考档（表五 §5.2）：易 8（65%）／中 12（45%）／难 16（25%） */
export const DC_TIERS = { easy: 8, mid: 12, hard: 16 } as const;
export type DCTier = keyof typeof DC_TIERS;

/** 骰面修正四原语：同一次检定先互抵再结算（check.ts netMods 消费）；T4a 起走格骰复用同型 */
export interface DiceMod {
  mode: "cut" | "raise" | "floor" | "flat";
  v: number;
  /** 来源卡名（走格骰战报括注「顺风靴 +3」） */
  src?: string;
  /** 穿戴类负面（脚镣/削面）·T4a：轻装上阵被动「减半（2 层并 1）」按它识别落账 */
  wear?: true;
}

export interface CheckSpec {
  /** 检定轴（力/敏/运；缺省=无轴前途骰，如命运之骰裸 1d20 分档） */
  axis?: Axis;
  /** 卡面自带 DC（给出即走通过线 vs DC） */
  dc?: number;
  /** 参考档锚（易8/中12/难16；与 dc 同给时数据校验一致性） */
  tier?: DCTier;
  /** 检定域（内核自建遭遇场景用，表五 roleCheckMods 同名口径）：dogFight=野狗遭遇战专指
   *  ——猎手特长只在该域生效；卡面缺省不设=全域通用检定（T6b 连线）。 */
  scope?: "dogFight";
  /** 骰面修正四原语（与角色特长合并后互抵） */
  mods?: DiceMod[];
  /** 骰 20 大成功分支（当卡自带额外正面；缺省回落 onPass） */
  onCrit?: EffectPart[];
  /** 骰 1 大失败分支（当卡自带额外负面；缺省回落 onFail） */
  onCritFail?: EffectPart[];
  /** 通过分支（缺省=无事） */
  onPass?: EffectPart[];
  /** 失败分支（缺省=无事） */
  onFail?: EffectPart[];
  /** 面值分档（无 dc 的前途骰）：按有效面顺序首中；末条不带 min/max = 兜底（覆盖 ≤10 类表述） */
  bands?: Array<{ min?: number; max?: number; parts: EffectPart[] }>;
}

export type EffectPart =
  | { type: "move"; v: number }
  | { type: "back"; v: number }
  | { type: "skip"; v: number }
  | { type: "hp"; v: number }
  | { type: "drawItem"; v: number }
  /** 再抽 1 张事件卡（时来运转类；内核串行结算，可再挂起新抉择） */
  | { type: "trial" }
  | { type: "check"; spec: CheckSpec }
  /** 走格骰修正（下次掷骰一次性消费；T4a 顺风靴 +3／脚镣削面／幸运骰保底——多张先互抵） */
  | { type: "rollMod"; mods: DiceMod[] }
  /** 重掷本次走格骰（表一 #2 时光怀表，T4b1）：需走在路上（骰走发团），用本骰修正批重掷、新面替换余步 */
  | { type: "reroll" }
  /** 与打出者互换位置（表一 #8 偷天换日，T4b1）：作用于指认目标；双方须在主干道（执行时校验） */
  | { type: "swap" }
  /** 免疫下一次任何伤害（表一 #14 护身符，T4b1）：触发即消耗（applyHpDelta 拦一道） */
  | { type: "talisman" }
  /** 下回合免疫他人卡牌效果（表一 #9 小圆盾，T4b1）：cardGuard=turn+1，applyParts 入口按 ctx 判据拦截 */
  | { type: "roundShield" }
  /** 清除当前格起前方 v 格内全部场地型卡（表一 #18 清障符，T4b1）：BFS 前向（来路作后界），收走上限深度 */
  | { type: "clearGround"; v: number }
  // ---- T5b 新原语（#33 陷阱格三格专属，#33 落卡；其余渠道现无数据位）----
  /** 传送回**自己**的出生格（#33 流沙坑/回旋沙柱）：净步保留、来向/来路栈清空（与偷天换日退格口径一致）；支路/通关席状态复位主干道位 */
  | { type: "teleport" }
  /** 随机弃手牌 v 张进弃牌堆（#33 贼赃房：单池守恒；无卡可弃=落空出声） */
  | { type: "discard"; v: number }
  /** 禁道具 v 个世界回合（#33 沙困行囊）：开窗消费 itemBan→itemBanned，本窗打不出道具卡；无伤害无位移 */
  | { type: "itemBan"; v: number }
  /** 狗笛生成（表一 #16，T6b）：受指向者相邻格生成 1 只标准野狗（4 血/3 世界回合寿命）+生成当拍同格照打遭遇战 */
  | { type: "dogSpawn" }
  | { type: "none" };

export interface TargetedEffect {
  /** 系统指认（事件定案 §1.5/§5.2）：跳过淘汰者与通关席；轮班=立即、世界·即时=下回合（运行时按模式） */
  target: "nearestToGoal" | "farthestFromGoal" | "previous" | "random" | "all";
  parts: EffectPart[];
}

export interface CardEffect {
  /** 对触发者/使用者（即时） */
  self?: EffectPart[];
  /** 指向他人（整蛊）：world 模式下一世界回合开始时结算 */
  others?: TargetedEffect[];
}

export interface CardOption {
  /** 选项文案（整蛊核落点） */
  label: string;
  effect: CardEffect;
}

export interface EventCard {
  id: string;
  /** 表二序号 */
  no: number;
  title: string;
  /** 一句场景文案（叙事皮：春节怪谈×庄园） */
  flavor: string;
  kind: "choice" | "effect" | "window";
  /** 地区特殊卡：仅抽卡者在该生态结算，否则洗回重抽 */
  region?: Eco;
  /** 赌狗时刻标签（表二 3 张；T8 暗牌「赌狗」计数） */
  gamble?: true;
  /** kind=choice 必填 */
  options?: CardOption[];
  /** kind=choice 必填：超时/挂机/假人代选下标（通常安全或中庸项） */
  defaultOption?: number;
  /** kind=effect 必填（window 卡的结算数据 T7 落） */
  effect?: CardEffect;
}

// ---- 原语速写见 data/primitives.ts（两张数据表同一份构造器） ----

const selfFx = (parts: EffectPart[]): CardEffect => ({ self: parts });

export const EVENT_CARDS: readonly EventCard[] = [
  {
    id: "e01",
    no: 1,
    title: "穿堂风",
    flavor: "穿堂的风灌进走廊，帽檐都在抖。",
    kind: "choice",
    options: [
      { label: "蹲下躲风", effect: selfFx([noEffect]) },
      { label: "顶风前行", effect: selfFx([move(2)]) },
    ],
    defaultOption: 0,
  },
  {
    id: "e02",
    no: 2,
    title: "温泉房",
    flavor: "门缝里漏出白雾，暖得让人挪不动脚。",
    kind: "choice",
    region: "plain",
    options: [
      { label: "泡一下", effect: selfFx([hp(2)]) },
      { label: "泡个够", effect: selfFx([hp(3), skip(1)]) },
    ],
    defaultOption: 0,
  },
  {
    id: "e03",
    no: 3,
    title: "断桥",
    flavor: "桥断了一半，下面黑得看不见底。",
    kind: "choice",
    options: [
      { label: "绕远路", effect: selfFx([back(2)]) },
      {
        label: "冒险跳过去",
        effect: selfFx([{ type: "check", spec: { axis: "might", dc: 12, tier: "mid", onPass: [move(3)], onFail: [hp(-1)] } }]),
      },
    ],
    defaultOption: 0,
  },
  {
    id: "e04",
    no: 4,
    title: "捡到钱袋",
    flavor: "墙角躺着一只鼓鼓的红纸袋。",
    kind: "choice",
    options: [
      { label: "归还失主", effect: selfFx([drawItem(1)]) },
      { label: "自己收下", effect: selfFx([move(1)]) },
    ],
    defaultOption: 0,
  },
  {
    id: "e05",
    no: 5,
    title: "醉酒的守卫",
    flavor: "守卫抱着酒葫芦睡得很沉。",
    kind: "choice",
    options: [
      { label: "踮脚溜过", effect: selfFx([move(2)]) },
      { label: "扶他一把", effect: selfFx([drawItem(1)]) },
    ],
    defaultOption: 0,
  },
  {
    id: "e06",
    no: 6,
    title: "电梯还是楼梯",
    flavor: "电梯门大开着，楼梯就在旁边。",
    kind: "choice",
    options: [
      { label: "走楼梯", effect: selfFx([noEffect]) },
      { label: "乘电梯", effect: selfFx([move(3), skip(1)]) },
    ],
    defaultOption: 0,
  },
  {
    id: "e07",
    no: 7,
    title: "捡到香蕉皮",
    flavor: "地上有一根完好的香蕉皮。",
    kind: "choice",
    options: [
      { label: "收好", effect: selfFx([drawItem(1)]) },
      { label: "丢掉", effect: selfFx([noEffect]) },
    ],
    defaultOption: 0,
  },
  {
    id: "e08",
    no: 8,
    title: "猜拳机器人",
    flavor: "石台上的机器人朝你伸出拳头。",
    kind: "choice",
    gamble: true,
    options: [
      { label: "绕行", effect: selfFx([noEffect]) },
      {
        label: "应战",
        effect: selfFx([
          {
            type: "check",
            spec: {
              axis: "luck",
              dc: 10,
              onPass: [move(3)],
              onCrit: [move(6)],
              onFail: [back(2)],
            },
          },
        ]),
      },
    ],
    defaultOption: 0,
  },
  {
    id: "e09",
    no: 9,
    title: "熔岩喷口",
    flavor: "地缝正往外渗岩浆，热气扑脸。",
    kind: "choice",
    region: "gobi",
    options: [
      { label: "等它停歇", effect: selfFx([skip(1)]) },
      {
        label: "踏岩而过",
        effect: selfFx([{ type: "check", spec: { axis: "agile", dc: 12, tier: "mid", onPass: [move(3)], onFail: [hp(-1)] } }]),
      },
    ],
    defaultOption: 0,
  },
  {
    id: "e10",
    no: 10,
    title: "冰面滑道",
    flavor: "一条冰滑道斜斜通往塔下层。",
    kind: "choice",
    region: "snow",
    options: [
      { label: "稳步绕行", effect: selfFx([noEffect]) },
      {
        label: "坐滑道",
        effect: selfFx([{ type: "check", spec: { axis: "agile", dc: 10, onPass: [move(4)], onFail: [back(2)] } }]),
      },
    ],
    defaultOption: 0,
  },
  {
    id: "e11",
    no: 11,
    title: "岔路口·宝箱与陷阱",
    flavor: "岔路口立着两只箱子，一实一空。",
    kind: "choice",
    options: [
      { label: "走险路", effect: selfFx([drawItem(1), back(2)]) },
      { label: "走稳路", effect: selfFx([noEffect]) },
    ],
    defaultOption: 0,
  },
  {
    id: "e12",
    no: 12,
    title: "岔路口·近路与远路",
    flavor: "近路墙皮剥落，远路平平坦坦。",
    kind: "choice",
    options: [
      { label: "抄近路", effect: selfFx([move(2), hp(-1)]) },
      { label: "绕远路", effect: selfFx([noEffect]) },
    ],
    defaultOption: 0,
  },
  {
    id: "e13",
    no: 13,
    title: "命运之骰",
    flavor: "骰盅立在青石阶上，正等下一只手。",
    kind: "choice",
    gamble: true,
    options: [
      { label: "稳住收手", effect: selfFx([noEffect]) },
      {
        label: "掷前途骰",
        effect: selfFx([
          {
            type: "check",
            spec: {
              // 前途检定：表二裸 1d20 无轴（20=前进 6／1=回退 4／≥11=前进 4／≤10=回退 3）
              bands: [
                { min: 11, parts: [move(4)] },
                { parts: [back(3)] },
              ],
              onCrit: [move(6)],
              onCritFail: [back(4)],
            },
          },
        ]),
      },
    ],
    defaultOption: 0,
  },
  {
    id: "e14",
    no: 14,
    title: "孤注一掷",
    flavor: "灯影里写着一行小字：压上什么，带走更多。",
    kind: "choice",
    gamble: true,
    options: [
      { label: "收手", effect: selfFx([noEffect]) },
      {
        label: "压上赌运",
        effect: selfFx([
          {
            type: "check",
            // 表二未标轴：T3a 实装按赌运定（=DC16 难档，参考 §5.2 高险高收益捷径）；过表可改
            spec: { axis: "luck", dc: 16, tier: "hard", onPass: [move(5), drawItem(1)], onFail: [hp(-2), skip(1)] },
          },
        ]),
      },
    ],
    defaultOption: 0,
  },
  {
    id: "e15",
    no: 15,
    title: "新年红包",
    flavor: "空箱滑到脚边，掀开来还烫手。",
    kind: "effect",
    effect: selfFx([drawItem(1)]),
  },
  {
    id: "e16",
    no: 16,
    title: "一路顺风",
    flavor: "一阵暖风贴着地面推了你一把。",
    kind: "effect",
    effect: selfFx([move(2)]),
  },
  {
    id: "e17",
    no: 17,
    title: "全员拜年",
    flavor: "锣鼓声起，满屋的人都起身拱手。",
    kind: "effect",
    effect: { others: [{ target: "all", parts: [move(1)] }] },
  },
  {
    id: "e18",
    no: 18,
    title: "全员大扫除",
    flavor: "灯笼影里，扫帚自己立了起来。",
    kind: "effect",
    effect: { others: [{ target: "all", parts: [back(1)] }] },
  },
  {
    id: "e19",
    no: 19,
    title: "庄园鼠横行",
    flavor: "窸窣声过，一群田鼠从墙洞里窜出。",
    kind: "effect",
    effect: { others: [{ target: "random", parts: [back(2)] }] },
  },
  {
    id: "e20",
    no: 20,
    title: "主楼停电",
    flavor: "整座主楼的灯闪了一下，随之一暗。",
    kind: "effect",
    effect: { others: [{ target: "nearestToGoal", parts: [skip(1)] }] },
  },
  {
    id: "e21",
    no: 21,
    title: "黑市开张",
    flavor: "后巷一块井盖被掀开，油灯次第亮起。",
    kind: "window",
    // 警长查货窗：完整规则见一页纸规则「警长查货窗」节；结算数据 T7 落，M1 牌池不含
  },
];

const BY_ID = new Map(EVENT_CARDS.map((c) => [c.id, c]));
export const EVENT_CARD_BY_ID = BY_ID;

/** M1 牌池（表二 20 张；'window' 卡等 T7 接入后放行） */
export const M1_EVENT_POOL: readonly EventCard[] = EVENT_CARDS.filter((c) => c.kind !== "window");

// ---- 数据完整性校验（load 期执行，卡面坏账立刻炸） ----
{
  if (BY_ID.size !== EVENT_CARDS.length) throw new Error("事件卡 id 重复");
  const walk = (spec: CheckSpec) => {
    if (spec.tier && spec.dc != null && DC_TIERS[spec.tier] !== spec.dc) {
      throw new Error(`检定档位 ${spec.tier}(=${DC_TIERS[spec.tier]}) 与 DC ${spec.dc} 不一致`);
    }
  };
  const scan = (parts: EffectPart[]) => {
    for (const p of parts) if (p.type === "check") walk(p.spec);
  };
  for (const c of EVENT_CARDS) {
    if (c.kind === "choice") {
      if (!c.options || c.options.length < 2) throw new Error(`事件卡 ${c.id} 抉择卡至少 2 项`);
      const d = c.defaultOption;
      if (d == null || d < 0 || d >= c.options.length) throw new Error(`事件卡 ${c.id} 默认项下标越界`);
      for (const o of c.options) scan(o.effect.self ?? []);
    } else if (c.kind === "effect" && !c.effect) {
      throw new Error(`事件卡 ${c.id} 纯效果卡缺 effect`);
    }
    for (const t of c.effect?.others ?? []) scan(t.parts);
  }
}
