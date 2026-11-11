/**
 * ⚙ 局中设置面板的**节显隐判据**（M3-T3，#55 / G-04）。
 *
 * 纯函数、零 Vue：组件 `ui/SettingsSheet.vue` 只照 `settingsSections()` 的结果渲染，
 * 不自己写 `v-if` 判据（判据散在模板里就没法测，也容易两处走样）。
 *
 * 口径（全部来自票面与清单）：
 * - `sfx`：音效行**永远在**（G-04 ① 的前置；开关本身接 T2 的 `audio/shell.ts`）。
 * - `vibrate`：只有设备支持 `navigator.vibrate` 才出——**整行隐藏**，不出灰开关（A-05）。
 * - `unlockHint`：待解锁且音效开着时出可点的「开启音效」（G-17，不许静默失败）；
 *   音效已关着不必催解锁（先开音效，解锁随下一次手势自然发生）。
 *   注意 `needsUnlock` 的语义是「**尝试过**解锁但没 running」（见 `audio/sfx.ts`）——
 *   冷启动还没试过时它是 false，所以面板不会一进游戏就假告警。
 * - `members` / `dissolve`：**仅房间页的房主**（G-04 ③④／G-07）。单机没有房间与解散的概念，
 *   即便调用方把 host 传成真也不出（防御性口径，单机链不该有这个分支）。
 *
 * **局中 ⚙ 里没有任何数值配置**（数值局中冻结）——本文件的节清单就是白名单，
 * 新增节必须同时改这里与 `settingsPanel.test.ts`。
 */

/** 面板输入：从壳层（roomStore / sfxUi / gameStore）摘出来的最小面 */
export interface SettingsView {
  /** 是否在房间页（联机）；单机对局=false */
  inRoom: boolean;
  /** 是否是房主（`snapshot.hostSeat === mySeat`） */
  host: boolean;
  /** 设备是否支持震动（`sfxUi.canVibrate`） */
  canVibrate: boolean;
  /** 是否待解锁（`sfxUi.needsUnlock`） */
  needsUnlock: boolean;
  /** 音效开关当前值（`sfxUi.enabled`） */
  sfxEnabled: boolean;
}

/** 面板会出现的全部节（白名单：多一项就是「局中出现了不该有的东西」） */
export const SETTINGS_SECTION_IDS = ["sfx", "vibrate", "unlockHint", "members", "dissolve"] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

export type SettingsSections = Record<SettingsSectionId, boolean>;

/** 该出哪几节 */
export function settingsSections(v: SettingsView): SettingsSections {
  const roomHost = v.inRoom && v.host;
  return {
    sfx: true,
    vibrate: v.canVibrate,
    unlockHint: v.needsUnlock && v.sfxEnabled,
    members: roomHost,
    dissolve: roomHost,
  };
}
