import { describe, expect, it } from "vitest";
import { configSummary, DEFAULT_CONFIG_MODEL, fromLobbyConfig, toLobbyConfig } from "./lobbyConfig";

/**
 * #62 结算页升格局间主舞台的**可测部分**。
 *
 * 说明：结算页的「留在屏上」「动作区吸底」「复用 ConfigPanel」是渲染/布局/时序形态，
 * 按 Spec #52「不设缝」的定论只能靠 IAB 冒烟与真机照单勾。这里只钉住抽出来的纯逻辑：
 * 配置域换算与摘要口径（大厅与结算页共用同一份，分叉即失败）。
 */
describe("#62 结算页与大厅共用配置域（单一真源）", () => {
  it("同一份快照配置，两处换算出的模型完全一致（不会各写一份口径）", () => {
    const c = {
      turnCap: 20,
      maxHp: 12,
      windowMs: 45_000,
      restMs: 8_000,
      timerMode: "world" as const,
      maliceEvery: 5,
      maliceLevel: "mild" as const,
    };
    const m = fromLobbyConfig(c);
    // 往返稳定（结算页改了配置上行 → 服务端 ack → 回填，不能漂）
    expect(toLobbyConfig(m)).toEqual(c);
    // 摘要同一句话
    expect(configSummary(c)).toBe(
      `${c.turnCap} 回合 · ${c.maxHp}❤ · 45s 窗 · 世界·即时 · 恶意温和/每5回合`,
    );
  });

  it("默认模型与服务端默认值同值（快照未到时的兜底不会把配置改坏）", () => {
    const c = toLobbyConfig(DEFAULT_CONFIG_MODEL);
    expect(c.turnCap).toBe(15);
    expect(c.maxHp).toBe(10);
    expect(c.windowMs).toBe(30_000);
    expect(c.restMs).toBe(10_000);
    expect(c.timerMode).toBe("world");
    expect(c.maliceEvery).toBe(3);
    expect(c.maliceLevel).toBe("mild");
  });
});
