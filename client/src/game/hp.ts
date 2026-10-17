/**
 * 血量呈现共用件（#23 T5a，数值表 §5.3 血条三档）：占比与档位/色的一处定义，
 * HUD 常驻 pill 与棋盘棋子旁微条同吃——阈值或色板改动一处生效。
 */
export type HpTone = "ok" | "mid" | "low";

/** 血量占比（封顶 0..1） */
export const hpRatio = (hp: number, maxHp: number): number => Math.max(0, Math.min(1, hp / maxHp));

/** 三档档位：≥50% 绿（ok）/ ≥25% 黄（mid）/ 其余红（low） */
export const hpTone = (r: number): HpTone => (r >= 0.5 ? "ok" : r >= 0.25 ? "mid" : "low");

/** 档位 → 填充色（棋盘 SVG 微条直接取；HUD 微条走同名 class 同色） */
export const HP_TONE_COLOR: Record<HpTone, string> = { ok: "#66bb6a", mid: "#ffca28", low: "#ef5350" };
