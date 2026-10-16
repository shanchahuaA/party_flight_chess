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
