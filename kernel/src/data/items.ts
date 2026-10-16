/**
 * 道具卡表（内容数值表 · 表一，全池 20 张）+ 道具打出链数据面（#21 T4a / #22 T4b1）。
 *
 * 目标路由（#10 定案目标六类，T4a 三类起步、T4b1 补全非环境）：
 *   `self` 自身 ｜ `chooseOther` 自选他人（打出时提交目标意图，内核验合法） ｜ `ground` 场地型
 *   （附着当前格，下一踩上者——含铺设者本人——触发判定后消失）｜ `auto` 自动指认
 *   （**卡面写死指认规则** autoRule：系统按规则选目标，无目标=指认落空；淘汰者/通关席自动跳过）。
 *   余 `allOthers` 全体（表一首批空缺）／`ambient` 全场环境（表一 3 张雷暴/暴雨/风暴 → T4b2 票）。
 *
 * T4a 首批落数 10 张（覆盖三类通路 + 违禁 4 + 走格骰修正三原语）；
 * T4b1 补落非环境余 7 张（时光怀表/偷天换日/小圆盾/护身符/加倍骰/狗笛/清障符），
 * 池内全池 17 张临时到齐；环境卡 3 张 T4b2 追加至 20。编号沿用表一序号。
 *
 * 口径：10 血／走格 1d10；违禁 7 张全池清单见 CONTRABAND_TITLES（警长查货窗 T7 消费）。
 */
import type { CheckSpec, EffectPart, TargetedEffect } from "./events";
import { DC_TIERS } from "./events";
import { back, clearGround, drawItem, hp, move, reroll, rollMod, roundShield, swap, talisman } from "./primitives";

export type ItemRoute = "self" | "chooseOther" | "auto" | "ground";

/** 场地型踩上判定（香蕉皮/地雷）：过=安全，败=负面；无论过败触发即消耗 */
export interface GroundSpec {
  check: CheckSpec;
}

export interface ItemCard {
  id: string;
  /** 表一序号（1..20） */
  no: number;
  title: string;
  /** 一句场景文案（叙事皮：春节怪谈×庄园） */
  flavor: string;
  /** 目标路由（T4a self/chooseOther/ground；T4b1 auto；allOthers/ambient 后票扩） */
  route: ItemRoute;
  /** 整蛊类=违禁品（表一 7 张）：警长查货窗走私清单（T7 行为）；壳层视觉标识随 T4a2 */
  contraband?: true;
  /** self/chooseOther/auto 的结算原语（chooseOther/auto 的 parts 落到指认目标身上） */
  parts?: EffectPart[];
  /** ground 专用：踩上判定数据 */
  ground?: GroundSpec;
  /** auto 路由专用：卡面写死指认规则（与事件卡系统指认同型，淘汰者/通关席自动跳过） */
  autoRule?: TargetedEffect["target"];
  /** 效果挂后续票的占位卡（表一 #16 狗笛=T6b 野狗生成）：打出照常落账，效果先挂「T# 起接入」 */
  tbd?: string;
}

// ---- 卡片表（原语速写共用 data/primitives.ts） ----

export const ITEM_CARDS: readonly ItemCard[] = [
  {
    id: "i01",
    no: 1,
    title: "顺风靴",
    flavor: "靴筒里灌满了顺风，抬脚就多滑三步。",
    route: "self",
    parts: [rollMod([{ mode: "flat", v: 3, src: "顺风靴" }])],
  },
  {
    id: "i02",
    no: 2,
    title: "时光怀表",
    flavor: "表盘倒着走，指针停在掷骰前那一秒。",
    route: "self",
    parts: [reroll()],
  },
  {
    id: "i03",
    no: 3,
    title: "香蕉皮",
    flavor: "一根剥得锃亮的香蕉皮，安静地躺在路中央。",
    route: "ground",
    contraband: true,
    ground: { check: { axis: "agile", dc: DC_TIERS.easy, tier: "easy", onFail: [{ type: "skip", v: 1 }] } },
  },
  {
    id: "i04",
    no: 4,
    title: "治疗药水",
    flavor: "小瓷瓶里晃着琥珀色的药汤，一口回魂。",
    route: "self",
    parts: [hp(2)],
  },
  {
    id: "i05",
    no: 5,
    title: "万能药",
    flavor: "标签上龙飞凤舞三个字：都管用。",
    route: "self",
    parts: [hp(4)],
  },
  {
    id: "i06",
    no: 6,
    title: "火箭鞋",
    flavor: "鞋跟绑着两根窜天猴，点火就冲。",
    route: "self",
    parts: [move(3)],
  },
  {
    id: "i07",
    no: 7,
    title: "脚镣",
    flavor: "一副生锈的脚镣，专栓跑得快的人。",
    route: "chooseOther",
    contraband: true,
    parts: [rollMod([{ mode: "cut", v: 1, src: "脚镣", wear: true }])],
  },
  {
    id: "i08",
    no: 8,
    title: "偷天换日",
    flavor: "天地对倒过来那一刻，谁也说不清站上谁的位置。",
    route: "chooseOther",
    contraband: true,
    parts: [swap()],
  },
  {
    id: "i09",
    no: 9,
    title: "小圆盾",
    flavor: "拇指大的铜盾牌，别人递来的恶意先撞它。",
    route: "self",
    parts: [roundShield()],
  },
  {
    id: "i10",
    no: 10,
    title: "弹弓",
    flavor: "橡皮筋绷得死紧，弹谁谁倒着走。",
    route: "chooseOther",
    contraband: true,
    parts: [back(2)],
  },
  {
    id: "i11",
    no: 11,
    title: "幸运骰",
    flavor: "骰子被摩挲得发亮，从不掷出小点。",
    route: "self",
    parts: [rollMod([{ mode: "floor", v: 6, src: "幸运骰" }])],
  },
  {
    id: "i12",
    no: 12,
    title: "双倍惊喜",
    flavor: "盒子打开还有个盒子，盒子里还压着一张请帖。",
    route: "self",
    parts: [drawItem(2)],
  },
  {
    id: "i14",
    no: 14,
    title: "护身符",
    flavor: "符纸背上朱砂，挡下下一次血光。",
    route: "self",
    parts: [talisman()],
  },
  {
    id: "i15",
    no: 15,
    title: "加倍骰",
    flavor: "骰角加了铅……不，是加了福。",
    route: "self",
    parts: [rollMod([{ mode: "raise", v: 2, src: "加倍骰" }])],
  },
  {
    id: "i16",
    no: 16,
    title: "狗笛",
    flavor: "一长两短，林子深处的耳朵竖了起来。",
    route: "chooseOther",
    contraband: true,
    tbd: "T6b",
  },
  {
    id: "i17",
    no: 17,
    title: "地雷",
    flavor: "铁壳上刻着福字，踩上去才知福薄。",
    route: "ground",
    contraband: true,
    ground: {
      check: { axis: "agile", dc: DC_TIERS.mid, tier: "mid", onFail: [{ type: "hp", v: -1 }, { type: "skip", v: 1 }] },
    },
  },
  {
    id: "i18",
    no: 18,
    title: "清障符",
    flavor: "黄符烧开一道净街，路上谁的东西都快烧没了。",
    route: "self",
    parts: [clearGround(3)],
  },
];

const BY_ID = new Map(ITEM_CARDS.map((c) => [c.id, c]));
export const ITEM_CARD_BY_ID = BY_ID;

export const itemCard = (id: string): ItemCard => {
  const c = BY_ID.get(id);
  if (!c) throw new Error(`道具卡 ${id} 不在表一`);
  return c;
};

/** 卡面 parts 是否含某类原语（打出闸/合法目标的专项探测共用，T4b1） */
export const itemHasPart = (card: ItemCard, type: EffectPart["type"]): boolean =>
  card.parts?.some((x) => x.type === type) === true;

/** M1 道具牌池（T4a 首批 10 + T4b1 非环境 7 = 17 张；T4b2 环境卡 3 张追加至全池 20）——单池洗匀，抽空弃牌堆洗回 */
export const M1_ITEM_POOL: readonly ItemCard[] = ITEM_CARDS;

/** 表一违禁 7 张全池清单（走私弹药；本批落的 6 张必在其列——数据校验兜底） */
export const CONTRABAND_TITLES: readonly string[] = ["香蕉皮", "脚镣", "偷天换日", "弹弓", "雷暴", "狗笛", "地雷"].sort();

/**
 * 测试卡注册通道（仅测试/冒烟）：把表一之外的临时卡挂进卡面查询表。
 * 不进 M1_ITEM_POOL（不进对局抽卡池）、不进 CONTRABAND 校验域——内核公开能力，M2 协议测试同源消费。
 */
export const registerCards = (cards: readonly ItemCard[]): void => {
  for (const c of cards) BY_ID.set(c.id, c);
};

// ---- 数据完整性校验（load 期执行，卡面坏账立刻炸） ----
{
  if (BY_ID.size !== ITEM_CARDS.length) throw new Error("道具卡 id 重复");
  const nos = new Set<number>();
  for (const c of ITEM_CARDS) {
    if (c.no < 1 || c.no > 20) throw new Error(`道具卡 ${c.id} 序号 ${c.no} 超出表一 1..20`);
    if (nos.has(c.no)) throw new Error(`道具卡序号 ${c.no} 重复`);
    nos.add(c.no);
    if (c.id !== `i${String(c.no).padStart(2, "0")}`) throw new Error(`道具卡 ${c.id} 与序号 ${c.no} 不一致`);
    if (!c.flavor) throw new Error(`道具卡 ${c.id} 缺场景 flavor`);
    if (c.route === "ground") {
      if (!c.ground?.check) throw new Error(`场地卡 ${c.id} 缺踩上判定`);
      if (c.parts) throw new Error(`场地卡 ${c.id} 不应带 parts（结算走 ground.check）`);
      const { tier, dc } = c.ground.check;
      if (tier && dc != null && DC_TIERS[tier] !== dc) throw new Error(`道具卡 ${c.id} 检定档位与 DC 不一致`);
    } else if (c.route === "auto" && !c.autoRule) {
      throw new Error(`自动指认卡 ${c.id} 缺卡面指认规则`);
    } else if (!c.parts?.length && !c.tbd) {
      throw new Error(`道具卡 ${c.id}（${c.route}）缺效果原语`);
    }
    if (c.contraband && !CONTRABAND_TITLES.includes(c.title)) {
      throw new Error(`道具卡 ${c.id} 标违禁但不在表一违禁 7 张清单`);
    }
  }
}
