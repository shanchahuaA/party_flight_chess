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
