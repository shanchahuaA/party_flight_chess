import { GAME_DEFAULTS, GameKernel } from "../src";
import type { Fact, GameConfig, PlayerState } from "../src";
import { cellAt } from "../src";

/** 开局暗牌抽 2 选 1（boot 默认替真人选第 0 条；泛用） */
export function openGame(k: GameKernel, pick = 0): void {
  k.apply({ type: "chooseSecret", pid: 0, pick }, 0);
}

/** 建一局（dev 通道开，时钟从 0 起；自动完成开局抽牌进第一窗） */
export function boot(over: Partial<GameConfig> = {}, now = 0): GameKernel {
  const { kernel } = GameKernel.create({ allowDev: true, ...over }, now);
  openGame(kernel);
  return kernel;
}

/** 搜种子：使人间（pid 0，可选先 setPos）首掷恰好为 target 面的种子 */
export function seedForFirstDie(target: number, pre: { pos: number; from: number | null; net: number } | null = null): number {
  for (let seed = 1; seed < 5000; seed++) {
    const k = GameKernel.create({ seed, allowDev: true }, 0).kernel;
    openGame(k);
    if (pre) k.apply({ type: "dev.setPos", pid: 0, pos: pre.pos, from: pre.from, net: pre.net }, 0);
    const fx = k.apply({ type: "roll", pid: 0 }, 0);
    const roll = fx.find((f) => f.type === "roll" && f.pid === 0);
    if (roll && roll.type === "roll" && roll.d === target) return seed;
  }
  throw new Error(`找不到首掷为 ${target} 的种子（1..4999）`);
}

/**
 * 搜种子：跑一段完全确定的意图/时钟脚本，人间各次掷面依次命中 targets。
 * 脚本必须对任意种子都合法执行完成（选路请选固定项）。
 */
export function seedForScript(script: (k: GameKernel) => number[], targets: number[]): number {
  for (let seed = 1; seed < 5000; seed++) {
    try {
      const k = boot({ seed });
      const faces = script(k);
      if (faces.length === targets.length && faces.every((f, i) => f === targets[i])) return seed;
    } catch {
      // 该种子下脚本中断（不应发生：脚本需全种子安全），换下一粒
    }
  }
  throw new Error(`找不到骰面流为 [${targets.join(",")}] 的种子（1..4999）`);
}

/**
 * 会造成位移的事件卡清单（抽卡必先播「踩上事件格，抽到「卡名」」——按卡名探测）。
 * 用途：机械走格测试搜种子时排除它们；其余卡抽到也不动位置（默认位=无事/摸道具/扣血/罚停）。
 */
export const DRAW_MOVE_TITLES: readonly string[] = [
  "断桥",
  "醉酒的守卫",
  "岔路口·宝箱与陷阱",
  "岔路口·近路与远路",
  "一路顺风",
  "全员拜年",
  "全员大扫除",
  "庄园鼠横行",
];

/**
 * 搜种子：同 seedForScript，外加事件卡约束（T3a 起走停即抽）。
 * banTitles 给出 → 允许安全卡，只排除位移卡（抽到也不会改停位——断言可保持机械语义）；
 * 不给 → 全程零事件抽卡（最严档）。极值/检定路径另在 events.test 用 dev 通道精确驱动。
 */
export function seedForScriptNoDraws(
  script: (k: GameKernel) => number[],
  targets: number[],
  banTitles?: readonly string[],
): number {
  for (let seed = 1; seed < 5000; seed++) {
    try {
      const k = boot({ seed });
      const before = k.state.messages.length;
      const faces = script(k);
      const drewTitles = k.state.messages
        .slice(before)
        .map((m) => /踩上事件格，抽到「(.+?)」/.exec(m.text)?.[1])
        .filter((t): t is string => !!t);
      const okDraws = banTitles ? drewTitles.every((t) => !banTitles.includes(t)) : drewTitles.length === 0;
      if (okDraws && faces.length === targets.length && faces.every((f, i) => f === targets[i])) return seed;
    } catch {
      // 该种子下脚本中断（含抽到卡后挂起闸拒绝原路径），换下一粒
    }
  }
  throw new Error(`找不到骰面流为 [${targets.join(",")}] 且${banTitles ? "零位移卡" : "零事件抽卡"}的种子（1..4999）`);
}

/** 建"骰面流 = targets 且满足事件卡约束"的新盘（脚本按同样时序重放） */
export function bootWithDiesPure(
  script: (k: GameKernel) => number[],
  targets: number[],
  over: Partial<GameConfig> = {},
  banTitles?: readonly string[],
): GameKernel {
  return boot({ ...over, seed: seedForScriptNoDraws(script, targets, banTitles) });
}

/** 建"人间首掷面 = target"的一局（含 setPos 回放） */
export function bootWithDie(target: number, pre: { pos: number; from: number | null; net: number } | null = null, over: Partial<GameConfig> = {}): GameKernel {
  const k = boot({ ...over, seed: seedForFirstDie(target, pre) });
  if (pre) k.apply({ type: "dev.setPos", pid: 0, pos: pre.pos, from: pre.from, net: pre.net }, 0);
  return k;
}

/** 建"人间骰面流 = targets"的一局（返回未执行脚本的新盘——测试自己按同脚本重放并断言） */
export function bootWithDies(
  script: (k: GameKernel) => number[],
  targets: number[],
  over: Partial<GameConfig> = {},
): GameKernel {
  for (let seed = 1; seed < 5000; seed++) {
    try {
      const k = boot({ seed });
      const faces = script(k);
      if (faces.length === targets.length && faces.every((f, i) => f === targets[i])) {
        return boot({ ...over, seed });
      }
    } catch {
      // 该种子下脚本中断，换下一粒
    }
  }
  throw new Error(`找不到骰面流为 [${targets.join(",")}] 的种子（1..4999）`);
}

/** 步进走完当前 walk（按时钟一格一格推，返回全部事实） */
export function walkOut(k: GameKernel, now: number, extraTicks = 0): Fact[] {
  const all: Fact[] = [];
  let t = now;
  const step = GAME_DEFAULTS.stepMs;
  for (let i = 0; i < 80; i++) {
    t += extraTicks + step;
    if (!k.state.players.some((p) => p.walk)) break;
    all.push(...k.tick(t));
  }
  return all;
}

/** 读人间某次事实里的掷面 */
export const dieOf = (fx: Fact[], pid = 0): number => {
  const r = fx.find((f) => f.type === "roll" && f.pid === pid);
  if (!r || r.type !== "roll") throw new Error("没有掷骰事实");
  return r.d;
};

/** 跨窗流程：把当前窗推到替掷收口并开下一窗（返回下一窗起始时刻） */
export function toNextWindow(k: GameKernel, now: number, windowMs: number, restMs: number): number {
  k.tick(now + windowMs);
  k.tick(now + windowMs + restMs);
  return now + windowMs + restMs;
}

export const me = (k: GameKernel): PlayerState => k.state.players[0]!;

/** 条件注入道具（给不进时返回 false——开局手牌+1 可能把目标卡先摸走了；hp.test/traps.test 共用，不耗随机流） */
export const tryGiveItem = (k: GameKernel, pid: number, cardId: string, now: number): boolean => {
  if (k.state.players[pid]!.hand.includes(cardId)) return true;
  try {
    k.apply({ type: "dev.giveItem", pid, cardId }, now);
    return true;
  } catch {
    return false;
  }
};

/** 常用格 id 助记 */
export const cell = (c: number, r: number) => {
  const n = cellAt(c, r);
  if (!n) throw new Error(`格 (${c},${r}) 不存在`);
  return n.id;
};
