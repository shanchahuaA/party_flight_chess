// M2-T5（#42）DO 对局核集成主链（Spec #37 Testing Decisions 缝 2 继续；房间面在 room/lobby.test）。
// 好测试=外部行为级别：HTTP/WS 进，事实/快照/消息条断言；DO 内部（kernel 懒加载/alarm 排程）不直测，
// Hibernation 的账面直查 SQL 沿 room.test/lobby.test 先例（唤醒恢复唯一真源=SQLite 的既定裁决）。
//
// 状态机三问对照（docs/脚手架约定.md；DO 单线程事件串行是结构性前提）：
// 1. 同一实体并发操作（两人同拍给同一窗发意图）：DO 事件串行 + kernel.apply 单步校验（后到者收
//    error+快照对齐）——「守门与对齐」组覆盖。
// 2. 挂账期间标的消失（局间动的旧 kernel + 新座位组合同）：handleIntent 门闸+pid 守卫两道 error 兜底。
// 3. 边界 tick 重入：alarm 汇非空转由 lastIdleAt 簿记挡（DO 每拍只喂一个 tick，不重复喂；
//    kernel 侧「一 tick 双吞世界回合」的回归在 kernel window.test 兜底——分工已定）。
import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Fact, GameState, Intent, SettlementRow } from "../../kernel/src/types";
import type { RoleId } from "../../kernel/src/data/roles";
import type { LobbyConfig } from "../../shared/protocol";
import {
  advanceTime,
  connect,
  createRoom,
  gameRow,
  joinRoom,
  nextError,
  nextGame,
  nextRoom,
  type GameMsg,
  type WsClient,
} from "./helpers";

/** 主链短配置：窗 10s（域下限）、局长 5（域下限）、休息 0（轮次直连）、恶意 off（少一份
 *  对局中途全灭导致直接 groupFail 的随机路径——保终局走年兽战这条验收线） */
const MAIN_CFG: LobbyConfig = {
  turnCap: 5, maxHp: 5, windowMs: 10_000, restMs: 0,
  timerMode: "world", maliceEvery: 2, maliceLevel: "off",
};

/** Alarm 专项配置：休息 2s（验 restStart→收窗→下一窗全靠 alarm），其余同主链 */
const ALARM_CFG: LobbyConfig = { ...MAIN_CFG, restMs: 2_000 };

interface Drive {
  code: string;
  host: WsClient;
  guest: WsClient;
  /** 两视角最新 game 态（各自整覆盖替换） */
  hostState: GameState | null;
  guestState: GameState | null;
  /** 全程见过的 fact type 集合 */
  seenFacts: Set<string>;
  /** 各视角收到的 game 消息全量（按序） */
  log: { which: "host" | "guest"; m: GameMsg }[];
  /** 真人（auto=false）roll/confirm 计数（打出的 pid 0=打本人） */
  ownHumanRolls: number;
  ownHumanConfirms: number;
  /** 见过的 room 快照相位（收口/翻 phase 断言用） */
  seenRoomPhases: Set<string>;
}

const sendIntent = (c: WsClient, turn: number, intent: Intent): void => {
  c.send({ type: "intent", turn, intent });
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 带冷却轮的缓冲排干：server 的紧邻 send 在客户端是逐帧事件，error/room/game 对齐包可能
 *  晚一两拍才落地——连续三轮「排空→冷却」确保读 pickRole ack 时缓冲里没有更早的 room 快照 */
async function quietDrain(c: WsClient): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    while (c.pop() !== undefined) {
      /* 排空 */
    }
    await sleep(40);
  }
  while (c.pop() !== undefined) {
    /* 收尾扫一遍 */
  }
}

const factList = (m: GameMsg): Array<{ type: string; pid?: number; auto?: boolean }> =>
  m.facts as unknown as Array<{ type: string; pid?: number; auto?: boolean }>;

/** 并账一条 game 消息：状态覆盖 + 事实集累计 + 真人（auto=false）动作计数 */
function ingest(d: Drive, which: "host" | "guest", m: GameMsg): void {
  if (which === "host") d.hostState = m.state;
  else d.guestState = m.state;
  d.log.push({ which, m });
  for (const f of factList(m)) {
    d.seenFacts.add(f.type);
    if (f.type === "roll" && f.auto === false) d.ownHumanRolls += 1;
    if (f.type === "confirm" && f.auto === false) d.ownHumanConfirms += 1;
  }
}

/** 单步反应（验收 1「真人窗口每窗 roll+confirm 老实发」：轮选路→代选卡→掷→确认→战波砍击）。
 *  返回是否出手。allowActions=false 抽掉真人动作（alarm 全自动组专测时钟税）。 */
function pumpStep(d: Drive, which: "host" | "guest", allowActions: boolean): boolean {
  const s = which === "host" ? d.hostState : d.guestState;
  if (!s) return false;
  const c = which === "host" ? d.host : d.guest;
  const me = s.players[0];
  if (s.phase === "drafting") {
    // 抽暗牌：凡在座真人都各选（视角重定基=自己恒 pid 0；self.secretPick 真值对本视角可见，
    // 选位后不再重复发）。内核 T5c 前置修复后=全员选定才开窗，drafting 期 alarm 无钟可催，
    // 本分支是 pump 唯一豁免面（allowActions=false 也放行）——双端各补一票即点亮第一窗。
    if (!me.isBot && me.secretPick == null) {
      sendIntent(c, s.turn, { type: "chooseSecret", pid: 0, pick: 0 });
      return true;
    }
    return false;
  }
  if (!allowActions || s.phase === "over" || s.phase === "rest") return false;
  if (me.dead || me.zone === "done") return false; // 淘汰/通关席不行动（替掷与假人继续）——kernel 闸同口径
  const fighting = s.endgame?.beast != null;
  if (me.walk?.ask) {
    sendIntent(c, s.turn, { type: "chooseRoute", pid: 0, option: 0 });
    return true;
  }
  if (me.cardPending) {
    sendIntent(c, s.turn, { type: "chooseCard", pid: 0, option: 0 });
    return true;
  }
  if (fighting) {
    if (!me.rolled) {
      sendIntent(c, s.turn, { type: "strike", pid: 0 });
      return true;
    }
    return false;
  }
  if (!me.rolled) {
    sendIntent(c, s.turn, { type: "roll", pid: 0 });
    return true;
  }
  if (!me.confirmed) {
    sendIntent(c, s.turn, { type: "confirm", pid: 0 });
    return true;
  }
  return false;
}

/** 驱动循环（双端 pop 轮询制，绝不丢消息）：把双方缓冲消息逐条并账+各自反应；双方全空才快进。 */
async function drive(
  d: Drive,
  done: (d: Drive) => boolean,
  opts: { allowActions?: boolean; budgetMs?: number; idleAdvance?: number; idleEvery?: number } = {},
): Promise<void> {
  const allowActions = opts.allowActions ?? true;
  const budgetMs = opts.budgetMs ?? 100_000;
  const idleAdvance = opts.idleAdvance ?? 2_600;
  const idleEvery = opts.idleEvery ?? 8; // 连续 8×25ms≈200ms 无消息才快进
  const deadline = Date.now() + budgetMs;
  let idleStreak = 0;
  while (Date.now() < deadline) {
    let got = false;
    for (const which of ["host", "guest"] as const) {
      const raw = (which === "host" ? d.host : d.guest).pop();
      if (raw == null) continue;
      got = true;
      if (raw.type === "room") {
        d.seenRoomPhases.add((raw as { room: { phase: string } }).room.phase);
      } else if (raw.type === "game") {
        const m = raw as GameMsg;
        ingest(d, which, m);
        pumpStep(d, which, allowActions);
      }
    }
    if (got) {
      idleStreak = 0;
      continue;
    }
    // 双端缓冲当下见底才做完成判定：把 gameEnd 之后接龙到的 room 收口快照也一并消化掉
    if (done(d)) return;
    idleStreak += 1;
    if (idleStreak >= idleEvery) {
      idleStreak = 0;
      // 无真人输入快进：alarm 把 kernel.tick(now) 喂进去（bots 日程/替掷/收窗/休息全 deadline 制）
      await advanceTime(d.code, idleAdvance);
    } else {
      await sleep(25); // 给 workerd 事件循环留转进余地
    }
  }
  throw new Error(
    `drive 超时（${Math.round(budgetMs / 1000)}s 内局没走完）` +
      ` hostPhase=${d.hostState?.phase} turn=${d.hostState?.turn}` +
      ` winDeadline=${d.hostState?.windowDeadline}` +
      ` log=${d.log.length} facts=${[...d.seenFacts].join(",")}` +
      ` rolls=${d.ownHumanRolls} confirms=${d.ownHumanConfirms}`,
  );
}

/** 全新 3 人局（房东真+朋友甲真+小黄假）：两端 connect 完成（hello 已消费） */
async function newRoomWithBot(): Promise<{ drive: Drive; hostToken: string; guestToken: string }> {
  const created = await createRoom("房东");
  const joined = await joinRoom(created.code, "朋友甲");
  const host = await connect(created.code, created.token);
  const guest = await connect(created.code, joined.token);
  await nextRoom(host); // 朋友甲上线广播（guest 侧同构广播留在缓冲，驱动循环 pop 消化）
  host.send({ type: "addBot" });
  await nextRoom(host); // 小黄入座
  await nextRoom(guest);
  return {
    drive: {
      code: created.code,
      host,
      guest,
      hostState: null,
      guestState: null,
      seenFacts: new Set(),
      log: [],
      ownHumanRolls: 0,
      ownHumanConfirms: 0,
      seenRoomPhases: new Set(),
    },
    hostToken: created.token,
    guestToken: joined.token,
  };
}

/** 房东落配置并开局+房东先明选暗牌（第二真人的一票由驱动循环补）：
 *  两端 room(playing)/game 开局快照/房东选牌 ack 都已消费并并账；第一窗的开张在 drive 里接力到齐。
 *  驱动循环 pop 只在「消息到达」后反应；boot ack 走显式消费，开局点火必须在此显式浇灌。 */
async function startGame(
  d: Drive,
  cfg: LobbyConfig,
): Promise<{ hostBoot: GameState; guestBoot: GameState }> {
  d.host.send({ type: "setConfig", config: cfg });
  await nextRoom(d.host);
  await nextRoom(d.guest);
  d.host.send({ type: "start" });
  expect((await nextRoom(d.host)).phase).toBe("playing");
  expect((await nextRoom(d.guest)).phase).toBe("playing");
  const hb = await nextGame(d.host);
  const gb = await nextGame(d.guest);
  ingest(d, "host", hb);
  ingest(d, "guest", gb);
  // 房东明选暗牌；朋友甲的一票同样在此显式补齐——修后内核（T5c 前置）全员选定才开窗，
  // 而 drafting 期 alarm 无钟可催、drive 只在收到新消息时翻起 pump，冷启动必须在此浇齐两票。
  sendIntent(d.host, hb.state.turn, { type: "chooseSecret", pid: 0, pick: 0 });
  const ha = await nextGame(d.host); // 房东选牌 ack（phase 仍 drafting）
  const ga = await nextGame(d.guest); // 广播同步
  ingest(d, "host", ha);
  ingest(d, "guest", ga);
  sendIntent(d.guest, ga.state.turn, { type: "chooseSecret", pid: 0, pick: 0 }); // 自视角恒 pid 0（协议转译）
  const gaa = await nextGame(d.guest); // 朋友甲选牌 ack——同批含 windowStart（开张拍）
  const haa = await nextGame(d.host); // 广播（host 侧 phase 翻 acting）
  ingest(d, "guest", gaa);
  ingest(d, "host", haa);
  return { hostBoot: hb.state, guestBoot: gb.state };
}

/** 裁剪硬约束（任意视角任意拍）：本人=true hand 原样/他人=[]；他人暗牌 [0,0]；
 *  RNG 五流+内部发号全部保形置零（收者视图零泄密口径——Spec 决策 4） */
function expectTrimmed(state: GameState, selfName: string): void {
  const self = state.players[0];
  expect(self.name).toBe(selfName); // 重定基=收者恒 players[0]
  expect(self.hand.length).toBeGreaterThan(0); // 自己手牌真值（轻装上阵开局 +1 已到手）
  for (const p of state.players.slice(1)) {
    expect(p.hand).toEqual([]);
    expect(p.secretOptions).toEqual([0, 0]);
  }
  expect(state.rngStates).toEqual({ setup: 0, deck: 0, items: 0, dice: 0, world: 0 });
  expect(state.seq).toBe(0);
  expect(state.dogSeq).toBe(0);
  expect(state.customsSeq).toBe(0);
}

describe("对局主链（M2-T5）：进房打到结算，局间再开新局", () => {
  it(
    "抽暗牌→五窗（真人老实 roll+confirm）→年兽战→结算→room 翻 intermission→新局新种子·旧账覆盖",
    async () => {
      const { drive: d } = await newRoomWithBot();
      const { hostBoot, guestBoot } = await startGame(d, MAIN_CFG);

      // ── 开局快照：两视角同构（同一 kernel 一真）+ 裁剪合规 + 身份重定基础 ──
      expectTrimmed(hostBoot, "房东");
      expectTrimmed(guestBoot, "朋友甲");
      expect(hostBoot.players.map((p) => p.name)).toEqual(["房东", "朋友甲", "小黄"]);
      expect(guestBoot.players.map((p) => p.name)).toEqual(["朋友甲", "房东", "小黄"]);
      expect(hostBoot.players[0].secretOptions.length).toBe(2);
      expect(hostBoot.players[0].secretOptions.every((n) => n !== 0)).toBe(true);
      expect(hostBoot.phase).toBe("drafting");
      expect(hostBoot.players[0].isBot).toBe(false);
      expect(hostBoot.players[1].isBot).toBe(false);
      // 假人已在 create 由系统代抽：其暗牌下标已落（真实值随壳保密——他人视角只见 [0,0]）
      expect(hostBoot.players[2].isBot).toBe(true);
      // boot 事实批的 itemDrawn 双口径：自己的摸牌见真卡面、他人的置空（gameView.rebaseFacts 行为面）
      const bootFactsForHost = d.log.filter((e) => e.which === "host").flatMap((e) => factList(e.m));
      const myDraw = bootFactsForHost.filter((f) => f.type === "itemDrawn" && f.pid === 0);
      const otherDraw = bootFactsForHost.filter((f) => f.type === "itemDrawn" && f.pid !== 0);
      expect(myDraw.length).toBeGreaterThan(0);
      expect((myDraw[0] as unknown as { cardId: string }).cardId.length).toBeGreaterThan(0);
      expect(otherDraw.every((f) => (f as unknown as { cardId: string }).cardId === "")).toBe(true);

      // ── 全程驱动到 gameEnd（真人老实发：选路/抉择/掷骰/确认/砍击全自动串行）──
      await drive(d, (x) => x.seenFacts.has("gameEnd"));

      // ── 主链事实齐备（验收 1/2 的存在性面）──
      expect(d.seenFacts.has("windowStart")).toBe(true);
      expect(d.seenFacts.has("roll")).toBe(true);
      expect(d.seenFacts.has("step")).toBe(true);
      expect(d.seenFacts.has("confirm")).toBe(true);
      expect(d.seenFacts.has("windowEnd")).toBe(true);
      expect(d.seenFacts.has("beastWave")).toBe(true); // 局长打满→终局最后一波年兽战
      expect(d.seenFacts.has("beastHit")).toBe(true);
      expect(d.seenFacts.has("settlement")).toBe(true);
      // 真人每窗老实发的证据：auto=false 的 roll/confirm 多于一窗
      expect(d.ownHumanRolls).toBeGreaterThanOrEqual(3);
      expect(d.ownHumanConfirms).toBeGreaterThanOrEqual(3);

      // ── 终局快照与盏底盘 ──
      const endState = d.hostState!;
      expect(endState.phase).toBe("over");
      const settlement = endState.endgame!.settlement!;
      expect(settlement).toBeTruthy();
      expect(endState.players).toHaveLength(3);
      for (const p of endState.players) {
        expect(p.hp).toBeGreaterThanOrEqual(0);
        expect(p.hp).toBeLessThanOrEqual(5);
        // 假人=系统代抽（0|1）；真人=选过（0|1）——凡在座真人都由驱动补选到齐才开窗
        if (p.isBot) expect([0, 1]).toContain(p.secretPick);
        else expect([null, 0, 1]).toContain(p.secretPick);
      }
      expect(new Set(endState.finishers).size).toBe(endState.finishers.length);
      expect(settlement.rows).toHaveLength(3);
      for (const row of settlement.rows) {
        expect(row.finishRank == null || row.finishRank >= 1).toBe(true);
        expect(row.total).toBeGreaterThanOrEqual(0);
      }
      const rankedCount = settlement.rows.filter((r) => r.finishRank != null).length;
      expect(
        settlement.rows.map((r) => r.finishRank).filter((x): x is number => x != null).sort((a, b) => a - b),
      ).toEqual(Array.from({ length: rankedCount }, (_, i) => i + 1));

      // ── 结算包全场同构：两视角 rows 去掉 pid 后（重定基所致差）逐字段集对账一致 ──
      const guestEnd = d.guestState!;
      expect(guestEnd.phase).toBe("over");
      const stripRow = (r: SettlementRow): Omit<SettlementRow, "pid"> & { total: number } => {
        const { pid: _pid, ...rest } = r;
        return { ...rest };
      };
      expect(
        settlement.rows
          .map(stripRow)
          .sort((a, b) => b.total - a.total),
      ).toEqual(guestEnd.endgame!.settlement!.rows.map(stripRow).sort((a, b) => b.total - a.total));
      expect(settlement.groupFail).toBe(guestEnd.endgame!.settlement!.groupFail);

      // ── 房间面收口：gameEnd 广播翻 phase=intermission（两端房间快照已到）──
      expect(d.seenRoomPhases.has("intermission")).toBe(true);

      // ── 局间再来一局：房主直接 start（intermission 同闸放行）；旧账覆盖+新种子 ──
      const oldDeck = JSON.stringify(endState.deck);
      const oldSecrets = JSON.stringify(endState.players[0].secretOptions);
      d.host.send({ type: "start" });
      const newBoot = (await nextGame(d.host)).state;
      expect(newBoot.turn).toBe(1);
      expect(newBoot.phase).toBe("drafting");
      expect(newBoot.players).toHaveLength(3);
      // 每局新种子（Spec 决策 2/6）：牌堆洗序换（1/20! 重合率）；暗牌对作为第二重信号
      const secretChanged = JSON.stringify(newBoot.players[0].secretOptions) !== oldSecrets;
      const deckChanged = JSON.stringify(newBoot.deck) !== oldDeck;
      expect(deckChanged || secretChanged).toBe(true);
      // 旧账被覆盖：库中 game 仍单行、已翻新为本局账（drafting/turn=1）
      const row = await gameRow(d.code);
      expect(row).toBeTruthy();
      expect((row!.state as GameState).turn).toBe(1);
      expect((row!.state as GameState).phase).toBe("drafting");
      expect((row!.state as GameState).players).toHaveLength(3);
      d.host.close();
      d.guest.close();
    },
    140_000,
  );
});

describe("守门与对齐（M2-T5）", () => {
  it(
    "回合号过期=「操作过期」+单发快照对齐（非广播）；局不崩，正意图照跑",
    async () => {
      const { drive: d } = await newRoomWithBot();
      await startGame(d, MAIN_CFG);
      await drive(d, (x) => x.hostState!.phase === "acting", { budgetMs: 30_000 });
      const turn = d.hostState!.turn;

      d.host.send({ type: "intent", turn: turn + 5, intent: { type: "roll", pid: 0 } });
      const err = await nextError(d.host, "操作过期");
      expect(err.length).toBeGreaterThan(0);
      const aligned = await nextGame(d.host); // 单发整份快照（非广播，仅操作人收到）
      ingest(d, "host", aligned);
      expect(aligned.state.turn).toBeGreaterThanOrEqual(turn); // 单调：不后退（临近窗界时可能有同拍推进）

      // 局不崩：合法意图照走（真人自掷或机器替掷同一条验收面——roll 事实必然落地）
      await drive(d, (x) => x.seenFacts.has("roll"), { budgetMs: 30_000 });
      d.host.close();
      d.guest.close();
    },
    60_000,
  );

  it(
    "卡不存在/dev 族被拒（allowDev 服务端关）——error 实+快照对齐；局不崩",
    async () => {
      const { drive: d } = await newRoomWithBot();
      await startGame(d, MAIN_CFG);
      await drive(d, (x) => x.hostState!.phase === "acting", { budgetMs: 30_000 });
      const turn = d.hostState!.turn;

      d.host.send({ type: "intent", turn, intent: { type: "playItem", pid: 0, cardId: "nie_ma" } });
      const err1 = await nextError(d.host);
      expect(err1.length).toBeGreaterThan(0);
      expect((await nextGame(d.host)).state.turn).toBeGreaterThanOrEqual(turn); // 对齐快照单发

      d.host.send({ type: "intent", turn, intent: { type: "dev.hit", pid: 0, dmg: 1 } });
      await nextError(d.host, "dev 意图未开放");
      await nextGame(d.host);

      // 局不崩：后续窗口照常推进（真人 roll 照收——一切在闸外的轴里原样跑）
      await drive(d, (x) => x.seenFacts.has("roll"));
      d.host.close();
      d.guest.close();
    },
    60_000,
  );

  it(
    "局间（intermission）意图拒「对局未开始」；大厅面照开（选角可动）",
    async () => {
      const { drive: d } = await newRoomWithBot();
      await startGame(d, MAIN_CFG);
      await drive(d, (x) => x.seenFacts.has("gameEnd"));
      expect(d.seenRoomPhases.has("intermission")).toBe(true);

      const turn = d.hostState!.turn;
      d.host.send({ type: "intent", turn, intent: { type: "roll", pid: 0 } });
      await nextError(d.host, "对局未开始");
      d.guest.send({ type: "intent", turn, intent: { type: "roll", pid: 0 } });
      await nextError(d.guest, "对局未开始");

      // 局间配置态的活动面：角色明选照常（同批人改配置再开的部分）。先带冷却排干
      // 「对局未开始」error 后的对齐 room/game（它们晚于 error 帧落地），再取 pickRole ack。
      await quietDrain(d.guest);
      d.guest.send({ type: "pickRole", roleId: "boss" as RoleId });
      const seen = await nextRoom(d.guest);
      expect(seen.seats.find((s) => s.name === "朋友甲")?.roleId).toBe("boss");
      d.host.close();
      d.guest.close();
    },
    60_000,
  );
});

describe("Alarm 全自动推进（M2-T5）", () => {
  it(
    "无真人输入的局照样走完：窗超替掷（auto roll/confirm）+步进+休息收窗+海关钟不卡",
    async () => {
      const { drive: d } = await newRoomWithBot();
      await startGame(d, ALARM_CFG);
      // 真人只在 drafting 各选一次暗牌（pump 唯一豁免面，双端各一票），此后零真人动作——全靠 alarm 推
      await drive(d, (x) => x.seenFacts.has("gameEnd"), { allowActions: false });

      // 子轴一：auto=true 的 roll/confirm（替掷与假人日程同一条时钟税道；整局里必现）
      expect(d.log.some(({ m }) => factList(m).some((f) => f.type === "roll" && f.auto === true))).toBe(true);
      expect(d.log.some(({ m }) => factList(m).some((f) => f.type === "confirm" && f.auto === true))).toBe(true);
      // 子轴二：步进链 + 窗收一并
      expect(d.seenFacts.has("step")).toBe(true);
      expect(d.seenFacts.has("windowEnd")).toBe(true);
      // 子轴三：休息收窗（restStart 之后还有 windowStart——休息款由 alarm 到点开下一窗）
      expect(d.seenFacts.has("restStart")).toBe(true);
      const lastRestIdx = d.log.findIndex(({ m }) => factList(m).some((f) => f.type === "restStart"));
      expect(lastRestIdx).toBeGreaterThanOrEqual(0);
      expect(
        d.log.slice(lastRestIdx + 1).some(({ m }) => factList(m).some((f) => f.type === "windowStart")),
      ).toBe(true);
      expect(d.hostState!.phase).toBe("over");
      expect(d.hostState!.endgame?.settlement).toBeTruthy();
      d.host.close();
      d.guest.close();
    },
    140_000,
  );
});

describe("Hibernation 唤醒续局（M2-T5）", () => {
  it(
    "evict→新连凭 token 归队：game hello 全量恢复（自己的牌真值/他手保密/RNG 面 0）；续局推进不重号",
    async () => {
      const { drive: d, hostToken } = await newRoomWithBot();
      await startGame(d, MAIN_CFG);
      await drive(d, (x) => (x.hostState?.turn ?? 0) >= 2, { budgetMs: 60_000 });
      const selfBefore = JSON.parse(JSON.stringify(d.hostState!.players[0])) as GameState["players"][number];
      const maxMsgId = Math.max(
        0,
        ...d.log
          .filter((e) => e.m.state.messages.length > 0)
          .map((e) => Math.max(...e.m.state.messages.map((mm) => mm.id))),
      );

      // 账面直查：内核整态已落 SQLite（唤醒即此重建的唯一真源）
      const row = await gameRow(d.code);
      expect(row).toBeTruthy();
      expect((row!.state as GameState).players).toHaveLength(3);

      // 撕掉实例：内存清空，SQLite 起新活（hyp WS 保留）
      await evictDurableObject(env.ROOM.get(env.ROOM.idFromName(d.code)));
      d.host.close();

      const back = await connect(d.code, hostToken);
      expect(back.hello.type).toBe("room");
      const helloGame = await nextGame(back); // playing 期连接追加 game 消息（facts=[] 全量快照）
      const resumed = helloGame.state;
      expect(helloGame.facts).toEqual([]);
      expect(resumed.players[0].name).toBe("房东");
      expect(resumed.players[0].hand).toEqual(selfBefore.hand);
      expect(resumed.players[0].secretOptions).toEqual(selfBefore.secretOptions);
      expect(resumed.players[0].pos).toBe(selfBefore.pos);
      for (const p of resumed.players.slice(1)) {
        expect(p.hand).toEqual([]);
        expect(p.secretOptions).toEqual([0, 0]);
      }
      expect(resumed.rngStates).toEqual({ setup: 0, deck: 0, items: 0, dice: 0, world: 0 });

      // 续局：同一 drive 对象换上新连接继续推（快进+真人老实发照走），回合号继续走）
      // 战报账「不重号」的确定性面：id 单调不回落——续局 hello 的战报尾牌 max id ≥ 唤醒前
      // 已见最大 id（战报条目只在有文案事件时增长，纯回合钟前进可以零增长，故只验单调）。
      d.host = back;
      const resumedTurn = resumed.turn;
      await drive(d, (x) => (x.hostState?.turn ?? 0) > resumedTurn || x.hostState?.phase === "over", {
        budgetMs: 60_000,
      });
      const afterIds = d.hostState!.messages.map((mm) => mm.id);
      const newMaxId = afterIds.length > 0 ? Math.max(...afterIds) : 0;
      expect(newMaxId).toBeGreaterThanOrEqual(maxMsgId);
      // 「不重号」的另一半：当前尾片内 id 无重复（同拍历史唯一——load 校验+seq 续走）
      expect(new Set(afterIds).size).toBe(afterIds.length);
      d.host.close();
      d.guest.close();
      back.close();
    },
    140_000,
  );
});
