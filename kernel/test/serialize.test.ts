/**
 * 内核序列化缝（#38 M2-T1，Spec #37 实现决策 6＝M2 唯一内核改动）：
 * - 往返等价：save→load→继续同一段意图/时钟序列 = 不落盘直跑的同一终态与事实流；
 *   相位取样：drafting 抽牌期／acting 常规对局中段（野狗发号续走）／海关风云中段（报备单号续走）／
 *   年兽战期／结算后（over）／轮班·限时中段（turnActor 域）。
 * - GameState 纯数据校验：无函数/类实例/循环引用/非有限数残留，JSON 往返无损。
 * - 存档隔离：save() 给快照拷贝、load() 深拷贝接管，调用方改存档不渗进内核；残缺存档拒收（KernelError）。
 *
 * 确定性纪律：不用 freezeBots（rollAt=∞ 不是 JSON 可序列化值——内核因此把 confirmAt 哨兵改成 null 口径，
 * 源头不写非有限数）；驱动脚本只读 state 决策（无 Math.random/挂钟），同脚本喂复局盘与直跑盘=行为必然逐拍可比。
 */
import { describe, expect, it } from "vitest";
import { GameKernel, KernelError, LEGIT_ITEM_CARDS } from "../src";
import type { Fact, GameConfig, GameState, PlayerDef } from "../src";
import { boot, cell, factTee, tryGiveItem } from "./helpers";

// ---------- 驱动器（读 state 决策、无随机；KernelError 业务拒绝吞掉，其余原样抛） ----------

const swallow = (e: unknown): void => {
  if (!(e instanceof KernelError)) throw e;
};

/** 一拍行动：人间按「应答抉择→选路→掷→确认」顺序出手（年兽战波窗改砍年兽）；拒绝=等替掷兜住 */
function actOnce(k: GameKernel, t: number): void {
  if (k.state.phase !== "acting") return;
  const p = k.state.players[0]!;
  if (k.state.endgame?.beast != null) {
    try {
      k.apply({ type: "strike", pid: 0 }, t);
    } catch (e) {
      swallow(e); // 本波已砍/不在名册
    }
    return;
  }
  if (p.cardPending) {
    try {
      k.apply({ type: "chooseCard", pid: 0, option: 0 }, t);
    } catch (e) {
      swallow(e);
    }
    return;
  }
  if (p.walk?.ask) {
    try {
      k.apply({ type: "chooseRoute", pid: 0, option: 0 }, t);
    } catch (e) {
      swallow(e);
    }
    return;
  }
  if (p.dead || p.zone === "done") return;
  if (!p.rolled) {
    try {
      k.apply({ type: "roll", pid: 0 }, t);
    } catch (e) {
      swallow(e); // 轮班没到棒/已替掷
    }
    return;
  }
  if (!p.confirmed) {
    try {
      k.apply({ type: "confirm", pid: 0 }, t);
    } catch (e) {
      swallow(e);
    }
  }
}

/** 时钟驱动：1s 步进 tick+出手，直到 stop 命中或 900s 预算耗尽；返回全程事实流 */
function drive(k: GameKernel, t0: number, stop: (k: GameKernel, t: number) => boolean): Fact[] {
  const { k: tee, facts } = factTee(k);
  let t = t0;
  while (!stop(tee, t) && t <= t0 + 900_000) {
    t += 1_000;
    tee.tick(t);
    actOnce(tee, t);
  }
  return facts;
}

const toOver = (k: GameKernel): boolean => k.state.phase === "over";

// ---------- 往返等价脚手架 ----------

/** 存档分叉：save→load 建复局盘；断言复局盘立即 save 与存档一致（复局即所见） */
function forkAt(a: GameKernel): { b: GameKernel; snap: GameState } {
  const snap = a.save();
  const b = GameKernel.load(a.config, snap);
  expect(b.save()).toEqual(snap);
  return { b, snap };
}

/** 同段意图序列双跑：A 直跑 vs B 复局跑——事实流与终态全等，终态再 save 一次 JSON 字符串级全等 */
function expectSameRun(a: GameKernel, b: GameKernel, script: (k: GameKernel) => Fact[]): void {
  const fxA = script(a);
  const fxB = script(b);
  expect(fxB).toEqual(fxA);
  expect(b.state).toEqual(a.state);
  expect(JSON.stringify(b.save())).toBe(JSON.stringify(a.save()));
}

// ---------- 纯数据校验 ----------

/** 深扫：只许 string/有限 number/boolean/null/纯对象/数组——函数/undefined/symbol/bigint/类实例/循环引用都是残留。
 *  （快照先过 JSON.stringify：∞/NaN 已折 null，扫描盯不住它们——非有限数的真防线=内核源头不写（confirmAt
 *  哨兵已改 null 口径）+ 往返等价双跑（∞ 与折损后的 null 行为必漂移）兜底。） */
function purity(v: unknown, path: string, seen: Set<object>): void {
  if (v === null) return;
  const t = typeof v;
  if (t === "string" || t === "boolean") return;
  if (t === "number") {
    if (!Number.isFinite(v as number)) throw new Error(`${path}: 非有限数（${String(v)}）残留`);
    return;
  }
  if (t !== "object") throw new Error(`${path}: 序列化不纯（${t}）——函数/undefined/symbol/bigint 残留`);
  const o = v as object;
  if (seen.has(o)) throw new Error(`${path}: 循环引用`);
  seen.add(o);
  const proto = Object.getPrototypeOf(o);
  if (proto !== Object.prototype && proto !== Array.prototype) {
    throw new Error(`${path}: 非纯对象/数组（原型 ${proto?.constructor?.name ?? "未知"}）——类实例/Map/Set/Date 残留`);
  }
  for (const [key, val] of Object.entries(o)) purity(val, `${path}.${key}`, seen);
}

const scanPure = (snap: GameState): void => purity(snap, "state", new Set<object>());

// ---------- 相位取样共用盘 ----------

/** 年兽战 crew（beast.test 同款）：人间 + 3 假人全员 light（无开局盾、假人波内自砍） */
const CREW: PlayerDef[] = [
  { name: "你", isBot: false, roleId: "light" },
  { name: "阿二", isBot: true, roleId: "light" },
  { name: "阿三", isBot: true, roleId: "light" },
  { name: "阿四", isBot: true, roleId: "light" },
];

/** 凝滞世界打进年兽战（windowMs 5——走格节拍永远赶不上一窗）：常规 15 窗推完、第 1 波开张 */
function bootFight(): { k: GameKernel; now: number } {
  const { kernel } = GameKernel.create({ allowDev: true, seed: 7, maliceLevel: "off", windowMs: 5, restMs: 0 }, 0, CREW);
  kernel.apply({ type: "chooseSecret", pid: 0, pick: 0 }, 0);
  let now = 0;
  for (let i = 0; i < 15; i++) {
    now = Math.max(kernel.state.windowDeadline, kernel.state.restUntil) + 1;
    kernel.tick(now);
  }
  expect(kernel.state.endgame?.beast != null).toBe(true);
  return { k: kernel, now };
}

describe("save/load 往返等价（同段意图序列=同一终态与事实流）", () => {
  it("drafting 抽牌期：选暗牌开局后全速推进到结算，与直跑全等", () => {
    const { kernel } = GameKernel.create({ seed: 7, allowDev: true }, 0);
    expect(kernel.state.phase).toBe("drafting");
    const { b, snap } = forkAt(kernel);
    scanPure(snap);
    expect(snap.phase).toBe("drafting");

    const cont = (k: GameKernel): Fact[] => {
      const out = k.apply({ type: "chooseSecret", pid: 0, pick: 0 }, 10_000);
      return [...out, ...drive(k, 10_000, toOver)];
    };
    expectSameRun(kernel, b, cont);
    expect(b.state.phase).toBe("over");
  });

  it("acting 中段（世界·即时+温和恶意）：野狗发号续走不重号，推到结算全等", () => {
    const a = boot({ seed: 7 }); // 恶意默认 mild——野狗/滚石/塌陷的世界流照常转
    drive(a, 0, (k, t) => t >= 150_000 && k.state.phase === "acting"); // 推进到中段（约第 4 世界回合）
    const { b, snap } = forkAt(a);
    scanPure(snap);
    expect(snap.phase).toBe("acting");

    const cont = (k: GameKernel): Fact[] => {
      const out = k.apply({ type: "dev.spawnDog", cell: cell(6, 0) }, 150_000); // 复局盘先试发号
      return [...out, ...drive(k, 150_000, toOver)];
    };
    expectSameRun(a, b, cont);
    // 狗 id 续走：复局后新发的号接着存档里的最大号走，绝不重号；名册内 id 两盘一致且唯一
    expect(b.state.dogSeq).toBe(a.state.dogSeq);
    expect(b.state.dogSeq).toBeGreaterThan(snap.dogSeq);
    const ids = b.state.malice.dogs.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("海关风云中段：报备单号续走不重号，收窗后推到结算全等", () => {
    const a = boot({ seed: 42 });
    a.apply({ type: "dev.customs", sheriff: 1 }, 1_000); // 假人当警长（确定性钉位）
    for (const c of LEGIT_ITEM_CARDS) {
      if (a.state.players[0]!.hand.length >= 2) break;
      tryGiveItem(a, 0, c.id, 1_000);
    }
    const first = a.state.players[0]!.hand[0]!;
    a.apply({ type: "customsShip", pid: 0, cardId: first, to: 2, declared: first }, 1_000);
    expect(a.state.customs?.shipments.length).toBe(1);

    const { b, snap } = forkAt(a);
    scanPure(snap);
    expect(snap.customs?.shipments.length).toBe(1);

    const cont = (k: GameKernel): Fact[] => {
      const second = k.state.players[0]!.hand[0]!; // 首单已离手，余牌必是另一张（单池守恒：手牌无重 id）
      const out = k.apply({ type: "customsShip", pid: 0, cardId: second, to: 2, declared: second }, 1_000);
      return [...out, ...drive(k, 1_000, toOver)];
    };
    expectSameRun(a, b, cont);
    // 单号续走：复局后第二单接着首单的号发（存档前=1，复局新发=2）
    expect(b.state.customsSeq).toBe(a.state.customsSeq);
    expect(b.state.customsSeq).toBeGreaterThan(snap.customsSeq);
  });

  it("年兽战期：波窗推进到收束结算（settlement 全量），与直跑全等", () => {
    const { k: a, now } = bootFight();
    const { b, snap } = forkAt(a);
    scanPure(snap);
    expect(snap.endgame?.beast?.wave).toBe(1);

    expectSameRun(a, b, (k) => drive(k, now, toOver));
    expect(a.state.phase).toBe("over");
    expect(a.state.endgame?.settlement).toBeDefined();
  });

  it("结算后（over）：存档复局继续 tick 静默无事实，终态全等", () => {
    const { k: a, now } = bootFight();
    drive(a, now, toOver);
    expect(a.state.phase).toBe("over");
    const settled = a.state.endgame!.settlement!;

    const { b, snap } = forkAt(a);
    scanPure(snap);
    expect(snap.endgame?.settlement).toEqual(settled);

    const cont = (k: GameKernel): Fact[] => {
      const { k: tee, facts } = factTee(k);
      tee.tick(now + 1_000);
      tee.tick(now + 2_000);
      return facts;
    };
    expectSameRun(a, b, cont);
    expect(b.state.endgame?.settlement).toEqual(settled);
  });

  it("轮班·限时中段（turnActor 域）：推进到结算全等", () => {
    const a = boot({ seed: 7, timerMode: "turn", windowMs: 3_000, restMs: 500 });
    drive(a, 0, (k, t) => t >= 60_000 && k.state.phase === "acting"); // 中段停棒（行动者在位）
    const { b, snap } = forkAt(a);
    scanPure(snap);
    expect(snap.phase).toBe("acting");

    expectSameRun(a, b, (k) => drive(k, 60_000, toOver));
    expect(b.state.phase).toBe("over");
  });
});

describe("GameState 序列化纯数据校验（JSON 往返无损）", () => {
  it("各相位快照 JSON 往返无损（drafting/acting/年兽/over）", () => {
    const drafts: Array<[string, GameState]> = [];
    const fresh = GameKernel.create({ seed: 7, allowDev: true }, 0).kernel;
    drafts.push(["drafting", fresh.save()]);

    const mid = boot({ seed: 7 });
    drive(mid, 0, (k, t) => t >= 150_000 && k.state.phase === "acting");
    drafts.push(["acting", mid.save()]);

    const fight = bootFight();
    drive(fight.k, fight.now, (k, t) => k.state.endgame?.beast?.wave === 2); // 打到第 2 波（战中期）
    drafts.push(["beast", fight.k.save()]);

    const done = bootFight();
    drive(done.k, done.now, toOver);
    drafts.push(["over", done.k.save()]);

    for (const [name, snap] of drafts) {
      scanPure(snap); // 无函数/类实例/循环引用/非有限数
      expect(JSON.parse(JSON.stringify(snap)), `${name} 相位 JSON 往返无损`).toEqual(snap);
    }
  });

  it("save() 返回拷贝：改快照不渗回权威态", () => {
    const a = boot({ seed: 7 });
    const before = JSON.stringify(a.save());
    const snap = a.save();
    snap.turn = 999;
    snap.players[0]!.hp = 999;
    expect(JSON.stringify(a.save())).toBe(before);
  });

  it("load() 深拷贝接管：load 之后改存档对象不渗进复局盘", () => {
    const a = boot({ seed: 7 });
    const snap = a.save();
    const b = GameKernel.load(a.config, snap);
    const hp = b.state.players[0]!.hp;
    snap.players[0]!.hp = 999;
    snap.messages.push({ id: 99999, turn: 1, kind: "system", text: "伪造", emphasis: "normal" });
    expect(b.state.players[0]!.hp).toBe(hp);
    expect(b.state.messages.some((m) => m.id === 99999)).toBe(false);
  });

  it("残缺存档拒收（KernelError）：无名册／RNG 流缺失／内部发号缺失", () => {
    const a = boot({ seed: 7 });
    const cfg: GameConfig = a.config;
    expect(() => GameKernel.load(cfg, {} as unknown as GameState)).toThrow(KernelError);
    expect(() => GameKernel.load(cfg, { players: [] } as unknown as GameState)).toThrow(KernelError);
    expect(() =>
      GameKernel.load(cfg, { players: a.state.players, rngStates: undefined } as unknown as GameState),
    ).toThrow(KernelError);
    expect(() =>
      GameKernel.load(cfg, { players: a.state.players, rngStates: a.state.rngStates } as unknown as GameState),
    ).toThrow(KernelError); // 缺 seq/dogSeq/customsSeq——静默 NaN 发号比拒收恶劣
  });
});
