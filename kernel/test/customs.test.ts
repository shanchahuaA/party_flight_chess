/**
 * 警长查货窗（#26 T7，自由窗口唯一一张=事件卡「黑市开张」e21；一页纸「警长查货窗」节）：
 * - 开窗：抽到 → 系统随机指派 1 名在场玩家当警长（淘汰者/通关席除外），其余为偷渡者；
 *   本世界回合窗转为海关风云，收窗即散（绝不跨窗）。
 * - 转让/报备：窗内玩家间可报备转让道具卡——明面只许正货（报备校验拒违禁品名），
 *   运违禁品只能谎报；谎报判读=declared≠实际箱货（contraband 字段驱动的报备校验让违禁品必然谎报）。
 * - 查验 ≤2 次（6 人在场及以上 3 次）：命中谎报=偷渡者交 1 张自选道具卡给警长（无卡回退 3 格）；
 *   查验清白=警长赔 1 张自选道具卡（无卡回退 3 格）。查验成果走 customsChecked 事实（T8b1 计数流）。
 * - 退化：警长超时不查（CUSTOMS_CHECK_MS，每查一次续期）/假警长不查验/警长离场 → 自由转让（无查验），
 *   绝不阻塞；罚没自选超时代选、收窗兜底代选。
 * - 假人：假警长直接退化；假偷渡者到点自动报备转让（正货如实报、违禁品谎报为随机正货名）。
 *
 * 确定性铁律：dev.customs 钉定警长（真抽路径另测）；假人角色固定（无轻装上阵=开局手牌空）；
 * 假人 rollAt=∞ 冻结走格摸卡的随机流（假人报备单测）；窗内 tick 不越 windowDeadline（收窗即散）。
 */
import { describe, expect, it } from "vitest";
import {
  BOARD,
  CUSTOMS_CHECK_MS,
  CUSTOMS_CHECKS,
  CUSTOMS_CHECKS_BIG,
  CUSTOMS_RETREAT,
  GameKernel,
  ITEM_CARD_BY_ID,
  ITEM_CARDS,
  type GameConfig,
  type PlayerDef,
} from "../src";
import { cell, tryGiveItem } from "./helpers";

const FIXED: PlayerDef[] = [
  { name: "你", isBot: false, roleId: "light" },
  { name: "小黄", isBot: true, roleId: "tough" }, // 非黑市老板——被动转让摸卡会把假人手牌搅进断言（专用用例单测）
  { name: "小绿", isBot: true, roleId: "beast" },
  { name: "小蓝", isBot: true, roleId: "woe" },
];
/** 6 人局（大查验次数档=3 次） */
const SIX: PlayerDef[] = [
  ...FIXED,
  { name: "丁", isBot: true, roleId: "tough" },
  { name: "戊", isBot: true, roleId: "beast" },
];
const bootDefs = (defs: PlayerDef[], over: Partial<GameConfig> = {}): GameKernel => {
  const { kernel } = GameKernel.create({ allowDev: true, restMs: 0, ...over }, 0, defs);
  kernel.apply({ type: "chooseSecret", pid: 0, pick: 0 }, 0);
  return kernel;
};
const bootK = (over: Partial<GameConfig> = {}): GameKernel => bootDefs(FIXED, over);

const PIN = cell(0, 13); // 外环西侧主干道格（退格实验钉位）
const PIN_FROM = BOARD[PIN]!.links[0]!; // 退格回程锚（from 非空=退格沿来向倒一步）

/** 钉定警长开窗（dev 钉位通道；真抽路径另测） */
const open = (k: GameKernel, sheriff: number, now = 0): void => {
  k.apply({ type: "dev.customs", sheriff }, now);
};

/** 塞一张正货/违禁品给 pid：表一池内挑（已被别家摸走的跳过），返回卡 id */
const giveFrom = (k: GameKernel, pid: number, wantContraband: boolean): string => {
  for (const c of ITEM_CARDS) {
    if ((c.contraband === true) !== wantContraband) continue;
    if (tryGiveItem(k, pid, c.id, 0)) return c.id;
  }
  throw new Error(`没有可塞的${wantContraband ? "违禁品" : "正货"}`);
};
const giveLegit = (k: GameKernel, pid: number): string => giveFrom(k, pid, false);
const giveContraband = (k: GameKernel, pid: number): string => giveFrom(k, pid, true);

/** 冻结假人走格（rollAt=∞）：假人报备排程的随机流不被走格摸卡污染（本文件确定性铁律） */
const freezeBots = (k: GameKernel): void => {
  for (const p of k.state.players) if (p.isBot) p.botSchedule.rollAt = Number.POSITIVE_INFINITY;
};

/** 出清假人报备排程（开窗后 3.1s 一拍全到点；空手=不出单）：先跑掉排程再摆本用例的货，
 *  防后续 tick 里「假人拿了货再转手」的链式单污染手牌断言（出清后同批不再重试）。 */
const flushBotPlans = (k: GameKernel): void => {
  k.tick(3_100);
};

/** 造一单报备（直接走 customsShip 意图——bot 也可提交，kernel 不按 isBot 分叉）；返回报备单号 */
const ship = (k: GameKernel, from: number, cardId: string, to: number, declared: string = cardId, now = 0): number => {
  k.apply({ type: "customsShip", pid: from, cardId, to, declared }, now);
  return k.state.customs!.shipments.at(-1)!.id;
};

const msg = (k: GameKernel, text: string): boolean => k.state.messages.some((m) => m.text.includes(text));
const hand0 = (k: GameKernel): string[] => k.state.players[0]!.hand;

describe("警长查货窗 · 开窗与指派（状态机·开始）", () => {
  it("dev.customs 钉定警长：海关挂账（sheriff/2 次/armed/15s 截止）+customsStart 事实+播报点名", () => {
    const k = bootK();
    const fx = k.apply({ type: "dev.customs", sheriff: 0 }, 0);
    const c = k.state.customs!;
    expect(c).toMatchObject({ sheriff: 0, armed: true, checksLeft: CUSTOMS_CHECKS, degraded: false, checkDeadline: CUSTOMS_CHECK_MS });
    expect(c.shipments).toEqual([]);
    expect(c.pending).toBeNull();
    expect(fx.some((f) => f.type === "customsStart" && f.sheriff === 0 && f.checks === CUSTOMS_CHECKS)).toBe(true);
    expect(msg(k, "海关风云！你 被指命为警长")).toBe(true);
    expect(msg(k, "明面只许运正货")).toBe(true);
  });

  it("抽到「黑市开张」（dev 直发=真抽同链）：海关开张、警长=在场玩家之一", () => {
    const k = bootK();
    k.apply({ type: "dev.drawCard", pid: 0, cardId: "e21" }, 0);
    const c = k.state.customs!;
    expect(c).not.toBeNull();
    expect([0, 1, 2, 3]).toContain(c.sheriff);
    expect(k.state.players[c.sheriff]!.dead).toBe(false);
    expect(k.state.players[c.sheriff]!.zone).not.toBe("done");
  });

  it("6 人局查验 3 次；4 人局 2 次（「6 人以上局」按局人数——在场人数不折）", () => {
    const k6 = bootDefs(SIX);
    k6.apply({ type: "dev.setDead", pid: 1 }, 0); // 开局折员也不减档：局人数口径（票面字面读法，review 收口）
    k6.apply({ type: "dev.setDead", pid: 2 }, 0);
    open(k6, 0);
    expect(k6.state.customs!.checksLeft).toBe(CUSTOMS_CHECKS_BIG);
    const k4 = bootK();
    open(k4, 0);
    expect(k4.state.customs!.checksLeft).toBe(CUSTOMS_CHECKS);
  });

  it("同窗二次抽到：窗口不重开（海关风云仍在——不重置警长与次数）", () => {
    const k = bootK();
    open(k, 0);
    const card = giveLegit(k, 0);
    ship(k, 0, card, 1); // 警长也能运货（自查被拒——此处只验不重开）
    const before = k.state.customs!.shipments.length;
    k.apply({ type: "dev.drawCard", pid: 1, cardId: "e21" }, 0);
    expect(k.state.customs!.shipments.length).toBe(before);
    expect(msg(k, "海关风云仍在，窗口不重开")).toBe(true);
  });

  it("休息期抽到（走路跨窗尾）：下个世界回合正式摆摊——armed 起算+假人排程", () => {
    const k = bootK({ windowMs: 10_000, restMs: 5_000 });
    k.tick(10_000); // 收窗 → 休息期
    expect(k.state.phase).toBe("rest");
    open(k, 0, 10_500);
    expect(k.state.customs!.armed).toBe(false); // 未起算
    expect(msg(k, "正在休息间隙，下个世界回合正式摆摊")).toBe(true);
    k.tick(15_000); // 休息到点 → 开下一窗 → 起算摆摊
    expect(k.state.phase).toBe("acting");
    expect(k.state.customs!.armed).toBe(true);
    expect(k.state.customs!.checkDeadline).toBe(15_000 + CUSTOMS_CHECK_MS);
  });
});

describe("海关风云 · 报备转让与报备校验（状态机·转让）", () => {
  it("报备转让合法正货：卡移交+报备单入册+播报；全场手牌总数守恒", () => {
    const k = bootK();
    open(k, 0);
    const card = giveLegit(k, 0);
    const totalHand = () => k.state.players.reduce((n, p) => n + p.hand.length, 0);
    const before = { me: hand0(k).length, to: k.state.players[1]!.hand.length, total: totalHand(), discard: k.state.itemDiscard.length };
    k.apply({ type: "customsShip", pid: 0, cardId: card, to: 1, declared: card }, 0);
    expect(hand0(k).length).toBe(before.me - 1);
    expect(k.state.players[1]!.hand).toContain(card);
    expect(totalHand()).toBe(before.total); // 手牌→手牌：单池总量不动
    expect(k.state.itemDiscard.length).toBe(before.discard); // 不进弃牌堆
    const s = k.state.customs!.shipments.at(-1)!;
    expect(s).toMatchObject({ from: 0, to: 1, cardId: card, declared: card, checked: false });
    expect(msg(k, `你 向 小黄 报备转让 1 张道具卡——报备货名「${ITEM_CARD_BY_ID.get(card)!.title}」`)).toBe(true);
  });

  it("谎报：运违禁品报个正货名——箱单记谎（declared≠实际）；报备违禁品名=内核拒（明面只许正货）", () => {
    const k = bootK();
    open(k, 0);
    const bad = giveContraband(k, 0);
    const legit = ITEM_CARDS.find((c) => !c.contraband)!.id;
    k.apply({ type: "customsShip", pid: 0, cardId: bad, to: 1, declared: legit }, 0);
    const s = k.state.customs!.shipments.at(-1)!;
    expect(s.cardId).toBe(bad);
    expect(s.declared).toBe(legit);
    expect(s.declared === s.cardId).toBe(false); // 谎报账
    // 报备校验：违禁品名直接拒（同一单还没出袋）
    const bad2 = giveContraband(k, 0);
    expect(() => k.apply({ type: "customsShip", pid: 0, cardId: bad2, to: 1, declared: bad2 }, 0)).toThrow(/明面只许运正货/);
    expect(hand0(k)).toContain(bad2);
    // 报备未知名同样拒
    expect(() => k.apply({ type: "customsShip", pid: 0, cardId: bad2, to: 1, declared: "i99" }, 0)).toThrow(/不在表一/);
  });

  it("转让闸全拒因：无海关风云/非本人手牌/目标=本人·淘汰/已确认/罚停轮空", () => {
    const k = bootK();
    const card = giveLegit(k, 0);
    expect(() => k.apply({ type: "customsShip", pid: 0, cardId: card, to: 1, declared: card }, 0)).toThrow(/没有海关风云/);
    open(k, 0);
    expect(() => k.apply({ type: "customsShip", pid: 0, cardId: "i04", to: 1, declared: "i04" }, 0)).toThrow(/不在你的手牌/);
    expect(() => k.apply({ type: "customsShip", pid: 0, cardId: card, to: 0, declared: card }, 0)).toThrow(/转让对象要选别人/);
    k.apply({ type: "dev.setDead", pid: 2 }, 0);
    expect(() => k.apply({ type: "customsShip", pid: 0, cardId: card, to: 2, declared: card }, 0)).toThrow(/已淘汰/);
    k.state.players[0]!.confirmed = true; // 等待区置位（真路径 confirm 需先掷骰——置位同义）
    expect(() => k.apply({ type: "customsShip", pid: 0, cardId: card, to: 1, declared: card }, 0)).toThrow(/已确认结束/);
    k.state.players[0]!.confirmed = false;
    k.state.players[0]!.skipped = true;
    expect(() => k.apply({ type: "customsShip", pid: 0, cardId: card, to: 1, declared: card }, 0)).toThrow(/罚停轮空/);
  });

  it("黑市老板被动（表三 #3）：海关窗转让（报备合格）摸 1 张——出卡 −1 摸卡 +1 净平", () => {
    const k = bootDefs([
      { name: "你", isBot: false, roleId: "boss" }, // 人间=黑市老板
      { name: "小黄", isBot: true, roleId: "tough" },
      { name: "小绿", isBot: true, roleId: "woe" },
    ]);
    open(k, 0);
    const card = giveLegit(k, 0);
    const before = hand0(k).length;
    k.apply({ type: "customsShip", pid: 0, cardId: card, to: 1, declared: card }, 0);
    expect(hand0(k).length).toBe(before); // −1 出卡 +1 门路补偿
    expect(msg(k, "黑市老板的门路")).toBe(true);
  });
});

describe("海关风云 · 查验与罚没（状态机·查验；罚没流转）", () => {
  it("抓谎·罚卡：警长开箱命中谎报——偷渡者交 1 张自选卡给警长；customsChecked lied=true", () => {
    const k = bootK();
    open(k, 0); // 人间当警长
    const bad = giveContraband(k, 1); // 假人偷渡者出门的货
    giveLegit(k, 1); // 罚没候选（出门后手里还剩 1 张）
    const id = ship(k, 1, bad, 2, "i04"); // 谎报为一正货名
    const before = {
      sheriff: hand0(k).length,
      sender: k.state.players[1]!.hand.length,
      total: k.state.players.reduce((n, p) => n + p.hand.length, 0),
    };
    expect(before.sender).toBe(1); // 出门后剩一张罚没候选
    const fx = k.apply({ type: "customsCheck", pid: 0, shipment: id }, 1_000);
    expect(fx.some((f) => f.type === "customsChecked" && f.pid === 0 && f.target === 1 && f.lied === true)).toBe(true);
    expect(msg(k, "报备的「治疗药水」是谎话")).toBe(true);
    expect(k.state.players[1]!.hand).toHaveLength(0); // 交 1 张（假人即时代选）
    expect(hand0(k).length).toBe(before.sheriff + 1); // 卡进警长（手牌→手牌）
    expect(k.state.players.reduce((n, p) => n + p.hand.length, 0)).toBe(before.total); // 单池守恒
    expect(k.state.customs!.checksLeft).toBe(CUSTOMS_CHECKS - 1);
    expect(k.state.customs!.shipments.find((s) => s.id === id)!.checked).toBe(true);
    expect(msg(k, "海关罚没")).toBe(true);
  });

  it("抓谎·无卡回退 3 格：被罚者手头无卡——按规矩退 3 步（沿来向）", () => {
    const k = bootK();
    open(k, 0);
    k.apply({ type: "dev.setPos", pid: 1, pos: PIN, from: PIN_FROM, net: 10 }, 0);
    const bad = giveContraband(k, 1);
    const id = ship(k, 1, bad, 2, "i04"); // 单卡出门=手牌空
    k.apply({ type: "customsCheck", pid: 0, shipment: id }, 1_000);
    expect(k.state.players[1]!.hand).toHaveLength(0);
    expect(k.state.players[1]!.walk?.remaining).toBe(-CUSTOMS_RETREAT);
    expect(msg(k, `手头无卡——按海关规矩回退 ${CUSTOMS_RETREAT} 格`)).toBe(true);
  });

  it("清白·警长反赔：查正货成单——警长挂账自选交卡（customsGive 落账，卡进报备人手里）", () => {
    const k = bootK();
    open(k, 0);
    const good = giveLegit(k, 2);
    const id = ship(k, 2, good, 1, good); // 如实报备（清白单）
    const before = {
      sheriff: hand0(k).length,
      sender: k.state.players[2]!.hand.length,
      total: k.state.players.reduce((n, p) => n + p.hand.length, 0),
    };
    const fx = k.apply({ type: "customsCheck", pid: 0, shipment: id }, 1_000);
    expect(fx.some((f) => f.type === "customsChecked" && f.pid === 0 && f.target === 2 && f.lied === false)).toBe(true);
    expect(msg(k, "报备清白")).toBe(true);
    const pend = k.state.customs!.pending!;
    expect(pend).toMatchObject({ from: 0, to: 2, reason: "clean" }); // 警长赔
    expect(pend.deadline).toBe(1_000 + k.config.routeAskMs);
    const pay = hand0(k)[0]!; // 人间警长自选
    k.apply({ type: "customsGive", pid: 0, cardId: pay }, 2_000);
    expect(k.state.customs!.pending).toBeNull();
    expect(k.state.players[2]!.hand).toContain(pay);
    expect(hand0(k).length).toBe(before.sheriff - 1);
    expect(k.state.players[2]!.hand.length).toBe(before.sender + 1);
    expect(k.state.players.reduce((n, p) => n + p.hand.length, 0)).toBe(before.total); // 单池守恒
    expect(msg(k, `交出「${ITEM_CARD_BY_ID.get(pay)!.title}」交给 小绿（海关赔账）`)).toBe(true);
  });

  it("清白·警长无卡回退 3 格：挂账不立、当场退 3 步", () => {
    const k = bootK();
    k.apply({ type: "dev.setPos", pid: 0, pos: PIN, from: PIN_FROM, net: 10 }, 0);
    k.state.itemDiscard.push(...hand0(k).splice(0)); // 警长手牌收回弃牌堆（单池守恒）
    open(k, 0);
    const good = giveLegit(k, 2);
    const id = ship(k, 2, good, 1, good);
    k.apply({ type: "customsCheck", pid: 0, shipment: id }, 1_000);
    expect(k.state.customs!.pending).toBeNull(); // 无卡=不立挂账
    expect(k.state.players[0]!.walk?.remaining).toBe(-CUSTOMS_RETREAT);
    expect(msg(k, `手头无卡——按海关规矩回退 ${CUSTOMS_RETREAT} 格`)).toBe(true);
  });

  it("罚没挂账超时：routeAskMs 到点系统代选（随机一张进对方；不阻塞）", () => {
    const k = bootK();
    open(k, 0);
    flushBotPlans(k); // 先出清假人排程（空手不出单）——本用例的货不给假人转手的机会
    const good = giveLegit(k, 2);
    const id = ship(k, 2, good, 1, good, 3_200);
    k.apply({ type: "customsCheck", pid: 0, shipment: id }, 3_300);
    const pend = k.state.customs!.pending!;
    expect(pend.deadline).toBe(3_300 + k.config.routeAskMs);
    const paid = hand0(k)[0]!;
    k.tick(pend.deadline + 1);
    expect(k.state.customs!.pending).toBeNull();
    expect(hand0(k)).not.toContain(paid); // 代选走真账：警长的卡进报备人手里
    expect(k.state.players[2]!.hand).toContain(paid);
    expect(msg(k, "系统替你 代选")).toBe(true);
  });

  it("挂账期间把仅剩的卡转走：到点复校=无卡回退 3 格（不崩账、不阻塞——review 真缺陷收口）", () => {
    const k = bootK({ windowMs: 60_000 });
    open(k, 0);
    flushBotPlans(k);
    const good = giveLegit(k, 2);
    const id = ship(k, 2, good, 1, good, 3_200);
    k.apply({ type: "customsCheck", pid: 0, shipment: id }, 3_300); // 清白单 → 警长（人间）挂账待赔
    k.apply({ type: "dev.setPos", pid: 0, pos: PIN, from: PIN_FROM, net: 10 }, 3_350); // 退格要有来向
    const pend = k.state.customs!.pending!;
    const only = hand0(k)[0]!;
    k.apply({ type: "customsShip", pid: 0, cardId: only, to: 3, declared: only }, 3_400); // 挂账期间把仅剩一张转走
    expect(hand0(k)).toHaveLength(0);
    const recvHandLen = k.state.players[2]!.hand.length;
    k.tick(pend.deadline + 1); // 到点代选：复校无卡 → 按规矩回退 3 格（旧账=splice 空手得 undefined 崩 tick）
    expect(k.state.customs!.pending).toBeNull();
    expect(hand0(k)).toHaveLength(0);
    expect(k.state.players[0]!.walk?.remaining).toBe(-CUSTOMS_RETREAT);
    expect(msg(k, `手头无卡——按海关规矩回退 ${CUSTOMS_RETREAT} 格`)).toBe(true);
    // 收方没被塞进坏账（旧账=undefined 入袋）——手牌只可能因假人走格自摸而增长、且每张都是真卡
    expect(k.state.players[2]!.hand.length).toBeGreaterThanOrEqual(recvHandLen);
    expect(k.state.players[2]!.hand.every((c: unknown) => typeof c === "string")).toBe(true);
    // 同口径的第二条崩溃路径（review 点名）：收窗兜底复校——窗照常收、回合钟照常走
    const k2 = bootK({ windowMs: 30_000 });
    k2.apply({ type: "dev.setPos", pid: 0, pos: PIN, from: PIN_FROM, net: 10 }, 0);
    k2.apply({ type: "dev.customs", sheriff: 0 }, 25_000);
    k2.tick(26_500); // 先出清假人排程（此刻全场无货=全空手，排程不出单）——防「收方转手」链事后补货
    const d1 = giveLegit(k2, 2);
    const id2 = ship(k2, 2, d1, 1, d1, 26_600);
    k2.apply({ type: "customsCheck", pid: 0, shipment: id2 }, 26_700); // 清白单 → 警长挂账（截止越窗尾）
    const only2 = hand0(k2)[0]!;
    k2.apply({ type: "customsShip", pid: 0, cardId: only2, to: 3, declared: only2 }, 26_800); // 挂账期间转走
    const fx2 = k2.tick(30_000); // 窗尾：收窗兜底代选
    expect(fx2.some((f) => f.type === "customsEnd")).toBe(true);
    expect(k2.state.customs).toBeNull();
    expect(k2.state.turn).toBe(2); // 回合钟没卡死（旧账=closeWindow 内抛错吞掉关窗）
    const p0 = k2.state.players[0]!; // 回退照布置（替掷的走格占用时入队，走完自然接——不打断操作）
    expect(p0.walk?.remaining === -CUSTOMS_RETREAT || p0.walkQueue.includes(-CUSTOMS_RETREAT)).toBe(true);
  });

  it("次数上限与查验闸：2 次用尽第 3 次拒；一单限查一次；自查拒；非警长拒", () => {
    const k = bootK();
    open(k, 0);
    const b1 = giveContraband(k, 1), b2 = giveContraband(k, 2), b3 = giveContraband(k, 3);
    const s1 = ship(k, 1, b1, 2, "i04"); // 一律谎报单：被抓=被判者即时代选交卡/无卡退格，不落 pending 挡下一查
    const s2 = ship(k, 2, b2, 1, "i04");
    const s3 = ship(k, 3, b3, 1, "i04");
    expect(() => k.apply({ type: "customsCheck", pid: 1, shipment: s3 }, 500)).toThrow(/只有警长/);
    k.apply({ type: "customsCheck", pid: 0, shipment: s1 }, 1_000);
    k.apply({ type: "customsCheck", pid: 0, shipment: s2 }, 2_000);
    expect(k.state.customs!.checksLeft).toBe(0);
    expect(() => k.apply({ type: "customsCheck", pid: 0, shipment: s3 }, 3_000)).toThrow(/查验次数已用尽/);
    expect(k.state.customs!.shipments.find((s) => s.id === s3)!.checked).toBe(false); // 余单未动
    // 一单限查一次 + 自查拒（另开一窗单独立账）
    const k2 = bootK();
    open(k2, 0);
    const c1 = giveLegit(k2, 1);
    const cSelf = giveLegit(k2, 0);
    const t1 = ship(k2, 1, c1, 2, c1);
    const sSelf = ship(k2, 0, cSelf, 1, cSelf); // 警长自己运合法货——自查拒
    expect(() => k2.apply({ type: "customsCheck", pid: 0, shipment: sSelf }, 1_000)).toThrow(/不能查验自己经手的报备/);
    k2.apply({ type: "customsCheck", pid: 0, shipment: t1 }, 1_000);
    expect(() => k2.apply({ type: "customsCheck", pid: 0, shipment: t1 }, 2_000)).toThrow(/已经查过了/);
  });

  it("挂账未了结前不再查验；报备人离场单查不着", () => {
    const k = bootK();
    open(k, 0);
    const g1 = giveLegit(k, 1), g2 = giveLegit(k, 2);
    const s1 = ship(k, 1, g1, 2, g1);
    const s2 = ship(k, 2, g2, 1, g2);
    k.apply({ type: "customsCheck", pid: 0, shipment: s1 }, 1_000); // 清白单 → 人间警长挂账待赔
    expect(k.state.customs!.pending).not.toBeNull();
    expect(() => k.apply({ type: "customsCheck", pid: 0, shipment: s2 }, 2_000)).toThrow(/罚没了结/);
    k.apply({ type: "customsGive", pid: 0, cardId: giveLegit(k, 0) }, 3_000); // 先了结（真账交一张）
    expect(k.state.customs!.pending).toBeNull();
    k.apply({ type: "dev.setDead", pid: 2 }, 3_100);
    expect(() => k.apply({ type: "customsCheck", pid: 0, shipment: s2 }, 4_000)).toThrow(/报备人已不在对局/);
  });
});

describe("海关风云 · 退化与假人行为（状态机·退化）", () => {
  it("警长超时不查：到点退化为自由转让（播报）；退化后查验拒、转让照常", () => {
    const k = bootK({ windowMs: 60_000 });
    open(k, 0);
    flushBotPlans(k); // 先出清假人排程（空手不出单）
    k.tick(CUSTOMS_CHECK_MS + 1);
    expect(k.state.customs!.degraded).toBe(true);
    expect(msg(k, "迟迟没查验——本窗退化为自由转让")).toBe(true);
    const g = giveLegit(k, 1);
    const sid = ship(k, 1, g, 2, g, CUSTOMS_CHECK_MS + 2); // 转让照常
    expect(() => k.apply({ type: "customsCheck", pid: 0, shipment: sid }, CUSTOMS_CHECK_MS + 3)).toThrow(/已撤岗/);
    expect(k.state.customs!.shipments).toHaveLength(1);
  });

  it("超时后再点查验=先撤岗再拒（懒退化：时钟过了没 tick 也不算漏网）", () => {
    const k = bootK({ windowMs: 60_000 });
    open(k, 0);
    const g = giveLegit(k, 1);
    const sid = ship(k, 1, g, 2, g);
    expect(() => k.apply({ type: "customsCheck", pid: 0, shipment: sid }, CUSTOMS_CHECK_MS + 1)).toThrow(/已撤岗/);
    expect(k.state.customs!.degraded).toBe(true);
  });

  it("每查一次续期：首查续 15s——过了首查截止时点第二查仍可落（未退化）", () => {
    const k = bootK({ windowMs: 90_000 });
    open(k, 0);
    flushBotPlans(k); // 先出清假人排程（空手不出单）
    const g1 = giveLegit(k, 1), g2 = giveLegit(k, 2);
    const s1 = ship(k, 1, g1, 2, g1, 3_200);
    const s2 = ship(k, 2, g2, 1, g2, 3_300);
    k.apply({ type: "customsCheck", pid: 0, shipment: s1 }, 3_400);
    expect(k.state.customs!.checkDeadline).toBe(3_400 + CUSTOMS_CHECK_MS); // 15s 起算窗+15s=18.4s
    k.tick(17_000); // 已过「开窗+15s」（15s）、未到续期截止（18.4s）——未退化
    expect(k.state.customs!.degraded).toBe(false);
    k.apply({ type: "customsCheck", pid: 0, shipment: s2 }, 17_100); // 第二查落在续期窗内
    expect(k.state.customs!.checksLeft).toBe(0);
  });

  it("假警长：开窗即退化（不查验）+ 查验拒", () => {
    const k = bootK();
    open(k, 1);
    expect(k.state.customs!.degraded).toBe(true);
    expect(msg(k, "小黄（系统）摆摆手不打算查验")).toBe(true);
    const g = giveLegit(k, 2);
    const sid = ship(k, 2, g, 3, g);
    expect(() => k.apply({ type: "customsCheck", pid: 1, shipment: sid }, 1_000)).toThrow(/只有警长|已撤岗/);
  });

  it("警长离场（淘汰）→ 退化出声（绝不阻塞）", () => {
    const k = bootK({ windowMs: 60_000 });
    open(k, 0);
    k.apply({ type: "dev.setDead", pid: 0 }, 100);
    k.tick(200);
    expect(k.state.customs!.degraded).toBe(true);
    expect(msg(k, "警长 你 已不在对局——本窗退化为自由转让")).toBe(true);
  });

  it("假偷渡者规则化报备：到点自动运 1 张（正货如实报、违禁品谎报为随机正货名），排程一出一", () => {
    // A：违禁品出门=谎报（假人规则）；转手链（收方再运）同样受规则约束
    const ka = bootK();
    freezeBots(ka); // 走格随机流冻结——假人手牌只含测试注入的卡与转手所得
    open(ka, 0);
    const bad = giveContraband(ka, 1);
    ka.tick(3_100); // 排程拍（开窗后 1–3s）全到点（首个执行=pid 1 的排程）
    const sa = ka.state.customs!.shipments;
    expect(sa.length).toBeGreaterThanOrEqual(1);
    expect(sa[0]).toMatchObject({ from: 1, cardId: bad });
    expect(sa[0]!.declared).not.toBe(bad); // 违禁必谎报
    for (const s of sa) {
      expect(ITEM_CARD_BY_ID.get(s.declared)!.contraband).toBeUndefined(); // 报备名一律正货（明面校验）
      const card = ITEM_CARD_BY_ID.get(s.cardId)!;
      if (card.contraband) expect(s.declared).not.toBe(s.cardId);
    }
    const n = sa.length;
    ka.tick(5_000); // 已出队的排程不再重试
    expect(ka.state.customs!.shipments).toHaveLength(n);
    // B：正货出门=如实报
    const kb = bootK();
    freezeBots(kb);
    open(kb, 0);
    const good = giveLegit(kb, 1);
    kb.tick(3_100);
    expect(kb.state.customs!.shipments[0]).toMatchObject({ from: 1, cardId: good, declared: good });
  });
});

describe("海关风云 · 收窗与兜底（状态机·关闭）", () => {
  it("收窗即散：世界窗收口 → customs=null + customsEnd；未了的挂账收窗代选落账（绝不阻塞）", () => {
    const k = bootK({ windowMs: 30_000 });
    k.apply({ type: "dev.customs", sheriff: 0 }, 25_000); // 晚开窗：挂账截止越世界窗尾（收窗兜底路径）
    k.tick(28_500); // 出清假人排程（空手不出单——防「收方转手」链污染账目）
    const good = giveLegit(k, 2);
    const id = ship(k, 2, good, 1, good, 28_600);
    k.apply({ type: "customsCheck", pid: 0, shipment: id }, 28_700); // 清白单 → 警长挂账（deadline 38_700 > 窗尾）
    expect(k.state.customs!.pending).not.toBeNull();
    const paid = hand0(k)[0]!;
    const before = hand0(k).length;
    const fx = k.tick(30_000); // 窗尾收口
    expect(fx.some((f) => f.type === "customsEnd")).toBe(true);
    expect(k.state.customs).toBeNull();
    expect(msg(k, "海关风云散去")).toBe(true);
    expect(msg(k, "系统替你 代选")).toBe(true); // 收窗兜底代选（绝不阻塞）
    expect(k.state.players[2]!.hand).toContain(paid); // 赔偿照落账（赔给报备人=pid 2）
    expect(hand0(k).length).toBe(before - 1);
  });

  it("死了就死了：挂账方淘汰 → 罚没作罢（出声、不阻塞）", () => {
    const k = bootK({ windowMs: 60_000 });
    open(k, 0);
    const good = giveLegit(k, 2);
    const id = ship(k, 2, good, 1, good);
    k.apply({ type: "customsCheck", pid: 0, shipment: id }, 1_000); // 清白单 → 警长挂账
    expect(k.state.customs!.pending).not.toBeNull();
    k.apply({ type: "dev.setDead", pid: 2 }, 2_000); // 收方（报备人）出局
    expect(k.state.customs!.pending).toBeNull();
    expect(msg(k, "海关罚没作罢——小绿 已不在对局")).toBe(true);
  });
});
