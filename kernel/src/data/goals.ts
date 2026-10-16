/**
 * 暗牌目标池（内容数值表 · 表四，10 条）：
 * 开局每人抽 2 选 1、对他人保密；终局亮牌判定，达成=称号+8 分（表五 §5.1）。
 * 判定计数器由对局事件流汇总挂起（本票只发牌不计数），终局亮牌与作废闸门在 T8b 接。
 * 淘汰不免除已达成事实，「活到结算」类目标自然失败。
 */
import type { MessageKind } from "../types";

/** 计数器种类（表四逐条对应；终局以事件流计数结算） */
export type GoalCounterKind =
  | "survive" // 🛡 幸存者：活到结算（不淘汰），无目标值
  | "finish" // 🏃 马拉松：到达终点（通关席，含最后一波前），无目标值
  | "grudge" // 😈 整蛊王：成功指认/违禁卡生效/场地卡踩中 ≥ target
  | "handAtEnd" // 🎒 囤积癖：结算时手牌 ≥ target
  | "gamble" // 🎲 赌狗：赌狗卡（猜拳机器人/命运之骰/孤注一掷）赢 ≥ target
  | "customs" // 🧣 海关清白：警长窗零违规（没被查验抓到），无目标值
  | "dogs" // 🐕 打狗英雄：击毙野狗 ≥ target（遭遇战成功/大成功）
  | "hpAtEnd" // 💰 暴发户：结算时血量 ≥ target
  | "hitsTaken" // 🪨 硬骨头：存活期内承受 ≥ target 次扣血
  | "ambient"; // 🌦 风调雨顺：打出 ≥ target 张环境卡且每逢自己回合前未吃环境负面

export interface SecretGoalDef {
  /** 表四序号 1..10（id 语义） */
  no: number;
  /** 称号名（含 emoji） */
  title: string;
  counter: GoalCounterKind;
  /** 目标值（survive/finish/customs 无目标值传 0） */
  target: number;
  /** 判定描述（抽牌卡面/弹层展示用） */
  note: string;
}

export const SECRET_GOALS: readonly SecretGoalDef[] = [
  { no: 1, title: "🛡 幸存者", counter: "survive", target: 0, note: "活到结算、没被淘汰。" },
  { no: 2, title: "🏃 马拉松", counter: "finish", target: 0, note: "踩进自家园子的终点旗位（通关席）。" },
  { no: 3, title: "😈 整蛊王", counter: "grudge", target: 3, note: "成功整蛊 ≥3 次（指认命中/违禁卡生效/场地卡踩中）。" },
  { no: 4, title: "🎒 囤积癖", counter: "handAtEnd", target: 5, note: "结算时手里攒 ≥5 张道具卡。" },
  { no: 5, title: "🎲 赌狗", counter: "gamble", target: 2, note: "赌狗时刻（猜拳机器人/命运之骰/孤注一掷）赢 ≥2 次。" },
  { no: 6, title: "🧣 海关清白", counter: "customs", target: 0, note: "警长查货窗全程没被查验抓到违规。" },
  { no: 7, title: "🐕 打狗英雄", counter: "dogs", target: 2, note: "击毙野狗 ≥2 只（遭遇战成功/大成功）。" },
  { no: 8, title: "💰 暴发户", counter: "hpAtEnd", target: 8, note: "结算时血量 ≥8（求生欲拉满）。" },
  { no: 9, title: "🪨 硬骨头", counter: "hitsTaken", target: 3, note: "承受 ≥3 次扣血仍活着。" },
  { no: 10, title: "🌦 风调雨顺", counter: "ambient", target: 2, note: "打出 ≥2 张环境卡，且自己没吃环境负面。" },
];

const goalByNo = new Map(SECRET_GOALS.map((g) => [g.no, g]));

export const secretGoal = (no: number): SecretGoalDef => {
  const g = goalByNo.get(no);
  if (!g) throw new Error(`暗牌目标 ${no} 不在表四`);
  return g;
};

/** 称号达成时的战报 kind（终局亮牌，T8b 消费；数据位先挂） */
export const SECRET_SCORE_KIND: MessageKind = "score";
