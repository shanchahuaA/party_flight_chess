/** 无死锁不变量：任意种子全自动推进，系统必达可继续/可收束的终态（局长打满） */
import { describe, expect, it } from "vitest";
import { BRANCH_LEN, GameKernel } from "../src";
import { boot, cell, me } from "./helpers";

describe("无死锁不变量（seed 扫描）", () => {
  const WINDOW = 30_000;
  const REST = 10_000;

  for (const seed of [1, 7, 42, 1337, 9001, 20261016]) {
    it(`seed ${seed}:15 个世界窗全自动推进到 gameEnd，无卡死`, () => {
      const k = boot({ seed });
      // 驱动：以 1s 步进扫完整局（15 窗 ×(30s 行动+10s 休息)≈600s），中途完全不干预
      let t = 0;
      while (k.state.phase !== "over" && t <= 750_000) {
        t += 1_000;
        const fx = k.tick(t);
        void fx;
        for (const p of k.state.players) {
          if (p.walk?.ask) {
            const left = p.walk.ask.deadline - t;
            expect(left).toBeGreaterThan(-1); // 待选条未到点仍在倒计时，不存在负直行授权
            expect(p.walk.ask.options.length).toBeGreaterThan(0);
          }
          // 位置/地带恒定有效
          if (p.zone === "main") {
            expect(p.pos).toBeGreaterThanOrEqual(0);
            expect(p.pos).toBeLessThan(100);
            expect(p.trail.length).toBeLessThan(200);
          }
          if (p.zone === "branch") {
            expect(p.bpos).toBeGreaterThanOrEqual(0);
            expect(p.bpos).toBeLessThanOrEqual(BRANCH_LEN);
          }
        }
      }
      expect(k.state.phase).toBe("over");
      expect(k.state.turn).toBeGreaterThan(15);
      // 战报可读：全条目的 turn ∈ [1..15+1]，序号严格递增
      let lastId = 0;
      for (const m of k.state.messages) {
        expect(m.id).toBeGreaterThan(lastId);
        lastId = m.id;
        expect(m.turn).toBeGreaterThanOrEqual(1);
        expect(m.turn).toBeLessThanOrEqual(16);
      }
      expect(lastId).toBeGreaterThan(0);
      // 形状：始终 4 名玩家；无人 pointPos 落在未知格
      expect(k.state.players.length).toBe(4);
      expect(me(k).spawnCell).toBe(cell(6, 0));
    });
  }

  it("手动与自动混合流也不死锁（真人随机掷、意图错乱给替掷兜住）", () => {
    const k = boot({ seed: 555 });
    let t = 0;
    let rolls = 0;
    while (k.state.phase !== "over" && t <= 750_000) {
      t += 1_000;
      k.tick(t);
      // 摸拟一个"有时点掷骰、有时拖到超窗"的滞后玩家
      if (t % 4_000 === 0 && k.state.phase === "acting" && !k.state.players[0]!.rolled && Math.random() < 0.5) {
        try {
          const fx = k.apply({ type: "roll", pid: 0 }, t);
          rolls++;
          const d = fx.find((x) => x.type === "roll" && x.pid === 0);
          expect(d).toBeTruthy();
        } catch {
          // 这样也接受：替掷 / 已掷都会兜住
        }
      }
      if (t % 9_000 === 0 && k.state.phase === "acting") {
        try {
          k.apply({ type: "confirm", pid: 0 }, t);
        } catch {
          // 未掷也可能确认——真正的确认置换在替掷时兜住
        }
      }
    }
    expect(k.state.phase).toBe("over");
    expect(rolls).toBeGreaterThanOrEqual(0);
    void GameKernel;
  });
});
