// M2-T5（#42）gameView 纯函数单测：重定基（收者恒 pid 0）+按座位裁剪的硬约束。
// 集成主链（game.test.ts）走 WS 缝钉行为契约；本文件钉重定基的字段账——
// 集成不易天然触达的面（spawnQueue/deferred/ground 等边角 pid 引用）在函数面直接验。
// 票契约 C 明示：重定基函数写在专门模块、纯函数可单测。
import { describe, expect, it } from "vitest";
import type { Fact, GameState, MessageEntry } from "../../kernel/src/types";
import { buildGameView, MESSAGE_TAIL, pidMapFor } from "../src/gameView";

/** 最小可跑快照（gameView 只触碰裁剪名册内的字段，其余给空值/合法默认） */
function rawState(overrides: Partial<GameState> & { players: GameState["players"]; messages?: MessageEntry[] }): GameState {
  return {
    turn: 3,
    phase: "acting",
    windowDeadline: 42_000,
    turnActor: null,
    restUntil: 0,
    finishers: [],
    deck: [],
    discard: [],
    itemDeck: [],
    itemDiscard: [],
    ground: [],
    ambient: null,
    deferred: [],
    customs: null,
    endgame: null,
    malice: { timber: null, sink: null, rock: null, spawnQueue: [], dogs: [] },
    seq: 11,
    dogSeq: 2,
    customsSeq: 1,
    rngStates: { setup: 100, deck: 200, items: 300, dice: 400, world: 500 },
    messages: [],
    ...overrides,
  } as unknown as GameState;
}

function player(id: number, overrides: Partial<GameState["players"][number]> = {}): GameState["players"][number] {
  return {
    id,
    name: `p${id}`,
    isBot: false,
    colorIndex: id,
    roleId: "light",
    axes: { might: 1, agile: 1, luck: 1 },
    hp: 10,
    shields: 0,
    talisman: 0,
    cardGuard: 0,
    pos: 10 + id,
    from: null,
    trail: [],
    net: 0,
    zone: "main",
    bpos: 0,
    rolled: false,
    confirmed: false,
    stun: 0,
    skipped: false,
    dead: false,
    spawnCell: 0,
    secretOptions: [7, 9],
    secretPick: null,
    botSchedule: { rollAt: 0, confirmAt: null },
    walk: null,
    walkQueue: [],
    cardPending: null,
    cardDraws: 0,
    hand: [],
    rollMods: [],
    checkMods: [],
    wearHalves: 0,
    itemBan: 0,
    itemBanned: false,
    endgame: null,
    ...overrides,
  } as unknown as GameState["players"][number];
}

/** 老pid→新pid 映射轴（收者=viewerPid）：
 *  viewer=1：老0→1、老1→0、老2→2；viewer=2：老0→1、老1→2、老2→0 */
describe("pidMapFor：重定基映射轴", () => {
  it("收者→0；其前的依次 +1；其后的保持", () => {
    expect([pidMapFor(1)(0), pidMapFor(1)(1), pidMapFor(1)(2)]).toEqual([1, 0, 2]);
    expect([pidMapFor(2)(0), pidMapFor(2)(1), pidMapFor(2)(2), pidMapFor(2)(3)]).toEqual([1, 2, 0, 3]);
  });
});

describe("buildGameView：players 重排与私密裁剪", () => {
  it("收者挪到 0、其余原序；收者手牌/暗牌原样，他人裁剪（收者=老1）", () => {
    const s = rawState({
      players: [player(0, { hand: ["item_1"], secretOptions: [1, 2] }), player(1, { hand: ["item_2"] }), player(2, { hand: ["item_3"] })],
    });
    const { state } = buildGameView(s, [], 1);
    expect(state.players.map((p) => p.id)).toEqual([0, 1, 2]);
    expect(state.players[0].colorIndex).toBe(1); // 收者本人，色号是稳定身份原样
    expect(state.players[0].hand).toEqual(["item_2"]); // 收者=老1 手牌原样
    expect(state.players[0].secretOptions).toEqual([7, 9]);
    expect(state.players[1].hand).toEqual([]);
    expect(state.players[1].secretOptions).toEqual([0, 0]);
    expect(state.players[2].hand).toEqual([]);
  });
});

describe("buildGameView：pid 引用全量改写（收者=老1 的映射轴）", () => {
  it("finishers/turnActor/ground/customs 群/deferred/spawnQueue/settlement", () => {
    const s = rawState({
      players: [player(0), player(1), player(2)],
      finishers: [2, 0], // → [2,1]
      turnActor: 1, // → 0
      ground: [{ cell: 5, cardId: "i1", owner: 2 }], // → owner 2
      malice: { timber: null, sink: null, rock: null, spawnQueue: [{ cell: 9, target: 0 }], dogs: [] }, // → target 1
      deferred: [{ pid: 2, parts: [], kind: "item", srcPid: 1, grudgeLabel: "整蛊" }], // → pid 2 / srcPid 0
      customs: {
        sheriff: 0, // → 老0 在收者前 → 1
        armed: true,
        checksLeft: 2,
        degraded: false,
        checkDeadline: 50_000,
        shipments: [
          { id: 1, from: 1, to: 2, cardId: "货A", declared: "a", checked: false }, // 收者本人报备→from 0，真货原样
          { id: 2, from: 2, to: 1, cardId: "货B", declared: "b", checked: false }, // 他人报备→from 2，真货置空
        ],
        pending: { from: 2, to: 0, reason: "caught", deadline: 51_000 }, // → from 2 / to 1
        botPlans: [{ pid: 0, at: 49_000 }], // → pid 1
      },
      endgame: {
        turn: 3,
        beast: null,
        groupFail: false,
        settlement: {
          groupFail: false,
          rows: [
            { pid: 2, progress: 1, finishRank: null, finish: 0, survive: 4, goalNos: [], goalsVoided: false, titleScore: 0, grudgeCount: 0, grudgeScore: 0, total: 5 },
            { pid: 1, progress: 0, finishRank: null, finish: 0, survive: 0, goalNos: [], goalsVoided: false, titleScore: 0, grudgeCount: 0, grudgeScore: 0, total: 0 },
          ],
          culprits: [{ kind: "noCardsPlayed", pid: 0, detail: "x", evidence: [] }],
        },
      },
    });
    const { state } = buildGameView(s, [], 1);
    expect(state.finishers).toEqual([2, 1]);
    expect(state.turnActor).toBe(0);
    expect(state.ground[0].owner).toBe(2);
    expect(state.malice.spawnQueue[0].target).toBe(1);
    expect(state.deferred[0]).toMatchObject({ pid: 2, srcPid: 0 });
    expect(state.customs!.sheriff).toBe(1);
    expect(state.customs!.shipments).toEqual([
      { id: 1, from: 0, to: 2, cardId: "货A", declared: "a", checked: false },
      { id: 2, from: 2, to: 0, cardId: "", declared: "b", checked: false },
    ]);
    expect(state.customs!.pending).toEqual({ from: 2, to: 1, reason: "caught", deadline: 51_000 });
    expect(state.customs!.botPlans).toEqual([{ pid: 1, at: 49_000 }]);
    expect(state.endgame!.settlement!.rows.map((r) => r.pid)).toEqual([2, 0]);
    expect(state.endgame!.settlement!.culprits[0].pid).toBe(1);
  });
});

describe("buildGameView：内部段与战报", () => {
  it("RNG 流与内部发号保形置零（未来抽卡顺序绝不外泄）", () => {
    const s = rawState({ players: [player(0), player(1)] });
    const { state } = buildGameView(s, [], 0);
    expect(state.rngStates).toEqual({ setup: 0, deck: 0, items: 0, dice: 0, world: 0 });
    expect(state.seq).toBe(0);
    expect(state.dogSeq).toBe(0);
    expect(state.customsSeq).toBe(0);
  });

  it("战报尾片 = 最后 200 条 + who/targets 重定基；输入不被污染（收者=老2）", () => {
    const msgs: MessageEntry[] = Array.from({ length: 250 }, (_, i) => ({
      id: i + 1,
      turn: 3,
      kind: "event",
      text: `m${i}`,
      emphasis: "normal",
      ...(i % 7 === 0 ? { who: 2, targets: [0, 1] } : {}),
    })) as unknown as MessageEntry[];
    const s = rawState({ players: [player(0), player(1), player(2)], messages: msgs });
    const { state, messages } = buildGameView(s, [], 2);
    expect(messages.length).toBe(MESSAGE_TAIL);
    expect(state.messages).toEqual(messages); // 同一段尾片
    expect(messages[0].text).toBe("m50"); // 250 条取尾 200，首位=第 51 条
    const withWho = messages.find((m) => (m as { who?: number }).who != null)! as { who: number; targets: number[] };
    expect(withWho.who).toBe(0); // 老2=收者→0
    expect(withWho.targets).toEqual([1, 2]); // 老0→1、老1→2
    expect(s.messages.length).toBe(250);
    expect((s.messages[0] as { who?: number }).who).toBe(2); // 原件未动
  });
});

describe("buildGameView：facts 批", () => {
  it("pid/target/targets 重定基 + itemDrawn 双口径（本人真卡面/他人空串）；分节号不动", () => {
    const s = rawState({ players: [player(0), player(1), player(2)] });
    const batch: Fact[] = [
      { type: "roll", pid: 1, d: 5, auto: false },
      { type: "itemDrawn", pid: 1, cardId: "真牌" },
      { type: "itemDrawn", pid: 2, cardId: "他人牌" },
      { type: "customsChecked", pid: 0, target: 2, lied: true },
      { type: "beastWave", wave: 1, hp: 70, maxHp: 70 },
      { type: "windowStart", turn: 3, deadline: 42_000 },
    ] as unknown as Fact[];
    const { facts } = buildGameView(s, batch, 1);
    const roll = facts[0] as { pid: number };
    expect(roll.pid).toBe(0); // 老1=收者→0
    expect((facts[1] as { cardId: string; pid: number })).toMatchObject({ pid: 0, cardId: "真牌" });
    expect((facts[2] as { cardId: string; pid: number })).toMatchObject({ pid: 2, cardId: "" });
    const checked = facts[3] as { pid: number; target: number };
    expect(checked.pid).toBe(1);
    expect(checked.target).toBe(2); // 老2 在收者后 → 原 pid 保持
    expect((facts[5] as { turn: number }).turn).toBe(3); // 分节号不是 pid，原样
  });
});
