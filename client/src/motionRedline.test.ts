import { describe, expect, it } from "vitest";

/**
 * 动效红线守卫（清单 T-05 / Spec #52 红线 18）：只允许 CSS `transition/animation`，
 * 只点名四处（①新战报条目高亮渐出 ②扣血数字弹一下 ③结算名次逐行淡入 ④骰面数字滚动），
 * 其余一律归超级升级。
 *
 * **判读口径（2026-11-11 用户拍板）**：G-10~12 的三档棋盘脉冲单次迭代 ≤300ms 即合规，
 * 允许 3–5 轮迭代（总时长最长 1.4s）——三档要能肉眼分辨，一轮闪烁与「烙住」分不开，
 * 会直接抵消 G-11「视觉比 G-10 重一级」的验收意图。除脉冲外所有动画仍按总时长判。
 * 口径原文见 `docs/M3界面完全体验收清单.md` T-05 的判读注。
 *
 * 守卫口径（刻意保守，只钉「新加的东西别越界」）：
 * - **不追溯 M2 既有基线**（棋盘预警呼吸/滚石流动/掷骰钮呼吸/卡面弹入这些在 M3 之前就有，
 *   且是「状态指示」而非「加料演出」）。
 * - 本测试钉的是：**M3 新增的浮层不许自带入场/退场动画**。引导、战报卡面、结算页
 *   这类「查看类浮层」在定案里明确要求朴素呈现；一旦有人往那里加 fade/pop，这条会炸。
 */

/** M3 新增的浮层：一律不许有 animation/@keyframes/transition（朴素呈现） */
const PLAIN_SHEETS = ["ui/GuideSheet.vue", "ui/RecBar.vue"];

const RAW = import.meta.glob(["./**/*.vue"], { eager: true, query: "?raw", import: "default" }) as Record<string, string>;

function srcOf(rel: string): string {
  const key = "./" + rel;
  const v = RAW[key];
  if (v == null) throw new Error(`motionRedline: 找不到 ${rel}（路径拼写？）`);
  return v;
}

describe("动效红线（T-05）：M3 新增浮层保持朴素", () => {
  for (const rel of PLAIN_SHEETS) {
    it(`${rel} 没有任何 animation / @keyframes / transition`, () => {
      const src = srcOf(rel);
      expect(src).not.toMatch(/@keyframes/);
      expect(src).not.toMatch(/(?:^|[^-])animation\s*:/m);
      expect(src).not.toMatch(/(?:^|[^-])transition\s*:/m);
    });
  }

  it("战报卡面展开（#59）不带动画——卡面是查看类，不做出场演出", () => {
    const src = srcOf("ui/WorldMessage.vue");
    // 只查 .faceCard 规则块内有没有 animation
    const i = src.indexOf(".faceCard {");
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i, src.indexOf("}", i));
    expect(block).not.toMatch(/animation/);
  });
});
