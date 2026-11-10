/**
 * 战报条目 → 大卡面的数据索引（M3-T7，#59 / G-08）。
 *
 * 为什么按 `flavor` 反查：`MessageEntry` 只有 `cards: string[]`（且仅出局散落那一条会落），
 * 抽卡/打牌条目**不带卡 id**；本票红线是不改内核字段。而 flavor 是**数据表字段**（不是战报
 * 文案正文——解析正文属于「禁解析中文文案」纪律的禁区），且在事件 21 / 道具 20 / 陷阱 14
 * 共 55 张之间**实测唯一**（见同目录 cardFace.test.ts 的守门用例）。
 *
 * 所以：flavor 当键、数据表当源——表里改了 flavor 会立刻在测试里炸，而不是静默配错卡。
 */
import {
  ECO_NAMES,
  EVENT_CARD_BY_ID,
  ITEM_CARD_BY_ID,
  M1_EVENT_POOL,
  M1_ITEM_POOL,
  TRAP_DEFS,
  type CardEffect,
  type EffectPart,
  type EventCard,
  type ItemCard,
  type TrapDef,
} from "../../../kernel/src";

/** 卡面数据（三池共用一张呈现形：标题/叙事皮/效果行/选项行） */
export interface CardFace {
  /** 来源池（呈现上区分图标与角标） */
  pool: "event" | "item" | "trap";
  id: string;
  /** 表序（事件表二 / 道具表一；陷阱无序号，用 0） */
  no: number;
  title: string;
  flavor: string;
  /** 一行行效果投影（DSL → 中文短语） */
  effects: string[];
  /** 有选项的卡：选项标签 + 各自效果投影（抉择卡） */
  options: Array<{ label: string; effects: string[] }>;
  /** 道具卡的路由标签（自己/指认他人/场地/环境…） */
  routeLabel: string | null;
}

/** EffectPart DSL → 一行中文（机械真话；与 CardChoice/HandDock 同口径的投影） */
export function partText(p: EffectPart): string {
  switch (p.type) {
    case "move":
      return `前进 ${p.v} 格`;
    case "back":
      return `后退 ${p.v} 格`;
    case "skip":
      return `罚停 ${p.v} 回合`;
    case "hp":
      return p.v > 0 ? `回血 +${p.v}` : `掉血 ${p.v}`;
    case "drawItem":
      return `摸 ${p.v} 张道具`;
    case "trial":
      return "再抽一张事件卡";
    case "check":
      return p.spec.dc != null
        ? `检定 ${p.spec.axis ? AXIS_LABEL[p.spec.axis] : "前途骰"} DC${p.spec.dc}`
        : `检定 ${p.spec.axis ? AXIS_LABEL[p.spec.axis] : "前途骰"}`;
    case "rollMod":
      return "改下次走格骰";
    case "reroll":
      return "重掷走格骰";
    case "swap":
      return "与目标互换位置";
    case "talisman":
      return "免疫下一次伤害";
    case "roundShield":
      return "下回合免疫他人卡牌";
    case "clearGround":
      return `清除前方 ${p.v} 格的场地卡`;
    case "teleport":
      return "传送回自己出生格";
    case "discard":
      return `随机弃 ${p.v} 张手牌`;
    case "itemBan":
      return `${p.v} 回合禁道具`;
    case "dogSpawn":
      return "在目标旁放一只野狗";
    case "mark":
      return p.text;
    case "none":
      return "无事";
    default:
      return "";
  }
}

const AXIS_LABEL: Record<string, string> = { might: "力", agile: "敏", luck: "运" };

/** CardEffect → 效果行（自身 + 指他人） */
export function effectLines(eff: CardEffect | undefined): string[] {
  if (!eff) return [];
  const out: string[] = (eff.self ?? []).map(partText).filter(Boolean);
  for (const t of eff.others ?? []) {
    const target =
      t.target === "all" ? "全体" : t.target === "nearestToGoal" ? "最靠前者" : t.target === "farthestFromGoal" ? "最落后者" : t.target === "previous" ? "上家" : "随机一人";
    out.push(`指向${target}：${t.parts.map(partText).filter(Boolean).join("、")}`);
  }
  return out;
}

const ROUTE_LABEL: Record<ItemCard["route"], string> = {
  self: "自己用",
  chooseOther: "指认他人",
  auto: "系统指认",
  ground: "铺在格上",
  ambient: "全场气候",
};

function fromEvent(card: EventCard): CardFace {
  return {
    pool: "event",
    id: card.id,
    no: card.no,
    title: card.title,
    flavor: card.flavor,
    effects: card.kind === "effect" ? effectLines(card.effect) : [],
    options: (card.options ?? []).map((o) => ({ label: o.label, effects: effectLines(o.effect) })),
    routeLabel: card.region ? `仅限${ECO_NAMES[card.region]}` : null,
  };
}

function fromItem(card: ItemCard): CardFace {
  const effects: string[] = (card.parts ?? []).map(partText).filter(Boolean);
  if (card.ground) effects.push("踩上者做检定，未过吃惩罚");
  if (card.weather) effects.push("全桌按生态逐行结算");
  return {
    pool: "item",
    id: card.id,
    no: card.no,
    title: card.title,
    flavor: card.flavor,
    effects,
    options: [],
    routeLabel: `${ROUTE_LABEL[card.route]}${card.contraband ? " · 违禁品" : ""}`,
  };
}

function fromTrap(def: TrapDef): CardFace {
  return {
    pool: "trap",
    id: def.id,
    no: 0,
    title: def.name,
    flavor: def.flavor,
    effects: effectLines({ self: def.check.onFail }),
    options: [],
    routeLabel: def.check.dc != null ? `检定 DC${def.check.dc}` : null,
  };
}

/** flavor → 卡面（55 张表内唯一；未命中=null） */
const BY_FLAVOR: Map<string, CardFace> = (() => {
  const m = new Map<string, CardFace>();
  for (const c of M1_EVENT_POOL) m.set(c.flavor, fromEvent(c));
  for (const c of M1_ITEM_POOL) m.set(c.flavor, fromItem(c));
  for (const { def } of TRAP_DEFS) m.set(def.flavor, fromTrap(def));
  return m;
})();

/** 战报条目 → 就地展开的卡面（无 flavor 或查不到=null → 组件不出空卡面） */
export function cardFaceOf(flavor: string | undefined | null): CardFace | null {
  if (!flavor) return null;
  return BY_FLAVOR.get(flavor) ?? null;
}

/** 表内 flavor 是否两两不同（测试守门：数据表加了重复 flavor 会立刻炸，而不是静默配错卡） */
export function flavorUniquenessReport(): { total: number; dups: string[] } {
  const seen = new Set<string>();
  const dups: string[] = [];
  for (const c of M1_EVENT_POOL) {
    if (seen.has(c.flavor)) dups.push(c.flavor);
    seen.add(c.flavor);
  }
  for (const c of M1_ITEM_POOL) {
    if (seen.has(c.flavor)) dups.push(c.flavor);
    seen.add(c.flavor);
  }
  for (const { def } of TRAP_DEFS) {
    if (seen.has(def.flavor)) dups.push(def.flavor);
    seen.add(def.flavor);
  }
  return { total: seen.size, dups };
}

/** 按 id 直查（卡面内「同类卡」引用等将来用；现在也给测试留一个稳定入口） */
export function cardFaceById(id: string): CardFace | null {
  const ev = EVENT_CARD_BY_ID.get(id);
  if (ev) return fromEvent(ev);
  const it = ITEM_CARD_BY_ID.get(id);
  if (it) return fromItem(it);
  const trap = TRAP_DEFS.find((t) => t.def.id === id);
  return trap ? fromTrap(trap.def) : null;
}
