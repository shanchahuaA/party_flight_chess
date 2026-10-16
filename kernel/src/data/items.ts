/**
 * 道具卡表（内容数值表 · 表一，全池 20 张）+ 道具打出链数据面（#21 T4a）。
 *
 * 目标路由（#10 定案目标六类，T4a 起步三类）：
 *   `self` 自身 ｜ `chooseOther` 自选他人（打出时提交目标意图，内核验合法） ｜ `ground` 场地型
 *   （附着当前格，下一踩上者——含铺设者本人——触发判定后消失）。
 *   其余三类 `auto` 自动指认／`allOthers` 全体／`ambient` 全场环境落在 T4b1/T4b2。
 *
 * T4a 首批落数 10 张（覆盖三类通路 + 违禁 4 + 走格骰修正三原语）；
 * 余下 10 张归属：T4b1 非环境 7 张（时光怀表/小圆盾/护身符/加倍骰/狗笛/清障符/偷天换日）
 * + T4b2 环境卡 3 张（雷暴/暴雨/风暴）。编号沿用表一序号，追加时按表一补全。
 *
 * 口径：10 血／走格 1d10；违禁 7 张全池清单见 CONTRABAND_TITLES（警长查货窗 T7 消费）。
 */
import type { CheckSpec, EffectPart } from "./events";
import { DC_TIERS } from "./events";
import { back, drawItem, hp, move, rollMod } from "./primitives";

export type ItemRoute = "self" | "chooseOther" | "ground";

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
  /** 目标路由（T4a 三类；auto/allOthers/ambient 后票扩） */
  route: ItemRoute;
  /** 整蛊类=违禁品（表一 7 张）：警长查货窗走私清单（T7 行为）；壳层视觉标识随 T4a2 */
  contraband?: true;
  /** self/chooseOther 的结算原语（chooseOther 的 parts 落到选中目标身上） */
  parts?: EffectPart[];
  /** ground 专用：踩上判定数据 */
  ground?: GroundSpec;
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
];

const BY_ID = new Map(ITEM_CARDS.map((c) => [c.id, c]));
export const ITEM_CARD_BY_ID = BY_ID;

export const itemCard = (id: string): ItemCard => {
  const c = BY_ID.get(id);
  if (!c) throw new Error(`道具卡 ${id} 不在表一`);
  return c;
};

/** M1 道具牌池（T4a=首批 10 张；T4b1/T4b2 追加至全池 20）——单池洗匀，抽空弃牌堆洗回 */
export const M1_ITEM_POOL: readonly ItemCard[] = ITEM_CARDS;

/** 表一违禁 7 张全池清单（走私弹药；本批落的 4 张必在其列——数据校验兜底） */
export const CONTRABAND_TITLES: readonly string[] = ["香蕉皮", "脚镣", "偷天换日", "弹弓", "雷暴", "狗笛", "地雷"].sort();

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
    } else if (!c.parts?.length) {
      throw new Error(`道具卡 ${c.id}（${c.route}）缺效果原语`);
    }
    if (c.contraband && !CONTRABAND_TITLES.includes(c.title)) {
      throw new Error(`道具卡 ${c.id} 标违禁但不在表一违禁 7 张清单`);
    }
  }
}
