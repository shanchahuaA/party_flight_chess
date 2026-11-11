import { describe, expect, it } from "vitest";
import { SETTINGS_SECTION_IDS, settingsSections, type SettingsView } from "./settingsPanel";

/**
 * ⚙ 局中设置面板的**可测部分**（#55 / G-04）：
 * 该出哪几节由纯函数判定，组件只照单渲染。渲染形态（整行隐藏、面板不显空）归 IAB 冒烟。
 *
 * 判据来源：
 * - 音效/震动开关 = T2 的 `audio/shell.ts`（面板不自己读 localStorage，这里只做显隐）
 * - 震动 `navigator.vibrate` 不存在 → **整行隐藏**，不出灰开关（A-05 / G-04）
 * - 待解锁 → 显示可点的「开启音效」（G-17，不许静默失败）
 * - 成员管理 / 解散房间 = **仅房间页的房主**（G-04 / G-07；单机无房间概念）
 * - 局中 ⚙ 里**没有任何数值配置**（数值局中冻结）——节清单就是白名单，多一节都会炸
 */

const BASE: SettingsView = {
  inRoom: true,
  host: false,
  canVibrate: true,
  needsUnlock: false,
  sfxEnabled: true,
};

describe("⚙ 面板节显隐（G-04）", () => {
  it("普通玩家（Android）：音效 + 震动两行，无成员管理、无解散", () => {
    expect(settingsSections(BASE)).toEqual({
      sfx: true,
      vibrate: true,
      unlockHint: false,
      members: false,
      dissolve: false,
    });
  });

  it("房主在房间页：额外见成员管理与解散房间", () => {
    const s = settingsSections({ ...BASE, host: true });
    expect(s.members).toBe(true);
    expect(s.dissolve).toBe(true);
    expect(s.sfx).toBe(true);
    expect(s.vibrate).toBe(true);
  });

  it("iOS（没有 navigator.vibrate）：震动整行隐藏，音效仍在", () => {
    const s = settingsSections({ ...BASE, canVibrate: false });
    expect(s.vibrate).toBe(false);
    expect(s.sfx).toBe(true);
  });

  it("iOS + 房主：只剩音效 + 成员管理 + 解散（面板不显空）", () => {
    const s = settingsSections({ ...BASE, host: true, canVibrate: false });
    expect(s).toEqual({
      sfx: true,
      vibrate: false,
      unlockHint: false,
      members: true,
      dissolve: true,
    });
  });

  it("单机对局（不在房间）：即便 host 标记为真也不出成员管理/解散", () => {
    const s = settingsSections({ ...BASE, inRoom: false, host: true });
    expect(s.members).toBe(false);
    expect(s.dissolve).toBe(false);
  });

  it("待解锁（浏览器拒绝出声）：出可点的「开启音效」（G-17，不静默失败）", () => {
    expect(settingsSections({ ...BASE, needsUnlock: true }).unlockHint).toBe(true);
    expect(settingsSections(BASE).unlockHint).toBe(false);
  });

  it("音效已关着：不必催解锁（先开音效，解锁随下一次手势自然发生）", () => {
    expect(settingsSections({ ...BASE, needsUnlock: true, sfxEnabled: false }).unlockHint).toBe(false);
  });
});

describe("局中 ⚙ 无任何数值配置（数值局中冻结）", () => {
  it("节清单是白名单，恰好这五项——多一节（如配置/数值）就炸", () => {
    expect([...SETTINGS_SECTION_IDS].sort()).toEqual([
      "dissolve",
      "members",
      "sfx",
      "unlockHint",
      "vibrate",
    ]);
  });

  it("SettingsSheet.vue 不内嵌配置控件（无 ConfigPanel、无 range/number/select）", () => {
    const RAW = import.meta.glob("../ui/SettingsSheet.vue", {
      eager: true,
      query: "?raw",
      import: "default",
    }) as Record<string, string>;
    const src = RAW["../ui/SettingsSheet.vue"];
    expect(src, "SettingsSheet.vue 应存在（⚙ 面板壳）").toBeTruthy();
    expect(src!).not.toContain("ConfigPanel");
    expect(src!).not.toMatch(/type="range"/);
    expect(src!).not.toMatch(/type="number"/);
    expect(src!).not.toMatch(/<select/);
  });
});
