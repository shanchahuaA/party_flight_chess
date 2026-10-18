/**
 * 规则内核公开面（M1/M2 唯一复制边界）：
 * - GameKernel.create / apply / tick —— 客户端直调（M1 单机），M2 挪进 Durable Object
 * - BOARD 棋盘静态数据（拓扑/生态/格型/支路投影）
 * - 类型全在 types.ts（意图/事实/定理=战报/状态），形状即 M2 的 WS 协议基础
 */
export { GameKernel, GAME_DEFAULTS, CONFIG_LIMITS, TIMBER_CELLS, ROCK_LEN, SINK_CELLS, DOGS_PER_WAVE, DOG_HP, DOG_TURNS, DOG_FIGHT_DC, CUSTOMS_CHECKS, CUSTOMS_CHECKS_BIG, CUSTOMS_BIG_AT, CUSTOMS_RETREAT, CUSTOMS_CHECK_MS, BEAST_BASE_HP, BEAST_HP_PER_PLAYER, BEAST_DIE, itemPlayGate, itemLegalTargets, customsShipGate, customsCheckGate, strikeGate, giveItemGate, giveTargets, hitBeastGate, type PlayGate } from "./game";
export { FINISH_SCORES, finishScore, TITLE_SCORE, SURVIVE_SCORE, GRUDGE_SCORE, PROGRESS_DIVISOR, computeSettlement, foldTags, type TagCounts } from "./settle";
export * from "./board";
export * from "./types";
export * from "./check";
export * from "./data/roles";
export * from "./data/goals";
export * from "./data/events";
export * from "./data/items";
export * from "./data/traps";
export { rngFrom, type Rng, type RngState } from "./rng";
