/**
 * 角色表（内容数值表 · 表三，5 个）：
 * 三轴 6 点（力/敏/运，每轴 1–4，检定 = 1d20+对应轴）+ 检定特长（含修正通道挂点）
 * + 1 条被动（只作用于自己、不控他人）。
 * 开局明选、可重复选同一角色；属性只在角色详情弹层展示（壳层纪律，内核不渲染）。
 *
 * 本票（T2）挂接口径：三轴随开局进 PlayerState 影响后续检定；特长/被动落到数据位，
 * 行为消费点：蛮力/狡运=检定修正（T3a 卡面与 T5 陷阱检定）、开局手牌+1（T4a 摸牌）。
 */

/** 三轴（力=野狗/年兽检定挂点；敏=陷阱/环境/闪躲；运=赌狗/随机事件） */
export type Axis = "might" | "agile" | "luck";

export const AXIS_NAMES: Record<Axis, string> = {
  might: "力",
  agile: "敏",
  luck: "运",
};

export type RoleId = "light" | "tough" | "boss" | "woe" | "beast";

/** 被动数据位（PlayerState 上按角色挂接的逐局状态在此之外单独存） */
export interface PassiveFlags {
  /** 轻装上阵：穿戴类负面（脚镣/削面）减半（2 层并 1）——T4a/卡面效果消费 */
  wearHalved?: boolean;
  /** 轻装上阵：开局手牌 +1（张数）——T4a 開牌队列消费 */
  handPlus?: number;
  /** 皮糙肉厚：免疫第一次扣血（每局 1 次，触发后清零）——T5 扣血管道消费 */
  firstBloodShield?: boolean;
  /** 黑市老板：警长窗转让（报备合格）时摸 1 张——T7 警长窗消费 */
  customsTransferDraw?: boolean;
  /** 倒霉蛋：踩陷阱时走格骰掷出 10 则无事——T5 陷阱检定消费 */
  trapWalk10Safe?: boolean;
  /** 野性直觉：被咬 −1 血改弃 1 张道具卡（无卡才扣血）——T6b 野狗遭遇战消费 */
  dogBiteDiscard?: boolean;
}

/** 检定特长：同一次检定的修正先互抵再结算（表五 §5.2 纪律） */
export interface Specialty {
  name: string;
  /** adv2=掷 2 取高（蛮力/狡运）；flat=固定加值（猎手）；oneToCrit=主骰 1 改判大成功（菜狗翻身） */
  kind: "adv2" | "flat" | "oneToCrit";
  /** adv2 挂轴（蛮力=力/狡运=运；oneToCrit 全检定生效） */
  axis?: Axis;
  /** flat 值（猎手 +4） */
  bonus?: number;
  /** flat/adv 生效域：dogFight=野狗遭遇战专指；其余=全部检定 */
  scope?: "dogFight";
}

export interface RoleDef {
  id: RoleId;
  /** 表三序号（1..5） */
  no: number;
  name: string;
  emoji: string;
  /** 三轴 6 点（力/敏/运，每轴 1–4；检定 = 1d20+对应轴） */
  axes: { might: number; agile: number; luck: number };
  /** 检定特长：轻装上阵无特长（敏 3 本身是挂点），null */
  specialty: Specialty | null;
  /** 被动文案（角色详情弹层展示用） */
  passiveText: string;
  flags: PassiveFlags;
}

export const ROLES: readonly RoleDef[] = [
  {
    id: "light",
    no: 1,
    name: "轻装上阵",
    emoji: "🎒",
    axes: { might: 1, agile: 3, luck: 2 },
    specialty: null,
    passiveText: "穿戴类负面（脚镣/削面）减半（2 层并 1）；开局手牌 +1。",
    flags: { wearHalved: true, handPlus: 1 },
  },
  {
    id: "tough",
    no: 2,
    name: "皮糙肉厚",
    emoji: "🛡",
    axes: { might: 4, agile: 1, luck: 1 },
    specialty: { name: "蛮力（力检掷 2 取高）", kind: "adv2", axis: "might" },
    passiveText: "免疫第一次扣血（每局 1 次，触发后标记）。",
    flags: { firstBloodShield: true },
  },
  {
    id: "boss",
    no: 3,
    name: "黑市老板",
    emoji: "💼",
    axes: { might: 1, agile: 1, luck: 4 },
    specialty: { name: "狡运（运检掷 2 取高）", kind: "adv2", axis: "luck" },
    passiveText: "警长窗转让（报备合格）时摸 1 张。",
    flags: { customsTransferDraw: true },
  },
  {
    id: "woe",
    no: 4,
    name: "倒霉蛋",
    emoji: "🍂",
    axes: { might: 2, agile: 1, luck: 3 },
    specialty: { name: "菜狗翻身（检定骰 1 改判大成功）", kind: "oneToCrit" },
    passiveText: "踩陷阱时走格骰掷出 10 则无事。",
    flags: { trapWalk10Safe: true },
  },
  {
    id: "beast",
    no: 5,
    name: "野性直觉",
    emoji: "🐾",
    axes: { might: 3, agile: 2, luck: 1 },
    specialty: { name: "猎手（野狗遭遇战检定 +4）", kind: "flat", bonus: 4, scope: "dogFight" },
    passiveText: "被咬 −1 血改为弃 1 张道具卡（无卡才扣血）。",
    flags: { dogBiteDiscard: true },
  },
];

const ROLE_BY_ID = new Map(ROLES.map((r) => [r.id, r]));

export const roleDef = (id: RoleId): RoleDef => {
  const r = ROLE_BY_ID.get(id);
  if (!r) throw new Error(`角色 ${id} 不在表三`);
  return r;
};
