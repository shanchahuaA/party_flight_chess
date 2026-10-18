/**
 * 种子化伪随机源——内核一切随机的唯一通道。
 * 选型：mulberry32（32bit、确定性、跨端一致，可整型序列化/MIT 简单实现）。
 * M2 搬进 Durable Object 时，只随状态携带一个 u32 种子即可恢复整条随机流。
 */
export interface Rng {
  /** 返回 [0,1) 的均匀随机数 */
  next(): number;
  /** 返回 [lo, hi) 的均匀整数 */
  int(hi: number): number;
  /** 洗匀并返回数组（Fisher–Yates，会修改原数组） */
  shuffle<T>(arr: T[]): T[];
  /** 从数组随机取一个元素 */
  pick<T>(arr: T[]): T;
}

export interface RngState {
  s: number;
}

// mulberry32：一个 32bit 无符号状态即可预测整条序列
function mulberry32(state: RngState): number {
  state.s = (state.s + 0x6d2b79f5) >>> 0;
  let t = state.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export const rngFrom = (seed: number, state: RngState = { s: seed >>> 0 }) => {
  const rng: Rng = {
    next: () => mulberry32(state),
    int(hi: number): number {
      return Math.floor(rng.next() * hi);
    },
    shuffle<T>(arr: T[]): T[] {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = rng.int(i + 1);
        [arr[i], arr[j]] = [arr[j]!, arr[i]!];
      }
      return arr;
    },
    pick<T>(arr: T[]): T {
      return arr[rng.int(arr.length)]!;
    },
  };
  return rng;
};

// ---------- 按用途拆流（T1..T8a2 回顾定案）：新消费点只位移自己那条流 ----------

/** 五条命名流：开局分发 / 事件牌堆 / 道具牌堆 / 走格骰+检定 / 世界恶意+野狗。
 *  单条共流时，改牌池或加机制会把全部种子测试的随机流整体位移——搜种子域飘移、钉死种子批量碎。
 *  拆流后互不污染：牌池扩容只影响 deck/items 两条流，走格测试的骰面流不动。 */
export type RngStreamName = "setup" | "deck" | "items" | "dice" | "world";

export const RNG_STREAM_NAMES: readonly RngStreamName[] = ["setup", "deck", "items", "dice", "world"];

export type RngStates = Record<RngStreamName, number>;

/** 流名盐——各流初值从主种子混盐派生（无关联序列），一条流的消耗不波及其余流 */
const STREAM_SALT: Record<RngStreamName, number> = {
  setup: 0x9e3779b9,
  deck: 0x85ebca6b,
  items: 0xc2b2ae35,
  dice: 0x27d4eb2f,
  world: 0x165667b1,
};

const streamSeed = (seed: number, name: RngStreamName): number => {
  let h = (seed >>> 0) ^ STREAM_SALT[name];
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
};

/** 五条流的初始状态快照（进 GameState 持久化，M2 恢复随机流） */
export const rngStatesFrom = (seed: number): RngStates => {
  const out = {} as RngStates;
  for (const n of RNG_STREAM_NAMES) out[n] = streamSeed(seed, n);
  return out;
};

/** 建一条命名流：返回 rng 与它推进的 host（同一对象——同步进 state 时读 host.s 才是现值） */
export const rngStream = (seed: number, name: RngStreamName): { rng: Rng; host: RngState } => {
  const host: RngState = { s: streamSeed(seed, name) };
  return { rng: rngFrom(host.s, host), host };
};
