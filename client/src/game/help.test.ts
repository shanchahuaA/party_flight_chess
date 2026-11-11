import { describe, expect, it } from "vitest";
import {
  BEAST_BASE_HP,
  BEAST_DIE,
  BEAST_HP_PER_PLAYER,
  FINISH_SCORES,
  GAME_DEFAULTS,
  GRUDGE_SCORE,
  PROGRESS_DIVISOR,
  SURVIVE_SCORE,
  TITLE_SCORE,
} from "../../../kernel/src";
import { HELP_BLOCKS } from "./help";

/**
 * 帮助速查的**可测部分**（#55 / G-03）：六块的结构与文案口径。
 *
 * 渲染形态（一屏读完的视觉判据、可上滑、不切页）按 Spec #52「不设缝」只能靠 IAB 冒烟；
 * 这里钉住的是：六块齐全且顺序固定、每块有图标/标题/正文、文案预算够一屏、数值与内核常量同一真源
 * （改了数值表却忘改帮助=对玩家说谎，必须炸）。
 */

const text = (b: (typeof HELP_BLOCKS)[number]): string => [b.title, ...b.lines].join("");

describe("帮助速查六块（G-03：①目标 ②一回合三步 ③四类格子 ④环岛选路与来路栈退格 ⑤最后一波 ⑥结算五项）", () => {
  it("恰好六块，顺序固定（id 即锚点）", () => {
    expect(HELP_BLOCKS.map((b) => b.id)).toEqual([
      "goal",
      "turn",
      "cells",
      "route",
      "lastWave",
      "settlement",
    ]);
  });

  it("每块都有图标、标题与至少一行正文", () => {
    for (const b of HELP_BLOCKS) {
      expect(b.icon.trim().length).toBeGreaterThan(0);
      expect(b.title.trim().length).toBeGreaterThan(0);
      expect(b.lines.length).toBeGreaterThan(0);
      for (const line of b.lines) expect(line.trim().length).toBeGreaterThan(0);
    }
  });

  it("六块标题分别点出六个主题（不许拿引导三步当六块凑数）", () => {
    expect(HELP_BLOCKS[0]!.title).toContain("目标");
    expect(HELP_BLOCKS[1]!.title).toMatch(/回合|三步/);
    expect(HELP_BLOCKS[2]!.title).toContain("格子");
    expect(HELP_BLOCKS[3]!.title).toContain("环岛");
    expect(HELP_BLOCKS[3]!.title).toContain("来路栈");
    expect(HELP_BLOCKS[4]!.title).toContain("最后一波");
    expect(HELP_BLOCKS[5]!.title).toContain("结算");
  });

  it("四类格子那块真的列了四类（事件/道具/陷阱/空格）", () => {
    const t = text(HELP_BLOCKS[2]!);
    for (const k of ["事件", "道具", "陷阱", "空格"]) expect(t).toContain(k);
  });

  it("结算那块点齐五项（进度/通关/存活/称号/整蛊）", () => {
    const t = text(HELP_BLOCKS[5]!);
    for (const k of ["进度", "通关", "存活", "称号", "整蛊"]) expect(t).toContain(k);
  });

  it("一屏读完的预算：每块正文 ≤ 3 行、全篇 ≤ 480 字（390×844 首屏）", () => {
    for (const b of HELP_BLOCKS) {
      expect(b.lines.length).toBeLessThanOrEqual(3);
      expect(text(b).length).toBeLessThanOrEqual(100);
    }
    const total = HELP_BLOCKS.reduce((n, b) => n + text(b).length, 0);
    expect(total).toBeLessThanOrEqual(480);
  });

  it("文案数值与内核常量同一真源（改了数值忘了改帮助会炸）", () => {
    const all = HELP_BLOCKS.map(text).join("\n");
    expect(all).toContain(`+${TITLE_SCORE}`);
    expect(all).toContain(`+${SURVIVE_SCORE}`);
    expect(all).toContain(`+${GRUDGE_SCORE}`);
    expect(all).toContain(`÷${PROGRESS_DIVISOR}`);
    expect(all).toContain(`${BEAST_BASE_HP}`);
    expect(all).toContain(`${BEAST_HP_PER_PLAYER}`);
    expect(all).toContain(`1d${BEAST_DIE}`);
    expect(all).toContain(`${FINISH_SCORES[0]}`);
    expect(all).toContain(`${FINISH_SCORES[1]}`);
    expect(all).toContain(`${FINISH_SCORES[2]}`);
    expect(all).toContain(`${GAME_DEFAULTS.routeAskMs / 1000} 秒`);
  });

  /**
   * 显式豁免（P3-2 / code-review）：帮助自述里「全部从 kernel 引常量」**不覆盖这两处**——
   * 内核没有对应导出（① 暗牌张数住在 `game.ts` 的局部 `draftPair()`；② 年兽反噬住在私有
   * `beastRoarDmg()`），文案只能硬编码。这里把两处字面量钉出来：一是告诉后来者「这两个数不在
   * 对账范围内」，二是它们若被误删/改写，这条会立刻炸。
   *
   * 维护责任：内核改这两个数值时**必须手改 help.ts**（豁免 ≠ 免维护）。
   */
  it("两处内核未导出常量的硬编码（显式豁免对账）", () => {
    const all = HELP_BLOCKS.map(text).join("\n");
    expect(all).toMatch(/抽\s*2\s*张/); // 开局暗牌 2 选 1（kernel 局部 draftPair）
    expect(all).toContain("−1（猛档 −2）"); // 年兽每波反噬（kernel 私有 beastRoarDmg）：温和 1 / 猛 2
  });
});
