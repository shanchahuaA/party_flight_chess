/**
 * 大厅配置域 ↔ 面板 UI 模型的双向换算（M3-T10 #62 抽出）。
 *
 * 原本这段换算只住 RoomLobby 的本地函数里；结算页要复用**同一个** ConfigPanel 改配置
 * （Spec #52 实现决策 7「配置面板复用，不复制版式」），换算逻辑就必须上提成单一真源，
 * 否则两处秒↔毫秒口径迟早分叉。
 */
import type { ConfigModel } from "../ui/ConfigPanel.vue";
import type { LobbyConfig } from "../../../shared/protocol";

/** 默认模型（与服务端 DEFAULT_LOBBY_CONFIG 同值；只有快照未到时才会用到） */
export const DEFAULT_CONFIG_MODEL: ConfigModel = {
  turnCap: 15,
  maxHp: 10,
  windowSeconds: 30,
  restSeconds: 10,
  maliceLevel: "mild",
  maliceEvery: 3,
  timerMode: "world",
};

/** 快照配置 → 面板模型（毫秒 → 秒） */
export function fromLobbyConfig(c: LobbyConfig): ConfigModel {
  return {
    turnCap: c.turnCap,
    maxHp: c.maxHp,
    windowSeconds: Math.round(c.windowMs / 1000),
    restSeconds: Math.round(c.restMs / 1000),
    timerMode: c.timerMode,
    maliceLevel: c.maliceLevel,
    maliceEvery: c.maliceEvery,
  };
}

/** 面板模型 → 上行配置（秒 → 毫秒） */
export function toLobbyConfig(m: ConfigModel): LobbyConfig {
  return {
    turnCap: m.turnCap,
    maxHp: m.maxHp,
    windowMs: m.windowSeconds * 1000,
    restMs: m.restSeconds * 1000,
    timerMode: m.timerMode,
    maliceLevel: m.maliceLevel,
    maliceEvery: m.maliceEvery,
  };
}

/** 配置摘要一行（大厅与结算页同一口径：改配置前后看到的是同一句话） */
export function configSummary(c: LobbyConfig | null | undefined): string {
  if (!c) return "";
  const mode = c.timerMode === "turn" ? "轮班·限时" : "世界·即时";
  const malice =
    c.maliceLevel === "off" ? "无恶意" : `恶意${c.maliceLevel === "mild" ? "温和" : "猛"}/每${c.maliceEvery}回合`;
  return `${c.turnCap} 回合 · ${c.maxHp}❤ · ${Math.round(c.windowMs / 1000)}s 窗 · ${mode} · ${malice}`;
}
