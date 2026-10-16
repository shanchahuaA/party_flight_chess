/**
 * 检定框架（内容数值表 · 表五 §5.2，D&D 式 1d20 高掷优四档）：
 *   骰 20 = 大成功（当卡自带的额外正面）；≥DC = 通过；<DC = 失败；骰 1 = 大失败（当卡自带的额外负面）。
 * 极值档取**原始主骰面**（极值挂在检定骰本身，不随修正翻动）；同一检定的 buff/debuff 先互抵再结算。
 * 修正四原语（#19 T3a 卡面 DSL）：削面/升面=骰面数 −/＋（20→1d19/1d21，bless·bane 式；削面时那面的
 *   极值自然不可达）、保底 tie floor 通道、加值 tie bonus 通道；同一次检定全量互抵后再掷再判。
 * 纯逻辑模块：掷面由内核内部 RNG 供给，本模块做互抵与判读——T3a 事件卡、T5 陷阱检定、T6 遭遇战消费。
 */
import type { RoleDef } from "./data/roles";
import type { Axis } from "./data/roles";
import type { Rng } from "./rng";

export type { Axis } from "./data/roles";

/** 修正通道（同一次检定的多张效果先全量互抵再结算） */
export interface CheckMods {
  /** 优势/劣势计数：正=N 张优势（掷 1+N 取最高）、负=N 张劣势（取最低） */
  adv?: number;
  /** 保底 ≥X（判定用有效面下限；不改变原始面语义、不救大失败） */
  floor?: number;
  /** 面宽 ±N（候选：加值类，同轴加值一样直接加在主骰上） */
  bonus?: number;
  /** 骰面数偏移 T3a 四原语：升面=正（1d20→1d21）、削面=负（1d20→1d19）；与 cut/raise 原语同为面数账 */
  face?: number;
}

export type CheckGrade = "crit" | "pass" | "fail" | "critfail";

export interface CheckResolve {
  /** 主骰原始面（极值档判定依据） */
  raw: number;
  /** 互抵后的加值合计（轴+面宽） */
  mods: number;
  /** 判定用有效面 = 原始面+加值合计，且不低于保底（≥1） */
  used: number;
  dc: number;
  grade: CheckGrade;
}

/** 互抵：adv 取符号与残差；多张保底互抵取最宽松、面宽/面数直接加总 */
export function netMods(mods: CheckMods[]): {
  adv: 1 | 0 | -1;
  advCount: number;
  bonus: number;
  floor: number | null;
  face: number;
} {
  let adv = 0;
  let bonus = 0;
  let face = 0;
  let floor: number | null = null;
  for (const m of mods) {
    adv += m.adv ?? 0;
    bonus += m.bonus ?? 0;
    face += m.face ?? 0;
    if (m.floor != null && (floor === null || m.floor > floor)) floor = m.floor;
  }
  return { adv: Math.sign(adv) as 1 | 0 | -1, advCount: Math.abs(adv), bonus, floor, face };
}

/** 掷检定骰：净值优势/劣势后掷 1+残差 颗取高/低（无修正=单颗）；faces=骰面数（升/削面改变它） */
export function rollD20(rng: Rng, net: { adv: 1 | 0 | -1; advCount: number }, faces = 20): number {
  const n = 1 + net.advCount;
  let best = 0;
  let worst = faces + 1;
  for (let i = 0; i < n; i++) {
    const d = Math.floor(rng.next() * faces) + 1;
    if (d > best) best = d;
    if (d < worst) worst = d;
  }
  return net.adv > 0 ? best : net.adv < 0 ? worst : best;
}

/** 判读一次检定（已掷原始面 + 修正通道 → 四档）。
 *  axisBonus = 对应轴加值（1..4，D&D 式 1d20+轴）；oneToCrit = 菜狗翻身（原始 1 → 大成功）。 */
export function resolveCheck(opts: {
  raw: number;
  axisBonus: number;
  dc: number;
  mods?: CheckMods[];
  oneToCrit?: boolean;
}): CheckResolve {
  const { raw, axisBonus, dc } = opts;
  const net = netMods(opts.mods ?? []);
  let used = Math.max(1, raw + axisBonus + net.bonus);
  if (net.floor != null && used < net.floor) used = net.floor;
  let grade: CheckGrade;
  if (raw === 20) grade = "crit";
  else if (raw === 1) grade = opts.oneToCrit ? "crit" : "critfail";
  else grade = used >= dc ? "pass" : "fail";
  return { raw, mods: axisBonus + net.bonus, used, dc, grade };
}

// ---------- 角色特长 → 修正通道（表三落数据位，T2 起；T3a 卡面检定开始消费） ----------

/** 角色检定特长折成同一检定的修正（蛮力/狡运=掷 2 取高；猎手=遭遇战专指 +4；与卡面修正一并互抵） */
export function roleCheckMods(role: RoleDef, axis: Axis, scope?: string): CheckMods[] {
  const s = role.specialty;
  if (!s) return [];
  if (s.kind === "adv2" && s.axis === axis) return [{ adv: 1 }];
  if (s.kind === "flat" && (!s.scope || s.scope === scope)) return [{ bonus: s.bonus ?? 0 }];
  return [];
}

/** 菜狗翻身（原始 1 改判大成功）是否生效（全检定域） */
export function roleOneToCrit(role: RoleDef): boolean {
  return role.specialty?.kind === "oneToCrit";
}

/** 极值判定面：升/削面只改面数不改极值面——极值挂原始面 20/1（削面使大成功自然不可达） */
export const CHECK_FACES = 20;
