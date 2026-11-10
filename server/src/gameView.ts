/**
 * 对局下行的按座位裁剪+视角重定基（M2-T5，#42；M3-T9 #61 加战报全量/增量）。
 *
 * 契约（胖消息）：每条 game 消息按收者逐人构建——
 * - 重定基（rebase）：收者恒为 pid 0（壳层 M1 约定「自己=players[0]」，协议替壳转译，服务端终局裁决）。
 *   统计 players 数组把收者挪到下标 0、其余按原序保持，随后全部 pid 引用同步改写。
 * - 裁剪（硬约束）：他人手牌 hand=[]、他人暗牌 secretOptions=[0,0]（保形置零）；
 *   牌堆现序 deck/itemDeck 保形裁黑（卡面全黑、长度可数——kernel 抽卡=pop()，牌堆尾=下一张，
 *   现序即未来抽卡顺序，同属保密面）；customs.shipments[].cardId 仅收者是报备人时给真值、他人置空串；
 *   facts 里 itemDrawn 的 cardId 仅发送者本人收到真值（其余置空——战报正文本来就不点名卡面，双口径一致）；
 *   rngStates / seq / dogSeq / customsSeq 全部置 0（保形不下发——RNG 流=未来抽卡顺序，绝不外泄）。
 * - 结算例外：kernel phase=over 时他人暗牌 secretOptions 照实亮（Spec #37 story 9「暗牌保密到结算即揭」
 *   ——亮牌只随结果进结算包，与单机 T8b2 呈现同源）；hand 不随结算松动。
 * - 战报（M3-T9 #61 / 清单 T-02）：顶层 `messages` 改「首次全量 + 后续增量」，配 `msgMode` 模式标记；
 *   客户端累积成完整流（抽屉能翻到本局第一条）。`state.messages` 仍留一段尾片——壳层整体覆盖口径
 *   要有东西接，但它不再承担「完整战报」职责。
 *
 * 纯函数无 IO：输入=内核导出的完整态快照（调用方保证是 kernel.save() 的克隆，本函数不归还原件）
 * 与本批事实；输出=该收者视角的整份 game 消息载荷。每次内核变化后逐连接跑一次。
 */
import type { Fact, GameState, MessageEntry } from "../../kernel/src/types";
import type { MsgMode } from "../../shared/protocol";

/** `state.messages` 尾片长度（壳层整体覆盖口径的兜底；完整战报走顶层 messages 累积流） */
export const MESSAGE_TAIL = 200;

/** 战报下发模式：单一真源在 shared/protocol.ts（两端共用，禁各自手写字面量） */
export type { MsgMode } from "../../shared/protocol";

/**
 * 视角重定基+裁剪后的整份 game 消息载荷。
 * - messages：按 msgMode 模式给全量或本批增量
 * - state.messages：恒为最近 MESSAGE_TAIL 条尾片（壳层兜底，不承担完整战报）
 */
export interface GameViewMsg {
  facts: Fact[];
  messages: MessageEntry[];
  /** #61：messages 是「全量」还是「本批增量」 */
  msgMode: MsgMode;
  state: GameState;
}

/** 战报里有哪些条目的 id 大于 lastId（增量切片用；与内核 append-only 口径一致） */
export function deltaMessages(all: MessageEntry[], lastId: number): MessageEntry[] {
  return all.filter((m) => m.id > lastId);
}

/**
 * 重定基规则：收者旧 pid=viewerPid 挪到 0，其下标 0..viewerPid-1 依次 +1，
 * 其后的原序保持（旧 pid ≥ viewerPid+1 的新 pid=旧 pid）。
 */
export function pidMapFor(viewerPid: number): (oldPid: number) => number {
  return (oldPid) => (oldPid === viewerPid ? 0 : oldPid < viewerPid ? oldPid + 1 : oldPid);
}

/** 战报尾片的 pid 改写（who/targets 可选字段保持缺席形态） */
export function rebaseMessages(list: MessageEntry[], map: (n: number) => number): MessageEntry[] {
  return list.map((m0) => {
    const m: Record<string, unknown> = { ...(m0 as unknown as Record<string, unknown>) };
    if (m.who != null) m.who = map(m.who as number);
    if (m.targets != null) m.targets = (m.targets as number[]).map(map);
    return m as unknown as MessageEntry;
  });
}

/** 事实批的 pid 引用改写 + itemDrawn 双口径卡面（仅本人看到摸到的真牌） */
export function rebaseFacts(facts: Fact[], map: (n: number) => number): Fact[] {
  return facts.map((f0) => {
    const f: Record<string, unknown> = { ...(f0 as unknown as Record<string, unknown>) };
    if (f.pid != null) f.pid = map(f.pid as number);
    if (f.target != null) f.target = map(f.target as number);
    if (f.targets != null) f.targets = (f.targets as number[]).map(map);
    if (f.who != null) f.who = map(f.who as number);
    if (f.sheriff != null) f.sheriff = map(f.sheriff as number);
    if (f.type === "itemDrawn" && f.pid !== 0) f.cardId = "";
    return f as unknown as Fact;
  });
}

/**
 * 整份 game 消息：克隆态重定基+裁剪+战报（全量/增量）+本批事实重定基。raw/batch 视为只读。
 *
 * @param msgOpts.lastId 该连接已见的最后战报 id（服务端按连接记）；msgMode="delta" 时只回 id > lastId 的条目。
 *   msgMode="full" 时忽略 lastId，给全量。
 */
export function buildGameView(
  raw: GameState,
  batch: Fact[],
  viewerPid: number,
  tail = MESSAGE_TAIL,
  msgOpts: { msgMode: MsgMode; lastId?: number } = { msgMode: "delta" },
): GameViewMsg {
  if (viewerPid < 0 || viewerPid >= raw.players.length) {
    throw new Error(`gameView: viewerPid ${viewerPid} 越界（名册 ${raw.players.length} 人）`);
  }
  const map = pidMapFor(viewerPid);
  // 深克隆隔离：raw 是 DO 侧共享的快照对象，逐收者构建必须互不污染（viewer 0 的裁剪不得写回）
  const state = JSON.parse(JSON.stringify(raw)) as GameState;
  rebaseState(state, map, viewerPid);
  const mode: MsgMode = msgOpts.msgMode;
  // 顶层 messages：全量 or 本批增量（#61）。state.messages 恒留尾片兜底。
  const messages =
    mode === "full"
      ? rebaseMessages(raw.messages ?? [], map)
      : rebaseMessages(deltaMessages(raw.messages ?? [], msgOpts.lastId ?? 0), map);
  state.messages = rebaseMessages((raw.messages ?? []).slice(-tail), map);
  return {
    facts: rebaseFacts(batch ?? [], map),
    messages,
    msgMode: mode,
    state,
  };
}

/** 状态整范围内的 pid 引用改写与私密裁剪（就地改传入的克隆） */
function rebaseState(state: GameState, map: (n: number) => number, viewerPid: number): void {
  // 结算即揭（Spec #37 story 9）：kernel 结束相位他人暗牌照实亮——亮牌只随结果进结算包
  const over = state.phase === "over";
  // players：收者挪到下标 0、其余按原序保持。colorIndex 不改写——棋子色号的稳定身份，与收者视角无关。
  const oldPlayers = state.players;
  const reordered = [
    ...oldPlayers.slice(viewerPid, viewerPid + 1),
    ...oldPlayers.slice(0, viewerPid),
    ...oldPlayers.slice(viewerPid + 1),
  ];
  state.players = reordered.map((p) => p);
  state.players.forEach((p, i) => {
    p.id = i;
    if (i !== 0) {
      p.hand = []; // 他人手牌绝不下发（Spec #37 决策 4）——不随结算松动
      p.secretOptions = over ? p.secretOptions : [0, 0]; // 暗牌保形置零；over=结算即揭
    }
  });

  state.finishers = (state.finishers ?? []).map(map);
  state.turnActor = state.turnActor == null ? null : map(state.turnActor);

  state.ground = (state.ground ?? []).map((g) => ({ ...g, owner: map(g.owner) }));

  const c = state.customs;
  if (c) {
    // sheriff 是 pid 的公开引用字段（票面清单未点名——漏改=换人视角串位，实现期定案里补记）
    c.sheriff = map(c.sheriff);
    c.shipments = (c.shipments ?? []).map((s) => {
      const out = { ...s, from: map(s.from), to: map(s.to) };
      if (out.from !== 0) out.cardId = ""; // 真货仅报备人本人可见（他人视角置空串保形）
      return out;
    });
    if (c.pending) {
      c.pending = { ...c.pending, from: map(c.pending.from), to: map(c.pending.to) };
    }
    c.botPlans = (c.botPlans ?? []).map((b) => ({ ...b, pid: map(b.pid) }));
  }

  const mal = state.malice;
  if (mal?.spawnQueue) {
    mal.spawnQueue = mal.spawnQueue.map((d) => ({ ...d, target: map(d.target) }));
  }

  state.deferred = (state.deferred ?? []).map((d) => ({ ...d, pid: map(d.pid), srcPid: map(d.srcPid) }));

  const eg = state.endgame;
  if (eg?.settlement) {
    eg.settlement = {
      ...eg.settlement,
      rows: eg.settlement.rows.map((r) => ({ ...r, pid: map(r.pid) })),
      culprits: eg.settlement.culprits.map((x) => ({ ...x, pid: map(x.pid) })),
    };
  }

  // 内部段：RNG 五流状态（=未来抽卡顺序）与内部发号绝不下发——保形置 0
  state.rngStates = { setup: 0, deck: 0, items: 0, dice: 0, world: 0 };
  state.seq = 0;
  state.dogSeq = 0;
  state.customsSeq = 0;

  // deck / itemDeck：牌堆**现序**也是一种未来抽卡顺序（kernel 抽卡=deck.pop()/itemDeck.pop()，
  // 牌堆尾=下一张）——保形裁黑（卡面全黑、长度可数）：客户端唯一合法消费=length（现场摸卡真身
  // 由 facts/itemDrawn 双口径给），卡面红action=与 itemDrawn/shipments 置空串同型的既有口径。
  state.deck = (state.deck ?? []).map(() => "");
  state.itemDeck = (state.itemDeck ?? []).map(() => "");
}
