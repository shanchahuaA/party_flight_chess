import { describe, expect, it } from "vitest";
import {
  configSummary,
  DEFAULT_CONFIG_MODEL,
  fromLobbyConfig,
  toLobbyConfig,
} from "./lobbyConfig";
import type { LobbyConfig } from "../../../shared/protocol";

const CFG: LobbyConfig = {
  turnCap: 12,
  maxHp: 8,
  windowMs: 20_000,
  restMs: 5_000,
  timerMode: "turn",
  maliceEvery: 4,
  maliceLevel: "fierce",
};

describe("大厅配置域换算（#62：大厅与结算页共用同一份）", () => {
  it("毫秒 ↔ 秒 往返不失真", () => {
    const m = fromLobbyConfig(CFG);
    expect(m.windowSeconds).toBe(20);
    expect(m.restSeconds).toBe(5);
    expect(toLobbyConfig(m)).toEqual(CFG);
  });

  it("默认模型能原样上行（无快照兜底路径不产生非法值）", () => {
    const c = toLobbyConfig(DEFAULT_CONFIG_MODEL);
    expect(c.windowMs).toBe(30_000);
    expect(c.restMs).toBe(10_000);
    expect(c.timerMode).toBe("world");
    expect(c.maliceLevel).toBe("mild");
  });

  it("摘要一行：三项以上都要在，互换口径一致", () => {
    const s = configSummary(CFG);
    expect(s).toContain("12 回合");
    expect(s).toContain("8❤");
    expect(s).toContain("20s 窗");
    expect(s).toContain("轮班·限时");
    expect(s).toContain("恶意猛");
    expect(s).toContain("每4回合");
  });

  it("关闭恶意时摘要说「无恶意」", () => {
    expect(configSummary({ ...CFG, maliceLevel: "off" })).toContain("无恶意");
  });

  it("null/undefined 摘要为空串（不抛）", () => {
    expect(configSummary(null)).toBe("");
    expect(configSummary(undefined)).toBe("");
  });
});
