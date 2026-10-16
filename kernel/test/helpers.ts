import { GAME_DEFAULTS, GameKernel } from "../src";
import type { Fact, GameConfig, PlayerState } from "../src";
import { cellAt } from "../src";

/** 建一局（dev 通道开，时钟从 0 起） */
export function boot(over: Partial<GameConfig> = {}, now = 0): GameKernel {
  return GameKernel.create({ allowDev: true, ...over }, now).kernel;
}

/** 搜种子：使人间（pid 0，可选先 setPos）首掷恰好为 target 面的种子 */
export function seedForFirstDie(target: number, pre: { pos: number; from: number | null; net: number } | null = null): number {
  for (let seed = 1; seed < 5000; seed++) {
    const k = GameKernel.create({ seed, allowDev: true }, 0).kernel;
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

/** 常用格 id 助记 */
export const cell = (c: number, r: number) => {
  const n = cellAt(c, r);
  if (!n) throw new Error(`格 (${c},${r}) 不存在`);
  return n.id;
};
