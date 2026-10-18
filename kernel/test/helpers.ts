import { GAME_DEFAULTS, GameKernel, KernelError } from "../src";
import type { Fact, GameConfig, PlayerState } from "../src";
import { DISPLACING_EVENT_IDS } from "../src";
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

/**
 * 事实收集器：把 k 的 apply/tick 返回事实汇进一个数组（代理转发，脚本无感）。
 * 搜种子的约束一律读这里头的事实（cardDrawn 等），**禁止解析战报中文文案**——文案会改，事实是协议。
 */
function factTee(k: GameKernel): { k: GameKernel; facts: Fact[] } {
  const facts: Fact[] = [];
  const proxy = new Proxy(k, {
    get(target, prop) {
      if (prop === "apply" || prop === "tick") {
        return (...args: unknown[]) => {
          const fx = (target[prop as "apply" | "tick"] as (...a: unknown[]) => Fact[])(...args);
          facts.push(...fx);
          return fx;
        };
      }
      return Reflect.get(target, prop, target);
    },
  }) as GameKernel;
  return { k: proxy, facts };
}

/** 搜种子 catch 纪律（T1..T8a2 回顾定案）：只吞 KernelError（业务拒绝=换种子），其余异常原样抛
 *  ——内核真缺陷绝不允许伪装成「没搜到种子」（T8a1 教训：吞掉的运行时炸被误读成概率问题）。 */
function swallowKernelRejection(e: unknown): void {
  if (!(e instanceof KernelError)) throw e;
}

/**
 * 种子搜索纪律（同上）：搜索约束必须机械可判定（读结构化事实/状态），
 * 禁止解析战报文案（T3b 教训：改播报措辞即碎）；脚本须对任意种子合法（选路选固定项）。
 */

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

/** 搜种子：跑一段完全确定的意图/时钟脚本，人间各次掷面依次命中 targets */
export function seedForScript(script: (k: GameKernel) => number[], targets: number[]): number {
  for (let seed = 1; seed < 5000; seed++) {
    try {
      const k = boot({ seed });
      const faces = script(k);
      if (faces.length === targets.length && faces.every((f, i) => f === targets[i])) return seed;
    } catch (e) {
      swallowKernelRejection(e);
      continue; // 该种子下脚本被业务规则拒绝，换下一粒
    }
  }
  throw new Error(`找不到骰面流为 [${targets.join(",")}] 的种子（1..4999）`);
}

/**
 * 搜种子：同 seedForScript，外加事件卡约束（T3a 起走停即抽）。
 * banIds 给出 → 允许安全卡，只排除位移卡（DISPLACING_EVENT_IDS，数据深扫派生——抽到也不改停位，
 * 断言可保持机械语义）；不给 → 全程零事件抽卡（最严档）。极值/检定路径另在 events.test 用 dev 通道精确驱动。
 */
export function seedForScriptNoDraws(
  script: (k: GameKernel) => number[],
  targets: number[],
  banIds?: readonly string[],
): number {
  for (let seed = 1; seed < 5000; seed++) {
    const { k, facts } = factTee(boot({ seed }));
    try {
      const faces = script(k);
      const drewIds = facts.filter((f) => f.type === "cardDrawn").map((f) => (f.type === "cardDrawn" ? f.cardId : ""));
      const okDraws = banIds ? drewIds.every((id) => !banIds.includes(id)) : drewIds.length === 0;
      if (okDraws && faces.length === targets.length && faces.every((f, i) => f === targets[i])) return seed;
    } catch (e) {
      swallowKernelRejection(e);
      continue; // 该种子下脚本被业务规则拒绝（含抽到卡后挂起闸拒绝原路径），换下一粒
    }
  }
  throw new Error(`找不到骰面流为 [${targets.join(",")}] 且${banIds ? "零位移卡" : "零事件抽卡"}的种子（1..4999）`);
}

/** 建"骰面流 = targets 且满足事件卡约束"的新盘（脚本按同样时序重放） */
export function bootWithDiesPure(
  script: (k: GameKernel) => number[],
  targets: number[],
  over: Partial<GameConfig> = {},
  banIds?: readonly string[],
): GameKernel {
  return boot({ ...over, seed: seedForScriptNoDraws(script, targets, banIds) });
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
      const { k } = factTee(boot({ seed }));
      const faces = script(k);
      if (faces.length === targets.length && faces.every((f, i) => f === targets[i])) {
        return boot({ ...over, seed });
      }
    } catch (e) {
      swallowKernelRejection(e);
      continue; // 该种子下脚本被业务规则拒绝，换下一粒
    }
  }
  throw new Error(`找不到骰面流为 [${targets.join(",")}] 的种子（1..4999）`);
}

/** 会造成位移的事件卡 id 清单（数据深扫派生，见 data/events.ts DISPLACING_EVENT_IDS——搜种子排除域用） */
export const DRAW_MOVE_IDS: readonly string[] = DISPLACING_EVENT_IDS;

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

/** 快进 n 个世界回合（windowMs:0 局专用——每次 tick 替掷收上一窗、立即开下一窗，一 tick 一回合）。
 *  时刻链在「当前窗 deadline+1 起」联合编码：内核时间必须单调，重复调用不倒退（测试时序铁律）。 */
export function advanceWorldTurns(k: GameKernel, n: number): number {
  let now = Math.max(k.state.windowDeadline, k.state.restUntil) + 1;
  for (let i = 0; i < n; i++, now++) k.tick(now);
  return now;
}

export const me = (k: GameKernel): PlayerState => k.state.players[0]!;

/** 条件注入道具（给不进时返回 false——开局手牌+1 可能把目标卡先摸走了；hp.test/traps.test 共用，不耗随机流） */
export const tryGiveItem = (k: GameKernel, pid: number, cardId: string, now: number): boolean => {
  if (k.state.players[pid]!.hand.includes(cardId)) return true;
  try {
    k.apply({ type: "dev.giveItem", pid, cardId }, now);
    return true;
  } catch (e) {
    swallowKernelRejection(e);
    return false;
  }
};

/** 常用格 id 助记 */
export const cell = (c: number, r: number) => {
  const n = cellAt(c, r);
  if (!n) throw new Error(`格 (${c},${r}) 不存在`);
  return n.id;
};
