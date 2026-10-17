/**
 * 卡面 DSL 原语速写（数据表共用）：事件表（表二）与道具表（表一）都拿它写效果行，
 * 免得两张表各抄一份「hp/move/...」构造器。类型本体在 events.ts（EffectPart/DiceMod）。
 */
import type { DiceMod, EffectPart } from "./events";

export const move = (v: number): EffectPart => ({ type: "move", v });
export const back = (v: number): EffectPart => ({ type: "back", v });
export const skip = (v: number): EffectPart => ({ type: "skip", v });
export const hp = (v: number): EffectPart => ({ type: "hp", v });
export const drawItem = (v: number): EffectPart => ({ type: "drawItem", v });
export const rollMod = (mods: DiceMod[]): EffectPart => ({ type: "rollMod", mods });
export const noEffect: EffectPart = { type: "none" };
/** T4b1 新原语（表一后半）：重掷本骰／换位／护身符／小圆盾／清障 */
export const reroll = (): EffectPart => ({ type: "reroll" });
export const swap = (): EffectPart => ({ type: "swap" });
export const talisman = (): EffectPart => ({ type: "talisman" });
export const roundShield = (): EffectPart => ({ type: "roundShield" });
export const clearGround = (v: number): EffectPart => ({ type: "clearGround", v });
/** T6b 原语（表一 #16 狗笛）：在受指向者相邻格生成 1 只标准野狗（4 血/3 世界回合寿命） */
export const dogSpawn = (): EffectPart => ({ type: "dogSpawn" });
