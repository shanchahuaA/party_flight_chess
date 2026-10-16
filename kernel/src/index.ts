/**
 * 规则内核公开面（M1/M2 唯一复制边界）：
 * - GameKernel.create / apply / tick —— 客户端直调（M1 单机），M2 挪进 Durable Object
 * - BOARD 棋盘静态数据（拓扑/生态/格型/支路投影）
 * - 类型全在 types.ts（意图/事实/定理=战报/状态），形状即 M2 的 WS 协议基础
 */
export { GameKernel, GAME_DEFAULTS, CONFIG_LIMITS, itemPlayGate, itemLegalTargets, type PlayGate } from "./game";
export * from "./board";
export * from "./types";
export * from "./check";
export * from "./data/roles";
export * from "./data/goals";
export * from "./data/events";
export * from "./data/items";
export { rngFrom, type Rng, type RngState } from "./rng";
